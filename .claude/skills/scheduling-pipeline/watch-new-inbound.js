/* Background watcher: wait until the autonomous session processes a NEW inbound
   (a hash beyond the current baseline), then exit so the watching agent can
   inspect the session transcript. Polls pipeline-state every 60s. */
const fs = require('fs');
const path = require('path');
const STATE = path.join(__dirname, 'pipeline-state.json');
const BASELINE = new Set([
  'c39a548a99c728f2', '9b43ee6c7304b4dd', 'd3a7291c15ed5186', '54d6c18e9094048f', 'f434d2987c9ad051',
]);
const MAX_POLLS = 360;     // ~6h at 60s
const STUCK_AFTER = 8;     // polls a new hash may sit at 'new' before we flag it
const firstSeen = {};

let poll = 0;
const tick = () => {
  poll++;
  let reqs = {};
  try { reqs = JSON.parse(fs.readFileSync(STATE, 'utf8')).requests || {}; } catch {}
  const fresh = Object.values(reqs).filter(r => !BASELINE.has(r.hash));
  for (const r of fresh) {
    if (!(r.hash in firstSeen)) firstSeen[r.hash] = poll;
    const processed = r.status !== 'new';
    const stuck = (poll - firstSeen[r.hash]) >= STUCK_AFTER;
    if (processed || stuck) {
      console.log(JSON.stringify({
        event: processed ? 'processed' : 'stuck',
        hash: r.hash, contactName: r.contactName, status: r.status,
        skipReason: r.skipReason || null, recommendedAction: r.recommendedAction || null,
      }));
      process.exit(0);
    }
  }
  if (poll >= MAX_POLLS) { console.log(JSON.stringify({ event: 'timeout', polls: poll })); process.exit(0); }
  setTimeout(tick, 60000);
};
console.log('watching pipeline-state for the next new inbound (baseline ' + BASELINE.size + ' hashes)…');
tick();
