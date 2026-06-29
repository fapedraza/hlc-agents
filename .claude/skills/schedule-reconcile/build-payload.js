const fs = require('fs');
const path = require('path');

const reconPath = process.argv[2];
const sheetIdArg = process.argv[3]; // optional override
const outDir = path.dirname(reconPath);
const recon = JSON.parse(fs.readFileSync(reconPath, 'utf8'));

function readEnv(envPath) {
  if (!fs.existsSync(envPath)) return {};
  const out = {};
  for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (m) out[m[1]] = m[2].replace(/^['"]|['"]$/g, '');
  }
  return out;
}
const env = readEnv('C:\\projects\\hlc-agents\\.env');
const sheetId = sheetIdArg || env.RECONCILE_SHEET_ID || '';
if (!sheetId) console.warn('WARN: no RECONCILE_SHEET_ID found; CTA link will be empty.');
const { startDate, endDate, dates, stats, perDay, typeCounts, discrepancies, lcosSessions, aplusSessions } = recon;

function fmtDateShort(ymd) {
  const d = new Date(ymd + 'T00:00:00');
  const day = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'][d.getDay()];
  return `${day} ${d.getMonth()+1}/${d.getDate()}`;
}
function fmtDateLong(ymd) {
  const d = new Date(ymd + 'T00:00:00');
  return d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
}
function dayShort(ymd) {
  const d = new Date(ymd + 'T00:00:00');
  return ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'][d.getDay()];
}
function esc(s) { return String(s == null ? '' : s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }

const dateRange = dates.length === 1
  ? fmtDateLong(dates[0])
  : `${fmtDateLong(dates[0])} — ${fmtDateLong(dates[dates.length-1])}`;

const now = new Date();
const timestamp = now.toLocaleString('en-US', { month:'short', day:'numeric', year:'numeric', hour:'numeric', minute:'2-digit', hour12:true });

const matchRate = stats.aplusActive > 0 ? Math.round((stats.matched / Math.max(stats.lcosActive, stats.aplusActive)) * 100) : 100;

// ---- Build Dashboard tab data ----
const dashboardRows = [];
dashboardRows.push(['HLC Schedule Reconciliation','','','','','']);
dashboardRows.push([`LCOS vs Appointment Plus · ${dateRange} · Issaquah`,'','','','','']);
dashboardRows.push([`Run: ${timestamp}`,'','','','','']);
dashboardRows.push(['','','','','','']);
dashboardRows.push(['LCOS Student-Days','A+ Student-Days','Matched','Discrepancies','LCOS Cancelled','A+ Cancelled']);
dashboardRows.push([String(stats.lcosTotal), String(stats.aplusTotal), String(stats.matched), String(stats.discrepancies), String(stats.lcosCancelled), String(stats.aplusCancelled)]);
dashboardRows.push(['','','','','','']);

// Daily breakdown
dashboardRows.push(['Daily Breakdown','','','','','']);
dashboardRows.push(['Date','LCOS','A+','Matched','Issues','Status']);
for (const d of perDay) {
  dashboardRows.push([
    fmtDateShort(d.date),
    String(d.lcos), String(d.aplus), String(d.matched), String(d.discrepancies),
    d.discrepancies === 0 ? '✅ Clean' : `⚠ ${d.discrepancies} issue(s)`
  ]);
}
// Totals
const totalL = perDay.reduce((s,d)=>s+d.lcos,0);
const totalA = perDay.reduce((s,d)=>s+d.aplus,0);
const totalM = perDay.reduce((s,d)=>s+d.matched,0);
const totalI = perDay.reduce((s,d)=>s+d.discrepancies,0);
dashboardRows.push(['Total', String(totalL), String(totalA), String(totalM), String(totalI), totalI === 0 ? '✅ All Clean' : `⚠ ${totalI} total`]);
dashboardRows.push(['','','','','','']);

if (stats.discrepancies > 0) {
  dashboardRows.push(['Breakdown by Type','','','','','']);
  dashboardRows.push(['Type','Count','','','','']);
  const typeOrder = ['Missing in A+','Missing in LCOS','Not Cancelled in A+','Not Cancelled in LCOS','Schedule Mismatch','Double Booked','Session/Retest Overlap'];
  for (const t of typeOrder) {
    if (typeCounts[t]) dashboardRows.push([t, String(typeCounts[t]),'','','','']);
  }
} else {
  dashboardRows.push(['✅ No discrepancies — schedules are in sync!','','','','','']);
}

// ---- Discrepancies tab ----
const discRows = [];
if (stats.discrepancies === 0) {
  discRows.push([`✅ No discrepancies for ${dateRange}`]);
} else {
  discRows.push(['Schedule Discrepancies','','','','','','','']);
  discRows.push([`LCOS vs Appointment Plus · ${dateRange} · Issaquah`,'','','','','','','']);
  discRows.push([`Run: ${timestamp}`,'','','','','','','']);
  discRows.push(['','','','','','','','']);
  discRows.push(['Type','Student','Date','Day','LCOS Schedule','A+ Schedule','LCOS (min)','A+ (min)']);
  for (const d of discrepancies) {
    discRows.push([d.type, d.student, d.date, dayShort(d.date), d.lcos_detail, d.aplus_detail, String(d.lcos_mins || 0), String(d.aplus_mins || 0)]);
  }
}

// ---- LCOS Schedule tab ----
const lcosRows = [];
lcosRows.push(['Date','Student Name','Client ID','Service','Subject Area','Start Time','End Time','Duration (min)','Attend Code','Status Code','Is Active','Is Cancelled','Notes']);
const lcosSorted = [...lcosSessions].sort((a,b) =>
  a.date.localeCompare(b.date) ||
  a.studentName.localeCompare(b.studentName) ||
  (a.startTime||'').localeCompare(b.startTime||'')
);
for (const s of lcosSorted) {
  lcosRows.push([s.date, s.studentName, s.clientId || '', s.service || '', s.subjectArea || '',
    s.startTime || '', s.endTime || '', String(s.durationMins || 0),
    s.attendCode || '', s.statusCode || '', s.isActive ? 'TRUE' : 'FALSE', s.isCancelled ? 'TRUE' : 'FALSE',
    s.notes || '']);
}

// ---- A+ Schedule tab ----
const aplusRows = [];
aplusRows.push(['Date','Student Name','Start Time','End Time','Duration (min)','Status','Service','Staff','Notes']);
const aplusSorted = [...aplusSessions].sort((a,b) =>
  a.date.localeCompare(b.date) ||
  a.studentName.localeCompare(b.studentName) ||
  (a.startTime||'').localeCompare(b.startTime||'')
);
for (const s of aplusSorted) {
  aplusRows.push([s.date, s.studentName, s.startTime || '', s.endTime || '', String(s.durationMins || 0),
    s.status || '', s.service || '', s.staff || '', s.notes || '']);
}

// ---- HTML Email ----
const sheetUrl = sheetId ? `https://docs.google.com/spreadsheets/d/${sheetId}` : '';

const badge = (text, good) => `<span style="display:inline-block;padding:2px 8px;border-radius:4px;font-weight:600;font-size:12px;background:${good?'#c6f6d5':'#fed7d7'};color:${good?'#276749':'#9b2c2c'};">${esc(text)}</span>`;

const typeBadgeColors = {
  'Missing in A+': 'background:#fff3e0;color:#e65100;',
  'Missing in LCOS': 'background:#e3f2fd;color:#1565c0;',
  'Not Cancelled in A+': 'background:#fce4ec;color:#ad1457;',
  'Not Cancelled in LCOS': 'background:#e0f7fa;color:#006064;',
  'Double Booked': 'background:#f3e5f5;color:#6a1b9a;',
  'Schedule Mismatch': 'background:#fefcbf;color:#975a16;',
  'Session/Retest Overlap': 'background:#ffcdd2;color:#b71c1c;'
};
const typeBadge = t => `<span style="display:inline-block;padding:2px 8px;border-radius:4px;font-weight:600;font-size:11px;${typeBadgeColors[t]||''}">${esc(t)}</span>`;

const thL = 'padding:10px 12px;background:#edf2f7;text-align:left;font-size:11px;font-weight:700;color:#4a5568;text-transform:uppercase;letter-spacing:0.5px;border-bottom:2px solid #cbd5e0;';
const thR = thL.replace('text-align:left','text-align:right');
const thC = thL.replace('text-align:left','text-align:center');
const tdL = 'padding:8px 12px;text-align:left;border-bottom:1px solid #e2e8f0;font-size:13px;';
const tdR = 'padding:8px 12px;text-align:right;border-bottom:1px solid #e2e8f0;font-size:13px;font-variant-numeric:tabular-nums;';
const tdC = 'padding:8px 12px;text-align:center;border-bottom:1px solid #e2e8f0;font-size:13px;font-variant-numeric:tabular-nums;';
const sectionHdr = 'margin:16px 0 6px 0;font-size:13px;font-weight:700;color:#1a365d;text-transform:uppercase;letter-spacing:0.8px;padding-bottom:6px;border-bottom:2px solid #1a365d;';

const headerStatus = stats.discrepancies === 0
  ? '&#x2705; No discrepancies found'
  : `&#x26A0; ${stats.discrepancies} discrepancies require attention`;

let html = `<!DOCTYPE html><html><body style="margin:0;padding:0;background:#f0f4f8;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
<div style="max-width:860px;margin:0 auto;background:#ffffff;">

<div style="background-color:#1a365d;background:linear-gradient(135deg,#1a365d 0%,#2d3748 100%);padding:28px 32px;color:#ffffff;">
  <h1 style="margin:0;font-size:22px;font-weight:700;letter-spacing:-0.3px;color:#ffffff;">Huntington Learning Center &mdash; Schedule Reconciliation</h1>
  <div style="font-size:14px;color:#e2e8f0;margin-top:8px;">LCOS vs Appointment Plus &middot; ${esc(dateRange)}</div>
  <div style="font-size:13px;color:#e2e8f0;margin-top:4px;">Center: <strong style="color:#7ec8e3">Issaquah</strong> &middot; ${dates.length} day(s) reconciled</div>
  <div style="font-size:11px;color:#cbd5e0;margin-top:8px;font-style:italic;">${headerStatus}</div>
</div>

<div style="padding:20px 26px 0;">
<table width="100%" cellpadding="0" cellspacing="8" style="border-collapse:separate;">
<tr>
<td style="width:25%;padding:12px 14px;background:#f8fafc;border:1px solid #e2e8f0;border-radius:6px;vertical-align:top;">
  <div style="font-size:10px;font-weight:700;color:#4a5568;text-transform:uppercase;letter-spacing:0.5px;margin-bottom:6px;">LCOS Student-Days</div>
  <div style="font-size:20px;font-weight:700;color:#1a365d;margin-bottom:4px;">${stats.lcosTotal}</div>
  ${badge(`${stats.lcosActive} active`, true)}
  <div style="font-size:10px;color:#a0aec0;margin-top:4px;">${stats.lcosCancelled} cancelled/absent</div>
</td>
<td style="width:25%;padding:12px 14px;background:#f8fafc;border:1px solid #e2e8f0;border-radius:6px;vertical-align:top;">
  <div style="font-size:10px;font-weight:700;color:#4a5568;text-transform:uppercase;letter-spacing:0.5px;margin-bottom:6px;">A+ Student-Days</div>
  <div style="font-size:20px;font-weight:700;color:#1a365d;margin-bottom:4px;">${stats.aplusTotal}</div>
  ${badge(`${stats.aplusActive} active`, true)}
  <div style="font-size:10px;color:#a0aec0;margin-top:4px;">${stats.aplusCancelled} cancelled</div>
</td>
<td style="width:25%;padding:12px 14px;background:#f8fafc;border:1px solid #e2e8f0;border-radius:6px;vertical-align:top;">
  <div style="font-size:10px;font-weight:700;color:#4a5568;text-transform:uppercase;letter-spacing:0.5px;margin-bottom:6px;">Matched</div>
  <div style="font-size:20px;font-weight:700;color:#1a365d;margin-bottom:4px;">${stats.matched}</div>
  ${badge(`${matchRate}% match rate`, matchRate >= 90)}
  <div style="font-size:10px;color:#a0aec0;margin-top:4px;">${dates.length} day(s) reconciled</div>
</td>
<td style="width:25%;padding:12px 14px;background:#f8fafc;border:1px solid #e2e8f0;border-radius:6px;vertical-align:top;">
  <div style="font-size:10px;font-weight:700;color:#4a5568;text-transform:uppercase;letter-spacing:0.5px;margin-bottom:6px;">Discrepancies</div>
  <div style="font-size:20px;font-weight:700;color:#1a365d;margin-bottom:4px;">${stats.discrepancies}</div>
  ${stats.discrepancies === 0 ? badge('All clear', true) : badge(`${stats.discrepancies} need review`, false)}
  <div style="font-size:10px;color:#a0aec0;margin-top:4px;">${stats.discrepancies === 0 ? 'Schedules are in sync' : 'See details below'}</div>
</td>
</tr>
</table>
</div>`;

// Daily breakdown
if (dates.length > 1) {
  html += `<div style="padding:4px 32px 0;"><div style="${sectionHdr}">DAILY BREAKDOWN</div>
  <table width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;margin-bottom:8px;">
    <tr><th style="${thL}">Date</th><th style="${thR}">LCOS</th><th style="${thR}">A+</th><th style="${thR}">Matched</th><th style="${thR}">Issues</th><th style="${thC}">Status</th></tr>`;
  perDay.forEach((d, i) => {
    const bg = i % 2 === 0 ? '#ffffff' : '#f8fafc';
    const issueColor = d.discrepancies > 0 ? '#c53030' : '#276749';
    const statusBadge = d.discrepancies === 0
      ? `<span style="display:inline-block;padding:2px 8px;border-radius:4px;font-weight:600;font-size:11px;background:#c6f6d5;color:#276749;">Clean</span>`
      : `<span style="display:inline-block;padding:2px 8px;border-radius:4px;font-weight:600;font-size:11px;background:#fed7d7;color:#9b2c2c;">${d.discrepancies}</span>`;
    html += `<tr style="background:${bg};"><td style="${tdL}">${esc(fmtDateShort(d.date))}</td><td style="${tdR}">${d.lcos}</td><td style="${tdR}">${d.aplus}</td><td style="${tdR}">${d.matched}</td><td style="${tdR};font-weight:700;color:${issueColor};">${d.discrepancies}</td><td style="${tdC}">${statusBadge}</td></tr>`;
  });
  html += `<tr style="background:#edf2f7;font-weight:700;"><td style="${tdL};border-top:2px solid #cbd5e0;">Total</td><td style="${tdR};border-top:2px solid #cbd5e0;">${totalL}</td><td style="${tdR};border-top:2px solid #cbd5e0;">${totalA}</td><td style="${tdR};border-top:2px solid #cbd5e0;">${totalM}</td><td style="${tdR};border-top:2px solid #cbd5e0;color:${totalI>0?'#c53030':'#276749'};">${totalI}</td><td style="${tdC};border-top:2px solid #cbd5e0;"></td></tr>
  </table></div>`;
}

// Breakdown by type
if (stats.discrepancies > 0) {
  html += `<div style="padding:0 32px;"><div style="${sectionHdr}">BREAKDOWN BY TYPE</div>
  <table width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;margin-bottom:8px;">
    <tr><th style="${thL}">Type</th><th style="${thR}">Count</th></tr>`;
  const typeOrder = ['Missing in A+','Missing in LCOS','Not Cancelled in A+','Not Cancelled in LCOS','Schedule Mismatch','Double Booked','Session/Retest Overlap'];
  let i = 0;
  for (const t of typeOrder) {
    if (!typeCounts[t]) continue;
    const bg = i % 2 === 0 ? '#ffffff' : '#f8fafc';
    html += `<tr style="background:${bg};"><td style="${tdL}">${typeBadge(t)}</td><td style="${tdR};font-weight:700;">${typeCounts[t]}</td></tr>`;
    i++;
  }
  html += `</table></div>`;
}

// Discrepancy details (top 25)
if (stats.discrepancies > 0) {
  const shown = discrepancies.slice(0, 25);
  const title = discrepancies.length > 25 ? 'DISCREPANCY DETAILS (Top 25)' : 'DISCREPANCY DETAILS';
  html += `<div style="padding:0 32px;"><div style="${sectionHdr}">${title}</div>
  <table width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;margin-bottom:8px;">
    <tr><th style="${thL}">Type</th><th style="${thL}">Student</th><th style="${thL}">Date</th><th style="${thL}">LCOS</th><th style="${thL}">A+</th></tr>`;
  shown.forEach((d, i) => {
    const bg = i % 2 === 0 ? '#ffffff' : '#f8fafc';
    html += `<tr style="background:${bg};"><td style="${tdL}">${typeBadge(d.type)}</td><td style="${tdL}">${esc(d.student)}</td><td style="${tdL}">${esc(fmtDateShort(d.date))}</td><td style="${tdL};color:#4a5568;">${esc(d.lcos_detail)}</td><td style="${tdL};color:#4a5568;">${esc(d.aplus_detail)}</td></tr>`;
  });
  if (discrepancies.length > 25) {
    html += `<tr><td colspan="5" style="${tdL};font-style:italic;color:#718096;text-align:center;">... and ${discrepancies.length - 25} more &mdash; <a href="${sheetUrl}" style="color:#1a365d;">view full list</a></td></tr>`;
  }
  html += `</table></div>`;
}

if (stats.discrepancies === 0) {
  html += `<div style="padding:0 32px;"><div style="padding:20px;text-align:center;background:#c6f6d5;border-radius:6px;margin:16px 0;">
  <div style="font-size:32px;margin-bottom:8px;">&#x1F389;</div>
  <div style="font-size:16px;font-weight:700;color:#276749;">Schedules Are In Sync!</div>
  <div style="font-size:13px;color:#4a5568;margin-top:4px;">${stats.matched} student-days matched across ${dates.length} day(s)</div>
</div></div>`;
}

if (stats.discrepancies > 0) {
  html += `<div style="padding:0 32px 24px;text-align:right;">
  <a href="${sheetUrl}" style="display:inline-block;background-color:#1a365d;color:#ffffff;text-decoration:none;padding:10px 18px;border-radius:4px;font-size:13px;font-weight:bold;">View Full Report &rarr;</a>
</div>`;
}

html += `<div style="background:#f7fafc;padding:14px 28px;border-top:1px solid #e2e8f0;font-size:11px;color:#a0aec0;text-align:center;">Auto-generated by HLC Automation &middot; LCOS vs A+ Reconciliation &middot; ${esc(timestamp)}</div>
</div></body></html>`;

const subjectPrefix = stats.discrepancies === 0 ? 'OK' : 'ALERT';
const subjectExtra = stats.discrepancies === 0 ? '' : ` (${stats.discrepancies} discrepancies)`;
const year = new Date(dates[0] + 'T00:00:00').getFullYear();
const subject = `${subjectPrefix} Schedule Reconciliation - Issaquah - Week of ${fmtDateShort(dates[0])} ${year}${subjectExtra}`;

const payload = {
  startDate, endDate, dateRange, timestamp,
  stats, matchRate, sheetUrl, subject,
  html,
  tabs: {
    dashboard: dashboardRows,
    discrepancies: discRows,
    lcosSchedule: lcosRows,
    aplusSchedule: aplusRows
  }
};
fs.writeFileSync(path.join(outDir, 'payload.json'), JSON.stringify(payload));
fs.writeFileSync(path.join(outDir, 'email.html'), html);
console.log(`Payload ready: ${path.join(outDir, 'payload.json')}`);
console.log(`Dashboard rows: ${dashboardRows.length}`);
console.log(`Discrepancy rows: ${discRows.length}`);
console.log(`LCOS rows: ${lcosRows.length}`);
console.log(`A+ rows: ${aplusRows.length}`);
console.log(`Subject: ${subject}`);
