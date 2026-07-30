/**
 * check-rule-violations.js — is anything booked against a rule staff already wrote?
 *
 * A+ Student Notes carry exclusions like "7/13/2026 No Connie". This checks the
 * upcoming schedule against them. It is the immediate payoff of reading the notes:
 * the rules already exist and nothing has ever enforced them.
 *
 * Names in notes are first names as staff type them, so a note name matches a
 * tutor if it appears as one of that tutor's name tokens. Ambiguity (two staff
 * sharing a first name) is reported rather than guessed.
 */
const fs = require('fs');
const path = require('path');
const { parseStudentNote } = require('./lib/parse-student-note');

const notes = JSON.parse(fs.readFileSync(path.join(__dirname, 'student-notes.json'), 'utf8'));
const HIST = path.join(__dirname, '.cache', 'history-report.csv');
const CANCELLED = new Set(['cancelled','canceled','no-show','no show','noshow','deleted','removed','void','anm','anm - paid','anm - unpaid','absent no makeup','abs','vac']);
const norm = s => (s||'').toLowerCase().replace(/\s+/g,' ').trim();

function parseCsv(t){const L=t.split(/\r?\n/).filter(Boolean);
  const sp=l=>{const o=[];let c='',q=false;for(let i=0;i<l.length;i++){const ch=l[i];
    if(q){if(ch==='"'&&l[i+1]==='"'){c+='"';i++;}else if(ch==='"'){q=false;}else c+=ch;}
    else if(ch==='"'){q=true;}else if(ch===','){o.push(c);c='';}else c+=ch;}o.push(c);return o;};
  const h=sp(L[0]).map(x=>x.trim());
  return L.slice(1).map(l=>{const r=sp(l);const o={};h.forEach((k,i)=>o[k]=(r[i]||'').trim());return o;});}
const mdyISO=s=>{const m=(s||'').match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);return m?`${m[3]}-${String(m[1]).padStart(2,'0')}-${String(m[2]).padStart(2,'0')}`:null;};

// Prefer the ad-hoc rows: they carry Service, which scoped rules need.
const useAdhoc = Array.isArray(notes.sessions) && notes.sessions.length;
const rows = useAdhoc
  ? notes.sessions.map(s => ({ 'Student Name': s.student, 'Teacher': s.teacher,
      'Session Date': s.date, 'Start Time': '', 'Session Status': '', 'Service': s.service }))
  : parseCsv(fs.readFileSync(HIST,'utf8'));
console.log(useAdhoc ? '(using ad-hoc rows - Service available, scoped rules checkable)'
                     : '(using report 763 - NO Service column, scoped rules cannot be evaluated)');
const today = new Date().toISOString().slice(0,10);
const tutors = [...new Set(rows.map(r => (r['Teacher']||'').trim()).filter(Boolean))];
const tokens = t => new Set((t.toLowerCase().match(/[a-z]+/g)) || []);

let checked = 0, violations = [], ambiguous = [], unmatched = [], unscoped = [];
for (const s of notes.students) {
  if (!s.note) continue;
  const p = parseStudentNote(s.note);
  if (!p.never.length) continue;
  checked++;
  const mine = rows.filter(r => norm(r['Student Name']) === norm(s.student)
    && !CANCELLED.has(norm(r['Session Status']))
    && mdyISO(r['Session Date']) && mdyISO(r['Session Date']) >= today);

  for (const rule of p.never) {
    const hits = tutors.filter(t => tokens(t).has(rule.name.toLowerCase()));
    if (hits.length === 0) { unmatched.push(`${s.student}: "No ${rule.name}" - no current tutor by that name (left?)`); continue; }
    if (hits.length > 1)  { ambiguous.push(`${s.student}: "No ${rule.name}" matches ${hits.join(' / ')}`); continue; }
    const banned = hits[0];
    let bad = mine.filter(r => (r['Teacher']||'').trim() === banned);
    // Honour the scope. "No Leta for math" only bites on math services.
    if (rule.scope) {
      const scope = rule.scope.toLowerCase();
      if (!useAdhoc) { unscoped.push(`${s.student}: "No ${rule.name} for ${rule.scope}" - ${bad.length} booking(s) with ${banned}, cannot judge without Service`); continue; }
      bad = bad.filter(r => (r['Service']||'').toLowerCase().includes(scope));
    }
    for (const b of bad) violations.push(
      `${s.student} with ${banned} on ${mdyISO(b['Session Date'])}` +
      `${b['Service'] ? ' [' + b['Service'] + ']' : ''}` +
      `  (note: "${rule.date||''} No ${rule.name}${rule.scope ? ' for '+rule.scope : ''}")`);
  }
}

console.log(`students with a NEVER rule: ${checked}`);
console.log(`\n=== VIOLATIONS: ${violations.length} ===`);
violations.forEach(v => console.log('  ' + v));
if (!violations.length) console.log('  none - the existing rules are being honoured');
console.log(`\n=== NAME AMBIGUOUS (${ambiguous.length}) ===`);
ambiguous.forEach(v => console.log('  ' + v));
if (unscoped.length) { console.log(`\n=== SCOPED RULES NOT EVALUABLE (${unscoped.length}) ===`); unscoped.forEach(v=>console.log('  '+v)); }
console.log(`\n=== RULE NAMES NOT ON CURRENT STAFF (${unmatched.length}) ===`);
unmatched.forEach(v => console.log('  ' + v));
