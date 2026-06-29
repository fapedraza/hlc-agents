/**
 * fetch-textrequest.js — Read inbound texts from app.textrequest.com
 *
 * Two modes:
 *   --login   Headed browser. Auto-fills email + password, waits for the user
 *             to enter the SMS MFA code in the popped browser window, then
 *             persists the authenticated session into the userDataDir.
 *
 *   (default) Headless. Reuses the userDataDir. Navigates to /app/queue,
 *             scrapes unresolved conversations whose latest message is inbound,
 *             opens each new conversation's thread to capture the last
 *             THREAD_LIMIT messages for context, writes new entries (vs.
 *             state.json) to messages.json, and updates state.json. Exits
 *             non-zero if the session has expired — caller should re-run with
 *             --login.
 *
 * Why a userDataDir instead of storageState({path}):
 *   Text Request's Angular app stores auth state in IndexedDB (`ngStorage`).
 *   Playwright's storageState only captures cookies + localStorage, so a
 *   storageState-backed context still fails the route guard. A persistent
 *   userDataDir persists IndexedDB too.
 *
 * Usage:
 *   node fetch-textrequest.js --login
 *   node fetch-textrequest.js [--full] [--no-threads] [--out <path>]
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { chromium } = require('playwright');

const SKILL_DIR = __dirname;
const ENV_PATH = 'C:\\projects\\hlc-agents\\.env';
const USER_DATA_DIR = path.join(SKILL_DIR, 'user-data');
const STATE_PATH = path.join(SKILL_DIR, 'state.json');
const DEFAULT_MESSAGES_PATH = path.join(SKILL_DIR, 'messages.json');
const QUEUE_URL = 'https://app.textrequest.com/app/queue';
const LOGIN_URL = 'https://app.textrequest.com/app/login';
const SEEN_CAP = 5000;
const THREAD_LIMIT = 15; // most recent N messages captured per conversation thread

function readEnv(p) {
  if (!fs.existsSync(p)) return {};
  const out = {};
  for (const line of fs.readFileSync(p, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (m) out[m[1]] = m[2].replace(/^['"]|['"]$/g, '');
  }
  return out;
}

function parseArgs(argv) {
  const a = { login: false, full: false, noThreads: false, out: DEFAULT_MESSAGES_PATH };
  for (let i = 0; i < argv.length; i++) {
    const v = argv[i];
    if (v === '--login') a.login = true;
    else if (v === '--full') a.full = true;
    else if (v === '--no-threads') a.noThreads = true;
    else if (v === '--out') a.out = argv[++i];
    else if (v.startsWith('--out=')) a.out = v.slice('--out='.length);
  }
  return a;
}

function hashRow({ contactName, dateText, timeText, snippet }) {
  return crypto
    .createHash('sha256')
    .update([contactName, dateText, timeText, snippet].join('|'))
    .digest('hex')
    .slice(0, 16);
}

async function loginAndSaveState(env) {
  console.log('Login mode: opening browser. Enter the SMS code when prompted.');
  fs.mkdirSync(USER_DATA_DIR, { recursive: true });
  const context = await chromium.launchPersistentContext(USER_DATA_DIR, { headless: false });
  const page = context.pages()[0] || await context.newPage();
  try {
    await page.goto(LOGIN_URL, { waitUntil: 'domcontentloaded' });

    // Text Request's login is staged, and which stage we land on varies:
    //   - 'email'    fresh — asks for the email address first
    //   - 'password' remembered account — "Welcome back!" skips straight to password
    //   - 'queue'    session still valid — no login needed
    const stage = await Promise.race([
      page.waitForSelector('input[type="email"]', { timeout: 30000 }).then(() => 'email'),
      page.waitForSelector('input[type="password"]', { timeout: 30000 }).then(() => 'password'),
      page.waitForSelector('[data-sid]', { timeout: 30000 }).then(() => 'queue'),
    ]).catch(() => 'unknown');

    if (stage === 'unknown') {
      throw new Error(`Login page not recognized (url=${page.url()})`);
    }

    if (stage === 'queue') {
      console.log('Already authenticated — existing session still valid.');
    } else {
      // Stage 1 (email) — only when Text Request doesn't remember the account.
      if (stage === 'email') {
        await page.fill('input[type="email"]', env.TR_USERNAME);
        await page.click('button:has-text("CONTINUE")');
        await page.waitForSelector('input[type="password"]', { timeout: 20000 });
      }

      // Stage 2 (password)
      await page.fill('input[type="password"]', env.TR_PASSWORD);
      await page.click('button:has-text("LOG IN")');

      // Stage 3 (SMS code) — entered manually by the user in the visible window.
      console.log('Waiting for you to enter the SMS code in the browser window...');
      await page.waitForURL(/\/app\/queue/, { timeout: 5 * 60 * 1000 });
    }

    // Let the queue actually render so IndexedDB writes finish before we close.
    await page.waitForSelector('[data-sid]', { timeout: 30000 });
    await page.waitForTimeout(2000);
    console.log(`Saved authenticated session to ${USER_DATA_DIR}`);
  } finally {
    await context.close();
  }
}

function loadState() {
  if (!fs.existsSync(STATE_PATH)) return { lastRunISO: null, seenHashes: [] };
  try {
    const j = JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'));
    return { lastRunISO: j.lastRunISO || null, seenHashes: Array.isArray(j.seenHashes) ? j.seenHashes : [] };
  } catch {
    return { lastRunISO: null, seenHashes: [] };
  }
}

function saveState(state) {
  const trimmed = { ...state, seenHashes: state.seenHashes.slice(-SEEN_CAP) };
  fs.writeFileSync(STATE_PATH, JSON.stringify(trimmed, null, 2));
}

async function scrapeQueue(page) {
  // Wait for at least one queue row to render.
  await page.waitForSelector('[data-sid]', { timeout: 30000 });
  // Give Angular a moment to settle so all visible rows hydrate.
  await page.waitForTimeout(1500);

  return page.evaluate(() => {
    const rows = Array.from(document.querySelectorAll('[data-sid]'))
      .filter(el => el.querySelector('.txr-queue__message'));
    return rows.map(r => {
      const inner = r.querySelector('.txr-queue__message');
      const isResolved = inner.classList.contains('resolved');
      const contactName = r.querySelector('.txr-queue__contact-recipient')?.innerText?.trim() || null;
      const snippet = r.querySelector('.txr-queue__text')?.innerText?.trim() || '';
      const timeText = r.querySelector('.msg-time')?.innerText?.trim() || '';
      const dateText = r.querySelector('.msg-date')?.innerText?.trim() || '';
      const staffInitials = r.querySelector('.sent-name .short-letters span')?.innerText?.trim()
        || r.querySelector('.sent-name .short-letters')?.innerText?.trim()
        || '';
      const lastFromStaff = staffInitials.length > 0;
      return {
        sid: r.dataset.sid,
        contactName,
        snippet,
        timeText,
        dateText,
        staffInitials,
        lastFromStaff,
        isResolved,
      };
    });
  });
}

/**
 * Text Request embeds a Userlane product-tour overlay that loads asynchronously.
 * Its full-screen backdrop (#userlane-backdrop-full) intercepts pointer events
 * and blocks clicks on the queue rows underneath. Strip every Userlane node so
 * thread scraping can click freely. Cheap, so we call it before each click.
 */
