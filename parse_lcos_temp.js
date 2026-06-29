const fs = require('fs');
const raw = fs.readFileSync('C:/Users/hlcadmin/.claude/projects/C--projects-hlc-agents/ea58b685-073b-4330-9a6c-0e31d87849aa/tool-results/mcp-lcos-lcos_sign_in_sheet-1776027332056.txt', 'utf8');
const outer = JSON.parse(raw);
const text = outer[0].text;
const jsonStart = text.indexOf('{');
const inner = JSON.parse(text.slice(jsonStart));
const rows = inner.rows;

// Normalize name: lowercase, trim, first+last -> sorted words
function normalizeName(last, first) {
  let s = (first + ' ' + last).trim().toLowerCase();
  // Remove suffixes: jr, sr, ii, iii, iv (as whole words)
  s = s.replace(/\b(jr|sr|ii|iii|iv)\b/g, '');
  // Remove non-alpha except spaces
  s = s.replace(/[^a-z ]/g, '');
  // Split, filter empty, sort alphabetically, join
  const words = s.split(/\s+/).filter(w => w.length > 0);
  words.sort();
  return words.join(' ');
}

// Parse forday to YYYY-MM-DD
function parseDate(forday) {
  const m = forday.match(/^(\d+)\/(\d+)\/(\d+)/);
  if (!m) return null;
  const month = m[1].padStart(2, '0');
  const day = m[2].padStart(2, '0');
  const year = m[3];
  return year + '-' + month + '-' + day;
}

// Parse time HH:MM:SS -> HH:MM
function parseTime(t) {
  if (!t) return null;
  const m = t.match(/^(\d{2}):(\d{2})/);
  if (!m) return null;
  return m[1] + ':' + m[2];
}

// Duration in mins
function durationMins(start, end) {
  if (!start || !end) return 0;
  const [sh, sm] = start.split(':').map(Number);
  const [eh, em] = end.split(':').map(Number);
  return (eh * 60 + em) - (sh * 60 + sm);
}

const ACTIVE_CODES = new Set(['ATD', 'MU', 'EXT']);
const CANCELLED_CODES = new Set(['ABS', 'VAC', 'ANM']);

const sessions = rows.map(row => {
  const studentName = ((row.firstname || '') + ' ' + (row.lastname || '')).trim();
  const normalName = normalizeName(row.lastname || '', row.firstname || '');
  const date = parseDate(row.forday);
  const startTime = parseTime(row.starttime);
  const endTime = parseTime(row.endtime);
  const attendCode = row.attendcode || '';

  return {
    date,
    studentName,
    normalName,
    clientId: row.clientid,
    service: row.service,
    subjectArea: row.subjectarea,
    startTime,
    endTime,
    durationMins: durationMins(startTime, endTime),
    attendCode,
    statusCode: row.statuscode,
    isActive: ACTIVE_CODES.has(attendCode),
    isCancelled: CANCELLED_CODES.has(attendCode),
    notes: row.notes || null
  };
});

// Build blocks
const blocks = {};
for (const session of sessions) {
  const key = session.normalName + '|' + session.date;
  if (!blocks[key]) {
    blocks[key] = {
      displayName: session.studentName,
      normalName: session.normalName,
      date: session.date,
      startTime: null,
      endTime: null,
      sessionCount: 0,
      totalMins: 0,
      hasActive: false,
      sessions: []
    };
  }
  const block = blocks[key];
  block.sessionCount++;
  block.sessions.push(session);

  if (session.isActive) {
    block.totalMins += session.durationMins;
    block.hasActive = true;
    if (!block.startTime || session.startTime < block.startTime) {
      block.startTime = session.startTime;
    }
    if (!block.endTime || session.endTime > block.endTime) {
      block.endTime = session.endTime;
    }
  }
}

const blockKeys = Object.keys(blocks);
const activeCount = blockKeys.filter(k => blocks[k].hasActive).length;
const cancelledCount = blockKeys.filter(k => !blocks[k].hasActive).length;

const result = {
  sessions,
  blocks,
  stats: {
    total: blockKeys.length,
    active: activeCount,
    cancelled: cancelledCount
  }
};

process.stdout.write(JSON.stringify(result, null, 2));
