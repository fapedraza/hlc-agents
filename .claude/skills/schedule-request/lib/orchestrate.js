/**
 * lib/orchestrate.js — core Phase-1 scheduling-recommendation logic.
 *
 * Extracted from demo-orchestrate.js so the same pipeline can run as a single
 * live request (demo-orchestrate.js) or batched over many cases (backtest.js)
 * while sharing ONE authenticated A+ page and a per-teacher scrape cache.
 *
 * `orchestrateOne()` evaluates one request payload against a live, already
 * authenticated A+ page and returns the full recommendation object — including
 * the back-test `comparison` block when `backtest: true`.
 *
 * Nothing here launches a browser or logs in; the caller owns the page
 * lifecycle (see demo-orchestrate.js / backtest.js).
 */
const fs = require('fs');
const path = require('path');
const { getTeacherQuals, getTeacherSchedule } = require('./aplus');
const { resolveStudent } = require('../resolve-student');
const { loadQualsIndex, buildCandidateList } = require('./discover-tutors');
const { resolveSubject, serviceMatchesAny } = require('./subject-map');
const { summarizeStudentHistory, buildHistoryCandidates, CANCEL_STATUSES } = require('./student-history');
const { isNonTutor } = require('./non-tutors');
const tutorRules = require('./tutor-rules');
const { computeOpenSlots, fmt12 } = require('./slots');

const SKILL_DIR = path.join(__dirname, '..');
const ROSTER_PATH = path.join(SKILL_DIR, 'lcos-roster.json');
// Fallback source of booked appointments, used only when the wide history pull
// fails (see historyRows below). This was a separate narrow CSV that the reconcile
// downloaded; since 2026-07-30 report 763 carries every column both needed, so
// both read the one shared cache and nothing writes aplus.csv anymore.
const APLUS_CSV_PATH = path.join(__dirname, '..', '.cache', 'history-report.csv');

const DAYS = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];

// How far ahead a `lookup` reaches when the family didn't name a day ("is she
// booked this week?"). Two weeks covers "this week" and "next week" without
// dumping a term's worth of sessions into Slack.
const LOOKUP_WINDOW_DAYS = 14;
// A+ dates are the center's local calendar days. Deriving "today" from a UTC
// slice puts every evening run on tomorrow's date — the bug that corrupted both
// the latency numbers and the outcome verdicts before this.
const CENTER_TZ = 'America/Los_Angeles';
const centerToday = (now) => new Date(now).toLocaleDateString('en-CA', { timeZone: CENTER_TZ });

// ─── loaders ──────────────────────────────────────────────────────────────────

function loadRoster() {
  if (!fs.existsSync(ROSTER_PATH)) {
    throw new Error(`Roster not found at ${ROSTER_PATH}. Run lcos_get_active_students and save the rows.`);
  }
  const raw = JSON.parse(fs.readFileSync(ROSTER_PATH, 'utf8'));
  return Array.isArray(raw) ? raw : (raw.rows || []);
}

/** Minimal CSV reader for the A+ Schedule Report layout (quoted fields, commas). */
function parseAplusCsv(text) {
  const rows = [];
  const lines = text.split(/\r?\n/).filter(Boolean);
  if (!lines.length) return rows;
  const header = parseLine(lines[0]);
  for (let i = 1; i < lines.length; i++) {
    const cells = parseLine(lines[i]);
    const row = {};
    header.forEach((h, j) => { row[h] = cells[j]; });
    rows.push(row);
  }
  return rows;
}
function parseLine(line) {
  const out = [];
  let cur = '', inQ = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inQ) {
      if (c === '"' && line[i+1] === '"') { cur += '"'; i++; }
      else if (c === '"') inQ = false;
      else cur += c;
    } else {
      if (c === ',') { out.push(cur); cur = ''; }
      else if (c === '"') inQ = true;
      else cur += c;
    }
  }
  out.push(cur);
  return out;
}

/** Load the booked-appointments CSV if present. Returns { csvRows, csvAvailable }. */
function loadAplusCsv(csvPath = APLUS_CSV_PATH) {
  if (fs.existsSync(csvPath)) {
    return { csvRows: parseAplusCsv(fs.readFileSync(csvPath, 'utf8')), csvAvailable: true };
  }
  return { csvRows: [], csvAvailable: false };
}

// ─── time helpers ─────────────────────────────────────────────────────────────

/** "7:30pm" / "07:30 PM" / "19:30" → "19:30". */
function toHHMM24(s) {
  if (!s) return null;
  const m = s.trim().match(/^(\d{1,2}):?(\d{2})?\s*(am|pm)?$/i);
  if (!m) return null;
  let h = parseInt(m[1], 10);
  const mm = m[2] || '00';
  const ap = (m[3] || '').toLowerCase();
  if (ap === 'pm' && h !== 12) h += 12;
  if (ap === 'am' && h === 12) h = 0;
  return `${String(h).padStart(2,'0')}:${mm}`;
}

function dayNameForISO(iso) {
  return DAYS[new Date(iso + 'T12:00:00').getDay()];
}

/** Returns true if HH:MM `t` is within [start, end] (inclusive). */
function withinWindow(t, start, end) {
  if (!t || !start || !end) return false;
  return t >= start && t <= end;
}

/** Returns true if [aStart, aEnd) overlaps [bStart, bEnd). */
function overlaps(aStart, aEnd, bStart, bEnd) {
  return aStart < bEnd && bStart < aEnd;
}

/** "1 hour" → 60; "30 minutes" → 30; "1 hour 30 minutes" → 90. */
function durationToMinutes(s) {
  if (!s) return null;
  let total = 0;
  const h = s.match(/(\d+)\s*hour/i);
  const m = s.match(/(\d+)\s*minute/i);
  if (h) total += parseInt(h[1], 10) * 60;
  if (m) total += parseInt(m[1], 10);
  return total || null;
}

function addMinutes(hhmm, minutes) {
  if (!hhmm) return null;
  const [h, m] = hhmm.split(':').map(Number);
  const total = h * 60 + m + (minutes || 0);
  const H = Math.floor(total / 60) % 24;
  const M = total % 60;
  return `${String(H).padStart(2,'0')}:${String(M).padStart(2,'0')}`;
}

// ─── booked-appointments check ────────────────────────────────────────────────

