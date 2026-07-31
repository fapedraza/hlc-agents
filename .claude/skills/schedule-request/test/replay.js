/**
 * replay.js — batch-replay curated real conversations through the LIVE workflow
 * and score closeness vs. what staff actually did.
 *
 * Unlike backtest.js (which runs backtest-MODE, bypassing the request-type
 * branches), replay runs the orchestrator the way the live pipeline does
 * (cancel → CANCEL, reschedule carry-over, slot-offering, etc.) so we can
 * measure the UPDATED workflow against ground truth extracted from the threads.
 *
 * One authenticated A+ session for the whole run; per-tutor quals/schedule
 * memoized across cases; the wide history report is pulled once (cached).
 *
 * Cases: replay-cases/<name>.json — a payload PLUS an `expected` block:
 *   { ...payload,
 *     "expected": { "acceptableActions": ["CANCEL"], "tutor": "Angela Galler"|null,
 *                   "note": "staff canceled the 6/30 session" } }
 *
 * Scoring per case:
 *   actionOK = recommended.action ∈ expected.acceptableActions
 *   tutorOK  = expected.tutor null  OR  token-match vs recommended.tutor /
 *              suggestedSlots tutor / cancel sessions' tutor
 *   verdict  = match (both) | partial (action only) | miss
 *
 * Usage: node replay.js [casesDir] [--out report.json]
 */
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const { readEnv, navStaffList, listTeachers } = require('../lib/aplus');
const { orchestrateOne, loadRoster, loadAplusCsv } = require('../lib/orchestrate');
const { fetchScheduleReportRowsCached } = require('../lib/fetch-history');

const SKILL_DIR = path.join(__dirname, '..');

function parseArgs(argv) {
  const a = { casesDir: path.join(SKILL_DIR, 'replay-cases'), out: path.join(SKILL_DIR, 'replay-report.json') };
  for (let i = 0; i < argv.length; i++) {
    const v = argv[i];
    if (v === '--out') a.out = argv[++i];
    else if (!v.startsWith('--')) a.casesDir = v;
  }
  return a;
}

const tokens = s => new Set(((s || '').toLowerCase().match(/[a-z]+/g)) || []);
function tutorTokenMatch(a, b) {
  const A = tokens(a), B = tokens(b);
  if (!A.size || !B.size) return false;
  const [s, g] = A.size <= B.size ? [A, B] : [B, A];
  for (const t of s) if (!g.has(t)) return false;
  return true;
}

/** Pull every tutor mentioned by a recommendation (for tutor-match scoring). */
function recTutors(rec) {
  const r = rec.recommended || {};
  const out = [];
  if (r.tutor) out.push(r.tutor);
  (r.alternatives || []).forEach(t => out.push(t));
  (r.sessions || []).forEach(s => s.tutor && out.push(s.tutor));
  return out;
}

(async () => {
  const args = parseArgs(process.argv.slice(2));
  const env = readEnv();
  const roster = loadRoster();
  if (!fs.existsSync(args.casesDir)) { console.error(`No cases dir: ${args.casesDir}`); process.exit(1); }
  const cases = fs.readdirSync(args.casesDir).filter(f => f.endsWith('.json')).sort()
    .map(f => { const raw = JSON.parse(fs.readFileSync(path.join(args.casesDir, f), 'utf8')); const { expected, ...payload } = raw; return { id: f.replace(/\.json$/, ''), payload, expected: expected || {} }; });
  const { csvRows, csvAvailable } = loadAplusCsv();

  const caches = { quals: new Map(), schedule: new Map() };
  const results = [];
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ acceptDownloads: true });
  const page = await context.newPage();
  try {
    let historyRows = null;
    try { historyRows = (await fetchScheduleReportRowsCached(page, env, {})).rows; console.log(`[history] ${historyRows.length} rows`); }
    catch (e) { console.log(`[history] pull failed: ${e.message}`); }
    await navStaffList(page, env);
    const teachers = await listTeachers(page);
    console.log(`[a+] ${teachers.length} teachers; replaying ${cases.length} cases\n`);

    for (const c of cases) {
      process.stdout.write(`▶ ${c.id} … `);
      try {
        const out = await orchestrateOne({ payload: c.payload, page, teachers, roster, csvRows, csvAvailable, historyRows, backtest: false, caches, log: () => {} });
        if (out.skipped) { console.log(`skipped (${out.skipped})`); results.push({ id: c.id, skipped: out.skipped, expected: c.expected }); continue; }
        const rec = out.recommendation;
        const action = rec.recommended.action;
        const exp = c.expected;
        const actionOK = !exp.acceptableActions || exp.acceptableActions.includes(action);
        const tutorOK = !exp.tutor || recTutors(rec).some(t => tutorTokenMatch(t, exp.tutor));
        const verdict = actionOK && tutorOK ? 'match' : actionOK ? 'partial' : 'miss';
        const recTutor = rec.recommended.tutor || (rec.recommended.suggestedSlots ? `(slots) ${rec.recommended.tutor || ''}` : (rec.recommended.sessions || []).map(s => s.tutor).join('/')) || '—';
        console.log(`${verdict === 'match' ? '✓' : verdict === 'partial' ? '~' : '✗'} ${verdict}  [${action} → ${recTutor}]  exp:[${(exp.acceptableActions || []).join('|')}${exp.tutor ? ' / ' + exp.tutor : ''}]`);
        results.push({ id: c.id, action, recTutor, verdict, actionOK, tutorOK, expected: exp, reason: rec.recommended.reason });
      } catch (err) { console.log(`ERR ${err.message}`); results.push({ id: c.id, error: err.message, expected: c.expected }); }
    }
  } finally { await browser.close(); }

  const scored = results.filter(r => r.verdict);
  const tally = { match: 0, partial: 0, miss: 0 };
  scored.forEach(r => tally[r.verdict]++);
  const report = { ranAt: 'n/a', total: results.length, scored: scored.length, tally,
    matchRate: scored.length ? +(tally.match / scored.length).toFixed(2) : 0,
    results };
  fs.writeFileSync(args.out, JSON.stringify(report, null, 2));
  console.log(`\n─── Summary ───`);
  console.log(`Scored ${scored.length}: match=${tally.match} partial=${tally.partial} miss=${tally.miss}  (match rate ${Math.round(report.matchRate * 100)}%)`);
  console.log(`Report → ${args.out}`);
})().catch(err => { console.error('replay failed:', err.stack || err.message); process.exit(1); });
