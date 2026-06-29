/**
 * resolve-student.js — Text Request contact name → LCOS clientid.
 *
 * Text Request contact strings come in three patterns:
 *
 *   "Pelita Batingan (Ryan Batingan)"   ← parent (student)
 *   "Zana Wang (Student)"               ← student, role-labeled
 *   "Tim Corrie (Teacher)"              ← staff, role-labeled — NOT a student
 *
 * The resolver parses the contact, then fuzzy-matches against an LCOS roster
 * (the output of `lcos_get_active_students`). Output is ranked candidates with
 * a confidence band so the agent can ask for human confirmation on low matches
 * instead of guessing.
 *
 * Usage (module):
 *   const { resolveStudent } = require('./resolve-student');
 *   const result = resolveStudent('Pelita Batingan (Ryan Batingan)', rosterRows);
 *
 * Usage (CLI):
 *   node resolve-student.js "<contact name>" [roster.json]
 *
 * `roster.json` may be either an array of LCOS rows or `{ rows: [...] }` —
 * matching what the LCOS MCP tools return.
 */
const fs = require('fs');
const path = require('path');

const ROLE_TOKENS = /^(student|parent|teacher|guardian|alum|alumni|tutor|coach|staff|admin|grandparent)$/i;

/**
 * Extract the OUTER (balanced) parenthetical from a contact string, tolerating
 * nesting like "Zahera Shaik (Shaheer (JB) and Sarah Shaikh)". Returns the
 * text before the first "(" as `primary` and the balanced inner text as
 * `parenContent` (null if there is no parenthetical).
 */
function extractOuterParen(s) {
  const start = s.indexOf('(');
  if (start < 0) return { primary: s.trim(), parenContent: null };
  let depth = 0, end = -1;
  for (let i = start; i < s.length; i++) {
    if (s[i] === '(') depth++;
    else if (s[i] === ')') { depth--; if (depth === 0) { end = i; break; } }
  }
  const primary = s.slice(0, start).trim();
  const parenContent = (end < 0 ? s.slice(start + 1) : s.slice(start + 1, end)).trim();
  return { primary, parenContent };
}

/**
 * Parse the student list out of a parenthetical, handling:
 *   - multiple students joined by "and" / "&" / ","   ("Eddy and Evan Rudolph")
 *   - per-student nicknames in inner parens                 ("Shaheer (JB)")
 *   - a trailing shared surname propagated to bare first names
 *     ("Shaheer (JB) and Sarah Shaikh" → "Shaheer Shaikh" + "Sarah Shaikh")
 * Returns [{ name, nickname }].
 */
function parseStudents(parenContent) {
  if (!parenContent) return [];
  const pieces = parenContent
    .split(/\s*(?:\band\b|&|,|\/)\s*/i)
    .map(p => p.trim())
    .filter(Boolean);
  const parsed = pieces.map(p => {
    const nick = (p.match(/\(([^)]+)\)/) || [])[1] || null;     // inner nickname
    const name = p.replace(/\([^)]*\)/g, '').replace(/\s+/g, ' ').trim();
    return { name, nickname: nick };
  }).filter(s => s.name);
  // Propagate a trailing surname to single-token (first-name-only) students.
  const lastMulti = [...parsed].reverse().find(s => s.name.split(/\s+/).length >= 2);
  if (lastMulti) {
    const surname = lastMulti.name.split(/\s+/).pop();
    for (const s of parsed) {
      if (s.name.split(/\s+/).length === 1) s.name = `${s.name} ${surname}`;
    }
  }
  return parsed;
}

/** Parse a Text Request contact string into structured pieces. */
function parseContact(name) {
  const trimmed = (name || '').trim();
  if (!trimmed) return { primary: '', inParen: null, students: [], role: null, rawRole: null };
  const { primary, parenContent } = extractOuterParen(trimmed);
  let role = null, rawRole = null, students = [];
  if (parenContent) {
    if (ROLE_TOKENS.test(parenContent)) { role = parenContent.toLowerCase(); rawRole = parenContent; }
    else { students = parseStudents(parenContent); }
  }
  // `inParen` retained for backward compatibility = the first student's name.
  return { primary: parenContent ? primary : trimmed, inParen: students[0]?.name || null, students, role, rawRole };
}

