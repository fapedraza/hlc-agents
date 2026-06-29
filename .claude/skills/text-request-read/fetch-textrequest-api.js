/**
 * fetch-textrequest-api.js — Read inbound texts from Text Request via the v3 API.
 *
 * Replaces the Playwright browser scraper (fetch-textrequest-browser.js). The
 * API uses a static x-api-key header, so there is NO login flow, NO SMS MFA,
 * and NO session to expire — this can run headless/unattended (cron, etc.).
 *
 * Behaviour mirrors the old scraper so downstream consumers (schedule-request)
 * keep working unchanged:
 *   - Surfaces UNRESOLVED conversations whose LAST message is inbound
 *     (message_direction === 'R'), i.e. a customer is waiting on a reply.
 *   - For each NEW conversation (vs state.json) it pulls the last THREAD_LIMIT
 *     messages for context.
 *   - Writes deltas to messages.json and updates state.json.
 *
 * Dedup key is the (phone | last_message.message_id) hash — stable across runs,
 * unlike the old date/time/snippet hash. The FIRST API run will therefore
 * re-surface conversations already seen by the browser scraper (one time).
 *
 * Usage:
 *   node fetch-textrequest-api.js [--full] [--no-threads] [--include-archived] [--out <path>]
 *
 * Env (C:\projects\hlc-agents\.env):
 *   TR_API_KEY        required
 *   TR_DASHBOARD_ID   optional — set to skip dashboard auto-selection
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { TextRequestApi, readEnv } = require('./lib/tr-api');

const SKILL_DIR = __dirname;
const ENV_PATH = 'C:\\projects\\hlc-agents\\.env';
const STATE_PATH = path.join(SKILL_DIR, 'state.json');
const DEFAULT_MESSAGES_PATH = path.join(SKILL_DIR, 'messages.json');
const SEEN_CAP = 5000;
const THREAD_LIMIT = 15;

function parseArgs(argv) {
  const a = { full: false, noThreads: false, includeArchived: false, out: DEFAULT_MESSAGES_PATH };
  for (let i = 0; i < argv.length; i++) {
    const v = argv[i];
    if (v === '--full') a.full = true;
    else if (v === '--no-threads') a.noThreads = true;
    else if (v === '--include-archived') a.includeArchived = true;
    else if (v === '--out') a.out = argv[++i];
    else if (v.startsWith('--out=')) a.out = v.slice('--out='.length);
    else if (v === '--login') {
      console.error('--login is not needed for the API client. Set TR_API_KEY in .env instead.');
      process.exit(1);
    }
  }
  return a;
}

function loadState() {
  if (!fs.existsSync(STATE_PATH)) return { lastRunISO: null, seenHashes: [] };
  try {
    const j = JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'));
    return { lastRunISO: j.lastRunISO || null, seenHashes: Array.isArray(j.seenHashes) ? j.seenHashes : [] };
  } catch {
    return { lastRunISO: null, seenHashes: [] };
  }
}

function saveState(state) {
  const trimmed = { ...state, seenHashes: state.seenHashes.slice(-SEEN_CAP) };
  fs.writeFileSync(STATE_PATH, JSON.stringify(trimmed, null, 2));
}

/** Stable per-conversation key: phone + the id of its current last message. */
function convHash(phone, messageId) {
  return crypto.createHash('sha256').update(`${phone}|${messageId}`).digest('hex').slice(0, 16);
}

/** Map a v3 message to the thread-entry shape the old scraper produced. */
function toThreadEntry(m) {
  return {
    direction: m.message_direction === 'R' ? 'inbound' : m.message_direction === 'S' ? 'outbound' : 'unknown',
    text: (m.body || '').trim(),
    timestamp: m.message_timestamp_utc || null,
    staffName: m.message_direction === 'S' ? (m.response_by_username || '') : '',
  };
}

/** UTC ISO (no zone suffix per API) → { dateText, timeText } in Pacific for humans. */
function localStamp(utc) {
  if (!utc) return { dateText: '', timeText: '' };
  const d = new Date(/[zZ]|[+-]\d\d:?\d\d$/.test(utc) ? utc : utc + 'Z');
  if (isNaN(d)) return { dateText: '', timeText: '' };
  const opts = { timeZone: 'America/Los_Angeles' };
  return {
    dateText: d.toLocaleDateString('en-US', { ...opts, year: 'numeric', month: '2-digit', day: '2-digit' }),
    timeText: d.toLocaleTimeString('en-US', { ...opts, hour: '2-digit', minute: '2-digit' }),
  };
}

