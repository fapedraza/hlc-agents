/**
 * lib/fetch-history.js — pull the wide A+ "Aplus Schedule Report" (ID 763) for
 * student-history anchoring.
 *
 * Same report and flow the schedule-reconcile skill uses (see
 * schedule-reconcile/fetch-aplus.js), but driven over an existing authenticated
 * Playwright page and over a WIDE window (default 150 days back, 45 forward) so
 * one student's full past+upcoming pattern is captured. The report isn't
 * student-filterable server-side, so we download the whole center and let
 * student-history.js filter — acceptable for a per-request pull, but the caller
 * should cache the rows when evaluating many requests in one run.
 *
 * The page's browser context MUST have been created with `acceptDownloads: true`.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { gotoWithAuth } = require('./aplus');
const { parseAplusCsv } = require('./orchestrate');

const REPORTS_URL = 'https://account.appointment-plus.com/ap/ap_admin_v2/appointments_index_v2.php?p=reports';
const APLUS_SCHEDULE_REPORT_ID = '763';

function mdy(d) { return `${d.getMonth() + 1}/${d.getDate()}/${d.getFullYear()}`; }

/**
 * Download report 763 over [now-backDays, now+fwdDays] and return parsed rows.
 * Returns { rows, window: { start, end }, csvPath }.
 */
async function fetchScheduleReportRows(page, env, { backDays = 150, fwdDays = 45, now = new Date() } = {}) {
  const today = new Date(now); today.setHours(12, 0, 0, 0);
  const start = new Date(today); start.setDate(start.getDate() - backDays);
  const end = new Date(today); end.setDate(end.getDate() + fwdDays);

  await gotoWithAuth(page, env, REPORTS_URL);
  await page.waitForSelector('frame[name="slots"]', { timeout: 15000 });
  const slots = page.frame({ name: 'slots' });
  if (!slots) throw new Error('slots frame not found');
  await slots.waitForSelector('select[name="report_id"]', { timeout: 15000 });

  await slots.evaluate((id) => {
    const sel = document.querySelector('select[name="report_id"]');
    sel.value = id;
    sel.dispatchEvent(new Event('change', { bubbles: true }));
  }, APLUS_SCHEDULE_REPORT_ID);
  await page.waitForTimeout(2000);   // form must react before dates/format stick
  await slots.evaluate(({ from, to }) => {
    const f = document.querySelector('#apt_date_from');
    const t = document.querySelector('#apt_date_to');
    f.value = from; t.value = to;
    f.dispatchEvent(new Event('change', { bubbles: true }));
    t.dispatchEvent(new Event('change', { bubbles: true }));
  }, { from: mdy(start), to: mdy(end) });

  const [download] = await Promise.all([
    page.waitForEvent('download', { timeout: 60000 }),
    slots.evaluate(() => document.querySelector('#run_the_report').click()),
  ]);
  const csvPath = path.join(os.tmpdir(), `aplus-history-${start.getTime()}-${end.getTime()}.csv`);
  await download.saveAs(csvPath);
  const rows = parseAplusCsv(fs.readFileSync(csvPath, 'utf8'));
  return { rows, window: { start: mdy(start), end: mdy(end) }, csvPath };
}

// Default cache: sibling .cache/ dir, fresh for 3h. The report is whole-center
// and slow (~60-70s), so within a pipeline working session many requests should
// share one pull. 3h staleness is fine for the tutor-pool/duration anchor and
// still tighter than the ~24h reconcile CSV the conflict check used before.
const DEFAULT_CACHE_PATH = path.join(__dirname, '..', '.cache', 'history-report.csv');
const DEFAULT_MAX_AGE_MS = 3 * 60 * 60 * 1000;
const LOCK_SUFFIX = '.lock';
const LOCK_STALE_MS = 3 * 60 * 1000;   // a single report pull should never exceed this

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/**
 * Page-free freshness check for the cached report. Lets a caller (e.g. the
 * pipeline pre-warm) decide whether a pull is needed before launching a browser.
 * Returns { fresh, ageMs } (ageMs = Infinity when no cache file exists).
 */
function isHistoryCacheFresh({ cachePath = DEFAULT_CACHE_PATH, maxAgeMs = DEFAULT_MAX_AGE_MS, now = new Date() } = {}) {
  if (maxAgeMs > 0 && fs.existsSync(cachePath)) {
    // Clamp tiny negative ages from clock/mtime skew — a file newer than `now`
    // is definitely fresh, not stale.
    const ageMs = Math.max(0, now.getTime() - fs.statSync(cachePath).mtimeMs);
    return { fresh: ageMs < maxAgeMs, ageMs };
  }
  return { fresh: false, ageMs: Infinity };
}