async function dismissOverlays(page) {
  await page.evaluate(() => {
    document.querySelectorAll('[id^="userlane"], .userlane-base, [data-usln]')
      .forEach(el => el.remove());
  }).catch(() => {});
}

/**
 * Open one conversation's thread (by clicking its queue row) and scrape the
 * most recent THREAD_LIMIT messages in chronological order. The thread pane
 * renders newest-at-bottom and auto-scrolls there on open, so the last N
 * messages are already in the DOM — no scroll-up pagination needed.
 *
 * Side effect: opening a thread marks its messages as read in Text Request.
 * This does NOT resolve the conversation, so it stays in the unresolved queue.
 */
async function scrapeThread(page, sid) {
  const rowSel = `[data-sid="${sid}"]`;
  // Click the conversation card to open its thread.
  await dismissOverlays(page);
  await page.click(`${rowSel} .txr-queue__message`, { timeout: 10000 });
  // Confirm this row became the active conversation, then let the thread render.
  await page.waitForSelector(`${rowSel} .txr-queue__message.txr-queue__current`, { timeout: 10000 });
  await page.waitForSelector('.thread__message', { timeout: 15000 });
  await page.waitForTimeout(1000);

  const messages = await page.evaluate(() => {
    const norm = s => (s || '').replace(/\s+/g, ' ').trim();
    return Array.from(document.querySelectorAll('.thread__message')).map(m => {
      const direction = m.classList.contains('recived') ? 'inbound'
        : m.classList.contains('sent') ? 'outbound'
        : 'unknown';
      const text = norm(m.querySelector('.thread__message-ballon')?.innerText);
      // Timestamp = the container text with the bubble text removed (best effort).
      const container = m.querySelector('.thread__message-container') || m;
      let timestamp = norm(container.innerText);
      if (text && timestamp.includes(text)) timestamp = norm(timestamp.replace(text, ''));
      const staffName = direction === 'outbound'
        ? norm(m.querySelector('.sent-name')?.innerText)
        : '';
      return { direction, text, timestamp: timestamp || null, staffName };
    }).filter(x => x.text);
  });

  return messages.slice(-THREAD_LIMIT);
}