async function resolveDashboardId(api, env) {
  if (env.TR_DASHBOARD_ID) return Number(env.TR_DASHBOARD_ID);
  const dashboards = await api.listDashboards();
  if (dashboards.length === 1) return dashboards[0].id;
  if (dashboards.length === 0) throw new Error('No dashboards returned for this account.');
  const list = dashboards.map(d => `  ${d.id}  ${d.name} (${d.phone})`).join('\n');
  throw new Error(`Multiple dashboards — set TR_DASHBOARD_ID in .env to one of:\n${list}`);
}

async function fetchMessages(args) {
  const env = readEnv(ENV_PATH);
  const api = new TextRequestApi(env.TR_API_KEY);
  const t0 = Date.now();

  const dashboardId = await resolveDashboardId(api, env);
  const state = args.full ? { lastRunISO: null, seenHashes: [] } : loadState();
  const seenSet = new Set(state.seenHashes);

  // Server-side: only unresolved conversations. Then keep those whose LAST
  // message came from the contact (inbound 'R') — a customer awaiting reply.
  const conversations = await api.listConversations(dashboardId, {
    unresolvedOnly: true,
    includeArchived: args.includeArchived,
  });
  const candidates = conversations
    .filter(c => c.last_message && c.last_message.message_direction === 'R')
    .map(c => {
      const lm = c.last_message;
      return {
        phone: c.phone_number,
        snippet: (lm.body || '').trim(),
        lastMessageId: lm.message_id,
        lastMessageUtc: lm.message_timestamp_utc,
        ...localStamp(lm.message_timestamp_utc),
        lastFromStaff: false,
        hash: convHash(c.phone_number, lm.message_id),
      };
    });

  const newMessages = candidates.filter(c => !seenSet.has(c.hash));

  // Enrich each NEW conversation with the contact's display name + thread.
  // Per-conversation failures degrade that row (kept UNSEEN for retry) rather
  // than failing the whole run.
  let threadsScraped = 0;
  for (const m of newMessages) {
    try {
      const contact = await api.getContact(dashboardId, m.phone);
      m.contactName = contact?.display_name
        || [contact?.first_name, contact?.last_name].filter(Boolean).join(' ')
        || m.phone;
      m.isResolved = !!contact?.is_resolved;
      m.threadId = contact?.thread_id || null;
    } catch (err) {
      m.contactName = m.phone;
      m.contactError = err.message || String(err);
    }
    if (!args.noThreads) {
      try {
        const msgs = await api.getRecentMessages(dashboardId, m.phone, THREAD_LIMIT);
        m.thread = msgs.map(toThreadEntry).filter(x => x.text);
        threadsScraped++;
      } catch (err) {
        m.thread = [];
        m.threadError = err.message || String(err);
      }
    }
  }

  const runISO = new Date().toISOString();
  const out = {
    runISO,
    source: 'api-v3',
    dashboardId,
    totalUnresolved: conversations.length,
    unresolvedInboundCount: candidates.length,
    newCount: newMessages.length,
    threadsScraped,
    newMessages,
  };
  fs.writeFileSync(args.out, JSON.stringify(out, null, 2));

  // Rows whose enrichment failed stay UNSEEN so the next run retries them.
  const updatedSeen = state.seenHashes.concat(
    newMessages.filter(m => !m.threadError && !m.contactError).map(m => m.hash),
  );
  saveState({ lastRunISO: runISO, seenHashes: updatedSeen });

  const dt = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(
    `text-request (api): ${newMessages.length} new (of ${candidates.length} unresolved inbound, ` +
    `${conversations.length} total unresolved), ${threadsScraped} threads in ${dt}s → ${args.out}`,
  );
}

(async () => {
  const args = parseArgs(process.argv.slice(2));
  await fetchMessages(args);
})().catch(err => {
  console.error(err.stack || err.message || String(err));
  process.exit(1);
});
