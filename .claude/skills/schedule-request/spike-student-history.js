/**
 * spike-student-history.js — SPIKE: per-student A+ session history.
 *
 * Mariah's insight: the bot guesses subject/tutor/duration instead of anchoring
 * on what the student ACTUALLY does. The A+ "Aplus Schedule Report" (ID 763)
 * covers any date range — past AND upcoming — so a wide window, filtered to one
 * student, yields their real tutor(s), durations, and day/time pattern.
 *
 * This is a throwaway probe to confirm the signal is clean before we re-anchor
 * orchestrate.js on it. It does NOT change the recommendation pipeline.
 *
 * Usage:
 *   node spike-student-history.js "Sathvik Movva" [backDays] [fwdDays]
 *
 * Reuses the report-763 download flow from
 * schedule-reconcile/fetch-aplus.js and the CSV parser from lib/orchestrate.js.
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const { chromium } = require('playwright');
const { parseAplusCsv } = require('./lib/orchestrate');

const REPORTS_URL = 'https://account.appointment-plus.com/ap/ap_admin_v2/appointments_index_v2.php?p=reports';
const APLUS_SCHEDULE_REPORT_ID = '763';
const ENV_PATH = 'C:\\projects\\hlc-agents\\.env';

const CANCEL_STATUSES = new Set([
  'cancelled','canceled','no-show','no show','noshow','deleted','removed','void',
  'anm','anm - paid','anm - unpaid','absent no makeup','abs','vac',
]);

function readEnv(p = ENV_PATH) {
  if (!fs.existsSync(p)) return {};
  const out = {};
  for (const line of fs.readFileSync(p, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (m) out[m[1]] = m[2].replace(/^['"]|['"]$/g, '');
  }
  return out;
}

function mdy(d) {
  return `${d.getMonth() + 1}/${d.getDate()}/${d.getFullYear()}`;
}
/** "6/26/2026" -> Date (local noon to dodge DST edges). */
function parseMDY(s) {
  const m = (s || '').trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (!m) return null;
  return new Date(+m[3], +m[1] - 1, +m[2], 12, 0, 0);
}
const DOW = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];

async function downloadReport(startMDY, endMDY, outCsv) {
  const env = readEnv();
  if (!env.AP_USERNAME || !env.AP_PASSWORD) throw new Error('AP_USERNAME / AP_PASSWORD missing from ' + ENV_PATH);
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ acceptDownloads: true });
  const page = await context.newPage();
  try {
    await page.goto(REPORTS_URL, { waitUntil: 'domcontentloaded' });
    if (page.url().includes('login.php')) {
      await page.fill('input[name="username"], input[name="user"], input[type="text"]', env.AP_USERNAME);
      await page.fill('input[name="password"], input[type="password"]', env.AP_PASSWORD);
      await Promise.all([
        page.waitForNavigation({ waitUntil: 'domcontentloaded' }),
        page.click('input[type="submit"], button[type="submit"]'),
      ]);
      if (page.url().includes('login.php')) throw new Error('A+ login failed');
      await page.goto(REPORTS_URL, { waitUntil: 'domcontentloaded' });
    }
    await page.waitForSelector('frame[name="slots"]', { timeout: 15000 });
    const slots = page.frame({ name: 'slots' });
    if (!slots) throw new Error('slots frame not found');
    await slots.waitForSelector('select[name="report_id"]', { timeout: 15000 });
    await slots.evaluate((id) => {
      const sel = document.querySelector('select[name="report_id"]');
      sel.value = id;
      sel.dispatchEvent(new Event('change', { bubbles: true }));
    }, APLUS_SCHEDULE_REPORT_ID);
    await page.waitForTimeout(2000);
    await slots.evaluate(({ from, to }) => {
      const f = document.querySelector('#apt_date_from');
      const t = document.querySelector('#apt_date_to');
      f.value = from; t.value = to;
      f.dispatchEvent(new Event('change', { bubbles: true }));
      t.dispatchEvent(new Event('change', { bubbles: true }));
    }, { from: startMDY, to: endMDY });
    const [download] = await Promise.all([
      page.waitForEvent('download', { timeout: 60000 }),
      slots.evaluate(() => document.querySelector('#run_the_report').click()),
    ]);
    await download.saveAs(outCsv);
    return fs.statSync(outCsv).size;
  } finally {
    await browser.close();
  }
}

