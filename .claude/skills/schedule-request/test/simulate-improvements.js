/**
 * simulate-improvements.js — would the new rules have fixed the recommendations
 * we already know were wrong?
 *
 * We have a measured baseline: backfill-outcomes.js graded all 38 historical
 * recommendations against what staff actually did afterwards. This replays those
 * same recommendations through the three filters we have since built, and reports
 * what changes.
 *
 *   1. DEPARTED   the tutor is no longer on the A+ roster
 *   2. CATEGORY   the tutor does not teach this student's category (LC / ST / EP)
 *   3. A+ RULE    an A+ Student Note excludes this tutor for this student
 *
 * HONEST FRAMING: a filter cannot prove the bot would then pick the RIGHT tutor.
 * It can only show that a demonstrably wrong pick would have been stopped. A
 * stopped recommendation becomes either a better pick or a BLOCKED that asks a
 * human, and both beat being confidently wrong. So the metric is "wrong answers
 * prevented", not "right answers produced".
 *
 * READ-ONLY.
 */
const fs = require('fs');
const path = require('path');
const { parseStudentNote } = require('../lib/parse-student-note');

const SR = path.join(__dirname, '..');
const PIPE = path.join(SR, '..', 'scheduling-pipeline');
const load = (p, what) => {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); }
  catch { console.error(`missing ${what}: ${p}`); process.exit(1); }
};

const backfill = load(path.join(PIPE, 'backfill-report.json'), 'backfill report');
const cats     = load(path.join(SR, 'seed-teacher-categories.json'), 'teacher categories');
const notes    = load(path.join(SR, 'student-notes.json'), 'A+ student notes');
const seedStu  = load(path.join(SR, 'seed-student-tutors.json'), 'student seeds');

const norm = s => (s || '').toLowerCase().replace(/\s+/g, ' ').trim();
const toks = s => new Set(((s || '').toLowerCase().match(/[a-z]+/g)) || []);
function sameTutor(a, b) {
  const A = toks(a), B = toks(b);
  if (!A.size || !B.size) return false;
  const [s, l] = A.size <= B.size ? [A, B] : [B, A];
  for (const t of s) if (!l.has(t)) return false;
  return true;
}

// current A+ roster = employment status (proved reliable; LCOS `active` is not)
const roster = notes.teachers.map(t => t.teacher);
const onRoster = name => roster.some(r => sameTutor(r, name));

// teacher -> categories. A+ Teacher Type first, statistical derivation as fallback.
const TYPE_TO_CAT = { 'LC': 'LC', 'EP/ST Math & Science': 'EP', 'EP/ST Verbal': 'EP' };
const apType = new Map(notes.teachers.map(t => [norm(t.teacher), t.type]));
function categoriesFor(name) {
  for (const [k, v] of apType) if (sameTutor(k, name) && TYPE_TO_CAT[v]) return { cats: [TYPE_TO_CAT[v]], src: 'A+ Teacher Type' };
  for (const t of cats.teachers) if (sameTutor(t.teacher, name) && t.teaches?.length) return { cats: t.teaches, src: 'derived' };
  return { cats: null, src: 'unknown' };
}
const studentCat = new Map(seedStu.students.map(s => [norm(s.student), s.category]));
const noteFor = name => (notes.students.find(s => sameTutor(s.student, name)) || {}).note || '';

// ---- replay ----
const results = [];
for (const r of backfill.results) {
  if (!r.recommendedTutor || !r.student) continue;
  const flags = [];

  if (!onRoster(r.recommendedTutor)) flags.push({ rule: 'DEPARTED', detail: 'not on the current A+ roster' });

  const sc = studentCat.get(norm(r.student));
  const { cats: tc, src } = categoriesFor(r.recommendedTutor);
  if (sc && tc && !tc.includes(sc)) {
    flags.push({ rule: 'CATEGORY', detail: `${r.student} is ${sc}; ${r.recommendedTutor} teaches ${tc.join('+')} (${src})` });
  }

  const note = noteFor(r.student);
  if (note) {
    for (const n of parseStudentNote(note).never) {
      if (toks(r.recommendedTutor).has(n.name.toLowerCase())) {
        flags.push({ rule: 'A+ RULE', detail: `note says "No ${n.name}${n.scope ? ' for ' + n.scope : ''}"${n.scope ? ' (scope not checked here)' : ''}` });
      }
    }
  }
  if (flags.length) results.push({ ...r, flags });
}

// ---- report ----
const WRONG = new Set(['wrong-category', 'wrong-tutor', 'bot-blocked-staff-acted']);
const base = backfill.results;
const tally = base.reduce((a, r) => { a[r.verdict] = (a[r.verdict] || 0) + 1; return a; }, {});

console.log('=== BASELINE (measured against what staff actually did) ===');
Object.entries(tally).sort((a, b) => b[1] - a[1]).forEach(([k, v]) => console.log(`  ${String(v).padStart(3)}  ${k}`));
const knownWrong = base.filter(r => WRONG.has(r.verdict));
console.log(`\n  demonstrably wrong recommendations: ${knownWrong.length}`);

console.log(`\n=== WOULD NOW BE STOPPED: ${results.length} of ${base.length} ===`);
for (const r of results) {
  const hit = WRONG.has(r.verdict) ? 'FIXES A KNOWN-BAD' : (r.verdict === 'different-but-allowed' ? 'would also stop an ACCEPTABLE pick' : `verdict was: ${r.verdict}`);
  console.log(`\n  ${r.student}  ->  bot said ${r.recommendedTutor}   [${hit}]`);
  r.flags.forEach(f => console.log(`      ${f.rule}: ${f.detail}`));
  if (r.actualTutors?.length) console.log(`      staff actually used: ${r.actualTutors.join(', ')}`);
}

const fixed = results.filter(r => WRONG.has(r.verdict));
const collateral = results.filter(r => ['match', 'match-cancelled', 'same-tutor-different-time', 'different-but-allowed'].includes(r.verdict));
console.log('\n=== SCORE ===');
console.log(`  known-bad recommendations caught: ${fixed.length} / ${knownWrong.length}`);
console.log(`  acceptable recommendations that would ALSO have been stopped: ${collateral.length}`);
if (collateral.length) console.log('    (these are the cost: a filter that fires on a pick staff were fine with)');
const missed = knownWrong.filter(r => !results.some(x => x.hash === r.hash));
console.log(`  known-bad NOT caught: ${missed.length}`);
missed.forEach(r => console.log(`    ${r.student || r.contactName}: ${r.verdict}${r.recommendedTutor ? ' (' + r.recommendedTutor + ')' : ''}`));
