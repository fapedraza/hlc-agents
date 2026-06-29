# scheduling-pipeline — continuous tracking → recommend → decide → (act)

Ties together [text-request-read] (read texts via TR v3 API) and [schedule-request]
(produce a scheduling recommendation) into a continuous loop, and captures staff
decisions from Slack so we can eventually apply changes.

## Locked decisions (with the user, 2026-05-30)
1. **Auto-post.** New inbound scheduling messages are classified, run through
   schedule-request, and the recommendation is **posted to #scheduling
   automatically**. The human gate is in Slack (✅/✏️/❌), not before posting.
2. **Decision input = reaction + optional reply.** Staff react on the
   recommendation message (✅ approve / ✏️ edit / ❌ override) as the *signal*;
   an optional thread reply carries *detail* (which tutor, edits).
3. **Always-on.** Runs as a continuously-looping background Claude Code session
   (like the Telegram bridge), pacing itself via `/loop`. Claude does the
   classification (LLM judgment); deterministic scripts do TR polling, A+
   orchestration, Slack posting/listening, and state.

## Architecture

```
Text Request (API)                          Slack #scheduling
   │ new inbound                                 │ ▲
   ▼                                             ▼ │ staff ✅/✏️/❌ (+reply)
 PIECE 1: auto-recommend            PIECE 2: decision listener
 poll → classify → schedule-        poll reactions+replies on
 request → post → record            recommended msgs → record
   │            ▲                              │
   └──────▶ pipeline-state.json ◀──────────────┘
                  │  (the spine)
                  ▼  PIECE 3 (deferred): apply approved → LCOS / A+ / TR reply
```

## State spine — `pipeline-state.json` (managed by `lib/pipeline-state.js`)
One record per scheduling request, keyed by the TR conversation hash
(`sha256(phone | last_message_id)` — same key text-request-read uses), so the
pipeline-state IS the "handled" set (no double delta-tracking).

```jsonc
{
  "version": 1,
  "updatedISO": "...",
  "requests": {
    "<hash>": {
      "hash", "phone", "contactName", "threadId",
      "firstSeenISO", "lastUpdateISO",
      "status": "new|classified|skipped|recommended|decided|actioned|error",
      "skipReason": null,                 // when status=skipped (e.g. not-scheduling, teacher)
      "classification": { "requestType","subject","student","proposedDate","proposedTime","sessionLength","candidateTutors","discover" } | null,
      "recommendationFile": null,         // path to the saved recommendation JSON
      "recommendedAction": null,          // PROCEED|MULTIPLE_OPTIONS|ALREADY_BOOKED|BLOCKED
      "slack": { "channel","ts","postedISO" } | null,
      "decision": { "signal":"approve|edit|override", "tutor":null, "by":null, "text":null, "decidedISO":null } | null,
      "action": null                      // Phase 3
    }
  }
}
```

Status flow: `new → classified → (skipped | recommended) → decided → actioned`.

## Pieces

### Piece 1 — auto-recommend (`pipeline-run`, agentic skill step)
Per loop pass: fetch new TR inbound (`text-request-read --full`), and for each
hash NOT already in pipeline-state:
1. **Classify** (LLM): scheduling? type? subject (customer words)? date/time?
   student hint (multi-student)? tutor(s) named? → payload, or `skipped`.
2. Run `schedule-request/demo-orchestrate.js` → recommendation JSON.
3. `post-slack.js` → #scheduling. Record `recommended` + slack ts in state.
Non-scheduling / teacher-originated / info-only → `skipped` with reason.

When `pending` finds new threads it **pre-warms the schedule-request history
cache** (`schedule-request/prewarm-history.js`) so the first `process` run
doesn't pay the ~60-70s whole-center A+ Schedule Report pull. The pull is
launched **detached in the background** — `pending` returns immediately, so
classification overlaps the download (log: `.cache/prewarm.log`). The pull holds
a lock, so a `process` run that starts before it finishes **waits for that
result instead of double-pulling**; the cache write is atomic. Best-effort
(never fails `pending`) and instant when the cache is already fresh (default 3h;
env `SR_HISTORY_CACHE_MIN` to tune). See schedule-request `SKILL.md` →
"History pull cost".

### Piece 2 — decision listener (`poll-decisions.js`, deterministic) ✅ build first
Per loop pass: for every `recommended` record with a slack ts, read the
message's reactions and thread replies; map to a decision and set
`status=decided` + `decision{}`. Reaction → signal; reply → detail.

### Piece 3 — take action (deferred)
Consume `decided` + approved records → apply LCOS / A+ / TR-reply writes
(Phase 2/3 of schedule-request). Designed-for, not built.

## Reaction → signal map
- ✅ `white_check_mark` / `heavy_check_mark` → **approve**
- ✏️ `pencil2` / `memo` → **edit**
- ❌ `x` / `negative_squared_cross_mark` → **override**

## Run model
A background Claude Code session loops via `/loop`, each pass running Piece 1
then Piece 2. Polling cadence self-paced (e.g. every few minutes). Task
Scheduler can launch the session (see the Telegram service pattern). For dev,
run the pieces on-demand.