/** Filter report rows to one student and summarize their real pattern. */
function summarize(rows, studentName, today) {
  const want = studentName.toLowerCase().replace(/\s+/g, ' ').trim();
  const mine = rows.filter(r => (r['Student Name'] || '').toLowerCase().replace(/\s+/g, ' ').trim() === want);

  const tutors = new Map();   // tutor -> { active, cancelled, durations:Set, dows:Set, times:Set, last, next }
  const durations = new Map(); // duration -> count (active only)
  for (const r of mine) {
    const tutor = (r['Teacher'] || '').trim() || '(none)';
    const status = (r['Session Status'] || '').toLowerCase().trim();
    const cancelled = CANCEL_STATUSES.has(status);
    const d = parseMDY(r['Session Date']);
    const dur = (r['Duration'] || '').trim();
    const time = (r['Start Time'] || '').trim();

    if (!tutors.has(tutor)) tutors.set(tutor, { active: 0, cancelled: 0, durations: new Set(), dows: new Set(), times: new Set(), last: null, next: null });
    const t = tutors.get(tutor);
    if (cancelled) { t.cancelled++; continue; }   // ignore cancelled for the pattern signal
    t.active++;
    if (dur) { t.durations.add(dur); durations.set(dur, (durations.get(dur) || 0) + 1); }
    if (d) t.dows.add(DOW[d.getDay()]);
    if (time) t.times.add(time);
    if (d) {
      if (d <= today) { if (!t.last || d > t.last) t.last = d; }
      else            { if (!t.next || d < t.next) t.next = d; }
    }
  }

  const tutorRows = [...tutors.entries()]
    .map(([name, t]) => ({
      tutor: name,
      activeSessions: t.active,
      cancelled: t.cancelled,
      durations: [...t.durations],
      days: [...t.dows],
      times: [...t.times],
      lastSeen: t.last ? mdy(t.last) : null,
      nextScheduled: t.next ? mdy(t.next) : null,
    }))
    .filter(t => t.activeSessions > 0)
    .sort((a, b) => b.activeSessions - a.activeSessions);

  return {
    student: studentName,
    totalRows: mine.length,
    activeRows: mine.length - mine.filter(r => CANCEL_STATUSES.has((r['Session Status'] || '').toLowerCase().trim())).length,
    primaryTutor: tutorRows[0]?.tutor || null,
    tutors: tutorRows,
    durationsSeen: [...durations.entries()].sort((a, b) => b[1] - a[1]).map(([d, n]) => ({ duration: d, count: n })),
  };
}

(async () => {
  const [,, student, backDaysArg, fwdDaysArg] = process.argv;
  if (!student) { console.error('Usage: node spike-student-history.js "First Last" [backDays] [fwdDays]'); process.exit(1); }
  const backDays = parseInt(backDaysArg, 10) || 150;
  const fwdDays = parseInt(fwdDaysArg, 10) || 45;

  const today = new Date(); today.setHours(12, 0, 0, 0);
  const start = new Date(today); start.setDate(start.getDate() - backDays);
  const end = new Date(today); end.setDate(end.getDate() + fwdDays);

  const outCsv = path.join(os.tmpdir(), `aplus-history-${Date.now()}.csv`);
  console.error(`[spike] pulling report ${APLUS_SCHEDULE_REPORT_ID} ${mdy(start)} → ${mdy(end)} ...`);
  const t0 = Date.now();
  const sz = await downloadReport(mdy(start), mdy(end), outCsv);
  console.error(`[spike] CSV ${sz} bytes in ${((Date.now() - t0) / 1000).toFixed(1)}s`);

  const rows = parseAplusCsv(fs.readFileSync(outCsv, 'utf8'));
  console.error(`[spike] ${rows.length} total report rows`);
  const summary = summarize(rows, student, today);
  console.log(JSON.stringify(summary, null, 2));
})().catch(err => { console.error('spike failed:', err.message); process.exit(1); });
