const fs = require('fs');
const data = JSON.parse(fs.readFileSync('C:\\projects\\hlc-agents\\reconcile_output.json','utf8'));
const { dateRange, stats, perDay, typeCounts, discrepancies, lcosRaw, aplusRaw } = data;

const SHEET_ID = '1f9tpPdkGMk0AYntuawh05_b3tJrcnm0jzCJOfiAz3Bk';
const SHEET_URL = `https://docs.google.com/spreadsheets/d/${SHEET_ID}`;

function fmtDateShort(d) {
  const dt = new Date(d+'T00:00:00');
  const days = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
  return `${days[dt.getDay()]} ${dt.getMonth()+1}/${dt.getDate()}`;
}
function fmtDay(d) {
  const days = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
  return days[new Date(d+'T00:00:00').getDay()];
}
function ts() {
  const d = new Date();
  return d.toLocaleString('en-US', { timeZone: 'America/Los_Angeles', dateStyle:'medium', timeStyle:'short'});
}
const timestamp = ts();
const numDays = perDay.length;
const matchRate = stats.matched && stats.lcosActive ? Math.round(stats.matched / stats.lcosActive * 100) : 0;
const firstDate = dateRange.start;
const year = firstDate.slice(0,4);
const dateRangeLabel = `${fmtDateShort(dateRange.start)} \u2013 ${fmtDateShort(dateRange.end)}, ${year}`;

// ===== DASHBOARD =====
const dashboard = [];
dashboard.push(['HLC Schedule Reconciliation','','','','','']);
dashboard.push([`LCOS vs Appointment Plus \u00b7 ${dateRangeLabel} \u00b7 Issaquah`,'','','','','']);
dashboard.push([`Run: ${timestamp}`,'','','','','']);
dashboard.push(['','','','','','']);
dashboard.push(['LCOS Student-Days','A+ Student-Days','Matched','Discrepancies','LCOS Cancelled','A+ Cancelled']);
dashboard.push([String(stats.lcosTotal), String(stats.aplusTotal), String(stats.matched), String(stats.discrepancies), String(stats.lcosCancelled), String(stats.aplusCancelled)]);
dashboard.push(['','','','','','']);
dashboard.push(['Daily Breakdown','','','','','']);
dashboard.push(['Date','LCOS','A+','Matched','Issues','Status']);
let totalL=0, totalA=0, totalM=0, totalI=0;
for (const d of perDay) {
  dashboard.push([`${fmtDay(d.date)} ${d.date}`, String(d.lcos), String(d.aplus), String(d.matched), String(d.discrepancies), d.discrepancies === 0 ? '\u2705 Clean' : `\u26A0 ${d.discrepancies} issue(s)`]);
  totalL+=d.lcos; totalA+=d.aplus; totalM+=d.matched; totalI+=d.discrepancies;
}
dashboard.push(['Totals', String(totalL), String(totalA), String(totalM), String(totalI), totalI===0?'\u2705 Clean':`\u26A0 ${totalI} total`]);
dashboard.push(['','','','','','']);
if (stats.discrepancies > 0) {
  dashboard.push(['Breakdown by Type','','','','','']);
  dashboard.push(['Type','Count','','','','']);
  for (const [type, count] of Object.entries(typeCounts)) {
    if (count > 0) dashboard.push([type, String(count),'','','','']);
  }
} else {
  dashboard.push(['\u2705 No discrepancies \u2014 schedules are in sync!','','','','','']);
}

// ===== DISCREPANCIES =====
const discSheet = [];
discSheet.push(['Schedule Discrepancies','','','','','','','']);
discSheet.push([`LCOS vs Appointment Plus \u00b7 ${dateRangeLabel} \u00b7 Issaquah`,'','','','','','','']);
discSheet.push([`Run: ${timestamp}`,'','','','','','','']);
discSheet.push(['','','','','','','','']);
discSheet.push(['Type','Student','Date','Day','LCOS Schedule','A+ Schedule','LCOS (min)','A+ (min)']);
for (const d of discrepancies) {
  discSheet.push([d.type, d.student, d.date, fmtDay(d.date), d.lcos_detail, d.aplus_detail, String(d.lcos_mins||0), String(d.aplus_mins||0)]);
}
if (discrepancies.length === 0) {
  discSheet.length = 0;
  discSheet.push([`\u2705 No discrepancies for ${dateRangeLabel}`]);
}

