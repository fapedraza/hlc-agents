/**
 * lib/parse-student-note.js — read the convention staff already use in the A+
 * Student Notes field.
 *
 * Observed forms (all real, from the 2026-07-30 sample):
 *
 *   "7/13/2026 No Connie"
 *   "7/8/2026 No Leta for math"                  <- scoped to a subject
 *   "10/10/2023 NO NAINA"                        <- shouty, and stale
 *   "6/2/2016 Best: Amy, Jamie, Alicia, Anita
 *             Okay: Stacey, Josh, Ian
 *             No: Beverly, Janis"                <- the full model
 *   "12/29/2025 Hana preferred
 *               Inform family of tutor changes"
 *   "7/7/2026 Family would like to be informed of any tutor changes"
 *
 * Design notes:
 *   - Names are FIRST names as staff write them. Resolving them to a roster tutor
 *     is the caller's job, because only the caller knows which tutors exist.
 *   - Entries carry a leading date. That is how staff signal age, so it is kept
 *     and surfaced rather than discarded - a "No" from 2016 deserves review.
 *   - Anything not matching a rule pattern is returned as `other`, NOT dropped.
 *     Several notes carry real constraints we do not model (communication
 *     routing, room preference, delivery mode) and staff must still see them.
 */

const DATE_RE = /(\d{1,2}\/\d{1,2}\/\d{4})/;
const SPLIT = /\s*(?:,|;|\band\b|\/)\s*/i;

/** Strip a trailing scope like "for math" and return [names, scope]. */
function splitScope(s) {
  const m = s.match(/^(.*?)\s+for\s+(.+)$/i);
  return m ? [m[1], m[2].trim()] : [s, null];
}
const cleanNames = s => s.split(SPLIT).map(x => x.trim().replace(/[.\s]+$/, '')).filter(x => /^[A-Za-z][A-Za-z'\-. ]{1,30}$/.test(x));

/**
 * @returns {{never:Array,prefer:Array,okay:Array,other:string[],dates:string[],raw:string}}
 *   never/prefer/okay entries are { name, scope, date }.
 */
function parseStudentNote(raw) {
  const out = { never: [], prefer: [], okay: [], other: [], dates: [], raw: raw || '' };
  if (!raw || !String(raw).trim()) return out;

  for (const line of String(raw).split(/\r?\n/).map(l => l.trim()).filter(Boolean)) {
    const dm = line.match(DATE_RE);
    const date = dm ? dm[1] : null;
    if (date) out.dates.push(date);
    const body = (date ? line.replace(date, '') : line).trim();
    if (!body) continue;

    // "Best: a, b"  /  "Okay: a, b"  /  "No: a, b"
    const labelled = body.match(/^(best|prefer(?:red|s)?|okay|ok|no|not|never|avoid)\s*:\s*(.+)$/i);
    if (labelled) {
      const [, label, rest] = labelled;
      const [namesPart, scope] = splitScope(rest);
      const names = cleanNames(namesPart).map(name => ({ name, scope, date }));
      if (/^(best|prefer)/i.test(label)) out.prefer.push(...names);
      else if (/^(okay|ok)$/i.test(label)) out.okay.push(...names);
      else out.never.push(...names);
      continue;
    }

    // bare "No Connie" / "NO NAINA" / "No Leta for math"
    const bare = body.match(/^(?:no|not|never|avoid)\s+(?!longer\b|show\b)(.+)$/i);
    if (bare) {
      const [namesPart, scope] = splitScope(bare[1]);
      const names = cleanNames(namesPart);
      if (names.length) { out.never.push(...names.map(name => ({ name, scope, date }))); continue; }
    }

    // "Hana preferred"
    const pref = body.match(/^(.+?)\s+(?:is\s+)?preferred$/i);
    if (pref) {
      const names = cleanNames(pref[1]);
      if (names.length) { out.prefer.push(...names.map(name => ({ name, scope: null, date }))); continue; }
    }

    out.other.push(body);
  }

  // A note accumulates over years - Tanisha Aggarwal's spans 2016 to 2026 with
  // several Best/Okay/No blocks. Without this, a name appears many times and can
  // sit in two buckets at once. Resolve each name to its MOST RECENT
  // classification, and report the ones that changed so staff can see the churn.
  const ts = d => { const m = (d || '').match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
    return m ? Date.UTC(+m[3], +m[1] - 1, +m[2]) : 0; };
  const latest = new Map();   // lowercased name -> { bucket, entry }
  out.superseded = [];
  for (const bucket of ['never', 'prefer', 'okay']) {
    for (const e of out[bucket]) {
      const k = e.name.toLowerCase();
      const prev = latest.get(k);
      if (!prev) { latest.set(k, { bucket, entry: e }); continue; }
      if (ts(e.date) > ts(prev.entry.date)) {
        if (prev.bucket !== bucket) out.superseded.push(`${e.name}: ${prev.bucket} (${prev.entry.date||'?'}) -> ${bucket} (${e.date||'?'})`);
        latest.set(k, { bucket, entry: e });
      }
    }
  }
  out.never = []; out.prefer = []; out.okay = [];
  for (const { bucket, entry } of latest.values()) out[bucket].push(entry);
  const byDate = (a, b) => ts(b.date) - ts(a.date);
  out.never.sort(byDate); out.prefer.sort(byDate); out.okay.sort(byDate);

  // Oldest date on any surviving rule - a "No" from 2016 deserves a second look.
  const all = [...out.never, ...out.prefer, ...out.okay].map(e => e.date).filter(Boolean);
  out.oldestRuleDate = all.length ? all.sort((a, b) => ts(a) - ts(b))[0] : null;
  return out;
}

/** True if the note asks staff to tell the family before changing tutor (item C6). */
function wantsTutorChangeNotice(raw) {
  return /inform(?:ed)?[^.\n]*tutor change|tutor change[^.\n]*inform|heads?\s*up[^.\n]*tutor/i.test(raw || '');
}

module.exports = { parseStudentNote, wantsTutorChangeNotice };
