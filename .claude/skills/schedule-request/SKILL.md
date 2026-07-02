---
name: schedule-request
description: Take a Text Request scheduling-related conversation and produce a scheduling recommendation. Resolves the student in LCOS, identifies candidate tutors, live-checks A+ qualifications + availability + bookings, and emits a recommendation (PROCEED / MULTIPLE_OPTIONS / ALREADY_BOOKED / BLOCKED) for human review. No writes — Phase 1 is recommend-only.
user-invocable: true
allowed-tools:
  - mcp__lcos__lcos_get_active_students
  - mcp__lcos__lcos_get_schedule
  - mcp__lcos__lcos_query
  - Bash
  - Read
  - Write
---

# /schedule-request — Scheduling agent (Phase 1, recommend-only)

Consumes a conversation surfaced by `text-request-read` and produces a scheduling
recommendation. No autonomous writes — every action is a recommendation a human
must confirm. Background and decisions: see `PLAN.md` in this folder.

Arguments: `$ARGUMENTS`

---

## Stage 0 — Classify the conversation
LLM reasoning over the conversation `thread[]` (from `text-request-read/messages.json`).

> **Act on the LATEST unresolved request only.** These are long-lived per-family
> threads. Ignore earlier asks that a staff reply already resolved — anchor on the
> most recent customer message that still needs action. (This is the *Atlas* bug:
> the bot resolved a schedule change from *May* instead of the current June ask.)
> If the latest request has no concrete date/time, capture the range in
> `timeWindow` and leave `proposedTime` empty rather than inventing a date.

Decide:
- **requestType:** `cancel` · `reschedule` · `makeup` · `new-session` · `program` · `info-only` · `not-scheduling` · `teacher-originated`
- **subject:** the customer-facing subject **in a few words** (e.g. "IB English", "AP Stats", "math"). The orchestrator maps it to A+ service names via `subject-map.json`. **Never put a phrase/description or a date here** ("makeup for Monday's session") — the orchestrator now rejects a non-subject and falls back to the student's enrolled service, but a clean subject is better. For makeups/reschedules you can leave it as the student's subject.
- **proposedDate / proposedTime / sessionLength:** as expressed in the thread. For a **program** request use `sessionsPerWeek` (int) + `timeWindow` instead of a single date/time.
- **latestInboundDate** (optional, ISO): the date of the latest customer message. If it's >2 weeks old the orchestrator flags the rec as possibly stale.
- **candidateTutors:** tutors named in the thread (e.g. "Tim"). **If none are named, leave it empty** — the orchestrator anchors on the student's real A+ session history (their actual tutors for this slot; see Stage 4 step 2.4) and only falls back to subject discovery for a brand-new student/subject. You don't need to supply the existing tutor for makeups/reschedules — history surfaces it.
- **student:** for a multi-student contact (e.g. `"Zahera Shaik (Shaheer (JB) and Sarah Shaikh)"`), which child the request is about — a name or nickname (`"JB"`). Passed through to `resolve-student` to disambiguate.

If `requestType` is `not-scheduling`, `info-only`, or `teacher-originated`, stop and report — no further data needed.

## Stage 1 — Resolve the student
1. Refresh the roster: call `mcp__lcos__lcos_get_active_students`; save the `rows` array to `lcos-roster.json` in this folder. (Once per session is plenty.)
2. Run `node resolve-student.js "<contactName>" lcos-roster.json` (or `require('./resolve-student').resolveStudent(contactName, roster, { student })` in-process). Returns `bestMatch` + `confidence` (`high` / `medium` / `low` / `none`) + `targetStudent`.
   - **Multi-student contacts** like `"... (Shaheer (JB) and Sarah Shaikh)"` are parsed into all students (nested parens, nicknames, and a shared trailing surname are handled). Pass `{ student: "JB" }` (name or nickname) to pick the right one; without a hint the top scorer wins.
3. `confidence: low` → surface the candidates and **ask the user to confirm** before proceeding. `none` (or `isTeacherContact: true`) → stop, report.

## Stage 2 — Pull student context (LCOS)
- `mcp__lcos__lcos_get_schedule(clientId, startDate, endDate)` for ±2 weeks around the proposed date — past sessions reveal the student's **current/preferred tutor**, future sessions reveal whether the request is already booked. *(Note: LCOS sessions carry student + service + subject but NOT staffid — staff lives in A+.)*
- For more context: query `DBA.clt_scheduling` directly via `mcp__lcos__lcos_query` (e.g. `WHERE clientid = '<id>' AND eventdate BETWEEN ...`).

