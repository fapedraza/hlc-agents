/**
 * webhook-doorbell.js — Text Request pushes; we stop polling for the last mile.
 *
 * TR fires a webhook on every new inbound message. This listener is a DOORBELL,
 * not a parser: it validates the secret in the path, answers 200 immediately,
 * and kicks the scheduling pipeline task. The gate then decides what to do —
 * which makes the payload shape irrelevant and the listener nearly unbreakable.
 *
 * With the 2-minute gate as fallback, the pipeline no longer depends on this
 * process existing at all; the doorbell only removes the last ~2 minutes of
 * polling latency. Failure mode is "slightly slower", never "silent".
 *
 * Binds 127.0.0.1 only; Tailscale Funnel terminates public HTTPS and proxies in.
 */
const http = require('http');
const { execFile } = require('child_process');
const fs = require('fs');

const ENV_PATH = 'C:\\projects\\hlc-agents\\.env';
const env = {};
for (const line of fs.readFileSync(ENV_PATH, 'utf8').split(/\r?\n/)) {
  const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/);
  if (m) env[m[1]] = m[2].replace(/^['"]|['"]$/g, '');
}
const SECRET = env.WEBHOOK_SECRET;
if (!SECRET) { console.error('WEBHOOK_SECRET missing from .env'); process.exit(1); }
const PORT = 8787;
const DEBOUNCE_MS = 10_000;
let lastKick = 0;

const log = m => console.log(new Date().toISOString() + ' ' + m);

http.createServer((req, res) => {
  // Health probe (no secret) for funnel checks.
  if (req.method === 'GET' && req.url === '/healthz') { res.writeHead(200); res.end('ok'); return; }
  if (req.url !== `/hook/${SECRET}`) { res.writeHead(404); res.end(); return; }
  // Drain and ignore the body — the event's existence is the only signal we use.
  req.resume();
  res.writeHead(200, { 'Content-Type': 'text/plain' }); res.end('ok');
  const now = Date.now();
  if (now - lastKick < DEBOUNCE_MS) { log('hook: debounced'); return; }
  lastKick = now;
  execFile('schtasks', ['/run', '/tn', 'ClaudeSchedulingPipeline'], (err, so, se) => {
    log(err ? `hook: kick FAILED — ${(se || err.message).trim()}` : 'hook: pipeline kicked');
  });
}).listen(PORT, '127.0.0.1', () => log(`doorbell listening on 127.0.0.1:${PORT}`));
