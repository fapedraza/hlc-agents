---
name: text-request-read
description: Fetch new inbound texts from Text Request via the v3 API. Surfaces unresolved conversations whose latest message came from a customer (not staff), writes them to messages.json, and persists state.json so subsequent runs return only deltas.
user-invocable: true
allowed-tools:
  - Bash
  - Read
---

# /text-request-read — Read new texts from Text Request

Pulls the conversation list from the **Text Request v3 API** and returns the **unresolved + last-message-inbound** conversations the script hasn't seen on a previous run. For each new conversation it also fetches the **last 15 messages** so downstream skills have enough context to act (e.g. classify schedule-change requests, make scheduling recommendations). This skill does not reply to messages.

> **API-based since 2026-05-29.** Authentication is a static `x-api-key` header — **no login, no SMS MFA, no browser, no session expiry**. This can run headless/unattended (cron, Telegram trigger, etc.). The old Playwright scraper is retained as `fetch-textrequest-browser.js` for fallback only (see *Legacy browser path* below).

Arguments passed: `$ARGUMENTS`

---

## Fast path

```bash
node .claude/skills/text-request-read/fetch-textrequest-api.js [--full] [--no-threads] [--include-archived] [--out <path>]
```

- Default: writes deltas vs. `state.json` to `messages.json`, with a `thread` array (last 15 messages) on each new conversation.
- `--full`: ignore `state.json` and return every currently-unresolved-inbound conversation (first run / debugging).
- `--no-threads`: skip per-contact message fetch — last-message snippet only (faster).
- `--include-archived`: include archived conversations (default: false).
- `--out <path>`: redirect output JSON.

Prints a one-line summary, e.g.:

```
text-request (api): 7 new (of 7 unresolved inbound, 7 total unresolved), 7 threads in 1.6s → ...\messages.json
```

The whole run is one batch of API calls (≈1–2s total), not per-conversation browser navigation.

---

## Authentication: API key

The v3 API authenticates with a static key in the `x-api-key` header. The key lives in `.env` as `TR_API_KEY` (an account admin generates it under **Integrations → API Key & Webhooks** in the Text Request dashboard).

- **Base URL:** `https://api.textrequest.com/api/v3`
- **Dashboard:** the account currently has a single dashboard ("Huntington Learning Center", id `24620`), auto-selected at runtime. If the account ever has more than one, the script errors and lists them — set `TR_DASHBOARD_ID` in `.env` to pin one.

There is no session to refresh. If the key is ever rotated/revoked, the script exits with the API's `401` message — regenerate the key and update `.env`.

---

## Steps for the agent

1. **Confirm `.env` has `TR_API_KEY`** (read via `Read` tool).
2. **Run the fetcher** (`node fetch-textrequest-api.js`).
3. **Handle outcome:**
   - Exit `0`: success. Read `messages.json` if the user asked for content; otherwise the stdout summary is enough.
   - Exit `1` with a `401`: key missing/invalid → regenerate and update `TR_API_KEY`.
   - Exit `1`, "Multiple dashboards": set `TR_DASHBOARD_ID` in `.env`.
   - other: surface the stderr message verbatim.
4. **Report** the summary line plus, if the user asked for details, the contact names and snippets from `messages.json`.

---

## Output schema (`messages.json`)

```jsonc
{
  "runISO": "2026-05-29T22:40:00.000Z",
  "source": "api-v3",
  "dashboardId": 24620,
  "totalUnresolved": 7,                  // all unresolved conversations on the dashboard
  "unresolvedInboundCount": 7,           // of those, how many are last-message-inbound (candidates)
  "newCount": 3,
  "threadsScraped": 3,
  "newMessages": [
    {
      "phone": "14152978475",
      "contactName": "Jin Rudolph (Eddy and Evan Rudolph)",   // contact.display_name
      "snippet": "Then",                                       // last message body
      "lastMessageId": "3951b4ba-4f11-453c-b5d7-f7900f440398", // stable; basis of the dedupe hash
      "lastMessageUtc": "2026-05-29T22:32:49.977",
      "dateText": "05/29/2026",            // last message time, formatted in America/Los_Angeles
      "timeText": "03:32 PM",
      "lastFromStaff": false,
      "isResolved": false,                 // from the contact record
      "threadId": "166382ad-...",          // app.textrequest.com/app/thread/<threadId>
      "hash": "9f4c1e2a3b5d7f60",          // sha256(phone | lastMessageId)[:16] — dedupe key
      "thread": [                          // last 15 messages, chronological (oldest → newest)
        {
          "direction": "outbound",         // "inbound" (R, from customer) | "outbound" (S, from staff) | "unknown"
          "text": "Hi this is Huntington and just wanted to confirm...",
          "timestamp": "2026-05-29T22:22:01.63",   // message_timestamp_utc (UTC)
          "staffName": "Rachel W"          // response_by_username on outbound; "" otherwise
        }
      ]
      // "threadError": "<message>"         // present only if the message fetch failed; "thread" is then []
      // "contactError": "<message>"        // present only if the contact fetch failed
    }
  ]
}
```

