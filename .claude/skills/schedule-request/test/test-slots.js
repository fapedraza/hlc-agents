/**
 * test-slots.js — floor capacity in slot offering.
 *
 * The bot used to treat any booking as fully occupying a tutor, so for a floor
 * student it offered only genuinely empty windows — 6:30pm for a tutor whose day
 * ends at 6:30. Staff instead seat floor students together. Measured over six
 * months: Verbal Floor shares a tutor 58% of the time, Math Floor 31%, against
 * 2% for Learning Center 1:1 — and never more than 4 at once.
 */
const assert = require('assert');
const { computeOpenSlots, FLOOR_CAPACITY } = require('../lib/slots');
const hours = { off: false, start: '10:00', end: '18:00' };
let pass = 0; const fail = [];
const t = (n, f) => { try { f(); console.log('  ok   ' + n); pass++; }
  catch (e) { console.log('  FAIL ' + n + '\n       ' + e.message); fail.push(n); } };

t('a floor request may join an existing floor block', () => {
  const busy = [{ start: '10:00', end: '12:00', service: 'Verbal Floor' }];
  const s = computeOpenSlots({ dayHours: hours, busyIntervals: busy, durationMin: 60, forService: 'Math Floor' });
  assert.ok(s.some(x => x.start === '10:00'), 'should be able to sit alongside a floor session');
});

t('a 1:1 request may NOT join anything', () => {
  const busy = [{ start: '10:00', end: '12:00', service: 'Verbal Floor' }];
  const s = computeOpenSlots({ dayHours: hours, busyIntervals: busy, durationMin: 60, forService: 'Learning Center 1:1 A' });
  assert.ok(!s.some(x => x.start === '10:00'), '1:1 must have the tutor to itself');
});

t('a floor request is blocked by a NON-floor session', () => {
  // This is the Leta 8/6 case: 10:00 was Homework, so a floor student cannot sit there.
  const busy = [{ start: '10:00', end: '11:30', service: 'Homework' }];
  const s = computeOpenSlots({ dayHours: hours, busyIntervals: busy, durationMin: 60, forService: 'Math Floor' });
  assert.ok(!s.some(x => x.start === '10:00'), 'a non-floor session still blocks the slot');
});

t(`a floor block is full at ${FLOOR_CAPACITY}`, () => {
  const busy = Array.from({ length: FLOOR_CAPACITY }, () => ({ start: '10:00', end: '12:00', service: 'Verbal Floor' }));
  const s = computeOpenSlots({ dayHours: hours, busyIntervals: busy, durationMin: 60, forService: 'Verbal Floor' });
  assert.ok(!s.some(x => x.start === '10:00'), `must not exceed ${FLOOR_CAPACITY} students at once`);
});

t(`${FLOOR_CAPACITY - 1} floor students still leaves a seat`, () => {
  const busy = Array.from({ length: FLOOR_CAPACITY - 1 }, () => ({ start: '10:00', end: '12:00', service: 'Verbal Floor' }));
  const s = computeOpenSlots({ dayHours: hours, busyIntervals: busy, durationMin: 60, forService: 'Verbal Floor' });
  assert.ok(s.some(x => x.start === '10:00'), 'the last seat should still be offered');
});

t('omitting forService keeps the old blocking behaviour', () => {
  const busy = [{ start: '10:00', end: '12:00', service: 'Verbal Floor' }];
  const s = computeOpenSlots({ dayHours: hours, busyIntervals: busy, durationMin: 60 });
  assert.ok(!s.some(x => x.start === '10:00'), 'callers that pass no service must be unaffected');
});

console.log(`\n${pass} passed, ${fail.length} failed`);
if (fail.length) process.exit(1);
