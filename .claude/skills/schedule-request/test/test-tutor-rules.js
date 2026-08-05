/**
 * test-tutor-rules.js — validate the rules layer against REAL A+ data before it
 * is allowed to influence a recommendation.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const R = require('../lib/tutor-rules');

const roster = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'lcos-roster.json'), 'utf8'));
const stu = n => roster.find(r => `${r.firstname} ${r.lastname}`.toLowerCase() === n.toLowerCase());
let pass = 0; const fail = [];
const t = (name, fn) => { try { fn(); console.log('  ok   ' + name); pass++; }
  catch (e) { console.log('  FAIL ' + name + '\n       ' + e.message); fail.push(name); } };

t('student pools come from the LCOS service code', () => {
  assert.equal(R.poolForStudent(stu('Quintin Ellison')), 'LC');      // L1
  assert.equal(R.poolForStudent({ service: 'LS' }), 'LC');
  assert.equal(R.poolForStudent({ service: 'S1' }), 'EPST');
  assert.equal(R.poolForStudent({ service: 'ST' }), 'EPST');
});

t('every Teacher Type value in A+ maps to a pool', () => {
  const { teachers } = R.load();
  const unmapped = teachers.filter(x => x.type && !(x.type.trim() in R.TYPE_TO_POOL));
  assert.equal(unmapped.length, 0, 'unmapped types: ' + unmapped.map(x => x.type).join(', '));
});

t('a teacher who does both is in both pools', () => {
  assert.deepEqual(R.poolsForTeacher('Webb Jennifer'), ['LC', 'EPST']);   // "LC & EP/ST"
});

t('admin staff are not auto-assignable', () => {
  assert.deepEqual(R.poolsForTeacher('Landon Mariah'), []);               // "Full Time Staff"
});

t('the real wrong-category case scores -1', () => {
  // Quintin Ellison (L1 = LC) was proposed Rollison Elizabeth (EP/ST Verbal).
  assert.equal(R.categoryFit('Rollison Elizabeth', stu('Quintin Ellison')), -1);
});

t('a same-pool tutor scores +1', () => {
  assert.equal(R.categoryFit('Ulrich Connie', stu('Quintin Ellison')), 1);
});

t('unknown on either side is neutral, never wrong', () => {
  assert.equal(R.categoryFit('Nobody At All', stu('Quintin Ellison')), 0);
  assert.equal(R.categoryFit('Ulrich Connie', { service: 'ZZ' }), 0);
});

t('a live never-rule excludes (Morgan Lan / Leta, note dated 8/1/2026)', () => {
  assert.ok(R.excludedBy('Morgan Lan', 'Hamilton Leta', 'Verbal Floor'));
});

t('a scoped rule only bites inside its scope', () => {
  assert.ok(!R.excludedBy('Lane MacDougall', 'Hamilton Leta', 'Verbal Floor'), 'verbal must be allowed');
  assert.ok(R.excludedBy('Lane MacDougall', 'Hamilton Leta', 'Math Floor'), 'math must be excluded');
});

t('rules naming departed staff are dropped, with a reason', () => {
  const r = R.rulesForStudent('Zayd Moussa');
  assert.equal(r.prefer.length, 0, 'prefer Hana must not survive - Hana has left');
  assert.ok(r.dropped.some(d => /hana/i.test(d.name)));
});

t('the 2016 note contributes no live rules', () => {
  const r = R.rulesForStudent('Tanisha Aggarwal');
  assert.equal(r.never.length + r.prefer.length, 0);
  assert.ok(r.dropped.length >= 10, 'expected the stale 2016 names to be dropped');
});

t('a live rule for a current tutor still applies', () => {
  assert.ok(R.excludedBy('Claire Rigby', 'Ulrich Connie', 'Learning Center 1:1 A'));
});

console.log(`\n${pass} passed, ${fail.length} failed`);
if (fail.length) process.exit(1);
