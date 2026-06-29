/**
 * poll-decisions.js — Piece 2 of the scheduling pipeline.
 *
 * For every pipeline-state record in status `recommended` that has a Slack
 * message ts, read that message's reactions and thread replies, map them to a
 * staff decision, and move the record to `decided`.
 *
 *   reaction → signal (approve / edit / override)
 *   thread reply → detail (free text; best-effort chosen-tutor extraction)
 *
 * Read-only against Slack + the recommendation files; writes only pipeline-state.
 *
 * Usage:
 *   node poll-decisions.js [--dry-run]
 *
 * Env: SLACK_BOT_TOKEN (C:\projects\hlc-agents\.env)
 */
const fs = require('fs');
const path = require('path');
const state = require('./lib/pipeline-state');

const ENV_PATH = 'C:\\projects\\hlc-agents\\.env';

const REACTION_SIGNAL = {
  white_check_mark: 'accept', heavy_check_mark: 'accept', '+1': 'accept', ballot_box_with_check: 'accept',
  pencil2: 'edit', memo: 'edit', lower_left_ballpoint_pen: 'edit',
  x: 'decline', negative_squared_cross_mark: 'decline', no_entry: 'decline', no_entry_sign: 'decline',
};
// Strongest-wins precedence when multiple decision reactions are present.
const SIGNAL_RANK = { decline: 3, edit: 2, accept: 1 };

function readEnv(p = ENV_PATH) {
  const out = {};
  if (!fs.existsSync(p)) return out;
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
  const j = await res.json();
  if (!j.ok) throw new Error(`Slack ${method}: ${j.error}`);
  return j;
}

/**
 * Highest-ranked decision signal among a message's reactions, or null.
 * Ignores the bot's OWN reactions — the bot pre-seeds ✅/✏️/❌ as voting
 * buttons, so a reaction only counts as a staff decision when a *human*
 * (non-bot) user added it.
 */
function reactionSignal(reactions, botUserId) {
  let best = null;
  for (const r of reactions || []) {
    const sig = REACTION_SIGNAL[r.name];
    if (!sig) continue;
    const humans = (r.users || []).filter(u => u !== botUserId);
    if (!humans.length) continue; // only the bot's seeded reaction — not a decision
    if (!best || SIGNAL_RANK[sig] > SIGNAL_RANK[best.signal]) {
      best = { signal: sig, emoji: r.name, users: humans };
    }
  }
  return best;
}

/** Candidate tutor display names from the recommendation, for reply matching. */
function tutorOptions(rec) {
  if (!rec) return [];
  const names = [];
  if (rec.recommended?.tutor) names.push(rec.recommended.tutor);
  if (Array.isArray(rec.recommended?.tutors)) names.push(...rec.recommended.tutors);
  (rec.tutorEvaluations || []).forEach(t => { if (t.teacher?.lastFirst) names.push(t.teacher.lastFirst); });
  return [...new Set(names)];
}

/** Best-effort: which tutor did a reply name? Matches full name or any name token (≥3 chars). */
function tutorFromReply(text, options) {
  const lc = (text || '').toLowerCase();
  for (const opt of options) {
    if (lc.includes(opt.toLowerCase())) return opt;
    const tokens = opt.toLowerCase().match(/[a-z]+/g) || [];
    if (tokens.some(t => t.length >= 3 && new RegExp(`\\b${t}\\b`).test(lc))) return opt;
  }
  return null;
}

async function main() {
  const dryRun = process.argv.includes('--dry-run');
  const env = readEnv();
  const token = env.SLACK_BOT_TOKEN;
  if (!token) { console.error('SLACK_BOT_TOKEN missing from .env'); process.exit(1); }

  // Identify the bot's own user id so we can ignore its pre-seeded reactions.
  let botUserId = null;
  try { botUserId = (await slack(token, 'auth.test', {})).user_id; } catch {}

  const st = state.load();
  const pending = state.withStatus(st, 'recommended').filter(r => r.slack?.ts);
  console.log(`poll-decisions: ${pending.length} recommended message(s) awaiting a decision`);

  let decided = 0;
  for (const rec of pending) {
    const { channel, ts } = rec.slack;
    let reactions = [], replies = [];
    try {
      // conversations.history (channels:history scope) returns the message
      // incl. its reactions — avoids reactions.get's reactions:read scope.
      const hx = await slack(token, 'conversations.history', { channel, latest: ts, oldest: ts, inclusive: 'true', limit: 1 });
      reactions = (hx.messages || [])[0]?.reactions || [];
      const rp = await slack(token, 'conversations.replies', { channel, ts, limit: 30 });
      const parent = (rp.messages || [])[0];
      const botId = parent?.bot_id;
      replies = (rp.messages || []).slice(1).filter(m => !(m.bot_id && m.bot_id === botId));
    } catch (err) {
      console.log(`  ⚠️ ${rec.contactName || rec.hash}: Slack read failed — ${err.message}`);
      continue;
    }

    const sig = reactionSignal(reactions, botUserId);
    const lastReply = replies[replies.length - 1] || null;
    if (!sig && !lastReply) {
      console.log(`  · ${rec.contactName || rec.hash}: no decision yet`);
      continue;
    }

    // Load the recommendation to map a reply → chosen tutor (best-effort).
    let recJson = null;
    if (rec.recommendationFile && fs.existsSync(rec.recommendationFile)) {
      try { recJson = JSON.parse(fs.readFileSync(rec.recommendationFile, 'utf8')); } catch {}
    }
    const replyText = lastReply?.text || null;
    const tutor = replyText ? tutorFromReply(replyText, tutorOptions(recJson)) : null;

    const decision = {
      signal: sig?.signal || (replyText ? 'edit' : null),  // a reply without a reaction ⇒ treat as edit/detail
      emoji: sig?.emoji || null,
      tutor: tutor || null,
      by: (sig?.users || [])[0] || lastReply?.user || null,
      text: replyText,
      decidedISO: state.nowISO(),
    };

    console.log(`  ✓ ${rec.contactName || rec.hash}: ${decision.signal}${tutor ? ` → ${tutor}` : ''}${replyText ? `  ("${replyText.slice(0, 50)}")` : ''}`);
    if (!dryRun) state.update(st, rec.hash, { status: 'decided', decision });
    decided++;
  }

  if (!dryRun && decided) state.save(st);
  console.log(`poll-decisions: ${decided} decided${dryRun ? ' (dry-run, not saved)' : ''}. State: ${JSON.stringify(state.summary(st))}`);
}

main().catch(err => { console.error('poll-decisions failed:', err.stack || err.message); process.exit(1); });
