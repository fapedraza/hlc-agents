@echo off
REM Daily "what did we learn" digest for the scheduling bot -> #scheduling,
REM plus weekly maintenance of the tutor-services index.
REM READ-ONLY apart from one Slack post, the review sheet, and aplus-quals.json.
cd /d C:\projects\hlc-agents
set PLAYWRIGHT_BROWSERS_PATH=C:\ProgramData\ms-playwright
set LOGFILE=%USERPROFILE%\.claude\logs\scheduling-daily-review.log
if not exist "%USERPROFILE%\.claude\logs" mkdir "%USERPROFILE%\.claude\logs"

echo ===== %date% %time% daily review start ===== >> "%LOGFILE%"
node .claude\skills\scheduling-pipeline\daily-review.js --days 7 >> "%LOGFILE%" 2>&1

REM Refresh the tutor-services index used by subject discovery. Self-guarded to
REM 7 days, so this is a no-op on six days out of seven. It runs AFTER the digest
REM on purpose: the scrape walks one A+ page per teacher (792s on 2026-08-05) and
REM must never delay or block the post. Departures are already handled at
REM recommendation time by the roster cross-check; this exists so a NEW HIRE does
REM not stay undiscoverable.
node .claude\skills\schedule-request\fetch-aplus-quals.js --max-age-days 7 >> "%LOGFILE%" 2>&1

echo ===== %date% %time% daily review exit %ERRORLEVEL% ===== >> "%LOGFILE%"
