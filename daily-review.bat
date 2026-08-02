@echo off
REM Daily "what did we learn" digest for the scheduling bot -> #scheduling.
REM Reads Text Request outcomes, Slack staff feedback, and the skip reasons, and
REM posts a summary. READ-ONLY apart from that one Slack post.
cd /d C:\projects\hlc-agents
set LOGFILE=%USERPROFILE%\.claude\logs\scheduling-daily-review.log
if not exist "%USERPROFILE%\.claude\logs" mkdir "%USERPROFILE%\.claude\logs"
echo ===== %date% %time% daily review start ===== >> "%LOGFILE%"
node .claude\skills\scheduling-pipeline\daily-review.js --days 7 >> "%LOGFILE%" 2>&1
echo ===== %date% %time% daily review exit %ERRORLEVEL% ===== >> "%LOGFILE%"
