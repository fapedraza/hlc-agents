const fs = require('fs');

const CANCEL_STATUSES = new Set(['cancelled','canceled','no-show','no show','noshow','deleted','removed','void','anm','anm - paid','anm - unpaid','absent no makeup']);
const EXCLUDED_SERVICES = new Set(['head teacher','training/shadow','admin project']);
const TOLERANCE = 5;
const WEEK_START = '2026-04-15';
const WEEK_END = '2026-04-21';

function normalName(s) {
  if (!s) return '';
  s = String(s).toLowerCase().trim();
  if (s.includes(',')) {
    const [last, first] = s.split(',').map(x=>x.trim());
    s = `${first} ${last}`;
  }
  s = s.replace(/\b(jr|sr|ii|iii|iv|md|phd|dds)\.?\b/g,'');
  s = s.replace(/[^a-z\s]/g,' ');
  return s.split(/\s+/).filter(Boolean).sort().join(' ');
}

function to24(t) {
  if (!t) return null;
  t = String(t).trim().toLowerCase();
  const m = t.match(/^(\d{1,2}):?(\d{2})?\s*(am|pm)?$/);
  if (!m) return null;
  let h = parseInt(m[1],10);
  const mm = m[2] ? parseInt(m[2],10) : 0;
  const ap = m[3];
  if (ap === 'am') { if (h === 12) h = 0; }
  else if (ap === 'pm') { if (h !== 12) h += 12; }
  return `${String(h).padStart(2,'0')}:${String(mm).padStart(2,'0')}`;
}

function toMins(t) { if (!t) return null; const [h,m] = t.split(':').map(Number); return h*60+m; }

function parseDuration(s) {
  if (!s) return null;
  s = String(s).toLowerCase();
  let total = 0;
  const hMatch = s.match(/(\d+(?:\.\d+)?)\s*hour/);
  const mMatch = s.match(/(\d+)\s*min/);
  if (hMatch) total += parseFloat(hMatch[1])*60;
  if (mMatch) total += parseInt(mMatch[1],10);
  if (!hMatch && !mMatch) { const n = parseInt(s,10); if (!isNaN(n)) total = n; }
  return total || null;
}

function normalizeDate(s) {
  if (!s) return null;
  s = String(s).trim();
  let m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (m) return `${m[3]}-${String(m[1]).padStart(2,'0')}-${String(m[2]).padStart(2,'0')}`;
  m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  return s;
}

function parseCSV(text) {
  const rows = [];
  let row = [], field = '', inQ = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQ) {
      if (c === '"') { if (text[i+1] === '"') { field += '"'; i++; } else inQ = false; }
      else field += c;
    } else {
      if (c === '"') inQ = true;
      else if (c === ',') { row.push(field); field = ''; }
      else if (c === '\r') {}
      else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
      else field += c;
    }
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows.filter(r => r.length > 1 || (r.length === 1 && r[0].trim()));
}

const lcosData = JSON.parse(fs.readFileSync('C:\\projects\\hlc-agents\\lcos_blocks.json','utf8'));
const lcosBlocks = lcosData.blocks;
const lcosRaw = lcosData.rawSessions;

const csvText = fs.readFileSync('C:\\projects\\hlc-agents\\.playwright-mcp\\appointplus324-329-638962a.csv','utf8');
const csvRows = parseCSV(csvText);
const headers = csvRows[0].map(h => h.toLowerCase().trim());
const colIdx = (aliases) => { for (const a of aliases) { const i = headers.indexOf(a); if (i >= 0) return i; } return -1; };
const iName = colIdx(['client name','student name','client','student','name','full name']);
const iDate = colIdx(['date','appointment date','appt date','session date','start date','scheduled date']);
const iStart = colIdx(['start time','start_time','time','begin','begin time','appt time','appointment time','scheduled time']);
const iEnd = colIdx(['end time','end_time','finish','finish time','stop time']);
const iDur = colIdx(['duration','length','minutes','duration (min)','mins','total time','appt length']);
const iStatus = colIdx(['status','appt status','appointment status','state','session status','session type']);
const iService = colIdx(['service','type','service type','category','appointment type','appt type']);
const iStaff = colIdx(['staff','provider','instructor','teacher','staff name','employee','assigned to']);
const iNotes = colIdx(['notes','comments','memo','remarks','description','session notes','internal notes','session notes (internal)']);

