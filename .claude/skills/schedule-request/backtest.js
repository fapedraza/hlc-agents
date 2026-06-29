/**
 * backtest.js — batch replay of historical scheduling threads.
 *
 * Replays a directory of case payloads through the Phase-1 orchestrator in
 * back-test mode and compares each recommendation against what staff actually
 * did (the student's existing A+ booking at the proposed slot = ground truth).
 *
 * Unlike demo-orchestrate.js (one request, one browser), this opens ONE
 * authenticated A+ session for the whole run and memoizes each tutor's
 * quals/schedule scrape across cases — so replaying 20 threads that share a
 * handful of tutors costs only a handful of scrapes.
 *
 * Case files: cases/<name>.json — a request payload (same shape as
 * demo-pelita.payload.json), optionally with `expected` (regression
 * assertions) and `groundTruthCsv` (a frozen booking snapshot):
 *
 *   {
 *     "contactName": "...", "requestType": "...", "subject": "...",
 *     "proposedDate": "2026-05-27", "proposedTime": "7:30pm",
 *     "sessionLength": "1 hour", "candidateTutors": ["Tim"],
 *     "groundTruthCsv": "fixtures/2026-05-22.csv",
 *     "expected": { "verdict": "match", "action": "PROCEED", "tutor": "Tim" }
 *   }
 *
 * `expected` is optional. Any subset of {verdict, action, tutor} is checked;
 * a case with no `expected` is informational (counted, never fails the run).
 *
 * GROUND TRUTH & THE LIVE CSV. The verdict (match / mismatch) is derived from
 * the student's existing A+ booking at the proposed slot. That booking lives
 * in the schedule-reconcile CSV — which only covers a rolling ~1-week window,
 * so once a case's date passes it ages out and the verdict degrades to
 * "no-ground-truth". For a reproducible verdict, pin a `groundTruthCsv`
 * snapshot (relative to the cases dir) captured when the thread was resolved.
 * Without one, the case falls back to the live CSV and you should assert only
 * the agent's *decision* (action/tutor), which stays reproducible against
 * live A+ quals + availability.
 *
 * Usage:
 *   node backtest.js [casesDir] [--out <report.json>] [--results-dir <dir>]
 *
 * Exit code = number of cases whose expectations failed (0 = all good).
 */
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const { readEnv, navStaffList, listTeachers } = require('./lib/aplus');
const { orchestrateOne, loadRoster, loadAplusCsv, parseAplusCsv, APLUS_CSV_PATH } = require('./lib/orchestrate');

const SKILL_DIR = __dirname;

function parseArgs(argv) {
  const a = { casesDir: path.join(SKILL_DIR, 'cases'), out: null, resultsDir: null };
  for (let i = 0; i < argv.length; i++) {
    const v = argv[i];
    if (v === '--out') a.out = argv[++i];
    else if (v.startsWith('--out=')) a.out = v.slice(6);
    else if (v === '--results-dir') a.resultsDir = argv[++i];
    else if (v.startsWith('--results-dir=')) a.resultsDir = v.slice(14);
    else if (!v.startsWith('--')) a.casesDir = v;
  }
  if (!a.out) a.out = path.join(SKILL_DIR, 'backtest-report.json');
  if (!a.resultsDir) a.resultsDir = path.join(SKILL_DIR, 'backtest-results');
  return a;
}

function loadCases(dir) {
  if (!fs.existsSync(dir)) {
    throw new Error(`Cases directory not found: ${dir}. Create it and add <name>.json payload files.`);
  }
  return fs.readdirSync(dir)
    .filter(f => f.endsWith('.json'))
    .sort()
    .map(f => {
      const raw = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
      const { expected, groundTruthCsv, ...payload } = raw;
      return {
        id: f.replace(/\.json$/, ''),
        payload,
        expected: expected || null,
        groundTruthCsv: groundTruthCsv || null,
      };
    });
}

/**
 * Resolve a case's booking CSV: a pinned `groundTruthCsv` fixture (frozen
 * snapshot) if set, otherwise the live reconcile CSV. Cached per path so a
 * shared fixture is read once.
 */
function csvForCase(c, casesDir, liveCsv, fixtureCache) {
  if (!c.groundTruthCsv) return liveCsv;
  const p = path.isAbsolute(c.groundTruthCsv) ? c.groundTruthCsv : path.join(casesDir, c.groundTruthCsv);
  if (fixtureCache.has(p)) return fixtureCache.get(p);
  if (!fs.existsSync(p)) {
    console.warn(`  ! groundTruthCsv fixture not found: ${p} — falling back to live CSV`);
    fixtureCache.set(p, liveCsv);
    return liveCsv;
  }
  const loaded = { csvRows: parseAplusCsv(fs.readFileSync(p, 'utf8')), csvAvailable: true, fixture: p };
  fixtureCache.set(p, loaded);
  return loaded;
}

/** Friendly short name for a tutor "Corrie, Tim (Tim)" → "Tim"; tolerant compare. */
function tutorMatchesExpected(predictedLastFirst, expectedTutor) {
  if (!expectedTutor) return true;
  if (!predictedLastFirst) return false;
  const p = predictedLastFirst.toLowerCase();
  const e = expectedTutor.toLowerCase();
  return p.includes(e) || e.includes(p.split(',')[0]); // last-name or display-name match
}

