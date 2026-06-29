---
name: scheduling-pipeline
description: Continuous loop that tracks new Text Request scheduling messages, auto-posts schedule-request recommendations to #scheduling, and captures staff decisions (reactions + replies). Designed to run in an always-on background Claude session via /loop. Phase 3 (applying changes) is deferred.
user-invocable: true
allowed-tools:
  - Bash
  - Read
  - Write
---

# /scheduling-pipeline — track → recommend → capture decision → (act)

Ties [text-request-read] + [schedule-request] into a continuous pipeline and
captures staff decisions from Slack. Full design + locked decisions: `PIPELINE.md`.

Two deterministic scripts + one LLM step (classification, done by you):
- **Piece 1 — auto-recommend:** `pipeline-run.js` (`pending` / `process` / `skip` / `status`)
- **Piece 2 — decision listener:** `poll-decisions.js`
- State spine: `lib/pipeline-state.js` → `pipeline-state.json` (keyed by the TR
  conversation hash; doubles as the "already handled" set).

## One loop pass (what the background session does each interval)

1. **Find new messages + register them:**
   ```bash
   node pipeline-run.js pending
   ```
   Fetches current unresolved-inbound via the TR v3 API, registers anything not
   already tracked as `new`, and prints each new thread as JSON.

2. **Classify each `new` thread (LLM — your judgment).** Work ONLY from the
   thread text that `pending` already printed — do NOT open other files and do
   NOT look anything up.

   > ⛔ **Critical:** in this step you use ONLY `Bash`, `Read`, `Write`. Do NOT
   > call any `mcp__lcos__*` / Appointment-Plus / Slack tools, and never invent
   > tool names. ALL student resolution, LCOS, A+ qualification/availability, and
   > Slack posting happen *inside* `node pipeline-run.js process` — your job is
   > just to turn a thread into a payload (or skip it) and run that one command.

   For each `new` thread, decide:
   - **Not schedulable** (teacher-originated `(Teacher)`, info-only, chit-chat, or
     a request with no actionable ask) →
     ```bash
     node pipeline-run.js skip <hash> "<reason>"
     ```
   - **Schedulable** → write `payloads/<hash>.json` = a schedule-request payload
     **plus** the `hash`, filling fields from the thread text alone:
     ```json
     { "hash":"<from pending>", "contactName":"...", "student":"<name/nickname if multi-student>",
       "requestType":"new-session|reschedule|makeup|cancel",
       "subject":"<customer words, e.g. 'IB English'>",
       "proposedDate":"YYYY-MM-DD", "proposedTime":"4:30pm", "sessionLength":"1 hour",
       "candidateTutors":["Hana"], "discover":true }
     ```
     Then:
     ```bash
     node pipeline-run.js process payloads/<name>.json
     ```
     This runs schedule-request (live A+ quals/availability/conflicts), auto-posts
     the compact recommendation to `#scheduling`, and marks the record
     `recommended` with the Slack ts. (Add `--dry-run` to preview without posting.)
   - **Missing a concrete day/time** (e.g. "sometime next week"): either pick a
     tentative slot and note it, or `skip <hash> "needs-info: ask for day/time"`
     and let staff request specifics. Prefer not to post guessed slots live.

3. **Capture staff decisions:**
   ```bash
   node poll-decisions.js
   ```
   Reads ✅/✏️/❌ reactions + thread replies on every `recommended` message and
   moves it to `decided` with `{signal, tutor?, by, text}`. Reaction = signal
   (override > edit > approve); reply = detail.

4. **Report** the pass (new / recommended / skipped / decided counts) and loop.

## Running it always-on — PER-TICK model
`service/` holds the launcher. **Each tick is a fresh, short-lived `claude -p`
pass** (Task Scheduler every 15 min) — NOT a long-lived `/loop` session. The old
long-lived session stalled after ~9h and silently froze monitoring for days; a
fresh process per tick can't do that.
- `run-pass.bat` — runs one headless `claude -p "<one-pass prompt>"` (stdin `< NUL`),
  logs to `~/.claude/logs/scheduling-pipeline-pass.log`, exits.
- `scheduling-pipeline-settings.json` — allow-list (no telegram plugin, no
  `--channels` → no 409 with ClaudeTelegramService).
- `install-scheduling-pipeline-service.ps1` — registers `ClaudeSchedulingPipeline`:
  trigger **every 15 min** + at logon, **IgnoreNew** (no overlap), **14-min cap**,
  runs hidden as the logged-on user (needs Claude auth).

Note: `claude -p "/scheduling-pipeline"` does NOT auto-run the skill (a slash
command isn't invoked in `-p` mode) — the `.bat` passes an explicit instruction
prompt that names the steps.

**Shakedown:** set `SCHEDULING_PIPELINE_DRYRUN=1` in `run-pass.bat` so `process`
drafts + previews but posts nothing; remove to go live. For dev, run the steps by hand.

## Status flow
`new → classified → (skipped | recommended) → decided → actioned`
(`actioned` = Phase 3, deferred — applying the approved change to LCOS/A+/TR.)

## Scopes / creds
- Text Request: `TR_API_KEY` (v3 API).
- Slack: `SLACK_BOT_TOKEN` with `chat:write`, `channels:history`, `channels:read`,
  `users:read` (all granted). Reactions are read via `conversations.history`
  (no `reactions:read` needed). **One-click voting:** `process` posts with
  `--seed-reactions`, which makes the bot pre-seed ✅/✏️/❌ on each message so
  staff vote with one tap — this needs the `reactions:write` scope added to the
  bot (until then it warns and skips, the post still succeeds).

## Files
| File | Role |
|---|---|
| `PIPELINE.md` | Design doc + locked decisions |
| `pipeline-run.js` | Piece 1 — pending / process / skip / status |
| `poll-decisions.js` | Piece 2 — Slack decision listener |
| `lib/pipeline-state.js` | State spine (`pipeline-state.json`) |
| `payloads/` | Per-message classified payloads (you write these) |
| `recommendations/` | Saved recommendation JSON per request (by hash) |
