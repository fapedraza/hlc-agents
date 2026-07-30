/**
 * build-review-csv.js — turn the seed JSON into two review sheets for Mariah.
 *
 * Design goal: she should be able to skim it and only touch the rows that are
 * wrong. So every row carries the evidence that produced the proposal, sorted so
 * the shakiest rows are near the top, and the only column she has to fill in is
 * the correction.
 */
const fs = require('fs');
const path = require('path');

const DIR = process.argv[2] || '.';
// A+ Student Notes are the real store: staff have recorded tutor exclusions there
// for years. The sheet's job is to CONFIRM and COMPLETE what A+ already has, not
// to become a competing list.
let apNotes = new Map(), parseNote = null, wantsNotice = () => false;
try {
  ({ parseStudentNote: parseNote, wantsTutorChangeNotice: wantsNotice } = require('./lib/parse-student-note'));
  for (const s of JSON.parse(fs.readFileSync(path.join(DIR, 'student-notes.json'), 'utf8')).students) {
    if (s.note) apNotes.set(s.student.toLowerCase().trim(), s.note);
  }
  console.log(`loaded ${apNotes.size} existing A+ Student Notes`);
} catch (e) { console.log('(no student-notes.json - run fetch-student-notes.js first)'); }
const noteFor = name => apNotes.get((name || '').toLowerCase().trim()) || '';
const teachers = JSON.parse(fs.readFileSync(path.join(DIR, 'seed-teacher-categories.json'), 'utf8'));
const students = JSON.parse(fs.readFileSync(path.join(DIR, 'seed-student-tutors.json'), 'utf8'));

const CAT = { LC: 'Learning Center', ST: 'Subject Tutoring', EP: 'Exam Prep' };

// A+ reports names as "Last First". Two tokens are safe to swap for readability;
// three or more (e.g. "Topete Salmoran Alma", "de Luna Aurora") are ambiguous, so
// leave them exactly as staff see them in A+.
function display(lastFirst) {
  const p = (lastFirst || '').trim().split(/\s+/);
  return p.length === 2 ? `${p[1]} ${p[0]}` : lastFirst;
}
const pct = v => v == null ? '' : Math.round(v * 100) + '%';
const esc = v => {
  const s = v == null ? '' : String(v);
  return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
};
const toCsv = (headers, rows) =>
  [headers.map(esc).join(','), ...rows.map(r => r.map(esc).join(','))].join('\n');

// ─── Sheet 1: teacher categories ─────────────────────────────────────────────
// Sorted so the judgment calls float to the top: anything with a mixed profile
// or thin evidence first, the unambiguous 100%-one-category people last.
const tRows = teachers.teachers.map(t => {
  const sh = t.categoryShares || {};
  const mixed = Object.keys(sh).length > 1;
  const topShare = Math.max(...Object.values(sh), 0);
  const incidentalLC = (t.incidental || []).find(i => i.cat === 'LC');
  const needsReview = mixed && topShare < 0.9;
  return {
    sort: (needsReview ? 0 : 1) * 1000 + (t.confidence === 'low' ? -500 : 0) + Math.round(topShare * 100),
    row: [
      display(t.teacher),
      t.totalSessions,
      t.distinctStudents,
      pct(sh.LC), pct(sh.ST), pct(sh.EP),
      (t.teaches || []).map(c => CAT[c] || c).join(' + ') || '(none)',
      t.teaches?.includes('LC') ? 'YES' : 'no',
      incidentalLC ? `${incidentalLC.sessions} LC session(s) — exception?` : '',
      t.confidence,
      t.lastSeen,
      '', '',
    ],
  };
}).sort((a, b) => a.sort - b.sort).map(x => x.row);

const tCsv = toCsv([
  'Teacher', 'Sessions', 'Students',
  'LC %', 'Subject %', 'Exam Prep %',
  'PROPOSED: teaches', 'PROPOSED: LC teacher?',
  'Flag', 'Confidence', 'Last session',
  '>> CORRECT LC teacher? (yes/no)', '>> Notes',
], tRows);

