/**
 * fetch-student-notes.js — read per-student scheduling constraints out of A+.
 *
 * Staff have been recording tutor exclusions in the A+ "Student Notes" field for
 * years, in a convention they invented themselves:
 *
 *     7/13/2026 No Connie
 *     7/8/2026  No Leta for math
 *     6/2/2016  Best: Amy, Jamie, Alicia, Anita
 *               Okay: Stacey, Josh, Ian
 *               No: Beverly, Janis
 *
 * That is prefer / any / never, a decade before we proposed it. So the bot reads
 * what already exists rather than asking anyone to maintain a new list.
 *
 * (Note this is NOT "Session Notes (internal)", which is a per-session ops log of
 * no-shows and cover arrangements. Different field, different purpose.)
 *
 * The field also carries constraints beyond tutor rules - "inform family of tutor
 * changes", "quiet room preferred", communication routing - which are kept as
 * free text and surfaced to staff rather than parsed.
 *
 * SAFETY: report 763 is a shared saved report the reconcile depends on. This runs
 * an AD-HOC report instead: it never selects a saved report, asserts report_id is
 * blank before running, and clicks only a control labelled exactly "Run Report".
 *
 * Usage: node fetch-student-notes.js [--days 45] [--out student-notes.json]
 */
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const { readEnv, gotoWithAuth } = require(path.join(__dirname, 'lib', 'aplus.js'));

const REPORTS_URL = 'https://account.appointment-plus.com/ap/ap_admin_v2/appointments_index_v2.php?p=reports';
const FIELDS = [
  'include_name',           // Student Name
  'include_customer_notes', // Student Notes   <- the rules
  'include_service',        // Service         <- floor vs 1:1
  'include_staff',          // Teacher
  'include_staff_type',     // Teacher Type
  'include_date',
];

const argv = process.argv.slice(2);
const argVal = (f, d) => { const i = argv.indexOf(f); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const DAYS = parseInt(argVal('--days', '45'), 10);
const OUT = path.join(__dirname, argVal('--out', 'student-notes.json'));
const mdy = d => `${d.getMonth() + 1}/${d.getDate()}/${d.getFullYear()}`;

(async () => {
  const env = readEnv();
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  const popups = []; ctx.on('page', p => popups.push(p));
  try {
    await gotoWithAuth(page, env, REPORTS_URL);
    await page.waitForSelector('frame[name="slots"]', { timeout: 25000 });
    const f = page.frame({ name: 'slots' });
    await f.waitForSelector('select[name="includeFields[0]"]', { timeout: 25000 });

    const from = new Date(Date.now() - 7 * 86400000);
    const to = new Date(Date.now() + DAYS * 86400000);
    const setup = await f.evaluate(({ fields, from, to }) => {
      const d = document;
      const rid = d.querySelector('select[name="report_id"]');
      if (rid && rid.value) return { ok: false, why: `a saved report is selected ("${rid.value}") - refusing to run` };
      for (let i = 0; i <= 50; i++) { const el = d.querySelector(`select[name="includeFields[${i}]"]`); if (el) el.value = ''; }
      fields.forEach((v, i) => {
        const el = d.querySelector(`select[name="includeFields[${i}]"]`);
        if (el && [...el.options].some(o => o.value === v)) { el.value = v; el.dispatchEvent(new Event('change', { bubbles: true })); }
      });
      for (const [sel, val] of [['#apt_date_from', from], ['#apt_date_to', to]]) {
        const e = d.querySelector(sel); if (e) { e.value = val; e.dispatchEvent(new Event('change', { bubbles: true })); }
      }
      return { ok: true };
    }, { fields: FIELDS, from: mdy(from), to: mdy(to) });
    if (!setup.ok) throw new Error(setup.why);

    const clicked = await f.evaluate(() => {
      const el = [...document.querySelectorAll('input[type=submit],input[type=button],button,a')]
        .find(e => ((e.value || e.innerText || '') + '').trim().toLowerCase() === 'run report');
      if (!el) return false;
      el.click(); return true;
    });
    if (!clicked) throw new Error('no control labelled exactly "Run Report"');
    await page.waitForTimeout(18000);

    const target = popups.length ? popups[popups.length - 1] : page;
    try { await target.waitForLoadState('domcontentloaded', { timeout: 15000 }); } catch {}
    const grid = await target.evaluate(() => {
      const docs = [document];
      for (const fr of document.querySelectorAll('frame,iframe')) { try { if (fr.contentDocument) docs.push(fr.contentDocument); } catch {} }
      let best = null;
      for (const d of docs) for (const t of d.querySelectorAll('table')) {
        const rows = [...t.querySelectorAll('tr')];
        if (rows.length > 3 && (!best || rows.length > best.length)) best = rows;
      }
      if (!best) return null;
      return best.map(r => [...r.querySelectorAll('th,td')].map(c => (c.innerText || '').trim()));
    });
    if (!grid) throw new Error('no result table rendered');

    const [hdr, ...body] = grid;
    const at = n => hdr.findIndex(h => h.toLowerCase().includes(n));
    const iName = at('student name'), iNote = at('student note'), iSvc = at('service'),
          iStaff = at('teacher'), iType = at('teacher type');

    const students = new Map(), teachers = new Map(), sessions = [];
    const iDate = at('session date');
    for (const r of body) {
      // Per-session rows too: a scoped rule ("No Leta for math") cannot be checked
      // without knowing each session's service, and the standard report 763 has no
      // Service column. This is the only place we can get that today.
      if ((r[iName] || '').trim()) sessions.push({
        student: (r[iName] || '').trim(), teacher: (r[iStaff] || '').trim(),
        service: (r[iSvc] || '').trim(), date: (r[iDate] || '').trim(),
      });
      const name = (r[iName] || '').trim();
      if (name) {
        if (!students.has(name)) students.set(name, { student: name, note: (r[iNote] || '').trim(), services: new Set() });
        const s = students.get(name);
        if (r[iSvc]) s.services.add(r[iSvc].trim());
        if (!s.note && r[iNote]) s.note = r[iNote].trim();
      }
      const t = (r[iStaff] || '').trim();
      if (t && !teachers.has(t)) teachers.set(t, { teacher: t, type: (r[iType] || '').trim() });
    }

    const out = {
      fetchedISO: new Date().toISOString(),
      range: { from: mdy(from), to: mdy(to) },
      sessionRows: body.length,
      students: [...students.values()].map(s => ({ ...s, services: [...s.services] })),
      teachers: [...teachers.values()],
      sessions,
    };
    fs.writeFileSync(OUT, JSON.stringify(out, null, 2));
    const withNotes = out.students.filter(s => s.note).length;
    console.log(`${body.length} session rows -> ${out.students.length} students (${withNotes} with a Student Note), ${out.teachers.length} teachers`);
    console.log(`wrote ${OUT}`);
  } finally { await browser.close(); }
})().catch(e => { console.error('failed:', e.message); process.exit(1); });
