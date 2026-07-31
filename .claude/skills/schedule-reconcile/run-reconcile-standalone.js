/**
 * run-reconcile-standalone.js — Claude-free scheduled runner
 *
 * Pipeline:
 *   fetch-lcos.js       → lcos_raw.json
 *   parse-lcos.js       → lcos_parsed.json
 *   prewarm-history.js  → the shared A+ report cache (schedule-request/.cache)
 *   reconcile.js        → reconciliation.json
 *   write-sheet.js   → (Google Sheet update)
 *   build-payload.js → email.html + payload.json
 *   send-email.js    → (Gmail send) [skipped if --no-email]
 *
 * Usage:
 *   node run-reconcile-standalone.js [--start=YYYY-MM-DD] [--end=YYYY-MM-DD]
 *                                    [--email-to=a@b.com,c@d.com] [--no-email]
 *
 * Defaults:
 *   start = tomorrow, end = today + 7
 *   email-to = staff@huntingtonissaquah.com,riddickb@hlcmail.com
 */

const { execFileSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const SKILL_DIR = __dirname;
const WORK_DIR = path.join(SKILL_DIR, '..', '..', '..').replace(/\\/g, '/');
// The A+ side of the reconcile used to be its own report pull (fetch-aplus.js →
// aplus.csv). Report 763 gained Service/Student Notes/Teacher Type on 2026-07-30,
// so it is now the same report the scheduling pipeline already caches — one pull
// serves both. The reconcile forces it fresh, since a stale fix would surface as
// a false discrepancy, and the pipeline reuses that pull for the next 3h.
const SR_DIR = path.join(SKILL_DIR, '..', 'schedule-request');
const HISTORY_CACHE = path.join(SR_DIR, '.cache', 'history-report.csv');
const DEFAULT_RECIPIENTS = ['staff@huntingtonissaquah.com', 'riddickb@hlcmail.com'];

function parseArgs() {
  const args = { noEmail: false, noSlack: false };
  for (const a of process.argv.slice(2)) {
    if (a === '--no-email') args.noEmail = true;
    else if (a === '--no-slack') args.noSlack = true;
    else if (a.startsWith('--start=')) args.start = a.slice(8);
    else if (a.startsWith('--end=')) args.end = a.slice(6);
    else if (a.startsWith('--email-to=')) args.emailTo = a.slice(11);
    else if (a.startsWith('--slack-channel=')) args.slackChannel = a.slice(16);
  }
  return args;
}

function ymd(d) {
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}

function step(name, fn) {
  const t0 = Date.now();
  console.log(`\n--- ${name} ---`);
  try {
    fn();
    console.log(`  [${name}] done in ${((Date.now()-t0)/1000).toFixed(1)}s`);
  } catch (err) {
    console.error(`  [${name}] FAILED: ${err.message}`);
    throw err;
  }
}

function run(cmd, args) {
  execFileSync(cmd, args, { cwd: WORK_DIR, stdio: 'inherit' });
}

function main() {
  const args = parseArgs();
  const today = new Date();
  const start = args.start || ymd(new Date(today.getFullYear(), today.getMonth(), today.getDate()+1));
  const end = args.end || ymd(new Date(today.getFullYear(), today.getMonth(), today.getDate()+7));
  const recipients = args.emailTo ? args.emailTo.split(',').map(s=>s.trim()) : DEFAULT_RECIPIENTS;

  console.log(`=== schedule-reconcile standalone runner ===`);
  console.log(`Date range: ${start} → ${end}`);
  console.log(`Recipients: ${args.noEmail ? '(no email)' : recipients.join(', ')}`);
  console.log(`Slack:      ${args.noSlack ? '(no slack)' : (args.slackChannel || '(default channel from .env)')}`);
  console.log(`Work dir:   ${WORK_DIR}`);

  const lcosRaw = path.join(WORK_DIR, 'lcos_raw.json');
  const lcosParsed = path.join(WORK_DIR, 'lcos_parsed.json');
  const aplusCsv = HISTORY_CACHE;
  const reconciliation = path.join(WORK_DIR, 'reconciliation.json');
  const emailHtml = path.join(WORK_DIR, 'email.html');
  const payloadJson = path.join(WORK_DIR, 'payload.json');

  const tStart = Date.now();

  step('1/8 fetch-lcos', () =>
    run('node', [path.join(SKILL_DIR, 'fetch-lcos.js'), start, end, lcosRaw]));

  step('2/8 parse-lcos', () =>
    run('node', [path.join(SKILL_DIR, 'parse-lcos.js'), lcosRaw, lcosParsed]));

  // reconcile.js verifies the cache actually spans [start, end] before using it.
  step('3/8 fetch-aplus (shared cache)', () =>
    run('node', [path.join(SR_DIR, 'prewarm-history.js'), '--force']));

  step('4/8 reconcile', () =>
    run('node', [path.join(SKILL_DIR, 'reconcile.js'), lcosParsed, aplusCsv, start, end, reconciliation]));

  step('5/8 write-sheet', () =>
    run('node', [path.join(SKILL_DIR, 'write-sheet.js'), reconciliation, '--create-if-missing']));

  step('6/8 build-payload', () =>
    run('node', [path.join(SKILL_DIR, 'build-payload.js'), reconciliation]));

  if (args.noEmail) {
    console.log('\n--- 7/8 send-email SKIPPED (--no-email) ---');
  } else {
    step('7/8 send-email', () =>
      run('node', [path.join(SKILL_DIR, 'send-email.js'), payloadJson, emailHtml, recipients.join(',')]));
  }

  if (args.noSlack) {
    console.log('\n--- 8/8 post-slack SKIPPED (--no-slack) ---');
  } else {
    const slackArgs = [path.join(SKILL_DIR, 'post-slack.js'), reconciliation];
    if (args.slackChannel) slackArgs.push(args.slackChannel);
    step('8/8 post-slack', () => run('node', slackArgs));
  }

  const totalSec = ((Date.now() - tStart) / 1000).toFixed(1);

  // Final summary from reconciliation.json
  try {
    const recon = JSON.parse(fs.readFileSync(reconciliation, 'utf8'));
    const s = recon.stats;
    const matchRate = s.lcosActive ? Math.round(s.matched / s.lcosActive * 100) : 0;
    console.log(`\n=== DONE in ${totalSec}s ===`);
    console.log(`LCOS: ${s.lcosTotal} (${s.lcosActive} active, ${s.lcosCancelled} cancelled)`);
    console.log(`A+:   ${s.aplusTotal} (${s.aplusActive} active, ${s.aplusCancelled} cancelled)`);
    console.log(`Matched: ${s.matched} (${matchRate}% match rate)`);
    console.log(`Discrepancies: ${s.discrepancies}`);
    if (recon.typeCounts) for (const [t, c] of Object.entries(recon.typeCounts)) console.log(`  - ${t}: ${c}`);
  } catch {}
}

try { main(); } catch (err) {
  console.error(`\n=== FAILED: ${err.message} ===`);
  process.exit(1);
}