// ─── Sheet 2: student tutor rules ────────────────────────────────────────────
// Framing matters here. The previous version proposed `prefer` for every student
// and silently dropped anyone with >4 tutors, which hid the 88 most flexible
// students and pushed the reviewer toward encoding rigidity. Now:
//   - everyone with enough history appears
//   - `any` is proposed where flexibility is EVIDENCED (several real tutors)
//   - `prefer` means CONTINUITY and is flagged with the question only a human can
//     answer: is this a requirement, or just who happened to be free?
//   - `only` and `exclude` are never proposed; there are blank columns for them,
//     and `exclude` in particular has no data substitute at all.
// Rules Mariah has ALREADY stated in Slack. Pre-filled so (a) the knowledge is
// not lost again and (b) the sheet shows what a filled-in row looks like.
// Atlas is also the clearest proof that the heuristic cannot be trusted on its
// own: he has worked with 3 tutors, so the data calls him "flexible", but she
// said he can work with ONLY those three.
const KNOWN = {
  'Atlas Germer':  { rule: 'only', tutors: 'Makenzie Binsacca, Lucas Erickson, Ashley Key',
                     note: 'from Mariah, Slack 2026-06-30: "Atlas can really only work with Makenzie, Lucas, or Ashley"' },
  'Sathvik Movva': { rule: 'only', tutors: 'Lucas Erickson, Makenzie Binsacca, Ashley Key, Sierra Lanham',
                     note: 'from Mariah, 2026-06-10: higher-needs LC student, "requires a tutor like Lucas, Makenzie, Ashley, or Sierra"' },
};

const RANK = { narrow: 0, mixed: 1, flexible: 2 };
const fmtRules = a => (a || []).map(x => x.name + (x.scope ? ` (${x.scope} only)` : '')).join(', ');

const withRule = students.students.filter(s => s.proposed);
const sRows = withRule
  .map(s => {
    const note = noteFor(s.student);
    const p = note && parseNote ? parseNote(note) : null;
    const hasApRule = !!(p && (p.never.length || p.prefer.length || p.okay.length));
    return { s, note, p, hasApRule };
  })
  // Rows where A+ already says something come first: those are confirmations, and
  // they are the ones we most need to know are still true.
  .sort((a, b) => (b.hasApRule ? 1 : 0) - (a.hasApRule ? 1 : 0)
    || (KNOWN[b.s.student] ? 1 : 0) - (KNOWN[a.s.student] ? 1 : 0)
    || (RANK[a.s.flexibility] - RANK[b.s.flexibility])
    || b.s.totalSessions - a.s.totalSessions)
  .map(({ s, note, p, hasApRule }) => [
    s.student,
    s.service,
    s.totalSessions,
    s.distinctTutors,
    s.tutors.map(t => `${display(t.tutor)} (${t.sessions})`).join(', '),
    s.flexibility === 'flexible' ? 'works with many tutors'
      : s.flexibility === 'mixed' ? 'works with a few tutors' : 'one main tutor',
    // what A+ says today
    note.replace(/\s*\n\s*/g, ' / '),
    p ? fmtRules(p.never) : '',
    p ? fmtRules(p.prefer) : '',
    p && wantsNotice(note) ? 'YES' : '',
    p && p.oldestRuleDate ? p.oldestRuleDate : '',
    // her input
    KNOWN[s.student]?.rule === 'only' ? KNOWN[s.student].tutors : '',
    '', '',
    KNOWN[s.student]?.note || (hasApRule ? 'confirm the A+ note is still right' : ''),
  ]);

const sCsv = toCsv([
  'Student', 'Service', 'Sessions', '# Tutors', 'Tutors seen (sessions)', 'Pattern',
  'A+ Student Note today', 'A+ says NEVER', 'A+ says PREFER', 'Tell family of tutor change?', 'Oldest rule dated',
  '>> ONLY these tutors', '>> PREFER these tutors', '>> NEVER these tutors', '>> Notes',
], sRows);

fs.writeFileSync(path.join(DIR, 'review-teachers.csv'), tCsv);
fs.writeFileSync(path.join(DIR, 'review-students.csv'), sCsv);
console.log(`teachers: ${tRows.length} rows -> review-teachers.csv`);
console.log(`students: ${sRows.length} rows -> review-students.csv`);
console.log(`  ordered: decisions first (one main tutor), confirmations last (works with many)`);