## Stage 3 — Build the request payload
Compose a `payload.json` for `demo-orchestrate.js`:
```json
{
  "contactName": "Pelita Batingan (Ryan Batingan)",
  "requestType": "new-session",
  "subject": "Chemistry",
  "proposedDate": "2026-05-27",
  "proposedTime": "7:30pm",
  "sessionLength": "1 hour",
  "candidateTutors": ["Tim"],
  "student": null,
  "discover": false
}
```
- **`student`** (optional): disambiguates a multi-student contact (name or nickname).
- **`candidateTutors`** empty **or** **`discover: true`** → the orchestrator discovers subject-qualified tutors from the quals index and live-verifies them (Stage 4). Named tutors are always evaluated first; discovery tops up the list. A **bare first name** ("Jennifer") is disambiguated against the *student's own history* (there are several Jennifers on staff) — see Stage 4.
- **`requestType`** drives the action: `cancel` → `CANCEL` (no tutor logic); `reschedule`/`makeup` → keep the same tutor (carry-over); `program` → `PROGRAM_OFFER`; else the normal recommend flow.
- **`fromDate`** (optional, reschedule): ISO date of the session being moved — its tutor (and the student's continuity) carries over to the new slot.
- **`timeWindow`** (optional): `{ "start": "11:00", "end": "15:00" }` (24h) when the family gives a *range* instead of an exact time. With no `proposedTime`, the orchestrator returns `OFFER_SLOTS` (open times) instead of checking one slot.
- **`sessionsPerWeek`** (int, program): triggers `PROGRAM_OFFER` — a proposed recurring weekly schedule (N open slots across distinct days) with the anchored tutor. Pair with `timeWindow` and optional `weekStart` (ISO Monday; defaults to next week).
- **`latestInboundDate`** (optional, ISO): age-checked to flag stale requests.

## Stage 4 — Live A+ lookups + recommendation
```bash
node demo-orchestrate.js payload.json --out recommendation.json
node demo-orchestrate.js payload.json --backtest --out recommendation.json   # back-test mode
```

**Back-test mode (`--backtest`)** treats the student's existing booking at the proposed slot as **ground truth** (what staff actually did) instead of short-circuiting to `ALREADY_BOOKED`. Use this to replay a resolved historical thread and check whether the agent would have made the same decision staff did. The output includes a `comparison` block with `matchVerdict ∈ { match, mismatch, agent-blocked-but-staff-acted, no-ground-truth }` so you can score the agent against real staff outcomes.

What it does (in order):
1. Resolves the student again (sanity check) against `lcos-roster.json`, honoring `payload.student`.
2. Loads the booked-appointments CSV from `C:/projects/hlc-agents/aplus.csv` (produced by the most recent schedule-reconcile run). If older than ~24h, rerun the reconcile first or fetch a narrow-range A+ report.
2.4. **Student-history anchor (primary tutor source).** Pulls the wide A+ "Aplus Schedule Report" (ID 763) over a ~150-day-back / 45-day-forward window (`lib/fetch-history.js`) and summarizes the resolved student's real pattern (`lib/student-history.js`): who actually teaches them, on which day/time, typical duration. The candidate pool becomes **the student's own tutors**, ranked for the proposed slot (slot match > same day > frequency/recency); the session length defaults from history when the thread didn't state one. A history tutor is qualification-proven by the fact they teach this student — important for Learning Center students whose A+ service doesn't map to a subject string. Admin placeholders (e.g. "Head Teacher") are filtered via `non-tutors.json`. Pass `--no-history` to skip the (slow) report pull. This is the fix for the "bot guessed a subject and reverse-engineered a tutor" failure mode.
2.5. **Candidate discovery (fallback only).** When there are **no** named tutors **and no** history (a genuinely new student/subject), it reads the quals index (`aplus-quals.json`, via `lib/discover-tutors.js`) and adds the top subject-qualified tutors (capped at 8). The index is a fast shortlist only — every candidate is still live-verified in step 3, so a stale/incomplete index can only *miss* a tutor, never wrongly recommend one. Keep the index fresh with `node fetch-aplus-quals.js`.
3. Opens a live A+ session and, for each candidate tutor:
   - `getTeacherQuals(page, teacher)` — **all 4 pages** of Services Offered (paginates via `fnChangeServicesPage(target, true)`).
   - `getTeacherSchedule(page, teacher)` — weekly working-hours template (24h-normalized).
   - **Effective availability (#4):** the template lags reality (summer changes, exceptions), so availability is the **union of the template and the tutor's REAL bookings on that weekday** (from the wide report). A stale "OFF" template no longer hides a tutor who demonstrably works then. An own-student booking at the slot is likewise authoritative → `ALREADY_BOOKED` even if the template says off.
   - Identifies overlapping bookings on the proposed date; separates **own-student matches** (already booked — no action needed) from **conflicts** (someone else holds the slot).
4. Emits one of:
   - `ALREADY_BOOKED` — the proposed slot is already this student's session with this tutor. Verify payment + confirm.
   - `PROCEED` — one tutor passes qualification + working-hours + conflict checks. For a reschedule this is the **same tutor** as the moved session (carry-over), not a re-rank by the new slot.
   - `CANCEL` — `requestType: cancel`: lists the student's existing session(s) on the date to remove. No tutor reasoning.
   - `OFFER_SLOTS` — the family gave a time *range*/no exact time, or the requested slot is taken: proposes the (correct) tutor's open times that day (`suggestedSlots: [{start,end,label}]`) for staff to offer — mirroring what staff do in ~56% of threads (`lib/slots.js`).
   - `PROGRAM_OFFER` — a program request (`sessionsPerWeek ≥ 2`): a proposed **recurring weekly schedule** (`proposedSchedule: [{date,day,start,end,label}]`) with the anchored tutor, honoring the student's historical day/time where open. For staff to confirm — not a single session.
   - `MULTIPLE_OPTIONS` — back-compat only; the orchestrator now picks one.
   - `BLOCKED` — no tutor passes and no slots to offer; the `reason` field gives the failing check.

   **Tutor disambiguation:** a bare first-name tutor is resolved against the *student's* history first (prefer the tutor who teaches *this* student), fixing the wrong-"Jennifer" false-block found in the conversation back-test.

## Stage 5 — Publish to `#scheduling` for staff to validate
```bash
node post-slack.js recommendation.json --channel CMR1PPZ9B
# preview without sending:
node post-slack.js recommendation.json --dry-run
```

`post-slack.js` composes a **compact** message — only what staff need to act:
- **Header:** `*Student* — Subject · Day Date Time`. A `⚠️ student match: <conf> confidence` line appears only when the resolve confidence is below `high`.
- **Recommendation, shaped by action:** `ALREADY_BOOKED`/`PROCEED` name the single tutor; `MULTIPLE_OPTIONS` lists only the *usable* tutors (with `(current tutor)` tag when the tutor already teaches this student) plus a `(checked N; M unavailable)` summary; `BLOCKED` shows the reason.
- **Caveat:** the recommendation's `note` (e.g. a subject-mapping warning) as a `⚠️` line, if present.
- **Customer context:** the last two inbound (customer) messages, autoresponders filtered — captures split requests.
- **Reply draft** (payment-free) the staff can copy/edit, and a `✅ … · ✏️ edit · ❌ override` footer.
- Full detail (clientid, every evaluated tutor, the LCOS/A+/payment breakdown) stays in the recommendation JSON, not the Slack post.
- Posts to `#scheduling` (channel `CMR1PPZ9B`) via the bot token in `.env` (`SLACK_BOT_TOKEN`) — same channel the reconcile skill uses, so scheduling staff already monitor it. `--dry-run` previews without sending; `chat.delete` (bot token) removes a posted message by `ts`.

Staff validates in Slack and applies the LCOS / A+ / Text-Request changes manually (Phase 1). Phase 2 / 3 will automate those writes on explicit approval.

## End-to-end one-liner

For a hand-built payload, the full pipeline is two commands:
```bash
node demo-orchestrate.js payload.json --out recommendation.json
node post-slack.js recommendation.json
```

For the back-test version (replaying a resolved thread to compare against staff's actual outcome), add `--backtest`:
```bash
node demo-orchestrate.js payload.json --backtest --out recommendation.json
node post-slack.js recommendation.json
```

## Back-test harness (batch)

Replay a whole directory of resolved threads at once and score the agent against staff outcomes:
```bash
node backtest.js [casesDir]   # default casesDir = ./cases
```
- **Cases:** `cases/<name>.json` — a request payload with optional `expected` (`{verdict, action, tutor}`, any subset asserted) and `groundTruthCsv` (a frozen booking snapshot relative to the cases dir).
- **One A+ session** for the whole run; each tutor's quals/schedule scrape is memoized across cases.
- **Outputs:** per-case `backtest-results/<name>.json`, aggregate `backtest-report.json`, console summary. **Exit code = number of failed assertions** (0 = all good), so it can gate CI.
- **Ground-truth aging:** the `verdict` needs the student's existing A+ booking, which lives in the rolling ~1-week reconcile CSV. Once a case's date passes, it ages out → `no-ground-truth` (the agent's *decision* is still checked). Pin a `groundTruthCsv` snapshot for a reproducible verdict. The seeded `pelita-batingan` case has aged out, so it asserts only the decision (`PROCEED` + `Tim`).

---

## Files

| File | Role |
|---|---|
| `SKILL.md` | This spec (agent workflow) |
| `PLAN.md` | Full design doc — decisions, discovery findings, build phases |
| `lib/aplus.js` | A+ frameset login + per-request helpers (`getTeacherQuals`, `getTeacherSchedule`, etc.) |
| `resolve-student.js` | Text Request contact name → LCOS clientid (fuzzy match + confidence; multi-student parsing + `student` hint) |
| `lib/orchestrate.js` | Core recommendation logic — shared by `demo-orchestrate.js` and `backtest.js` |
| `lib/student-history.js` | Summarize a student's real A+ history → tutor pool + slot ranking + modal duration (the primary anchor) |
| `lib/slots.js` | Compute a tutor's open times that day (working hours − bookings) for `OFFER_SLOTS` |
| `backtest-corpus.js` | Pull resolved family↔staff TR conversations (deep threads) as evaluation ground truth |
| `replay.js` + `replay-cases/` | LIVE batch-replay of labeled real cases; scores action-routing closeness vs ground truth (`node replay.js`) |
| `lib/fetch-history.js` | Pull the wide A+ Schedule Report (ID 763) for history anchoring; `…Cached` reuses a 3h on-disk cache; `isHistoryCacheFresh` is a page-free check |
| `prewarm-history.js` | Warm the history cache up front (used by the pipeline `pending` step); short-circuits when fresh, no browser |
| `lib/non-tutors.js` + `non-tutors.json` | Exclusion list for admin/placeholder "teachers" (e.g. "Head Teacher") |
| `test-student-history.js` | Offline unit test for the history anchor + exclusion (no network) |
| `lib/discover-tutors.js` | Subject → qualified-tutor shortlist from the quals index (fallback discovery only) |
| `lib/subject-map.js` + `subject-map.json` | Customer subject phrase → canonical A+ service terms (+ confirm note when ambiguous) |
| `demo-orchestrate.js` | Single-request CLI wrapper over `lib/orchestrate.js` (Stages 3–4 above) |
| `backtest.js` | Batch replay of `cases/*.json` → aggregate report + CI-gatable exit code |
| `cases/` | Back-test case files (payload + optional `expected` / `groundTruthCsv`) |
| `demo-pelita.payload.json` | Sample payload for Pelita Batingan's thread (the dry-run case) |
| `post-slack.js` | Format + publish a recommendation to `#scheduling` (uses `SLACK_BOT_TOKEN`) |
| `fetch-aplus-quals.js` | Bulk Services Offered snapshot — debugging / analytics only |
| `fetch-aplus-availability.js` | Bulk Schedule snapshot — debugging / analytics only |
| `aplus-quals.json` / `aplus-availability.json` | Snapshots from bulk runs (not in the runtime path) |
| `lcos-roster.json` | Cached `lcos_get_active_students` output |

## Known limitations

- **Subject matching** is fuzzy substring (`subject` is contained in or contains an offered service name). Combined-service entries like `"Chemistry/Algebra 2"` match for "Chemistry" and for "Algebra 2", which is intended.
- **Booked-appointments freshness** depends on `aplus.csv` from the last schedule-reconcile run. For high-precision use, fetch a narrow-range A+ report on demand.
- **History pull cost.** The student-history anchor downloads the whole-center Schedule Report (report 763 isn't student-filterable server-side) — ~60–70 s and thousands of rows. It is **cached on disk** (`.cache/history-report.csv`, default 3 h via `lib/fetch-history.js` `fetchScheduleReportRowsCached`), so back-to-back requests (e.g. the always-on pipeline) share one pull. The cached fetch is **concurrency-safe**: a `.lock` file means only one pull runs at a time and a second caller waits for that result (never double-pulls), and the cache is written atomically (temp + rename). The scheduling-pipeline `pending` step **pre-warms** this cache (`prewarm-history.js`) when new threads arrive — launched **detached** so `pending` returns immediately while the report downloads in the background. Override the window with env `SR_HISTORY_CACHE_MIN` (minutes); force a fresh pull with `--refresh-history` (or `prewarm-history.js --force`); skip history entirely with `--no-history` (falls back to the narrow CSV for a weaker signal).
- **A+ pagination wait** is 30 s per page. A+ occasionally takes longer; a failed advance lands on incomplete quals, which surfaces as `not qualified for this subject`. Re-run if you see that.
- **No writes.** Phase 2 will add LCOS writes (makeup, cancellation, conference) behind explicit human approval. Phase 3 adds A+ writes (browser automation).
