# hlc-agents

Automation for **Huntington Learning Center – Issaquah**, built as
[Claude Code](https://claude.com/claude-code) skills. The skills read inbound
family texts, reconcile schedules between the two systems of record, and turn
scheduling requests into human-reviewed recommendations.

> **Private repo.** The code references internal systems and contains a few real
> names in comments/examples. All customer data (LCOS/Appointment-Plus/Text
> Request dumps, conversation corpora) and secrets are **git-ignored** — see
> [`.gitignore`](.gitignore).

## Systems

| Name | Role |
|---|---|
| **LCOS** | Learning-center OS — students, enrollments, recurring schedule (no staff/tutor on a row). Read via 32-bit PowerShell ODBC. |
| **Appointment-Plus (A+)** | Booking system — tutors, qualifications, per-tutor schedule, booked sessions. No API; scraped via headless Playwright. |
| **Text Request (TR)** | SMS platform families text. Read via the v3 REST API (`x-api-key`). |
| **Slack `#scheduling`** | Where recommendations are posted for staff to approve/edit/decline. |

## Skills (`.claude/skills/`)

- **`schedule-request`** — takes a TR scheduling conversation → resolves the
  student in LCOS → produces a recommendation (`PROCEED` / `ALREADY_BOOKED` /
  `CANCEL` / `OFFER_SLOTS` / `BLOCKED`) for human review. **Recommend-only — no
  writes.**
- **`scheduling-pipeline`** — continuous loop: track new inbound → classify →
  run `schedule-request` → post to Slack → capture the staff decision (reaction +
  reply).
- **`schedule-reconcile`** — compares the upcoming week between LCOS and A+,
  flags discrepancies, writes a Google Sheet, emails/Slacks an HTML report.
- **`text-request-read`** — fetches new inbound texts via the TR v3 API
  (delta-tracked).

## How `schedule-request` decides (the core)

The recommendation is **anchored on the student's real A+ session history**, not a
guessed subject:

1. **Resolve** the student in LCOS (handles multi-student contacts like
   `"Parent (Kid A and Kid B)"`).
2. **History anchor** (`lib/student-history.js`) — pull the student's real
   sessions from the wide A+ Schedule Report; the candidate tutors, typical
   duration, and day/time pattern come from what they *actually* do.
3. **Request-type aware** (`lib/orchestrate.js`):
   - `cancel` → list the existing session(s) to remove (no tutor logic)
   - `reschedule` / `makeup` → keep the **same tutor** (carry-over), don't re-pick
   - first-name tutors ("Jennifer") are **disambiguated against the student's own
     history** (there are several on staff)
4. **Real availability** — a slot is available if it's within the **union of the
   A+ weekly template and the tutor's actual bookings that weekday**, so a stale
   "OFF" template can't hide a tutor. An existing booking at the slot is
   authoritative (`ALREADY_BOOKED`).
5. **Slot-offering** (`lib/slots.js`) — when the family gives a time range / no
   exact time, or the slot is taken, propose a few of the tutor's open times
   (`OFFER_SLOTS`), mirroring how staff actually reply.

The wide A+ report is **cached on disk** (3 h, concurrency-safe) and the pipeline
**pre-warms** it in the background (`lib/fetch-history.js`).

## Evaluation harnesses

Validated against real (anonymized-local) family↔staff conversations:

```bash
cd .claude/skills/schedule-request
node backtest.js      # replay frozen cases vs. staff ground truth (CI-gatable exit code)
node replay.js        # LIVE batch over labeled cases; scores action-routing closeness
```

The latest curated run scored **14/14 action-routing match** across cancels,
reschedules, adds, makeups, and slot-offering. Corpus/case files contain real
names and are git-ignored.

## Setup

- **Node** (project deps via `npm install`) + **Playwright** Chromium for A+ scraping.
- A `.env` at the repo root (git-ignored) with at least:
  ```
  AP_USERNAME=...            # Appointment-Plus admin
  AP_PASSWORD=...
  TR_API_KEY=...             # Text Request v3 API key
  SLACK_BOT_TOKEN=...        # for posting to #scheduling
  SCHEDULING_SLACK_CHANNEL=  # channel id
  ```
- Single request, end-to-end:
  ```bash
  cd .claude/skills/schedule-request
  node demo-orchestrate.js payload.json --out recommendation.json
  node post-slack.js recommendation.json        # --dry-run to preview
  ```

See each skill's `SKILL.md` for the full spec, and `schedule-request/PLAN.md` for
the design doc and phase plan (Phase 1 = recommend-only; Phases 2–3 add writes on
approval).
