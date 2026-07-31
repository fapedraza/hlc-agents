const fs = require('fs');
const path = require('path');

const lcosPath = process.argv[2];
const csvPath = process.argv[3];
const startDate = process.argv[4]; // YYYY-MM-DD
const endDate = process.argv[5];
const outPath = process.argv[6] || path.join(path.dirname(lcosPath), 'reconciliation.json');

// ---- helpers ----
function normName(name) {
  if (!name) return '';
  let s = String(name).toLowerCase().trim();
  if (s.includes(',')) {
    const parts = s.split(',');
    s = parts.slice(1).join(' ').trim() + ' ' + parts[0].trim();
  }
  s = s.replace(/\b(jr|sr|ii|iii|iv|md|phd|dds)\.?\b/g, '');
  s = s.replace(/[^a-z\s]/g, ' ');
  return s.split(/\s+/).filter(Boolean).sort().join(' ');
}
function normTime(t) {
  if (!t) return '';
  const s = String(t).trim();
  const m24 = s.match(/^(\d{1,2}):(\d{2})(:\d{2})?$/);
  if (m24) return `${String(parseInt(m24[1],10)).padStart(2,'0')}:${m24[2]}`;
  const m12 = s.match(/^(\d{1,2}):?(\d{2})?\s*(am|pm)$/i);
  if (m12) {
    let h = parseInt(m12[1],10);
    const m = m12[2] || '00';
    const ap = m12[3].toLowerCase();
    if (ap === 'pm' && h !== 12) h += 12;
    if (ap === 'am' && h === 12) h = 0;
    return `${String(h).padStart(2,'0')}:${m}`;
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
function timeToMins(t) { const [h,m] = t.split(':').map(x=>parseInt(x,10)); return h*60+m; }
function minsToTime(n) { const h = Math.floor(n/60); const m = n%60; return `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}`; }
function parseDuration(d) {
  if (!d) return 0;
  const s = String(d).toLowerCase().trim();
  // Plain number → assume minutes
  const plain = parseFloat(s);
  if (!isNaN(plain) && /^\d+(\.\d+)?$/.test(s)) return Math.round(plain);
  // Extract hours and minutes separately from compound strings
  // Handles: "1 hour 30 minutes", "2 hours", "30 minutes", "1.5 hours", "1 hr 30 min"
  let mins = 0;
  const hourMatch = s.match(/([\d.]+)\s*h(?:ours?|rs?)?/);
  const minMatch = s.match(/([\d.]+)\s*m(?:in(?:ute)?s?)?/);
  if (hourMatch) mins += parseFloat(hourMatch[1]) * 60;
  if (minMatch) mins += parseFloat(minMatch[1]);
  return Math.round(mins) || 0;
}

// ---- parse CSV (simple RFC4180) ----
function parseCsv(text) {
  const rows = [];
  let cur = [], field = '', inQ = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQ) {
      if (c === '"') {
        if (text[i+1] === '"') { field += '"'; i++; }
        else inQ = false;
      } else field += c;
    } else {
      if (c === '"') inQ = true;
      else if (c === ',') { cur.push(field); field = ''; }
      else if (c === '\r') { /* skip */ }
      else if (c === '\n') { cur.push(field); rows.push(cur); cur = []; field = ''; }
      else field += c;
    }
  }
  if (field.length > 0 || cur.length > 0) { cur.push(field); rows.push(cur); }
  return rows;
}

// ---- load data ----
const lcosData = JSON.parse(fs.readFileSync(lcosPath, 'utf8'));
const lcosBlocks = lcosData.blocks;
const lcosSessions = lcosData.sessions || lcosData.rawSessions || [];

const csvText = fs.readFileSync(csvPath, 'utf8');
const csvRows = parseCsv(csvText);
const headers = csvRows[0].map(h => h.toLowerCase().trim());

