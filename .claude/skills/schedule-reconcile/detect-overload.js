/**
 * detect-overload.js — find tutors with too many students at once.
 *
 * Mariah, Slack DM 2026-07-27:
 *   "Possible to add a check for when more than 4 floor students are booked at
 *    the same time? Miller Morissette was moved to me because - if it had been
 *    left on Jen A.W. - she would have had 5 students from 3:00-3:30pm."
 *
 * Her screenshot shows Jen A. W. on one day with Max Anderson (2-4), Benjamin
 * Sanchez (2-3:30), Anvita Sattenapalli (3-5) and Cillian Hynes (3-4:30) already
 * overlapping at 3:00-3:30, so Miller Morissette's Verbal Floor (3-4) would have
 * been the fifth.
 *
 * CAVEAT on "floor": her screenshot labels sessions "Math Floor" / "Verbal Floor"
 * vs "Learning Center 1:1 A", but the A+ Schedule Report (763) we download has no
 * Service column - only Student Name, Start Time, Duration, Session Status,
 * Teacher, Notes, Session Date. So this counts CONCURRENT STUDENTS regardless of
 * service. That is arguably the better measure anyway: 4 floor students plus a 1:1
 * is still five people needing one tutor. If we want strictly floor-only, we need
 * a saved A+ report that includes the service column.
 *
 * READ-ONLY. Prints findings; writes nothing.
 *
 * Usage: node detect-overload.js [--max 4] [--from YYYY-MM-DD] [--to YYYY-MM-DD] [--csv path]
 */
const fs = require('fs');
const path = require('path');

const SR_DIR = path.join(__dirname, '..', 'schedule-request');
const { isNonTutor } = require(path.join(SR_DIR, 'lib', 'non-tutors.js'));
const DEFAULT_CSV = path.join(SR_DIR, '.cache', 'history-report.csv');

const argv = process.argv.slice(2);
const argVal = (f, d) => { const i = argv.indexOf(f); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const MAX_CONCURRENT = parseInt(argVal('--max', '4'), 10);
const FROM = argVal('--from', null);
const TO = argVal('--to', null);
const CSV = argVal('--csv', DEFAULT_CSV);
const BUCKET = 30; // minutes

const CANCELLED = new Set(['cancelled','canceled','no-show','no show','noshow','deleted','removed','void','anm','anm - paid','anm - unpaid','absent no makeup','abs','vac']);
const norm = s => (s || '').toLowerCase().replace(/\s+/g, ' ').trim();

function parseCsv(text) {
  const lines = text.split(/\r?\n/).filter(Boolean);
  const split = l => { const o=[]; let c='', q=false;
    for (let i=0;i<l.length;i++){ const ch=l[i];
      if(q){ if(ch==='"'&&l[i+1]==='"'){c+='"';i++;} else if(ch==='"'){q=false;} else c+=ch; }
      else if(ch==='"'){q=true;} else if(ch===','){o.push(c);c='';} else c+=ch; }
    o.push(c); return o; };
  const h = split(lines[0]).map(x=>x.trim());
  return lines.slice(1).map(l => { const r=split(l); const o={}; h.forEach((k,i)=>o[k]=(r[i]||'').trim()); return o; });
}
function mdyToISO(s){ const m=(s||'').trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/); return m?`${m[3]}-${String(m[1]).padStart(2,'0')}-${String(m[2]).padStart(2,'0')}`:null; }
function toMins(s){ if(!s) return null; const m=s.trim().match(/^(\d{1,2}):?(\d{2})?\s*(am|pm)?$/i); if(!m) return null;
  let h=+m[1]; const mm=+(m[2]||0); const ap=(m[3]||'').toLowerCase();
  if(ap==='pm'&&h!==12)h+=12; if(ap==='am'&&h===12)h=0; return h*60+mm; }
function durMins(s){ if(!s) return 60; const t=String(s).toLowerCase(); let n=0;
  const h=t.match(/([\d.]+)\s*hour/); if(h) n+=Math.round(parseFloat(h[1])*60);
  const m=t.match(/([\d.]+)\s*min/);  if(m) n+=Math.round(parseFloat(m[1]));
  if(!n){ const p=parseInt(t,10); if(!isNaN(p)) n=p; }
  return n || 60; }
const fmt = m => `${String(Math.floor(m/60)).padStart(2,'0')}:${String(m%60).padStart(2,'0')}`;

// ─── load ────────────────────────────────────────────────────────────────────
if (!fs.existsSync(CSV)) { console.error(`Missing A+ report: ${CSV}`); process.exit(1); }
const rows = parseCsv(fs.readFileSync(CSV, 'utf8'));
const ageH = ((Date.now() - fs.statSync(CSV).mtimeMs) / 3600e3).toFixed(1);