When `--no-threads` is passed, the `thread` field is omitted from each row.

`state.json` next to the script tracks `{ lastRunISO, seenHashes }`, capped at the most recent 5000 hashes. A conversation whose contact/thread fetch failed is **not** added to `seenHashes`, so the next run re-surfaces it and retries — incomplete context is never permanently dropped.

> **One-time re-surface:** the dedupe hash changed from the old scraper's `sha256(name|date|time|snippet)` to `sha256(phone|lastMessageId)`. The first API run re-surfaces conversations the browser scraper had already seen. This is expected and self-corrects after that run.

---

## API mapping (v3)

| Need | Endpoint / field |
|---|---|
| Dashboards | `GET /dashboards` → `{ id, name, phone }` |
| Unresolved conversations + last message | `GET /dashboards/{id}/conversations?show_unresolved_only=true` → items `{ phone_number, last_message }` |
| Last-message direction | `last_message.message_direction` — `R` = received (inbound/customer), `S` = sent (staff) |
| Contact display name / resolved flag | `GET /dashboards/{id}/contacts/{phone}` → `display_name`, `is_resolved`, `is_archived`, `thread_id` |
| Thread messages | `GET /dashboards/{id}/contacts/{phone}/messages` (newest-first; client reverses) → `{ body, message_direction, message_timestamp_utc, response_by_username }` |
| Pagination | `page` (0-based) + `page_size` query params; `meta.total_items` in response |

Full OpenAPI spec saved locally as `apiv3docs.yml` (docs: <https://www.textrequest.com/api/v3>).

---

## Out of scope (deferred)

- Replying to messages. (The API *can* send via `POST .../messages`, but replying stays with the downstream `schedule-request` skill under human approval.)
- Full thread history beyond the last 15 messages (raise `THREAD_LIMIT` / paginate `getRecentMessages` if needed).
- Classifying messages as schedule-change-related — lives in the downstream `schedule-request` skill consuming `messages.json`.
- **Webhooks:** the API supports `POST /dashboards/{id}/hooks` to get pushed new messages in real time instead of polling — a natural future upgrade now that auth is stable.

---

## Legacy browser path (fallback)

`fetch-textrequest-browser.js` is the original Playwright scraper of `app.textrequest.com/app/queue`. It is **superseded by the API** and kept only as a fallback if the API is ever unavailable. It requires `TR_USERNAME` / `TR_PASSWORD` and a headed `--login` step to clear the account's **SMS MFA** (no remember-device), persisting an IndexedDB-backed session under `user-data/`. Exit codes: `2` = no saved session (run `--login`), `3` = session expired (re-run `--login`). Its DOM selectors (queue rows `[data-sid]`, `.txr-queue__contact-recipient`, thread `.thread__message.recived`/`.sent`, the Userlane overlay quirk, etc.) are documented in the file's comments. Prefer the API path for anything automated.

---

## Files

| File | Role |
|---|---|
| `SKILL.md` | This spec |
| `fetch-textrequest-api.js` | **Primary.** v3 API fetcher (no auth ritual) |
| `lib/tr-api.js` | Text Request v3 API client (`x-api-key`, pagination) |
| `apiv3docs.yml` | Saved v3 OpenAPI spec (reference) |
| `state.json` | `{ lastRunISO, seenHashes[] }` for dedupe |
| `messages.json` | Latest run's new-messages output |
| `fetch-textrequest-browser.js` | Legacy Playwright scraper (fallback only) |
| `user-data/` | Persistent Chromium profile for the legacy path (tens of MB) |
| `messages.browser-last.json` / `state.browser-last.json` | Backups of the final browser-era run |
