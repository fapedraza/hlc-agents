# schedule-request — Scheduling Agent (design doc)

**Status:** Plan / not yet implemented. This document is the agreed design for the
Part 2 scheduling agent. Build phases are at the bottom.

## Goal

Given a schedule-related conversation surfaced by the `text-request-read` skill,
the agent:

1. reads the conversation thread for intent + context,
2. pulls the student's enrollment and current schedule from **LCOS**,
3. pulls tutor qualifications and availability from **Appointment-Plus (A+)**,
4. produces a concrete scheduling **recommendation**, and
5. on **explicit human approval**, applies the change to LCOS (and later A+).

## Authority

**Recommend + apply on approval.** The agent never writes to LCOS or A+ without a
human OK on the specific recommendation. No autonomous writes.

## Input

`messages.json` produced by `text-request-read` — unresolved inbound conversations,
each with a `thread[]` array (last 15 messages, `direction`/`text`/`timestamp`).

Real examples observed 2026-05-22:
- `Pelita Batingan (Ryan Batingan)` — full scheduling negotiation: in-person
  Chemistry session, tutor named, date haggling, payment link.
- `Tim Corrie (Teacher)` — note: some texts come from **staff**, not students.
- `Zana Wang (Student)` — practice-test scheduling with a constraint ("at least
  four tutoring sessions between each test").

The two skills stay **separate**: `text-request-read` writes `messages.json`;
`schedule-request` is invoked when recommendations are wanted.

---

## Pipeline

### Stage 0 — Classify the conversation
LLM classification over `thread[]`. Output one of:
`cancellation` · `reschedule` · `makeup` · `new-session` · `availability-question` ·
`not-scheduling` (skip). Also flag **teacher-originated** threads (e.g. contact
name ends in `(Teacher)`) for separate routing — they are not parent requests.

### Stage 1 — Identify the student → LCOS clientid
Text Request contact names are parent- or student-centric:
`"Pelita Batingan (Ryan Batingan)"` → parent (student). Resolve the **student** name
to an LCOS `clientid` by matching the active-student roster (`lcos_get_active_students`),
reusing the name normalization in `schedule-reconcile/parse-lcos.js`
(lowercase + suffix-strip + alphabetize).

**Low-confidence matches are surfaced for human confirmation — never auto-resolved.**

### Stage 2 — Determine lesson type / subject
- **Makeup / reschedule:** lesson type = the student's enrolled LCOS service code
  (L1 / S1 / A1 / ST / …), from their enrollment.
- **New session:** subject is stated in the thread (e.g. "Chemistry").

### Stage 3 — Determine the tutor (decision: *keep current tutor*)
Default to the tutor on the student's **existing recurring schedule**
(`lcos_get_schedule(clientId)` → assigned `staffId`). Try that tutor first.
Only fall back to other tutors if the current one has no usable availability —
and any fallback must pass Stage 4.

### Stage 4 — Qualified-staff filter (decision: *quals live in A+*)
Not every tutor teaches every subject. Tutor→service qualifications are configured
in **Appointment-Plus** (provider configuration). The data layer extracts a
`provider → [services]` map; a fallback tutor must be qualified for the Stage 2
lesson type. *(Exact A+ location is a discovery item — see below.)*

### Stage 5 — Availability (A+ per-teacher Schedule template — see Discovery findings)
Open slot for teacher *T* on date *D* =

> within `[first_appt_time, last_appt_time]` for *D*'s weekday from *T*'s A+
> **Schedule** template
> − Days Off / Schedule Exceptions for *D*
> − booked appointments for *T* on *D* (from the "Aplus Schedule Report", ID 763).

All three inputs are structured and scrapable — no Session-calendar pixel-scraping
needed. Mechanics confirmed in the 2026-05-22 discovery spike (below).

### Stage 6 — Build the recommendation
Combine: lesson type + tutor (current, or qualified fallback) + open slots +
**preferences and constraints pulled from the thread** (e.g. Tim Corrie's "slight
preference for 10:30"; Zana's "≥4 sessions between practice tests"; in-person vs
online). Output a concrete proposal: date, time, tutor, service, location.

### Stage 7 — Apply on approval
Present the recommendation to a human. On explicit OK:
- **LCOS write** — tool depends on request type:
  - makeup → `lcos_insert_session`
  - cancellation → `lcos_update_attendance` (ABS/VAC/ANM)
  - conference/eval → `lcos_insert_appointment` / `lcos_reschedule_appointment`
  - ⚠️ recurring tutoring **sessions** vs **appointments** are different objects —
    confirm the correct write path per type (discovery item).
- **A+ write** — A+ has no MCP; writing means browser automation against the A+
  admin UI. Deferred to Phase 3. Until then, Phase 2 writes LCOS and **lists the
  A+ change for manual entry**.

---

## Data-extraction layer (the "extract LCOS and A+ data" piece)

Proposed scripts under `.claude/skills/schedule-request/`:

| Script | Source | Output | Status |
|---|---|---|---|
| `lib/aplus.js` | shared | A+ frameset login + nav primitives | ✅ built |
| `fetch-aplus-quals.js` | A+ browser, per teacher `sec=54` | `provider → [qualified services]` map | ✅ built — full run ~2.5 min for 50 teachers → `aplus-quals.json` |
| `fetch-aplus-availability.js` | A+ browser, per teacher `sec=2` | weekly working-hours template (Days Off / Exceptions TBD) | ✅ built — full run ~2.5 min → `aplus-availability.json` |
| `resolve-student.js` | LCOS roster | contact name → `clientid` (+ confidence) | not started |
| `fetch-student-context.js` | LCOS MCP | enrollment, service code, current schedule + tutor | not started |
| *(reuse)* `schedule-reconcile/fetch-aplus.js` | A+ report 763 | booked appointments | already exists |

**Quals output observed:** 32/50 teachers have services configured (18 are admin/non-teaching). Service popularity skew: Math (26), Algebra (20), Algebra 2 (16). Felix Dyer and Laura Bellamy show 25/25 — likely "Assign All" was clicked; flag in recommendation logic so the agent doesn't over-trust these as best matches.

**Availability output observed:** 47/50 teachers have working hours. Day coverage Mon–Thu ≈ 41–43 tutors, Fri 29, Sat 31, Sun 22.

**LCOS** is reachable directly via the `lcos__` MCP tools — no scraping:
`lcos_get_active_students`, `lcos_get_schedule`, `lcos_get_appointments`, `lcos_query`.
**A+** has no API/MCP — all A+ extraction is headless Playwright, following the
pattern already proven in `fetch-aplus.js` (auto-login, `slots` frame, etc.).

---

## Discovery findings — A+ admin UI (spike completed 2026-05-22)

**Frameset navigation.** A+ admin v2 is a frameset. Top-level sections load via
`appointments_index_v2.php?p=<X>` (`staff`, `services`, `reports`, `appts`). A
teacher's detail pages load by clicking their link in `?p=staff` — the link
targets the `sidenav` frame (`sidenav_frame_v2.php?p=staff_details&employee_id=<eid>&sec=<n>`),
which renders content into the `slots` frame. Direct top-level navigation to
`p=staff_details` does **not** work — must go through the sidenav click.

**Teacher roster.** `?p=staff` lists ~49 teachers. Each teacher link carries an
`employee_id` (e.g. Addison = 3331). The Sessions calendar columns expose the
same `e_id`.

**Teacher detail section codes** (`&sec=`): Profile = 1, Schedule = 2,
Days Off = 4, Schedule Exceptions = 51, Assign Schedule Templates = 52,
Services Offered = 54.

**Qualifications — SOLVED.** Per-teacher **Services Offered** page (`sec=54`).
A table of service rows; each has a checkbox `name="<serviceId>-box"` whose
`.checked` state = "this teacher delivers this service", plus per-day checkboxes,
time-to-complete, and cost. Fully scrapable → `provider → [qualified service]`.

**Availability — SOLVED.** Per-teacher **Schedule** page (`sec=2`) is the weekly
working-hours template: 7 day rows, each with an `off_<Day>` checkbox and
`first_appt_time_<Day>` / `last_appt_time_<Day>` `<select>`s. Fully scrapable.
Date-specific overrides live in **Days Off** (`sec=4`) and **Schedule Exceptions**
(`sec=51`) — same structured-page pattern (confirm their exact DOM in Phase 1).

**No bulk availability report.** The Reports tab holds only appointment-data
reports (incl. "Aplus Schedule Report" 763 = booked appointments). There is no
staff-availability report — per-teacher Schedule scrape is the source.

**Scrape cost.** ~49 teachers × ~3 pages ≈ 150 page loads (~3–5 min). Quals and
weekly templates change rarely → **cache them, refresh occasionally**. Only
booked appointments (report 763, one download) and near-term exceptions need
frequent refresh.

## Open questions

1. **LCOS write path** — confirm which MCP tool applies for a recurring-session
   makeup vs a one-off appointment, and how SPEC exception rows are created.
2. **Teacher-originated texts** — routing for `(Teacher)` contacts.
3. **Days Off / Schedule Exceptions DOM** — confirm exact structure.
4. **Service-code mapping** — A+ service names/IDs ↔ LCOS service codes.
   *(Partly addressed 2026-05-30: `subject-map.json` + `lib/subject-map.js` map
   customer subject phrases → A+ service names, with a confirm-note on ambiguous
   leaps. LCOS service-code ↔ A+ service-name mapping is still open.)*

## Evaluation methodology — back-test against historical threads

The right way to evaluate the orchestrator is to **replay past resolved
threads** and check whether the agent would have made the same scheduling
decision staff actually made. Concretely:

1. Pick a thread the staff already processed.
2. Build a payload from the thread (manually for now; classifier later).
3. Run `demo-orchestrate.js payload.json --backtest`.
4. The orchestrator treats the student's existing booking at the proposed
   slot as **ground truth** rather than short-circuiting to `ALREADY_BOOKED`.
5. The output's `comparison` block reports:
   - `groundTruth` — the existing A+ booking(s) staff created from this thread.
   - `predicted` — the agent's recommendation under back-test.
   - `matchVerdict` — `match` / `mismatch` / `agent-blocked-but-staff-acted` / `no-ground-truth`.

**Two levels of rigor:**
- **Assisted:** payload includes a candidate tutor name extracted from the
  thread (what we have now). Tests the qualification + availability + conflict
  logic.
- **Blind:** payload omits the tutor; orchestrator must find candidates from
  the qualified pool. **Implemented 2026-05-29** via `lib/discover-tutors.js`:
  with `candidateTutors: []` (or `discover: true`) the orchestrator pulls
  subject-qualified tutors from the quals index (`aplus-quals.json`), caps at 8,
  and live-verifies each. The index is a shortlist only — live quals re-check is
  authoritative, so a stale index can only miss a tutor, not misrecommend one.
  Keep the index fresh with `fetch-aplus-quals.js` (the paginated scrape).

**First validated case:** `demo-pelita.payload.json` → `matchVerdict: match`
(predicted Tim Corrie, staff booked Tim Corrie at 7:30 pm on 5/27 for
Chemistry).

**Back-test harness — ✅ built 2026-05-29.** `backtest.js` replays a directory
of case files (`cases/<name>.json`) through the orchestrator in back-test mode,
sharing ONE authenticated A+ session and memoizing each tutor's quals/schedule
scrape across cases. Per-case output → `backtest-results/<case>.json`; aggregate
→ `backtest-report.json`; console summary with verdict tallies + assertion
pass/fail. Exit code = number of failed assertions (CI-gatable). The shared
orchestration logic now lives in `lib/orchestrate.js`; `demo-orchestrate.js` is
a thin single-request wrapper over it.

Case files carry an optional `expected` block (`{verdict, action, tutor}` — any
subset asserted) and an optional `groundTruthCsv` fixture path.

⚠️ **Ground-truth aging.** The verdict (match/mismatch) needs the student's
existing A+ booking, which lives in the schedule-reconcile CSV — a rolling
~1-week window. Once a case's date passes, the booking ages out and the verdict
degrades to `no-ground-truth` (the agent's *decision* is still checked). For a
reproducible verdict, pin a `groundTruthCsv` snapshot captured when the thread
was resolved. The seeded Pelita case (5/27) has already aged out, so it asserts
only the decision (`PROCEED` + `Tim`) — still green against live A+.

## Lessons from Phase-1 build (Pelita's dry-run)

- **A+ Services Offered paginates server-side** (~25 rows × 4 pages). The bulk
  pre-scrape was incomplete until the pager (`fnChangeServicesPage(p, true)`)
  was wired. A+ is the authoritative qualifications source — the roster
  spreadsheet is just a summary.
- **A+ pagination is occasionally slow** — `scrapeAllServicePages` now waits up
  to 30 s for the first row's `<serviceId>-box` to change between pages. A
  failed advance silently lands on partial quals; the orchestrator surfaces
  this as a "not qualified" result, so re-running is enough.
- **LCOS sessions don't carry `staffid`** — the staff assignment lives only in
  A+. The reconcile pattern (match LCOS↔A+ via student+date+time) is how we
  identify a student's "current tutor."
- **CSV parsing requires a proper quoted-field reader.** An earlier eyeball
  with `awk -F','` missed Ryan's existing 5/27 booking because his student
  name field contained a comma. The orchestrator uses a real CSV parser.
- **Own-student "conflicts" are not conflicts.** If the only booking
  overlapping the proposed slot is the same student, the request is already
  in A+ — emit `ALREADY_BOOKED`, not `BLOCKED`.

---

## Build phases

- **Phase 0 — Discovery spike.** ✅ Done 2026-05-22 — see Discovery findings above.
- **Phase 1 — Recommend-only, end-to-end.** ✅ Working pipeline 2026-05-22.
  `lib/aplus.js` + `resolve-student.js` + `demo-orchestrate.js` + `post-slack.js`.
  Validated on Pelita Batingan's thread → produced `ALREADY_BOOKED` (Ryan's
  5/27 Chemistry session with Tim Corrie is in both LCOS and A+; just needs
  payment) AND posted the formatted recommendation + drafted text reply to
  `#scheduling` (channel `CMR1PPZ9B`) for staff validation.
  Back-test mode (`--backtest`) replays past resolved threads and compares
  against staff outcomes; first validated case = `match`. **Back-test harness
  `backtest.js` built 2026-05-29** (batch replay + aggregate report + CI-gatable
  exit code; logic shared via `lib/orchestrate.js`). See `SKILL.md` for the
  orchestrator workflow. **Also built 2026-05-29:** multi-student contact
  parsing + `student` hint in `resolve-student.js` (handles
  `"Zahera Shaik (Shaheer (JB) and Sarah Shaikh)"`), and candidate discovery
  for unnamed-tutor requests (`lib/discover-tutors.js`). Known refinements still
  pending: classifier hardening, more case files beyond Pelita (and
  `groundTruthCsv` snapshots so verdicts stay reproducible), A+ pagination wait
  reliability under load.
- **Phase 2 — Apply-on-approval (LCOS).** Add the LCOS write path behind an
  explicit human approval gate. A+ changes listed for manual entry.
- **Phase 3 — A+ writes.** Browser automation for applying changes in A+.

## Reusable assets already in the repo

- `schedule-reconcile/fetch-aplus.js` — headless A+ login + saved-report CSV download.
- `schedule-reconcile/parse-lcos.js` — LCOS name/time/date normalization.
- `schedule-reconcile/lookup-schedules.js` — per-student recurring schedule blocks.
- `lcos__` MCP tools — direct LCOS reads and writes.
- `text-request-read/messages.json` — the conversation input with thread context.