const aliases = {
  studentName: ['client name','student name','client','student','name','full name'],
  date: ['date','appointment date','appt date','session date','start date','scheduled date'],
  startTime: ['start time','start_time','time','begin','begin time','appt time','appointment time','scheduled time'],
  endTime: ['end time','end_time','finish','finish time','stop time'],
  duration: ['duration','length','minutes','duration (min)','mins','total time','appt length'],
  status: ['status','appt status','appointment status','state','session status','session type'],
  service: ['service','type','service type','category','appointment type','appt type'],
  staff: ['staff','provider','instructor','teacher','staff name','employee','assigned to'],
  notes: ['notes','comments','memo','remarks','description','session notes','internal notes','session notes (internal)']
};
const colIdx = {};
for (const [k, al] of Object.entries(aliases)) {
  for (let i = 0; i < headers.length; i++) {
    if (al.includes(headers[i])) { colIdx[k] = i; break; }
  }
}

const cancelStatuses = ['cancelled','canceled','no-show','no show','noshow','deleted','removed','void','anm','anm - paid','anm - unpaid','absent no makeup'];
// Role placeholders. A+ books non-teaching time against a pseudo-student the way
// retests are booked against a pseudo-tutor: "Head Teacher" (200 rows in six
// months) and "Teacher Training" (7). None can exist in LCOS, so each one became a
// false "Missing in LCOS" — a median of 4 per weekly report, in all 26 of the last
// 26 weeks. 'head teacher' was already listed here but only ever compared against
// the status and service; matching the STUDENT NAME is what was missing.
//
// The name is the right key, not the service: 79 of these rows are booked against
// ordinary tutoring services (Homework, Math, Learning Center 1:1 A), and one real
// student legitimately has an "Admin Work" booking that must not be swallowed.
const excludedLabels = ['head teacher','teacher training','training/shadow','admin project'];

const aplusSessions = [];
const aplusAllSessions = []; // includes cancelled for the A+ Schedule tab
const retestSessions = []; // active retests (e.g. staff "McRetest Retest"); excluded from the normal reconcile but used for session/retest overlap detection
for (let i = 1; i < csvRows.length; i++) {
  const row = csvRows[i];
  if (!row || row.every(c => !c || !c.trim())) continue;
  const student = colIdx.studentName != null ? (row[colIdx.studentName] || '').trim() : '';
  if (!student) continue;
  const status = (colIdx.status != null ? row[colIdx.status] : '').trim();
  const service = (colIdx.service != null ? row[colIdx.service] : '').trim();
  const staff = (colIdx.staff != null ? row[colIdx.staff] : '').trim();
  const date = normDate(colIdx.date != null ? row[colIdx.date] : '');
  const startTime = normTime(colIdx.startTime != null ? row[colIdx.startTime] : '');
  let endTime = normTime(colIdx.endTime != null ? row[colIdx.endTime] : '');
  const durationRaw = colIdx.duration != null ? row[colIdx.duration] : '';
  let durationMins = parseDuration(durationRaw);
  if (!endTime && startTime && durationMins) endTime = minsToTime(timeToMins(startTime) + durationMins);
  if (!durationMins && startTime && endTime) durationMins = Math.max(0, timeToMins(endTime) - timeToMins(startTime));
  const notes = colIdx.notes != null ? row[colIdx.notes] : '';
  const statusLower = status.toLowerCase();
  const isCancelled = cancelStatuses.includes(statusLower);

  const sessObj = {
    date, studentName: student, normalName: normName(student),
    startTime, endTime, durationMins,
    status, service, staff, notes,
    isActive: !isCancelled, isCancelled
  };
  aplusAllSessions.push(sessObj);

  // Exclude role placeholders and non-student services. These stay in
  // aplusAllSessions (pushed above) so the A+ Schedule tab still shows them —
  // they simply stop generating discrepancies they can never resolve.
  const studentLower = student.toLowerCase();
  if (excludedLabels.some(x => studentLower.includes(x) || statusLower.includes(x) || service.toLowerCase().includes(x))) continue;
  // Retests (e.g. staff "McRetest Retest") are excluded from the normal
  // LCOS<->A+ reconcile (they aren't recurring LCOS sessions), but we keep the
  // active ones to detect a student booked into a retest AND a session at the
  // same time (requested by Mariah 2026-05-30).
  if (staff.toLowerCase().includes('retest')) {
    if (!isCancelled && startTime && endTime) retestSessions.push(sessObj);
    continue;
  }

  aplusSessions.push(sessObj);
}

