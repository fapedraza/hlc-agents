/**
 * daily-review.js — what did the scheduling bot learn yesterday?
 *
 * Every other piece of this pipeline answers "what should we do about THIS
 * message". Nothing answered "is the thing working, and what is it getting
 * wrong". That question got answered by hand, and the two most useful findings
 * of the whole project came out of it: cancellations were being skipped as
 * "not a scheduling request", and six threads were families asking what was
 * already on the calendar. Both were sitting in the skip reasons the entire
 * time. This runs that same read daily so the next one surfaces on its own.
 *
 * Four signals, in the order they are worth reading:
 *
 *   1. What staff SAID   — human replies in #scheduling. The gold. Mariah's
 *                          "Morgan already normally has a session on Tuesdays"
 *                          is worth more than any number on this page.
 *   2. What staff DID    — outcome verdicts from backfill-outcomes.js.
 *   3. What we declined  — skip reasons, themed. New use cases hide here.
 *   4. What is stuck     — errors, records sitting at `new`, restores ignored.
 *
 * READ-ONLY apart from the Slack digest it posts. Never touches pipeline state.
 *
 * Usage:
 *   node daily-review.js [--days 7] [--dry-run] [--channel <ID>]
 */
const fs = require('fs');
const path = require('path');

const PIPE_DIR = __dirname;
const SR_DIR = path.join(PIPE_DIR, '..', 'schedule-request');
const STATE_PATH = path.join(PIPE_DIR, 'pipeline-state.json');
const REPORT_PATH = path.join(PIPE_DIR, 'backfill-report.json');
const ENV_PATH = 'C:\\projects\\hlc-agents\\.env';
const CENTER_TZ = 'America/Los_Angeles';