// teacher|date -> [{student, start, end}]
const byTeacherDay = new Map();
let used = 0;
for (const r of rows) {
  if (CANCELLED.has(norm(r['Session Status']))) continue;
  const teacher = (r['Teacher'] || '').trim();
  // "McRetest Retest" is a proctored group retest, not a tutor with a caseload.
  // It legitimately has 7-8 students at once and would dominate the report.
  if (isNonTutor(teacher)) continue;
  const student = (r['Student Name'] || '').trim();
  const date = mdyToISO(r['Session Date']);
  const start = toMins(r['Start Time']);
  if (!teacher || !student || !date || start == null) continue;
  if (FROM && date < FROM) continue;
  if (TO && date > TO) continue;
  const end = start + durMins(r['Duration']);
  const k = `${teacher}|${date}`;
  if (!byTeacherDay.has(k)) byTeacherDay.set(k, []);
  byTeacherDay.get(k).push({ student, start, end });
  used++;
}

// ─── sweep 30-minute buckets ────────────────────────────────────────────────
const findings = [];
for (const [k, sess] of byTeacherDay) {
  const [teacher, date] = k.split('|');
  const lo = Math.min(...sess.map(s => s.start));
  const hi = Math.max(...sess.map(s => s.end));
  const flagged = [];
  for (let t = Math.floor(lo / BUCKET) * BUCKET; t < hi; t += BUCKET) {
    // A session occupies this bucket if it overlaps it at all.
    const here = sess.filter(s => s.start < t + BUCKET && s.end > t);
    const students = [...new Set(here.map(s => s.student))];
    if (students.length > MAX_CONCURRENT) flagged.push({ t, students });
  }
  if (!flagged.length) continue;
  // Merge contiguous buckets into one finding so a 2-hour overload is one row.
  let cur = null;
  for (const f of flagged) {
    if (cur && f.t === cur.end) { cur.end = f.t + BUCKET; f.students.forEach(s => cur.students.add(s)); cur.peak = Math.max(cur.peak, f.students.length); }
    else { if (cur) findings.push(cur); cur = { teacher, date, start: f.t, end: f.t + BUCKET, students: new Set(f.students), peak: f.students.length }; }
  }
  if (cur) findings.push(cur);
}
findings.sort((a, b) => b.peak - a.peak || (a.date < b.date ? -1 : 1));

// ─── report ─────────────────────────────────────────────────────────────────
console.log(`A+ report: ${rows.length} rows (${ageH}h old), ${used} usable sessions${FROM||TO ? ` in ${FROM||'..'}..${TO||'..'}` : ''}`);
console.log(`Threshold: more than ${MAX_CONCURRENT} concurrent students in a ${BUCKET}-minute window\n`);
if (!findings.length) { console.log('No overloads found.'); process.exit(0); }

const days = new Set(findings.map(f => f.date));
console.log(`=== ${findings.length} overload window(s) across ${days.size} day(s), ${new Set(findings.map(f=>f.teacher)).size} tutor(s) ===\n`);
for (const f of findings.slice(0, 40)) {
  console.log(`${f.date}  ${f.teacher.padEnd(22)} ${fmt(f.start)}-${fmt(f.end)}  peak ${f.peak} students`);
  console.log(`     ${[...f.students].join(', ')}`);
}
if (findings.length > 40) console.log(`\n... and ${findings.length - 40} more`);

// Most overloads are a recurring weekly slot, so the same problem shows up once
// per week. Collapse them: one underlying schedule to fix, not six incidents.
const DAY = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
const recur = new Map();
for (const f of findings) {
  const dow = DAY[new Date(f.date + 'T12:00:00').getDay()];
  const k = `${f.teacher}|${dow}|${f.start}|${f.end}`;
  if (!recur.has(k)) recur.set(k, { teacher: f.teacher, dow, start: f.start, end: f.end, dates: [], peak: 0, students: new Set() });
  const g = recur.get(k);
  g.dates.push(f.date); g.peak = Math.max(g.peak, f.peak); f.students.forEach(s => g.students.add(s));
}
const groups = [...recur.values()].sort((a,b)=>b.peak - a.peak || b.dates.length - a.dates.length);
console.log(`\n=== COLLAPSED TO ${groups.length} RECURRING PATTERN(S) ===`);
for (const g of groups) {
  console.log(`\n${g.teacher} - ${g.dow} ${fmt(g.start)}-${fmt(g.end)}  peak ${g.peak} students  (${g.dates.length}x: ${g.dates.join(', ')})`);
  console.log(`   ${[...g.students].join(', ')}`);
}

const byTeacher = {};
for (const f of findings) byTeacher[f.teacher] = (byTeacher[f.teacher] || 0) + 1;
console.log('\n=== BY TUTOR (incidents) ===');
Object.entries(byTeacher).sort((a,b)=>b[1]-a[1]).forEach(([t,n]) => console.log(`  ${String(n).padStart(3)}  ${t}`));
console.log('\nREAD-ONLY: nothing written.');
