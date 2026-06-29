/**
 * Shared helpers for Appointment-Plus admin v2 scraping.
 *
 * A+ admin is a frameset (`header`, `sidenav`, `slots`). Teacher detail pages
 * load by clicking a teacher in `?p=staff` — that targets the `sidenav` frame
 * with `sidenav_frame_v2.php?p=staff_details&employee_id=<eid>&sec=<n>&first=yes`,
 * which in turn populates the `slots` frame. The sec codes match A+'s internal
 * section IDs (Profile=1, Schedule=2, Days Off=4, Schedule Exceptions=51,
 * Assign Schedule Templates=52, Services Offered=54).
 *
 * Rather than two clicks per (teacher, section), we set the `sidenav` frame's
 * location directly to the staff_details URL with the desired `sec` — A+ loads
 * the matching slots content in one trip.
 */
const fs = require('fs');

const STAFF_LIST_URL = 'https://account.appointment-plus.com/ap/ap_admin_v2/appointments_index_v2.php?p=staff';
const ENV_PATH = 'C:\\projects\\hlc-agents\\.env';

// `sec` is the sidenav's section param. A+ remaps this to a different `sec`
// in the slots frame URL (e.g. sidenav sec=54 → slots URL sec=3), so we
// cannot use slots `sec` to verify navigation — we use `readySel`, a
// per-section DOM selector whose presence confirms the section has rendered.
const SECTIONS = {
  profile:         { sec: 1,  label: 'Teacher Information',     readySel: 'input[name="first_name"]' },
  schedule:        { sec: 2,  label: 'Schedule',                readySel: 'select[name^="first_appt_time_"]' },
  daysOff:         { sec: 4,  label: 'Days Off',                readySel: null },
  exceptions:      { sec: 51, label: 'Schedule Exceptions',     readySel: null },
  assignTemplates: { sec: 52, label: 'Assign Schedule Templates', readySel: null },
  servicesOffered: { sec: 54, label: 'Services Offered',        readySel: 'input[type="checkbox"][name$="-box"]' },
};

