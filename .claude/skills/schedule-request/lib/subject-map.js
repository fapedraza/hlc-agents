/**
 * lib/subject-map.js — map a customer-facing subject phrase to canonical A+
 * service-name terms.
 *
 * Customers write things like "IB English", "AP Stats", or "math" that don't
 * line up with A+'s exact service names ("Language Arts", "AP Statistics",
 * "Math"). resolveSubject() translates the phrase into the A+ service terms to
 * qualify/discover tutors against, and produces a `note` whenever the mapping
 * is non-trivial (so staff can confirm an inferred subject — e.g. IB English →
 * Language Arts).
 *
 * Matching is intentionally the SAME fuzzy rule the orchestrator uses for
 * qualifications: a service matches a term if their lowercased names are equal,
 * or one contains the other. So a root term like "Chemistry" also catches
 * "Chemistry/Algebra 2"; "Language Arts" catches "AP Language Arts".
 *
 * The table lives in ../subject-map.json (data, easy to extend without code).
 */
const fs = require('fs');
const path = require('path');

const MAP_PATH = path.join(__dirname, '..', 'subject-map.json');

let _cache = null;
function loadMap(p = MAP_PATH) {
  if (_cache && p === MAP_PATH) return _cache;
  const raw = JSON.parse(fs.readFileSync(p, 'utf8'));
  const m = { version: raw.version, entries: raw.entries || [] };
  if (p === MAP_PATH) _cache = m;
  return m;
}

const norm = s => (s || '').toString().toLowerCase().replace(/\s+/g, ' ').trim();
const tokens = s => norm(s).split(/[^a-z0-9]+/).filter(t => t.length >= 2);

/** Do the input phrase and any mapped service share a word token? */
function sharesToken(input, services) {
  const it = new Set(tokens(input));
  return (services || []).some(s => tokens(s).some(t => it.has(t)));
}

/** Fuzzy service↔term match: equal, or one contains the other (case-insensitive). */
function serviceMatchesTerm(serviceName, term) {
  const n = norm(serviceName), t = norm(term);
  if (!n || !t) return false;
  return n === t || n.includes(t) || t.includes(n);
}

/** True if `serviceName` matches ANY of the given terms. */
function serviceMatchesAny(serviceName, terms) {
  return (terms || []).some(t => serviceMatchesTerm(serviceName, t));
}

/**
 * Resolve a customer subject phrase to A+ service terms.
 *
 * Returns:
 *   {
 *     input,                 // the original phrase
 *     services: [terms],     // A+ service-name terms to match tutors against
 *     canonical,             // human label for the matched group (or null)
 *     category,              // 'subject' | 'exam-prep' | 'college' | 'world-language' | null
 *     matchedAlias,          // which alias matched (or 'exact-service' / null)
 *     exact,                 // input already equals an A+ service term
 *     mapped,                // input was translated via an alias (≠ exact)
 *     note,                  // staff caveat when the mapping is inferred (else null)
 *   }
 *
 * Resolution order: exact alias → substring alias → none (falls back to using
 * the raw phrase as the term, flagged with a note).
 */
function resolveSubject(input, { map } = {}) {
  const table = map || loadMap();
  const q = norm(input);
  const base = { input, services: input ? [input] : [], canonical: null, category: null, matchedAlias: null, exact: false, mapped: false, note: null };
  if (!q) return base;

  // 1) exact alias match
  let entry = table.entries.find(e => (e.aliases || []).some(a => norm(a) === q));
  let matchedAlias = entry ? q : null;

  // 2) substring alias match (alias contains the phrase or vice-versa), longest alias wins
  if (!entry) {
    let best = null, bestLen = 0;
    for (const e of table.entries) {
      for (const a of e.aliases || []) {
        const na = norm(a);
        if ((na.includes(q) || q.includes(na)) && na.length > bestLen) { best = e; bestLen = na.length; matchedAlias = na; }
      }
    }
    entry = best;
  }

  if (!entry) {
    return { ...base, note: `No subject mapping for "${input}" — searching tutors with the raw term; confirm the intended A+ service.` };
  }

  // Did the customer phrase already equal one of the target service terms?
  const exact = (entry.services || []).some(s => norm(s) === q);
  const mapped = !exact;
  // A mapping needs staff confirmation only when it's a genuine semantic leap —
  // i.e. the customer's wording shares no word with any mapped service (e.g.
  // "IB English" → Language Arts). Abbreviations/casing ("AP Stats" → AP
  // Statistics) share a token and pass silently.
  const ambiguous = mapped && !sharesToken(input, entry.services);
  const note = ambiguous
    ? `Customer said "${input}" — no exact A+ service; mapped to ${entry.services.join(' / ')}. Confirm before booking.`
    : null;

  return {
    input,
    services: entry.services.slice(),
    canonical: entry.canonical,
    category: entry.category || null,
    matchedAlias,
    exact,
    mapped,
    ambiguous,
    note,
  };
}

module.exports = { resolveSubject, serviceMatchesAny, serviceMatchesTerm, loadMap, MAP_PATH };