const aplusSessions = [];
for (let r = 1; r < csvRows.length; r++) {
  const row = csvRows[r];
  if (!row[iName]) continue;
  const statusRaw = (iStatus >= 0 ? row[iStatus] : '').trim();
  const service = (iService >= 0 ? row[iService] : '').trim();
  const staff = (iStaff >= 0 ? row[iStaff] : '').trim();
  const notes = (iNotes >= 0 ? row[iNotes] : '').trim();
  const statusLc = statusRaw.toLowerCase();
  const isCancelled = CANCEL_STATUSES.has(statusLc);

  if (EXCLUDED_SERVICES.has(service.toLowerCase())) continue;
  if (staff.toLowerCase().includes('retest')) continue;
  const nameLc = (row[iName] || '').toLowerCase();
  const statusLc2 = statusLc;
  if (nameLc.includes('head teacher') || nameLc.includes('teacher training') || nameLc.includes('training/shadow') || nameLc.includes('admin project') || nameLc.includes('interactives')) continue;
  if (statusLc2.includes('head teacher') || statusLc2.includes('training/shadow') || statusLc2.includes('admin project')) continue;

  const date = normalizeDate(row[iDate]);
  if (!date || date < WEEK_START || date > WEEK_END) continue;
  const startTime = to24(row[iStart]);
  let endTime = iEnd >= 0 ? to24(row[iEnd]) : null;
  let durationMins = iDur >= 0 ? parseDuration(row[iDur]) : null;
  if (!endTime && startTime && durationMins) {
    const m = toMins(startTime) + durationMins;
    endTime = `${String(Math.floor(m/60)).padStart(2,'0')}:${String(m%60).padStart(2,'0')}`;
  }
  if (!durationMins && startTime && endTime) durationMins = toMins(endTime) - toMins(startTime);

  const studentName = row[iName].trim();
  aplusSessions.push({
    date, studentName, normalName: normalName(studentName),
    startTime, endTime, durationMins,
    status: statusRaw, service, staff, notes,
    isActive: !isCancelled, isCancelled
  });
}

const aplusBlockMap = new Map();
for (const s of aplusSessions) {
  const key = `${s.normalName}|${s.date}`;
  if (!aplusBlockMap.has(key)) {
    aplusBlockMap.set(key, { displayName: s.studentName, normalName: s.normalName, date: s.date, startTime: null, endTime: null, sessionCount: 0, totalMins: 0, hasActive: false, sessions: [] });
  }
  const b = aplusBlockMap.get(key);
  b.sessions.push(s);
  b.sessionCount++;
  if (s.isActive) {
    b.hasActive = true;
    b.totalMins += s.durationMins || 0;
    if (s.startTime) { if (!b.startTime || toMins(s.startTime) < toMins(b.startTime)) b.startTime = s.startTime; }
    if (s.endTime) { if (!b.endTime || toMins(s.endTime) > toMins(b.endTime)) b.endTime = s.endTime; }
  }
}

const lcosMap = new Map();
for (const b of lcosBlocks) lcosMap.set(`${b.normalName}|${b.date}`, b);

const keys = new Set([...lcosMap.keys(), ...aplusBlockMap.keys()]);
const discrepancies = [];
let matched = 0;

const fmtRange = (b) => (!b || !b.startTime) ? '(no active)' : `${b.startTime} to ${b.endTime}`;

for (const key of keys) {
  const lb = lcosMap.get(key);
  const ab = aplusBlockMap.get(key);
  if (lb && ab) {
    if (lb.hasActive && ab.hasActive) {
      matched++;
      const ds = Math.abs(toMins(lb.startTime) - toMins(ab.startTime));
      const de = Math.abs(toMins(lb.endTime) - toMins(ab.endTime));
      if (ds > TOLERANCE || de > TOLERANCE) {
        discrepancies.push({ type: 'Schedule Mismatch', student: lb.displayName, date: lb.date, lcos_detail: fmtRange(lb), aplus_detail: fmtRange(ab), lcos_mins: lb.totalMins, aplus_mins: ab.totalMins });
      }
    } else if (!lb.hasActive && ab.hasActive) {
      const codes = (lb.attendCodes || []).join('/');
      discrepancies.push({ type: 'Not Cancelled in A+', student: ab.displayName, date: ab.date, lcos_detail: codes || 'Cancelled', aplus_detail: fmtRange(ab), lcos_mins: 0, aplus_mins: ab.totalMins });
    } else if (lb.hasActive && !ab.hasActive) {
      discrepancies.push({ type: 'Not Cancelled in LCOS', student: lb.displayName, date: lb.date, lcos_detail: fmtRange(lb), aplus_detail: 'Cancelled', lcos_mins: lb.totalMins, aplus_mins: 0 });
    }
  } else if (lb && !ab) {
    if (lb.hasActive) discrepancies.push({ type: 'Missing in A+', student: lb.displayName, date: lb.date, lcos_detail: fmtRange(lb), aplus_detail: '(not found)', lcos_mins: lb.totalMins, aplus_mins: 0 });
  } else if (!lb && ab) {
    if (ab.hasActive) discrepancies.push({ type: 'Missing in LCOS', student: ab.displayName, date: ab.date, lcos_detail: '(not found)', aplus_detail: fmtRange(ab), lcos_mins: 0, aplus_mins: ab.totalMins });
  }
}

