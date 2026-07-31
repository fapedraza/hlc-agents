/**
 * detect-orphaned.js — sessions left behind when a tutor's availability shrinks.
 *
 * Mariah, Slack DM 2026-07-08:
 *   "Sometimes, when tutor availability/schedules change, the student session
 *    remains but the tutor is not actually available. Ryan Zand was scheduled for
 *    the 4:30pm when Katherine used to be available at that time, but now she is
 *    not (hence the dark gray)."
 *
 * WHY THIS IS CHANGE DETECTION AND NOT A STATIC CHECK
 * The obvious implementation - flag every booking outside the tutor's weekly
 * template - was built first and measured: 436 of 1604 upcoming sessions (27%)
 * fall outside their tutor's stated hours, collapsing to 45 recurring slots even
 * after excluding 13 tutors whose templates are plainly stale. That is noise, not
 * a work queue. The A+ weekly template at this center is simply not maintained;
 * orchestrate.js already compensates by treating availability as the union of the
 * template AND real bookings, precisely because "the template lags reality".
 *
 * But Mariah's case is specifically a CHANGE: availability that used to exist was
 * removed, and a booking was left stranded inside the removed window. Comparing
 * consecutive snapshots finds exactly that and nothing else, so it stays quiet
 * until something actually breaks.
 *
 * Trade-off: it cannot see sessions orphaned before snapshots began, and it needs
 * one prior snapshot before it can ever fire.
 *
 * READ-ONLY apart from its own snapshot file.
 *
 * Usage: node detect-orphaned.js [--json out.json] [--baseline]
 */
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const SR_DIR = path.join(path.join(__dirname, '..'), '..', 'schedule-request');
const { readEnv, navStaffList, listTeachers, getTeacherSchedule } = require(path.join(SR_DIR, 'lib', 'aplus.js'));
const { isNonTutor } = require(path.join(SR_DIR, 'lib', 'non-tutors.js'));

const HISTORY_CSV = path.join(SR_DIR, '.cache', 'history-report.csv');
const SNAPSHOT = path.join(path.join(__dirname, '..'), '.template-snapshot.json');
const LEGACY_CACHE = path.join(path.join(__dirname, '..'), '.cache-availability.json');

const argv = process.argv.slice(2);
const argVal = (f, d) => { const i = argv.indexOf(f); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const JSON_OUT = argVal('--json', null);
const BASELINE_ONLY = argv.includes('--baseline');

const DAYS = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
const CANCELLED = new Set(['cancelled','canceled','no-show','no show','noshow','deleted','removed','void','anm','anm - paid','anm - unpaid','absent no makeup','abs','vac']);
const norm = s => (s||'').toLowerCase().replace(/\s+/g,' ').trim();
const toks = s => new Set(((s||'').toLowerCase().match(/[a-z]+/g)) || []);
function sameTutor(a, b) {
  const A = toks(a), B = toks(b);
  if (!A.size || !B.size) return false;
  const [small, big] = A.size <= B.size ? [A, B] : [B, A];
  for (const t of small) if (!big.has(t)) return false;
  return true;
}
function parseCsv(text){ const lines=text.split(/\r?\n/).filter(Boolean);
  const split=l=>{const o=[];let c='',q=false;for(let i=0;i<l.length;i++){const ch=l[i];
    if(q){if(ch==='"'&&l[i+1]==='"'){c+='"';i++;}else if(ch==='"'){q=false;}else c+=ch;}
    else if(ch==='"'){q=true;}else if(ch===','){o.push(c);c='';}else c+=ch;} o.push(c);return o;};
  const h=split(lines[0]).map(x=>x.trim());
  return lines.slice(1).map(l=>{const r=split(l);const o={};h.forEach((k,i)=>o[k]=(r[i]||'').trim());return o;}); }
function mdyToISO(s){const m=(s||'').trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);return m?`${m[3]}-${String(m[1]).padStart(2,'0')}-${String(m[2]).padStart(2,'0')}`:null;}
function toMins(s){if(!s)return null;const m=s.trim().match(/^(\d{1,2}):?(\d{2})?\s*(am|pm)?$/i);if(!m)return null;
  let h=+m[1];const mm=+(m[2]||0);const ap=(m[3]||'').toLowerCase();
  if(ap==='pm'&&h!==12)h+=12;if(ap==='am'&&h===12)h=0;return h*60+mm;}
function durMins(s){if(!s)return 60;const t=String(s).toLowerCase();let n=0;
  const h=t.match(/([\d.]+)\s*hour/);if(h)n+=Math.round(parseFloat(h[1])*60);
  const m=t.match(/([\d.]+)\s*min/);if(m)n+=Math.round(parseFloat(m[1]));
  if(!n){const p=parseInt(t,10);if(!isNaN(p))n=p;} return n||60;}
const hhmm = s => { const m=(s||'').match(/^(\d{1,2}):(\d{2})$/); return m? +m[1]*60 + +m[2] : null; };
const fmt = m => `${String(Math.floor(m/60)).padStart(2,'0')}:${String(m%60).padStart(2,'0')}`;