/** Returns { csvTeacher, matches } for a tutor on a date. */
function tutorBookingsOnDate(csvRows, tutorLastFirst, isoDate) {
  // CSV Teacher column is "LastName FirstName" with no comma, e.g. "Corrie Tim".
  // Convert our `"Corrie, Tim (Tim)"` to "Corrie Tim" for match.
  const m = tutorLastFirst.match(/^([^,]+),\s*([^(]+?)\s*\(/);
  const csvTeacher = m ? `${m[1].trim()} ${m[2].trim()}` : tutorLastFirst;
  const mdy = isoToMDY(isoDate);
  const matches = csvRows.filter(r =>
    (r['Teacher'] || '').trim() === csvTeacher &&
    (r['Session Date'] || '').trim() === mdy
  );
  return { csvTeacher, matches };
}
function isoToMDY(iso) {
  const [y, m, d] = iso.split('-');
  return `${parseInt(m,10)}/${parseInt(d,10)}/${y}`;
}

// ─── real availability from the booked grid (#4) ──────────────────────────────
// The A+ weekly working-hours TEMPLATE lags reality (summer changes, exceptions),
// causing false "OFF"/"not available" verdicts. A tutor's ACTUAL working window
// on a weekday is better inferred from where they really have sessions that day.

/** A tutor's non-cancelled bookings on a given WEEKDAY across all rows → intervals. */
function tutorWeekdayIntervals(csvRows, tutorLastFirst, weekdayName) {
  const m = tutorLastFirst.match(/^([^,]+),\s*([^(]+?)\s*\(/);
  const csvTeacher = m ? `${m[1].trim()} ${m[2].trim()}` : tutorLastFirst;
  const out = [];
  for (const r of csvRows || []) {
    if ((r['Teacher'] || '').trim() !== csvTeacher) continue;
    if (CANCEL_STATUSES.has((r['Session Status'] || '').toLowerCase().trim())) continue;
    const sd = (r['Session Date'] || '').match(/(\d+)\/(\d+)\/(\d+)/);
    if (!sd) continue;
    const d = new Date(+sd[3], +sd[1] - 1, +sd[2], 12, 0, 0);
    if (DAYS[d.getDay()] !== weekdayName) continue;
    const start = toHHMM24((r['Start Time'] || '').trim());
    if (!start) continue;
    const dur = durationToMinutes((r['Duration'] || '').trim()) || 60;
    out.push({ start, end: addMinutes(start, dur) });
  }
  return out;
}

/** Earliest start → latest end across intervals (the observed working span). */
function observedWindow(intervals) {
  if (!intervals || !intervals.length) return null;
  let s = intervals[0].start, e = intervals[0].end;
  for (const iv of intervals) { if (iv.start < s) s = iv.start; if (iv.end > e) e = iv.end; }
  return { start: s, end: e };
}

/** Effective working window = union of the template window and the observed one. */
function unionWindow(template, observed) {
  const t = template && !template.off ? template : null;
  if (!t && !observed) return { off: true, start: null, end: null };
  if (t && !observed) return { off: false, start: t.start, end: t.end };
  if (!t && observed) return { off: false, start: observed.start, end: observed.end, fromBookings: true };
  return {
    off: false,
    start: t.start <= observed.start ? t.start : observed.start,
    end: t.end >= observed.end ? t.end : observed.end,
    fromBookings: observed.start < t.start || observed.end > t.end,
  };
}

/** The tutor's non-cancelled booked intervals on a specific ISO date. */
function bookedIntervalsOnDate(bookingRows, tutorLastFirst, isoDate) {
  const { matches } = tutorBookingsOnDate(bookingRows, tutorLastFirst, isoDate);
  return (matches || [])
    .filter(b => !CANCEL_STATUSES.has((b['Session Status'] || '').toLowerCase().trim()))
    .map(b => {
      const start = toHHMM24((b['Start Time'] || '').trim());
      const dur = durationToMinutes((b['Duration'] || '').trim()) || 60;
      // Service travels with the interval so slot-offering can tell a floor block
      // (joinable, up to 4) from a 1:1 session (blocking).
      return { start, end: addMinutes(start, dur), service: (b['Service'] || '').trim() };
    })
    .filter(iv => iv.start);
}

function isoAddDays(iso, n) {
  const d = new Date(iso + 'T12:00:00'); d.setDate(d.getDate() + n);
  return d.toISOString().slice(0, 10);
}
/** ISO date of the Monday on/after `now` (start of the next full week). */
function nextMondayISO(now) {
  const d = new Date(now); d.setHours(12, 0, 0, 0);
  const add = ((8 - d.getDay()) % 7) || 7;   // 1..7 days to the coming Monday
  d.setDate(d.getDate() + add);
  return d.toISOString().slice(0, 10);
}

/**
 * #3 Program scheduling — propose a recurring weekly schedule instead of one
 * session. For the target week, walk Mon→Sat and pick `sessionsPerWeek` open
 * slots on DISTINCT days for the anchored tutor, honoring the student's historical
 * day/time with that tutor when it's free, else the earliest open slot in the
 * window. Availability uses the effective window (template ∪ real bookings).
 * Returns { slots:[{date,day,start,end,label}], shortfall }.
 */
function buildProgramProposal({ weeklySchedule, tutorLastFirst, bookingRows, weekStartISO, sessionsPerWeek, timeWindow, durationMin, historyTutor }) {
  const prefByDay = {};
  if (historyTutor && historyTutor.slots) {
    for (const k of historyTutor.slots) { const [day, hhmm] = k.split(' '); if (day && !prefByDay[day]) prefByDay[day] = hhmm; }
  }
  const slots = [];
  const usedDays = new Set();
  for (let i = 0; i < 6 && slots.length < sessionsPerWeek; i++) {   // Mon..Sat
    const date = isoAddDays(weekStartISO, i);
    const day = DAYS[new Date(date + 'T12:00:00').getDay()];
    if (usedDays.has(day)) continue;
    const eff = unionWindow(weeklySchedule ? weeklySchedule[day] : null,
      observedWindow(tutorWeekdayIntervals(bookingRows, tutorLastFirst, day)));
    if (eff.off) continue;
    const open = computeOpenSlots({
      dayHours: eff, busyIntervals: bookedIntervalsOnDate(bookingRows, tutorLastFirst, date),
      durationMin, window: timeWindow || null, max: 8,
    });
    if (!open.length) continue;
    const pref = prefByDay[day];
    const chosen = (pref && open.find(s => s.start === pref)) || open[0];
    slots.push({ date, day, start: chosen.start, end: chosen.end, label: `${day.slice(0, 3)} ${date} ${chosen.label}` });
    usedDays.add(day);
  }
  return { slots, shortfall: Math.max(0, sessionsPerWeek - slots.length) };
}

/** Does this tutor have ANY booking with the resolved student (any date) in the CSV? */
function tutorHasStudent(csvRows, tutorLastFirst, rosterRow) {
  if (!rosterRow) return false;
  const m = tutorLastFirst.match(/^([^,]+),\s*([^(]+?)\s*\(/);
  const csvTeacher = m ? `${m[1].trim()} ${m[2].trim()}` : tutorLastFirst;
  return (csvRows || []).some(r =>
    (r['Teacher'] || '').trim() === csvTeacher &&
    isOwnStudent((r['Student Name'] || '').trim(), rosterRow));
}

// ─── action-plan templates ────────────────────────────────────────────────────

/** Pull the tutor's friendly name (e.g. "Tim" from "Corrie, Tim (Tim)"). */
function shortTutorName(lastFirst) {
  if (!lastFirst) return '';
  const m = lastFirst.match(/\(([^)]+)\)\s*$/);
  if (m) return m[1].trim();
  const c = lastFirst.match(/^[^,]+,\s*([^(]+?)\s*(?:\(|$)/);
  return c ? c[1].trim() : lastFirst;
}

/**
 * First name from an A+ Schedule-Report teacher string. That column is
 * "Last First" with no comma, which shortTutorName cannot split (it needs the
 * comma or a parenthesised nickname), so families were being told "with Ulrich
 * Connie" and "with Hamilton Leta" - surname first. Fall back to the trailing
 * token only when shortTutorName made no progress.
 */
function tutorDisplayName(name) {
  if (!name) return '';
  const short = shortTutorName(name);
  return short === name ? String(name).trim().split(/\s+/).pop() : short;
}

/**
 * "2026-08-05" -> "Wed 8/5". Reply drafts go to PARENTS; an ISO date in a text
 * message reads like a database row. Ops text (LCOS/A+ steps) keeps the ISO form,
 * where being unambiguous matters more than reading well.
 */
function familyDate(iso) {
  if (!iso) return '';
  const [y, m, d] = iso.split('-');
  return `${fmtDay(iso)} ${+m}/${+d}`;
}

function studentFirstName(rosterRow) {
  return rosterRow?.firstname || rosterRow?.firstName || 'your student';
}

// ─── subject sanity (#1 — Atlas "garbled subject" bug) ────────────────────────
// The classifier sometimes jams a whole phrase into `subject` ("makeup for Monday
// July 27th session (tutor unavailable)"), which then fails subject-mapping and
// pollutes the reply draft. Detect a non-subject and fall back to the student's
// enrolled service so qualification (already history-anchored) and the reply stay clean.
const SERVICE_LABELS = { ST: 'Subject Tutoring', S1: 'Subject Tutoring', L1: 'Learning Center', LS: 'Learning Center', A1: 'test prep' };
const SUBJECT_STOPWORDS = /\b(session|sessions|makeup|make[- ]?up|reschedul|cancel|schedule|unavailable|tutor|appointment|monday|tuesday|wednesday|thursday|friday|saturday|sunday|\d{1,2}(st|nd|rd|th)?)\b/i;

/** True if `s` reads like an actual subject (short, no scheduling/date words). */
function looksLikeSubject(s) {
  if (!s) return false;
  const t = s.trim();
  if (t.split(/\s+/).length > 4) return false;       // subjects are short ("AP Stats", "SAT prep")
  if (/\d{1,2}\/\d{1,2}/.test(t)) return false;       // contains a date
  if (SUBJECT_STOPWORDS.test(t)) return false;        // contains scheduling/date words
  return true;
}

// Request types that act on a session the student ALREADY has. For these the
// subject is whatever the student already does — there is nothing to parse and
// nothing for staff to confirm, because the tutor carries over from the existing
// session (see the reschedule carry-over in orchestrateOne). Warning on these
// produced a "Couldn't parse a subject" line on most posts, which trained staff
// to ignore the warning entirely.
const CONTINUATION_TYPES = new Set(['makeup', 'reschedule', 'cancel']);

/**
 * The subject to USE: the customer's if it's plausible, else the student's
 * service label.
 *
 * Returns `{ subject, fellBack, inherited }`:
 *   - `fellBack: true`  — we needed a real subject and could not get one. The
 *     label is a guess, so it must NOT be used to hard-block a tutor (see
 *     `subjectUnreliable` in orchestrateOne) and staff get a confirm note.
 *   - `inherited: true` — a continuation request; the service label is the
 *     right answer, not a fallback. No note, no blocking.
 */
function effectiveSubject(payload, rosterRow) {
  const svc = (rosterRow?.service || '').toUpperCase();
  const serviceLabel = SERVICE_LABELS[svc] || 'tutoring';
  const plausible = looksLikeSubject(payload.subject);
  const isContinuation = CONTINUATION_TYPES.has((payload.requestType || '').toLowerCase());

  if (plausible) return { subject: payload.subject, fellBack: false, inherited: false };
  if (isContinuation) return { subject: serviceLabel, fellBack: false, inherited: true };
  return { subject: serviceLabel, fellBack: true, inherited: false };
}

function fmtDay(iso) {
  const d = new Date(iso + 'T12:00:00');
  return ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'][d.getDay()];
}

/**
 * Build a concrete action plan + drafted text reply, keyed off the
 * recommendation. These are heuristic templates that staff edits before
 * applying. The drafted reply matches HLC's typical phrasing.
 */
function buildActionPlan(recommended, payload, tutorEvals, rosterRow) {
  const tutor = recommended.tutor || (recommended.tutors && recommended.tutors[0]) || null;
  const tutorShort = shortTutorName(tutor);
  const student = studentFirstName(rosterRow);
  const dayName = payload.proposedDate ? fmtDay(payload.proposedDate) : '';
  const dateNice = payload.proposedDate ? `${dayName} ${payload.proposedDate}` : '';
  const dateForFamily = familyDate(payload.proposedDate);   // parent-facing: "Wed 8/5"
  const timeNice = payload.proposedTime || '';
  const subject = effectiveSubject(payload, rosterRow).subject;   // #1: never echo a garbled subject

  if (recommended.action === 'SCHEDULE_INFO') {
    // Read-only: there is nothing to book, move or cancel. The reply draft IS the
    // deliverable — staff paste the answer back to the family.
    const sess = recommended.sessions || [];
    // The A+ Teacher column is "Last First" with no comma, which shortTutorName
    // cannot split (it needs the comma or a parenthesised nickname) — it would
    // hand the family "with Ulrich Connie", surname first. Take the trailing token
    // here only; the comma-less form is specific to this report field.
    const tutorFirst = tutorDisplayName;
    const dayAndDate = familyDate;   // "Wed 8/12" - never a bare weekday, see below
    // Retests are booked against a pseudo-tutor ("McRetest Retest"), so a practice
    // test would otherwise read "with Retest". Keep the session, drop the name.
    const realTutor = t => t && !/retest/i.test(t);
    const nice = sess.map(s =>
      `${dayAndDate(s.date)} at ${fmt12(s.start)}` +
      `${realTutor(s.tutor) ? ` with ${tutorFirst(s.tutor)}` : ''}` +
      `${!realTutor(s.tutor) && s.service ? ` (${s.service})` : ''}`).join(', ');
    return {
      lcos: 'Nothing to do — information request, no schedule change.',
      aplus: 'Nothing to do — information request, no schedule change.',
      payment: 'N/A.',
      // Never assert "you have nothing booked" off an empty result: the report
      // window or a name mismatch could be the reason. Hedge and let staff check.
      textReplyDraft: sess.length
        ? `Hi! ${student} is booked for ${nice}. Let us know if you'd like to change anything. - HLC Issaquah`
        : `Hi! Let me double-check ${student}'s schedule and confirm right back with you. - HLC Issaquah`,
    };
  }
  if (recommended.action === 'RESTORE') {
    const sess = recommended.sessions || [];
    const nice = sess.map(s => fmt12(s.start)).join(' and ');
    const who = tutorDisplayName(recommended.tutor) || 'their usual tutor';
    return {
      lcos: `Reinstate ${student}'s existing session(s) on ${payload.proposedDate} (${sess.map(s => s.start).join(', ')}) — ` +
        `clear the cancellation rather than inserting a new row, so the recurring schedule stays intact.`,
      aplus: `Un-cancel the existing booking(s) on ${payload.proposedDate}: ${sess.map(s => `${s.start}${s.tutor ? ` w/ ${s.tutor}` : ''}`).join('; ')}.`,
      payment: 'No new charge — this is the session they already had.',
      textReplyDraft: `Great news — we've put ${student} back on for ${dateForFamily} at ${nice}${recommended.tutor ? ` with ${who}` : ''}. See you then!`,
    };
  }
  if (recommended.action === 'RETEST_MOVE') {
    const at = recommended.time ? fmt12(recommended.time) : null;
    return {
      lcos: 'No LCOS change — practice tests are A+ bookings under the retest resource, not tutoring sessions.',
      aplus: `${recommended.sourceDate ? `Remove the ${recommended.sourceDate} retest booking and s` : 'S'}eat ${student} in the ${payload.proposedDate} retest block${at ? ` at ${at}` : ''} (McRetest resource).`,
      payment: 'No new charge for moving a practice test.',
      textReplyDraft: recommended.alreadyBooked
        ? `Hi! ${student} is already set for the practice test on ${dateForFamily}${at ? ` at ${at}` : ''}. See you then!`
        : `Hi! I've moved ${student}'s practice test to ${dateForFamily}${at ? ` at ${at}` : ''}. See you then! - HLC Issaquah`,
    };
  }
  if (recommended.action === 'PROGRAM_OFFER') {
    // #3 Program: propose the full weekly schedule for staff to confirm.
    const sch = recommended.proposedSchedule || [];
    const nice = sch.map(s => `${s.day.slice(0, 3)} ${fmt12(s.start)}`).join(', ');
    return {
      lcos: sch.length
        ? `Build a recurring ${recommended.sessionsPerWeek}×/week program for ${student} with ${tutorShort} (week of ${recommended.weekStart}): ${sch.map(s => `${s.date} ${s.start}–${s.end}`).join('; ')}.`
        : `Program request — no open slots auto-found; build the schedule manually.`,
      aplus: sch.length ? `Book the recurring sessions with ${tutorShort}: ${sch.map(s => `${s.date} ${s.start}`).join('; ')}.` : 'Hold — build manually.',
      payment: 'Confirm program tuition / hours before booking.',
      textReplyDraft: sch.length
        ? `Hi! For ${student}'s ${recommended.sessionsPerWeek}×/week schedule with ${tutorShort}, here's what we have open: ${nice}. Do these work? - HLC Issaquah`
        : `Hi! Let me put together a few schedule options for ${student} and follow up shortly. - HLC Issaquah`,
    };
  }
  if (recommended.action === 'CANCEL') {
    // #1 Cancel: no tutor reasoning; enumerate the existing session(s) to remove.
    // Sessions may span several students and dates (Duvvuru: both kids, both
    // Fridays). The ops list and the family draft both carry the full scope —
    // "I've canceled Nivin's and Kavin's sessions on 8/7 and 8/14" is what staff
    // actually sent, and the old one-date draft made the bot look like it had
    // only heard half the message.
    const sess = recommended.sessions || [];
    const list = sess.map(s =>
      `${s.date || payload.proposedDate} ${fmt12(s.start)}${s.student ? ` (${s.student})` : ''}${s.tutor ? ` w/ ${s.tutor}` : ''}`).join('; ');
    const who = [...new Set(sess.map(x => x.student).filter(Boolean))];
    const whoNice = who.length > 1
      ? who.slice(0, -1).map(n => n + "'s").join(', ') + ' and ' + who[who.length - 1] + "'s sessions"
      : `${who[0] || student}'s session${sess.length > 1 ? 's' : ''}`;
    const daysNice = [...new Set(sess.map(x => familyDate(x.date || payload.proposedDate)))].join(' and ');
    return {
      lcos: sess.length
        ? `Cancel ${sess.length} session(s) (${list}) — set the cancel attendcode per policy.`
        : `No session found to cancel on ${payload.proposedDate}; verify the date with the family.`,
      aplus: sess.length ? `Cancel the A+ session(s): ${list}.` : 'No A+ session found to cancel.',
      payment: 'No charge for a cancellation — apply credit/makeup per policy.',
      textReplyDraft: sess.length
        ? `Hi! I've canceled ${whoNice} on ${daysNice}. Let us know if you'd like to reschedule. - HLC Issaquah`
        : `Hi! I don't see a session for ${student} on ${dateForFamily} — could you confirm the date? - HLC Issaquah`,
    };
  }
  if (recommended.action === 'OFFER_SLOTS') {
    // #2 Slot-offering: present a few open times for the family to pick from.
    const slots = (recommended.suggestedSlots || []).map(s => s.label).join(', ');
    return {
      lcos: 'Hold — no write until the family picks a time.',
      aplus: 'Hold — book once the family confirms one of the offered times.',
      payment: 'Hold.',
      textReplyDraft: slots
        ? `Hi! ${tutorShort} has these times open on ${dateForFamily}: ${slots}. Which works best for ${student}? - HLC Issaquah`
        : `Hi! Let me check ${tutorShort}'s availability and send a few options shortly. - HLC Issaquah`,
    };
  }
  if (recommended.action === 'ALREADY_BOOKED') {
    return {
      lcos: `No new LCOS row needed — verify the existing session (clientid ${rosterRow?.clientid || '?'}, ${dateNice}). If its notes mention "waiting on payment", update once payment is processed.`,
      aplus: 'No new A+ booking needed — A+ already has this session.',
      payment: 'Process payment if the customer authorized it in the thread (the typical case). Handle separately from this scheduling confirmation.',
      textReplyDraft: `Confirmed! ${student}'s ${subject} session with ${tutorShort} is set for ${dateForFamily} at ${timeNice}. Thank you!`,
    };
  }
  if (recommended.action === 'PROCEED') {
    const ev = tutorEvals.find(t => t.teacher?.lastFirst === tutor)?.eval || {};
    return {
      lcos: `Insert a SPEC session for ${student} on ${payload.proposedDate} ${ev.proposedStart}–${ev.proposedEnd} (service ${rosterRow?.service || 'ST'}, attendcode EXT until paid). Note: "Scheduled via text on ${new Date().toISOString().slice(0,10)}".`,
      aplus: `Book "Subject Tutoring" with ${tutorShort} on ${payload.proposedDate} at ${ev.proposedStart} for ${payload.sessionLength || '1 hour'}.`,
      payment: 'Charge the card on file if authorized in the thread, otherwise request payment. Handle separately from this scheduling confirmation.',
      textReplyDraft: `Great! We've scheduled ${student}'s ${subject} session with ${tutorShort} for ${dateForFamily} at ${timeNice}. See you then!`,
    };
  }
  if (recommended.action === 'MULTIPLE_OPTIONS') {
    return {
      lcos: 'Hold until staff picks a tutor.',
      aplus: 'Hold until staff picks a tutor.',
      payment: 'Hold.',
      textReplyDraft: `Hi! Let me check tutor availability and get back to you shortly.`,
    };
  }
  // BLOCKED
  return {
    lcos: 'No action — request blocked. See `reason` and surface to staff.',
    aplus: 'No action — request blocked.',
    payment: 'N/A',
    textReplyDraft: `Thanks for reaching out — let me check on a few options and follow up shortly.`,
  };
}

// ─── evaluation per tutor ─────────────────────────────────────────────────────

/** True when the CSV row's student name corresponds to the resolved roster row. */
function isOwnStudent(csvStudent, rosterRow) {
  if (!csvStudent || !rosterRow) return false;
  const a = (csvStudent || '').toLowerCase().replace(/\s+/g, ' ').trim();
  const b = `${rosterRow.firstname || ''} ${rosterRow.lastname || ''}`.toLowerCase().replace(/\s+/g, ' ').trim();
  const bRev = `${rosterRow.lastname || ''} ${rosterRow.firstname || ''}`.toLowerCase().replace(/\s+/g, ' ').trim();
  return a === b || a === bRev;
}

function evalTutorForRequest(quals, schedule, csvBookings, payload, resolvedStudent, subjectTerms, observedWin) {
  const proposedStart = toHHMM24(payload.proposedTime);
  const dayName = dayNameForISO(payload.proposedDate);
  const dayHours = schedule[dayName];
  const durationMin = durationToMinutes(payload.sessionLength) || 60;
  const proposedEnd = addMinutes(proposedStart, durationMin);

  // Qualification check — match offered services against the mapped A+ service
  // terms (from subject-map.js); falls back to the raw subject if unmapped.
  const terms = (subjectTerms && subjectTerms.length) ? subjectTerms : [payload.subject];
  const offered = quals.filter(s => s.offered);
  const qualMatches = offered.filter(s => serviceMatchesAny(s.name, terms));

  // Availability check against the EFFECTIVE window (#4): the union of the A+
  // weekly template and the tutor's REAL bookings on this weekday. This stops a
  // stale "OFF" template from hiding a tutor who demonstrably works then.
  const effectiveHours = unionWindow(dayHours, observedWin);
  const inWorkingHours = !effectiveHours.off &&
    withinWindow(proposedStart, effectiveHours.start, effectiveHours.end) &&
    withinWindow(proposedEnd,   effectiveHours.start, effectiveHours.end);

  // Inspect every booking that overlaps the proposed slot. Separate
  // own-student matches ("already booked — no new action needed") from real
  // conflicts (someone else has this slot).
  const cancelStatuses = new Set(['cancelled','canceled','no-show','no show','noshow','deleted','removed','void','anm','anm - paid','anm - unpaid','absent no makeup']);
  // All of the tutor's non-cancelled bookings that day (intervals), used both
  // for the proposed-slot conflict check AND for slot-offering (free times).
  const dayBusy = (csvBookings.matches || [])
    .filter(b => !cancelStatuses.has((b['Session Status'] || '').toLowerCase()))
    .map(b => {
      const start = toHHMM24((b['Start Time'] || '').trim());
      const dur = durationToMinutes((b['Duration'] || '').trim()) || 60;
      return { start, end: addMinutes(start, dur) };
    })
    .filter(iv => iv.start);
  const overlapping = (csvBookings.matches || []).filter(b => {
    const status = (b['Session Status'] || '').toLowerCase();
    if (cancelStatuses.has(status)) return false;
    const start = toHHMM24((b['Start Time'] || '').trim());
    const dur = durationToMinutes((b['Duration'] || '').trim()) || 60;
    const end = addMinutes(start, dur);
    return overlaps(proposedStart, proposedEnd, start, end);
  });
  const ownStudentMatches = [];
  const conflicts = [];
  for (const b of overlapping) {
    const rec = {
      student: (b['Student Name'] || '').trim(),
      start: toHHMM24((b['Start Time'] || '').trim()),
      duration: (b['Duration'] || '').trim(),
      status: (b['Session Status'] || '').trim(),
      lastUpdate: (b['Last Update Date'] || '').trim(),
      updatedBy: (b['Last Updated By'] || '').trim(),
    };
    if (isOwnStudent(rec.student, resolvedStudent)) ownStudentMatches.push(rec);
    else conflicts.push(rec);
  }

  return {
    dayName, dayHours, effectiveHours, proposedStart, proposedEnd, durationMin,
    qualified: qualMatches.length > 0,
    qualMatches: qualMatches.map(s => ({ name: s.name, id: s.serviceId })),
    inWorkingHours,
    ownStudentMatches,
    conflicts,
    dayBusy,
  };
}

// ─── orchestrate one request ────────────────────────────────────────────────

/**
 * Evaluate a single request payload against a live, authenticated A+ page.
 *
 * The caller must have already run `navStaffList(page, env)` and obtained
 * `teachers` via `listTeachers(page)`. Per-teacher quals/schedule scrapes are
 * memoized in `caches` (a `{ quals: Map, schedule: Map }` keyed by eid) so a
 * batch run never re-scrapes the same tutor.
 *
 * Returns one of:
 *   { skipped: 'teacher-contact', resolution }
 *   { recommendation, resolution, tutorEvals }
 */
async function orchestrateOne({
  payload, page, teachers, roster,
  csvRows = [], csvAvailable = false,
  historyRows = null, now = new Date(),
  backtest = false, caches = null, log = () => {},
}) {
  // Step 1: resolve student. `payload.student` disambiguates multi-student
  // contacts (e.g. "Zahera Shaik (Shaheer (JB) and Sarah Shaikh)" + "JB").
  const resolution = resolveStudent(payload.contactName, roster, { student: payload.student });
  log(`[1] Student resolution: ${payload.contactName}`);
  log(`    parsed:     ${JSON.stringify(resolution.parsed)}`);
  log(`    confidence: ${resolution.confidence}`);
  if (resolution.bestMatch) {
    log(`    best match: ${resolution.bestMatch.firstname} ${resolution.bestMatch.lastname} (clientid ${resolution.bestMatch.clientid})`);
  }
  if (resolution.isTeacherContact) {
    log('    — TEACHER CONTACT, not a student request. Skipping.');
    return { skipped: 'teacher-contact', resolution };
  }

  // Step 1.4: sanity-check the subject (#1 — Atlas "garbled subject" bug), then
  // map it to canonical A+ service terms. A non-subject (a whole phrase/date jammed
  // in by the classifier) falls back to the student's enrolled service and adds a
  // clear confirm-note instead of a misleading "no mapping" warning.
  const effSubj = effectiveSubject(payload, resolution.bestMatch);
  const subjectForMap = effSubj.subject;
  const subjectResolved = resolveSubject(subjectForMap);
  const subjectTerms = subjectResolved.services;
  // A continuation (makeup/reschedule/cancel) needs no subject at all, so neither
  // the fallback warning NOR resolveSubject's "no mapping for <service label>"
  // note is useful — both are noise on a post whose tutor carries over anyway.
  const subjectNote = effSubj.inherited
    ? null
    : effSubj.fellBack
      // Do NOT claim the tutor came from history unless it did. On 2026-08-04 this
      // told staff "tutor chosen from this student's history" for Amy Kot, where
      // the student did not resolve at all and the tutor came from blind subject
      // discovery. Mariah's reply: "Xiaoying does not teach this subject."
      ? `Couldn't parse a subject from the request ("${(payload.subject || '').slice(0, 60)}") — used ${resolution.bestMatch ? `the student's usual service (${subjectForMap})` : `"${subjectForMap}"`}; ` +
        `${resolution.bestMatch ? 'confirm the subject only if it matters.' : 'the student could not be matched, so the tutor is a subject guess — check it.'}`
      : subjectResolved.note;
  // When the subject is a guess, a qualification MISS proves nothing — the tutor
  // was checked against a label the customer never said. Blocking on it produced
  // false "not qualified" BLOCKs (2026-07-15 Charlie Hirschberg: Connie was named
  // in the thread and blocked as unqualified for "1 to 1.5 hour tutoring sessions").
  const subjectUnreliable = effSubj.fellBack;
  if (effSubj.fellBack) {
    log(`    [subject] garbled input "${(payload.subject || '').slice(0, 40)}" → fallback service "${subjectForMap}" (qualification check downgraded to advisory)`);
  } else if (effSubj.inherited) {
    log(`    [subject] ${payload.requestType} of an existing session → inherited service "${subjectForMap}" (no subject needed)`);
  } else if (subjectResolved.mapped) {
    log(`    [subject] "${subjectForMap}" → [${subjectTerms.join(', ')}]${subjectResolved.ambiguous ? ' (ambiguous — note added)' : ''}`);
  }

  // Step 1.45: anchor on the student's REAL A+ session history (Mariah's fix).
  // The wide Schedule Report (`historyRows`, falling back to the narrow conflict
  // CSV) shows who actually teaches this student, on which day/time, and for how
  // long. This makes the tutor pool + duration evidence-based instead of inferred
  // from a (often guessed) subject. Cancelled rows are ignored for the pattern.
  const studentFullName = resolution.bestMatch
    ? `${resolution.bestMatch.firstname} ${resolution.bestMatch.lastname}` : null;
  const historySrc = (historyRows && historyRows.length) ? historyRows : csvRows;
  const history = studentFullName
    ? summarizeStudentHistory(historySrc, studentFullName, now)
    : { found: false, tutors: [], modalDuration: null, primaryTutor: null };
  const proposedDayName = payload.proposedDate ? dayNameForISO(payload.proposedDate) : null;
  const historyCands = history.found
    ? buildHistoryCandidates(history, { dayName: proposedDayName, time: payload.proposedTime, max: 8 })
    : [];
  if (history.found) {
    log(`    [history] ${history.tutors.length} tutor(s) for ${studentFullName}; primary ${history.primaryTutor}; ` +
        `modal duration ${history.modalDuration || '?'}; slot-match: ${historyCands.filter(h => h.slotMatch).map(h => h.tutor).join(', ') || 'none'}`);
  } else if (studentFullName) {
    log(`    [history] no A+ history rows for ${studentFullName} (narrow CSV window or new student) — falling back to subject discovery`);
  }
  // Default the session length from history when the thread didn't specify one.
  if (!payload.sessionLength && history.modalDuration) {
    payload = { ...payload, sessionLength: history.modalDuration };
    log(`    [history] session length defaulted to "${history.modalDuration}" from history`);
  }

  // Step 1.5: assemble the candidate list. Priority:
  //   1. tutors explicitly named in the thread (human signal wins)
  //   2. the student's real tutors from A+ history (the anchor)
  //   3. fallback ONLY when neither exists: subject discovery from the quals
  //      index (each still LIVE-verified below, so an incomplete index can only
  //      miss a tutor, never wrongly recommend one).
  // Admin/placeholder "teachers" (e.g. "Head Teacher") are filtered everywhere.
  // Match tutor names ACROSS formats — report "Ball Leah", roster
  // "Ball, Leah (Leah)", or a bare "Leah" — by comparing alpha tokens: the
  // smaller token set must be fully contained in the larger. (A plain substring
  // test fails on the comma/paren, e.g. "ball leah" ⊄ "ball, leah (leah)".)
  const tutorTokens = s => new Set(((s || '').toLowerCase().match(/[a-z]+/g)) || []);
  const sameTutor = (a, b) => {
    const A = tutorTokens(a), B = tutorTokens(b);
    if (!A.size || !B.size) return false;
    const [small, big] = A.size <= B.size ? [A, B] : [B, A];
    for (const t of small) if (!big.has(t)) return false;
    return true;
  };

  // #3 Disambiguate a bare first-name tutor ("Jennifer") against the STUDENT'S
  // own history first — there are several Jennifers/etc. on staff, and a global
  // substring match picks the wrong one (the back-test's Kayla false-BLOCK: bare
  // "Jennifer" → Jennifer Leath, but her real tutor is Jennifer Webb). If the
  // student's history has exactly one tutor whose name contains the token, use
  // that full "Last First" name; if several, flag it for staff.
  const tutorNote = [];
  const disambiguateNamed = (name) => {
    if (/\s/.test(name)) return name;                       // already a full name
    const tok = name.toLowerCase();
    const matches = historyCands.filter(h =>
      h.tutor.toLowerCase().split(/\s+/).includes(tok));
    if (matches.length === 1) {
      if (matches[0].tutor.toLowerCase() !== tok) {
        log(`    [disambig] named "${name}" → "${matches[0].tutor}" (this student's tutor)`);
      }
      return matches[0].tutor;
    }
    if (matches.length > 1) {
      tutorNote.push(`"${name}" is ambiguous for this student (${matches.map(m => m.tutor).join(' / ')}) — confirm which tutor.`);
    }
    return name;
  };
  // Declared here, not with the other request-type flags below, because the
  // candidate-assembly step immediately after this needs to know to skip itself.
  const isLookup = !backtest && (payload.requestType || '').toLowerCase() === 'lookup';
  const named = (payload.candidateTutors || []).filter(n => !isNonTutor(n)).map(disambiguateNamed);
  const discovered = new Set();
  let candidateNames = [...named];
  let candidateSource = named.length ? 'named' : null;

  // A `lookup` reports what is already booked. It picks no tutor, so every
  // candidate assembled here would be evaluated against the live A+ pages and
  // then thrown away — an info request costing exactly as much as a booking.
  // Skip the lot: no candidates, no discovery, no per-tutor page loads.
  if (isLookup) {
    candidateNames = [];
    candidateSource = 'n/a (lookup — no tutor selection)';
  }

  // Merge in history tutors (deduped vs named), best-ranked first.
  for (const h of historyCands) {
    if (isLookup) break;
    if (candidateNames.length >= 8) break;
    if (isNonTutor(h.tutor)) continue;
    if (!candidateNames.some(n => sameTutor(n, h.tutor))) candidateNames.push(h.tutor);
  }
  if (!candidateSource && history.found) candidateSource = 'history';

  // Fallback discovery only when we have neither a named nor a history tutor.
  const wantDiscover = !isLookup && candidateNames.length === 0;
  if (wantDiscover) {
    const qualsIndex = loadQualsIndex();
    if (!qualsIndex) {
      log('    ! no named/history tutors and aplus-quals.json not found — run fetch-aplus-quals.js');
    } else {
      const { candidates, discovered: hits, indexAge } = buildCandidateList({
        subjectTerms, named, qualsIndex, max: 8,
      });
      candidateNames = candidates.filter(n => !isNonTutor(n));
      hits.forEach(h => { if (!isNonTutor(h.tutor)) discovered.add(h.tutor); });
      candidateSource = 'discovery';
      const added = candidateNames.filter(n => !named.includes(n));
      log(`    [discover] subject [${subjectTerms.join(', ')}]: ${hits.length} qualified in index (${indexAge || 'age?'}), ` +
          `evaluating ${added.length} discovered${hits.length > added.length ? ` (capped; ${hits.length - added.length} more in index)` : ''}`);
    }
  }
  // ── staff rules, applied BEFORE any tutor is evaluated ──────────────────────
  // A `never` rule in A+ Student Notes is an explicit instruction and outranks
  // every other signal INCLUDING history: Morgan Lan's most-used tutor is
  // precisely the one her note excludes (16 sessions were booked against a rule
  // dated 8/1/2026). Filtering here also avoids paying for A+ page loads on a
  // tutor we could never propose.
  // (skipped for cancels: no tutor is being chosen, and "Leta is excluded"
  //  on a cancellation reads as noise to staff. Local flag - `isCancel` is
  //  declared further down, same hoisting trap as `isLookup`.)
  const cancelAsk = !backtest && (payload.requestType || '').toLowerCase() === 'cancel';
  if (!cancelAsk && studentFullName && candidateNames.length) {
    const kept = [];
    for (const n of candidateNames) {
      const hit = tutorRules.excludedBy(studentFullName, n, effSubj.subject);
      if (hit) {
        const scope = hit.scope ? ` for ${hit.scope}` : '';
        log(`    [rule] dropped ${n} — A+ student note says "No ${hit.name}${scope}"`);
        tutorNote.push(`${shortTutorName(n)} is excluded for this student by an A+ note ("No ${hit.name}${scope}").`);
      } else kept.push(n);
    }
    candidateNames = kept;
  }

  // Drop candidates who are no longer on the A+ roster, whatever the source.
  //
  // Discovery reads a periodically-scraped index. HISTORY is the bigger surface:
  // 144 students have a departed tutor in their session history, and for 7
  // currently-enrolled students the most-used tutor has left outright (Zoe Cable
  // has 27 sessions with a tutor who is gone). The eval step DOES catch these -
  // they come back "NOT FOUND in A+ roster" - so this is not a correctness fix;
  // it stops us paying for a live A+ page load per departed name first. Zoe's
  // request wasted 2 of 8 lookups. The NOT FOUND path stays as the backstop.
  if (candidateNames.length) {
    const kept = candidateNames.filter(n => {
      const ok = tutorRules.onRoster(n);
      if (!ok) log(`    [roster] dropped ${n} — not on the current A+ roster`);
      return ok;
    });
    candidateNames = kept;
  }

  log(`    [candidates] source=${candidateSource || 'none'}: ${candidateNames.join(', ') || '(none)'}`);

  // Step 2: per-candidate-tutor live A+ lookups (quals + schedule), then eval.
  // Bookings/conflicts use the widest data we have: the history report when
  // passed (superset that also covers the proposed date), else the narrow CSV.
  const bookingRows = (historyRows && historyRows.length) ? historyRows : csvRows;
  const bookingAvailable = bookingRows.length > 0;
  const tutorEvals = [];
  for (const want of candidateNames) {
    const lowerWant = want.toLowerCase();
    const teacher = teachers.find(t =>
      t.displayName.toLowerCase() === lowerWant ||
      t.lastFirst.toLowerCase().includes(lowerWant) ||
      (t.firstName && t.lastName &&
       `${t.firstName} ${t.lastName}`.toLowerCase() === lowerWant) ||
      // A+ Schedule-Report names are "Last First" with no comma (e.g. "Key
      // Ashley") — match that against the roster's parsed last/first too.
      (t.firstName && t.lastName &&
       `${t.lastName} ${t.firstName}`.toLowerCase() === lowerWant)
    );
    if (!teacher) {
      log(`    - ${want}: NOT FOUND in A+ roster`);
      tutorEvals.push({ candidate: want, found: false });
      continue;
    }

    // Memoized quals/schedule scrape — keyed by eid, shared across cases.
    let quals, schedule, fromCache = false;
    if (caches && caches.quals.has(teacher.eid)) {
      quals = caches.quals.get(teacher.eid);
      schedule = caches.schedule.get(teacher.eid);
      fromCache = true;
    } else {
      quals = await getTeacherQuals(page, teacher);
      schedule = await getTeacherSchedule(page, teacher);
      if (caches) { caches.quals.set(teacher.eid, quals); caches.schedule.set(teacher.eid, schedule); }
    }
    log(`    - ${teacher.lastFirst} (eid ${teacher.eid}): quals + schedule${fromCache ? ' [cached]' : ''}`);

    const bookings = (bookingAvailable && payload.proposedDate)   // no single date for a program request
      ? tutorBookingsOnDate(bookingRows, teacher.lastFirst, payload.proposedDate)
      : { matches: [], csvTeacher: null };
    // #4 real availability: the tutor's actual working span on this weekday,
    // derived from their real bookings (unioned with the template inside eval).
    const obsWin = payload.proposedDate && bookingAvailable
      ? observedWindow(tutorWeekdayIntervals(bookingRows, teacher.lastFirst, dayNameForISO(payload.proposedDate)))
      : null;
    const ev = evalTutorForRequest(quals, schedule, bookings, payload, resolution.bestMatch, subjectTerms, obsWin);
    // History match: a tutor who actively teaches THIS student is qualification-
    // proven regardless of the subject string (important for Learning Center
    // students whose A+ service doesn't map cleanly to a subject term).
    const histEntry = historyCands.find(h => sameTutor(h.tutor, teacher.lastFirst) || sameTutor(h.tutor, want));
    tutorEvals.push({
      candidate: want,
      found: true,
      discovered: discovered.has(want),
      fromHistory: !!histEntry,
      historyScore: histEntry ? histEntry.score : 0,
      historySlotMatch: histEntry ? histEntry.slotMatch : false,
      isStudentsTutor: !!histEntry || (bookingAvailable ? tutorHasStudent(bookingRows, teacher.lastFirst, resolution.bestMatch) : false),
      teacher: { eid: teacher.eid, lastFirst: teacher.lastFirst, displayName: teacher.displayName },
      eval: ev,
      weeklySchedule: schedule,          // #3: needed to propose a full-week program
      servicesOfferedCount: quals.filter(q => q.offered).length,
    });
    log(`       qualified: ${ev.qualified ? 'YES (' + ev.qualMatches.map(q => q.name).join(', ') + ')' : (histEntry ? 'via history (active tutor for this student)' : 'no')}`);
    const eh = ev.effectiveHours;
    log(`       ${ev.dayName} hours: ${eh && !eh.off ? eh.start + '–' + eh.end + (eh.fromBookings ? ' (extended by real bookings)' : '') : 'OFF'}` +
        `${ev.dayHours && ev.dayHours.off && eh && !eh.off ? ` [template said OFF]` : ''}`);
    log(`       proposed slot ${ev.proposedStart}–${ev.proposedEnd} within hours: ${ev.inWorkingHours}`);
    log(`       own-student matches (already booked):  ${ev.ownStudentMatches.length}`);
    log(`       conflicts (other students at this slot): ${ev.conflicts.length}`);
  }

  // Step 3: build recommendation — request-type aware. Back-test mode stays on
  // the original single PROCEED/ALREADY_BOOKED/BLOCKED path so its ground-truth
  // comparison remains comparable; the new branches are live-only.
  const reqType = (payload.requestType || '').toLowerCase();
  const isProgram = !backtest && (reqType === 'program' || reqType === 'new-program' || Number(payload.sessionsPerWeek) >= 2);
  const isCancel = !backtest && !isProgram && reqType === 'cancel';
  const isReschedule = !backtest && !isProgram && (reqType === 'reschedule' || reqType === 'makeup');
  const noExactTime = !backtest && !isProgram && !payload.proposedTime;

  const CANCELLED = new Set(['cancelled','canceled','no-show','no show','noshow','deleted','removed','void','anm','anm - paid','anm - unpaid','absent no makeup']);
  // The student's non-cancelled sessions on an ISO date, across ALL tutors —
  // used to cancel, and to find the "from" tutor of a reschedule.
  function studentSessionsOn(isoDate, rosterRow = resolution.bestMatch) {
    if (!isoDate || !bookingAvailable || !rosterRow) return [];
    const mdy = isoToMDY(isoDate);
    return bookingRows
      .filter(r => isOwnStudent((r['Student Name'] || '').trim(), rosterRow)
        && (r['Session Date'] || '').trim() === mdy
        && !CANCELLED.has((r['Session Status'] || '').toLowerCase()))
      .map(r => ({ tutor: (r['Teacher'] || '').trim(), start: toHHMM24((r['Start Time'] || '').trim()), duration: (r['Duration'] || '').trim() }));
  }
  /**
   * Retests are proctored practice tests booked under a pseudo-tutor
   * ("McRetest Retest") that the tutor-selection path deliberately excludes -
   * which is why Arjun's "move his SAT retest to Friday" got a subject tutor's
   * teaching slots instead of the Friday test block. These helpers see what the
   * recommender's candidate machinery cannot.
   */
  function studentRetestOn(isoDate, rosterRow = resolution.bestMatch) {
    if (!isoDate || !bookingAvailable || !rosterRow) return [];
    const mdy = isoToMDY(isoDate);
    return bookingRows.filter(r => /retest/i.test((r['Teacher'] || '').trim())
      && isOwnStudent((r['Student Name'] || '').trim(), rosterRow)
      && (r['Session Date'] || '').trim() === mdy
      && !CANCELLED.has((r['Session Status'] || '').toLowerCase()))
      .map(r => ({ start: toHHMM24((r['Start Time'] || '').trim()), duration: (r['Duration'] || '').trim(), service: (r['Service'] || '').trim() }));
  }
  /** The proctored block already running on a date: [{start, count}] by start time. */
  function retestBlockOn(isoDate) {
    if (!isoDate || !bookingAvailable) return [];
    const mdy = isoToMDY(isoDate);
    const byStart = new Map();
    for (const r of bookingRows) {
      if (!/retest/i.test((r['Teacher'] || '').trim())) continue;
      if ((r['Session Date'] || '').trim() !== mdy) continue;
      if (CANCELLED.has((r['Session Status'] || '').toLowerCase())) continue;
      const start = toHHMM24((r['Start Time'] || '').trim());
      if (!start) continue;
      byStart.set(start, (byStart.get(start) || 0) + 1);
    }
    return [...byStart.entries()].map(([start, count]) => ({ start, count }))
      .sort((a, b) => a.start.localeCompare(b.start));
  }

  // Resolve a sibling named in a sessions[] entry, memoized. Falls back to the
  // primary student when the entry names nobody or the name doesn't clear the
  // resolution floor - never guesses a different child.
  const siblingCache = new Map();
  function rosterRowFor(studentName) {
    if (!studentName) return resolution.bestMatch;
    const key = studentName.toLowerCase();
    if (!siblingCache.has(key)) {
      const r = resolveStudent(payload.contactName, roster, { student: studentName });
      siblingCache.set(key, r.bestMatch || null);
    }
    return siblingCache.get(key) || resolution.bestMatch;
  }
  /**
   * The student's CANCELLED sessions on a date — the pool a restore draws from.
   *
   * Mariah, 2026-08-01, on a family asking for Morgan to come in on Tue 8/4:
   * "Morgan already normally has a session on Tuesdays at 10am, so they were
   * probably looking to come in at their usual time (so 'uncancelling' the
   * session)." The bot instead proposed a brand-new 4:30pm slot with a different
   * tutor, because it had no concept of restoring what was already there.
   */
  function studentCancelledSessionsOn(isoDate) {
    if (!isoDate || !bookingAvailable) return [];
    const mdy = isoToMDY(isoDate);
    return bookingRows
      .filter(r => isOwnStudent((r['Student Name'] || '').trim(), resolution.bestMatch)
        && (r['Session Date'] || '').trim() === mdy
        && CANCELLED.has((r['Session Status'] || '').toLowerCase()))
      .map(r => ({
        tutor: (r['Teacher'] || '').trim(),
        start: toHHMM24((r['Start Time'] || '').trim()),
        duration: (r['Duration'] || '').trim(),
        service: (r['Service'] || '').trim(),
      }))
      .sort((a, b) => String(a.start).localeCompare(String(b.start)));
  }

  /**
   * Every non-cancelled session this student has from `fromISO` forward, across
   * ALL tutors, for `days` days. Backs the read-only `lookup` request type.
   *
   * bookingRows is the wide A+ schedule report (about -150/+45 days), so the
   * forward side is already there; no extra pull.
   */
  function studentUpcomingSessions(fromISO, days) {
    if (!bookingAvailable || !fromISO) return [];
    const toISO = isoAddDays(fromISO, days);
    return bookingRows
      .filter(r => isOwnStudent((r['Student Name'] || '').trim(), resolution.bestMatch)
        && !CANCELLED.has((r['Session Status'] || '').toLowerCase()))
      .map(r => {
        const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec((r['Session Date'] || '').trim());
        if (!m) return null;
        return {
          date: `${m[3]}-${String(+m[1]).padStart(2, '0')}-${String(+m[2]).padStart(2, '0')}`,
          tutor: (r['Teacher'] || '').trim(),
          start: toHHMM24((r['Start Time'] || '').trim()),
          duration: (r['Duration'] || '').trim(),
          service: (r['Service'] || '').trim(),
        };
      })
      .filter(s => s && s.date >= fromISO && s.date < toISO)
      .sort((a, b) => a.date.localeCompare(b.date) || String(a.start).localeCompare(String(b.start)));
  }

  const evalFor = (name) => name && tutorEvals.find(t => t.found && t.teacher && (sameTutor(t.teacher.lastFirst, name) || sameTutor(t.candidate, name)));
  // #2 Build an OFFER_SLOTS recommendation for a tutor (their free times that day).
  function offerFor(tEval, label) {
    const slots = tEval && tEval.eval ? computeOpenSlots({
      dayHours: tEval.eval.effectiveHours || tEval.eval.dayHours, busyIntervals: tEval.eval.dayBusy || [],
      durationMin: tEval.eval.durationMin, window: payload.timeWindow || null, max: 4,
      // A request carries no service of its own, so use what this student is
      // actually booked for. A floor student may join a floor block; everyone
      // else still needs the tutor to themselves.
      forService: history.modalService || null,
    }) : [];
    if (!slots.length) return null;
    return {
      action: 'OFFER_SLOTS', tutor: tEval.teacher.lastFirst, suggestedSlots: slots,
      reason: `${label} — proposing ${slots.length} open time(s) with ${shortTutorName(tEval.teacher.lastFirst)} on ${dayNameForISO(payload.proposedDate)}: ${slots.map(s => s.label).join(', ')}.`,
    };
  }

  // A history tutor is qualification-proven by the fact they teach this student.
  // And when the subject itself is a guess (`subjectUnreliable`), a qualification
  // miss is not evidence of anything — treat the check as advisory rather than
  // disqualifying, and surface it as a note instead.
  const qualOk = t => t.eval.qualified || t.fromHistory || subjectUnreliable;
  const usable = tutorEvals.filter(t => t.found && t.eval &&
    qualOk(t) && t.eval.inWorkingHours && t.eval.conflicts.length === 0);

  // #1 Reschedule/makeup: tutor carries over from the EXISTING session rather
  // than being re-ranked by the new slot (which drifted Lydia's reschedule to
  // the wrong tutor). Prefer the `fromDate` session's tutor, else history primary.
  let preferredTutor = null;
  if (isReschedule) {
    if (payload.fromDate) {
      const from = studentSessionsOn(payload.fromDate)[0];
      if (from && from.tutor) preferredTutor = from.tutor;
    }
    if (!preferredTutor && history.primaryTutor) preferredTutor = history.primaryTutor;
    if (preferredTutor) log(`    [reschedule] carry-over tutor: ${preferredTutor}`);
  }

  // Mariah, 2026-08-04: "we try to prioritize LC teachers for LC students, and
  // EP/ST teachers for EP/ST students, even if they are able to teach both."
  // PRIORITIZE, not restrict - so category ranks and never excludes. 29% of
  // recommendations already end in BLOCKED, and turning "an imperfect tutor"
  // into "no tutor" would be a worse answer for staff, not a safer one.
  // Weights: history still dominates; category (600) sits under isStudentsTutor
  // (1000) so a student's own tutor is never demoted, but well above the
  // discovery tie-breakers - which is where all three wrong-category picks came
  // from.
  const rankUsable = t => {
    const name = (t.teacher && t.teacher.lastFirst) || t.candidate || '';
    return (t.fromHistory ? 5000 + (t.historyScore || 0) : 0) +
      (t.isStudentsTutor ? 1000 : 0) + (!t.discovered ? 100 : 0) +
      tutorRules.categoryFit(name, resolution.bestMatch) * 600 +
      (tutorRules.preferredFor(studentFullName, name) ? 800 : 0) -
      (t.servicesOfferedCount || 0) * 0.1;
  };

  // Restore pool: cancelled sessions on the requested date, but only when the
  // student has nothing ACTIVE that day (else this is an already-booked case, not
  // a restore) and the request is not itself a cancellation. If the family named a
  // time, require a cancelled session at that time.
  // A retest ask never selects a tutor: the customer names the test in their own
  // words, or the session being moved IS a retest booking. Declared here rather
  // than with the hoisted flags because studentRetestOn reads bookingRows, which
  // does not exist yet at that point (the same TDZ trap isCancel hit).
  const isRetestAsk = !backtest && !isLookup && !isCancel && (
    /retest|practice test|mock (sat|act)|proctor/i.test(payload.subject || '')
    || (!!payload.fromDate && studentRetestOn(payload.fromDate).length > 0)
  );

  const restorable = (() => {
    if (isLookup || isCancel || isProgram || !payload.proposedDate) return [];
    // A reschedule/makeup carries a SOURCE session being moved; a cancelled
    // session that happens to sit on the target date is coincidence, not the
    // thing the family wants back. Replaying Lydia's reschedule showed RESTORE
    // hijacking it and proposing the wrong tutor entirely. "Put us back on"
    // arrives as new-session (Morgan Lan, Max Mark - both graded correct).
    if (isReschedule) return [];
    if (studentSessionsOn(payload.proposedDate).length) return [];
    const pool = studentCancelledSessionsOn(payload.proposedDate)
      // Never propose reinstating a session with someone who has left: the
      // Susie replay offered to restore a slot with Goldroot Hana, departed.
      .filter(s => !s.tutor || tutorRules.onRoster(s.tutor));
    const wantHHMM = payload.proposedTime ? toHHMM24(payload.proposedTime) : null;
    return wantHHMM ? pool.filter(s => s.start === wantHHMM) : pool;
  })();

  let recommended;
  if (isLookup) {
    // #0 Lookup: the family is asking what is ALREADY on the calendar, not asking
    // to change it ("what time is Ryan's class today?", "confirming we're still
    // Mon/Thu 5:30"). Staff answer these by hand today, usually after hours, and
    // the answer is already sitting in the A+ report we pull every pass.
    //
    // Deliberately READ-ONLY and tutor-logic-free: no availability check, no
    // ranking, no proposal. Being wrong here misstates a schedule; it cannot
    // double-book anyone. That is why this branch runs before every other one.
    const fromISO = payload.proposedDate || centerToday(now);
    const windowDays = payload.proposedDate ? 1 : LOOKUP_WINDOW_DAYS;
    const sessions = studentUpcomingSessions(fromISO, windowDays);
    recommended = {
      action: 'SCHEDULE_INFO',
      sessions,
      windowFrom: fromISO,
      windowDays,
      reason: sessions.length
        ? `${studentFirstName(resolution.bestMatch)} has ${sessions.length} session(s) ` +
          `${payload.proposedDate ? `on ${fromISO}` : `in the next ${windowDays} days`} — information only, nothing to change.`
        : `No sessions found for ${studentFirstName(resolution.bestMatch)} ` +
          `${payload.proposedDate ? `on ${fromISO}` : `in the next ${windowDays} days`}. ` +
          `Confirm with staff before telling the family they have nothing booked.`,
    };
  } else if (isProgram) {
    // #3 Program request ("3 sessions per week"): propose a recurring WEEKLY
    // schedule with the anchored tutor, not a single session (Mariah: Abhi
    // "needs a complete schedule, not just an individual session").
    const perWeek = Math.max(2, Number(payload.sessionsPerWeek) || 2);
    const anchorName = named[0] || history.primaryTutor
      || [...usable].sort((a, b) => rankUsable(b) - rankUsable(a))[0]?.teacher.lastFirst;
    const tEval = evalFor(anchorName) || tutorEvals.find(t => t.found && t.weeklySchedule);
    const weekStart = payload.weekStart
      || (payload.proposedDate ? isoAddDays(payload.proposedDate, -((new Date(payload.proposedDate + 'T12:00:00').getDay() + 6) % 7)) : nextMondayISO(now));
    const durationMin = durationToMinutes(payload.sessionLength) || (tEval && tEval.eval && tEval.eval.durationMin) || 60;
    const histTutor = (tEval && history.tutors) ? history.tutors.find(t => sameTutor(t.tutor, tEval.teacher.lastFirst)) : null;
    const prop = tEval ? buildProgramProposal({
      weeklySchedule: tEval.weeklySchedule, tutorLastFirst: tEval.teacher.lastFirst,
      bookingRows, weekStartISO: weekStart, sessionsPerWeek: perWeek,
      timeWindow: payload.timeWindow || null, durationMin, historyTutor: histTutor,
    }) : { slots: [], shortfall: perWeek };
    log(`    [program] ${perWeek}×/week with ${tEval ? tEval.teacher.lastFirst : (anchorName || '?')}, week of ${weekStart}: ${prop.slots.length} slot(s)`);
    recommended = {
      action: 'PROGRAM_OFFER',
      tutor: tEval ? tEval.teacher.lastFirst : null,
      sessionsPerWeek: perWeek,
      weekStart,
      proposedSchedule: prop.slots,
      shortfall: prop.shortfall,
      reason: prop.slots.length
        ? `Program: ${prop.slots.length}${prop.shortfall ? ` of ${perWeek} (only ${prop.slots.length} open day(s) found in the window)` : ''} weekly session(s) with ${tEval ? shortTutorName(tEval.teacher.lastFirst) : '?'} — ${prop.slots.map(s => s.label).join('; ')}.`
        : `Program request (${perWeek}×/week) but no open slots found${payload.timeWindow ? ' in the requested window' : ''} — staff to build the schedule manually.`,
    };
  } else if (isCancel) {
    // #1 Cancel: no tutor reasoning — just identify the session(s) to cancel.
    //
    // A cancel is routinely a FAMILY-scope ask. Duvvuru, 2026-08-01: "cancel
    // Friday sessions on 08/07 and 08/14 for both Nivin and Kavin" — four
    // appointments. The classifier captured all four in its notes and the
    // single proposedDate then threw three away; staff had to catch the rest
    // from prose. `sessions[]` carries the full scope; the old single-date
    // payload remains the one-entry case of the same path.
    const wanted = (Array.isArray(payload.sessions) && payload.sessions.length)
      ? payload.sessions
      : [{ student: null, date: payload.proposedDate }];
    const sessions = [];
    for (const w of wanted) {
      if (!w || !w.date) continue;
      const row = rosterRowFor(w.student);
      for (const s of studentSessionsOn(w.date, row)) {
        sessions.push({ ...s, date: w.date, student: studentFirstName(row) });
      }
    }
    const who = [...new Set(sessions.map(s => s.student))];
    const days = [...new Set(sessions.map(s => s.date))];
    recommended = {
      action: 'CANCEL',
      sessions,
      reason: sessions.length
        ? `Cancel ${sessions.length} existing session(s) for ${who.join(' and ')} across ${days.length} day(s) (${days.join(', ')}) — no tutor selection needed.`
        : `No existing (non-cancelled) session found for this ask (${wanted.map(w => w.date).join(', ')}); confirm the date(s) with staff.`,
    };
  } else if (isRetestAsk) {
    // #0a Retest move: the "session" being moved is a proctored test seat, not a
    // tutor booking. Join the target day's existing block when there is one
    // (staff moved Arjun "Saturday -> Friday 9:00am" by seating him in the
    // Friday block); otherwise keep the student's own test time; otherwise leave
    // the time to staff rather than inventing one.
    const block = retestBlockOn(payload.proposedDate);
    const source = payload.fromDate ? studentRetestOn(payload.fromDate) : [];
    const already = studentRetestOn(payload.proposedDate);
    const at = already.length ? already[0].start
      : block.length ? block[0].start
      : (source.length ? source[0].start : (payload.proposedTime ? toHHMM24(payload.proposedTime) : null));
    recommended = {
      action: 'RETEST_MOVE',
      time: at,
      sourceDate: payload.fromDate || null,
      existingBlock: block,
      alreadyBooked: already.length > 0,
      reason: already.length
        ? `${studentFirstName(resolution.bestMatch)} already has a practice test on ${payload.proposedDate} at ${fmt12(already[0].start)} — confirm, don't rebook.`
        : block.length
          ? `Seat the practice test in the existing ${payload.proposedDate} block at ${fmt12(block[0].start)} (${block[0].count} student(s) already in it)${payload.fromDate ? `; remove the ${payload.fromDate} booking` : ''}.`
          : `No proctored block exists on ${payload.proposedDate} yet${at ? ` — propose ${fmt12(at)} (their current test time)` : ' — staff to pick the seat time'}${payload.fromDate ? `, and remove the ${payload.fromDate} booking` : ''}.`,
    };
  } else if (restorable.length) {
    // #0b Restore: the family wants their USUAL slot back, not a new one. Only
    // fires when nothing active is already on that date (otherwise there is
    // nothing to restore) and, if they named a time, when a cancelled session
    // actually sits at it — asking for 3pm should not silently reinstate 10am.
    const tutors = [...new Set(restorable.map(s => s.tutor).filter(Boolean))];
    recommended = {
      action: 'RESTORE',
      sessions: restorable,
      tutor: tutors.length === 1 ? tutors[0] : null,
      reason: `${studentFirstName(resolution.bestMatch)} already has ${restorable.length} cancelled ` +
        `session(s) on ${payload.proposedDate}${tutors.length ? ` with ${tutors.join(', ')}` : ''} — ` +
        `reinstate the existing slot(s) rather than booking something new.`,
    };
  } else if (noExactTime && studentSessionsOn(payload.proposedDate).length) {
    // The family named a day with no time — and they already HAVE a session that
    // day. Staff answer this by pointing at the booking ("You do indeed have
    // sessions today", Anica 8/4), not by hunting for open slots that all clash
    // with it and giving up. Replay caught the old behaviour twice: Melia and
    // Ellen both came back BLOCKED for days they were already booked.
    const own = studentSessionsOn(payload.proposedDate);
    recommended = {
      action: 'ALREADY_BOOKED',
      tutor: own[0].tutor || null,
      existing: { start: own[0].start, duration: own[0].duration },
      reason: `${studentFirstName(resolution.bestMatch)} already has ${own.length} session(s) on ` +
        `${payload.proposedDate}: ${own.map(s => `${fmt12(s.start)}${s.tutor ? ' w/ ' + tutorDisplayName(s.tutor) : ''}`).join(', ')} — confirm rather than book anew.`,
    };
  } else if (noExactTime) {
    // #2 No exact time (family gave a range / none) → offer the preferred or
    // best-ranked tutor's open slots that day.
    const target = (preferredTutor && evalFor(preferredTutor))
      || [...usable].sort((a, b) => rankUsable(b) - rankUsable(a))[0]
      || tutorEvals.find(t => t.found && t.eval);
    recommended = offerFor(target, payload.timeWindow ? 'no exact time given (within requested window)' : 'no exact time given')
      || { action: 'BLOCKED', reason: target ? `${shortTutorName(target.teacher.lastFirst)} has no open ${target.eval.durationMin}-min slot that day${payload.timeWindow ? ' in the requested window' : ''}.` : 'no candidate tutor to offer slots for.' };
  } else {
    // An own-student booking at the slot is authoritative (real A+ data): it
    // means ALREADY_BOOKED even if the tutor's weekly TEMPLATE says off that day.
    // Templates lag reality (e.g. summer changes) — the actual booking wins.
    // When several of the student's tutors overlap the slot (e.g. a split-topic
    // session), prefer the reschedule carry-over tutor so we report continuity.
    const alreadyMatches = backtest ? [] : tutorEvals.filter(t => t.found && t.eval && t.eval.ownStudentMatches.length > 0);
    const alreadyBooked = alreadyMatches.find(t => preferredTutor && sameTutor(t.teacher.lastFirst, preferredTutor)) || alreadyMatches[0];
    const preferredUsable = isReschedule && preferredTutor && usable.find(t => sameTutor(t.teacher.lastFirst, preferredTutor));
    if (alreadyBooked && isReschedule && !payload.fromDate) {
      // The family asked to MOVE a session, and the booking sitting at exactly
      // the proposed slot is that session — the SOURCE, not the target. Saying
      // "already booked, just confirm" answers the opposite of what they asked:
      // Kim Magill wanted the 8/20 1:00pm moved, the bot confirmed it, staff
      // cancelled it. With no separate fromDate there is no target to book, so
      // the honest answer is that staff need the family's new day/time.
      const ex = alreadyBooked.eval.ownStudentMatches[0];
      recommended = {
        action: 'BLOCKED',
        reason: `the family wants to MOVE the ${payload.proposedDate}${ex?.start ? ' ' + ex.start : ''} session` +
          ` with ${shortTutorName(alreadyBooked.teacher.lastFirst)} but gave no new day/time — ask what works and rebook.`,
      };
    } else if (alreadyBooked) {
      recommended = {
        action: 'ALREADY_BOOKED', tutor: alreadyBooked.teacher.lastFirst,
        existing: alreadyBooked.eval.ownStudentMatches[0],
        reason: 'A+ already has this session booked for the same student/tutor/slot — no scheduling action needed (verify any pending payment/confirmation steps).',
      };
    } else if (preferredUsable) {
      // #1 reschedule: move to the SAME tutor, free at the new time.
      recommended = {
        action: 'PROCEED', tutor: preferredUsable.teacher.lastFirst,
        reason: `reschedule — keep the same tutor (${shortTutorName(preferredUsable.teacher.lastFirst)}); free at the requested time.`,
        anchoredOnHistory: true,
        alternatives: usable.filter(t => t !== preferredUsable).map(t => t.teacher.lastFirst),
      };
    } else if (isReschedule && preferredTutor && evalFor(preferredTutor)) {
      // #1+#2 reschedule: same tutor but NOT free at the requested time → offer
      // that tutor's open slots rather than silently switching tutors.
      recommended = offerFor(evalFor(preferredTutor), `reschedule — ${shortTutorName(preferredTutor)} isn't free at the requested time`);
    }

    if (!recommended) {
      if (usable.length >= 1) {
        const ranked = [...usable].sort((a, b) => rankUsable(b) - rankUsable(a));
        const best = ranked[0];
        const why = best.fromHistory
          ? (best.historySlotMatch
              ? "the student's regular tutor for this day/time (from A+ session history)"
              : "one of the student's established tutors (from A+ session history)")
          : best.isStudentsTutor ? "the student's current tutor — qualified & available"
          : !best.discovered ? 'the tutor named in the thread — qualified & available'
          : 'qualified & available (auto-selected for this subject)';
        recommended = {
          action: 'PROCEED', tutor: best.teacher.lastFirst, reason: why,
          anchoredOnHistory: !!best.fromHistory,
          alternatives: ranked.slice(1).map(r => r.teacher.lastFirst),
        };
      } else {
        const evaluated = tutorEvals.filter(t => t.found && t.eval);
        const qualified = evaluated.filter(qualOk);
        const qualAvail = qualified.filter(t => t.eval.inWorkingHours);
        // #2 Before BLOCKING, try offering the best candidate's open slots that
        // day — the requested time may be taken but others are free.
        const offerTarget = (preferredTutor && evalFor(preferredTutor))
          || [...qualified].sort((a, b) => rankUsable(b) - rankUsable(a))[0];
        const offer = !backtest && offerTarget ? offerFor(offerTarget, 'requested time unavailable') : null;
        if (offer) {
          recommended = offer;
        } else {
          const names = list => list.map(t => t.teacher.lastFirst).join(', ');
          let why;
          if (evaluated.length === 0) {
            why = wantDiscover
              ? `no tutor qualified for "${payload.subject}" found in the quals index (index may be stale/incomplete — refresh fetch-aplus-quals.js, or name a tutor)`
              : 'no candidate evaluated';
          } else if (qualified.length === 0) {
            // Quote the subject we actually checked against, not the raw thread
            // text — "not qualified for '1 to 1.5 hour tutoring sessions'" reads
            // like a bug to staff, because it is one.
            why = `none of the ${evaluated.length} evaluated tutor(s) are qualified for "${subjectForMap}" (checked: ${names(evaluated)})`;
          } else if (qualAvail.length === 0) {
            why = `qualified tutor(s) [${names(qualified)}] are not available ${payload.proposedTime} on ${qualified[0].eval.dayName}`;
          } else {
            why = `qualified + available tutor(s) [${names(qualAvail)}] all have conflicting bookings at the slot`;
          }
          recommended = { action: 'BLOCKED', reason: why };
        }
      }
    }
  }

  // A multi-session ask that ISN'T a cancel still gets a single recommendation
  // today (tutor selection per extra session is future work) — but the scope must
  // never be silently dropped again: say plainly what else the family asked for.
  if (!isCancel && Array.isArray(payload.sessions) && payload.sessions.length > 1) {
    const extra = payload.sessions.slice(1)
      .map(w => `${w.date}${w.time ? ' ' + w.time : ''}${w.student ? ' (' + w.student + ')' : ''}`).join('; ');
    tutorNote.push(`This ask covers ${payload.sessions.length} sessions — recommending the first; staff also need: ${extra}.`);
  }

  const actionPlan = buildActionPlan(recommended, payload, tutorEvals, resolution.bestMatch);
  // Mariah, 2026-08-01, on an otherwise-correct cancellation reply: "Response was
  // fine, but would be better to add something wishing Layla a happy camping trip."
  //
  // The classifier supplies this line, because writing a natural courtesy is the
  // one part of a draft a template cannot do - it depends on WHY the family wrote
  // in. The templates stay deterministic and the phrase is simply appended. The
  // prompt tells it to omit `courtesy` for anything sensitive (illness, family
  // difficulty), so an absent phrase is the normal case, not a failure.
  const COURTESY_OK = new Set(['PROCEED','CANCEL','RESTORE','ALREADY_BOOKED','OFFER_SLOTS','PROGRAM_OFFER','SCHEDULE_INFO']);
  const nothingFound = Array.isArray(recommended.sessions) && recommended.sessions.length === 0;
  if (actionPlan && actionPlan.textReplyDraft && payload.courtesy
      && COURTESY_OK.has(recommended.action) && !nothingFound) {
    // Sit it BEFORE the sign-off, not after it: appending blindly produced
    // "... - HLC Issaquah Have a great time at camp!".
    const courtesy = String(payload.courtesy).trim();
    const SIGNOFF = /\s*[-\u2013\u2014]\s*HLC Issaquah\s*$/;
    const draft = actionPlan.textReplyDraft;
    const sign = draft.match(SIGNOFF);
    actionPlan.textReplyDraft = sign
      ? draft.replace(SIGNOFF, ` ${courtesy}${sign[0]}`)
      : `${draft} ${courtesy}`;
  }

  // Back-test comparison: predicted vs what staff actually did.
  let comparison = null;
  if (backtest) {
    const groundTruth = tutorEvals.flatMap(t => (t.eval?.ownStudentMatches || []).map(m => ({
      tutor: t.teacher?.lastFirst,
      start: m.start,
      duration: m.duration,
      status: m.status,
      lastUpdate: m.lastUpdate,
      updatedBy: m.updatedBy,
    })));
    const predictedTutor = recommended.tutor || (recommended.tutors && recommended.tutors[0]) || null;
    const tutorMatches = groundTruth.length > 0 && groundTruth.some(g => g.tutor === predictedTutor);
    const proceeded = ['PROCEED', 'MULTIPLE_OPTIONS'].includes(recommended.action);
    comparison = {
      groundTruth,
      predicted: { action: recommended.action, tutor: predictedTutor },
      matchVerdict:
        !groundTruth.length ? 'no-ground-truth'        // staff hadn't acted; can't compare
        : !proceeded         ? 'agent-blocked-but-staff-acted'
        : tutorMatches       ? 'match'                  // predicted same tutor staff used
        : 'mismatch',                                   // predicted different tutor
      notes:
        !groundTruth.length ? 'No existing own-student booking at the proposed slot — cannot compare against staff outcome.'
        : tutorMatches       ? 'Agent recommended the same tutor staff actually booked.'
        : `Agent recommended ${predictedTutor || '(none)'}, staff booked ${groundTruth.map(g => g.tutor).join('/')}.`,
    };
  }

  // #1 stale-thread / past-date guard — flag likely-stale requests (the Atlas
  // "acting on a May message" case) so staff don't trust a confidently-wrong rec.
  const staleBits = [];
  const todayMid = new Date(now); todayMid.setHours(0, 0, 0, 0);
  if (payload.proposedDate) {
    const pd = new Date(payload.proposedDate + 'T12:00:00');
    if (!isNaN(pd) && pd < todayMid) staleBits.push(`⚠️ proposed date ${payload.proposedDate} is in the PAST — likely acting on an old message; re-check the thread.`);
  }
  if (payload.latestInboundDate) {
    const li = new Date(payload.latestInboundDate + 'T12:00:00');
    if (!isNaN(li)) {
      const days = Math.floor((todayMid - li) / 86400000);
      if (days >= 14) staleBits.push(`⚠️ latest customer text is ~${days} days old — verify this is a current request.`);
    }
  }
  const staleNote = staleBits.join(' ') || null;

  const recommendation = {
    contactName: payload.contactName,
    requestType: payload.requestType,
    mode: backtest ? 'backtest' : 'live',
    // A lookup picks no tutor and needs no subject, so the subject-fallback and
    // tutor-disambiguation caveats do not apply — and saying "tutor chosen from
    // this student's history" on a read-only answer is simply untrue. Keep only
    // an explicit note and the stale-thread flag.
    note: (isLookup
      ? [payload.note, staleNote]
      : [payload.note || subjectNote, ...tutorNote, staleNote]
    ).filter(Boolean).join(' ') || null,
    student: resolution.bestMatch && {
      clientid: resolution.bestMatch.clientid,
      name: `${resolution.bestMatch.firstname} ${resolution.bestMatch.lastname}`,
      service: resolution.bestMatch.service,
      confidence: resolution.confidence,
    },
    proposed: {
      date: payload.proposedDate,
      time: payload.proposedTime,
      subject: subjectForMap,          // #1: clean/effective subject, never the garbled raw input
      rawSubject: looksLikeSubject(payload.subject) ? undefined : payload.subject,
      sessionLength: payload.sessionLength,
    },
    candidateSource,
    history: history.found ? {
      anchored: candidateSource === 'history' || (candidateSource === 'named' && historyCands.length > 0),
      primaryTutor: history.primaryTutor,
      modalDuration: history.modalDuration,
      tutorPool: historyCands.slice(0, 6).map(h => ({
        tutor: h.tutor, activeSessions: h.activeSessions,
        slotMatch: h.slotMatch, dayMatch: h.dayMatch, nextScheduled: h.nextScheduled,
      })),
    } : { anchored: false },
    tutorEvaluations: tutorEvals,
    recommended,
    actionPlan,
    ...(comparison ? { comparison } : {}),
  };

  return { recommendation, resolution, tutorEvals };
}

module.exports = {
  orchestrateOne,
  loadRoster,
  loadAplusCsv,
  parseAplusCsv,
  APLUS_CSV_PATH,
  // helpers exported for tests / reuse
  toHHMM24, durationToMinutes, addMinutes, dayNameForISO,
  effectiveSubject, looksLikeSubject,
};
