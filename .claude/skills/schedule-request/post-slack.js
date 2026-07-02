/**
 * post-slack.js — Publish a scheduling recommendation to #scheduling.
 *
 * Combines a recommendation produced by demo-orchestrate.js with the
 * corresponding text-thread excerpts from text-request-read's messages.json
 * and posts a formatted message to a Slack channel for staff to validate.
 *
 * Uses the bot token in .env (SLACK_BOT_TOKEN) and posts via
 * https://slack.com/api/chat.postMessage so it works in any context (no MCP
 * dependency, scriptable / cron-friendly).
 *
 * Usage:
 *   node post-slack.js <recommendation.json> [--messages <messages.json>]
 *                                            [--channel <CHANNEL_ID>]
 *                                            [--dry-run]
 *
 * Defaults:
 *   --messages = ../text-request-read/messages.json
 *   --channel  = SCHEDULING_SLACK_CHANNEL or RECONCILE_SLACK_CHANNEL from .env
 */
const fs = require('fs');
const path = require('path');
const https = require('https');

const ENV_PATH = 'C:\\projects\\hlc-agents\\.env';

function readEnv(p) {
  if (!fs.existsSync(p)) return {};
  const out = {};
  for (const line of fs.readFileSync(p, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (m) out[m[1]] = m[2].replace(/^['"]|['"]$/g, '');
  }
  return out;
}

function parseArgs(argv) {
  const a = { recommendation: null, messages: null, channel: null, dryRun: false, seedReactions: false };
  for (let i = 0; i < argv.length; i++) {
    const v = argv[i];
    if (v === '--messages')          a.messages = argv[++i];
    else if (v.startsWith('--messages=')) a.messages = v.slice('--messages='.length);
    else if (v === '--channel')      a.channel  = argv[++i];
    else if (v.startsWith('--channel='))  a.channel  = v.slice('--channel='.length);
    else if (v === '--dry-run')      a.dryRun = true;
    else if (v === '--seed-reactions') a.seedReactions = true;
    else if (!a.recommendation)      a.recommendation = v;
  }
  return a;
}

/**
 * Pre-seed the ✅/✏️/❌ decision reactions on a just-posted message so staff can
 * vote with one click. Needs the `reactions:write` scope; if it's missing the
 * call fails with `missing_scope` and we warn (the post itself still succeeds).
 */
async function seedReactions(token, channel, ts) {
  const emojis = ['white_check_mark', 'pencil2', 'x'];
  for (const name of emojis) {
    try {
      const res = await fetch('https://slack.com/api/reactions.add', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ channel, timestamp: ts, name }),
      });
      const j = await res.json();
      if (!j.ok && j.error !== 'already_reacted') {
        console.error(`  (seed-reactions: ${name} → ${j.error}${j.error === 'missing_scope' ? ' — add reactions:write to the bot to enable one-click voting' : ''})`);
        if (j.error === 'missing_scope') break; // no point trying the rest
      }
    } catch (e) { console.error(`  (seed-reactions ${name}: ${e.message})`); }
  }
}

function fmtDay(iso) {
  const d = new Date(iso + 'T12:00:00');
  return ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'][d.getDay()];
}

const ACTION_EMOJI = {
  PROCEED:           ':white_check_mark:',
  ALREADY_BOOKED:    ':information_source:',
  MULTIPLE_OPTIONS:  ':grey_question:',
  CANCEL:            ':wastebasket:',
  OFFER_SLOTS:       ':calendar:',
  PROGRAM_OFFER:     ':date:',
  BLOCKED:           ':warning:',
};

/** Lowercased word tokens of a name, e.g. "Zahera Shaik (Shaheer (JB))" → [zahera, shaik, shaheer, jb]. */
function nameTokens(s) {
  return (s || '').toLowerCase().match(/[a-z]+/g) || [];
}
/** The primary contact name = the part before the first parenthesis. */
function primaryName(s) {
  return (s || '').split('(')[0].trim().toLowerCase();
}

/**
 * Find the thread for a recommendation's contactName in messages.json.
 * Exact match first; then fall back to a fuzzy match so a normalized name
 * (e.g. "Zahera Shaik (Shaheer Shaikh)") still maps to the original Text
 * Request contact ("Zahera Shaik (Shaheer (JB) and Sarah Shaikh)"). The
 * fallback requires the same primary (parent) name AND at least one more
 * shared token, then picks the best token overlap.
 */
