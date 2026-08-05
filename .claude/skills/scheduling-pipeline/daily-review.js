/**
 * daily-review.js — what did the scheduling bot learn yesterday?
 *
 * Every other piece of this pipeline answers "what should we do about THIS
 * message". Nothing answered "is it working, and what is it getting wrong".
 * That was done by hand, and it produced the two most useful findings of the
 * project: cancellations skipped as "not a scheduling request", and six threads
 * asking what was already on the calendar. Both sat in the skip reasons the
 * whole time. This runs that read daily so the next one surfaces on its own.
 *
 * Output follows the schedule-reconcile pattern deliberately: a SHORT Slack
 * post and a linked Google Sheet with everything else. #scheduling is where
 * staff work, so the channel gets headline numbers and a link, never the detail.
 *
 * Sheet tabs, in the order they are worth reading:
 *   Summary        the same numbers as the Slack post, plus context
 *   Staff Feedback human replies in the channel. The gold. Mariah's "Morgan
 *                  already normally has a session on Tuesdays" beat every metric.
 *   Outcomes       per-recommendation verdicts from backfill-outcomes.js
 *   Declined       skip reasons, themed. New use cases hide here.
 *   Attention      errors, records stuck at `new`
 *
 * READ-ONLY apart from the Slack post and the sheet it owns. Never touches
 * pipeline state.
 *
 * Usage:
 *   node daily-review.js [--days 7] [--dry-run] [--channel <ID>] [--no-sheet] [--no-post]
 */
const fs = require('fs');
const path = require('path');
const { google } = require('googleapis');
const { execFileSync } = require('child_process');

const PIPE_DIR = __dirname;
const STATE_PATH = path.join(PIPE_DIR, 'pipeline-state.json');
const REPORT_PATH = path.join(PIPE_DIR, 'backfill-report.json');
const ENV_PATH = 'C:\\projects\\hlc-agents\\.env';
const CENTER_TZ = 'America/Los_Angeles';
const SHEET_TITLE = 'HLC Scheduling Bot - Daily Review';
const SHARE_EMAIL = 'staff@huntingtonissaquah.com';

