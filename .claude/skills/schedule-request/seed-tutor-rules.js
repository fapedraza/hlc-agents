/**
 * seed-tutor-rules.js — derive tutor rules from what actually happened.
 *
 * Mariah's ask (Slack #scheduling 2026-06-30) was a way to tell the bot which
 * tutors a student can work with. Her own note on where that knowledge lives:
 * "usually we just know". So there is nothing to import — but there IS evidence:
 * every session that has already happened.
 *
 * This joins two sources we already have:
 *   LCOS roster        student -> service code (L1/LS/ST/S1/A1)
 *   A+ Schedule Report student -> teacher, per session
 *
 * and derives two things:
 *
 * 1. TEACHER CATEGORIES (feedback item C2). Mariah, 2026-07-16: "Gwen is L1, and
 *    Tarun, Ethan, and Elizabeth are not learning center teachers. (Tarun has ONE
 *    LC student, but that is a special circumstance)". We can compute exactly
 *    that: a teacher's category is the mix of services of the students they
 *    actually teach, and the "one special student" case shows up as a small
 *    share rather than a miscategorisation.
 *
 * 2. PER-STUDENT TUTOR SEEDS (feedback item B1). Who has really taught this
 *    student, how often, how recently.
 *
 * Everything emitted is a PROPOSAL for Mariah to correct, never an active rule.
 * Confidence is reported so she can skim the thin evidence first.
 *
 * Usage:
 *   node seed-tutor-rules.js [--out-dir .] [--min-sessions 3] [--days 150]
 */
const fs = require('fs');
const path = require('path');
const { isNonTutor } = require('./lib/non-tutors');

const SKILL_DIR = __dirname;
const ROSTER_PATH = path.join(SKILL_DIR, 'lcos-roster.json');
const HISTORY_CSV = path.join(SKILL_DIR, '.cache', 'history-report.csv');
const ALL_STUDENTS_PATH = path.join(SKILL_DIR, 'lcos-students-all.json');

// LCOS service code -> teaching category.
// L1/LS = Learning Center, ST = subject tutoring, S1/A1 = exam prep (SAT/ACT).
const SERVICE_CATEGORY = { L1: 'LC', LS: 'LC', ST: 'ST', S1: 'EP', A1: 'EP' };
const CATEGORY_LABEL = { LC: 'Learning Center', ST: 'Subject Tutoring', EP: 'Exam Prep' };

const CANCEL_STATUSES = new Set([
  'cancelled', 'canceled', 'no-show', 'no show', 'noshow', 'deleted', 'removed',
  'void', 'anm', 'anm - paid', 'anm - unpaid', 'absent no makeup', 'abs', 'vac',
]);

const argv = process.argv.slice(2);
const argVal = (flag, dflt) => {
  const i = argv.indexOf(flag);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt;
};
const OUT_DIR = argVal('--out-dir', SKILL_DIR);
const MIN_SESSIONS = parseInt(argVal('--min-sessions', '3'), 10);

// ─── tiny CSV reader (quoted fields, embedded commas) ─────────────────────────
function parseCsv(text) {
  const rows = [];
  const lines = text.split(/\r?\n/).filter(l => l.length);
  for (const line of lines) {
    const out = [];
    let cur = '', inQ = false;
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (inQ) {
        if (c === '"' && line[i + 1] === '"') { cur += '"'; i++; }
        else if (c === '"') inQ = false;
        else cur += c;
      } else if (c === '"') inQ = true;
      else if (c === ',') { out.push(cur); cur = ''; }
      else cur += c;
    }
    out.push(cur);
    rows.push(out);
  }
  if (!rows.length) return [];
  const headers = rows[0].map(h => h.trim());
  return rows.slice(1).map(r => {
    const o = {};
    headers.forEach((h, i) => { o[h] = (r[i] || '').trim(); });
    return o;
  });
}

const norm = s => (s || '').toLowerCase().replace(/\s+/g, ' ').trim();
function parseMDY(s) {
  const m = (s || '').trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  return m ? new Date(+m[3], +m[1] - 1, +m[2], 12, 0, 0) : null;
}

// ─── load ─────────────────────────────────────────────────────────────────────
if (!fs.existsSync(ROSTER_PATH)) { console.error(`Missing roster: ${ROSTER_PATH}`); process.exit(1); }
if (!fs.existsSync(HISTORY_CSV)) { console.error(`Missing history cache: ${HISTORY_CSV}\nRun prewarm-history.js first.`); process.exit(1); }

const roster = JSON.parse(fs.readFileSync(ROSTER_PATH, 'utf8'));
const rows = parseCsv(fs.readFileSync(HISTORY_CSV, 'utf8'));
const rosterAge = Math.round((Date.now() - fs.statSync(ROSTER_PATH).mtimeMs) / 86400000);
const historyAge = Math.round((Date.now() - fs.statSync(HISTORY_CSV).mtimeMs) / 86400000);

