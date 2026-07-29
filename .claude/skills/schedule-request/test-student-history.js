/**
 * test-student-history.js — fast, offline regression guard for the
 * student-history anchor (lib/student-history.js + lib/non-tutors.js).
 *
 * No network: feeds synthetic Schedule-Report rows through the summarizer and
 * candidate ranker and asserts the behaviors that motivated the re-anchor
 * (Mariah's feedback): real tutor pool, admin-placeholder exclusion, cancelled
 * sessions ignored, slot-aware ranking, modal-duration inference, and no
 * cross-student bleed.
 *
 * Usage: node test-student-history.js   (exit 0 = all pass)
 */
const assert = require('assert');
const { summarizeStudentHistory, buildHistoryCandidates } = require('./lib/student-history');
const { isNonTutor } = require('./lib/non-tutors');
const { findQualifiedTutors } = require('./lib/discover-tutors');
const { effectiveSubject } = require('./lib/orchestrate');

const NOW = new Date('2026-06-26T12:00:00');   // fixed "today" for reproducibility

const rows = [
  // Sathvik — Learning Center student, multiple real tutors.
  row('Sathvik Movva', 'Key Ashley',      '6/13/2026', '10:30am', '1 hour', 'ATD'),
  row('Sathvik Movva', 'Key Ashley',      '6/27/2026', '10:30am', '1 hour', 'Scheduled'),  // upcoming
  row('Sathvik Movva', 'Key Ashley',      '6/16/2026', '6:30pm',  '1 hour', 'ATD'),
  row('Sathvik Movva', 'Lanham Sierra',   '6/16/2026', '6:30pm',  '1 hour', 'ATD'),
  row('Sathvik Movva', 'Lanham Sierra',   '6/9/2026',  '6:30pm',  '1 hour', 'Cancelled'),  // ignored
  row('Sathvik Movva', 'Erickson Lucas',  '3/21/2026', '6:30pm',  '1 hour', 'ATD'),        // stale
  row('Sathvik Movva', 'Head Teacher',    '6/1/2026',  '9:00am',  '1 hour', 'ATD'),        // admin placeholder
  row('Sathvik Movva', 'McRetest Retest', '6/2/2026',  '9:00am',  '5 hours','ATD'),        // proctoring placeholder
  // A different student / different tutor — must never leak into Sathvik's pool.
  row('Other Kid',     'Smith Elizabeth', '6/1/2026',  '3:00pm',  '1 hour', 'ATD'),
];

function row(student, teacher, date, time, dur, status) {
  return {
    'Student Name': student, 'Teacher': teacher, 'Session Date': date,
    'Start Time': time, 'Duration': dur, 'Session Status': status,
  };
}

let failures = 0;
function check(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); }
  catch (e) { failures++; console.log(`  ✗ ${name}\n      ${e.message}`); }
}

const sum = summarizeStudentHistory(rows, 'Sathvik Movva', NOW);

check('finds the student', () => assert.equal(sum.found, true));

check('excludes "Head Teacher" admin placeholder', () =>
  assert.ok(!sum.tutors.some(t => /head teacher/i.test(t.tutor)), 'Head Teacher leaked into pool'));

check('does not bleed another student\'s tutor (Elizabeth)', () =>
  assert.ok(!sum.tutors.some(t => /elizabeth/i.test(t.tutor)), 'Elizabeth leaked into pool'));

check('counts active sessions, ignores cancelled', () => {
  const sierra = sum.tutors.find(t => t.tutor === 'Lanham Sierra');
  assert.equal(sierra.activeSessions, 1, 'cancelled session counted as active');
  assert.equal(sierra.cancelled, 1);
});

check('primary tutor is the most-frequent (Ashley)', () =>
  assert.equal(sum.primaryTutor, 'Key Ashley'));

check('infers modal duration', () => assert.equal(sum.modalDuration, '1 hour'));

check('slot-match tutors rank above off-slot tutors (Tue 6:30pm)', () => {
  const ranked = buildHistoryCandidates(sum, { dayName: 'Tuesday', time: '6:30pm' });
  const top = ranked[0];
  assert.ok(top.slotMatch, `top candidate ${top.tutor} should slot-match Tue 6:30pm`);
  // Ashley & Sierra both cover Tue 6:30pm; Lucas (stale, off-slot here) ranks last.
  const lucasIdx = ranked.findIndex(t => t.tutor === 'Erickson Lucas');
  const ashleyIdx = ranked.findIndex(t => t.tutor === 'Key Ashley');
  assert.ok(ashleyIdx < lucasIdx, 'slot+recent tutor should outrank stale off-slot tutor');
});

check('non-tutor helper matches placeholder forms', () => {
  assert.equal(isNonTutor('Head Teacher'), true);
  assert.equal(isNonTutor('Head Teacher (admin hours)'), true);
  assert.equal(isNonTutor('Key Ashley'), false);
});

// ── regression: the proctoring placeholder must never be recommendable ──
// A+ carries "McRetest Retest" as a staff row with real service quals, and it
// has 253 sessions in the history report. On 2026-07-03 it was recommended as a
// tutor for a practice SSAT.
check('excludes "McRetest Retest" proctoring placeholder', () => {
  assert.equal(isNonTutor('McRetest Retest'), true);
  assert.equal(isNonTutor('McRetest, Retest (RETEST)'), true);
  assert.ok(!sum.tutors.some(t => /retest/i.test(t.tutor)), 'RETEST leaked into history pool');
});

check('subject discovery filters non-tutors (the actual 7/03 leak path)', () => {
  const idx = { extractedAt: null, teachers: [
    { lastFirst: 'McRetest Retest', eid: '1', services: [{ name: 'Practice SSAT', offered: true }] },
    { lastFirst: 'Head Teacher',    eid: '2', services: [{ name: 'Practice SSAT', offered: true }] },
    { lastFirst: 'Wiley Tyler',     eid: '3', services: [{ name: 'Practice SSAT', offered: true }] },
  ] };
  const hits = findQualifiedTutors(['Practice SSAT'], idx, { max: 8 });
  assert.deepEqual(hits.map(h => h.tutor), ['Wiley Tyler'],
    'discovery returned a placeholder: ' + hits.map(h => h.tutor).join(', '));
});

// ── regression: subject handling (C4) ──
const RR = { service: 'L1' };
check('continuation requests inherit the service, no fallback warning', () => {
  for (const t of ['makeup', 'reschedule', 'cancel']) {
    const r = effectiveSubject({ requestType: t, subject: "make up today's missed session next Friday" }, RR);
    assert.equal(r.inherited, true, t + ' should inherit');
    assert.equal(r.fellBack, false, t + ' should not be flagged as a failed parse');
    assert.equal(r.subject, 'Learning Center');
  }
});

check('new-session with an unparseable subject still flags fallback', () => {
  const r = effectiveSubject({ requestType: 'new-session', subject: '1 to 1.5 hour tutoring sessions' }, RR);
  assert.equal(r.fellBack, true, 'new-session must still warn — the subject genuinely matters');
  assert.equal(r.inherited, false);
});

check('a real subject is kept regardless of request type', () => {
  const r = effectiveSubject({ requestType: 'reschedule', subject: 'AP Stats' }, RR);
  assert.equal(r.subject, 'AP Stats');
  assert.equal(r.inherited, false);
  assert.equal(r.fellBack, false);
});

console.log(failures ? `\n${failures} FAILED` : '\nAll passed');
process.exit(failures ? 1 : 0);
