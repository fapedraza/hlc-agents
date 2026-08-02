/**
 * lib/non-tutors.js — exclusion list for A+ "teacher" entries that aren't real
 * tutors.
 *
 * Two kinds of entry belong here, both meaning "never auto-recommend this name":
 *
 *   1. Placeholders that are not people at all - "Head Teacher" (admin hours) and
 *      "Retest" (the pseudo-tutor proctored practice tests are booked against).
 *   2. Real staff who DO teach but must not be auto-assigned. Mariah Landon, 2026-08-01:
 *      "This required a more personal response, explaining why Mariah was not
 *      available as a regular tutor due to administrative responsibilities."
 *      She covers floor and fills gaps - 32 sessions across 23 students - but is
 *      the majority tutor for none of them, so excluding her costs no student
 *      their history anchor.
 *
 * `isNonTutor()` filters these out everywhere candidates are assembled.
 *
 * The list lives in `non-tutors.json` (sibling of the skill dir) so it can be
 * edited without touching code.
 */
const fs = require('fs');
const path = require('path');

const NON_TUTORS_PATH = path.join(__dirname, '..', 'non-tutors.json');

let cached = null;
function loadNonTutors(p = NON_TUTORS_PATH) {
  if (cached) return cached;
  try {
    const raw = JSON.parse(fs.readFileSync(p, 'utf8'));
    cached = Array.isArray(raw) ? raw : [];
  } catch {
    cached = ['Head Teacher'];
  }
  return cached;
}

/** True if `name` matches a known non-tutor placeholder (substring, case-insensitive). */
function isNonTutor(name) {
  const n = (name || '').toLowerCase();
  if (!n) return false;
  return loadNonTutors().some(x => n.includes(x.toLowerCase()));
}

module.exports = { isNonTutor, loadNonTutors, NON_TUTORS_PATH };
