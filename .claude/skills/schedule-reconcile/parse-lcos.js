const fs = require('fs');
const path = require('path');

const lcosTxtPath = process.argv[2];
const outPath = process.argv[3] || path.join(__dirname, '..', '..', '..', '.playwright-mcp', 'lcos_parsed.json');

const raw = fs.readFileSync(lcosTxtPath, 'utf8');
const firstBrace = raw.indexOf('{');
const json = JSON.parse(raw.slice(firstBrace));
const rows = json.rows || [];

function normName(name) {
  if (!name) return '';
  let s = String(name).toLowerCase().trim();
  if (s.includes(',')) {
    const parts = s.split(',');
    s = parts.slice(1).join(' ').trim() + ' ' + parts[0].trim();
  }
  s = s.replace(/\b(jr|sr|ii|iii|iv|md|phd|dds)\.?\b/g, '');
  s = s.replace(/[^a-z\s]/g, ' ');
  const words = s.split(/\s+/).filter(Boolean).sort();
  return words.join(' ');
}

function normTime(t) {
  if (!t) return '';
  const s = String(t).trim();
  const m24 = s.match(/^(\d{1,2}):(\d{2})(:\d{2})?$/);
  if (m24) {
    return `${String(parseInt(m24[1],10)).padStart(2,'0')}:${m24[2]}`;
  }
  const m12 = s.match(/^(\d{1,2}):(\d{2})\s*(am|pm|AM|PM)$/i);
  if (m12) {
    let h = parseInt(m12[1],10);
    const ap = m12[3].toLowerCase();
    if (ap === 'pm' && h !== 12) h += 12;
    if (ap === 'am' && h === 12) h = 0;
    return `${String(h).padStart(2,'0')}:${m12[2]}`;
  }
  return s;
}

function normDate(d) {
  if (!d) return '';
  const s = String(d).trim();
  const iso = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
  const us = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})/);
  if (us) {
    let y = us[3];
    if (y.length === 2) y = '20' + y;
    return `${y}-${String(us[1]).padStart(2,'0')}-${String(us[2]).padStart(2,'0')}`;
  }
  return s;
}

function timeToMins(t) {
  const [h, m] = t.split(':').map(x => parseInt(x, 10));
  return h * 60 + m;
}

const sessions = [];
for (const r of rows) {
  const first = r.firstname || '';
  const last = r.lastname || '';
  const display = (first + ' ' + last).trim();
  const norm = normName(display);
  const date = normDate(r.forday);
  const startTime = normTime(r.starttime);
  const endTime = normTime(r.endtime);
  let durationMins = 0;
  if (startTime && endTime) {
    durationMins = Math.max(0, timeToMins(endTime) - timeToMins(startTime));
  }
  const attendCode = (r.attendcode || '').toUpperCase();
  const statusCode = (r.statuscode || '').toUpperCase();
  const isActive = ['ATD', 'MU', 'EXT'].includes(attendCode);
  const isCancelled = ['ABS', 'VAC', 'ANM'].includes(attendCode);
  sessions.push({
    date, studentName: display, normalName: norm, clientId: r.clientid,
    service: r.service, subjectArea: r.subjectarea,
    startTime, endTime, durationMins,
    attendCode, statusCode, isActive, isCancelled,
    notes: r.notes || ''
  });
}

const blockMap = {};
for (const s of sessions) {
  if (!s.normalName || !s.date) continue;
  const key = `${s.normalName}|${s.date}`;
  if (!blockMap[key]) {
    blockMap[key] = {
      displayName: s.studentName,
      normalName: s.normalName,
      date: s.date,
      startTime: '', endTime: '',
      sessionCount: 0, totalMins: 0,
      hasActive: false,
      sessions: [],
      activeAttendCodes: [],
      cancelAttendCodes: []
    };
  }
  const b = blockMap[key];
  b.sessions.push(s);
  b.sessionCount++;
  if (s.isActive) {
    b.hasActive = true;
    b.totalMins += s.durationMins;
    b.activeAttendCodes.push(s.attendCode);
    if (s.startTime && (!b.startTime || timeToMins(s.startTime) < timeToMins(b.startTime))) b.startTime = s.startTime;
    if (s.endTime && (!b.endTime || timeToMins(s.endTime) > timeToMins(b.endTime))) b.endTime = s.endTime;
  } else if (s.isCancelled) {
    b.cancelAttendCodes.push(s.attendCode);
  }
}

const blocks = Object.values(blockMap);

fs.writeFileSync(outPath, JSON.stringify({ sessions, blocks }, null, 2));
console.log(`LCOS: ${sessions.length} sessions, ${blocks.length} student-day blocks`);
console.log(`Active blocks: ${blocks.filter(b => b.hasActive).length}`);
console.log(`Wrote: ${outPath}`);
