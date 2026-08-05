/**
 * post-slack.js — Post a concise schedule-reconcile summary to a Slack channel.
 *
 * Reads SLACK_BOT_TOKEN and RECONCILE_SLACK_CHANNEL from .env (channel can also
 * be passed as 2nd CLI arg). Calls https://slack.com/api/chat.postMessage.
 *
 * Usage: node post-slack.js <reconciliation.json> [channel-id]
 */

const fs = require('fs');
const https = require('https');

const ENV_PATH = 'C:\\projects\\hlc-agents\\.env';

function readEnv(p) {
  if (!fs.existsSync(p)) return {};
  const out = {};
  for (const line of fs.readFileSync(p, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (m) out[m[1]] = m[2].replace(/^['"]|['"]$/g, '');
  }
  return out;
}

// --dry-run prints the message instead of sending it. Its sibling in
// schedule-request already had this; without it the only way to check what the
// daily reconcile will say was to post it to staff. Note the channel is
// POSITIONAL, so "--dry-run" would otherwise be read as a channel id and fail
// with channel_not_found.
const argv = process.argv.slice(2).filter(a => a !== '--dry-run');
const DRY_RUN = process.argv.includes('--dry-run');
const [reconPath, channelArg] = argv;
if (!reconPath) {
  console.error('Usage: node post-slack.js <reconciliation.json> [channel-id]');
  process.exit(1);
}

const env = readEnv(ENV_PATH);
const token = env.SLACK_BOT_TOKEN;
const channel = channelArg || env.RECONCILE_SLACK_CHANNEL;
if (!token) { console.error('SLACK_BOT_TOKEN not set in .env'); process.exit(1); }
if (!channel) { console.error('RECONCILE_SLACK_CHANNEL not set (and no channel arg given)'); process.exit(1); }

const recon = JSON.parse(fs.readFileSync(reconPath, 'utf8'));
const { stats, typeCounts, discrepancies, dates } = recon;

function fmtDateShort(ymd) {
  const d = new Date(ymd + 'T12:00:00');
  return ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'][d.getDay()] + ' ' + (d.getMonth()+1) + '/' + d.getDate();
}
const dateRange = dates.length === 1 ? fmtDateShort(dates[0]) : `${fmtDateShort(dates[0])} – ${fmtDateShort(dates[dates.length-1])}`;
const sheetUrl = env.RECONCILE_SHEET_ID ? `https://docs.google.com/spreadsheets/d/${env.RECONCILE_SHEET_ID}` : null;

let text;
if (stats.discrepancies === 0) {
  text = `:white_check_mark: *Schedule Reconciliation — Issaquah — ${dateRange}*\nAll clear: ${stats.matched} student-days matched, no discrepancies.`;
  if (sheetUrl) text += `\n<${sheetUrl}|View full report>`;
} else {
  const lines = [
    `:warning: *Schedule Reconciliation — Issaquah — ${dateRange}*`,
    `${stats.discrepancies} discrepancies need review (${stats.matched}/${stats.lcosActive} matched).`,
  ];
  const typeOrder = ['Missing in A+','Missing in LCOS','Not Cancelled in A+','Not Cancelled in LCOS','Schedule Mismatch','Double Booked','Session/Retest Overlap','Tutor Overloaded','1:1 Double Booked','Tutor Rule Violation'];
  for (const t of typeOrder) {
    if (typeCounts[t]) lines.push(`• *${t}:* ${typeCounts[t]}`);
  }
  if (sheetUrl) lines.push(`<${sheetUrl}|View full report>`);
  text = lines.join('\n');
}

if (DRY_RUN) {
  console.log('=== DRY RUN — reconcile Slack message preview ===');
  console.log(text);
  process.exit(0);
}

const body = JSON.stringify({ channel, text, unfurl_links: false, unfurl_media: false });

const req = https.request({
  method: 'POST',
  hostname: 'slack.com',
  path: '/api/chat.postMessage',
  headers: {
    'Content-Type': 'application/json; charset=utf-8',
    'Authorization': `Bearer ${token}`,
    'Content-Length': Buffer.byteLength(body),
  },
}, (res) => {
  let data = '';
  res.on('data', c => data += c);
  res.on('end', () => {
    try {
      const json = JSON.parse(data);
      if (!json.ok) {
        console.error('Slack post failed:', json.error || data);
        process.exit(1);
      }
      console.log(`Slack: posted to ${channel} (ts=${json.ts})`);
    } catch (e) {
      console.error('Slack response parse error:', e.message, data);
      process.exit(1);
    }
  });
});
req.on('error', e => { console.error('Slack request error:', e.message); process.exit(1); });
req.write(body);
req.end();