// ===== LCOS SCHEDULE =====
const lcosSheet = [['Date','Student Name','Client ID','Service','Subject Area','Start Time','End Time','Duration (min)','Attend Code','Status Code','Is Active','Is Cancelled','Notes']];
const lcosSorted = [...lcosRaw].sort((a,b) => a.date.localeCompare(b.date) || a.studentName.localeCompare(b.studentName) || (a.startTime||'').localeCompare(b.startTime||''));
for (const s of lcosSorted) {
  lcosSheet.push([s.date, s.studentName, s.clientId||'', s.service||'', s.subjectArea||'', s.startTime||'', s.endTime||'', String(s.durationMins||0), s.attendCode||'', s.statusCode||'', s.isActive?'TRUE':'FALSE', s.isCancelled?'TRUE':'FALSE', s.notes||'']);
}

// ===== A+ SCHEDULE =====
const aplusSheet = [['Date','Student Name','Start Time','End Time','Duration (min)','Status','Service','Staff','Notes']];
const aplusSorted = [...aplusRaw].sort((a,b) => a.date.localeCompare(b.date) || a.studentName.localeCompare(b.studentName) || (a.startTime||'').localeCompare(b.startTime||''));
for (const s of aplusSorted) {
  aplusSheet.push([s.date, s.studentName, s.startTime||'', s.endTime||'', String(s.durationMins||0), s.status||'', s.service||'', s.staff||'', s.notes||'']);
}

