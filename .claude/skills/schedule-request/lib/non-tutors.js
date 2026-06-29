/**
 * lib/non-tutors.js — exclusion list for A+ "teacher" entries that aren't real
 * tutors.
 *
 * A+ carries admin/placeholder entries in its staff list (e.g. "Head Teacher",
 * which represents admin hours, per Mariah). These can otherwise be surfaced as
 * recommendable tutors by subject discovery or even appear in session history.
 * `isNonTutor()` filters them out everywhere candidates are assembled.
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
