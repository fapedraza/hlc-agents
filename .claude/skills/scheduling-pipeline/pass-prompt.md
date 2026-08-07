# Scheduling pipeline - one pass

Execute exactly ONE pass of the scheduling pipeline, following the skill at
`.claude/skills/scheduling-pipeline/SKILL.md`, then STOP. Do not loop.

## Step 1 - fetch

Run:

    node .claude/skills/scheduling-pipeline/pipeline-run.js pending

to fetch new Text Request threads.

## Step 2 - classify each thread

For EACH thread listed by `pending`, classify it from the thread text only.

### What counts as schedulable

Set `requestType` to one of these. **All five go through `process`, not `skip`:**

| requestType | the family is asking to... |
|---|---|
| `new-session` | book a session that does not exist yet |
| `reschedule` | move an existing session |
| `makeup` | replace a missed session |
| `cancel` | **remove an existing session** |
| `lookup` | **be told what is already on the calendar** (no change requested) |

`cancel` is a first-class request, not an absence of one. "We can't make Tuesday",
"cancel next week's class", "he won't be in on 6/30" are all `cancel` - the pipeline
finds the exact sessions and proposes removing them. Do NOT skip these as "not a
booking" or "not a scheduling request"; a missed cancellation leaves a real session
on the schedule and a tutor sitting idle.

`lookup` is for "what time is Ryan's class today?", "confirming we're still Mon/Thu
5:30", "is she booked this week?" - the family wants information, not a change. Set
`proposedDate` if they named a day; leave it out for "this week". READ-ONLY: it never
books, moves, or cancels anything.

If the family asks for information AND a change in the same message, classify it as
the change (`reschedule` / `cancel` / etc.), not as `lookup`.

### Reschedules: proposedDate is the TARGET, never the source

For `reschedule`/`makeup`, put the session being MOVED in `fromDate` and the NEW
day in `proposedDate`. If the family has not named a new day yet, OMIT
`proposedDate` entirely - do not fill it with the date they want to move away
from. That inversion made the bot tell a family their 8/20 session was
"already booked - just confirm" when moving it was the whole request.

### Practice tests / retests

A request about an SAT/ACT RETEST or practice test is a proctored TEST SEAT, not
a tutoring session - say so in the subject ("SAT retest", "practice test") and
set `fromDate` to the current test date when the family is moving one. The
pipeline seats it in the target day's test block; it must never turn into a
tutor-availability search (that mistake sent a family a tutor's teaching slots
for a test move).

### `sessions` - when the ask covers more than one session

Families routinely ask in FAMILY scope: "cancel Friday sessions on 08/07 and
08/14 for both Nivin and Kavin" is four appointments, and a payload that carries
one date acts on one and silently drops three. When the ask spans multiple dates
or students, add a `sessions` array covering EVERY session, and keep the
top-level `student`/`proposedDate`/`proposedTime` set to the FIRST entry:

    "sessions": [
      { "student": "Nivin Duvvuru", "date": "2026-08-07" },
      { "student": "Kavin Duvvuru", "date": "2026-08-07" },
      { "student": "Nivin Duvvuru", "date": "2026-08-14" },
      { "student": "Kavin Duvvuru", "date": "2026-08-14" }
    ]

`time` is optional per entry. Omit `sessions` entirely for a single-session ask
- most are. Cancellations act on the whole list; other request types recommend
for the first and surface the rest to staff.

### `courtesy` - an optional warm closing line

Families usually say WHY they are writing. Staff acknowledge it; the bot's drafts
did not. Mariah, on an otherwise-correct cancellation reply: *"Response was fine,
but would be better to add something wishing Layla a happy camping trip."*

When the family gives a clearly positive reason, add a short `courtesy` field - one
sentence, in the center's voice, that will be appended to the reply draft:

| the family said | `courtesy` |
|---|---|
| "Layla leaves Monday for a 5-night camp" | `Have a great time at camp, Layla!` |
| "we have family visiting next week" | `Enjoy the time with your family!` |
| "she's away for a swim meet" | `Good luck at the meet!` |

**Omit `courtesy` entirely when the reason is sensitive or unclear** - illness,
injury, bereavement, family difficulty, money trouble, or anything you would not
be confident saying out loud to that parent. No line is always safe; a
tone-deaf one is not. Most messages have no reason at all, so leaving it out is
the normal case.

Never put scheduling facts in `courtesy` - it is the closing pleasantry only.

### Then

- If a thread shows `inQueue: false` or has no messages, run `pipeline-run.js skip`
  with reason `no-longer-in-queue`.
- If it IS a schedulable request, write a payload JSON file under
  `.claude/skills/scheduling-pipeline/payloads/` named EXACTLY `<hash>.json`, then run:

      node .claude/skills/scheduling-pipeline/pipeline-run.js process <payload file>

  Use the customer's own words for the subject, and prefer the student's current tutor.

  **A reopened conversation keeps its hash, so that file usually already exists.
  OVERWRITE it.** Do not invent a variant name and do not stop to ask: `process`
  reads the hash from inside the file, so the filename carries no meaning, and the
  superseded payload is of no value once the family has sent a newer message. On
  2026-08-05 this cost a real thread a pass - the payload existed, a v2 name was
  attempted instead, and the pass halted with nothing recommended.
- If it is NOT schedulable, run:

      node .claude/skills/scheduling-pipeline/pipeline-run.js skip <hash> "<short reason>"

  Genuinely not schedulable: billing and tuition questions, teacher-originated threads
  (a tutor asking about their own hours or coverage), thanks/acknowledgements and
  tapbacks, document requests, and absence notices that ask for nothing back. When you
  skip, say WHY in the reason - the skip reason is the only record of this decision and
  it is what gets audited later.

You MUST actually run the `process` or `skip` command for EACH thread. Do not just
describe it.

After handling all threads, run:

    node .claude/skills/scheduling-pipeline/pipeline-run.js status

and confirm zero records remain at status `new`. If any remain, go back and process
or skip each one until none are new.

**Exception - do not spin on a failing record.** When `process` fails it now returns
the record to `new` on purpose, so that the NEXT pass retries it. If the same record
fails twice in this pass, leave it and move on. It is capped at three attempts and
then lands in `error` by itself.

Do NOT call any LCOS, Appointment-Plus, or Slack tools directly. The node scripts
handle all of that.

## Step 3 - record staff decisions

Run:

    node .claude/skills/scheduling-pipeline/poll-decisions.js

to record any staff decisions.

Finish with a one-line summary.
