/**
 * measure-race.js — does the bot get there before staff?
 *
 * The question is whether a recommendation lands before staff have dealt with the
 * message. Text Request has no read/unread state (only is_resolved / is_archived,
 * which staff toggle by hand), so "did they read it" is unobservable. The closest
 * honest proxy is the race from the CUSTOMER'S message:
 *
 *     inbound message  ->  bot posts to Slack     (bot latency)
 *     inbound message  ->  staff reply to family  (staff latency)
 *
 * Earlier I measured bot-post -> staff-reply, which flatters the bot: it starts
 * the clock when the bot speaks and ignores how long the bot took to get there.
 *
 * READ-ONLY.
 */
const fs = require('fs');
const path = require('path');
const PIPE = __dirname;
const TR = path.join(PIPE, '..', 'text-request-read');
const { TextRequestApi, readEnv } = require(path.join(TR, 'lib', 'tr-api.js'));

const state = JSON.parse(fs.readFileSync(path.join(PIPE, 'pipeline-state.json'), 'utf8'));
const dash = (JSON.parse(fs.readFileSync(path.join(TR, 'messages.json'), 'utf8')) || {}).dashboardId;
const env = readEnv(path.join(PIPE, '..', '..', '..', '.env'));
const api = new TextRequestApi(env.TR_API_KEY);

// TR timestamps are UTC but carry no 'Z'; Date would read them as local (+7h here).
const trDate = raw => {
  if (!raw) return null;
  const s = String(raw);
  const d = new Date(/(?:Z|[+-]\d{2}:?\d{2})$/.test(s) ? s : s + 'Z');
  return isNaN(d) ? null : d;
};
const dir = m => { const v = String(m.message_direction ?? '').toUpperCase(); return v === 'R' ? 'in' : v === 'S' ? 'out' : '?'; };
const med = a => a.length ? a.slice().sort((x, y) => x - y)[Math.floor(a.length / 2)] : null;
const pct = (a, p) => a.length ? a.slice().sort((x, y) => x - y)[Math.floor(a.length * p)] : null;

(async () => {
  const recs = Object.values(state.requests || {}).filter(r => r.slack?.postedISO && r.phone);
  console.log(`${recs.length} recommendations with a Slack post\n`);

  const botLat = [], staffLat = [], rows = [];
  for (const r of recs) {
    let msgs = [];
    try { msgs = await api.getRecentMessages(dash, r.phone, 50); } catch { continue; }
    const posted = new Date(r.slack.postedISO);
    const inbound = msgs.filter(m => dir(m) === 'in' && trDate(m.message_timestamp_utc))
      .map(m => trDate(m.message_timestamp_utc)).sort((a, b) => a - b);
    const outbound = msgs.filter(m => dir(m) === 'out' && trDate(m.message_timestamp_utc))
      .map(m => trDate(m.message_timestamp_utc)).sort((a, b) => a - b);

    // The customer message that triggered this recommendation: the last one before we posted.
    const trigger = [...inbound].reverse().find(d => d <= posted);
    if (!trigger) continue;
    const reply = outbound.find(d => d > trigger);       // first staff reply after that message
    const bot = (posted - trigger) / 60000;
    const staff = reply ? (reply - trigger) / 60000 : null;
    botLat.push(bot);
    if (staff != null) staffLat.push(staff);
    rows.push({ name: r.contactName, bot: Math.round(bot), staff: staff == null ? null : Math.round(staff) });
  }

  const show = (label, a) => console.log(
    `  ${label.padEnd(28)} n=${String(a.length).padStart(3)}  p25 ${String(pct(a,.25)?.toFixed(0)).padStart(5)}m` +
    `  median ${String(med(a)?.toFixed(0)).padStart(5)}m  p75 ${String(pct(a,.75)?.toFixed(0)).padStart(6)}m`);
  console.log('=== TIME FROM THE CUSTOMER MESSAGE ===');
  show('customer -> bot posts', botLat);
  show('customer -> staff replies', staffLat);

  const both = rows.filter(r => r.staff != null);
  const botWon = both.filter(r => r.bot < r.staff).length;
  console.log(`\n=== RACE (${both.length} where both happened) ===`);
  console.log(`  bot posted BEFORE staff replied: ${botWon}  (${Math.round(botWon/both.length*100)}%)`);
  console.log(`  staff replied first:             ${both.length - botWon}`);

  const within = n => both.filter(r => r.staff <= n).length;
  console.log(`\n=== HOW FAST DO STAFF MOVE? ===`);
  for (const n of [15, 30, 60, 120]) console.log(`  staff replied within ${String(n).padStart(3)} min of the customer: ${within(n)} / ${both.length}`);
  const slow = both.filter(r => r.bot > 15);
  console.log(`\n  recommendations that took the bot >15 min: ${slow.length} / ${both.length}`);
  console.log(`  (the pass runs every 15 min, so ~7.5 min average queue wait is the floor)`);

  console.log('\n=== SLOWEST BOT RESPONSES ===');
  rows.sort((a, b) => b.bot - a.bot).slice(0, 8)
    .forEach(r => console.log(`  bot ${String(r.bot).padStart(6)}m  staff ${String(r.staff ?? '-').padStart(6)}m   ${r.name}`));
})().catch(e => { console.error('failed:', e.message); process.exit(1); });