const argv = process.argv.slice(2);
const argVal = (f, d) => { const i = argv.indexOf(f); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const DAYS = parseInt(argVal('--days', '7'), 10);
const DRY_RUN = argv.includes('--dry-run');
const NO_SHEET = argv.includes('--no-sheet');
// Write the sheet but stay out of Slack - lets the digest be verified without
// adding a post to a channel staff are reading.
const NO_POST = argv.includes('--no-post');
// Below this, a Slack message is an acknowledgement rather than feedback.
const MIN_NOTE_CHARS = 25;
// The tabs this report owns, in reading order. Anything else in the sheet is
// stray (e.g. the default "Sheet1") and gets removed.
const TAB_ORDER = ['Summary', 'Staff Feedback', 'Outcomes', 'Declined', 'Attention'];

function readEnv(p = ENV_PATH) {
  if (!fs.existsSync(p)) return {};
  const out = {};
  for (const line of fs.readFileSync(p, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (m) out[m[1]] = m[2].replace(/^['"]|['"]$/g, '');
  }
  return out;
}
function appendEnv(p, key, value) {
  const existing = fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : '';
  const sep = existing && !existing.endsWith('\n') ? '\n' : '';
  fs.appendFileSync(p, `${sep}${key}=${value}\n`);
}

async function slack(token, method, params) {
  const qs = new URLSearchParams(params).toString();
  const res = await fetch(`https://slack.com/api/${method}?${qs}`, { headers: { Authorization: `Bearer ${token}` } });
  return res.json();
}

const load = p => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; } };
/** Center-local calendar day. A+ and staff both think in local days, not UTC. */
const day = iso => iso ? new Date(iso).toLocaleDateString('en-CA', { timeZone: CENTER_TZ }) : null;
const nice = iso => iso ? new Date(iso).toLocaleString('en-CA', { timeZone: CENTER_TZ, hour12: false }) : '';

// Skip reasons are free text written by the classifier. Theming them is how a new
// use case becomes visible: "6 threads asking what is already booked" reads as a
// feature request, where six separate one-line reasons read as noise.
//
// ORDER MATTERS - first match wins. The acknowledgement patterns MUST come first:
// "tapback-only: liked staff's cancellation confirmation" mentions cancelling but
// is a correct skip, and it was being counted as a MISSED cancellation. A theme
// meant to flag misses must not flag the successes.
const SKIP_THEMES = [
  ['thanks / acknowledgement',              /thank|tapback|liked |acknowledg|ack only|reply only|already (handled|confirmed|agreed|rescheduled) by/],
  ['automated / no-reply traffic',          /otp|one.time code|verification code|cardpointe|automated/],
  ['results conference / director meeting', /results (conference|meeting|review)|director|conference (already|with)|calendly/],
  ['schedule question (possible `lookup`)', /what time|when is|which day|already (booked|scheduled)|confirm(ing|ation)? of existing|confirming (the )?format|existing (mon|tue|wed|thu|fri|schedule|booking)/],
  // Affirmative cancellations only. The classifier routinely writes negations
  // like "no session to book, move, or cancel", and a bare /cancel/ counted
  // those as MISSED cancellations - 8 of 11 were that inversion, which is the
  // exact error this theme exists to catch.
  ['cancellation (should be `cancel`)',     /cancellation request|wants? to cancel|cancel(l)?ing (the|next|her|his|their|today)|cancel(l)?ation notice/],
  ['billing / tuition',                     /tuition|billing|payment|invoice|pricing|rate|charge|refund/],
  ['teacher-originated',                    /teacher-originated|tutor asking|staff-to-teacher|own (schedule|hours|session)/],
  ['voicemail / phone tag',                 /voicemail|phone tag|call(ed)? back|left a message/],
  ['no concrete date or time',              /no concrete|no specific|needs-info|unclear|vague|no day|no date|no scheduling ask/],
  ['absence notice, nothing asked',         /absence|sick|out of town|vacation|camp|won.t be|not attend/],
  ['no longer in queue',                    /no-longer-in-queue|not in queue/],
];
function themeOf(reason) {
  const hit = SKIP_THEMES.find(([, re]) => re.test((reason || '').toLowerCase()));
  return hit ? hit[0] : '(uncategorised)';
}

/** Write one tab: create if missing, clear, then fill. Plain values, no formatting fuss. */
async function writeTab(sheets, spreadsheetId, existing, title, rows) {
  if (!existing.has(title)) {
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId,
      resource: { requests: [{ addSheet: { properties: { title, gridProperties: { frozenRowCount: 1 } } } }] },
    });
    existing.add(title);
  }
  await sheets.spreadsheets.values.clear({ spreadsheetId, range: `${title}!A:Z` });
  if (rows.length) {
    await sheets.spreadsheets.values.update({
      spreadsheetId, range: `${title}!A1`, valueInputOption: 'RAW', resource: { values: rows },
    });
  }
}

