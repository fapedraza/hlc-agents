/**
 * backfill-outcomes.js — what did staff ACTUALLY do after each recommendation?
 *
 * STRICTLY READ-ONLY. Writes no state, posts nothing to Slack. It only reads
 * pipeline-state, the saved recommendations, the Text Request thread, and the
 * cached A+ Schedule Report, then prints a comparison.
 *
 * Why this exists: only 4 of 38 recommendations ever got a Slack vote, so we
 * have almost no signal on whether the bot is any good. But staff DID respond --
 * to the family, in Text Request -- and the resulting booking is in A+. That is
 * the real ground truth, and it covers nearly every request instead of 10%.
 *
 * IMPORTANT: what this produces is an OUTCOME, not a DECISION. Staff doing
 * something is evidence for evaluation; it is not approval, and it must never be
 * counted as consent for the bot to act on its own later.
 *
 * Usage: node backfill-outcomes.js [--limit N] [--json out.json]
 */
const fs = require('fs');
const path = require('path');

const PIPE_DIR = __dirname;
const SR_DIR = path.join(PIPE_DIR, '..', 'schedule-request');
const STATE_PATH = path.join(PIPE_DIR, 'pipeline-state.json');
const HISTORY_CSV = path.join(SR_DIR, '.cache', 'history-report.csv');
const TR_MESSAGES = path.join(PIPE_DIR, '..', 'text-request-read', 'messages.json');

const { TextRequestApi, readEnv } = require(path.join(PIPE_DIR, '..', 'text-request-read', 'lib', 'tr-api.js'));

const argv = process.argv.slice(2);
const argVal = (f, d) => { const i = argv.indexOf(f); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const LIMIT = parseInt(argVal('--limit', '0'), 10);
const JSON_OUT = argVal('--json', null);
// --apply records the outcome on the record and posts one threaded Slack reply.
// Without it nothing is written and nothing is sent.
const APPLY = argv.includes('--apply');
// An outcome needs time to exist: staff have to reply and the booking has to land
// in A+. Judging a recommendation made 10 minutes ago would post "no booking" for
// everything. Only settle records older than this.
const MIN_AGE_HOURS = parseFloat(argVal('--min-age-hours', '24'));
// Record the outcome but post nothing. Used to seed history without dumping
// dozens of replies into months-old threads nobody will revisit.
const NO_SLACK = argv.includes('--no-slack');
const state_lib = require(path.join(PIPE_DIR, 'lib', 'pipeline-state.js'));

/** Verdicts where we actually learned something worth writing back. */
const INFORMATIVE = new Set(['match','match-cancelled','same-tutor-different-time',
  'wrong-category','wrong-tutor','different-but-allowed','different-tutor-unknown',
  'bot-blocked-staff-acted','no-booking','blocked-no-booking','still-booked']);

const VERDICT_BLURB = {
  'match': 'staff did what the bot proposed',
  'match-cancelled': 'session cancelled, as expected',
  'same-tutor-different-time': 'same tutor, different time',
  'wrong-category': 'bot proposed a tutor who does not teach this category',
  'wrong-tutor': 'bot proposed a tutor this student does not work with',
  'different-but-allowed': 'staff chose a different tutor this student also works with',
  'different-tutor-unknown': 'staff chose a different tutor (no history to judge)',
  'bot-blocked-staff-acted': 'bot found nothing, staff booked anyway',
  'no-booking': 'no booking resulted',
  'blocked-no-booking': 'bot found nothing and nothing was booked',
  'still-booked': 'cancellation requested but the session is still on the schedule',
};

async function slackPost(token, channel, threadTs, text) {
  const res = await fetch('https://slack.com/api/chat.postMessage', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify({ channel, thread_ts: threadTs, text, unfurl_links: false }),
  });
  return res.json();
}

// ─── helpers ─────────────────────────────────────────────────────────────────
const norm = s => (s || '').toLowerCase().replace(/\s+/g, ' ').trim();
const CANCELLED = new Set(['cancelled','canceled','no-show','no show','noshow','deleted','removed','void','anm','anm - paid','anm - unpaid','absent no makeup','abs','vac']);

