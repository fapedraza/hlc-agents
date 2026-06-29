---
name: schedule-reconcile
description: Reconcile student session schedules between LCOS and Appointment-Plus for the upcoming week. Compares both systems, flags discrepancies (missing sessions, time mismatches, cancellation mismatches, double bookings), outputs a Google Sheet and sends an HTML email report.
user-invocable: true
allowed-tools:
  - mcp__lcos__lcos_sign_in_sheet
  - mcp__lcos__lcos_get_schedule
  - mcp__lcos__lcos_query
  - mcp__playwright__browser_navigate
  - mcp__playwright__browser_snapshot
  - mcp__playwright__browser_take_screenshot
  - mcp__playwright__browser_evaluate
  - mcp__playwright__browser_click
  - mcp__playwright__browser_fill_form
  - mcp__playwright__browser_select_option
  - mcp__playwright__browser_press_key
  - mcp__playwright__browser_type
  - mcp__playwright__browser_tabs
  - mcp__playwright__browser_wait_for
  - mcp__gmail-center__send_email
  - Bash
  - Read
---

# /schedule-reconcile — LCOS vs A+ Schedule Reconciliation

Compares student session schedules between LCOS and Appointment-Plus for a date range, flags discrepancies, and produces a Google Sheet + HTML email report.

**Architecture:** The heavy lifting lives in Node scripts under this skill's directory. The agent's job is (1) parse args, (2) drive the A+ browser flow, (3) invoke each script, and (4) send the final email. Do **not** re-implement parsing, reconciliation, sheet writes, or HTML templating in-context — those are solved by the scripts.

Arguments passed: `$ARGUMENTS`

**Working directory for intermediate artifacts:** `C:\projects\hlc-agents\` (scripts write `lcos_parsed.json`, `reconciliation.json`, `email.html`, `payload.json` here).

---

## Fast path: standalone runner (preferred for on-demand calls)

If you are running this skill from a **non-interactive context** (Telegram bot, scheduler, scripted Claude session) and don't need to interactively debug each step, **just shell out to the standalone runner** instead of stepping through Steps 1–6 manually:

```bash
node .claude/skills/schedule-reconcile/run-reconcile-standalone.js \
  [--start=YYYY-MM-DD] [--end=YYYY-MM-DD] \
  [--email-to=a@b.com,c@d.com] [--no-email] \
  [--slack-channel=CXXXXXXXX] [--no-slack]
```

This runs the entire pipeline (LCOS fetch → A+ fetch → reconcile → Sheet → email → Slack) in ~20-25 seconds without using any MCP tools — `fetch-lcos.js` shells to 32-bit PowerShell ODBC, `fetch-aplus.js` runs headless Playwright, `send-email.js` uses cached Gmail OAuth tokens, and `post-slack.js` POSTs directly to `slack.com/api/chat.postMessage` using the bot token in `.env`. Defaults: tomorrow→+7 days, recipients `staff@huntingtonissaquah.com` + `riddickb@hlcmail.com`, Slack channel from `RECONCILE_SLACK_CHANNEL` in `.env`.

**Use Steps 1–6 below only when** you need to inspect intermediate output, debug a specific stage, or run interactively with a human in the loop.

When a user asks via Telegram (or any chat) something like *"run the schedule recon for April 22 to 28 and send it to alice@example.com"*, parse the dates and recipient and invoke the standalone runner directly.

---

## Step 0 — Parse Arguments

Parse `$ARGUMENTS` for:

- **Date range:** two dates (any format) → start and end. Convert start to YYYY-MM-DD and M/D/YYYY forms.
- **`--no-email`:** skip Step 5.
- **`--email-to=<addr1,addr2,...>`:** override default recipients.

Defaults if no dates given: start = tomorrow, end = today+7.

Default recipients (if no `--email-to`): `staff@huntingtonissaquah.com`, `riddickb@hlcmail.com`.

---

## Step 1 — Pull LCOS Data

### 1.1 Call the tool
Call `mcp__lcos__lcos_sign_in_sheet` with `startDate` and `endDate` in YYYY-MM-DD form.

### 1.2 Handle the overflow file
The response will almost always exceed the 144k-char tool-result limit and spill to a file like `C:\Users\<user>\.claude\projects\<session>\tool-results\mcp-lcos-lcos_sign_in_sheet-<ts>.txt`. Read the path from the overflow message — **do not read the file into context**.

### 1.3 Normalize via script
```bash
node .claude/skills/schedule-reconcile/parse-lcos.js \
  <overflow-file-path> \
  C:/projects/hlc-agents/lcos_parsed.json
