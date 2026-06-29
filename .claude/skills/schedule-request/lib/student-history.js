/**
 * lib/student-history.js — derive a student's real scheduling pattern from A+
 * session history.
 *
 * Mariah's insight (validated by spike-student-history.js): the bot was guessing
 * a subject and reverse-engineering a tutor. The student's actual A+ history —
 * the wide "Aplus Schedule Report" (ID 763), past AND upcoming — already tells
 * us who teaches them, on which day/time, and for how long. Anchoring on that
 * makes the tutor pool + duration evidence-based instead of inferred.
 *
 * `summarizeStudentHistory()` collapses report rows for one student into a
 * per-tutor pattern. `buildHistoryCandidates()` ranks those tutors for a
 * specific proposed day/time (slot match > same-day > frequency/recency).
 *
 * Cancelled/no-show rows are counted but excluded from the pattern signal so a
 * one-off cancellation doesn't look like a real recurring tutor.
 */
const { isNonTutor } = require('./non-tutors');

const CANCEL_STATUSES = new Set([
  'cancelled', 'canceled', 'no-show', 'no show', 'noshow', 'deleted', 'removed',
  'void', 'anm', 'anm - paid', 'anm - unpaid', 'absent no makeup', 'abs', 'vac',
]);
const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

function norm(s) { return (s || '').toLowerCase().replace(/\s+/g, ' ').trim(); }

/** "6/26/2026" → Date (local noon to dodge DST edges); null if unparseable. */
function parseMDY(s) {
  const m = (s || '').trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  return m ? new Date(+m[3], +m[1] - 1, +m[2], 12, 0, 0) : null;
}
function fmtMDY(d) { return `${d.getMonth() + 1}/${d.getDate()}/${d.getFullYear()}`; }

/** "6:30pm" / "07:30 PM" / "19:30" → "19:30"; null if unrecognized. */
function toHHMM(s) {
  if (!s) return null;
  const m = s.trim().match(/^(\d{1,2}):?(\d{2})?\s*(am|pm)?$/i);
  if (!m) return null;
  let h = parseInt(m[1], 10);
  const mm = m[2] || '00';
  const ap = (m[3] || '').toLowerCase();
  if (ap === 'pm' && h !== 12) h += 12;
  if (ap === 'am' && h === 12) h = 0;
  return `${String(h).padStart(2, '0')}:${mm}`;
}

/**
 * Summarize one student's history from Schedule-Report rows.
 *
 * Returns:
 *   {
 *     student, found, totalRows, todayTs,
 *     primaryTutor, modalDuration,
 *     tutors: [{ tutor, activeSessions, cancelled, durations[], days[],
 *                slots:Set("Monday 18:30"), lastSeen, lastSeenTs,
 *                nextScheduled, hasUpcoming }]  // sorted by activeSessions desc
 *   }
 *
 * `tutor` is the report's "Last First" form (e.g. "Key Ashley"), matching what
 * orchestrate's tutor lookup already resolves against the A+ roster.
 */
function summarizeStudentHistory(rows, studentName, now = new Date()) {
  const today = new Date(now); today.setHours(12, 0, 0, 0);
  const todayTs = today.getTime();
  const want = norm(studentName);
  const mine = (rows || []).filter(r => norm(r['Student Name']) === want);

  const tutors = new Map();
  const durCount = new Map();
  for (const r of mine) {
    const tutor = (r['Teacher'] || '').trim();
    if (!tutor || isNonTutor(tutor)) continue;
    const cancelled = CANCEL_STATUSES.has(norm(r['Session Status']));
    const d = parseMDY(r['Session Date']);
    const hhmm = toHHMM(r['Start Time']);
    const day = d ? DAYS[d.getDay()] : null;
    const dur = (r['Duration'] || '').trim();

    if (!tutors.has(tutor)) {
      tutors.set(tutor, { tutor, active: 0, cancelled: 0, durations: new Map(), slots: new Map(), days: new Set(), last: null, next: null });
    }
    const t = tutors.get(tutor);
    if (cancelled) { t.cancelled++; continue; }   // counted, but not part of the pattern
    t.active++;
    if (dur) { t.durations.set(dur, (t.durations.get(dur) || 0) + 1); durCount.set(dur, (durCount.get(dur) || 0) + 1); }
    if (day) {
      t.days.add(day);
      if (hhmm) { const k = `${day} ${hhmm}`; t.slots.set(k, (t.slots.get(k) || 0) + 1); }
    }
    if (d) {
      if (d <= today) { if (!t.last || d > t.last) t.last = d; }
      else            { if (!t.next || d < t.next) t.next = d; }
    }
  }

  const tutorList = [...tutors.values()]
    .filter(t => t.active > 0)
    .map(t => ({
      tutor: t.tutor,
      activeSessions: t.active,
      cancelled: t.cancelled,
      durations: [...t.durations.entries()].sort((a, b) => b[1] - a[1]).map(([d]) => d),
      days: [...t.days],
      slots: new Set(t.slots.keys()),
      lastSeen: t.last ? fmtMDY(t.last) : null,
      lastSeenTs: t.last ? t.last.getTime() : null,
      nextScheduled: t.next ? fmtMDY(t.next) : null,
      hasUpcoming: !!t.next,
    }))
    .sort((a, b) => b.activeSessions - a.activeSessions);

  const modalDuration = [...durCount.entries()].sort((a, b) => b[1] - a[1]).map(([d]) => d)[0] || null;

  return {
    student: studentName,
    found: tutorList.length > 0,
    totalRows: mine.length,
    todayTs,
    primaryTutor: tutorList[0] ? tutorList[0].tutor : null,
    modalDuration,
    tutors: tutorList,
  };
}

/** Score one tutor's history against a proposed day/time. */
function scoreTutor(t, { dayName, hhmm, todayTs }) {
  let score = 0, slotMatch = false, dayMatch = false;
  if (dayName && hhmm && t.slots.has(`${dayName} ${hhmm}`)) { slotMatch = true; score += 1000; }
  if (dayName && t.days.includes(dayName)) { dayMatch = true; score += 200; }
  score += t.activeSessions * 5;                       // frequency
  if (t.hasUpcoming) score += 50;                      // actively scheduled right now
  if (t.lastSeenTs && todayTs) {                       // recency
    const days = (todayTs - t.lastSeenTs) / 86400000;
    if (days <= 45) score += 30; else if (days <= 90) score += 10;
  }
  return { score, slotMatch, dayMatch };
}

/**
 * Rank a student's history tutors for a specific proposed slot.
 * Returns [{ tutor, score, slotMatch, dayMatch, activeSessions, lastSeen,
 *            nextScheduled }], best first, capped at `max`.
 */
function buildHistoryCandidates(summary, { dayName = null, time = null, max = 8 } = {}) {
  if (!summary || !summary.found) return [];
  const hhmm = toHHMM(time);
  return summary.tutors
    .map(t => {
      const s = scoreTutor(t, { dayName, hhmm, todayTs: summary.todayTs });
      return {
        tutor: t.tutor, ...s,
        activeSessions: t.activeSessions,
        lastSeen: t.lastSeen,
        nextScheduled: t.nextScheduled,
      };
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, max);
}

module.exports = { summarizeStudentHistory, buildHistoryCandidates, CANCEL_STATUSES, toHHMM };