// Two populations, deliberately:
//
//   byActive  — currently enrolled. Student tutor-preference rules only make
//               sense for students who are still here.
//   byAny     — everyone enrolled during the history window, including those who
//               have since finished. Teacher categorisation MUST use this: the
//               active roster alone drops the students whose sessions we are
//               counting, which skews a teacher's subject mix. Using the active
//               roster flipped Tarun to "LC teacher" on 2026-07-29, directly
//               contradicting Mariah's "Tarun is not a learning center teacher".
const byActive = new Map();
for (const r of roster) byActive.set(norm(`${r.firstname} ${r.lastname}`), r);

const byAny = new Map();
if (fs.existsSync(ALL_STUDENTS_PATH)) {
  const all = JSON.parse(fs.readFileSync(ALL_STUDENTS_PATH, 'utf8'));
  // A student can hold several enrollments; keep the most recent by startdate.
  for (const r of all) {
    const k = norm(`${r.firstname} ${r.lastname}`);
    const prev = byAny.get(k);
    const t = Date.parse(r.startdate || '') || 0;
    if (!prev || t >= (prev.__t || 0)) byAny.set(k, Object.assign({}, r, { __t: t }));
  }
} else {
  console.error(`WARNING: ${ALL_STUDENTS_PATH} missing — falling back to the active roster.\n` +
                `Teacher categories will be biased. Regenerate with:\n` +
                `  refresh-roster.ps1 -All -Force -OutFile lcos-students-all.json`);
  for (const [k, v] of byActive) byAny.set(k, v);
}

// ─── aggregate ────────────────────────────────────────────────────────────────
const teachers = new Map();   // teacher -> { sessions, students:Map(student->n), byCat:{}, lastSeen }
const students = new Map();   // student -> { tutors:Map(tutor->{n,last}) }
let matched = 0, unmatchedRows = 0;
const unmatchedStudents = new Set();

for (const row of rows) {
  const status = norm(row['Session Status']);
  if (CANCEL_STATUSES.has(status)) continue;          // cancelled sessions prove nothing
  const teacher = (row['Teacher'] || '').trim();
  const student = (row['Student Name'] || '').trim();
  if (!teacher || !student) continue;
  // "McRetest Retest" is a proctoring placeholder with 143 sessions and real A+
  // service quals — it looks exactly like a busy tutor to any naive aggregation.
  if (isNonTutor(teacher)) continue;

  const anyRow = byAny.get(norm(student));
  if (!anyRow) { unmatchedRows++; unmatchedStudents.add(student); continue; }
  matched++;

  const svc = (anyRow.service || '').toUpperCase();
  const cat = SERVICE_CATEGORY[svc] || 'other';
  const d = parseMDY(row['Session Date']);

  if (!teachers.has(teacher)) {
    teachers.set(teacher, { teacher, sessions: 0, students: new Map(), byCat: {}, lastSeen: null });
  }
  const t = teachers.get(teacher);
  t.sessions++;
  t.byCat[cat] = (t.byCat[cat] || 0) + 1;
  t.students.set(student, (t.students.get(student) || 0) + 1);
  if (d && (!t.lastSeen || d > t.lastSeen)) t.lastSeen = d;

  // Student seeds are only meaningful for students still enrolled.
  const activeRow = byActive.get(norm(student));
  if (!activeRow) continue;
  if (!students.has(student)) students.set(student, { student, roster: activeRow, tutors: new Map(), total: 0 });
  const s = students.get(student);
  s.total++;
  if (!s.tutors.has(teacher)) s.tutors.set(teacher, { tutor: teacher, n: 0, last: null });
  const tu = s.tutors.get(teacher);
  tu.n++;
  if (d && (!tu.last || d > tu.last)) tu.last = d;
}

// ─── derive teacher categories ────────────────────────────────────────────────
const fmtDate = d => d ? `${d.getMonth() + 1}/${d.getDate()}/${d.getFullYear()}` : null;

const teacherProfiles = [...teachers.values()].map(t => {
  const cats = ['LC', 'ST', 'EP'].map(c => ({ cat: c, n: t.byCat[c] || 0 }))
    .filter(c => c.n > 0)
    .sort((a, b) => b.n - a.n);
  const total = cats.reduce((a, c) => a + c.n, 0) || 1;
  const primary = cats[0] ? cats[0].cat : null;
  const shares = {};
  for (const c of cats) shares[c.cat] = +(c.n / total).toFixed(3);

  // "Teaches this category at all" vs "this is what they do". A tutor with a
  // single LC student out of 200 sessions is Mariah's Tarun case: allowed as an
  // exception, not an LC teacher.
  const teaches = cats.filter(c => c.n / total >= 0.15).map(c => c.cat);
  const incidental = cats.filter(c => c.n / total < 0.15).map(c => ({
    cat: c.cat, sessions: c.n, students: null,
  }));

  return {
    teacher: t.teacher,
    totalSessions: t.sessions,
    distinctStudents: t.students.size,
    lastSeen: fmtDate(t.lastSeen),
    primaryCategory: primary,
    categoryShares: shares,
    teaches,                       // proposed categories
    incidental,                    // small-share categories = likely exceptions
    confidence: t.sessions >= 40 ? 'high' : t.sessions >= 10 ? 'medium' : 'low',
  };
}).sort((a, b) => b.totalSessions - a.totalSessions);

