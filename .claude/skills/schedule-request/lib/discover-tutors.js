/**
 * lib/discover-tutors.js — candidate-tutor discovery for a subject.
 *
 * When a request names no tutor (e.g. a new-subject session), the orchestrator
 * needs a shortlist of tutors who *might* be qualified. This module produces
 * that shortlist from the cached A+ quals index (`aplus-quals.json`) — fast,
 * no live scraping. The orchestrator then LIVE-verifies each shortlisted tutor
 * (authoritative quals + availability + conflicts), so an incomplete/stale
 * index can only cause a tutor to be *missed*, never wrongly recommended.
 *
 * Subject matching mirrors the orchestrator's fuzzy rule: a service matches if
 * its name equals, contains, or is contained by the subject (case-insensitive).
 * Combined services like "Chemistry/Algebra 2" therefore match "Chemistry".
 */
const fs = require('fs');
const path = require('path');
const { serviceMatchesAny } = require('./subject-map');
const { isNonTutor } = require('./non-tutors');

const QUALS_PATH = path.join(__dirname, '..', 'aplus-quals.json');

/** Load the quals index. Returns { extractedAt, teachers: [...] } or null. */
function loadQualsIndex(p = QUALS_PATH) {
  if (!fs.existsSync(p)) return null;
  const raw = JSON.parse(fs.readFileSync(p, 'utf8'));
  const teachers = Array.isArray(raw.teachers) ? raw.teachers
    : raw.teachers ? Object.values(raw.teachers) : [];
  return { extractedAt: raw.extractedAt || null, teachers };
}

/**
 * Rank tutors in the index qualified for the given subject term(s).
 *
 * `terms` may be a single subject string or an array of mapped A+ service-name
 * terms (from subject-map.js). Scoring favours an exact service-name match,
 * then a specialist (a tutor who offers fewer services overall is a more
 * targeted fit than one flagged for everything — see the "Assign All" caveat
 * in PLAN.md).
 *
 * Returns [{ tutor, eid, services, exact, offeredCount, score }], best first.
 */
function findQualifiedTutors(terms, qualsIndex, { max = 8 } = {}) {
  if (!qualsIndex || !qualsIndex.teachers) return [];
  const termList = Array.isArray(terms) ? terms : [terms];
  const termSet = new Set(termList.map(t => (t || '').toLowerCase().trim()));
  const out = [];
  for (const t of qualsIndex.teachers) {
    // Admin/placeholder entries carry real service qualifications in A+ (e.g.
    // "McRetest Retest" is qualified for the retest services), so without this
    // guard discovery happily recommends them — that is how the 2026-07-03
    // practice-SSAT request got "book with McRetest, Retest (RETEST)".
    // The history/named paths already filter; discovery was the hole.
    if (isNonTutor(t.lastFirst || t.displayName)) continue;
    const offered = (t.services || []).filter(s => s.offered);
    const matches = offered.filter(s => serviceMatchesAny(s.name, termList));
    if (!matches.length) continue;
    const exact = matches.some(s => termSet.has((s.name || '').toLowerCase().trim()));
    // Down-weight "offers everything" tutors; up-weight an exact-name match.
    const score = (exact ? 1 : 0) + 1 / Math.max(1, offered.length);
    out.push({
      tutor: t.lastFirst || t.displayName,
      eid: t.eid,
      services: matches.map(s => s.name),
      exact,
      offeredCount: offered.length,
      score: +score.toFixed(4),
    });
  }
  out.sort((a, b) => b.score - a.score);
  return out.slice(0, max);
}

/**
 * Build the candidate-tutor name list for an orchestration run:
 *   - names already on the payload (kept first, in order)
 *   - then discovered subject-qualified tutors from the index (deduped)
 * capped at `max`. Returns { candidates: [names], discovered: [...], indexAge }.
 */
function buildCandidateList({ subject, subjectTerms, named = [], qualsIndex, max = 8 }) {
  const discovered = findQualifiedTutors(subjectTerms || subject, qualsIndex, { max: max * 2 });
  const seen = new Set(named.map(n => n.toLowerCase()));
  const merged = [...named];
  for (const d of discovered) {
    if (merged.length >= max) break;
    const key = (d.tutor || '').toLowerCase();
    if (key && !seen.has(key) && ![...seen].some(s => key.includes(s) || s.includes(key))) {
      merged.push(d.tutor);
      seen.add(key);
    }
  }
  return {
    candidates: merged,
    discovered,
    indexAge: qualsIndex?.extractedAt || null,
  };
}

module.exports = { loadQualsIndex, findQualifiedTutors, buildCandidateList, QUALS_PATH };
