/**
 * demo-orchestrate.js — end-to-end prototype for a SINGLE scheduling request.
 *
 * Phase 1 (recommend-only) pipeline:
 *
 *   1. Resolve contact name → LCOS clientid (resolve-student.js).
 *   2. For each candidate tutor:
 *        a. Live A+ Services Offered lookup (getTeacherQuals).
 *        b. Live A+ Schedule (getTeacherSchedule).
 *        c. Booked-appointments check against the schedule-reconcile CSV.
 *   3. Score qualified + available + conflict-free tutors.
 *   4. Emit a recommendation JSON.
 *
 * The core logic lives in lib/orchestrate.js (shared with backtest.js); this
 * file just owns the single-request CLI + browser lifecycle.
 *
 * Usage:
 *   node demo-orchestrate.js <payload.json> [--out <recommendation.json>] [--backtest]
 */
const fs = require('fs');
const { chromium } = require('playwright');
const { readEnv, navStaffList, listTeachers } = require('./lib/aplus');
const { orchestrateOne, loadRoster, loadAplusCsv, APLUS_CSV_PATH } = require('./lib/orchestrate');
const { fetchScheduleReportRowsCached, DEFAULT_MAX_AGE_MS } = require('./lib/fetch-history');

function parseArgs(argv) {
  const a = { payload: null, out: null, backtest: false, noHistory: false, refreshHistory: false };
  for (let i = 0; i < argv.length; i++) {
    const v = argv[i];
    if (v === '--out') a.out = argv[++i];
    else if (v.startsWith('--out=')) a.out = v.slice(6);
    else if (v === '--backtest') a.backtest = true;
    else if (v === '--no-history') a.noHistory = true;
    else if (v === '--refresh-history') a.refreshHistory = true;   // force a fresh report pull
    else if (!a.payload) a.payload = v;
  }
  return a;
}

// History cache window: env SR_HISTORY_CACHE_MIN (minutes) overrides the default;
// --refresh-history forces a miss. The always-on pipeline relies on this so many
// requests in a working session share one whole-center report pull.
function historyMaxAgeMs(args) {
  if (args.refreshHistory) return 0;
  const min = parseInt(process.env.SR_HISTORY_CACHE_MIN, 10);
  return Number.isFinite(min) ? min * 60 * 1000 : DEFAULT_MAX_AGE_MS;
}

