/**
 * prewarm-history.js — warm the student-history report cache.
 *
 * The scheduling-pipeline's `pending` step calls this when new threads arrive so
 * the ~60-70s whole-center A+ Schedule Report pull is paid up front (once per
 * cache window) instead of by the first `process` run. If the cache is already
 * fresh, it short-circuits WITHOUT launching a browser.
 *
 * All output goes to stderr so callers can run it without disturbing their
 * stdout (e.g. pipeline `pending` prints JSON on stdout).
 *
 * Usage:
 *   node prewarm-history.js [--force]
 *   SR_HISTORY_CACHE_MIN=180 node prewarm-history.js
 *
 * Exit 0 whether warmed or already fresh; exit 1 only on an unexpected error.
 */
const { chromium } = require('playwright');
const { readEnv } = require('./lib/aplus');
const { fetchScheduleReportRowsCached, isHistoryCacheFresh, DEFAULT_MAX_AGE_MS } = require('./lib/fetch-history');

function maxAgeMs() {
  if (process.argv.includes('--force')) return 0;
  const min = parseInt(process.env.SR_HISTORY_CACHE_MIN, 10);
  return Number.isFinite(min) ? min * 60 * 1000 : DEFAULT_MAX_AGE_MS;
}

(async () => {
  const max = maxAgeMs();
  const fresh = isHistoryCacheFresh({ maxAgeMs: max });
  if (fresh.fresh) {
    console.error(`[prewarm] cache warm (age ${Math.round(fresh.ageMs / 60000)}m) — no pull needed`);
    return;
  }

  const env = readEnv();
  if (!env.AP_USERNAME || !env.AP_PASSWORD) {
    console.error('[prewarm] AP_USERNAME / AP_PASSWORD missing — skipping (process will fall back).');
    return;   // best-effort: don't fail the caller
  }

  console.error('[prewarm] cache cold — pulling wide A+ schedule report…');
  const t0 = Date.now();
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ acceptDownloads: true });
  const page = await context.newPage();
  try {
    const { rows, window } = await fetchScheduleReportRowsCached(page, env, { maxAgeMs: max });
    console.error(`[prewarm] cached ${rows.length} rows ${window ? window.start + '–' + window.end : ''} in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  } finally {
    await browser.close();
  }
})().catch(e => { console.error('[prewarm] failed:', e.message); process.exit(1); });
