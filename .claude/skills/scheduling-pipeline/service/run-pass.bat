@echo off
REM One scheduling-pipeline pass via a fresh headless claude -p, then exits.
REM Runs on a Task Scheduler repetition trigger every ~15 min, so a stalled
REM session can never silently freeze monitoring.
cd /d C:\projects\hlc-agents
set SETTINGS=C:\projects\hlc-agents\.claude\skills\scheduling-pipeline\service\scheduling-pipeline-settings.json
set PROMPT=C:\projects\hlc-agents\.claude\skills\scheduling-pipeline\pass-prompt.md
set LOGFILE=%USERPROFILE%\.claude\logs\scheduling-pipeline-pass.log
if not exist "%USERPROFILE%\.claude\logs" mkdir "%USERPROFILE%\.claude\logs"

REM Cheap gate: one TR API call decides whether this 2-minute tick needs the
REM full pass (roster + rules + claude classify + browser). Exit 3 = idle and a
REM recent full pass exists, so skip everything. Any gate error runs the full
REM pass - the gate must never be able to silence the pipeline.
node .claude\skills\scheduling-pipeline\gate.js >> "%LOGFILE%" 2>&1
if %ERRORLEVEL%==3 exit /b 0

REM Refresh the LCOS active-student roster before the pass.
REM SKILL.md says to refresh it via mcp__lcos__lcos_get_active_students, but
REM .mcp.json is empty so that tool does not exist - the roster silently froze
REM on 2026-05-29 and 74 of 198 current students could not be resolved.
REM The script self-guards (no-op under 24h old) so this is near-free per pass,
REM and a failure here is logged but must not block the pass.
REM 32-bit PowerShell is required: the SQL Anywhere ODBC driver is 32-bit only.
C:\Windows\SysWOW64\WindowsPowerShell\v1.0\powershell.exe -NoProfile -ExecutionPolicy Bypass -File "C:\projects\hlc-agents\.claude\skills\schedule-request\refresh-roster.ps1" >> "%LOGFILE%" 2>&1

REM The classifier prompt lives in pass-prompt.md rather than inline here. It is
REM the only LLM step in the pipeline and it is a spec, so it belongs somewhere
REM reviewable and diffable - a shell string is not that. claude -p reads it from
REM stdin, which also supersedes the old < NUL guard against a blocking stdin.
REM Rebuild the rules snapshot the recommender depends on. student-notes.json
REM carries the A+ Teacher Types (category matching), the per-student prefer/never
REM rules, and the current roster used to drop departed tutors. It reads the shared
REM A+ cache - no browser, ~1s - and nothing else regenerates it, so without this a
REM new "No X" note or Teacher Type change would never reach the bot.
node .claude\skills\schedule-request\extract-student-notes.js >> "%LOGFILE%" 2>&1

echo ===== %date% %time% pass start ===== >> "%LOGFILE%"
type "%PROMPT%" | claude -p --settings "%SETTINGS%" >> "%LOGFILE%" 2>&1
REM Close the loop on past recommendations. Staff answer the FAMILY in Text
REM Request, not the bot in Slack -- only 4 of 38 recommendations ever got a
REM vote. This reads the staff reply + the resulting A+ booking and records what
REM actually happened, then posts one threaded reply so a wrong reading can be
REM corrected. Records an OUTCOME, never a DECISION: inferred evidence must not
REM be mistaken for a human approving anything.
REM --min-age-hours 24 lets the outcome settle; already-settled records are
REM skipped before any API call, so this is cheap at a 15-minute cadence.
node .claude\skills\scheduling-pipeline\backfill-outcomes.js --apply --min-age-hours 24 >> "%LOGFILE%" 2>&1

REM Mark the completed full pass; the gate forces a new one when this is stale.
type nul > "%USERPROFILE%\.claude\logs\last-full-pass.marker"
echo ===== %date% %time% pass exit %ERRORLEVEL% ===== >> "%LOGFILE%"