for (const [key, ab] of aplusBlockMap.entries()) {
  const active = ab.sessions.filter(s => s.isActive && s.startTime && s.endTime);
  if (active.length < 2) continue;
  let flagged = false;
  for (let i = 0; i < active.length && !flagged; i++) {
    for (let j = i+1; j < active.length && !flagged; j++) {
      const a = active[i], b = active[j];
      const as = toMins(a.startTime), ae = toMins(a.endTime);
      const bs = toMins(b.startTime), be = toMins(b.endTime);
      if (as < be && bs < ae) {
        const s1 = (a.staff||'').toLowerCase().trim();
        const s2 = (b.staff||'').toLowerCase().trim();
        if (s1 !== s2) {
          const detail = active.map(s => `${s.startTime}-${s.endTime} [${s.staff||'?'}]`).join(', ');
          discrepancies.push({ type: 'Double Booked', student: ab.displayName, date: ab.date, lcos_detail: '-', aplus_detail: detail, lcos_mins: 0, aplus_mins: ab.totalMins });
          flagged = true;
        }
      }
    }
  }
}

const typePriority = {'Missing in A+':1,'Missing in LCOS':2,'Not Cancelled in A+':3,'Not Cancelled in LCOS':4,'Schedule Mismatch':5,'Double Booked':6};
discrepancies.sort((a,b) => {
  if (a.date !== b.date) return a.date < b.date ? -1 : 1;
  const pa = typePriority[a.type]||99, pb = typePriority[b.type]||99;
  if (pa !== pb) return pa - pb;
  return a.student.localeCompare(b.student);
});

const lcosActive = lcosBlocks.filter(b=>b.hasActive).length;
const lcosCancelled = lcosBlocks.length - lcosActive;
const aplusBlocksArr = [...aplusBlockMap.values()];
const aplusActive = aplusBlocksArr.filter(b=>b.hasActive).length;
const aplusCancelled = aplusBlocksArr.length - aplusActive;

const dates = [];
for (let d = new Date(WEEK_START+'T00:00:00'); d <= new Date(WEEK_END+'T00:00:00'); d.setDate(d.getDate()+1)) dates.push(d.toISOString().slice(0,10));
const perDay = dates.map(date => {
  const lcosDay = lcosBlocks.filter(b=>b.date===date).length;
  const aplusDay = aplusBlocksArr.filter(b=>b.date===date).length;
  const matchedDay = [...lcosMap.keys()].filter(k=>{ const lb=lcosMap.get(k); const ab=aplusBlockMap.get(k); return lb && ab && lb.hasActive && ab.hasActive && lb.date===date; }).length;
  const discDay = discrepancies.filter(d=>d.date===date).length;
  return {date, lcos: lcosDay, aplus: aplusDay, matched: matchedDay, discrepancies: discDay};
});

const typeCounts = {};
for (const d of discrepancies) typeCounts[d.type] = (typeCounts[d.type] || 0) + 1;

const stats = { lcosTotal: lcosBlocks.length, lcosActive, lcosCancelled, aplusTotal: aplusBlocksArr.length, aplusActive, aplusCancelled, matched, discrepancies: discrepancies.length };

const out = { dateRange: {start: WEEK_START, end: WEEK_END}, stats, perDay, typeCounts, discrepancies, lcosRaw, aplusRaw: aplusSessions };
fs.writeFileSync('C:\\projects\\hlc-agents\\reconcile_output.json', JSON.stringify(out, null, 2));
console.log(JSON.stringify({stats, typeCounts, perDay}, null, 2));
console.log('\nSample discrepancies:');
discrepancies.slice(0,15).forEach(d => console.log(`  [${d.date}] ${d.type}: ${d.student} | LCOS: ${d.lcos_detail} | A+: ${d.aplus_detail}`));
console.log(`\nTotal discrepancies: ${discrepancies.length}`);
