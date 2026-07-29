@echo off
REM One scheduling-pipeline pass via a fresh headless claude -p, then exits.
REM Runs on a Task Scheduler repetition trigger every ~15 min, so a stalled
REM session can never silently freeze monitoring.
cd /d C:\projects\hlc-agents
set SETTINGS=C:\projects\hlc-agents\.claude\skills\scheduling-pipeline\service\scheduling-pipeline-settings.json
set LOGFILE=%USERPROFILE%\.claude\logs\scheduling-pipeline-pass.log
if not exist "%USERPROFILE%\.claude\logs" mkdir "%USERPROFILE%\.claude\logs"

REM Refresh the LCOS active-student roster before the pass.
REM SKILL.md says to refresh it via mcp__lcos__lcos_get_active_students, but
REM .mcp.json is empty so that tool does not exist - the roster silently froze
REM on 2026-05-29 and 74 of 198 current students could not be resolved.
REM The script self-guards (no-op under 24h old) so this is near-free per pass,
REM and a failure here is logged but must not block the pass.
REM 32-bit PowerShell is required: the SQL Anywhere ODBC driver is 32-bit only.
C:\Windows\SysWOW64\WindowsPowerShell\v1.0\powershell.exe -NoProfile -ExecutionPolicy Bypass -File "C:\projects\hlc-agents\.claude\skills\schedule-request\refresh-roster.ps1" >> "%LOGFILE%" 2>&1

echo ===== %date% %time% pass start ===== >> "%LOGFILE%"
claude -p "Execute exactly ONE pass of the scheduling pipeline, following the skill at .claude/skills/scheduling-pipeline/SKILL.md, then STOP. Do not loop. Step 1: run  node .claude/skills/scheduling-pipeline/pipeline-run.js pending  to fetch new Text Request threads. Step 2: for EACH thread listed by pending, classify it from the thread text only. If a thread shows inQueue false or has no messages, run pipeline-run.js skip with reason no-longer-in-queue. If it is a schedulable request, write a payload JSON file under .claude/skills/scheduling-pipeline/payloads/ named by the thread hash and run  node .claude/skills/scheduling-pipeline/pipeline-run.js process  on that file. Use the customer's own words for the subject and prefer the student's current tutor. If it is NOT schedulable, run  node .claude/skills/scheduling-pipeline/pipeline-run.js skip  with the hash and a short reason. You MUST actually run the process or skip command for EACH thread - do not just describe it. After handling all threads, run  node .claude/skills/scheduling-pipeline/pipeline-run.js status  and confirm zero records remain at status new; if any remain, go back and process or skip each one until none are new. Do NOT call any LCOS, Appointment-Plus, or Slack tools directly - the node scripts handle all of that. Step 3: run  node .claude/skills/scheduling-pipeline/poll-decisions.js  to record any staff decisions. Finish with a one-line summary." --settings "%SETTINGS%" < NUL >> "%LOGFILE%" 2>&1
echo ===== %date% %time% pass exit %ERRORLEVEL% ===== >> "%LOGFILE%"
