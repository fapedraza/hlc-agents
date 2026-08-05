/**
 * lib/slots.js — open-slot computation for slot-offering.
 *
 * Real staff rarely just confirm/deny one exact time — when a family gives a
 * range, no time, or the requested slot is taken, staff OFFER a few of the
 * tutor's open times ("Monday we have 3:30, 4:30, 5, 6:30 — which works?").
 * (In the conversation back-test this happened in 56% of threads.)
 *
 * `computeOpenSlots` takes a tutor's weekly working-hours template + their
 * booked intervals on the target day and returns the first few free start
 * times that fit the session length, optionally inside a requested window.
 */

/** "18:30" → 1110 (minutes since midnight); null-safe. */
function hhmmToMin(hhmm) {
  if (!hhmm) return null;
  const m = hhmm.match(/^(\d{1,2}):(\d{2})$/);
  return m ? parseInt(m[1], 10) * 60 + parseInt(m[2], 10) : null;
}
function minToHHMM(min) {
  const h = Math.floor(min / 60), m = min % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}
/** "18:30" → "6:30pm" for human-facing drafts. */
function fmt12(hhmm) {
  const min = hhmmToMin(hhmm);
  if (min == null) return hhmm || '';
  let h = Math.floor(min / 60); const m = min % 60;
  const ap = h >= 12 ? 'pm' : 'am';
  h = h % 12; if (h === 0) h = 12;
  return m ? `${h}:${String(m).padStart(2, '0')}${ap}` : `${h}${ap}`;
}

/**
 * Free start times for a tutor on one day.
 *   dayHours       { off, start:"HH:MM", end:"HH:MM" }  (from getTeacherSchedule)
 *   busyIntervals  [{ start:"HH:MM", end:"HH:MM" }]     (non-cancelled bookings that day)
 *   durationMin    session length in minutes
 *   window         optional { start:"HH:MM", end:"HH:MM" } to constrain the search
 *   granularityMin slot step (default 30)
 *   max            cap on returned slots (default 4)
 * Returns [{ start, end, label }] where label = "10:30am–11:30am".
 */
/** Floor services seat several students with one tutor; everything else is 1:1. */
const isFloorService = svc => /floor/i.test(svc || '');
/** Mariah's cap, and exactly what the data shows: floor never exceeds 4 at once. */
const FLOOR_CAPACITY = 4;

/**
 * @param {string} forService  the service being booked. When it is a FLOOR
 *   service, overlapping floor bookings consume a seat rather than blocking the
 *   slot outright — which is how staff actually schedule. Measured over six
 *   months: Verbal Floor shares a tutor 58% of the time and Math Floor 31%,
 *   against 2% for Learning Center 1:1 and 1% for Exam Prep Math, and the
 *   maximum ever seen is 4. Treating every booking as blocking is why the bot
 *   offered Leta 6:30pm when staff put the student at 10am beside another.
 *
 *   A non-floor request still blocks on ANY overlap, and a floor request still
 *   blocks on an overlapping NON-floor session. Without both of those the bot
 *   would start generating the "1:1 Double Booked" discrepancies the daily
 *   reconcile exists to catch.
 */
function computeOpenSlots({ dayHours, busyIntervals = [], durationMin = 60, window = null, granularityMin = 30, max = 4, forService = null }) {
  if (!dayHours || dayHours.off) return [];
  let ws = hhmmToMin(dayHours.start), we = hhmmToMin(dayHours.end);
  if (ws == null || we == null) return [];
  if (window) {
    const wsW = hhmmToMin(window.start), weW = hhmmToMin(window.end);
    if (wsW != null) ws = Math.max(ws, wsW);
    if (weW != null) we = Math.min(we, weW);
  }
  const wantFloor = isFloorService(forService);
  const busy = busyIntervals
    .map(b => ({ s: hhmmToMin(b.start), e: hhmmToMin(b.end), floor: isFloorService(b.service) }))
    .filter(b => b.s != null && b.e != null)
    .sort((a, b) => a.s - b.s);

  const out = [];
  // last start must leave room for the full session within working hours
  for (let s = ws; s + durationMin <= we; s += granularityMin) {
    const e = s + durationMin;
    const over = busy.filter(b => s < b.e && b.s < e);
    // A floor request may join an existing floor block until it is full; anything
    // else (or any non-floor session in the way) still blocks.
    const clash = wantFloor
      ? over.some(b => !b.floor) || over.length >= FLOOR_CAPACITY
      : over.length > 0;
    if (!clash) out.push({ start: minToHHMM(s), end: minToHHMM(e), label: `${fmt12(minToHHMM(s))}–${fmt12(minToHHMM(e))}` });
    if (out.length >= max) break;
  }
  return out;
}

module.exports = { computeOpenSlots, hhmmToMin, minToHHMM, fmt12, isFloorService, FLOOR_CAPACITY };