/** Windows present in `before` but gone in `after`, as [start, end, why] triples. */
function removedWindows(before, after) {
  if (!before || !after) return [];
  if (before.off) return [];                       // nothing was available before
  const bs = hhmm(before.start), be = hhmm(before.end);
  if (bs == null || be == null) return [];
  if (after.off) return [[bs, be, 'day switched to OFF']];
  const as = hhmm(after.start), ae = hhmm(after.end);
  if (as == null || ae == null) return [];
  const out = [];
  if (as > bs) out.push([bs, Math.min(as, be), `start moved ${before.start} -> ${after.start}`]);
  if (ae < be) out.push([Math.max(ae, bs), be, `end moved ${before.end} -> ${after.end}`]);
  return out.filter(([s, e]) => e > s);
}

(async () => {
  // ── fetch current templates ──────────────────────────────────────────────
  const env = readEnv();
  const browser = await chromium.launch({ headless: true });
  const page = await (await browser.newContext()).newPage();
  const current = {};
  try {
    await navStaffList(page, env);
    const roster = (await listTeachers(page)).filter(t => !isNonTutor(t.lastFirst));
    process.stdout.write(`Scraping ${roster.length} tutor templates`);
    for (const t of roster) {
      try { current[t.lastFirst] = await getTeacherSchedule(page, t); process.stdout.write('.'); }
      catch { process.stdout.write('!'); }
    }
    console.log('');
  } finally { await browser.close(); }

  // ── previous snapshot ────────────────────────────────────────────────────
  let prev = null;
  if (fs.existsSync(SNAPSHOT)) prev = JSON.parse(fs.readFileSync(SNAPSHOT, 'utf8'));
  else if (fs.existsSync(LEGACY_CACHE)) {
    // Seed from the one-off availability cache so the first run has a baseline.
    const c = JSON.parse(fs.readFileSync(LEGACY_CACHE, 'utf8'));
    prev = { fetchedISO: c.fetchedISO, schedules: c.schedules };
    console.log(`(seeded baseline from ${path.basename(LEGACY_CACHE)} @ ${prev.fetchedISO.slice(0,16).replace('T',' ')})`);
  }

  const save = () => fs.writeFileSync(SNAPSHOT, JSON.stringify({ fetchedISO: new Date().toISOString(), schedules: current }, null, 2));

  if (!prev || BASELINE_ONLY) {
    save();
    console.log(`Baseline captured for ${Object.keys(current).length} tutors. Nothing to compare yet - re-run after the next change.`);
    return;
  }
  console.log(`Comparing against snapshot from ${prev.fetchedISO.slice(0,16).replace('T',' ')}\n`);

  // ── bookings that could be stranded ──────────────────────────────────────
  const today = new Date().toISOString().slice(0, 10);
  const rows = parseCsv(fs.readFileSync(HISTORY_CSV, 'utf8'));
  const future = [];
  for (const r of rows) {
    if (CANCELLED.has(norm(r['Session Status']))) continue;
    const teacher = (r['Teacher']||'').trim();
    if (!teacher || isNonTutor(teacher)) continue;
    const date = mdyToISO(r['Session Date']);
    const start = toMins(r['Start Time']);
    if (!date || start == null || date < today) continue;
    future.push({ teacher, student: (r['Student Name']||'').trim(), date, start, end: start + durMins(r['Duration']) });
  }

  // ── diff ─────────────────────────────────────────────────────────────────
  const changes = [], orphans = [];
  for (const [tutor, cur] of Object.entries(current)) {
    const beforeKey = Object.keys(prev.schedules).find(k => sameTutor(k, tutor));
    if (!beforeKey) continue;
    for (const day of DAYS) {
      const removed = removedWindows(prev.schedules[beforeKey][day], cur[day]);
      for (const [ws, we, why] of removed) {
        changes.push({ tutor, day, from: fmt(ws), to: fmt(we), why });
        const hit = future.filter(b => sameTutor(b.teacher, tutor) &&
          DAYS[new Date(b.date + 'T12:00:00').getDay()] === day &&
          b.start < we && b.end > ws);
        for (const h of hit) orphans.push({ ...h, day, why, removed: `${fmt(ws)}-${fmt(we)}` });
      }
    }
  }

  console.log(`=== AVAILABILITY REDUCTIONS SINCE LAST SNAPSHOT: ${changes.length} ===`);
  if (!changes.length) console.log('  none');
  for (const c of changes) console.log(`  ${c.tutor} - ${c.day}: lost ${c.from}-${c.to}  (${c.why})`);

  console.log(`\n=== SESSIONS STRANDED BY THOSE CHANGES: ${orphans.length} ===`);
  if (!orphans.length) console.log('  none');
  for (const o of orphans) {
    console.log(`  ${o.date} ${o.day.slice(0,3)} ${fmt(o.start)}-${fmt(o.end)}  ${o.student}  with ${o.teacher}`);
    console.log(`     tutor no longer available ${o.removed} (${o.why})`);
  }

  save();
  if (JSON_OUT) fs.writeFileSync(JSON_OUT, JSON.stringify({ generatedISO: new Date().toISOString(), changes, orphans }, null, 2));
  console.log(`\nSnapshot updated (${Object.keys(current).length} tutors).`);
})().catch(e => { console.error('failed:', e.message); process.exit(1); });