async function fetchMessages(args) {
  if (!fs.existsSync(USER_DATA_DIR)) {
    console.error(
      `No saved session at ${USER_DATA_DIR}. ` +
      `Run \`node fetch-textrequest.js --login\` first to authenticate.`,
    );
    process.exit(2);
  }

  const state = args.full ? { lastRunISO: null, seenHashes: [] } : loadState();
  const seenSet = new Set(state.seenHashes);
  const t0 = Date.now();

  const context = await chromium.launchPersistentContext(USER_DATA_DIR, { headless: true });
  const page = context.pages()[0] || await context.newPage();

  try {
    await page.goto(QUEUE_URL, { waitUntil: 'domcontentloaded' });
    // The Angular SPA may briefly land on /app/login during hydration even when authenticated.
    // Race a queue-row appearing against a stable login form to determine which page we're on.
    let landed;
    try {
      landed = await Promise.race([
        page.waitForSelector('[data-sid]', { timeout: 30000 }).then(() => 'queue'),
        page.waitForSelector('input[type="email"]', { timeout: 30000 }).then(() => 'login'),
      ]);
    } catch {
      landed = 'unknown';
    }
    if (landed !== 'queue') {
      console.error(
        `Session expired or unexpected page (landed=${landed}, url=${page.url()}). ` +
        'Re-run with --login to refresh the saved session.',
      );
      await context.close();
      process.exit(3);
    }

    const rows = await scrapeQueue(page);

    // For v1: surface unresolved conversations whose last message was inbound (no staff initials).
    const candidates = rows
      .filter(r => !r.isResolved && !r.lastFromStaff && r.contactName)
      .map(r => ({ ...r, hash: hashRow(r) }));

    const newMessages = candidates.filter(c => !seenSet.has(c.hash));

    // Open each new conversation's thread to capture recent context. Per-thread
    // failures degrade that row to snippet-only rather than failing the run.
    let threadsScraped = 0;
    if (!args.noThreads) {
      for (const m of newMessages) {
        try {
          m.thread = await scrapeThread(page, m.sid);
          threadsScraped++;
        } catch (err) {
          m.thread = [];
          m.threadError = err.message || String(err);
        }
      }
    }

    const runISO = new Date().toISOString();
    const out = {
      runISO,
      totalQueueRows: rows.length,
      unresolvedInboundCount: candidates.length,
      newCount: newMessages.length,
      threadsScraped,
      newMessages,
    };
    fs.writeFileSync(args.out, JSON.stringify(out, null, 2));

    // Rows whose thread failed to scrape are left UNSEEN so the next run
    // retries them — we don't want to permanently drop incomplete context.
    const updatedSeen = state.seenHashes.concat(
      newMessages.filter(m => !m.threadError).map(m => m.hash),
    );
    saveState({ lastRunISO: runISO, seenHashes: updatedSeen });

    const dt = ((Date.now() - t0) / 1000).toFixed(1);
    console.log(
      `text-request: ${newMessages.length} new (of ${candidates.length} unresolved inbound, ` +
      `${rows.length} total queue rows), ${threadsScraped} threads scraped in ${dt}s → ${args.out}`,
    );
  } finally {
    await context.close();
  }
}

(async () => {
  const args = parseArgs(process.argv.slice(2));
  const env = readEnv(ENV_PATH);

  if (args.login) {
    if (!env.TR_USERNAME || !env.TR_PASSWORD) {
      console.error(`TR_USERNAME / TR_PASSWORD missing from ${ENV_PATH}`);
      process.exit(1);
    }
    await loginAndSaveState(env);
    return;
  }

  await fetchMessages(args);
})().catch(err => {
  console.error(err.stack || err.message || String(err));
  process.exit(1);
});