// Build A+ blocks
const aplusBlockMap = {};
for (const s of aplusSessions) {
  if (!s.normalName || !s.date) continue;
  const key = `${s.normalName}|${s.date}`;
  if (!aplusBlockMap[key]) {
    aplusBlockMap[key] = {
      displayName: s.studentName, normalName: s.normalName, date: s.date,
      startTime: '', endTime: '', sessionCount: 0, totalMins: 0,
      hasActive: false, sessions: []
    };
  }
  const b = aplusBlockMap[key];
  b.sessions.push(s);
  b.sessionCount++;
  if (s.isActive) {
    b.hasActive = true;
    b.totalMins += s.durationMins;
    if (s.startTime && (!b.startTime || timeToMins(s.startTime) < timeToMins(b.startTime))) b.startTime = s.startTime;
    if (s.endTime && (!b.endTime || timeToMins(s.endTime) > timeToMins(b.endTime))) b.endTime = s.endTime;
  }
}
const aplusBlocks = Object.values(aplusBlockMap);

// ---- helpers: date range ----
function eachDate(start, end) {
  const out = [];
  const d = new Date(start + 'T00:00:00');
  const e = new Date(end + 'T00:00:00');
  while (d <= e) {
    out.push(d.toISOString().slice(0,10));
    d.setDate(d.getDate() + 1);
  }
  return out;
}

// ---- guard: does the A+ export actually span the requested window? ----
// Since 2026-07-30 the A+ side is the shared schedule-report cache, a FIXED
// window (about -150/+45 days) rather than a pull for exactly this range. If it
// ever fails to cover the window, every LCOS session silently becomes "Missing
// in A+" — a catastrophic false report that looks like ordinary output. Fail loudly.
{
  const dates = aplusBlocks.map(b => b.date).filter(Boolean).sort();
  if (!dates.length) {
    console.error(`A+ export ${csvPath} contains no dated sessions — refusing to reconcile.`);
    process.exit(1);
  }
  const min = dates[0], max = dates[dates.length - 1];
  if (startDate < min || endDate > max) {
    console.error(`A+ export covers ${min}..${max} but the reconcile needs ${startDate}..${endDate}.`);
    console.error('Refusing to reconcile against a partial export: every unmatched LCOS session');
    console.error('would be reported as "Missing in A+". Widen the report window and retry.');
    process.exit(1);
  }
}

// ---- reconcile ----
// Filter blocks to the requested date range
const dateSet = new Set(eachDate(startDate, endDate));
const lcosMap = {};
for (const b of lcosBlocks) { if (dateSet.has(b.date)) lcosMap[`${b.normalName}|${b.date}`] = b; }
const aplusMap = {};
for (const b of aplusBlocks) { if (dateSet.has(b.date)) aplusMap[`${b.normalName}|${b.date}`] = b; }

const allKeys = new Set([...Object.keys(lcosMap), ...Object.keys(aplusMap)]);
const discrepancies = [];
let matched = 0;
const tol = 5;

