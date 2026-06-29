/**
 * fetch-aplus.js — Headless Playwright CSV download for Appointment-Plus
 *
 * Replicates the browser flow used by the schedule-reconcile skill:
 * navigate → login if needed → select "Aplus Schedule Report" (ID 763) →
 * wait for form to refresh → set dates → click Run → wait for CSV download.
 *
 * Usage: node fetch-aplus.js <M/D/YYYY start> <M/D/YYYY end> <out.csv>
 */

const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const REPORTS_URL = 'https://account.appointment-plus.com/ap/ap_admin_v2/appointments_index_v2.php?p=reports';
const APLUS_SCHEDULE_REPORT_ID = '763';
const ENV_PATH = 'C:\\projects\\hlc-agents\\.env';

function readEnv(p) {
  if (!fs.existsSync(p)) return {};
  const out = {};
  for (const line of fs.readFileSync(p, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (m) out[m[1]] = m[2].replace(/^['"]|['"]$/g, '');
  }
  return out;
}

const [,, startMDY, endMDY, outCsv] = process.argv;
if (!startMDY || !endMDY || !outCsv) {
  console.error('Usage: node fetch-aplus.js <M/D/YYYY start> <M/D/YYYY end> <out.csv>');
  process.exit(1);
}

const env = readEnv(ENV_PATH);
if (!env.AP_USERNAME || !env.AP_PASSWORD) {
  console.error('AP_USERNAME / AP_PASSWORD missing from', ENV_PATH);
  process.exit(1);
}

(async () => {
  const t0 = Date.now();
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ acceptDownloads: true });
  const page = await context.newPage();

  try {
    await page.goto(REPORTS_URL, { waitUntil: 'domcontentloaded' });

    // Handle login if redirected
    if (page.url().includes('login.php')) {
      console.log('Logging in...');
      await page.fill('input[name="username"], input[name="user"], input[type="text"]', env.AP_USERNAME);
      await page.fill('input[name="password"], input[type="password"]', env.AP_PASSWORD);
      await Promise.all([
        page.waitForNavigation({ waitUntil: 'domcontentloaded' }),
        page.click('input[type="submit"], button[type="submit"]'),
      ]);
      if (page.url().includes('login.php')) throw new Error('Login failed — check AP_USERNAME/AP_PASSWORD');
      await page.goto(REPORTS_URL, { waitUntil: 'domcontentloaded' });
    }

    // Find slots frame
    await page.waitForSelector('frame[name="slots"]', { timeout: 15000 });
    const slotsFrame = page.frame({ name: 'slots' });
    if (!slotsFrame) throw new Error('slots frame not found');
    await slotsFrame.waitForSelector('select[name="report_id"]', { timeout: 15000 });

    // Step 1: Select the saved report, dispatch change
    await slotsFrame.evaluate((reportId) => {
      const sel = document.querySelector('select[name="report_id"]');
      sel.value = reportId;
      sel.dispatchEvent(new Event('change', { bubbles: true }));
    }, APLUS_SCHEDULE_REPORT_ID);

    // Step 2: Wait for the form to react (critical — without this, the form submits in wrong output format)
    await page.waitForTimeout(2000);

    // Step 3: Set dates
    await slotsFrame.evaluate(({ from, to }) => {
      const f = document.querySelector('#apt_date_from');
      const t = document.querySelector('#apt_date_to');
      f.value = from; t.value = to;
      f.dispatchEvent(new Event('change', { bubbles: true }));
      t.dispatchEvent(new Event('change', { bubbles: true }));
    }, { from: startMDY, to: endMDY });

    // Step 4: Click Run and wait for download
    const [download] = await Promise.all([
      page.waitForEvent('download', { timeout: 60000 }),
      slotsFrame.evaluate(() => document.querySelector('#run_the_report').click()),
    ]);

    await download.saveAs(outCsv);
    const sz = fs.statSync(outCsv).size;
    console.log(`A+: CSV ${sz} bytes in ${((Date.now() - t0) / 1000).toFixed(1)}s → ${outCsv}`);
  } finally {
    await browser.close();
  }
})().catch(err => {
  console.error('fetch-aplus.js failed:', err.message);
  process.exit(1);
});