```
The script writes `{sessions, blocks}` with full normalization (names lowercased+suffix-stripped+alphabetized, times → HH:MM 24h, dates → YYYY-MM-DD, `isActive` for ATD/MU/EXT, `isCancelled` for ABS/VAC/ANM). Do not re-implement this in-context.

---

## Step 2 — Pull A+ Data

This step needs the browser, so the agent drives it.

### 2.1 Navigate
`https://account.appointment-plus.com/ap/ap_admin_v2/appointments_index_v2.php?p=reports`

### 2.2 Auto-login if needed
If URL contains `login.php`: read `AP_USERNAME` / `AP_PASSWORD` from `C:\projects\hlc-agents\.env`, fill the form, submit, then navigate back to the reports URL.

### 2.3 Drive the report form
All form interactions target the `slots` frame. Use `browser_evaluate` with:
```js
const doc = document.querySelector('frame[name="slots"]').contentDocument;
```

Then:
1. In the `select[name="report_id"]` dropdown, pick the option whose text matches **"Aplus Schedule Report"**, and dispatch a `change` event.
2. Set `#apt_date_from` to start date in `M/D/YYYY`, `#apt_date_to` to end date.
3. Click `#run_the_report`.
4. A CSV downloads to `C:\projects\hlc-agents\.playwright-mcp\appointplus*.csv`. Note the exact filename from the playwright download event.

### 2.4 What NOT to do
Do not parse the CSV, filter cancelled statuses, or build A+ blocks in-context. `reconcile.js` does all of that.

---

## Step 3 — Reconcile

```bash
node .claude/skills/schedule-reconcile/reconcile.js \
  C:/projects/hlc-agents/lcos_parsed.json \
  <csv-path-from-Step-2> \
  <start-YYYY-MM-DD> \
  <end-YYYY-MM-DD> \
  C:/projects/hlc-agents/reconciliation.json
```

Writes `reconciliation.json` with `{startDate, endDate, dates, stats, perDay, typeCounts, discrepancies, lcosSessions, aplusSessions}`.

**Reference only — implemented by the script:**

