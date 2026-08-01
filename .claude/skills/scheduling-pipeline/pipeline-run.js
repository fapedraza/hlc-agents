/**
 * pipeline-run.js — Piece 1 of the scheduling pipeline (auto-recommend).
 *
 * Deterministic scaffolding around the one LLM step (classification). The
 * always-on Claude session drives the loop:
 *
 *   1) node pipeline-run.js pending
 *        Fetch current unresolved-inbound from Text Request (v3 API), register
 *        any NOT already in pipeline-state as `new`, and print each new thread
 *        so Claude can classify it.
 *   2) Claude classifies each `new` thread → writes a payload JSON, then:
 *        node pipeline-run.js process <payload.json> [--dry-run]
 *          → run schedule-request (live A+) → post to #scheduling → record
 *            the record as `recommended`.
 *      or, if it isn't a schedulable request:
 *        node pipeline-run.js skip <hash> "<reason>"
 *   3) node poll-decisions.js   (Piece 2 — capture staff decisions)
 *
 * A payload is the schedule-request payload PLUS the `hash` of the TR
 * conversation it came from (so process can update the right state record).
 *
 * Usage:
 *   node pipeline-run.js pending [--no-fetch]
 *   node pipeline-run.js process <payload.json> [--dry-run]
 *   node pipeline-run.js skip <hash> "<reason>"
 *   node pipeline-run.js status
 */
const fs = require('fs');
const path = require('path');
const { execFileSync, spawn } = require('child_process');
const state = require('./lib/pipeline-state');

const SKILL_DIR = __dirname;
const TR_DIR = path.join(SKILL_DIR, '..', 'text-request-read');
const SR_DIR = path.join(SKILL_DIR, '..', 'schedule-request');
const MESSAGES_PATH = path.join(TR_DIR, 'messages.json');
const REC_DIR = path.join(SKILL_DIR, 'recommendations');
const CHANNEL = 'CMR1PPZ9B';
// How many times `process` may fail on one record before it stops being retried
// and lands in `error` for a human to look at.
const MAX_PROCESS_ATTEMPTS = 3;

const node = process.execPath;
const run = (script, args, opts = {}) =>
  execFileSync(node, [script, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...opts });

/**
 * Text Request thread timestamps are UTC but carry NO 'Z' ("2026-08-01T01:58:10.623"),
 * while our own record fields are proper ISO with one. Comparing them raw reads the
 * TR side as local time and shifts it by the UTC offset — the same mistake that
 * corrupted the latency measurements and then the outcome verdicts. Normalise first.
 */
function trTime(v) {
  const s = String(v || '');
  if (!s) return null;
  const d = new Date(/(?:Z|[+-]\d\d:?\d\d)$/.test(s) ? s : s + 'Z');
  return isNaN(d) ? null : d;
}

/** Newest INBOUND message in a conversation, as a Date (customer messages only). */
function latestInboundAt(conv) {
  return ((conv && conv.thread) || [])
    .filter(t => t.direction === 'inbound')
    .map(t => trTime(t.timestamp))
    .filter(Boolean)
    .sort((a, b) => b - a)[0] || null;
}

/** The most recently touched record for a phone (records are 1:1 with phones today). */
function recordForPhone(st, phone) {
  return Object.values(st.requests || {})
    .filter(r => r.phone === phone)
    .sort((a, b) => String(b.lastUpdateISO).localeCompare(String(a.lastUpdateISO)))[0] || null;
}