function findThread(messages, contactName) {
  if (!messages || !Array.isArray(messages.newMessages)) return null;
  const exact = messages.newMessages.find(m => (m.contactName || '') === contactName);
  if (exact) return exact;

  const want = new Set(nameTokens(contactName));
  const wantPrimary = primaryName(contactName);
  let best = null, bestScore = 0;
  for (const m of messages.newMessages) {
    const have = nameTokens(m.contactName);
    const overlap = have.filter(t => want.has(t)).length;
    const samePrimary = primaryName(m.contactName) === wantPrimary && wantPrimary.length > 0;
    if (samePrimary && overlap > bestScore) { best = m; bestScore = overlap; }
  }
  // Require the primary name plus at least one more shared token (e.g. the student).
  return bestScore >= 2 ? best : null;
}

/** The most recent customer (inbound) messages, autoresponders filtered, truncated. */
function lastCustomerLines(thread, n = 2, max = 160) {
  if (!Array.isArray(thread)) return [];
  const inbound = thread.filter(m =>
    m.direction === 'inbound' && m.text && !/Huntington is currently closed/i.test(m.text));
  return inbound.slice(-n).map(m => {
    let t = m.text.replace(/\s+/g, ' ').trim();
    if (t.length > max) t = t.slice(0, max - 1).trim() + '…';
    return t;
  });
}

const tutorTag = t => (t && t.isStudentsTutor ? ' _(current tutor)_' : '');

/**
 * Compact recommendation message — only what staff need to act:
 * who/what, the recommendation with the *actionable* tutor(s), any caveat,
 * one line of customer context, and the reply draft. Full detail (clientid,
 * every evaluated tutor, LCOS/A+/payment breakdown) stays in the JSON.
 */
function buildSlackText(rec, threadEntry) {
  const action = rec.recommended?.action || 'UNKNOWN';
  const emoji = ACTION_EMOJI[action] || ':robot_face:';
  const dateNice = rec.proposed?.date ? `${fmtDay(rec.proposed.date)} ${rec.proposed.date}` : '';
  const studentName = rec.student?.name || rec.contactName;
  const time = rec.proposed?.time || '';
  const evalsByName = {};
  (rec.tutorEvaluations || []).forEach(t => { if (t.teacher) evalsByName[t.teacher.lastFirst] = t; });

  const lines = [];
  // Header: who + what
  lines.push(`${emoji} *${studentName}* — ${rec.proposed?.subject || '?'} · ${dateNice} ${time}`.trimEnd());
  if (rec.mode === 'backtest') lines.push('_(back-test mode)_');
  // Uncertain student match is decision-critical — surface it.
  if (rec.student?.confidence && rec.student.confidence !== 'high') {
    lines.push(`_⚠️ student match: ${rec.student.confidence} confidence — confirm this is the right student_`);
  }
  lines.push('');

  // Recommendation — always a SINGLE proposed change, shaped by action.
  if (action === 'PROGRAM_OFFER') {
    const sch = rec.recommended.proposedSchedule || [];
    if (sch.length) {
      lines.push(`*Program* — ${rec.recommended.sessionsPerWeek}×/week with *${rec.recommended.tutor}*${rec.recommended.shortfall ? ` _(only ${sch.length} of ${rec.recommended.sessionsPerWeek} days open)_` : ''}:`);
      sch.forEach(s => lines.push(`• ${s.day.slice(0, 3)} ${s.date} ${s.start}–${s.end}`));
    } else {
      lines.push(`*Program request* (${rec.recommended.sessionsPerWeek}×/week) — no open slots auto-found; staff to build manually.`);
    }
  } else if (action === 'CANCEL') {
    const sess = rec.recommended.sessions || [];
    lines.push(sess.length
      ? `*Cancel* ${sess.length} session(s): ${sess.map(s => `${s.start || '?'}${s.tutor ? ` w/ ${s.tutor}` : ''}`).join(', ')} — no tutor selection needed.`
      : `*Cancel requested* but no existing session found on ${dateNice} — confirm the date with the family.`);
  } else if (action === 'OFFER_SLOTS') {
    const slots = (rec.recommended.suggestedSlots || []).map(s => s.label);
    lines.push(`*Offer times* with *${rec.recommended.tutor}*: ${slots.length ? slots.join(', ') : '(none free that day — suggest another day)'}`);
  } else if (action === 'ALREADY_BOOKED') {
    const ex = rec.recommended.existing;
    lines.push(`*Already booked* with *${rec.recommended.tutor}*${ex ? ` (${ex.start})` : ''} — no scheduling change needed; just confirm.`);
  } else if (action === 'PROCEED' || action === 'MULTIPLE_OPTIONS') {
    // MULTIPLE_OPTIONS kept only for back-compat; orchestrator now picks one.
    const t = rec.recommended.tutor || (rec.recommended.tutors || [])[0];
    lines.push(`*Recommend:* book with *${t}*${tutorTag(evalsByName[t])} — ${rec.recommended.reason || 'qualified & available'}.`);
    const alts = rec.recommended.alternatives || [];
    if (alts.length) lines.push(`_If you'd rather a different tutor (✏️ edit), also free: ${alts.slice(0, 3).join(', ')}_`);
  } else { // BLOCKED / UNKNOWN
    lines.push(`*Needs staff* — ${rec.recommended?.reason || 'could not auto-recommend a tutor'}.`);
  }

  if (rec.note) { lines.push(''); lines.push(`⚠️ ${rec.note}`); }

  const cust = lastCustomerLines(threadEntry?.thread, 2);
  if (cust.length) {
    lines.push('');
    cust.forEach((c, i) => lines.push(`> ${i === 0 ? '_Customer:_ ' : ''}${c}`));
  }

  if (rec.actionPlan?.textReplyDraft) {
    lines.push('');
    lines.push(`✏️ _Reply draft:_ ${rec.actionPlan.textReplyDraft}`);
  }

  if (rec.comparison) lines.push(`_back-test: ${rec.comparison.matchVerdict}_`);

  lines.push('');
  if (action === 'BLOCKED' || action === 'UNKNOWN') {
    lines.push('_⚠️ No auto-recommendation — staff to handle. ❌ decline to dismiss._');
  } else {
    lines.push('_✅ accept · ✏️ edit (reply with a tutor) · ❌ decline_');
  }
  return lines.join('\n');
}