// ===== EMAIL HTML =====
function esc(s) { return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
const typeColors = {
  'Missing in A+': {bg:'#fff3e0', fg:'#e65100'},
  'Missing in LCOS': {bg:'#e3f2fd', fg:'#1565c0'},
  'Not Cancelled in A+': {bg:'#fce4ec', fg:'#ad1457'},
  'Not Cancelled in LCOS': {bg:'#fce4ec', fg:'#ad1457'},
  'Double Booked': {bg:'#f3e5f5', fg:'#6a1b9a'},
  'Schedule Mismatch': {bg:'#fefcbf', fg:'#975a16'}
};
function badge(text, good) {
  const style = good ? 'background:#c6f6d5;color:#276749;' : 'background:#fed7d7;color:#9b2c2c;';
  return `<span style="display:inline-block;padding:2px 8px;border-radius:4px;font-weight:600;font-size:12px;${style}">${esc(text)}</span>`;
}
function typeBadge(t) {
  const c = typeColors[t] || {bg:'#edf2f7',fg:'#4a5568'};
  return `<span style="display:inline-block;padding:2px 8px;border-radius:4px;font-weight:600;font-size:12px;background:${c.bg};color:${c.fg};">${esc(t)}</span>`;
}
const sectionH = 'margin:16px 0 6px 0;font-size:13px;font-weight:700;color:#1a365d;text-transform:uppercase;letter-spacing:0.8px;padding-bottom:6px;border-bottom:2px solid #1a365d;';
const thL = 'padding:10px 12px;background:#edf2f7;text-align:left;font-size:11px;font-weight:700;color:#4a5568;text-transform:uppercase;letter-spacing:0.5px;border-bottom:2px solid #cbd5e0;';
const thR = thL.replace('text-align:left','text-align:right');
const thC = thL.replace('text-align:left','text-align:center');
const tdL = 'padding:8px 12px;text-align:left;border-bottom:1px solid #e2e8f0;font-size:13px;';
const tdR = 'padding:8px 12px;text-align:right;border-bottom:1px solid #e2e8f0;font-size:13px;font-variant-numeric:tabular-nums;';
const tdC = 'padding:8px 12px;text-align:center;border-bottom:1px solid #e2e8f0;font-size:13px;font-variant-numeric:tabular-nums;';

let html = '';
html += '<div style="font-family:-apple-system,BlinkMacSystemFont,\'Segoe UI\',Roboto,sans-serif;background:#f0f4f8;padding:20px 0;">';
html += '<div style="max-width:860px;margin:0 auto;background:#ffffff;border-radius:8px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,0.08);">';
// Header banner
html += '<div style="background-color:#1a365d;background:linear-gradient(135deg,#1a365d 0%,#2d3748 100%);padding:28px 32px;color:#ffffff;">';
html += '<h1 style="margin:0;font-size:22px;font-weight:700;letter-spacing:-0.3px;color:#ffffff;">Huntington Learning Center &mdash; Schedule Reconciliation</h1>';
html += `<div style="font-size:14px;color:#e2e8f0;margin-top:8px;">LCOS vs Appointment Plus &middot; ${esc(dateRangeLabel)}</div>`;
html += `<div style="font-size:13px;color:#e2e8f0;margin-top:4px;">Center: <strong style="color:#7ec8e3">Issaquah</strong> &middot; ${numDays} day(s) reconciled</div>`;
const headerStatus = stats.discrepancies === 0 ? '&#x2705; No discrepancies found' : `&#x26A0; ${stats.discrepancies} discrepancies require attention`;
html += `<div style="font-size:11px;color:#cbd5e0;margin-top:8px;font-style:italic;">${headerStatus}</div>`;
html += '</div>';

// Summary cards
html += '<div style="padding:20px 26px 0;">';
html += '<table style="width:100%;border-collapse:separate;border-spacing:8px;"><tr>';
const cards = [
  { label:'LCOS Student-Days', value: stats.lcosTotal, badge: badge(`${stats.lcosActive} active`, true), sub: `${stats.lcosCancelled} cancelled/absent` },
  { label:'A+ Student-Days', value: stats.aplusTotal, badge: badge(`${stats.aplusActive} active`, true), sub: `${stats.aplusCancelled} cancelled` },
  { label:'Matched', value: stats.matched, badge: badge(`${matchRate}% match rate`, matchRate >= 90), sub: `${numDays} day(s) reconciled` },
  { label:'Discrepancies', value: stats.discrepancies, badge: stats.discrepancies === 0 ? badge('All clear', true) : badge(`${stats.discrepancies} need review`, false), sub: stats.discrepancies === 0 ? 'Schedules are in sync' : 'See details below' }
];
for (const c of cards) {
  html += `<td style="width:25%;padding:12px 14px;background:#f8fafc;border:1px solid #e2e8f0;border-radius:6px;vertical-align:top;">`;
  html += `<div style="font-size:10px;font-weight:700;color:#4a5568;text-transform:uppercase;letter-spacing:0.5px;margin-bottom:6px;">${esc(c.label)}</div>`;
  html += `<div style="font-size:20px;font-weight:700;color:#1a365d;margin-bottom:4px;">${c.value}</div>`;
  html += `<div>${c.badge}</div>`;
  html += `<div style="font-size:10px;color:#a0aec0;margin-top:4px;">${esc(c.sub)}</div>`;
  html += '</td>';
}
html += '</tr></table></div>';

// Daily breakdown
html += '<div style="padding:10px 32px 0;">';
html += `<div style="${sectionH}">Daily Breakdown</div>`;
html += '<table style="width:100%;border-collapse:collapse;">';
html += `<tr><th style="${thL}">Date</th><th style="${thR}">LCOS</th><th style="${thR}">A+</th><th style="${thR}">Matched</th><th style="${thR}">Issues</th><th style="${thC}">Status</th></tr>`;
let alt = false;
for (const d of perDay) {
  const bg = alt ? '#f8fafc' : '#ffffff'; alt = !alt;
  const issuesColor = d.discrepancies > 0 ? '#c53030' : '#276749';
  const statusCell = d.discrepancies === 0 ? badge('Clean', true) : `<span style="display:inline-block;padding:2px 8px;border-radius:4px;font-weight:600;font-size:12px;background:#feebc8;color:#9c4221;">${d.discrepancies}</span>`;
  html += `<tr style="background:${bg};">`;
  html += `<td style="${tdL}">${fmtDay(d.date)} ${d.date}</td>`;
  html += `<td style="${tdR}">${d.lcos}</td><td style="${tdR}">${d.aplus}</td><td style="${tdR}">${d.matched}</td>`;
  html += `<td style="${tdR};font-weight:700;color:${issuesColor};">${d.discrepancies}</td>`;
  html += `<td style="${tdC}">${statusCell}</td>`;
  html += '</tr>';
}
html += `<tr style="background:#edf2f7;font-weight:700;border-top:2px solid #cbd5e0;">`;
html += `<td style="${tdL};font-weight:700;">Totals</td><td style="${tdR};font-weight:700;">${totalL}</td><td style="${tdR};font-weight:700;">${totalA}</td><td style="${tdR};font-weight:700;">${totalM}</td><td style="${tdR};font-weight:700;">${totalI}</td><td style="${tdC}"></td>`;
html += '</tr></table></div>';

// Breakdown by type
if (stats.discrepancies > 0) {
  html += '<div style="padding:10px 32px 0;">';
  html += `<div style="${sectionH}">Breakdown by Type</div>`;
  html += '<table style="width:100%;border-collapse:collapse;">';
  html += `<tr><th style="${thL}">Type</th><th style="${thR}">Count</th></tr>`;
  for (const [type, count] of Object.entries(typeCounts)) {
    if (count > 0) html += `<tr><td style="${tdL}">${typeBadge(type)}</td><td style="${tdR}">${count}</td></tr>`;
  }
  html += '</table></div>';

  // Discrepancy details
  html += '<div style="padding:10px 32px 20px;">';
  const showDetails = discrepancies.slice(0,25);
  html += `<div style="${sectionH}">Discrepancy Details${discrepancies.length > 25 ? ' (Top 25)' : ''}</div>`;
  html += '<table style="width:100%;border-collapse:collapse;">';
  html += `<tr><th style="${thL}">Type</th><th style="${thL}">Student</th><th style="${thL}">Date</th><th style="${thL}">LCOS</th><th style="${thL}">A+</th></tr>`;
  alt = false;
  for (const d of showDetails) {
    const bg = alt ? '#f8fafc' : '#ffffff'; alt = !alt;
    html += `<tr style="background:${bg};">`;
    html += `<td style="${tdL}">${typeBadge(d.type)}</td>`;
    html += `<td style="${tdL}">${esc(d.student)}</td>`;
    html += `<td style="${tdL}">${fmtDay(d.date)} ${d.date}</td>`;
    html += `<td style="${tdL}">${esc(d.lcos_detail)}</td>`;
    html += `<td style="${tdL}">${esc(d.aplus_detail)}</td>`;
    html += '</tr>';
  }
  if (discrepancies.length > 25) {
    html += `<tr><td colspan="5" style="${tdL};font-style:italic;color:#718096;">... and ${discrepancies.length - 25} more &mdash; <a href="${SHEET_URL}">view full list</a></td></tr>`;
  }
  html += '</table></div>';

  // CTA
  html += `<div style="padding:0 32px 24px;text-align:right;"><a href="${SHEET_URL}" style="display:inline-block;background-color:#1a365d;color:#ffffff;text-decoration:none;padding:10px 18px;border-radius:4px;font-size:13px;font-weight:bold;">View Full Report &rarr;</a></div>`;
} else {
  html += '<div style="padding:10px 32px 20px;">';
  html += '<div style="padding:20px;text-align:center;background:#c6f6d5;border-radius:6px;margin:16px 0;">';
  html += '<div style="font-size:32px;margin-bottom:8px;">&#x1F389;</div>';
  html += '<div style="font-size:16px;font-weight:700;color:#276749;">Schedules Are In Sync!</div>';
  html += `<div style="font-size:13px;color:#4a5568;margin-top:4px;">${stats.matched} student-days matched across ${numDays} day(s)</div>`;
  html += '</div></div>';
}

// Footer
html += `<div style="background:#f7fafc;padding:14px 28px;border-top:1px solid #e2e8f0;font-size:11px;color:#a0aec0;text-align:center;">Auto-generated by HLC Automation &middot; LCOS vs A+ Reconciliation &middot; ${esc(timestamp)}</div>`;
html += '</div></div>';

const alert = stats.discrepancies > 0;
const subject = alert
  ? `ALERT Schedule Reconciliation - Issaquah - Week of ${fmtDateShort(firstDate)} ${year} (${stats.discrepancies} discrepancies)`
  : `OK Schedule Reconciliation - Issaquah - Week of ${fmtDateShort(firstDate)} ${year}`;

fs.writeFileSync('C:\\projects\\hlc-agents\\out_dashboard.json', JSON.stringify(dashboard));
fs.writeFileSync('C:\\projects\\hlc-agents\\out_discrepancies.json', JSON.stringify(discSheet));
fs.writeFileSync('C:\\projects\\hlc-agents\\out_lcos.json', JSON.stringify(lcosSheet));
fs.writeFileSync('C:\\projects\\hlc-agents\\out_aplus.json', JSON.stringify(aplusSheet));
fs.writeFileSync('C:\\projects\\hlc-agents\\out_email.html', html);
fs.writeFileSync('C:\\projects\\hlc-agents\\out_subject.txt', subject);
console.log(JSON.stringify({ dashboardRows: dashboard.length, discRows: discSheet.length, lcosRows: lcosSheet.length, aplusRows: aplusSheet.length, subject, htmlLen: html.length }, null, 2));
