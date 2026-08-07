@echo off
REM Keeps the Text Request webhook doorbell alive. If node exits it is restarted
REM after 10s; the 2-minute gate remains the fallback so a dead doorbell only
REM means slightly-slower, never silent.
cd /d C:\projects\hlc-agents
set LOGFILE=%USERPROFILE%\.claude\logs\webhook-doorbell.log
if not exist "%USERPROFILE%\.claude\logs" mkdir "%USERPROFILE%\.claude\logs"
:loop
echo ===== %date% %time% doorbell start ===== >> "%LOGFILE%"
node .claude\skills\scheduling-pipeline\webhook-doorbell.js >> "%LOGFILE%" 2>&1
echo ===== %date% %time% doorbell EXITED %ERRORLEVEL% ===== >> "%LOGFILE%"
timeout /t 10 /nobreak > nul
goto loop