- Discrepancy types (priority order): Missing in A+ → Missing in LCOS → Not Cancelled in A+ → Not Cancelled in LCOS → Schedule Mismatch → Double Booked → Session/Retest Overlap
- **Session/Retest Overlap** (added 2026-05-30, requested by Mariah): a student is booked into a **retest** (A+ staff name contains "retest", e.g. "McRetest Retest") AND a regular tutoring session at overlapping times on the same day. Retests are otherwise excluded from the LCOS↔A+ reconcile (they aren't recurring LCOS sessions), but the active ones are kept solely for this check. One flag per student/day.
- Time tolerance: ±5 minutes
- A+ cancel statuses: `cancelled`, `canceled`, `no-show`, `no show`, `noshow`, `deleted`, `removed`, `void`, `anm`, `anm - paid`, `anm - unpaid`, `absent no makeup`
- LCOS active codes: `ATD`, `MU`, `EXT`
- LCOS cancel codes: `ABS`, `VAC`, `ANM`
- Excluded A+ services: `head teacher`, `training/shadow`, `admin project`
- Excluded staff: names containing `retest`

---

## Step 4 — Write Google Sheet

```bash
node .claude/skills/schedule-reconcile/write-sheet.js \
  C:/projects/hlc-agents/reconciliation.json \
  --create-if-missing
```

- Sheet ID is read from `RECONCILE_SHEET_ID` in `C:\projects\hlc-agents\.env`.
- With `--create-if-missing`: if the env var is absent or the sheet is 404, the script creates a new spreadsheet titled "HLC Schedule Reconciliation — Issaquah", shares it with `fapedraza@gmail.com` as writer, and appends `RECONCILE_SHEET_ID=<new-id>` to `.env`.
- Service account path is `SERVICE_ACCOUNT_PATH` in `.env` (defaults to `C:\LCOS\service-account.json`).
- The script deletes and recreates all 4 tabs (Dashboard, Discrepancies, LCOS Schedule, A+ Schedule) with full formatting in a single batch call. Typical runtime: ~5 seconds.

**Do not write to Google Sheets via MCP tools.** The batch API via service account is orders of magnitude faster than per-range MCP updates.

---

## Step 5 — Send Email Report

Skip if `--no-email` was passed.

### 5.1 Build the email
```bash
node .claude/skills/schedule-reconcile/build-payload.js \
  C:/projects/hlc-agents/reconciliation.json
```

Writes two files to `C:\projects\hlc-agents\`:
- `email.html` — the full HTML body (inline styles, max 860px, banner + 4 summary cards + daily breakdown + type breakdown + top-25 discrepancies + CTA or celebration)
- `payload.json` — metadata including the computed `subject` line

The CTA link reads from `RECONCILE_SHEET_ID` in `.env`.

### 5.2 Send via gmail tool
- `to`: recipient list from Step 0 (default or `--email-to` override)
- `subject`: read `payload.json` → `.subject`
- `htmlBody`: contents of `email.html`
- `body`: short plaintext fallback, e.g. `"Schedule reconciliation for Issaquah — {dateRange}. {N} discrepancies. See HTML for details."`
- `mimeType`: `text/html`

**Subject format (built by build-payload.js):**
- 0 disc: `OK Schedule Reconciliation - Issaquah - Week of {DayShort M/D} {year}`
- N > 0: `ALERT Schedule Reconciliation - Issaquah - Week of {DayShort M/D} {year} (N discrepancies)`

---

## Step 6 — Report to User

Print a one-message summary:
- Date range
- LCOS vs A+ student-day counts
- Matched + match rate %
- Discrepancy count by type
- Google Sheet URL (`https://docs.google.com/spreadsheets/d/<RECONCILE_SHEET_ID>`)
- Whether email was sent and to whom

---

## Error Handling

- **LCOS returns no data:** warn, continue with A+ data only (all A+ will show as "Missing in LCOS").
- **A+ login fails:** stop; ask user to verify `.env` credentials.
- **A+ report returns no rows:** warn, continue with LCOS data only.
- **Both empty:** inform user, skip sheet/email.
- **`write-sheet.js` fails:** try again once; if still failing, fall back to `emit-tabs.js` (chunked) — but diagnose first.
- **Email send fails:** log and continue — the Sheet is the primary output.

---

## Files

| File | Role |
|---|---|
| `SKILL.md` | This spec (agent workflow) |
| `parse-lcos.js` | LCOS overflow-file → normalized `{sessions, blocks}` JSON |
| `reconcile.js` | LCOS JSON + A+ CSV → `reconciliation.json` |
| `write-sheet.js` | `reconciliation.json` → Google Sheet (4 tabs, full formatting) |
| `build-payload.js` | `reconciliation.json` → `email.html` + `payload.json` |
| `make-short-email.js` | Compact email variant (alternative codepath) |
| `emit-tabs.js` | Chunk fallback if `write-sheet.js` fails |
| `lookup-schedules.js` | Show current + future recurring schedule blocks for a student |

---

## LCOS quirk: stale schedules from `sp_sign_in_sheet`

`sp_sign_in_sheet` only applies the `max(startdate)` "latest schedule wins" filter for `clt_status.statuscode = 'ENR'` students. For `CONF`, `DROP`, and ST `INQ`/`DT`, it returns rows from **every** unended SCHG/CHGSRV/NEWSRV change — so when a new schedule is added without setting `enddate` on the prior `clt_changes` row, both old and new rows come through and produce false "Not Cancelled in LCOS" discrepancies. The LCOS UI applies the override on top, so the SP and the UI disagree.

`fetch-lcos.js` mirrors the UI's behavior: after running the SP, it queries `clt_changes` (SCHG/CHGSRV/NEWSRV) and `clt_scheduling` for the clientids in the SP output, computes the active scheduleid per (client, date) using max-startdate, and drops SP rows that don't match either an active recurring slot or a SPEC entry. SPEC rows are always preserved. To bypass the filter for debugging: `--no-override-filter`.

---

## Configuration

Reads from `C:\projects\hlc-agents\.env`:

| Key | Purpose | Default |
|---|---|---|
| `AP_USERNAME` / `AP_PASSWORD` | A+ auto-login | (required) |
| `RECONCILE_SHEET_ID` | Persistent Google Sheet | created on first run |
| `SERVICE_ACCOUNT_PATH` | GCP service account JSON for Sheet writes | `C:\LCOS\service-account.json` |

---

## Diagnosing discrepancies — future schedule lookup

Some discrepancies fire because LCOS has a future-dated schedule change that hasn't fully replaced the old block (e.g. the new block was added but the old day-of-week row wasn't deactivated). To inspect all recurring schedule blocks for a student — current, past, and future — plus any SPEC exceptions:

```bash
node .claude/skills/schedule-reconcile/lookup-schedules.js "<name or clientid>"
```

Recurring blocks live in `DBA.clt_scheduling` with `scheduleid = MMDDYY<service>` encoding the effective start date. `SPEC` rows are single-event exceptions (cancellations, makeups) and reference their parent block via `referenceid`.

---

## Name Aliases

Add known name discrepancies here as they are discovered:
(none yet)