function parseCsv(text) {
  const lines = text.split(/\r?\n/).filter(l => l.length);
  const split = line => {
    const out = []; let cur = '', q = false;
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (q) { if (c === '"' && line[i+1] === '"') { cur += '"'; i++; } else if (c === '"') q = false; else cur += c; }
      else if (c === '"') q = true;
      else if (c === ',') { out.push(cur); cur = ''; }
      else cur += c;
    }
    out.push(cur); return out;
  };
  const headers = split(lines[0]).map(h => h.trim());
  return lines.slice(1).map(l => { const r = split(l); const o = {}; headers.forEach((h,i)=>o[h]=(r[i]||'').trim()); return o; });
}
function mdyToISO(s) {
  const m = (s||'').trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  return m ? `${m[3]}-${String(m[1]).padStart(2,'0')}-${String(m[2]).padStart(2,'0')}` : null;
}
function toHHMM(s) {
  if (!s) return null;
  const m = s.trim().match(/^(\d{1,2}):?(\d{2})?\s*(am|pm)?$/i);
  if (!m) return null;
  let h = +m[1]; const mm = m[2] || '00'; const ap = (m[3]||'').toLowerCase();
  if (ap === 'pm' && h !== 12) h += 12;
  if (ap === 'am' && h === 12) h = 0;
  return `${String(h).padStart(2,'0')}:${mm}`;
}
/** Compare tutor names across "Last First" / "Last, First (Nick)" / bare first name. */
const toks = s => new Set(((s||'').toLowerCase().match(/[a-z]+/g)) || []);
function sameTutor(a, b) {
  const A = toks(a), B = toks(b);
  if (!A.size || !B.size) return false;
  const [small, big] = A.size <= B.size ? [A, B] : [B, A];
  for (const t of small) if (!big.has(t)) return false;
  return true;
}
/** Text Request message field access, defensive about naming. */
const msgDir  = m => { const v = String(m.message_direction ?? m.direction ?? '').toUpperCase(); return v === 'R' ? 'in' : v === 'S' ? 'out' : v.toLowerCase().startsWith('in') ? 'in' : v.toLowerCase().startsWith('out') ? 'out' : '?'; };
/**
 * Text Request returns e.g. "2026-04-02T03:07:53.647" -- UTC per the field name,
 * but with NO 'Z' and no offset. Node's Date then parses it as LOCAL time, which
 * on a PDT box puts every message 7 hours in the future and inflated every
 * latency measurement by exactly 420 minutes. Verified against the hour
 * histogram: raw hours cluster 23:00-03:00 UTC = 16:00-20:00 PDT, i.e. business
 * hours. Force UTC when the string carries no zone.
 */
function trDate(raw) {
  if (!raw) return null;
  const s = String(raw);
  const iso = /(?:Z|[+-]\d{2}:?\d{2})$/.test(s) ? s : s + 'Z';
  const d = new Date(iso);
  return isNaN(d) ? null : d;
}
const msgTime = m => m.message_timestamp_utc || m.timestamp || m.created_at || null;
const msgBody = m => m.body || m.text || '';
const msgUser = m => m.response_by_username || m.staff || m.user || null;

// ─── load ────────────────────────────────────────────────────────────────────
const state = JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'));
const histRows = fs.existsSync(HISTORY_CSV) ? parseCsv(fs.readFileSync(HISTORY_CSV, 'utf8')) : [];
const histAgeDays = fs.existsSync(HISTORY_CSV) ? (Date.now() - fs.statSync(HISTORY_CSV).mtimeMs) / 86400000 : null;
const dashboardId = (JSON.parse(fs.readFileSync(TR_MESSAGES, 'utf8')) || {}).dashboardId;
const ENV_PATH = path.join(PIPE_DIR, '..', '..', '..', '.env');   // repo root .env
const env = readEnv(ENV_PATH);
if (!env.TR_API_KEY) { console.error(`TR_API_KEY not found in ${ENV_PATH}`); process.exit(1); }
const api = new TextRequestApi(env.TR_API_KEY);