/** Lowercase, strip diacritics, split on whitespace/comma/hyphen. */
function tokenize(s) {
  if (!s) return [];
  return s.toString().toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')   // drop combining marks
    .replace(/[.']/g, '')
    .split(/[\s,\-]+/).filter(Boolean);
}

/**
 * Score a token list against a `(firstname, lastname)` pair.
 *
 * - exact token match = 1.0
 * - prefix match (either direction, ≥3 chars) = 0.5
 *
 * Score is `matched / max(queryTokens.length, targetTokens.length)`, so a
 * "Ryan" query matched to "Ryan Batingan" gets 0.5 (not 1.0) — perfect on the
 * first-name side but missing the last name. A full match on both names = 1.0.
 */
function scoreMatch(queryTokens, fname, lname) {
  const target = [...tokenize(fname), ...tokenize(lname)];
  if (!target.length || !queryTokens.length) return 0;
  let matched = 0;
  const taken = new Set();
  for (const q of queryTokens) {
    let best = 0, bestIdx = -1;
    for (let i = 0; i < target.length; i++) {
      if (taken.has(i)) continue;
      const t = target[i];
      let s = 0;
      if (t === q) s = 1.0;
      else if (q.length >= 3 && t.length >= 3 && (t.startsWith(q) || q.startsWith(t))) s = 0.5;
      if (s > best) { best = s; bestIdx = i; }
    }
    if (bestIdx >= 0) { matched += best; taken.add(bestIdx); }
  }
  return matched / Math.max(queryTokens.length, target.length);
}

/**
 * Resolve a Text Request contact name to one or more LCOS roster entries.
 *
 * Strategy: when the contact has a parenthesized student name (parent text
 * pattern), use that as the primary query — the wrapping name is the parent
 * and won't match the roster. When the parens hold a role label
 * (Student/Teacher/...), use the outer name as primary. Teacher-labeled
 * contacts short-circuit with role='teacher' — they aren't students to look
 * up.
 *
 * Returns:
 *   {
 *     parsed: { primary, inParen, role, rawRole },
 *     candidates: [ { ...rosterRow, _score, _matched } ],  // top 5
 *     bestMatch:  rosterRow | null,
 *     confidence: 'high' | 'medium' | 'low' | 'none',
 *     isTeacherContact: boolean,
 *   }
 */
function resolveStudent(contactName, rosterRows, opts = {}) {
  const parsed = parseContact(contactName);
  if (parsed.role === 'teacher') {
    return { parsed, candidates: [], bestMatch: null, confidence: 'none', isTeacherContact: true, targetStudent: null };
  }

  // If the caller knows which student the request is about (multi-student
  // contacts), narrow to that student by matching the hint against each
  // parsed student's name OR nickname.
  let students = parsed.students;
  let targetStudent = null;
  if (opts.student && students.length) {
    const hintTokens = tokenize(opts.student);
    const matched = students.find(s => {
      const pool = tokenize(`${s.name} ${s.nickname || ''}`);
      return hintTokens.some(h => pool.includes(h));
    });
    if (matched) { students = [matched]; targetStudent = matched.name; }
  }

  // Build the queries to try, weighted. Each parsed student is a full-weight
  // query; the parent/primary name is a weak fallback.
  const queries = [];
  if (students.length) {
    for (const s of students) queries.push({ q: s.name, weight: 1.00, source: 'paren-student' });
    if (parsed.primary) queries.push({ q: parsed.primary, weight: 0.40, source: 'parent-name' });
    // If a hint was given but matched no parsed student, also try it directly.
    if (opts.student && !targetStudent) queries.push({ q: opts.student, weight: 1.00, source: 'hint' });
  } else if (opts.student) {
    queries.push({ q: opts.student, weight: 1.00, source: 'hint' });
    if (parsed.primary) queries.push({ q: parsed.primary, weight: 0.40, source: 'parent-name' });
  } else {
    queries.push({ q: parsed.primary, weight: 1.00, source: 'primary' });
  }
  const scored = [];
  for (const entry of rosterRows || []) {
    const fname = entry.firstname || entry.firstName || entry.first || '';
    const lname = entry.lastname  || entry.lastName  || entry.last  || '';
    let best = 0, bestSrc = null;
    for (const { q, weight, source } of queries) {
      const s = scoreMatch(tokenize(q), fname, lname) * weight;
      if (s > best) { best = s; bestSrc = source; }
    }
    if (best > 0) scored.push({ ...entry, _score: +best.toFixed(3), _matched: bestSrc });
  }
  scored.sort((a, b) => b._score - a._score);
  const top = scored[0];
  const confidence = !top ? 'none'
    : top._score >= 0.90 ? 'high'
    : top._score >= 0.55 ? 'medium'
    : 'low';
  return {
    parsed,
    candidates: scored.slice(0, 5),
    bestMatch: top || null,
    confidence,
    isTeacherContact: false,
    targetStudent: targetStudent || (top ? `${top.firstname || top.firstName || ''} ${top.lastname || top.lastName || ''}`.trim() : null),
  };
}

module.exports = { parseContact, tokenize, scoreMatch, resolveStudent };

// CLI entry
if (require.main === module) {
  const args = process.argv.slice(2);
  if (!args.length) {
    console.error('Usage: node resolve-student.js "<contact name>" [roster.json]');
    process.exit(1);
  }
  const contact = args[0];
  const rosterPath = args[1] || path.join(__dirname, 'lcos-roster.json');
  if (!fs.existsSync(rosterPath)) {
    console.error(`Roster file not found: ${rosterPath}`);
    console.error('Refresh it with the LCOS MCP: lcos_get_active_students → save rows here.');
    process.exit(2);
  }
  const raw = JSON.parse(fs.readFileSync(rosterPath, 'utf8'));
  const rosterRows = Array.isArray(raw) ? raw : (raw.rows || raw.students || raw.results || []);
  const result = resolveStudent(contact, rosterRows);
  console.log(JSON.stringify(result, null, 2));
}
