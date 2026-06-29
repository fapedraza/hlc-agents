const fs = require('fs');
const path = require('path');

const reconPath = process.argv[2];
const recon = JSON.parse(fs.readFileSync(reconPath, 'utf8'));
const { stats, dates, discrepancies, typeCounts, perDay } = recon;

function fmtShort(ymd) {
  const d = new Date(ymd + 'T00:00:00');
  const day = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'][d.getDay()];
  return `${day} ${d.getMonth()+1}/${d.getDate()}`;
}
function fmtLong(ymd) {
  const d = new Date(ymd + 'T00:00:00');
  return d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
}
function esc(s) { return String(s == null ? '' : s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }

const dateRange = dates.length === 1 ? fmtLong(dates[0]) : `${fmtLong(dates[0])} — ${fmtLong(dates[dates.length-1])}`;
const matchRate = Math.round((stats.matched / Math.max(stats.lcosActive, stats.aplusActive, 1)) * 100);
const sheetUrl = 'https://docs.google.com/spreadsheets/d/1f9tpPdkGMk0AYntuawh05_b3tJrcnm0jzCJOfiAz3Bk';
const timestamp = new Date().toLocaleString('en-US', { month:'short', day:'numeric', year:'numeric', hour:'numeric', minute:'2-digit', hour12:true });

const typeColors = {
  'Missing in A+': ['#fff3e0','#e65100'],
  'Missing in LCOS': ['#e3f2fd','#1565c0'],
  'Not Cancelled in A+': ['#fce4ec','#ad1457'],
  'Not Cancelled in LCOS': ['#fce4ec','#ad1457'],
  'Double Booked': ['#f3e5f5','#6a1b9a'],
  'Schedule Mismatch': ['#fefcbf','#975a16'],
  'Session/Retest Overlap': ['#ffcdd2','#b71c1c']
};
const tbadge = t => {
  const [bg, fg] = typeColors[t] || ['#edf2f7','#4a5568'];
  return `<span style="display:inline-block;padding:2px 8px;border-radius:4px;font-size:11px;font-weight:600;background:${bg};color:${fg};">${esc(t)}</span>`;
};

const th = 'padding:8px 10px;background:#edf2f7;text-align:left;font-size:11px;font-weight:700;color:#4a5568;text-transform:uppercase;border-bottom:2px solid #cbd5e0;';
const td = 'padding:6px 10px;text-align:left;border-bottom:1px solid #e2e8f0;font-size:12px;';

let perDayRows = '';
let totL=0,totA=0,totM=0,totI=0;
for (const d of perDay) {
  totL += d.lcos; totA += d.aplus; totM += d.matched; totI += d.discrepancies;
  const issueColor = d.discrepancies > 0 ? '#c53030' : '#276749';
  perDayRows += `<tr><td style="${td}">${fmtShort(d.date)}</td><td style="${td};text-align:right;">${d.lcos}</td><td style="${td};text-align:right;">${d.aplus}</td><td style="${td};text-align:right;">${d.matched}</td><td style="${td};text-align:right;font-weight:700;color:${issueColor};">${d.discrepancies}</td></tr>`;
}
perDayRows += `<tr style="background:#edf2f7;font-weight:700;"><td style="${td}">Total</td><td style="${td};text-align:right;">${totL}</td><td style="${td};text-align:right;">${totA}</td><td style="${td};text-align:right;">${totM}</td><td style="${td};text-align:right;color:${totI>0?'#c53030':'#276749'};">${totI}</td></tr>`;

let typeRows = '';
const typeOrder = ['Missing in A+','Missing in LCOS','Not Cancelled in A+','Not Cancelled in LCOS','Schedule Mismatch','Double Booked','Session/Retest Overlap'];
for (const t of typeOrder) if (typeCounts[t]) typeRows += `<tr><td style="${td}">${tbadge(t)}</td><td style="${td};text-align:right;font-weight:700;">${typeCounts[t]}</td></tr>`;

let discRows = '';
const shown = discrepancies.slice(0, 25);
for (const d of shown) {
  discRows += `<tr><td style="${td}">${tbadge(d.type)}</td><td style="${td}">${esc(d.student)}</td><td style="${td}">${fmtShort(d.date)}</td><td style="${td};color:#4a5568;">${esc(d.lcos_detail)}</td><td style="${td};color:#4a5568;">${esc(d.aplus_detail)}</td></tr>`;
}
if (discrepancies.length > 25) discRows += `<tr><td colspan="5" style="${td};text-align:center;font-style:italic;color:#718096;">... and ${discrepancies.length - 25} more &mdash; <a href="${sheetUrl}">view full list</a></td></tr>`;

const headerStatus = stats.discrepancies === 0 ? '&#x2705; No discrepancies' : `&#x26A0; ${stats.discrepancies} discrepancies`;
const successBlock = stats.discrepancies === 0 ? `<div style="padding:20px;text-align:center;background:#c6f6d5;border-radius:6px;margin:16px 32px;"><div style="font-size:32px;">&#x1F389;</div><div style="font-size:16px;font-weight:700;color:#276749;">Schedules Are In Sync!</div><div style="font-size:13px;color:#4a5568;margin-top:4px;">${stats.matched} student-days matched across ${dates.length} day(s)</div></div>` : '';

const cta = stats.discrepancies > 0 ? `<div style="padding:0 32px 24px;text-align:right;"><a href="${sheetUrl}" style="display:inline-block;background:#1a365d;color:#fff;text-decoration:none;padding:10px 18px;border-radius:4px;font-size:13px;font-weight:bold;">View Full Report &rarr;</a></div>` : '';

const typeSection = stats.discrepancies > 0 ? `<div style="padding:0 32px;"><div style="margin:16px 0 6px;font-size:13px;font-weight:700;color:#1a365d;text-transform:uppercase;letter-spacing:0.8px;padding-bottom:6px;border-bottom:2px solid #1a365d;">By Type</div><table width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;"><tr><th style="${th}">Type</th><th style="${th};text-align:right;">Count</th></tr>${typeRows}</table></div>` : '';

const discSection = stats.discrepancies > 0 ? `<div style="padding:0 32px;"><div style="margin:16px 0 6px;font-size:13px;font-weight:700;color:#1a365d;text-transform:uppercase;letter-spacing:0.8px;padding-bottom:6px;border-bottom:2px solid #1a365d;">Discrepancy Details${discrepancies.length>25?' (Top 25)':''}</div><table width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;"><tr><th style="${th}">Type</th><th style="${th}">Student</th><th style="${th}">Date</th><th style="${th}">LCOS</th><th style="${th}">A+</th></tr>${discRows}</table></div>` : '';

const dailySection = dates.length > 1 ? `<div style="padding:4px 32px 0;"><div style="margin:16px 0 6px;font-size:13px;font-weight:700;color:#1a365d;text-transform:uppercase;letter-spacing:0.8px;padding-bottom:6px;border-bottom:2px solid #1a365d;">Daily Breakdown</div><table width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;"><tr><th style="${th}">Date</th><th style="${th};text-align:right;">LCOS</th><th style="${th};text-align:right;">A+</th><th style="${th};text-align:right;">Matched</th><th style="${th};text-align:right;">Issues</th></tr>${perDayRows}</table></div>` : '';

const html = `<!DOCTYPE html><html><body style="margin:0;padding:0;background:#f0f4f8;font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,sans-serif;"><div style="max-width:860px;margin:0 auto;background:#fff;"><div style="background:linear-gradient(135deg,#1a365d 0%,#2d3748 100%);padding:24px 32px;color:#fff;"><h1 style="margin:0;font-size:22px;font-weight:700;color:#fff;">Huntington Learning Center &mdash; Schedule Reconciliation</h1><div style="font-size:14px;color:#e2e8f0;margin-top:8px;">LCOS vs Appointment Plus &middot; ${esc(dateRange)}</div><div style="font-size:13px;color:#e2e8f0;margin-top:4px;">Center: <strong style="color:#7ec8e3">Issaquah</strong> &middot; ${dates.length} day(s)</div><div style="font-size:11px;color:#cbd5e0;margin-top:8px;font-style:italic;">${headerStatus}</div></div><div style="padding:20px 32px;"><table width="100%" cellpadding="0" cellspacing="8" style="border-collapse:separate;"><tr><td style="width:25%;padding:10px;background:#f8fafc;border:1px solid #e2e8f0;border-radius:6px;vertical-align:top;"><div style="font-size:10px;font-weight:700;color:#4a5568;text-transform:uppercase;">LCOS</div><div style="font-size:20px;font-weight:700;color:#1a365d;">${stats.lcosTotal}</div><div style="font-size:10px;color:#a0aec0;">${stats.lcosActive} active &middot; ${stats.lcosCancelled} cancelled</div></td><td style="width:25%;padding:10px;background:#f8fafc;border:1px solid #e2e8f0;border-radius:6px;vertical-align:top;"><div style="font-size:10px;font-weight:700;color:#4a5568;text-transform:uppercase;">A+</div><div style="font-size:20px;font-weight:700;color:#1a365d;">${stats.aplusTotal}</div><div style="font-size:10px;color:#a0aec0;">${stats.aplusActive} active &middot; ${stats.aplusCancelled} cancelled</div></td><td style="width:25%;padding:10px;background:#f8fafc;border:1px solid #e2e8f0;border-radius:6px;vertical-align:top;"><div style="font-size:10px;font-weight:700;color:#4a5568;text-transform:uppercase;">Matched</div><div style="font-size:20px;font-weight:700;color:#1a365d;">${stats.matched}</div><div style="font-size:10px;color:#a0aec0;">${matchRate}% match rate</div></td><td style="width:25%;padding:10px;background:#f8fafc;border:1px solid #e2e8f0;border-radius:6px;vertical-align:top;"><div style="font-size:10px;font-weight:700;color:#4a5568;text-transform:uppercase;">Discrepancies</div><div style="font-size:20px;font-weight:700;color:${stats.discrepancies>0?'#c53030':'#276749'};">${stats.discrepancies}</div><div style="font-size:10px;color:#a0aec0;">${stats.discrepancies===0?'All clear':'Need review'}</div></td></tr></table></div>${dailySection}${typeSection}${discSection}${successBlock}${cta}<div style="background:#f7fafc;padding:12px;border-top:1px solid #e2e8f0;font-size:11px;color:#a0aec0;text-align:center;">Auto-generated &middot; ${esc(timestamp)}</div></div></body></html>`;

fs.writeFileSync(path.join(path.dirname(reconPath), 'email.short.html'), html);
console.log('short email size:', html.length);
