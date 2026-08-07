/**
 * test-resolve.js — student resolution: sibling narrowing + the confidence floor.
 *
 * Runs against a FROZEN fixture roster, not the live one. The first version used
 * lcos-roster.json and broke the day Matthew Mar Chong enrolled: the "collision
 * returns no match" case was true only while he wasn't a student. Live data
 * makes good test subjects and terrible test fixtures.
 *
 * The floor exists because weak matches were WORSE than no match: "Matthew Mar
 * Chong" resolved to Ben Mark at 0.167 (three-way tie) and the reply draft asked
 * the parent "Which works best for Ben?"; "Ishaan Boinepally" resolved to Ishaan
 * Vij at 0.500 — right first name, wrong family. Measured: every verified-correct
 * match scores >= 0.75, every verified-wrong one <= 0.50.
 */
const assert = require('assert');
const { resolveStudent } = require('../resolve-student');

// Frozen slice of the real roster shape — enough to reproduce every case.
const ROSTER = [
  { clientid: 'F001', firstname: 'Nolan',     lastname: 'Lan',        statuscode: 'ENR', service: 'LS' },
  { clientid: 'F002', firstname: 'Morgan',    lastname: 'Lan',        statuscode: 'ENR', service: 'LS' },
  { clientid: 'F003', firstname: 'Gwendolen', lastname: 'Stanfield',  statuscode: 'ENR', service: 'L1' },
  { clientid: 'F004', firstname: 'Ben',       lastname: 'Mark',       statuscode: 'ENR', service: 'LS' },
  { clientid: 'F005', firstname: 'Max',       lastname: 'Mark',       statuscode: 'ENR', service: 'LS' },
  { clientid: 'F006', firstname: 'Mateo',     lastname: 'Martinez',   statuscode: 'ENR', service: 'LS' },
  { clientid: 'F007', firstname: 'Ishaan',    lastname: 'Vij',        statuscode: 'ENR', service: 'S1' },
];
let pass = 0; const fail = [];
const t = (n, f) => { try { f(); console.log('  ok   ' + n); pass++; }
  catch (e) { console.log('  FAIL ' + n + '\n       ' + e.message); fail.push(n); } };

t('siblings resolve to the hinted child, not the first-listed', () => {
  const r = resolveStudent('Helen Louie (Nolan and Morgan Lan)', ROSTER, { student: 'Morgan Lan' });
  assert.equal(r.bestMatch?.firstname, 'Morgan');
});

t('nickname prefix still clears the floor (Gwen -> Gwendolen)', () => {
  const r = resolveStudent('Jaclyn Stanfield (Gwen Stanfield)', ROSTER, { student: 'Gwen Stanfield' });
  assert.equal(r.bestMatch?.firstname, 'Gwendolen');
  assert.notEqual(r.confidence, 'none');
});

t('a token-scrap collision returns NO match (Mar Chong vs Ben Mark, 0.167)', () => {
  // Matthew is NOT in this fixture — the exact pre-enrollment state that
  // produced the live bug.
  const r = resolveStudent('Christine Mar Chong (Matthew Mar Chong)', ROSTER, { student: 'Matthew Mar Chong' });
  assert.equal(r.bestMatch, null, 'must not crown a 0.167 tie');
  assert.equal(r.confidence, 'none');
  assert.ok(r.flooredMatch, 'the floored candidate should still be visible for logs');
});

t('same first name, wrong family returns NO match (Boinepally vs Vij, 0.500)', () => {
  const r = resolveStudent('Shravya Nellutla (Ishaan & Anshul Boinepally)', ROSTER, { student: 'Ishaan Boinepally' });
  assert.equal(r.bestMatch, null, 'a first-name-only overlap must not name a child');
});

t('once the real student enrolls, they win over the collision', () => {
  const withMatthew = [...ROSTER, { clientid: 'F008', firstname: 'Matthew', lastname: 'Mar Chong', statuscode: 'ENR', service: 'L1' }];
  const r = resolveStudent('Christine Mar Chong (Matthew Mar Chong)', withMatthew, { student: 'Matthew Mar Chong' });
  assert.equal(r.bestMatch?.firstname, 'Matthew');
  assert.equal(r.confidence, 'high');
});

t('teacher contacts still short-circuit', () => {
  const r = resolveStudent('Tim Corrie (Teacher)', ROSTER);
  assert.equal(r.isTeacherContact, true);
});

console.log(`\n${pass} passed, ${fail.length} failed`);
if (fail.length) process.exit(1);
