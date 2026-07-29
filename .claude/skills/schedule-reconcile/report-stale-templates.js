/**
 * report-stale-templates.js — tutors whose A+ availability does not match what
 * they actually teach.
 *
 * Fell out of building Mariah's 2026-07-08 orphaned-session check: 436 of 1604
 * upcoming sessions (27%) sit outside the tutor's own stated hours. That is too
 * noisy to be a session-level report, but it IS a precise statement about the
 * templates themselves - and those templates are not decoration:
 * schedule-request reads them to decide who is free, so a wrong template makes
 * the scheduling bot recommend the wrong people and block the right ones.
 *
 * For each tutor this compares the weekly template against sessions actually on
 * the books and says, per weekday, what the template claims vs what they do.
 *
 * READ-ONLY. Uses the snapshot written by detect-orphaned.js - no scraping.
 *
 * Usage: node report-stale-templates.js [--min-share 0.2] [--slack]
 */
const fs = require('fs');
const path = require('path');

const SR_DIR = path.join(__dirname, '..', 'schedule-request');
const { isNonTutor } = require(path.join(SR_DIR, 'lib', 'non-tutors.js'));
const HISTORY_CSV = path.join(SR_DIR, '.cache', 'history-report.csv');
const SNAPSHOT = path.join(__dirname, '.template-snapshot.json');

const argv = process.argv.slice(2);
const argVal = (f, d) => { const i = argv.indexOf(f); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const MIN_SHARE = parseFloat(argVal('--min-share', '0.2'));
const MIN_SESSIONS = 5;

const DAYS = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
const CANCELLED = new Set(['cancelled','canceled','no-show','no show','noshow','deleted','removed','void','anm','anm - paid','anm - unpaid','absent no makeup','abs','vac']);
const norm = s => (s||'').toLowerCase().replace(/\s+/g,' ').trim();
const toks = s => new Set(((s||'').toLowerCase().match(/[a-z]+/g)) || []);
function sameTutor(a,b){const A=toks(a),B=toks(b);if(!A.size||!B.size)return false;
  const [s,l]=A.size<=B.size?[A,B]:[B,A];for(const t of s)if(!l.has(t))return false;return true;}
function parseCsv(text){const lines=text.split(/\r?\n/).filter(Boolean);
  const split=l=>{const o=[];let c='',q=false;for(let i=0;i<l.length;i++){const ch=l[i];
    if(q){if(ch==='"'&&l[i+1]==='"'){c+='"';i++;}else if(ch==='"'){q=false;}else c+=ch;}
    else if(ch==='"'){q=true;}else if(ch===','){o.push(c);c='';}else c+=ch;}o.push(c);return o;};
  const h=split(lines[0]).map(x=>x.trim());
  return lines.slice(1).map(l=>{const r=split(l);const o={};h.forEach((k,i)=>o[k]=(r[i]||'').trim());return o;});}
function mdyToISO(s){const m=(s||'').trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);return m?`${m[3]}-${String(m[1]).padStart(2,'0')}-${String(m[2]).padStart(2,'0')}`:null;}
function toMins(s){if(!s)return null;const m=s.trim().match(/^(\d{1,2}):?(\d{2})?\s*(am|pm)?$/i);if(!m)return null;
  let h=+m[1];const mm=+(m[2]||0);const ap=(m[3]||'').toLowerCase();
  if(ap==='pm'&&h!==12)h+=12;if(ap==='am'&&h===12)h=0;return h*60+mm;}
function durMins(s){if(!s)return 60;const t=String(s).toLowerCase();let n=0;
  const h=t.match(/([\d.]+)\s*hour/);if(h)n+=Math.round(parseFloat(h[1])*60);
  const m=t.match(/([\d.]+)\s*min/);if(m)n+=Math.round(parseFloat(m[1]));
  if(!n){const p=parseInt(t,10);if(!isNaN(p))n=p;}return n||60;}
const hhmm=s=>{const m=(s||'').match(/^(\d{1,2}):(\d{2})$/);return m?+m[1]*60+ +m[2]:null;};
const fmt=m=>`${String(Math.floor(m/60)).padStart(2,'0')}:${String(m%60).padStart(2,'0')}`;
const t12=m=>{const h=Math.floor(m/60),mm=m%60;const ap=h>=12?'pm':'am';const hh=h%12===0?12:h%12;
  return `${hh}${mm?':'+String(mm).padStart(2,'0'):''}${ap}`;};

