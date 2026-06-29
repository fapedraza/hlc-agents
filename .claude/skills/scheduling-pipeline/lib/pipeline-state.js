/**
 * lib/pipeline-state.js — the scheduling-pipeline state spine.
 *
 * One record per scheduling request, keyed by the Text Request conversation
 * hash (sha256(phone | last_message_id) — the same key text-request-read uses),
 * so this store doubles as the "already handled" set. See PIPELINE.md.
 *
 * Pure data layer: load / upsert / query / save. No network, no LLM.
 */
const fs = require('fs');
const path = require('path');

const SKILL_DIR = path.join(__dirname, '..');
const STATE_PATH = path.join(SKILL_DIR, 'pipeline-state.json');

const STATUSES = ['new', 'classified', 'skipped', 'recommended', 'decided', 'actioned', 'error'];

function nowISO() { return new Date().toISOString(); }

function load(p = STATE_PATH) {
  if (!fs.existsSync(p)) return { version: 1, updatedISO: null, requests: {} };
  try {
    const j = JSON.parse(fs.readFileSync(p, 'utf8'));
    return { version: j.version || 1, updatedISO: j.updatedISO || null, requests: j.requests || {} };
  } catch {
    return { version: 1, updatedISO: null, requests: {} };
  }
}

function save(state, p = STATE_PATH) {
  state.updatedISO = nowISO();
  fs.writeFileSync(p, JSON.stringify(state, null, 2));
  return state;
}

function get(state, hash) {
  return state.requests[hash] || null;
}

function has(state, hash) {
  return Object.prototype.hasOwnProperty.call(state.requests, hash);
}

/** Is this conversation (by phone) already tracked in any state? Dedup is per
 *  CONVERSATION, not per message — a new text shouldn't spawn a duplicate
 *  recommendation. */
function hasPhone(state, phone) {
  if (!phone) return false;
  return Object.values(state.requests).some(r => r.phone === phone);
}

/** Insert a brand-new request record (status 'new'). No-op if it already exists. */
function add(state, { hash, phone, contactName, threadId }) {
  if (has(state, hash)) return state.requests[hash];
  const rec = {
    hash, phone: phone || null, contactName: contactName || null, threadId: threadId || null,
    firstSeenISO: nowISO(), lastUpdateISO: nowISO(),
    status: 'new', skipReason: null,
    classification: null, recommendationFile: null, recommendedAction: null,
    slack: null, decision: null, action: null,
  };
  state.requests[hash] = rec;
  return rec;
}

/** Merge `fields` into a record and stamp lastUpdateISO. Validates status. */
function update(state, hash, fields) {
  const rec = state.requests[hash];
  if (!rec) throw new Error(`pipeline-state: no record for hash ${hash}`);
  if (fields.status && !STATUSES.includes(fields.status)) {
    throw new Error(`pipeline-state: invalid status "${fields.status}"`);
  }
  Object.assign(rec, fields, { lastUpdateISO: nowISO() });
  return rec;
}

/** All records matching a status (or array of statuses). */
function withStatus(state, status) {
  const set = new Set(Array.isArray(status) ? status : [status]);
  return Object.values(state.requests).filter(r => set.has(r.status));
}

/** Hashes present in `candidates` (from messages.json) that have no record yet. */
function newHashes(state, candidates) {
  return (candidates || []).filter(c => !has(state, c.hash));
}

/** Compact counts by status, for logging. */
function summary(state) {
  const out = {};
  for (const r of Object.values(state.requests)) out[r.status] = (out[r.status] || 0) + 1;
  return out;
}

module.exports = {
  STATE_PATH, STATUSES,
  load, save, get, has, hasPhone, add, update, withStatus, newHashes, summary, nowISO,
};