function readEnv(p = ENV_PATH) {
  if (!fs.existsSync(p)) return {};
  const out = {};
  for (const line of fs.readFileSync(p, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (m) out[m[1]] = m[2].replace(/^['"]|['"]$/g, '');
  }
  return out;
}

/** Go to `url`; if A+ redirected to login.php, log in then revisit `url`. */
async function gotoWithAuth(page, env, url) {
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  if (!page.url().includes('login.php')) return;
  if (!env.AP_USERNAME || !env.AP_PASSWORD) {
    throw new Error('AP_USERNAME / AP_PASSWORD missing from .env');
  }
  await page.fill('input[name="username"], input[name="user"], input[type="text"]', env.AP_USERNAME);
  await page.fill('input[name="password"], input[type="password"]', env.AP_PASSWORD);
  await Promise.all([
    page.waitForNavigation({ waitUntil: 'domcontentloaded' }),
    page.click('input[type="submit"], button[type="submit"]'),
  ]);
  if (page.url().includes('login.php')) throw new Error('A+ login failed — check AP_USERNAME/AP_PASSWORD');
  await page.goto(url, { waitUntil: 'domcontentloaded' });
}

async function waitForSlotsHeading(page, prefix, timeoutMs = 20000) {
  await page.waitForFunction((p) => {
    const d = [...document.querySelectorAll('frame')].find(f => f.name === 'slots')?.contentDocument;
    if (!d) return false;
    const h = (d.querySelector('h1, h2, h3')?.innerText || '').trim();
    return h.toLowerCase().startsWith(p.toLowerCase());
  }, prefix, { timeout: timeoutMs });
}

/** Establish the staff-list frameset (the entry point that gives us all 3 frames). */
async function navStaffList(page, env) {
  await gotoWithAuth(page, env, STAFF_LIST_URL);
  await waitForSlotsHeading(page, 'Teachers');
}

/**
 * Read the staff list from the slots frame. Must be on the staff list page.
 *
 * The slots-frame heading flips to "Teachers" before the table rows finish
 * rendering — listTeachers waits until the teacher-link count matches the
 * "N results found" banner so we don't truncate the roster.
 */
async function listTeachers(page, timeoutMs = 15000) {
  await page.waitForFunction(() => {
    const d = [...document.querySelectorAll('frame')].find(f => f.name === 'slots')?.contentDocument;
    if (!d) return false;
    const m = (d.body?.innerText || '').match(/(\d+)\s+results?\s+found/i);
    if (!m) return false;
    const expected = parseInt(m[1], 10);
    const have = d.querySelectorAll('a[target="sidenav"][href*="employee_id="]').length;
    return have >= expected;
  }, null, { timeout: timeoutMs });

  return await page.evaluate(() => {
    const d = [...document.querySelectorAll('frame')].find(f => f.name === 'slots')?.contentDocument;
    if (!d) return [];
    return [...d.querySelectorAll('a[target="sidenav"]')]
      .filter(a => /employee_id=/.test(a.href))
      .map(a => {
        const eid = (a.href.match(/employee_id=(\d+)/) || [])[1];
        const lastFirst = a.innerText.trim();
        const dm = lastFirst.match(/^([^,]+),\s*([^(]+?)\s*(?:\(([^)]+)\))?$/);
        return {
          eid,
          lastFirst,
          lastName:    dm ? dm[1].trim() : null,
          firstName:   dm ? dm[2].trim() : null,
          displayName: dm && dm[3] ? dm[3].trim() : (dm ? dm[2].trim() : lastFirst),
        };
      })
      .filter(t => t.eid);
  });
}

/**
 * Navigate to a teacher's section by directly setting the sidenav frame URL
 * — one round-trip per (teacher, section). Waits until the slots frame's
 * URL reflects this teacher AND the section's `readySel` element is present.
 *
 * Sections without a `readySel` fall back to a slots-body text match starting
 * with the section label (best-effort).
 */
async function navTeacherSection(page, teacher, section, timeoutMs = 30000) {
  await page.evaluate(({ eid, sec }) => {
    const sidenav = [...document.querySelectorAll('frame')].find(f => f.name === 'sidenav');
    if (!sidenav || !sidenav.contentWindow) throw new Error('sidenav frame missing');
    sidenav.contentWindow.location.href =
      `/ap/ap_admin_v2/sidenav_frame_v2.php?p=staff_details&employee_id=${eid}&sec=${sec}&first=yes`;
  }, { eid: teacher.eid, sec: section.sec });

  await page.waitForFunction(({ eid, readySel, label }) => {
    const d = [...document.querySelectorAll('frame')].find(f => f.name === 'slots')?.contentDocument;
    if (!d) return false;
    if (!(d.URL || '').includes('employee_id=' + eid)) return false;
    if (readySel) return !!d.querySelector(readySel);
    // Fallback: body innerText starts with the section label (and isn't a longer
    // label that begins the same way — e.g. "Schedule" must not match
    // "Schedule Exceptions").
    const body = (d.body && d.body.innerText || '').replace(/\s+/g, ' ').trim();
    const lower = body.toLowerCase();
    const lbl = label.toLowerCase();
    if (!lower.startsWith(lbl)) return false;
    const nextCh = body.charAt(lbl.length);
    return !nextCh || !/\w/.test(nextCh);
  }, { eid: teacher.eid, readySel: section.readySel, label: section.label }, { timeout: timeoutMs });
}

// ─── Services Offered (sec=54) ────────────────────────────────────────────────

/**
 * Page-context helper. Reads one rendered page of the Services Offered table
 * from the slots frame and returns:
 *   { services: [{ serviceId, name, offered, days, timeToComplete, cost }], nextTarget, firstId }
 * `nextTarget` is the target-page argument lifted from the Next button's onclick
 * (used for pagination); `firstId` is the first service's id (used as the
 * "page advanced" signal during pagination).
 *
 * Pass this directly to `page.evaluate(scrapeOneServicesPage)`.
 */
function scrapeOneServicesPage() {
  const d = [...document.querySelectorAll('frame')].find(f => f.name === 'slots')?.contentDocument;
  if (!d) return { services: [], nextTarget: null, firstId: null };
  const dayLabels = ['Mon','Tue','Wed','Thu','Fri','Sat','Sun'];
  const seen = new Set();
  const services = [];
  for (const tr of d.querySelectorAll('tr')) {
    const cb = tr.querySelector('input[type=checkbox]');
    if (!cb || !/^\d+-box$/.test(cb.name) || !tr.querySelector('select')) continue;
    const id = cb.name.replace('-box','');
    if (seen.has(id)) continue;
    const desc = (tr.cells[1] && tr.cells[1].innerText) || '';
    const name = desc.split('\n').map(s => s.trim())
                     .filter(s => s.length && s.toLowerCase() !== 'service')[0] || null;
    if (!name) continue;
    seen.add(id);
    const sel = tr.querySelector('select');
    const timeToComplete = sel && sel.selectedIndex >= 0
      ? (sel.options[sel.selectedIndex].text || '').trim() : null;
    const dayBoxes = [...tr.querySelectorAll('input[type=checkbox]')].slice(1, 8);
    const days = {};
    if (dayBoxes.length === 7) dayLabels.forEach((day, i) => { days[day] = !!dayBoxes[i].checked; });
    const inputs = [...tr.querySelectorAll('input[type=text], input:not([type])')];
    const cost = inputs.length ? (inputs[inputs.length - 1].value || '').trim() : null;
    services.push({ serviceId: id, name, offered: !!cb.checked, days, timeToComplete, cost });
  }
  const nextBtn = d.querySelector('input[name="update_next"]');
  const m = nextBtn ? (nextBtn.getAttribute('onclick') || '').match(/fnChangeServicesPage\('(\d+)'\)/) : null;
  return { services, nextTarget: m ? m[1] : null, firstId: services[0] ? services[0].serviceId : null };
}

/**
 * Scrape every page of the currently-open Services Offered table.
 *
 * Services Offered paginates server-side (~25 rows/page, currently 4 pages
 * for HLC). `fnChangeServicesPage(p, submitForm)` requires submitForm=true to
 * actually POST — the UI's Next is `<input type="submit">` so the browser
 * fires its native submit after onclick. Programmatic callers must pass true.
 */
async function scrapeAllServicePages(page, maxPages = 12) {
  const collected = new Map();
  for (let i = 0; i < maxPages; i++) {
    const cur = await page.evaluate(scrapeOneServicesPage);
    for (const s of cur.services) if (!collected.has(s.serviceId)) collected.set(s.serviceId, s);
    if (!cur.nextTarget) break;
    const prev = cur.firstId;
    await page.evaluate((t) => {
      const slots = [...document.querySelectorAll('frame')].find(f => f.name === 'slots');
      slots.contentWindow.fnChangeServicesPage(t, true);
    }, cur.nextTarget);
    // Wait until the first row's service ID changes — the most reliable
    // "page advanced" signal. A+ sometimes takes >15s to repaint the slots
    // frame after fnChangeServicesPage POSTs, so we give it 30s.
    const moved = await page.waitForFunction((prevFirstId) => {
      const d = [...document.querySelectorAll('frame')].find(f => f.name === 'slots')?.contentDocument;
      if (!d) return false;
      for (const tr of d.querySelectorAll('tr')) {
        const cb = tr.querySelector('input[type=checkbox]');
        if (cb && /^\d+-box$/.test(cb.name) && tr.querySelector('select')) {
          return cb.name.replace('-box','') !== prevFirstId;
        }
      }
      return false;
    }, prev, { timeout: 30000 }).then(() => true).catch(() => false);
    if (!moved) break;
  }
  return [...collected.values()];
}

// ─── Schedule (sec=2) ─────────────────────────────────────────────────────────

/**
 * Page-context helper. Reads the 7 day rows of the Schedule table.
 * Returns `{ Monday: {off, rawStart, rawEnd}, ..., Sunday: {...} }` with the
 * raw A+ display times (e.g. "10:00am"). Use `normalizeApTime` to convert to
 * 24h HH:MM. Pass directly to `page.evaluate(scrapeWeeklyScheduleTable)`.
 */
function scrapeWeeklyScheduleTable() {
  const d = [...document.querySelectorAll('frame')].find(f => f.name === 'slots')?.contentDocument;
  if (!d) return null;
  const days = ['Monday','Tuesday','Wednesday','Thursday','Friday','Saturday','Sunday'];
  const out = {};
  for (const day of days) {
    const offCb    = d.querySelector(`input[type="checkbox"][name="off_${day}"]`);
    const startSel = d.querySelector(`select[name="first_appt_time_${day}"]`);
    const endSel   = d.querySelector(`select[name="last_appt_time_${day}"]`);
    if (!offCb || !startSel || !endSel) { out[day] = null; continue; }
    const off = !!offCb.checked;
    const rawStart = (startSel.options[startSel.selectedIndex]?.text || '').trim();
    const rawEnd   = (endSel.options[endSel.selectedIndex]?.text   || '').trim();
    out[day] = { off, rawStart, rawEnd };
  }
  return out;
}

/** "10:00am" → "10:00"; "8:30pm" → "20:30"; "12:30am" → "00:30". null on unrecognized. */
function normalizeApTime(s) {
  if (!s) return null;
  const m = s.trim().match(/^(\d{1,2}):(\d{2})\s*(am|pm)$/i);
  if (!m) return null;
  let h = parseInt(m[1], 10);
  const mm = m[2];
  const ap = m[3].toLowerCase();
  if (ap === 'pm' && h !== 12) h += 12;
  if (ap === 'am' && h === 12) h = 0;
  return `${String(h).padStart(2, '0')}:${mm}`;
}

// ─── Per-request convenience wrappers ─────────────────────────────────────────

/**
 * Navigate to a teacher's Services Offered tab and return their full
 * (all-pages) qualification list. Use during a scheduling request to look up
 * just the candidate tutors — no bulk pre-scrape needed.
 *
 * Caller must already have an authenticated A+ session — typically by calling
 * `navStaffList(page, env)` once at session start.
 */
async function getTeacherQuals(page, teacher) {
  await navTeacherSection(page, teacher, SECTIONS.servicesOffered);
  return scrapeAllServicePages(page);
}

/**
 * Navigate to a teacher's Schedule tab and return their weekly working-hours
 * template as `{ Monday: {off, start, end}, ..., Sunday: {...} }` with times
 * normalized to 24h HH:MM. Off days have start/end = null.
 *
 * As with getTeacherQuals, caller must have an authenticated A+ session.
 */
async function getTeacherSchedule(page, teacher) {
  await navTeacherSection(page, teacher, SECTIONS.schedule);
  const raw = await page.evaluate(scrapeWeeklyScheduleTable);
  const DAYS = ['Monday','Tuesday','Wednesday','Thursday','Friday','Saturday','Sunday'];
  const weekly = {};
  for (const day of DAYS) {
    const r = raw && raw[day];
    if (!r) { weekly[day] = null; continue; }
    weekly[day] = r.off
      ? { off: true, start: null, end: null }
      : { off: false, start: normalizeApTime(r.rawStart), end: normalizeApTime(r.rawEnd) };
  }
  return weekly;
}

module.exports = {
  STAFF_LIST_URL,
  SECTIONS,
  readEnv,
  gotoWithAuth,
  navStaffList,
  listTeachers,
  navTeacherSection,
  waitForSlotsHeading,
  // page-context scrapers (pass to page.evaluate)
  scrapeOneServicesPage,
  scrapeWeeklyScheduleTable,
  // higher-level scrapers
  scrapeAllServicePages,
  normalizeApTime,
  // per-request convenience wrappers
  getTeacherQuals,
  getTeacherSchedule,
};