// ─── pending: fetch new TR inbound, register, print threads to classify ──────
function cmdPending(argv) {
  const DRY_RUN = argv.includes('--dry-run');
  const noFetch = argv.includes('--no-fetch');
  if (!noFetch) {
    process.stderr.write('[pending] fetching current unresolved-inbound from Text Request…\n');
    run(path.join(TR_DIR, 'fetch-textrequest-api.js'), ['--full']);
  }
  if (!fs.existsSync(MESSAGES_PATH)) {
    console.error(`messages.json not found at ${MESSAGES_PATH} — run the TR fetch first.`);
    process.exit(1);
  }
  const msgs = JSON.parse(fs.readFileSync(MESSAGES_PATH, 'utf8'));
  const conversations = msgs.newMessages || [];
  const byPhone = {};
  for (const m of conversations) byPhone[m.phone] = m; // latest message per conversation

  const st = state.load();
  // Dedup by CONVERSATION (phone): register a new record only for a phone that
  // isn't tracked yet. A follow-up text (new message_id) on an already-tracked
  // conversation must NOT spawn a duplicate recommendation.
  for (const m of conversations) {
    if (!state.hasPhone(st, m.phone)) {
      state.add(st, { hash: m.hash, phone: m.phone, contactName: m.contactName, threadId: m.threadId });
    }
  }

  // …but that dedup used to be PERMANENT, and that was the bug. Nothing ever put
  // a record back to `new`, so once a family had any record at all, every FUTURE
  // ask from them was invisible forever. On 2026-08-01 all 182 tracked phones were
  // terminal and 0 records sat at `new`: the bot could only ever answer a family's
  // first-ever conversation. Helen Louie asked for a session on 8/4 and got nothing
  // because her record had been closed since 2026-06-08.
  //
  // Reopen when inbound arrives that is newer than the newest message the
  // classifier has already been shown (`handledInboundISO`, stamped below). That
  // keeps the original guarantee — a follow-up on the SAME ask cannot spawn a
  // duplicate, because that message was already in what we showed it.
  const reopened = [];
  for (const m of conversations) {
    const rec = recordForPhone(st, m.phone);
    if (!rec || rec.status === 'new') continue;
    const latest = latestInboundAt(m);
    if (!latest) continue;
    // Fall back to lastUpdateISO for records predating handledInboundISO: the
    // inbound that triggered their recommendation is older than that action, so
    // legacy records do not all reopen at once.
    const seen = trTime(rec.handledInboundISO) || new Date(rec.lastUpdateISO);
    if (!(latest > seen)) continue;
    reopened.push({ name: rec.contactName || rec.phone, was: rec.status, at: latest.toISOString() });
    if (!DRY_RUN) state.update(st, rec.hash, { status: 'new', reopenedISO: state.nowISO() });
  }
  if (reopened.length) {
    process.stderr.write(`[pending] reopened ${reopened.length} conversation(s) with new inbound since we last looked:\n`);
    for (const r of reopened) process.stderr.write(`  - ${r.name} (was ${r.was}; new message ${r.at})\n`);
  }
  if (DRY_RUN) {
    process.stderr.write('[pending] --dry-run: nothing written, nothing will be classified or posted.\n');
    console.log(JSON.stringify({ dryRun: true, wouldReopen: reopened }, null, 2));
    return;
  }
  state.save(st);

  // Output EVERY record still needing classification (status `new`) — including
  // ones registered in a prior pass — with the LATEST thread (looked up by
  // phone, since the hash changes as new messages arrive). Records whose
  // conversation is no longer in the live queue come through inQueue:false (no
  // thread) so the classifier skips them as resolved/gone.
  const todo = state.withStatus(st, 'new');

  // Record how much of each conversation the classifier is about to be shown. This
  // is the high-water mark the reopen check above compares against, so it must be
  // stamped HERE - at the moment we hand the thread over - and not when the record
  // is later actioned. Anything that arrives after this point is genuinely new and
  // will reopen the record; anything at or before it has already been considered.
  for (const r of todo) {
    const latest = latestInboundAt(byPhone[r.phone]);
    if (latest) state.update(st, r.hash, { handledInboundISO: latest.toISOString() });
  }
  state.save(st);

  // Pre-warm the schedule-request history cache when there's work to classify,
  // so the first `process` run doesn't eat the ~60-70s whole-center report pull.
  // DETACHED background pull: `pending` returns immediately (Claude can classify
  // while the report downloads). The pull holds a lock so a concurrent `process`
  // waits for its result instead of double-pulling (see lib/fetch-history.js).
  // prewarm short-circuits instantly when the cache is already fresh.
  if (todo.length > 0) {
    try {
      const cacheDir = path.join(SR_DIR, '.cache');
      fs.mkdirSync(cacheDir, { recursive: true });
      const logFd = fs.openSync(path.join(cacheDir, 'prewarm.log'), 'a');
      const child = spawn(node, [path.join(SR_DIR, 'prewarm-history.js')],
        { detached: true, stdio: ['ignore', logFd, logFd] });
      child.unref();
      fs.closeSync(logFd);
      process.stderr.write(`[pending] history pre-warm launched in background (pid ${child.pid})\n`);
    } catch (e) {
      process.stderr.write(`[pending] pre-warm launch failed (non-fatal): ${e.message}\n`);
    }
  }

  const out = todo.map(r => {
    const m = byPhone[r.phone];
    return {
      hash: r.hash,
      contactName: r.contactName,
      phone: r.phone,
      inQueue: !!m,
      lastMessage: m ? m.snippet : null,
      thread: m ? (m.thread || []).map(t => ({ who: t.direction === 'inbound' ? 'customer' : (t.staffName || 'staff'), text: t.text, ts: t.timestamp })) : [],
    };
  });
  console.log(JSON.stringify({ newCount: todo.length, totalUnresolvedInbound: conversations.length, pending: out }, null, 2));
  process.stderr.write(`[pending] ${todo.length} to classify (of ${conversations.length} unresolved conversations). State: ${JSON.stringify(state.summary(st))}\n`);
}

