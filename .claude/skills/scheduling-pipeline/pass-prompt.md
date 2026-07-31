# Scheduling pipeline - one pass

Execute exactly ONE pass of the scheduling pipeline, following the skill at
`.claude/skills/scheduling-pipeline/SKILL.md`, then STOP. Do not loop.

## Step 1 - fetch

Run:

    node .claude/skills/scheduling-pipeline/pipeline-run.js pending

to fetch new Text Request threads.

## Step 2 - classify each thread

For EACH thread listed by `pending`, classify it from the thread text only.

- If a thread shows `inQueue: false` or has no messages, run `pipeline-run.js skip`
  with reason `no-longer-in-queue`.
- If it IS a schedulable request, write a payload JSON file under
  `.claude/skills/scheduling-pipeline/payloads/` named by the thread hash, then run:

      node .claude/skills/scheduling-pipeline/pipeline-run.js process <payload file>

  Use the customer's own words for the subject, and prefer the student's current tutor.
- If it is NOT schedulable, run:

      node .claude/skills/scheduling-pipeline/pipeline-run.js skip <hash> "<short reason>"

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