// student -> non-cancelled sessions
const sessionsByStudent = new Map();
for (const r of histRows) {
  const k = norm(r['Student Name']);
  if (!k) continue;
  if (!sessionsByStudent.has(k)) sessionsByStudent.set(k, []);
  sessionsByStudent.get(k).push({
    date: mdyToISO(r['Session Date']), time: toHHMM(r['Start Time']),
    tutor: (r['Teacher'] || '').trim(), status: r['Session Status'],
    cancelled: CANCELLED.has(norm(r['Session Status'])),
    // When the booking was last touched. Without this we cannot tell a session
    // staff created IN RESPONSE to a recommendation from one that already
    // existed and merely happens to fall near the proposed date.
    updated: mdyToISO(r['Last Update Date']),
  });
}

// ─── seed data: separates "a different tutor" from "the WRONG tutor" ─────────
// Staff picking Ashley when the bot said Lucas is not an error if the student
// works with both. Staff picking an LC teacher when the bot proposed an exam-prep
// teacher IS an error, and it is the one the teacher-category rule fixes.
const SEED_STUDENTS = path.join(SR_DIR, 'seed-student-tutors.json');
const SEED_TEACHERS = path.join(SR_DIR, 'seed-teacher-categories.json');
const knownTutors = new Map();     // student -> [tutor]
const studentCategory = new Map(); // student -> LC | ST | EP
const teacherTeaches = new Map();  // tutor -> [categories]
try {
  for (const st of JSON.parse(fs.readFileSync(SEED_STUDENTS, 'utf8')).students) {
    knownTutors.set(norm(st.student), st.tutors.map(t => t.tutor));
    studentCategory.set(norm(st.student), st.category);
  }
} catch { console.log('(seed-student-tutors.json not readable - skipping allowed-tutor analysis)'); }
try {
  for (const t of JSON.parse(fs.readFileSync(SEED_TEACHERS, 'utf8')).teachers) {
    teacherTeaches.set(norm(t.teacher), t.teaches || []);
  }
} catch { console.log('(seed-teacher-categories.json not readable - skipping category analysis)'); }

/** Does this tutor teach this category at all? null = unknown. */
function teachesCategory(tutorName, cat) {
  if (!tutorName || !cat) return null;
  for (const [k, cats] of teacherTeaches) {
    if (sameTutor(k, tutorName)) return cats.includes(cat);
  }
  return null;
}
function inKnownSet(studentName, tutorName) {
  const set = knownTutors.get(norm(studentName));
  if (!set || !set.length || !tutorName) return null;
  return set.some(t => sameTutor(t, tutorName));
}

let records = Object.values(state.requests || {})
  .filter(r => r.slack && r.slack.postedISO && r.recommendationFile)
  .sort((a, b) => (a.slack.postedISO < b.slack.postedISO ? -1 : 1));

// In apply mode, skip work we have already done or that is too fresh to judge --
// BEFORE the Text Request fetch, so a 15-minute cadence costs almost nothing.
let ageSkipped = 0, doneSkipped = 0;
if (APPLY) {
  const cutoff = Date.now() - MIN_AGE_HOURS * 3600e3;
  records = records.filter(r => {
    if (r.outcome && r.outcome.postedISO) { doneSkipped++; return false; }
    if (new Date(r.slack.postedISO).getTime() > cutoff) { ageSkipped++; return false; }
    return true;
  });
}