function postToSlack({ token, channel, text }) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ channel, text, unfurl_links: false, unfurl_media: false });
    const req = https.request({
      method: 'POST',
      hostname: 'slack.com',
      path: '/api/chat.postMessage',
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Authorization': `Bearer ${token}`,
        'Content-Length': Buffer.byteLength(body),
      },
    }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          if (!json.ok) return reject(new Error(`Slack: ${json.error || data}`));
          resolve(json);
        } catch (e) { reject(new Error(`Slack parse error: ${e.message}; ${data.slice(0,200)}`)); }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

(async () => {
  const args = parseArgs(process.argv.slice(2));
  if (!args.recommendation) {
    console.error('Usage: node post-slack.js <recommendation.json> [--messages <messages.json>] [--channel <CHANNEL_ID>] [--dry-run]');
    process.exit(1);
  }
  const env = readEnv(ENV_PATH);
  const token = env.SLACK_BOT_TOKEN;
  const channel = args.channel || env.SCHEDULING_SLACK_CHANNEL || env.RECONCILE_SLACK_CHANNEL;
  const messagesPath = args.messages
    || path.join(__dirname, '..', 'text-request-read', 'messages.json');

  if (!args.dryRun && !token) { console.error('SLACK_BOT_TOKEN missing in .env'); process.exit(1); }
  if (!args.dryRun && !channel) { console.error('No channel — set SCHEDULING_SLACK_CHANNEL in .env or pass --channel.'); process.exit(1); }

  const rec = JSON.parse(fs.readFileSync(args.recommendation, 'utf8'));
  let threadEntry = null;
  if (fs.existsSync(messagesPath)) {
    const messages = JSON.parse(fs.readFileSync(messagesPath, 'utf8'));
    threadEntry = findThread(messages, rec.contactName);
    if (!threadEntry) console.error(`Note: thread for "${rec.contactName}" not found in ${messagesPath}`);
  } else {
    console.error(`Note: messages.json not at ${messagesPath} — thread excerpt will be omitted.`);
  }

  const text = buildSlackText(rec, threadEntry);
  if (args.dryRun) {
    console.log('=== DRY RUN — Slack message preview ===');
    console.log(text);
    return;
  }
  const result = await postToSlack({ token, channel, text });
  console.log(`Slack: posted to ${channel} (ts=${result.ts})`);
  if (args.seedReactions) await seedReactions(token, channel, result.ts);
})().catch(err => {
  console.error('post-slack.js failed:', err.stack || err.message || String(err));
  process.exit(1);
});