(async () => {
  const args = parseArgs(process.argv.slice(2));
  if (!args.payload) {
    console.error('Usage: node demo-orchestrate.js <payload.json> [--out <recommendation.json>] [--backtest]');
    process.exit(1);
  }
  const payload = JSON.parse(fs.readFileSync(args.payload, 'utf8'));
  const env = readEnv();
  const roster = loadRoster();

  const { csvRows, csvAvailable } = loadAplusCsv();
  if (csvAvailable) console.log(`[csv] Loaded ${csvRows.length} booked-appointment rows from ${APLUS_CSV_PATH}`);
  else console.log(`[csv] Booked-appointments CSV not found at ${APLUS_CSV_PATH} — conflict check will be skipped.`);

  console.log(`\nOpening A+ session for live tutor lookups...`);
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ acceptDownloads: true });
  const page = await context.newPage();
  let result = null;
  try {
    // Pull the wide A+ schedule report first → student-history anchor.
    // Cached on disk (default 3h) so the always-on pipeline reuses one pull.
    let historyRows = null;
    if (!args.noHistory) {
      const maxAgeMs = historyMaxAgeMs(args);
      try {
        const { rows, window, cached, ageMs } = await fetchScheduleReportRowsCached(page, env, { maxAgeMs });
        historyRows = rows;
        console.log(cached
          ? `[history] ${rows.length} rows from cache (age ${Math.round(ageMs / 60000)}m)`
          : `[history] ${rows.length} rows pulled fresh ${window.start}–${window.end} (cached for reuse)`);
      } catch (e) {
        console.log(`[history] report pull failed (${e.message}); falling back to narrow CSV`);
      }
    }
    await navStaffList(page, env);
    const teachers = await listTeachers(page);

    // ── multi-session bookings ────────────────────────────────────────────────
    // A sessions[] ask that ISN'T a cancel gets one full evaluation PER entry —
    // Amy Kot's "Wed verbal + Fri math" needs a tutor decision for each, and the
    // single-payload run could only make one. Each entry goes through the same
    // orchestrateOne; the browser session and per-tutor scrapes are shared via
    // `caches`, so N sessions cost one login and each tutor is scraped once.
    // Cancels stay single-call: orchestrateOne already collects the whole
    // sessions[] scope internally for CANCEL.
    const wantMulti = Array.isArray(payload.sessions) && payload.sessions.length > 1
      && !/^(cancel|lookup)$/i.test(payload.requestType || '');
    if (wantMulti) {
      const caches = { quals: new Map(), schedule: new Map() };
      const parts = [];
      for (const [i, entry] of payload.sessions.entries()) {
        if (!entry || !entry.date) continue;
        const sub = {
          ...payload,
          sessions: undefined,                       // no scope note on sub-calls
          student: entry.student || payload.student,
          proposedDate: entry.date,
          proposedTime: entry.time || null,
          sessionLength: entry.length || payload.sessionLength,
          subject: entry.subject || payload.subject,
          courtesy: i === 0 ? payload.courtesy : undefined,   // once, not per line
        };
        console.log(`
--- session ${i + 1}/${payload.sessions.length}: ${sub.student || ''} ${sub.proposedDate} ${sub.proposedTime || ''} ---`);
        const r = await orchestrateOne({
          payload: sub, page, teachers, roster, csvRows, csvAvailable, historyRows,
          backtest: args.backtest, caches, log: (m) => console.log(m),
        });
        parts.push({
          student: sub.student, date: sub.proposedDate, time: sub.proposedTime,
          subject: sub.subject,
          skipped: r.skipped || null,
          recommended: r.recommendation ? r.recommendation.recommended : null,
          note: r.recommendation ? r.recommendation.note : null,
        });
        if (!result && r.recommendation) result = r;   // first evaluable part anchors downstream
      }
      if (result) {
        result.recommendation.multi = true;
        result.recommendation.parts = parts;
        // One combined family draft, composed from the parts rather than by
        // concatenating N greeting+signoff drafts.
        // Parents get "Wed 8/12", never an ISO date — same rule as every other draft.
        const famDate = iso => {
          const d = new Date(iso + 'T12:00:00');
          const dow = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'][d.getDay()];
          return `${dow} ${d.getMonth() + 1}/${d.getDate()}`;
        };
        const fmtPart = q => {
          const rec = q.recommended || {};
          const t = rec.tutor ? String(rec.tutor).replace(/^([^,]+),\s*([^(]+?)\s*(\(.*)?$/, '$2').trim() : null;
          const when = `${famDate(q.date)}${q.time ? ' at ' + q.time : ''}`;
          if (rec.action === 'PROCEED' || rec.action === 'ALREADY_BOOKED') return `${when}${q.subject ? ' — ' + q.subject : ''}${t ? ' with ' + t : ''}`;
          if (rec.action === 'OFFER_SLOTS') return `${when}${t ? ' — times to confirm with ' + t : ' — times to confirm'}`;
          return `${when} — staff to confirm`;
        };
        const booked = parts.filter(q => q.recommended);
        result.recommendation.actionPlan = result.recommendation.actionPlan || {};
        result.recommendation.actionPlan.textReplyDraft =
          `Hi! Here's what we've set up: ${booked.map(fmtPart).join('; ')}. ` +
          `We'll confirm anything still open shortly. - HLC Issaquah`;
      }
    } else {
      result = await orchestrateOne({
        payload, page, teachers, roster, csvRows, csvAvailable, historyRows,
        backtest: args.backtest, log: (m) => console.log(m),
      });
    }
  } finally {
    await browser.close();
  }

  if (result.skipped) {
    console.log(`\nSkipped: ${result.skipped}`);
    process.exit(0);
  }

  if (args.out) {
    fs.writeFileSync(args.out, JSON.stringify(result.recommendation, null, 2));
    console.log(`\nWrote recommendation → ${args.out}`);
  } else {
    console.log('\n=== Recommendation ===');
    console.log(JSON.stringify(result.recommendation.recommended, null, 2));
  }
})().catch(err => {
  console.error('demo-orchestrate.js failed:', err.stack || err.message || String(err));
  process.exit(1);
});