// ─── pull coordination (so the detached pre-warm and a concurrent `process`
//     never double-pull, and readers never see a half-written CSV) ────────────

/** Try to take the pull lock. Steals it if the existing lock is stale. */
function acquireLock(lockPath, now = new Date()) {
  try {
    const fd = fs.openSync(lockPath, 'wx');   // exclusive create — fails if held
    fs.writeSync(fd, String(now.getTime()));
    fs.closeSync(fd);
    return true;
  } catch (e) {
    if (e.code !== 'EEXIST') throw e;
    try {
      const age = now.getTime() - fs.statSync(lockPath).mtimeMs;
      if (age > LOCK_STALE_MS) { fs.unlinkSync(lockPath); return acquireLock(lockPath, now); }
    } catch { /* lock vanished between checks — fall through and report "not held" */ }
    return false;
  }
}
function releaseLock(lockPath) { try { fs.unlinkSync(lockPath); } catch { /* already gone */ } }

/** Atomic cache write: stage a temp file in the same dir, then rename. */
function writeCacheAtomic(srcCsvPath, cachePath) {
  fs.mkdirSync(path.dirname(cachePath), { recursive: true });
  const tmp = `${cachePath}.${process.pid}.tmp`;
  fs.copyFileSync(srcCsvPath, tmp);
  fs.renameSync(tmp, cachePath);            // atomic on the same filesystem
}

function readCache(cachePath, ageMs) {
  return { rows: parseAplusCsv(fs.readFileSync(cachePath, 'utf8')), window: null, csvPath: cachePath, cached: true, ageMs };
}

async function pullAndCache(page, env, pullOpts, cachePath, lockPath) {
  try {
    const pulled = await fetchScheduleReportRows(page, env, pullOpts);
    writeCacheAtomic(pulled.csvPath, cachePath);
    return { ...pulled, csvPath: cachePath, cached: false, ageMs: 0 };
  } finally {
    releaseLock(lockPath);
  }
}

/**
 * Cached wrapper around fetchScheduleReportRows. Reuses a recent on-disk CSV
 * when younger than `maxAgeMs`; otherwise pulls fresh and rewrites the cache
 * (atomically). `maxAgeMs: 0` forces a refresh. Returns the report shape plus
 * `{ cached, ageMs }`. The caller owns the authenticated `page` (used only when
 * THIS call performs the pull).
 *
 * Concurrency-safe: a single pull lock means a detached pre-warm and a
 * simultaneous `process` run cooperate — whoever gets the lock pulls; the other
 * WAITS for that result instead of starting a second whole-center download.
 */
async function fetchScheduleReportRowsCached(page, env, {
  backDays = 150, fwdDays = 45, now = new Date(),
  cachePath = DEFAULT_CACHE_PATH, maxAgeMs = DEFAULT_MAX_AGE_MS,
} = {}) {
  const pullOpts = { backDays, fwdDays, now };
  const lockPath = cachePath + LOCK_SUFFIX;

  const f0 = isHistoryCacheFresh({ cachePath, maxAgeMs, now });
  if (f0.fresh) return readCache(cachePath, f0.ageMs);

  // Fast path: nobody else pulling → we pull.
  if (acquireLock(lockPath, now)) return pullAndCache(page, env, pullOpts, cachePath, lockPath);

  // Someone else is pulling → wait for their result rather than double-pulling.
  const deadline = Date.now() + LOCK_STALE_MS;
  while (Date.now() < deadline) {
    await sleep(2000);
    const f = isHistoryCacheFresh({ cachePath, maxAgeMs, now: new Date() });
    if (f.fresh) return readCache(cachePath, f.ageMs);
    if (!fs.existsSync(lockPath)) break;     // holder finished/died without a fresh cache
  }
  // Take over and pull ourselves (acquireLock steals a stale lock if needed).
  acquireLock(lockPath, new Date());
  return pullAndCache(page, env, pullOpts, cachePath, lockPath);
}

module.exports = { fetchScheduleReportRows, fetchScheduleReportRowsCached, isHistoryCacheFresh, DEFAULT_CACHE_PATH, DEFAULT_MAX_AGE_MS };
