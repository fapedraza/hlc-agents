/**
 * test-resolve.js — student resolution: sibling narrowing + the confidence floor.
 *
 * The floor exists because weak matches were WORSE than no match: "Matthew Mar
 * Chong" resolved to Ben Mark at 0.167 (three-way tie) and the reply draft asked
 * the parent "Which works best for Ben?"; "Ishaan Boinepally" resolved to Ishaan
 * Vij at 0.500 — right first name, wrong family. Measured floor: every verified
 * correct match scores >= 0.75; every verified wrong one <= 0.50.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { resolveStudent } = require('../resolve-student');
const roster = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'lcos-roster.json'), 'utf8'));
let pass = 0; const fail = [];
const t = (n, f) => { try { f(); console.log('  ok   ' + n); pass++; }
  catch (e) { console.log('  FAIL ' + n + '\n       ' + e.message); fail.push(n); } };

t('siblings resolve to the hinted child, not the first-listed', () => {
  const r = resolveStudent('Helen Louie (Nolan and Morgan Lan)', roster, { student: 'Morgan Lan' });
  assert.equal(r.bestMatch?.firstname, 'Morgan');
});

t('nickname prefix still clears the floor (Gwen -> Gwendolen)', () => {
  const r = resolveStudent('Jaclyn Stanfield (Gwen Stanfield)', roster, { student: 'Gwen Stanfield' });
  assert.equal(r.bestMatch?.firstname, 'Gwendolen');
  assert.notEqual(r.confidence, 'none');
});

t('a token-scrap collision returns NO match (Mar Chong -> Ben Mark, 0.167)', () => {
  const r = resolveStudent('Christine Mar Chong (Matthew Mar Chong)', roster, { student: 'Matthew Mar Chong' });
  assert.equal(r.bestMatch, null, 'must not crown a 0.167 tie');
  assert.equal(r.confidence, 'none');
  assert.ok(r.flooredMatch, 'the floored candidate should still be visible for logs');
});

t('same first name, wrong family returns NO match (Boinepally -> Vij, 0.500)', () => {
  const r = resolveStudent('Shravya Nellutla (Ishaan & Anshul Boinepally)', roster, { student: 'Ishaan Boinepally' });
  assert.equal(r.bestMatch, null, 'a first-name-only overlap must not name a child');
});

t('teacher contacts still short-circuit', () => {
  const r = resolveStudent('Tim Corrie (Teacher)', roster);
  assert.equal(r.isTeacherContact, true);
});

console.log(`\n${pass} passed, ${fail.length} failed`);
if (fail.length) process.exit(1);
