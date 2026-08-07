/**
 * gate.js — is there anything for the scheduling pipeline to DO right now?
 *
 * The full pass costs a 30-54s `claude -p` invocation, and ~85% of passes were
 * idle: ninety LLM calls a day to discover "0 new threads". Meanwhile the
 * 15-minute cadence was the bot's biggest latency — a customer message waited
 * ~7.5 min on average just to be noticed, in a race staff often win in five.
 *
 * This gate is the cheap 2-minute heartbeat: one TR API fetch (~2s, no LLM, no
 * browser). Full pass only when there is real work, plus a forced full pass
 * when the last one is older than ~15 min so poll-decisions and backfill keep
 * their cadence.
 *
 * Exit codes: 0 = run the full pass, 3 = skip (idle and a recent full pass exists).
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const PIPE_DIR = __dirname;
const TR_DIR = path.join(PIPE_DIR, '..', 'text-request-read');
const MESSAGES = path.join(TR_DIR, 'messages.json');
const STATE = path.join(PIPE_DIR, 'pipeline-state.json');
const MARKER = path.join(process.env.USERPROFILE || 'C:\\Users\\hlcadmin', '.claude', 'logs', 'last-full-pass.marker');
const FORCE_FULL_MIN = 14;   // never let decisions/outcomes lag more than ~15 min

// Same normalisation as pipeline-run.js `pending` (kept in sync by test):
// TR thread timestamps are UTC with no 'Z'.
const trTime = v => { const s = String(v || ''); if (!s) return null;
  const d = new Date(/(?:Z|[+-]\d\d:?\d\d)$/.test(s) ? s : s + 'Z'); return isNaN(d) ? null : d; };
const latestInboundAt = c => ((c && c.thread) || [])
  .filter(t => t.direction === 'inbound').map(t => trTime(t.timestamp))
  .filter(Boolean).sort((a, b) => b - a)[0] || null;

try {
  // Forced full pass when the last one is stale — this also covers first run.
  let markerAgeMin = Infinity;
  try { markerAgeMin = (Date.now() - fs.statSync(MARKER).mtimeMs) / 60000; } catch {}
  if (markerAgeMin >= FORCE_FULL_MIN) { console.log(`[gate] full pass due (last was ${markerAgeMin === Infinity ? 'never' : markerAgeMin.toFixed(0) + 'm ago'})`); process.exit(0); }

  execFileSync(process.execPath, [path.join(TR_DIR, 'fetch-textrequest-api.js'), '--full'], { stdio: 'ignore', timeout: 60000 });
  const msgs = JSON.parse(fs.readFileSync(MESSAGES, 'utf8'));
  const st = JSON.parse(fs.readFileSync(STATE, 'utf8'));
  const recs = Object.values(st.requests || {});
  const byPhone = new Map();
  for (const r of recs) {
    const cur = byPhone.get(r.phone);
    if (!cur || String(r.lastUpdateISO) > String(cur.lastUpdateISO)) byPhone.set(r.phone, r);
  }
  const reasons = [];
  if (recs.some(r => r.status === 'new')) reasons.push('records already at `new`');
  for (const c of (msgs.newMessages || [])) {
    const r = byPhone.get(c.phone);
    if (!r) { reasons.push(`untracked conversation: ${c.contactName || c.phone}`); continue; }
    const latest = latestInboundAt(c);
    if (!latest) continue;
    const seen = trTime(r.handledInboundISO) || new Date(r.lastUpdateISO);
    if (latest > seen) reasons.push(`new inbound: ${c.contactName || c.phone}`);
  }
  if (reasons.length) { console.log('[gate] WORK — ' + reasons.join('; ')); process.exit(0); }
  console.log('[gate] idle — skipping the pass (last full ' + markerAgeMin.toFixed(0) + 'm ago)');
  process.exit(3);
} catch (e) {
  // Any gate failure must not silence the pipeline: fall through to a full pass.
  console.log('[gate] error (' + e.message + ') — running the full pass to be safe');
  process.exit(0);
}