(async () => {
  console.log(`Recommendations to evaluate: ${records.length}`);
  if (APPLY) console.log(`  (apply mode: skipped ${doneSkipped} already settled, ${ageSkipped} younger than ${MIN_AGE_HOURS}h)`);
  console.log(`A+ history cache: ${histRows.length} rows, ${histAgeDays == null ? 'MISSING' : histAgeDays.toFixed(1) + 'd old'}`);
  if (histAgeDays > 2) console.log(`  ! cache is stale - bookings made in the last ${Math.floor(histAgeDays)} days are invisible. Run prewarm-history.js --force for a current picture.`);
  console.log('');

  const out = [];
  let shownFields = false;
  const todo = LIMIT ? records.slice(0, LIMIT) : records;

  for (const rec of todo) {
    let recJson = {};
    try { recJson = JSON.parse(fs.readFileSync(rec.recommendationFile, 'utf8')); } catch {}
    const action = recJson.recommended?.action || rec.recommendedAction || 'UNKNOWN';
    const recTutor = recJson.recommended?.tutor || null;
    const studentName = recJson.student?.name || null;
    const propDate = recJson.proposed?.date || rec.classification?.proposedDate || null;
    const propTime = toHHMM(recJson.proposed?.time || rec.classification?.proposedTime);
    const postedAt = new Date(rec.slack.postedISO);

    // ── Text Request: what did staff tell the family, and when? ──
    let msgs = [];
    let trError = null;
    try {
      msgs = await api.getRecentMessages(dashboardId, rec.phone, 50);
      if (!shownFields && msgs.length) { console.log(`(TR message fields: ${Object.keys(msgs[0]).join(', ')})\n`); shownFields = true; }
    } catch (e) { trError = e.message; }

    const outbound = msgs.filter(m => msgDir(m) === 'out' && trDate(msgTime(m)))
      .map(m => ({ at: trDate(msgTime(m)), body: msgBody(m), by: msgUser(m) }))
      .sort((a, b) => a.at - b.at);
    const firstAfter = outbound.find(m => m.at > postedAt) || null;
    const lastBefore = [...outbound].reverse().find(m => m.at <= postedAt) || null;
    const latencyMin = firstAfter ? Math.round((firstAfter.at - postedAt) / 60000) : null;

    // Did staff already answer this ask before the bot spoke?
    const lastInboundBefore = msgs.filter(m => msgDir(m) === 'in' && trDate(msgTime(m)))
      .map(m => trDate(msgTime(m))).filter(d => d <= postedAt).sort((a,b)=>b-a)[0] || null;
    const answeredBeforeBot = !!(lastBefore && lastInboundBefore && lastBefore.at > lastInboundBefore);

    // ── A+: what actually got booked? ──
    const sess = studentName ? (sessionsByStudent.get(norm(studentName)) || []) : [];
    const postedDay = rec.slack.postedISO.slice(0, 10);
    // A session that predates the request cannot be a response to it. This was
    // flagging a 5/30 session as staff acting on a 6/6 request.
    // A session only counts as a response if it was created or changed AFTER we
    // posted. Date proximity alone was wrong: it matched sessions last touched
    // days BEFORE the recommendation, which produced four bogus
    // `bot-blocked-staff-acted` verdicts.
    const responsive = s => s.date && s.date >= postedDay && s.updated && s.updated >= postedDay;
    const live = sess.filter(s => !s.cancelled);
    const onDate  = propDate ? live.filter(s => s.date === propDate) : [];
    const nearDate = propDate ? live.filter(s => responsive(s) && Math.abs((new Date(s.date) - new Date(propDate)) / 86400000) <= 7) : [];
    const cancelledOnDate = propDate ? sess.filter(s => s.cancelled && s.date === propDate) : [];
    const reqType = (recJson.requestType || rec.classification?.requestType || '').toLowerCase();

    // ── verdict ──
    // Two ORTHOGONAL axes. Collapsing them loses the agreement signal on exactly
    // the cases where staff acted without the bot - the most informative ones.
    const timeliness = trError ? 'unknown'
      : answeredBeforeBot ? 'staff-replied-first'
      : firstAfter ? 'bot-first'
      : 'no-staff-reply';

    let verdict, catDetail = null;
    if (!studentName)      verdict = 'no-student-resolved';
    else if (trError)      verdict = 'tr-error';
    else if (reqType === 'cancel') {
      // Success for a cancellation is the session being GONE, not present.
      verdict = cancelledOnDate.length ? 'match-cancelled'
        : onDate.length ? 'still-booked'
        : 'cancel-unverifiable';
    }
    else if (action === 'BLOCKED') {
      // Only a booking staff actually made after we gave up counts against us.
      const responsiveBookings = nearDate.filter(responsive);
      verdict = responsiveBookings.length ? 'bot-blocked-staff-acted'
        : (onDate.length || nearDate.length) ? 'blocked-but-slot-already-booked'
        : 'blocked-no-booking';
    }
    else if (!onDate.length && !nearDate.length) verdict = 'no-booking';
    else {
      const exact = onDate.find(s => recTutor && sameTutor(s.tutor, recTutor) && (!propTime || s.time === propTime));
      const sameT = [...onDate, ...nearDate].find(s => recTutor && sameTutor(s.tutor, recTutor));
      if (exact)       verdict = 'match';
      else if (sameT)  verdict = 'same-tutor-different-time';
      else if (!recTutor) verdict = 'booked-no-tutor-recommended';
      else {
        // Grade the miss. Category error > not-a-tutor-of-this-student > both fine.
        const cat = studentCategory.get(norm(studentName));
        const recTeaches = teachesCategory(recTutor, cat);
        const recKnown = inKnownSet(studentName, recTutor);
        if (recTeaches === false)      verdict = 'wrong-category';
        else if (recKnown === false)   verdict = 'wrong-tutor';
        else if (recKnown === true)    verdict = 'different-but-allowed';
        else                           verdict = 'different-tutor-unknown';
        catDetail = { studentCategory: cat || null, recommendedTeachesCategory: recTeaches, recommendedInKnownSet: recKnown };
      }
    }

    const actualTutors = [...new Set((onDate.length ? onDate : nearDate).map(s => s.tutor))];
    out.push({
      hash: rec.hash, contactName: rec.contactName, student: studentName,
      postedISO: rec.slack.postedISO, action, recommendedTutor: recTutor,
      proposedDate: propDate, proposedTime: propTime,
      staffRepliedAt: firstAfter ? firstAfter.at.toISOString() : null,
      staffReplyBy: firstAfter?.by || null,
      staffReplyExcerpt: firstAfter ? firstAfter.body.slice(0, 120) : null,
      latencyMin, answeredBeforeBot, timeliness, requestType: reqType, catDetail,
      actualTutors, actualSessions: (onDate.length ? onDate : nearDate).slice(0, 4),
      slackDecision: rec.decision?.signal || null,
      verdict,
    });
  }

  // ─── report ──────────────────────────────────────────────────────────────
  const tally = out.reduce((a, r) => { a[r.verdict] = (a[r.verdict] || 0) + 1; return a; }, {});
  const timeTally = out.reduce((a, r) => { a[r.timeliness] = (a[r.timeliness] || 0) + 1; return a; }, {});
  console.log('=== TIMELINESS (was the bot in time to matter?) ===');
  for (const [k, v] of Object.entries(timeTally).sort((a,b)=>b[1]-a[1])) console.log(`  ${String(v).padStart(3)}  ${k}`);
  console.log('');
  console.log('=== AGREEMENT (did staff do what the bot said?) ===');
  for (const [k, v] of Object.entries(tally).sort((a,b)=>b[1]-a[1])) console.log(`  ${String(v).padStart(3)}  ${k}`);

  const wrongCat = out.filter(r => r.verdict === 'wrong-category');
  const wrongTut = out.filter(r => r.verdict === 'wrong-tutor');
  const allowed  = out.filter(r => r.verdict === 'different-but-allowed');
  console.log('\n=== WOULD THE TEACHER-CATEGORY RULE HAVE CAUGHT IT? ===');
  console.log(`  ${wrongCat.length}  wrong-category        -> YES: rule filters the pool before ranking`);
  console.log(`  ${wrongTut.length}  wrong-tutor           -> partly: per-student prefer/only rules`);
  console.log(`  ${allowed.length}  different-but-allowed -> NO error to fix - staff chose another valid tutor`);
  for (const r of wrongCat) {
    console.log(`     [cat] ${r.student}: ${r.studentCategoryLabel || r.catDetail?.studentCategory} student, bot proposed ${r.recommendedTutor} (does not teach that category); staff used ${r.actualTutors.join(', ')}`);
  }

  const lat = out.map(r => r.latencyMin).filter(v => v != null).sort((a,b)=>a-b);
  console.log('\n=== BOT LATENCY (Slack post -> staff reply to family) ===');
  if (lat.length) {
    const med = lat[Math.floor(lat.length/2)];
    console.log(`  n=${lat.length}  median ${med} min   min ${lat[0]}   max ${lat[lat.length-1]}`);
    console.log(`  staff replied within 5 min of the bot: ${lat.filter(v=>v<=5).length}`);
    console.log(`  staff had ALREADY replied before the bot posted: ${out.filter(r=>r.answeredBeforeBot).length}`);
  } else console.log('  no measurable latencies');

  console.log('\n=== PER RECOMMENDATION ===');
  for (const r of out) {
    console.log(`\n[${r.verdict} | ${r.timeliness}]  ${r.contactName}  (${r.postedISO.slice(0,16).replace('T',' ')})`);
    console.log(`   bot: ${r.action}${r.recommendedTutor ? ' -> ' + r.recommendedTutor : ''}${r.proposedDate ? `  for ${r.proposedDate}${r.proposedTime ? ' ' + r.proposedTime : ''}` : ''}`);
    console.log(`   actual: ${r.actualTutors.length ? r.actualTutors.join(', ') : '(no booking found)'}${r.actualSessions.length ? '  [' + r.actualSessions.map(s=>`${s.date} ${s.time||''} ${s.tutor}`).join(' | ') + ']' : ''}`);
    if (r.staffRepliedAt) console.log(`   staff reply ${r.latencyMin != null ? `+${r.latencyMin}min` : ''} ${r.staffReplyBy ? 'by ' + r.staffReplyBy : ''}: "${(r.staffReplyExcerpt||'').replace(/\s+/g,' ')}"`);
    if (r.slackDecision) console.log(`   slack vote: ${r.slackDecision}`);
  }

  // ─── --apply: record the outcome and close the loop in Slack ──────────────
  if (APPLY) {
    console.log('\n=== APPLYING (writing outcome + posting threaded replies) ===');
    const st = state_lib.load();
    let posted = 0, skipped = 0;
    for (const r of out) {
      const rec = st.requests[r.hash];
      if (!rec) continue;
      if (!INFORMATIVE.has(r.verdict)) { skipped++; continue; }
      if (rec.outcome && rec.outcome.postedISO) { skipped++; continue; }   // idempotent

      const actual = r.actualTutors.length ? r.actualTutors.join(', ') : 'no booking';
      const lines = [
        `:mag: *Outcome* (auto-detected from Text Request + A+ \u2014 _not_ an approval)`,
        `*What happened:* ${actual}${r.proposedDate ? ` \u00b7 ${r.proposedDate}` : ''}`,
        r.recommendedTutor ? `*Bot proposed:* ${r.recommendedTutor}` : `*Bot:* ${r.action}`,
        r.staffRepliedAt ? `*Staff replied* ${r.latencyMin != null ? (r.latencyMin >= 0 ? `+${r.latencyMin} min` : `${r.latencyMin} min (before the bot)`) : ''}${r.staffReplyBy ? ` by ${r.staffReplyBy}` : ''}` : null,
        `\u2192 recorded as \`${r.verdict}\` \u2014 ${VERDICT_BLURB[r.verdict] || ''}`,
        `_If that reading is wrong, reply here and it will be corrected._`,
      ].filter(Boolean);

      const text = lines.join('\n');
      if (argv.includes('--dry-run')) {
        console.log(`\n--- would post to thread ${r.hash} (ts ${rec.slack.ts}) ---\n${text}`);
        posted++;
        continue;
      }
      if (!NO_SLACK) {
        const resp = await slackPost(env.SLACK_BOT_TOKEN, rec.slack.channel, rec.slack.ts, text);
        if (!resp.ok) { console.log(`  ! ${r.contactName}: slack error ${resp.error}`); continue; }
      }
      // OUTCOME, deliberately NOT `decision`. An inferred outcome is evidence for
      // evaluation; it must never be mistaken for a human approving the action.
      state_lib.update(st, r.hash, {
        outcome: {
          source: 'inferred-from-text-request',
          verdict: r.verdict, actualTutors: r.actualTutors,
          recommendedTutor: r.recommendedTutor, latencyMin: r.latencyMin,
          timeliness: r.timeliness, staffReplyBy: r.staffReplyBy,
          postedISO: new Date().toISOString(),
          slackReplied: !NO_SLACK,
        },
      });
      posted++;
    }
    if (!argv.includes('--dry-run')) state_lib.save(st);
    console.log(`\n  posted ${posted}, skipped ${skipped} (uninformative or already done)`);
  }

  if (JSON_OUT) { fs.writeFileSync(JSON_OUT, JSON.stringify({ generatedISO: new Date().toISOString(), tally, results: out }, null, 2)); console.log(`\nwrote ${JSON_OUT}`); }
  if (!APPLY) console.log('\nREAD-ONLY: no state written, nothing posted to Slack. Use --apply to record outcomes.');
})().catch(e => { console.error('failed:', e); process.exit(1); });
