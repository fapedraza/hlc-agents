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
function computeOpenSlots({ dayHours, busyIntervals = [], durationMin = 60, window = null, granularityMin = 30, max = 4 }) {
  if (!dayHours || dayHours.off) return [];
  let ws = hhmmToMin(dayHours.start), we = hhmmToMin(dayHours.end);
  if (ws == null || we == null) return [];
  if (window) {
    const wsW = hhmmToMin(window.start), weW = hhmmToMin(window.end);
    if (wsW != null) ws = Math.max(ws, wsW);
    if (weW != null) we = Math.min(we, weW);
  }
  const busy = busyIntervals
    .map(b => [hhmmToMin(b.start), hhmmToMin(b.end)])
    .filter(([s, e]) => s != null && e != null)
    .sort((a, b) => a[0] - b[0]);

  const out = [];
  // last start must leave room for the full session within working hours
  for (let s = ws; s + durationMin <= we; s += granularityMin) {
    const e = s + durationMin;
    const clash = busy.some(([bs, be]) => s < be && bs < e);
    if (!clash) out.push({ start: minToHHMM(s), end: minToHHMM(e), label: `${fmt12(minToHHMM(s))}–${fmt12(minToHHMM(e))}` });
    if (out.length >= max) break;
  }
  return out;
}

module.exports = { computeOpenSlots, hhmmToMin, minToHHMM, fmt12 };
