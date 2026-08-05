/**
 * lib/tutor-rules.js — the two things staff already maintain in A+, made usable
 * by the bot.
 *
 * Both existed as analysis long before this file: the teacher-category check
 * lived only in test/simulate-improvements.js (as "what a filter WOULD catch")
 * and in backfill-outcomes.js (to LABEL a miss after the fact). Neither ran
 * while a recommendation was being made. Mariah filled in all 38 Teacher Types
 * on 2026-08-04 specifically because it was described as the highest-value
 * thing she could do — this is what makes that true.
 *
 * TWO POOLS, NOT THREE. Mariah, 2026-08-04: "we try to prioritize LC teachers
 * for LC students, and EP/ST teachers for EP/ST students, even if they are able
 * to teach both." Validated against the roster: L1/LS students attend Learning
 * Center and Floor services, S1/A1/ST students attend Exam Prep and subject
 * services. So LC and EP/ST, and some teachers legitimately serve both.
 *
 * CATEGORY RANKS, IT DOES NOT EXCLUDE. Her word was "prioritize", and 29% of
 * recommendations already end in BLOCKED — a hard category filter would convert
 * "an imperfect tutor" into "no tutor", which is worse for staff. A `never`
 * rule is the opposite: that is an explicit instruction and hard-excludes from
 * every candidate source, including history.
 *
 * RELEVANCY. Mariah, 2026-08-04: "Student notes in A+, as far as I can tell,
 * cannot be edited or deleted... the notes may quickly become cluttered and even
 * outdated... the bot will need to assess relevancy." Measured 2026-08-04:
 * 16 of 24 parsed rules name someone no longer on the roster, 13 of them from a
 * single 2016 note. One of those is "prefer Hana" — a tutor who has left — so
 * honouring rules blindly would actively steer toward departed staff. Every rule
 * is therefore checked against the CURRENT A+ roster before it is applied.
 */
const fs = require('fs');
const path = require('path');
const { parseStudentNote } = require('./parse-student-note');

const NOTES_PATH = path.join(__dirname, '..', 'student-notes.json');

/** A+ Teacher Type -> tutor pool(s). Values as they actually appear in A+. */
const TYPE_TO_POOL = {
  'LC': ['LC'],
  'EP/ST Math & Science': ['EPST'],
  'EP/ST Verbal': ['EPST'],
  'EP/ST All': ['EPST'],
  'LC & EP/ST': ['LC', 'EPST'],
  // Directors and admin (Mariah, Laura, Shannon) plus the retest placeholder.
  // They appear in session data from covering, but are not auto-assignable.
  'Full Time Staff': [],
};

/** LCOS service code -> the pool that should serve that student. */
const SERVICE_TO_POOL = { L1: 'LC', LS: 'LC', S1: 'EPST', A1: 'EPST', ST: 'EPST' };

const toks = s => new Set(String(s || '').toLowerCase().match(/[a-z]+/g) || []);
/** Token-subset match: "Rollison, Elizabeth (Elizabeth)" vs "Rollison Elizabeth". */
function sameTutor(a, b) {
  const A = toks(a), B = toks(b);
  if (!A.size || !B.size) return false;
  const [small, large] = A.size <= B.size ? [A, B] : [B, A];
  for (const t of small) if (!large.has(t)) return false;
  return true;
}

let cache = null;
function load(notesPath = NOTES_PATH) {
  if (cache) return cache;
  let data = { students: [], teachers: [] };
  try { data = JSON.parse(fs.readFileSync(notesPath, 'utf8')); } catch { /* absent = no rules */ }
  const teachers = data.teachers || [];
  const roster = teachers.map(t => t.teacher).filter(Boolean);
  cache = { data, teachers, roster };
  return cache;
}
/** Test seam — lets a suite point at a fixture without leaking state between cases. */
function _reset() { cache = null; }

/** Is this name a tutor on the CURRENT A+ roster? The relevancy test for every rule. */
function onRoster(name, notesPath) {
  const { roster } = load(notesPath);
  const n = String(name || '').toLowerCase();
  if (!n) return false;
  // A rule names a first name ("No Leta"); the roster stores "Hamilton Leta".
  return roster.some(r => toks(r).has(n) || sameTutor(r, name));
}

/** Pools a teacher serves, from A+ Teacher Type. Empty = not auto-assignable. */
function poolsForTeacher(name, notesPath) {
  const { teachers } = load(notesPath);
  const t = teachers.find(x => sameTutor(x.teacher, name));
  if (!t || !t.type) return null;                       // unknown, not "wrong"
  return TYPE_TO_POOL[t.type.trim()] || null;
}

/** Pool a student belongs to, from their LCOS service code. */
function poolForStudent(rosterRow) {
  const svc = String(rosterRow?.service || '').trim().toUpperCase();
  return SERVICE_TO_POOL[svc] || null;
}

/**
 * Rules for a student, RELEVANCY-FILTERED to the current roster.
 * Returns { never, prefer, dropped } where dropped is what was ignored and why —
 * surfaced rather than silently discarded, because a rule vanishing without
 * explanation is how staff lose trust in the thing.
 */
function rulesForStudent(studentName, notesPath) {
  const { data } = load(notesPath);
  const rec = (data.students || []).find(s => sameTutor(s.student, studentName));
  const out = { never: [], prefer: [], dropped: [] };
  if (!rec || !rec.note) return out;
  const parsed = parseStudentNote(rec.note);
  for (const kind of ['never', 'prefer']) {
    for (const r of parsed[kind] || []) {
      if (onRoster(r.name, notesPath)) out[kind].push(r);
      else out.dropped.push({ kind, name: r.name, why: 'not on the current A+ roster' });
    }
  }
  return out;
}

/**
 * Should this tutor be hard-excluded for this student?
 * Honours scope: "No Leta for math" only bites on a math service, while a bare
 * "No Leta" applies to everything. Scoped rules produced 22 false positives
 * when scope was ignored.
 */
function excludedBy(studentName, tutorName, service, notesPath) {
  const { never } = rulesForStudent(studentName, notesPath);
  const svc = String(service || '').toLowerCase();
  for (const r of never) {
    if (!toks(tutorName).has(String(r.name).toLowerCase()) && !sameTutor(tutorName, r.name)) continue;
    if (r.scope && svc && !svc.includes(String(r.scope).toLowerCase())) continue; // scoped elsewhere
    return r;
  }
  return null;
}

/** Is this tutor explicitly preferred for this student? */
function preferredFor(studentName, tutorName, notesPath) {
  const { prefer } = rulesForStudent(studentName, notesPath);
  return prefer.some(r => toks(tutorName).has(String(r.name).toLowerCase()) || sameTutor(tutorName, r.name));
}

/**
 * Category fit: 1 same pool, 0 unknown either side, -1 wrong pool.
 * Callers RANK on this. Nothing here excludes on category alone.
 */
function categoryFit(tutorName, rosterRow, notesPath) {
  const want = poolForStudent(rosterRow);
  const has = poolsForTeacher(tutorName, notesPath);
  if (!want || !has || !has.length) return 0;
  return has.includes(want) ? 1 : -1;
}

module.exports = {
  load, _reset, onRoster, poolsForTeacher, poolForStudent,
  rulesForStudent, excludedBy, preferredFor, categoryFit,
  TYPE_TO_POOL, SERVICE_TO_POOL, sameTutor, NOTES_PATH,
};
