/**
 * fetch-aplus-quals.js — scrape per-teacher Services Offered (sec=54) for all
 * (or a limit of) teachers in Appointment-Plus. Outputs a JSON file mapping
 * each teacher to the services they're configured to deliver.
 *
 * Output schema:
 *   {
 *     extractedAt: ISO-8601,
 *     teachersTotal: N,
 *     teachersScraped: N,
 *     teachers: [
 *       {
 *         eid, displayName, lastFirst, lastName, firstName,
 *         services: [
 *           { serviceId, name, offered, days:{Mon..Sun}, timeToComplete, cost }
 *         ]
 *       }
 *     ]
 *   }
 *
 * Usage:
 *   node fetch-aplus-quals.js [--limit N] [--out <path>] [--filter <regex>]
 */
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const { readEnv, navStaffList, listTeachers, getTeacherQuals } = require('./lib/aplus');

const SKILL_DIR = __dirname;
const DEFAULT_OUT = path.join(SKILL_DIR, 'aplus-quals.json');

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

// Per-teacher quals scraping lives in lib/aplus.js (`getTeacherQuals`) so the
// scheduling orchestrator can call it per-request without going through this
// bulk runner.

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

    console.log(`A+ quals: ${teachers.length}/${teachersTotal} teachers to scrape`);

    const results = [];
    let i = 0;
    for (const teacher of teachers) {
      i++;
      try {
        const services = await getTeacherQuals(page, teacher);
        results.push({ ...teacher, services });
        const offered = services.filter(s => s.offered).length;
        console.log(`  [${i}/${teachers.length}] ${teacher.lastFirst} — ${offered}/${services.length} services offered`);
      } catch (err) {
        console.error(`  [${i}/${teachers.length}] ${teacher.lastFirst} — ERROR: ${err.message}`);
        results.push({ ...teacher, services: [], error: err.message });
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
    console.log(`A+ quals: ${results.length} teachers in ${dt}s → ${args.out}`);
  } finally {
    await browser.close();
  }
})().catch(err => {
  console.error('fetch-aplus-quals.js failed:', err.stack || err.message || String(err));
  process.exit(1);
});