/** Evaluate a case's `expected` block against the recommendation. */
function checkExpectations(expected, recommendation) {
  if (!expected) return { hasExpect: false, pass: true, failures: [] };
  const failures = [];
  const rec = recommendation.recommended || {};
  const cmp = recommendation.comparison || {};
  const predictedTutor = rec.tutor || (rec.tutors && rec.tutors[0]) || null;

  if (expected.verdict && cmp.matchVerdict !== expected.verdict) {
    failures.push(`verdict: expected "${expected.verdict}", got "${cmp.matchVerdict}"`);
  }
  if (expected.action && rec.action !== expected.action) {
    failures.push(`action: expected "${expected.action}", got "${rec.action}"`);
  }
  if (expected.tutor && !tutorMatchesExpected(predictedTutor, expected.tutor)) {
    failures.push(`tutor: expected "${expected.tutor}", got "${predictedTutor || '(none)'}"`);
  }
  return { hasExpect: true, pass: failures.length === 0, failures };
}

(async () => {
  const args = parseArgs(process.argv.slice(2));
  const env = readEnv();
  const roster = loadRoster();
  const cases = loadCases(args.casesDir);
  if (!cases.length) {
    console.error(`No case files in ${args.casesDir}. Add <name>.json payload files.`);
    process.exit(1);
  }
  const liveCsv = loadAplusCsv();
  console.log(`Back-test: ${cases.length} case(s) from ${args.casesDir}`);
  console.log(liveCsv.csvAvailable
    ? `[csv] live: ${liveCsv.csvRows.length} booked-appointment rows from ${APLUS_CSV_PATH}`
    : `[csv] live CSV not found at ${APLUS_CSV_PATH} — cases without a groundTruthCsv fixture get "no-ground-truth".`);

  fs.mkdirSync(args.resultsDir, { recursive: true });

  const caches = { quals: new Map(), schedule: new Map() };
  const fixtureCache = new Map();
  const results = [];

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  const page = await context.newPage();
  try {
    await navStaffList(page, env);
    const teachers = await listTeachers(page);
    console.log(`[a+] ${teachers.length} teachers in roster; session ready.\n`);

    for (const c of cases) {
      process.stdout.write(`▶ ${c.id} … `);
      try {
        const csv = csvForCase(c, args.casesDir, liveCsv, fixtureCache);
        const out = await orchestrateOne({
          payload: c.payload, page, teachers, roster,
          csvRows: csv.csvRows, csvAvailable: csv.csvAvailable,
          backtest: true, caches, log: () => {},
        });
        if (out.skipped) {
          console.log(`skipped (${out.skipped})`);
          results.push({ id: c.id, skipped: out.skipped, expected: c.expected });
          continue;
        }
        const rec = out.recommendation;
        const verdict = rec.comparison?.matchVerdict || 'n/a';
        const action = rec.recommended?.action;
        const predicted = rec.recommended?.tutor || (rec.recommended?.tutors || []).join('/') || '—';
        const check = checkExpectations(c.expected, rec);

        const tag = !check.hasExpect ? '·' : (check.pass ? '✓' : '✗');
        console.log(`${tag} ${verdict}  [${action} → ${predicted}]${check.pass ? '' : '  FAIL: ' + check.failures.join('; ')}`);

        fs.writeFileSync(path.join(args.resultsDir, `${c.id}.json`), JSON.stringify(rec, null, 2));
        results.push({
          id: c.id,
          verdict, action, predictedTutor: predicted,
          csvSource: csv.fixture ? path.basename(csv.fixture) : 'live',
          expected: c.expected,
          check: { hasExpect: check.hasExpect, pass: check.pass, failures: check.failures },
        });
      } catch (err) {
        console.log(`ERROR: ${err.message}`);
        results.push({ id: c.id, error: err.message, expected: c.expected });
      }
    }
  } finally {
    await browser.close();
  }

  // ─── aggregate ─────────────────────────────────────────────────────────────
  const verdictCounts = {};
  for (const r of results) {
    const key = r.error ? 'error' : r.skipped ? 'skipped' : (r.verdict || 'n/a');
    verdictCounts[key] = (verdictCounts[key] || 0) + 1;
  }
  const expected = results.filter(r => r.check?.hasExpect);
  const passed = expected.filter(r => r.check.pass);
  const failed = expected.filter(r => !r.check.pass);

  const report = {
    ranAt: new Date().toISOString(),
    casesDir: args.casesDir,
    total: results.length,
    liveCsvAvailable: liveCsv.csvAvailable,
    verdictCounts,
    assertions: { withExpected: expected.length, passed: passed.length, failed: failed.length },
    failures: failed.map(r => ({ id: r.id, failures: r.check.failures })),
    results,
  };
  fs.writeFileSync(args.out, JSON.stringify(report, null, 2));

  console.log('\n─── Summary ───────────────────────────────');
  console.log(`Cases:    ${results.length}`);
  console.log(`Verdicts: ${Object.entries(verdictCounts).map(([k, v]) => `${k}=${v}`).join('  ')}`);
  console.log(`Asserts:  ${passed.length}/${expected.length} passed${failed.length ? `, ${failed.length} FAILED` : ''}`);
  for (const r of failed) console.log(`  ✗ ${r.id}: ${r.check.failures.join('; ')}`);
  console.log(`\nReport  → ${args.out}`);
  console.log(`Results → ${args.resultsDir}/<case>.json`);

  process.exit(failed.length);
})().catch(err => {
  console.error('backtest.js failed:', err.stack || err.message || String(err));
  process.exit(1);
});