for (const key of allKeys) {
  const l = lcosMap[key];
  const a = aplusMap[key];
  if (l && a) {
    if (l.hasActive && a.hasActive) {
      const dStart = Math.abs(timeToMins(l.startTime) - timeToMins(a.startTime));
      const dEnd = Math.abs(timeToMins(l.endTime) - timeToMins(a.endTime));
      if (dStart > tol || dEnd > tol) {
        discrepancies.push({
          type: 'Schedule Mismatch',
          student: l.displayName, date: l.date,
          lcos_detail: `${l.startTime} to ${l.endTime}`,
          aplus_detail: `${a.startTime} to ${a.endTime}`,
          lcos_mins: l.totalMins, aplus_mins: a.totalMins
        });
      } else {
        matched++;
      }
    } else if (!l.hasActive && a.hasActive) {
      discrepancies.push({
        type: 'Not Cancelled in A+',
        student: l.displayName, date: l.date,
        lcos_detail: l.cancelAttendCodes.join('/') || 'Cancelled',
        aplus_detail: `${a.startTime} to ${a.endTime}`,
        lcos_mins: 0, aplus_mins: a.totalMins
      });
    } else if (l.hasActive && !a.hasActive) {
      discrepancies.push({
        type: 'Not Cancelled in LCOS',
        student: l.displayName, date: l.date,
        lcos_detail: `${l.startTime} to ${l.endTime}`,
        aplus_detail: 'Cancelled',
        lcos_mins: l.totalMins, aplus_mins: 0
      });
    }
  } else if (l && !a) {
    if (l.hasActive) {
      discrepancies.push({
        type: 'Missing in A+',
        student: l.displayName, date: l.date,
        lcos_detail: `${l.startTime} to ${l.endTime}`,
        aplus_detail: '(not found)',
        lcos_mins: l.totalMins, aplus_mins: 0
      });
    }
  } else if (!l && a) {
    if (a.hasActive) {
      discrepancies.push({
        type: 'Missing in LCOS',
        student: a.displayName, date: a.date,
        lcos_detail: '(not found)',
        aplus_detail: `${a.startTime} to ${a.endTime}`,
        lcos_mins: 0, aplus_mins: a.totalMins
      });
    }
  }
}

// Double bookings
for (const b of aplusBlocks) {
  // aplusBlocks spans the whole cached report (months), not the requested window.
  // Every other check filters on dateSet; this one did not, so the daily report
  // carried stale double-bookings from as far back as the cache reached.
  if (!dateSet.has(b.date)) continue;
  const active = b.sessions.filter(s => s.isActive && s.startTime && s.endTime);
  for (let i = 0; i < active.length; i++) {
    for (let j = i + 1; j < active.length; j++) {
      const a1 = active[i], a2 = active[j];
      const s1 = timeToMins(a1.startTime), e1 = timeToMins(a1.endTime);
      const s2 = timeToMins(a2.startTime), e2 = timeToMins(a2.endTime);
      if (s1 < e2 && s2 < e1) {
        const staff1 = (a1.staff || '').toLowerCase();
        const staff2 = (a2.staff || '').toLowerCase();
        if (staff1 !== staff2) {
          const detail = active.map(s => `${s.startTime}-${s.endTime} [${s.staff || '?'}]`).join(', ');
          discrepancies.push({
            type: 'Double Booked',
            student: b.displayName, date: b.date,
            lcos_detail: '-',
            aplus_detail: detail,
            lcos_mins: 0, aplus_mins: b.totalMins
          });
          i = active.length; break;
        }
      }
    }
  }
}