(async () => {
  const state = load(STATE_PATH);
  if (!state) { console.error(`no pipeline state at ${STATE_PATH}`); process.exit(1); }
  const report = load(REPORT_PATH);
  const env = readEnv();
  const token = env.SLACK_BOT_TOKEN;
  const channel = argVal('--channel', env.SCHEDULING_SLACK_CHANNEL || 'CMR1PPZ9B');

  const now = new Date();
  const since = new Date(now.getTime() - DAYS * 86400000);
  const today = day(now.toISOString());
  const recs = Object.values(state.requests || {});
  const inWindow = r => r.lastUpdateISO && new Date(r.lastUpdateISO) >= since;

  // volume
  const posted = recs.filter(r => r.slack?.postedISO && new Date(r.slack.postedISO) >= since);
  const skipped = recs.filter(inWindow).filter(r => r.status === 'skipped');
  const reopened = recs.filter(r => r.reopenedISO && new Date(r.reopenedISO) >= since);

  // What staff SAID — scan the CHANNEL, not our records. A record's slack.ts is
  // overwritten when a conversation is reopened and re-posted, so walking records
  // loses every comment on the earlier message (it found 1 of 2 known replies in
  // testing). Top-level notes count too: "Oliver Fhi has moved to Tuesdays 2-4"
  // is feedback without being a reply to anything.
  const staffNotes = [];
  if (token) {
    const hist = await slack(token, 'conversations.history', { channel, oldest: (since.getTime() / 1000).toFixed(6), limit: 200 });
    for (const m of (hist.messages || [])) {
      const isBot = !!m.bot_id || m.subtype === 'bot_message';
      const body = String(m.text || '').replace(/\s+/g, ' ').trim();
      if (!isBot && body.length >= MIN_NOTE_CHARS) {
        staffNotes.push({ when: nice(new Date(+m.ts.split('.')[0] * 1000).toISOString()), about: '(channel note)', text: body });
      }
      if (!m.reply_count) continue;
      const rp = await slack(token, 'conversations.replies', { channel, ts: m.ts, limit: 50 });
      if (!rp.ok) continue;
      // Drop the :emoji: shortcode first: stripping ':' alone leaves the bare word.
      const about = String((rp.messages || [])[0]?.text || '').split('\n')[0]
        .replace(/:[a-z0-9_+-]+:/gi, '').replace(/[*_]/g, '').trim().slice(0, 90);
      for (const r of (rp.messages || []).slice(1)) {
        if (r.bot_id || r.subtype === 'bot_message') continue;   // the bot's own outcome replies
        const reply = String(r.text || '').replace(/\s+/g, ' ').trim();
        if (reply.length >= MIN_NOTE_CHARS) {
          staffNotes.push({ when: nice(new Date(+r.ts.split('.')[0] * 1000).toISOString()), about, text: reply });
        }
      }
    }
  }
  // Replies about a specific recommendation outrank general channel chatter.
  staffNotes.sort((a, b) => (a.about === '(channel note)') - (b.about === '(channel note)'));

  // outcomes
  const results = (report?.results || []).filter(x => x.postedISO && new Date(x.postedISO) >= since);
  const verdicts = {};
  results.forEach(x => { verdicts[x.verdict] = (verdicts[x.verdict] || 0) + 1; });
  const botFirst = results.filter(x => x.timeliness === 'bot-first').length;
  const timed = results.filter(x => x.timeliness && x.timeliness !== 'unknown').length;
  const WRONG = new Set(['wrong-category', 'wrong-tutor', 'bot-blocked-staff-acted', 'still-booked', 'restore-not-done']);
  const wrong = results.filter(x => WRONG.has(x.verdict));

  // ── job health ─────────────────────────────────────────────────────────────
  // A failed scheduled job is otherwise SILENT. The reconcile posts to Slack only
  // when it SUCCEEDS, so a failure looks exactly like a quiet day - and its log is
  // overwritten on the next run, so the evidence is gone too. `Reconcile Saturday
  // noon` failed on 2026-08-01 (0xC000013A, process terminated) and nobody knew;
  // staff simply got no report that day.
  //
  // Only a non-zero exit is FLAGGED in Slack. Every job's last run goes to the
  // sheet regardless: the cadences differ (15 min / daily / weekly / monthly) and
  // one staleness threshold across all of them would be guesswork.
  let jobs = [];
  try {
    const ps = "Get-ScheduledTask | Where-Object { $_.TaskName -match 'ClaudeScheduling|^Reconcile |^HLC-' } | " +
      "ForEach-Object { $i = $_ | Get-ScheduledTaskInfo; " +
      "'{0}|{1}|{2}' -f $_.TaskName, $i.LastTaskResult, $(if ($i.LastRunTime.Year -gt 2000) { $i.LastRunTime.ToString('o') } else { '' }) }";
    jobs = execFileSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', ps],
      { encoding: 'utf8', timeout: 60000 })
      .split(/\r?\n/).map(l => l.trim()).filter(Boolean)
      .map(l => { const [name, result, last] = l.split('|');
        return { name, result: Number(result), last,
                 hrs: last ? +((Date.now() - new Date(last)) / 3600000).toFixed(1) : null }; });
  } catch (e) {
    console.error(`[daily-review] job health unavailable (${e.message}) - continuing.`);
  }
  // Task Scheduler status codes are NOT exit codes. A task that is mid-run
  // reports 267009 (SCHED_S_TASK_RUNNING) and one that has never fired reports
  // 267011 (SCHED_S_TASK_HAS_NOT_RUN). Treating those as failures made the daily
  // review flag ITSELF every single time it ran - caught only by triggering the
  // real scheduled task rather than the script.
  const NOT_A_FAILURE = new Set([
    0,          // success
    267009,     // 0x41301 currently running (this job, while it asks)
    267011,     // 0x41303 has not run yet (newly registered)
  ]);
  const failedJobs = jobs.filter(j => Number.isFinite(j.result) && !NOT_A_FAILURE.has(j.result));

  // stuck
  const errors = recs.filter(r => r.status === 'error');
  const stuckNew = recs.filter(r => r.status === 'new');

  // ── the sheet carries the detail ──
  let sheetUrl = null;
  let sheetError = null;
  // The sheet is the DETAIL; the Slack line is the ALERT. If Sheets is
  // unreachable, mis-shared, or the service account loses access, the digest
  // must still go out - a monitoring tool that disappears when its optional
  // output fails is worse than one with no detail view.
  if (!NO_SHEET && !DRY_RUN) try {
    const auth = new google.auth.GoogleAuth({
      keyFile: env.SERVICE_ACCOUNT_PATH || 'C:\\LCOS\\service-account.json',
      scopes: ['https://www.googleapis.com/auth/spreadsheets', 'https://www.googleapis.com/auth/drive'],
    });
    const sheets = google.sheets({ version: 'v4', auth });
    const drive = google.drive({ version: 'v3', auth });
    let sheetId = env.REVIEW_SHEET_ID || '';
    if (sheetId) {
      try { await sheets.spreadsheets.get({ spreadsheetId: sheetId, fields: 'spreadsheetId' }); }
      catch (e) { if (e.code === 404) sheetId = ''; else throw e; }
    }
    if (!sheetId) {
      const created = await sheets.spreadsheets.create({ resource: { properties: { title: SHEET_TITLE } }, fields: 'spreadsheetId' });
      sheetId = created.data.spreadsheetId;
      await drive.permissions.create({
        fileId: sheetId, requestBody: { type: 'user', role: 'writer', emailAddress: SHARE_EMAIL }, sendNotificationEmail: false,
      });
      appendEnv(ENV_PATH, 'REVIEW_SHEET_ID', sheetId);
      console.log(`created review sheet ${sheetId}, shared with ${SHARE_EMAIL}`);
    }
    const info = await sheets.spreadsheets.get({ spreadsheetId: sheetId, fields: 'sheets.properties' });
    const existing = new Set((info.data.sheets || []).map(s => s.properties.title));

    await writeTab(sheets, sheetId, existing, 'Summary', [
      ['Scheduling bot - daily review'],
      ['Generated', nice(now.toISOString())],
      ['Window', `last ${DAYS} days (since ${day(since.toISOString())})`],
      [],
      ['Recommendations posted', posted.length],
      ['Threads skipped', skipped.length],
      ['Conversations reopened by a new message', reopened.length],
      ['Graded outcomes', results.length],
      ['Bot posted before staff replied', timed ? `${botFirst} of ${timed}` : 'n/a'],
      ['Demonstrably wrong', wrong.length],
      ['Records in error', errors.length],
      ['Records stuck at new', stuckNew.length],
      [],
      ['Verdict breakdown', ''],
      ...Object.entries(verdicts).sort((a, b) => b[1] - a[1]).map(([v, n]) => ['  ' + v, n]),
      [],
      ['Note', 'Small samples move these numbers a lot. Read trends, not single days.'],
    ]);

    await writeTab(sheets, sheetId, existing, 'Staff Feedback',
      [['When', 'About', 'What they said'], ...staffNotes.map(n => [n.when, n.about, n.text])]);

    await writeTab(sheets, sheetId, existing, 'Outcomes',
      [['Posted', 'Student', 'Bot action', 'Bot tutor', 'Verdict', 'Timeliness', 'Staff actually used'],
        ...results.map(r => [nice(r.postedISO), r.student || r.contactName || '', r.action || '',
          r.recommendedTutor || '', r.verdict || '', r.timeliness || '', (r.actualTutors || []).join(', ')])]);

    await writeTab(sheets, sheetId, existing, 'Declined',
      [['Theme', 'Contact', 'Reason the classifier gave'],
        ...skipped.map(r => [themeOf(r.skipReason), r.contactName || '', r.skipReason || ''])
          .sort((a, b) => String(a[0]).localeCompare(String(b[0])))]);

    await writeTab(sheets, sheetId, existing, 'Attention',
      [['Status', 'Contact', 'Detail'],
        ...errors.map(r => ['error', r.contactName || '', r.lastError || '']),
        ...stuckNew.map(r => ['stuck at new', r.contactName || '', `first seen ${nice(r.firstSeenISO)}`]),
        ...(jobs.length ? [[], ['SCHEDULED JOBS', 'last result', 'last run']] : []),
        ...jobs.slice().sort((a, b) => a.name.localeCompare(b.name))
          .map(j => [NOT_A_FAILURE.has(j.result) ? (j.result === 267009 ? 'running now' : j.result === 267011 ? 'not yet run' : 'job ok') : 'JOB FAILED', j.name,
            `${NOT_A_FAILURE.has(j.result) ? 'ok' : 'exit ' + j.result} - ${j.last ? nice(j.last) : 'never run'}${j.hrs != null ? ` (${j.hrs}h ago)` : ''}`])]);

    // Housekeeping: a spreadsheet created by hand opens on an empty "Sheet1",
    // and our tabs get appended AFTER it - so the doc looks empty on open even
    // though every tab is populated. Drop that default tab and pin Summary first.
    const after = await sheets.spreadsheets.get({ spreadsheetId: sheetId, fields: 'sheets.properties' });
    const tabs = (after.data.sheets || []).map(x => x.properties);
    const ours = new Set(TAB_ORDER);
    const cleanup = tabs.filter(t => !ours.has(t.title))
      .map(t => ({ deleteSheet: { sheetId: t.sheetId } }));
    const summary = tabs.find(t => t.title === TAB_ORDER[0]);
    if (summary && summary.index !== 0) {
      cleanup.push({ updateSheetProperties: { properties: { sheetId: summary.sheetId, index: 0 }, fields: 'index' } });
    }
    if (cleanup.length) {
      await sheets.spreadsheets.batchUpdate({ spreadsheetId: sheetId, resource: { requests: cleanup } });
      console.log(`tidied ${cleanup.length} tab change(s) (removed stray tabs, Summary first)`);
    }

    sheetUrl = `https://docs.google.com/spreadsheets/d/${sheetId}`;
    console.log(`wrote review sheet: ${sheetUrl}`);
  } catch (e) {
    sheetError = e.message;
    console.error(`[daily-review] sheet unavailable (${e.message}) - posting the summary without it.`);
  }

  // ── Slack: headline only. Detail lives in the sheet. ──
  const L = [];
  L.push(`:bar_chart: *Scheduling bot - daily review* · ${today} (last ${DAYS} days)`);
  L.push(`${posted.length} recommended · ${skipped.length} skipped · ${reopened.length} reopened` +
         (timed ? ` · bot first in ${botFirst}/${timed}` : ''));
  // Only ever add a line when there is something to act on. A quiet day stays short.
  const flags = [];
  if (wrong.length) flags.push(`:warning: ${wrong.length} wrong`);
  if (staffNotes.length) flags.push(`:speech_balloon: ${staffNotes.length} staff note(s)`);
  if (errors.length) flags.push(`:x: ${errors.length} in error`);
  if (stuckNew.length) flags.push(`:hourglass: ${stuckNew.length} stuck at new`);
  if (failedJobs.length) flags.push(`:rotating_light: ${failedJobs.length} job(s) failed: ${failedJobs.map(j => j.name).join(', ')}`);
  if (flags.length) L.push(flags.join(' · '));
  if (sheetUrl) L.push(`<${sheetUrl}|View full review>`);
  else if (sheetError) L.push(`_(detail sheet unavailable: ${sheetError})_`);
  const text = L.join('\n');

  console.log('\n--- Slack post ---\n' + text);
  if (DRY_RUN || NO_POST || !token) {
    console.log(`\n[daily-review] ${DRY_RUN ? '--dry-run' : NO_POST ? '--no-post' : 'no SLACK_BOT_TOKEN'} - not posted.`);
    return;
  }
  const res = await slack(token, 'chat.postMessage', { channel, text });
  console.log(res.ok ? `\n[daily-review] posted to ${channel}` : `\n[daily-review] post failed: ${res.error}`);
})().catch(e => { console.error('daily-review failed:', e.message); process.exit(1); });