// ─── derive per-student tutor seeds ───────────────────────────────────────────
const studentSeeds = [...students.values()].map(s => {
  const tutors = [...s.tutors.values()]
    .sort((a, b) => b.n - a.n)
    .map(t => ({
      tutor: t.tutor,
      sessions: t.n,
      share: +(t.n / s.total).toFixed(3),
      lastSeen: fmtDate(t.last),
    }));
  const svc = (s.roster.service || '').toUpperCase();
  return {
    student: s.student,
    clientid: s.roster.clientid,
    service: svc,
    category: SERVICE_CATEGORY[svc] || 'other',
    totalSessions: s.total,
    distinctTutors: tutors.length,
    tutors,
    // Proposed rule: students with a small, stable tutor set are the ones worth
    // seeding as `prefer`. A student who has seen 8 tutors has no meaningful
    // preference to encode.
    proposed: tutors.length > 0 && tutors.length <= 4 && s.total >= MIN_SESSIONS
      ? { rule_type: 'prefer', tutors: tutors.filter(t => t.sessions >= 2).map(t => t.tutor) }
      : null,
    confidence: s.total >= 20 ? 'high' : s.total >= MIN_SESSIONS ? 'medium' : 'low',
  };
}).sort((a, b) => b.totalSessions - a.totalSessions);

// ─── write + report ───────────────────────────────────────────────────────────
const meta = {
  generatedFrom: { rosterPath: ROSTER_PATH, rosterAgeDays: rosterAge, rosterStudents: roster.length,
                   historyPath: HISTORY_CSV, historyAgeDays: historyAge, historyRows: rows.length },
  matchedSessions: matched, unmatchedSessions: unmatchedRows,
  note: 'PROPOSALS ONLY — nothing here is an active rule. For Mariah to correct.',
};
fs.writeFileSync(path.join(OUT_DIR, 'seed-teacher-categories.json'),
  JSON.stringify({ meta, teachers: teacherProfiles }, null, 2));
fs.writeFileSync(path.join(OUT_DIR, 'seed-student-tutors.json'),
  JSON.stringify({ meta, students: studentSeeds }, null, 2));

console.log('=== SOURCES ===');
console.log(`active roster:      ${roster.length} students (${rosterAge}d old)  -> student rules`);
console.log(`historical enrolled: ${byAny.size} students                -> teacher categories`);
console.log(`history: ${rows.length} rows (${historyAge}d old) — ${matched} matched to roster, ${unmatchedRows} unmatched`);
if (unmatchedStudents.size) {
  console.log(`unmatched students: ${unmatchedStudents.size} (former students, or enrolled after the roster snapshot)`);
}

console.log('\n=== TEACHER CATEGORIES (derived) ===');
console.log('teacher                        sess  stu  primary  shares                      conf');
for (const t of teacherProfiles) {
  const sh = Object.entries(t.categoryShares).map(([c, v]) => `${c} ${Math.round(v * 100)}%`).join('  ');
  console.log(
    `${t.teacher.padEnd(30)} ${String(t.totalSessions).padStart(4)} ${String(t.distinctStudents).padStart(4)}  ` +
    `${(t.primaryCategory || '?').padEnd(7)}  ${sh.padEnd(26)} ${t.confidence}`
  );
}

console.log('\n=== LC TEACHERS (proposed) ===');
console.log(teacherProfiles.filter(t => t.teaches.includes('LC')).map(t => t.teacher).join(', ') || '(none)');
console.log('\n=== NOT LC teachers, but have incidental LC sessions (Mariah\'s "special circumstance" case) ===');
for (const t of teacherProfiles.filter(t => !t.teaches.includes('LC') && t.incidental.some(i => i.cat === 'LC'))) {
  const inc = t.incidental.find(i => i.cat === 'LC');
  console.log(`  ${t.teacher} — ${inc.sessions} LC session(s) of ${t.totalSessions} (${Math.round(inc.sessions / t.totalSessions * 100)}%)`);
}

const seeded = studentSeeds.filter(s => s.proposed);
console.log(`\n=== STUDENT TUTOR SEEDS ===`);
console.log(`${studentSeeds.length} students with history; ${seeded.length} have a proposable 'prefer' rule (<=4 tutors, >=${MIN_SESSIONS} sessions)`);
console.log(`by confidence: high ${seeded.filter(s => s.confidence === 'high').length}, medium ${seeded.filter(s => s.confidence === 'medium').length}`);
console.log(`\nwrote seed-teacher-categories.json and seed-student-tutors.json to ${OUT_DIR}`);
