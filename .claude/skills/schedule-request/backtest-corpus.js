/**
 * backtest-corpus.js — pull RESOLVED Text Request conversations (with full
 * threads) to use as ground-truth for evaluating the scheduling workflow.
 *
 * The live fetcher (text-request-read) only surfaces UNRESOLVED + last-inbound
 * threads (a customer awaiting reply). For a back-test we want the opposite:
 * conversations staff already HANDLED, so the thread contains both the family's
 * request AND staff's actual response/outcome — our ground truth.
 *
 * Pulls the most-recently-active conversations, fetches a deeper thread for
 * each, tags the scheduling-related ones (keyword heuristic over the whole
 * thread), and writes a corpus JSON for the replay harness.
 *
 * Usage: node backtest-corpus.js [limit] [threadDepth] [--out <file>]
 *   limit       how many recent conversations to pull threads for (default 100)
 *   threadDepth messages per thread (default 40)
 */
const fs = require('fs');
const path = require('path');
const { TextRequestApi, readEnv } = require('../text-request-read/lib/tr-api');

const ENV_PATH = 'C:/Projects/hlc-agents/.env';
const OUT_DEFAULT = path.join(__dirname, 'backtest-corpus.json');

const SCHED_RE = /\b(reschedul|resched|cancel|move|switch|change|makeup|make[- ]?up|session|appointment|tutor|available|availabilit|book|slot|push back|earlier|later|come in|next week|this week|can('?| no)t make|won'?t make|miss|absent|time work|what time|earlier time|new time|swap)\b/i;

function parseArgs(argv) {
  const a = { limit: 100, depth: 40, out: OUT_DEFAULT };
  const pos = [];
  for (let i = 0; i < argv.length; i++) {
    const v = argv[i];
    if (v === '--out') a.out = argv[++i];
    else if (!v.startsWith('--')) pos.push(v);
  }
  if (pos[0]) a.limit = parseInt(pos[0], 10) || a.limit;
  if (pos[1]) a.depth = parseInt(pos[1], 10) || a.depth;
  return a;
}

const ts = (m) => m && m.message_timestamp_utc ? Date.parse(m.message_timestamp_utc + (/[zZ]|[+-]\d\d:?\d\d$/.test(m.message_timestamp_utc) ? '' : 'Z')) : 0;

(async () => {
  const args = parseArgs(process.argv.slice(2));
  const env = readEnv(ENV_PATH);
  const api = new TextRequestApi(env.TR_API_KEY);
  const did = env.TR_DASHBOARD_ID ? Number(env.TR_DASHBOARD_ID)
    : (await api.listDashboards())[0].id;

  process.stderr.write('[corpus] listing all conversations (resolved + archived)…\n');
  const all = await api.listConversations(did, { unresolvedOnly: false, includeArchived: true });
  process.stderr.write(`[corpus] ${all.length} conversations total\n`);

  // Most-recently-active first; pull threads for the top `limit`.
  const recent = all
    .filter(c => c.last_message)
    .sort((a, b) => ts(b.last_message) - ts(a.last_message))
    .slice(0, args.limit);

  const corpus = [];
  let i = 0;
  for (const c of recent) {
    i++;
    const phone = c.phone_number;
    let name = phone, resolved = null;
    try {
      const contact = await api.getContact(did, phone);
      name = contact?.display_name || [contact?.first_name, contact?.last_name].filter(Boolean).join(' ') || phone;
      resolved = !!contact?.is_resolved;
    } catch { /* keep phone as name */ }

    let thread = [];
    try {
      const msgs = await api.getRecentMessages(did, phone, args.depth);
      thread = msgs.map(m => ({
        who: m.message_direction === 'R' ? 'customer' : (m.response_by_username || 'staff'),
        dir: m.message_direction === 'R' ? 'in' : 'out',
        text: (m.body || '').trim(),
        ts: m.message_timestamp_utc || null,
      })).filter(x => x.text);
    } catch { /* empty thread */ }

    const joined = thread.map(t => t.text).join('  ');
    const hasInbound = thread.some(t => t.dir === 'in');
    const hasStaff = thread.some(t => t.dir === 'out');
    corpus.push({
      phone, contactName: name, resolved,
      scheduling: SCHED_RE.test(joined),
      hasInbound, hasStaff,
      msgCount: thread.length,
      lastTs: c.last_message?.message_timestamp_utc || null,
      thread,
    });
    if (i % 20 === 0) process.stderr.write(`[corpus] ${i}/${recent.length} threads pulled\n`);
  }

  const sched = corpus.filter(c => c.scheduling && c.hasInbound && c.hasStaff);
  fs.writeFileSync(args.out, JSON.stringify({
    pulledFrom: all.length, threadsPulled: corpus.length,
    schedulingCandidates: sched.length, corpus,
  }, null, 2));
  process.stderr.write(`[corpus] ${sched.length} scheduling candidates (of ${corpus.length} threads) → ${args.out}\n`);
  console.log(JSON.stringify({
    total: all.length, pulled: corpus.length, schedulingCandidates: sched.length,
    candidates: sched.map(c => ({ name: c.contactName, msgs: c.msgCount, lastTs: c.lastTs })),
  }, null, 2));
})().catch(err => { console.error('backtest-corpus failed:', err.stack || err.message); process.exit(1); });
