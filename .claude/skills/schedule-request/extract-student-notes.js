/**
 * extract-student-notes.js — read per-student scheduling constraints out of the
 * shared A+ schedule report cache.
 *
 * Staff have been recording tutor exclusions in the A+ "Student Notes" field for
 * years, in a convention they invented themselves:
 *
 *     7/13/2026 No Connie
 *     7/8/2026  No Leta for math
 *     6/2/2016  Best: Amy, Jamie, Alicia, Anita
 *               Okay: Stacey, Josh, Ian
 *               No: Beverly, Janis
 *
 * That is prefer / any / never, a decade before we proposed it. So the bot reads
 * what already exists rather than asking anyone to maintain a new list.
 *
 * (Note this is NOT "Session Notes (internal)", which is a per-session ops log of
 * no-shows and cover arrangements. Different field, different purpose.)
 *
 * WAS a headless browser scrape against an ad-hoc report, because report 763 did
 * not carry Student Notes / Teacher Type / Service. Ferni added all three to 763
 * on 2026-07-30, so this now derives everything from the cache that the reconcile
 * and the scheduling pipeline already share — no browser, no second login, no
 * risk of disturbing a shared saved report.
 *
 * Usage: node extract-student-notes.js [--days 45] [--back 7] [--out student-notes.json]
 *        [--csv <path>]   (defaults to the shared history cache)
 */
const fs = require('fs');
const path = require('path');
const { DEFAULT_CACHE_PATH } = require(path.join(__dirname, 'lib', 'fetch-history.js'));

const argv = process.argv.slice(2);
const argVal = (f, d) => { const i = argv.indexOf(f); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const DAYS = parseInt(argVal('--days', '45'), 10);
const BACK = parseInt(argVal('--back', '7'), 10);
const OUT = path.join(__dirname, argVal('--out', 'student-notes.json'));
const CSV = argVal('--csv', DEFAULT_CACHE_PATH);

const mdy = d => `${d.getMonth() + 1}/${d.getDate()}/${d.getFullYear()}`;

/** RFC4180-ish parse: the report quotes fields and Student Notes contain commas and newlines. */
function parseCsv(text) {
  const rows = [];
  let field = '', row = [], inQ = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQ) {
      if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else inQ = false; }
      else field += c;
    } else if (c === '"') inQ = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else if (c !== '\r') field += c;
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  return rows.filter(r => r.length > 1);
}

/**
 * Restore the line breaks A+ destroys on CSV export.
 *
 * Staff type Student Notes as multiple lines. The HTML admin view preserves them;
 * the CSV export does not - it collapses some breaks to " | " and the rest to a
 * plain space. parse-student-note.js anchors every pattern to line start/end
 * (`^best\s*:\s*(.+)$`), so a collapsed note makes "Best:" swallow the whole
 * thing: Tanisha Aggarwal's `No: Beverly, Janis` silently became `never: []`.
 * An emptied denylist is the exact failure the tutor-rule work exists to prevent,
 * so this is reconstructed here rather than by loosening the parser.
 *
 * The date lookbehind matters: breaking between "9/14/2015" and "Best:" would
 * orphan the label from its date, and the date is what drives most-recent-wins.
 */
const NOTE_LABELS = 'best|okay|ok|no|not|never|avoid|prefers?|preferred|focus';
function restoreLines(note) {
  return String(note || '')
    .replace(/\s*\|\s*/g, '\n')                                   // A+ writes some breaks as a pipe
    .replace(/\s+(?=\d{1,2}\/\d{1,2}\/\d{4})/g, '\n')             // a new dated entry starts a line
    .replace(new RegExp(`(?<!\\d{4})\\s+(?=(?:${NOTE_LABELS})\\s*:)`, 'gi'), '\n') // ...but keep "6/2/2016 Best:" together
    // "Hana preferred" + "Inform family..." is two lines; "Quiet room preferred
    // when possible" is one sentence. A capitalised next word is the only signal
    // left that a break was there. (No /i flag - it would make [A-Z] match anything.)
    .replace(/\b[Pp]referred\b(?=\s+[A-Z])/g, 'preferred\n')
    .replace(/\n{2,}/g, '\n')
    .trim();
}

/** "M/D/YYYY" → Date, or null. */
function parseDate(s) {
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec((s || '').trim());
  return m ? new Date(+m[3], +m[1] - 1, +m[2]) : null;
}

if (!fs.existsSync(CSV)) {
  console.error(`no schedule report cache at ${CSV}\nrun: node prewarm-history.js --force`);
  process.exit(1);
}

const grid = parseCsv(fs.readFileSync(CSV, 'utf8'));
if (grid.length < 2) { console.error(`${CSV} has no data rows`); process.exit(1); }

const hdr = grid[0].map(h => h.trim());
const at = n => hdr.findIndex(h => h.toLowerCase().includes(n));
const iName = at('student name'), iNote = at('student note'), iSvc = at('service'),
      iStaff = at('teacher'), iType = at('teacher type'), iDate = at('session date');

// Report 763 only gained these on 2026-07-30. A cache written before then parses
// fine but silently yields no rules, which would look like "nobody has any
// constraints" rather than "the cache is stale". Fail loudly instead.
const missing = [['Student Notes', iNote], ['Teacher Type', iType], ['Service', iSvc]]
  .filter(([, i]) => i < 0).map(([n]) => n);
if (missing.length) {
  console.error(`${CSV} is missing column(s): ${missing.join(', ')}`);
  console.error('the cache predates the 2026-07-30 report change — run: node prewarm-history.js --force');
  process.exit(1);
}

const now = new Date();
const from = new Date(now.getFullYear(), now.getMonth(), now.getDate() - BACK);
const to = new Date(now.getFullYear(), now.getMonth(), now.getDate() + DAYS);

const students = new Map(), teachers = new Map(), sessions = [];
let scanned = 0;
for (const r of grid.slice(1)) {
  const d = parseDate(r[iDate]);
  if (!d || d < from || d > to) continue;
  scanned++;

  const name = (r[iName] || '').trim();
  // Per-session rows too: a scoped rule ("No Leta for math") cannot be checked
  // without knowing each session's service.
  if (name) sessions.push({
    student: name, teacher: (r[iStaff] || '').trim(),
    service: (r[iSvc] || '').trim(), date: (r[iDate] || '').trim(),
  });
  if (name) {
    if (!students.has(name)) students.set(name, { student: name, note: restoreLines(r[iNote]), services: new Set() });
    const s = students.get(name);
    if (r[iSvc]) s.services.add(r[iSvc].trim());
    if (!s.note && r[iNote]) s.note = restoreLines(r[iNote]);
  }
  const t = (r[iStaff] || '').trim();
  if (t && !teachers.has(t)) teachers.set(t, { teacher: t, type: (r[iType] || '').trim() });
}

const out = {
  fetchedISO: new Date().toISOString(),
  source: CSV,
  sourceMtimeISO: fs.statSync(CSV).mtime.toISOString(),
  range: { from: mdy(from), to: mdy(to) },
  sessionRows: scanned,
  students: [...students.values()].map(s => ({ ...s, services: [...s.services] })),
  teachers: [...teachers.values()],
  sessions,
};
fs.writeFileSync(OUT, JSON.stringify(out, null, 2));

const withNotes = out.students.filter(s => s.note).length;
const withType = out.teachers.filter(t => t.type).length;
console.log(`${scanned} session rows in ${out.range.from}–${out.range.to} -> ` +
  `${out.students.length} students (${withNotes} with a Student Note), ` +
  `${out.teachers.length} teachers (${withType} with a Teacher Type)`);
console.log(`wrote ${OUT}`);