if (!fs.existsSync(SNAPSHOT)) { console.error(`No template snapshot. Run detect-orphaned.js first.`); process.exit(1); }
const snap = JSON.parse(fs.readFileSync(SNAPSHOT, 'utf8'));
const rows = parseCsv(fs.readFileSync(HISTORY_CSV, 'utf8'));
const today = new Date().toISOString().slice(0, 10);

// tutor -> day -> { sessions, outside, earliest, latest, students:Set }
const obs = new Map();
for (const r of rows) {
  if (CANCELLED.has(norm(r['Session Status']))) continue;
  const teacher = (r['Teacher']||'').trim();
  if (!teacher || isNonTutor(teacher)) continue;
  const date = mdyToISO(r['Session Date']);
  const start = toMins(r['Start Time']);
  if (!date || start == null || date < today) continue;      // upcoming only
  const end = start + durMins(r['Duration']);
  const day = DAYS[new Date(date + 'T12:00:00').getDay()];
  if (!obs.has(teacher)) obs.set(teacher, {});
  const d = obs.get(teacher);
  if (!d[day]) d[day] = { n: 0, out: 0, earliest: start, latest: end, students: new Set() };
  const x = d[day];
  x.n++; x.earliest = Math.min(x.earliest, start); x.latest = Math.max(x.latest, end);
  x.students.add((r['Student Name']||'').trim());
}

const findings = [];
for (const [tutor, days] of obs) {
  const key = Object.keys(snap.schedules).find(k => sameTutor(k, tutor));
  if (!key) continue;
  const tpl = snap.schedules[key];
  let total = 0, outside = 0;
  const issues = [];
  for (const [day, x] of Object.entries(days)) {
    total += x.n;
    const win = tpl[day];
    if (!win) continue;
    if (win.off) {
      outside += x.n;
      issues.push({ day, kind: 'off', text: `template says OFF, but ${x.n} session(s) booked ${t12(x.earliest)}-${t12(x.latest)} with ${[...x.students].slice(0,4).join(', ')}${x.students.size>4?` +${x.students.size-4} more`:''}` });
      continue;
    }
    const ws = hhmm(win.start), we = hhmm(win.end);
    if (ws == null || we == null) continue;
    if (x.earliest < ws) { outside += x.n; issues.push({ day, kind: 'early', text: `template opens ${t12(ws)}, but teaches from ${t12(x.earliest)}` }); }
    if (x.latest > we)   { issues.push({ day, kind: 'late',  text: `template closes ${t12(we)}, but teaches until ${t12(x.latest)}` }); }
  }
  if (!issues.length || total < MIN_SESSIONS) continue;
  const share = outside / total;
  findings.push({ tutor, total, outside, share, issues });
}
findings.sort((a,b) => b.share - a.share || b.total - a.total);

const flagged = findings.filter(f => f.share >= MIN_SHARE || f.issues.some(i => i.kind === 'off'));
console.log(`Templates snapshot: ${snap.fetchedISO.slice(0,16).replace('T',' ')}, ${Object.keys(snap.schedules).length} tutors`);
console.log(`Tutors with a template/reality conflict: ${findings.length}  (${flagged.length} worth acting on)\n`);
for (const f of flagged) {
  console.log(`${f.tutor}  -  ${f.outside}/${f.total} upcoming sessions outside stated hours`);
  for (const i of f.issues) console.log(`   ${i.day.padEnd(9)} ${i.text}`);
  console.log('');
}

if (argv.includes('--slack')) {
  const lines = ['*A+ availability templates that do not match reality*',
    '_These matter beyond tidiness: the scheduling bot reads these templates to decide who is free, so a wrong one makes it recommend the wrong tutor and block the right one._', ''];
  for (const f of flagged.slice(0, 12)) {
    lines.push(`*${f.tutor}* (${f.outside}/${f.total} sessions outside stated hours)`);
    for (const i of f.issues) lines.push(`   • ${i.day}: ${i.text}`);
  }
  fs.writeFileSync(path.join(__dirname, '.stale-templates-slack.txt'), lines.join('\n'));
  console.log(`(slack text written to .stale-templates-slack.txt)`);
}