// Session/Retest overlap: a student booked into a retest AND a tutoring session
// at overlapping times on the same day (e.g. ACT retest 9:00-14:00 while also in
// a 10:30-12:30 session). Retests were captured above (excluded from the normal
// reconcile). Match each active retest against the student's regular A+ sessions.
const retestByKey = {};
for (const r of retestSessions) {
  if (!r.normalName || !r.date || !dateSet.has(r.date)) continue;
  (retestByKey[`${r.normalName}|${r.date}`] = retestByKey[`${r.normalName}|${r.date}`] || []).push(r);
}
for (const key of Object.keys(retestByKey)) {
  const a = aplusMap[key];
  if (!a) continue; // no regular session that day → student just has the retest
  const sessions = a.sessions.filter(s => s.isActive && s.startTime && s.endTime);
  for (const r of retestByKey[key]) {
    const rs = timeToMins(r.startTime), re = timeToMins(r.endTime);
    const overlapping = sessions.filter(s => timeToMins(s.startTime) < re && rs < timeToMins(s.endTime));
    if (overlapping.length) {
      discrepancies.push({
        type: 'Session/Retest Overlap',
        student: a.displayName, date: a.date,
        lcos_detail: '-',
        aplus_detail: `Retest ${r.startTime}-${r.endTime} [${r.staff || '?'}] overlaps session ` +
          overlapping.map(s => `${s.startTime}-${s.endTime} [${s.staff || '?'}]`).join(', '),
        lcos_mins: 0, aplus_mins: a.totalMins
      });
      break; // one flag per student/day
    }
  }
}

// Tutor overload. Mariah, 2026-07-29:
//   "the 1:1 students should not be double booked. So, if there are 4x floor
//    students and 1x 1:1 students booked on the same tutor in the same 30min
//    block, the issue is that there is a 1:1 student double booked, NOT
//    necessarily that there are 5 students... Same issue if there were 3x floor
//    and 1x 1:1. So we definitely need it to still detect those double bookings,
//    but make an exception for the floor (LS) with a cap of 4 students at a time"
//
// So this is TWO rules, not one threshold. The earlier single ">4 concurrent"
// check missed 3 floor + 1 one-to-one entirely, because that is only 4.
//   1. a non-floor session sharing a tutor with any other student  -> always wrong
//   2. floor sessions                                              -> cap of 4
// Needs the Service column, added to report 763 on 2026-07-30.
const FLOOR_CAP = 4;
const OVERLOAD_BUCKET = 30;
const isFloor       = svc => /floor/i.test(svc || '');
const isNonTeaching = svc => /^(admin work|front desk coverage)$/i.test((svc || '').trim());
const hasServiceCol = colIdx.service != null;

const byStaffDay = {};
for (const s of aplusSessions) {
  if (!s.isActive || !s.staff || !s.startTime || !s.endTime) continue;
  if (!dateSet.has(s.date)) continue;
  if (isNonTeaching(s.service)) continue;         // Admin Work / Front Desk Coverage
  (byStaffDay[`${s.staff}|${s.date}`] = byStaffDay[`${s.staff}|${s.date}`] || []).push(s);
}
for (const [key, sess] of Object.entries(byStaffDay)) {
  const [staff, date] = key.split('|');
  const lo = Math.min(...sess.map(s => timeToMins(s.startTime)));
  const hi = Math.max(...sess.map(s => timeToMins(s.endTime)));
  const windows = [];
  let cur = null;
  for (let t = Math.floor(lo / OVERLOAD_BUCKET) * OVERLOAD_BUCKET; t < hi; t += OVERLOAD_BUCKET) {
    const here = sess.filter(s => timeToMins(s.startTime) < t + OVERLOAD_BUCKET && timeToMins(s.endTime) > t);
    const students = [...new Set(here.map(s => s.studentName))];
    if (students.length <= 1) { if (cur) { windows.push(cur); cur = null; } continue; }

    // Without a Service column every session looks the same, so fall back to the
    // old single threshold rather than silently mis-classifying everything as 1:1.
    const nonFloor = hasServiceCol ? here.filter(s => !isFloor(s.service)) : [];
    let kind = null;
    if (hasServiceCol && nonFloor.length) {
      kind = { type: '1:1 Double Booked',
               detail: `${[...new Set(nonFloor.map(s => s.studentName))].join(', ')} (${[...new Set(nonFloor.map(s => s.service))].join('/')}) shares this slot` };
    } else if (students.length > FLOOR_CAP) {
      kind = { type: 'Tutor Overloaded', detail: `${students.length} students at once (floor cap ${FLOOR_CAP})` };
    }
    if (!kind) { if (cur) { windows.push(cur); cur = null; } continue; }

    if (cur && cur.end === t && cur.type === kind.type) {
      cur.end = t + OVERLOAD_BUCKET; students.forEach(x => cur.students.add(x));
    } else {
      if (cur) windows.push(cur);
      cur = { start: t, end: t + OVERLOAD_BUCKET, students: new Set(students), type: kind.type, detail: kind.detail };
    }
  }
  if (cur) windows.push(cur);
  for (const w of windows) {
    discrepancies.push({
      type: w.type,
      student: staff,                       // the row's subject is the TUTOR here
      date,
      lcos_detail: w.detail,
      aplus_detail: `${minsToTime(w.start)}-${minsToTime(w.end)}: ${[...w.students].join(', ')}`,
      lcos_mins: 0, aplus_mins: 0
    });
  }
}

