/**
 * fetch-aplus-availability.js — scrape each teacher's weekly working-hours
 * template (sec=2 "Schedule") from Appointment-Plus.
 *
 * The Schedule page has 7 day rows. Each row has:
 *   - off_<Day>             checkbox  (off if checked)
 *   - first_appt_time_<Day> select    (start time, e.g. "10:00am")
 *   - last_appt_time_<Day>  select    (end   time, e.g. "8:30pm")
 *
 * Times are normalized to 24h HH:MM. Days flagged "off" emit start/end = null.
 *
 * Date-specific overrides (Days Off, Schedule Exceptions) are NOT yet captured
 * — open items in PLAN.md.
 *
 * Usage:
 *   node fetch-aplus-availability.js [--limit N] [--out <path>] [--filter <regex>]
 */
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const { readEnv, navStaffList, listTeachers, getTeacherSchedule } = require('./lib/aplus');

const SKILL_DIR = __dirname;
const DEFAULT_OUT = path.join(SKILL_DIR, 'aplus-availability.json');
const DAYS = ['Monday','Tuesday','Wednesday','Thursday','Friday','Saturday','Sunday'];

function parseArgs(argv) {
  const a = { limit: null, out: DEFAULT_OUT, filter: null };
  for (let i = 0; i < argv.length; i++) {
    const v = argv[i];
    if (v === '--limit')        a.limit = parseInt(argv[++i], 10);
    else if (v.startsWith('--limit=')) a.limit = parseInt(v.slice(8), 10);
    else if (v === '--out')     a.out = argv[++i];
    else if (v.startsWith('--out='))   a.out = v.slice(6);
    else if (v === '--filter')  a.filter = new RegExp(argv[++i], 'i');
    else if (v.startsWith('--filter=')) a.filter = new RegExp(v.slice(9), 'i');
  }
  return a;
}

// Per-teacher schedule scraping + time normalization live in lib/aplus.js
// (`getTeacherSchedule`, `normalizeApTime`) so the scheduling orchestrator can
// call them per-request without going through this bulk runner.

(async () => {
  const args = parseArgs(process.argv.slice(2));
  const env = readEnv();
  const t0 = Date.now();

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  const page = await context.newPage();

  try {
    await navStaffList(page, env);
    let teachers = await listTeachers(page);
    if (args.filter) teachers = teachers.filter(t => args.filter.test(t.lastFirst));
    const teachersTotal = teachers.length;
    if (args.limit) teachers = teachers.slice(0, args.limit);

    console.log(`A+ availability: ${teachers.length}/${teachersTotal} teachers to scrape`);

    const results = [];
    let i = 0;
    for (const teacher of teachers) {
      i++;
      try {
        const weekly = await getTeacherSchedule(page, teacher);
        let workingDays = 0;
        for (const day of DAYS) if (weekly[day] && !weekly[day].off) workingDays++;
        results.push({ ...teacher, weekly });
        const range = DAYS.map(d => {
          const w = weekly[d]; if (!w || w.off) return 'off';
          return `${w.start}-${w.end}`;
        }).join(' / ');
        console.log(`  [${i}/${teachers.length}] ${teacher.lastFirst} — ${workingDays} working days  (${range})`);
      } catch (err) {
        console.error(`  [${i}/${teachers.length}] ${teacher.lastFirst} — ERROR: ${err.message}`);
        results.push({ ...teacher, weekly: null, error: err.message });
      }
    }

    const out = {
      extractedAt: new Date().toISOString(),
      teachersTotal,
      teachersScraped: results.length,
      teachers: results,
    };
    fs.writeFileSync(args.out, JSON.stringify(out, null, 2));
    const dt = ((Date.now() - t0) / 1000).toFixed(1);
    console.log(`A+ availability: ${results.length} teachers in ${dt}s → ${args.out}`);
  } finally {
    await browser.close();
  }
})().catch(err => {
  console.error('fetch-aplus-availability.js failed:', err.stack || err.message || String(err));
  process.exit(1);
});
