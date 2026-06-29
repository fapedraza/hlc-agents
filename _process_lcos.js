const fs = require('fs');
const path = require('path');

const INPUT = String.raw`C:\Users\hlcadmin\.claude\projects\C--projects-hlc-agents\8454bfee-22bf-4b79-9ec4-65b537ef2b4f\tool-results\mcp-lcos-lcos_sign_in_sheet-1776186261454.txt`;
const OUTPUT = String.raw`C:\projects\hlc-agents\lcos_blocks.json`;

const raw = fs.readFileSync(INPUT, 'utf8');

// The file may contain surrounding wrapper text; try to locate the JSON.
function extractJson(text) {
  // try direct parse
  try { return JSON.parse(text); } catch (e) {}
  // find first { or [
  const start = text.search(/[\{\[]/);
  if (start < 0) throw new Error('no JSON start found');
  // try progressive slicing from end
  for (let end = text.length; end > start; end--) {
    const ch = text[end - 1];
    if (ch !== '}' && ch !== ']') continue;
    try {
      return JSON.parse(text.slice(start, end));
    } catch (e) { /* keep going */ }
  }
  throw new Error('failed to parse JSON');
}

const parsed = extractJson(raw);

// find rows array
let rows = null;
if (Array.isArray(parsed)) rows = parsed;
else if (parsed && Array.isArray(parsed.rows)) rows = parsed.rows;
else {
  // search deep
  const stack = [parsed];
  while (stack.length) {
    const cur = stack.pop();
    if (cur && typeof cur === 'object') {
      if (Array.isArray(cur.rows)) { rows = cur.rows; break; }
      for (const k in cur) stack.push(cur[k]);
    }
  }
}
if (!rows) throw new Error('rows not found');

const ACTIVE = new Set(['ATD', 'MU', 'EXT']);
const CANCELLED = new Set(['ABS', 'VAC', 'ANM']);
const SUFFIXES = new Set(['jr', 'sr', 'ii', 'iii', 'iv', 'md', 'phd', 'dds']);

function toISODate(s) {
  if (!s) return null;
  // "4/15/2026 12:00:00 AM"
  const m = String(s).match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (!m) return null;
  const mm = m[1].padStart(2, '0');
  const dd = m[2].padStart(2, '0');
  return `${m[3]}-${mm}-${dd}`;
}

function toHHMM(s) {
  if (!s) return null;
  // starttime may be "4/15/2026 2:30:00 PM" or "14:30" or "2:30 PM"
  const str = String(s);
  // try ISO-like with date + time
  let m = str.match(/(\d{1,2}):(\d{2})(?::\d{2})?\s*([AaPp][Mm])?/);
  if (!m) return null;
  let h = parseInt(m[1], 10);
  const min = m[2];
  const ampm = m[3] ? m[3].toUpperCase() : null;
  if (ampm === 'AM') { if (h === 12) h = 0; }
  else if (ampm === 'PM') { if (h !== 12) h += 12; }
  return `${String(h).padStart(2, '0')}:${min}`;
}

function hhmmToMins(s) {
  if (!s) return null;
  const [h, m] = s.split(':').map(Number);
  return h * 60 + m;
}

function normalizeName(first, last) {
  const combined = `${first || ''} ${last || ''}`.toLowerCase();
  // remove non-alpha/non-space
  const cleaned = combined.replace(/[^a-z\s]/g, ' ');
  const words = cleaned.split(/\s+/).filter(w => w && !SUFFIXES.has(w));
  words.sort();
  return words.join(' ');
}

const normalizedSessions = [];
const blocksMap = new Map();

for (const row of rows) {
  const date = toISODate(row.forday);
  const startTime = toHHMM(row.starttime);
  const endTime = toHHMM(row.endtime);
  const sMins = hhmmToMins(startTime);
  const eMins = hhmmToMins(endTime);
  const durationMins = (sMins != null && eMins != null) ? (eMins - sMins) : 0;
  const attendCode = row.attendcode || '';
  const isActive = ACTIVE.has(attendCode);
  const isCancelled = CANCELLED.has(attendCode);
  const first = row.firstname || '';
  const last = row.lastname || '';
  const studentName = `${first} ${last}`.trim();
  const normalName = normalizeName(first, last);

  const session = {
    date,
    studentName,
    clientId: row.clientid,
    service: row.service,
    subjectArea: row.subjectarea,
    startTime,
    endTime,
    durationMins,
    attendCode,
    statusCode: row.statuscode,
    isActive,
    isCancelled,
    notes: row.notes,
  };
  normalizedSessions.push(session);

  const key = `${normalName}|${date}`;
  let block = blocksMap.get(key);
  if (!block) {
    block = {
      displayName: studentName,
      normalName,
      date,
      startTime: null,
      endTime: null,
      sessionCount: 0,
      totalMins: 0,
      hasActive: false,
      attendCodes: new Set(),
      _startMins: null,
      _endMins: null,
    };
    blocksMap.set(key, block);
  }
  block.sessionCount += 1;
  if (attendCode) block.attendCodes.add(attendCode);
  if (isActive) {
    block.hasActive = true;
    block.totalMins += durationMins;
    if (sMins != null && (block._startMins == null || sMins < block._startMins)) {
      block._startMins = sMins;
      block.startTime = startTime;
    }
    if (eMins != null && (block._endMins == null || eMins > block._endMins)) {
      block._endMins = eMins;
      block.endTime = endTime;
    }
  }
}

const blocks = [];
let activeBlocks = 0;
let cancelledBlocks = 0;
for (const b of blocksMap.values()) {
  const codes = Array.from(b.attendCodes);
  const hasCancelled = codes.some(c => CANCELLED.has(c));
  if (b.hasActive) activeBlocks++;
  else if (hasCancelled) cancelledBlocks++;
  blocks.push({
    displayName: b.displayName,
    normalName: b.normalName,
    date: b.date,
    startTime: b.startTime,
    endTime: b.endTime,
    sessionCount: b.sessionCount,
    totalMins: b.totalMins,
    hasActive: b.hasActive,
    attendCodes: codes,
  });
}

const out = {
  blocks,
  rawSessions: normalizedSessions,
  stats: {
    totalRows: rows.length,
    totalBlocks: blocks.length,
    activeBlocks,
    cancelledBlocks,
  },
};

fs.writeFileSync(OUTPUT, JSON.stringify(out, null, 2));
console.log(JSON.stringify(out.stats));
console.log('wrote', OUTPUT);