const argv = process.argv.slice(2);
const argVal = (f, d) => { const i = argv.indexOf(f); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const DAYS = parseInt(argVal('--days', '7'), 10);
const DRY_RUN = argv.includes('--dry-run');
// Below this, a Slack message is an acknowledgement rather than feedback.
const MIN_NOTE_CHARS = 25;

function readEnv(p = ENV_PATH) {
  if (!fs.existsSync(p)) return {};
  const out = {};
  for (const line of fs.readFileSync(p, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (m) out[m[1]] = m[2].replace(/^['"]|['"]$/g, '');
  }
  return out;
}

async function slack(token, method, params) {
  const qs = new URLSearchParams(params).toString();
  const res = await fetch(`https://slack.com/api/${method}?${qs}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  return res.json();
}

const load = p => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; } };
/** Center-local calendar day. A+ and staff both think in local days, not UTC. */
const day = iso => iso ? new Date(iso).toLocaleDateString('en-CA', { timeZone: CENTER_TZ }) : null;
const pct = (n, d) => d ? `${Math.round(n / d * 100)}%` : 'n/a';

// Skip reasons are free text written by the classifier. Theming them is how a new
// use case becomes visible: "6 threads asking what is already booked" reads as a
// feature request, where six separate one-line reasons read as noise.
const SKIP_THEMES = [
  ['schedule question (possible `lookup`)', /what time|when is|which day|already (booked|scheduled)|confirm(ing|ation)? of existing|existing (mon|tue|wed|thu|fri|schedule)/],
  ['cancellation (should be `cancel`)',     /cancel/],
  ['billing / tuition',                     /tuition|billing|payment|invoice|pricing|rate|charge|refund/],
  ['teacher-originated',                    /teacher-originated|tutor asking|staff-to-teacher|own (schedule|hours|session)/],
  ['no concrete date or time',              /no concrete|no specific|needs-info|unclear|vague|no day|no date/],
  ['thanks / acknowledgement',              /thank|tapback|liked|acknowledg|ack only|reply only/],
  ['absence notice, nothing asked',         /absence|sick|out of town|vacation|camp|won.t be|not attend/],
  ['no longer in queue',                    /no-longer-in-queue|not in queue/],
];

function themeSkips(reasons) {
  const counts = new Map();
  const unmatched = [];
  for (const r of reasons) {
    const hit = SKIP_THEMES.find(([, re]) => re.test(r.toLowerCase()));
    if (hit) counts.set(hit[0], (counts.get(hit[0]) || 0) + 1);
    else unmatched.push(r);
  }
  return { counts: [...counts.entries()].sort((a, b) => b[1] - a[1]), unmatched };
}

(async () => {
  const state = load(STATE_PATH);
  if (!state) { console.error(`no pipeline state at ${STATE_PATH}`); process.exit(1); }
  const report = load(REPORT_PATH);
  const env = readEnv();
  const token = env.SLACK_BOT_TOKEN;
  const channel = argVal('--channel', env.SCHEDULING_SLACK_CHANNEL || 'CMR1PPZ9B');

  const now = new Date();
  const since = new Date(now.getTime() - DAYS * 86400000);
  const today = day(now.toISOString());
  const recs = Object.values(state.requests || {});
  const inWindow = r => r.lastUpdateISO && new Date(r.lastUpdateISO) >= since;

  // ── 1. volume ──
  const win = recs.filter(inWindow);
  const posted = recs.filter(r => r.slack?.postedISO && new Date(r.slack.postedISO) >= since);
  const skipped = win.filter(r => r.status === 'skipped');
  const reopened = recs.filter(r => r.reopenedISO && new Date(r.reopenedISO) >= since);

  // ── 2. what staff SAID in Slack (the qualitative signal) ──
  //
  // Scan the CHANNEL, not our own records. A record's slack.ts is overwritten
  // when a conversation is reopened and re-posted, so walking records silently
  // loses every comment left on the earlier message - it found 1 of 2 known
  // replies in testing. The channel is the source of truth for what staff said.
  //
  // Top-level human messages count too: "Oliver Fhi has moved to Tuesdays 2-4"
  // is feedback, and it is not a reply to anything.
  const staffNotes = [];
  if (token) {
    const oldest = (since.getTime() / 1000).toFixed(6);
    const hist = await slack(token, 'conversations.history', { channel, oldest, limit: 200 });
    for (const m of (hist.messages || [])) {
      const isBot = !!m.bot_id || m.subtype === 'bot_message';
      // "I have not" / "ok" / tapbacks are chatter, not signal. A comment worth
      // acting on is essentially never this short.
      const body = String(m.text || '').replace(/\s+/g, ' ').trim();
      if (!isBot && body.length >= MIN_NOTE_CHARS) {
        staffNotes.push({ where: 'channel', text: body });
      }
      if (!m.reply_count) continue;
      const rp = await slack(token, 'conversations.replies', { channel, ts: m.ts, limit: 50 });
      if (!rp.ok) continue;
      // Drop the :emoji: shortcode first - stripping ':' alone leaves the bare
      // word and the label reads "wastebasket Layla Armstrong".
      const parentLine = String((rp.messages || [])[0]?.text || '')
        .split('\n')[0].replace(/:[a-z0-9_+-]+:/gi, '').replace(/[*_]/g, '').trim();
      for (const r of (rp.messages || []).slice(1)) {
        if (r.bot_id || r.subtype === 'bot_message') continue;   // the bot's own outcome replies
        const reply = String(r.text || '').replace(/\s+/g, ' ').trim();
        if (reply.length >= MIN_NOTE_CHARS) staffNotes.push({ where: parentLine.slice(0, 70), text: reply });
      }
    }
  }

  // ── 3. outcomes ──
  const results = (report?.results || []).filter(x => x.postedISO && new Date(x.postedISO) >= since);
  const verdicts = {};
  results.forEach(x => { verdicts[x.verdict] = (verdicts[x.verdict] || 0) + 1; });
  const timeliness = {};
  results.forEach(x => { if (x.timeliness) timeliness[x.timeliness] = (timeliness[x.timeliness] || 0) + 1; });
  const WRONG = new Set(['wrong-category', 'wrong-tutor', 'bot-blocked-staff-acted', 'still-booked', 'restore-not-done']);
  const wrong = results.filter(x => WRONG.has(x.verdict));

  // ── 4. what is stuck ──
  const errors = recs.filter(r => r.status === 'error');
  const stuckNew = recs.filter(r => r.status === 'new');

  const { counts: skipThemes, unmatched } = themeSkips(skipped.map(r => r.skipReason).filter(Boolean));

  // ── build the digest ──
  const L = [];
  L.push(`:bar_chart: *Scheduling bot — daily review* (${today}, last ${DAYS} days)`);
  L.push('');
  L.push(`*Volume* — ${posted.length} recommendation(s) posted · ${skipped.length} skipped · ${reopened.length} conversation(s) reopened by a new message`);

  if (Object.keys(timeliness).length) {
    const first = timeliness['bot-first'] || 0;
    const tot = Object.values(timeliness).reduce((a, b) => a + b, 0);
    L.push(`*In time to matter* — bot posted first in ${first}/${tot} (${pct(first, tot)})`);
  }

  if (results.length) {
    L.push('');
    L.push(`*What staff actually did* (${results.length} graded)`);
    Object.entries(verdicts).sort((a, b) => b[1] - a[1]).slice(0, 8)
      .forEach(([v, n]) => L.push(`• ${n} ${v}`));
    if (wrong.length) {
      L.push(`:warning: *${wrong.length} demonstrably wrong* — ${wrong.map(w => `${w.student || w.contactName} (${w.verdict})`).join(', ')}`);
    }
  }

  if (staffNotes.length) {
    L.push('');
    L.push(`*What staff said* — ${staffNotes.length} reply(ies). This is the most useful thing on this page:`);
    staffNotes.sort((a, b) => (a.where === 'channel') - (b.where === 'channel'));
    staffNotes.slice(0, 8).forEach(n =>
      L.push(`> _${n.where}_: ${n.text.length > 220 ? n.text.slice(0, 219) + '\u2026' : n.text}`));
  }

  if (skipThemes.length) {
    L.push('');
    L.push(`*What we declined* (${skipped.length}) — a theme growing here is usually a missing feature, not noise:`);
    skipThemes.forEach(([t, n]) => L.push(`• ${n} ${t}`));
    if (unmatched.length) L.push(`• ${unmatched.length} uncategorised${unmatched.length <= 3 ? ` — ${unmatched.map(u => `"${u.slice(0, 60)}"`).join(', ')}` : ''}`);
  }

  const attention = [];
  if (errors.length) attention.push(`${errors.length} record(s) in \`error\` (gave up after 3 attempts)`);
  if (stuckNew.length) attention.push(`${stuckNew.length} record(s) still at \`new\` — the pass may not be completing`);
  if (!results.length && posted.length) attention.push('recommendations posted but none graded yet (outcomes need 24h)');
  if (attention.length) {
    L.push('');
    L.push(`*Needs attention*`);
    attention.forEach(a => L.push(`• ${a}`));
  }

  const text = L.join('\n');
  console.log(text);

  if (DRY_RUN || !token) {
    console.log(`\n[daily-review] ${DRY_RUN ? '--dry-run' : 'no SLACK_BOT_TOKEN'} — not posted.`);
    return;
  }
  const res = await slack(token, 'chat.postMessage', { channel, text });
  console.log(res.ok ? `\n[daily-review] posted to ${channel}` : `\n[daily-review] post failed: ${res.error}`);
})().catch(e => { console.error('daily-review failed:', e.message); process.exit(1); });