// ─── process: classified payload → recommendation → Slack → state ────────────
function cmdProcess(argv) {
  // Env toggle lets the always-on service run a no-post shakedown (drafts +
  // previews only) before going live. Set SCHEDULING_PIPELINE_DRYRUN=1.
  const dryRun = argv.includes('--dry-run') || process.env.SCHEDULING_PIPELINE_DRYRUN === '1';
  const payloadPath = argv.find(a => !a.startsWith('--'));
  if (!payloadPath) { console.error('Usage: pipeline-run.js process <payload.json> [--dry-run]'); process.exit(1); }
  const payload = JSON.parse(fs.readFileSync(payloadPath, 'utf8'));
  if (!payload.hash) { console.error('payload is missing "hash" (the TR conversation hash from `pending`).'); process.exit(1); }

  const st = state.load();
  if (!state.has(st, payload.hash)) {
    console.error(`hash ${payload.hash} not in pipeline-state — run \`pending\` first (or it was already processed).`);
    process.exit(1);
  }
  const { hash, ...classification } = payload;
  state.update(st, hash, { status: 'classified', classification });
  state.save(st);

  try {
    fs.mkdirSync(REC_DIR, { recursive: true });
    const recFile = path.join(REC_DIR, `${hash}.json`);
    process.stderr.write(`[process] running schedule-request (live A+) for ${payload.contactName}…\n`);
    run(path.join(SR_DIR, 'demo-orchestrate.js'), [payloadPath, '--out', recFile], { stdio: ['ignore', 'inherit', 'inherit'] });
    const rec = JSON.parse(fs.readFileSync(recFile, 'utf8'));
    const action = rec.recommended?.action || 'UNKNOWN';

    let ts = null;
    if (dryRun) {
      process.stderr.write('[process] --dry-run: previewing Slack post (not sending, not recording recommended)\n');
      run(path.join(SR_DIR, 'post-slack.js'), [recFile, '--dry-run'], { stdio: ['ignore', 'inherit', 'inherit'] });
      state.update(st, hash, { recommendationFile: recFile, recommendedAction: action });
    } else {
      const out = run(path.join(SR_DIR, 'post-slack.js'), [recFile, '--channel', CHANNEL, '--seed-reactions']);
      process.stdout.write(out);
      ts = (out.match(/ts=([\d.]+)/) || [])[1] || null;
      state.update(st, hash, {
        status: 'recommended', recommendationFile: recFile, recommendedAction: action,
        slack: ts ? { channel: CHANNEL, ts, postedISO: state.nowISO() } : null,
      });
    }
    state.save(st);
    process.stderr.write(`[process] ${payload.contactName}: ${action}${ts ? ` posted (ts=${ts})` : ''}. State: ${JSON.stringify(state.summary(st))}\n`);
  } catch (err) {
    // `classified` is set optimistically above, BEFORE the live A+ run and the
    // Slack post — and `pending` only ever re-emits status `new`. So any throw in
    // here used to strand the record silently and permanently: four sat at
    // `classified` from 2026-06-07 until 2026-07-31, never retried, never surfaced.
    //
    // Hand it back to `new` so the next pass picks it up through the path that
    // already exists (no new selection logic, and re-classification sees any newer
    // messages in the thread). Give up after MAX_PROCESS_ATTEMPTS so a genuinely
    // broken record lands in `error` and is visible instead of looping forever.
    const attempts = (st.requests[hash].attempts || 0) + 1;
    const giveUp = attempts >= MAX_PROCESS_ATTEMPTS;
    state.update(st, hash, {
      status: giveUp ? 'error' : 'new',
      attempts,
      lastError: String(err.message || err).slice(0, 500),
    });
    state.save(st);
    process.stderr.write(`[process] ${payload.contactName}: FAILED on attempt ${attempts}/${MAX_PROCESS_ATTEMPTS} — ` +
      `${giveUp ? 'giving up, marked `error`' : 'requeued as `new`'}: ${err.message}\n`);
    process.exit(1);
  }
}

// ─── skip: mark a non-schedulable message handled ────────────────────────────
function cmdSkip(argv) {
  const [hash, ...reasonParts] = argv;
  const reason = reasonParts.join(' ');
  if (!hash) { console.error('Usage: pipeline-run.js skip <hash> "<reason>"'); process.exit(1); }
  const st = state.load();
  if (!state.has(st, hash)) { console.error(`hash ${hash} not in pipeline-state.`); process.exit(1); }
  state.update(st, hash, { status: 'skipped', skipReason: reason || 'not-scheduling' });
  state.save(st);
  console.log(`skipped ${hash}: ${reason || 'not-scheduling'}`);
}

function cmdStatus() {
  const st = state.load();
  console.log(JSON.stringify({ summary: state.summary(st), updatedISO: st.updatedISO }, null, 2));
}

const [cmd, ...argv] = process.argv.slice(2);
({ pending: cmdPending, process: cmdProcess, skip: cmdSkip, status: cmdStatus }[cmd] ||
  (() => { console.error('Usage: pipeline-run.js <pending|process|skip|status> …'); process.exit(1); }))(argv);