const typePriority = {
  'Missing in A+': 1, 'Missing in LCOS': 2,
  'Not Cancelled in A+': 3, 'Not Cancelled in LCOS': 4,
  'Schedule Mismatch': 5, 'Double Booked': 6, 'Session/Retest Overlap': 7, 'Tutor Overloaded': 8, '1:1 Double Booked': 9
};
discrepancies.sort((a,b) =>
  a.date.localeCompare(b.date) ||
  (typePriority[a.type] - typePriority[b.type]) ||
  a.student.localeCompare(b.student)
);

// Stats.
// The A+ side is now a fixed-window shared cache (~6 months), not a pull for this
// range, so counting every block would report "A+: 8969" against "LCOS: 298" and
// push 6 months of rows into the A+ Schedule tab. Everything reported is scoped
// to the reconcile window, which is what these numbers always meant.
const aplusInWindow = aplusBlocks.filter(b => dateSet.has(b.date));
const stats = {
  lcosTotal: lcosBlocks.length,
  lcosActive: lcosBlocks.filter(b => b.hasActive).length,
  lcosCancelled: lcosBlocks.filter(b => !b.hasActive).length,
  aplusTotal: aplusInWindow.length,
  aplusActive: aplusInWindow.filter(b => b.hasActive).length,
  aplusCancelled: aplusInWindow.filter(b => !b.hasActive).length,
  matched,
  discrepancies: discrepancies.length
};

// Per-day stats
const dates = eachDate(startDate, endDate);
const perDay = dates.map(date => {
  const lcos = lcosBlocks.filter(b => b.date === date).length;
  const aplus = aplusBlocks.filter(b => b.date === date).length;
  const m = discrepancies.filter(d => d.date === date).length;
  const matchedDay = [...allKeys].filter(k => {
    const l = lcosMap[k], ap = aplusMap[k];
    if (!l || !ap || l.date !== date) return false;
    if (!l.hasActive || !ap.hasActive) return false;
    const dStart = Math.abs(timeToMins(l.startTime) - timeToMins(ap.startTime));
    const dEnd = Math.abs(timeToMins(l.endTime) - timeToMins(ap.endTime));
    return dStart <= tol && dEnd <= tol;
  }).length;
  return { date, lcos, aplus, matched: matchedDay, discrepancies: m };
});

const typeCounts = {};
for (const d of discrepancies) typeCounts[d.type] = (typeCounts[d.type] || 0) + 1;

const result = {
  startDate, endDate, dates,
  stats, perDay, typeCounts,
  discrepancies,
  lcosSessions, aplusSessions: aplusAllSessions.filter(s => dateSet.has(s.date))
};

fs.writeFileSync(outPath, JSON.stringify(result, null, 2));
console.log(`Reconciled: ${stats.lcosTotal} LCOS blocks, ${stats.aplusTotal} A+ blocks`);
console.log(`Matched: ${matched}, Discrepancies: ${discrepancies.length}`);
console.log('By type:', typeCounts);
console.log(`Wrote: ${outPath}`);
