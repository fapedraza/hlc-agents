@echo off
:: Claude Code Telegram Service - Auto-restart wrapper
:: Must run in a console window (Claude Code requires a TTY on stdout)
title Claude Telegram Service

cd /d C:\projects\hlc-agents
set LOGFILE=%USERPROFILE%\.claude\logs\telegram-service.log
if not exist "%USERPROFILE%\.claude\logs" mkdir "%USERPROFILE%\.claude\logs"

set RESTART_COUNT=0
set MAX_RESTARTS=50

:loop
if %RESTART_COUNT% GEQ %MAX_RESTARTS% (
    echo %date% %time% ^| ERROR: Hit %MAX_RESTARTS% restarts. Stopping. >> "%LOGFILE%"
    echo ERROR: Too many restarts. Check the log.
    pause
    exit /b 1
)

set /a RESTART_COUNT+=1
echo %date% %time% ^| Starting Claude Code attempt %RESTART_COUNT% >> "%LOGFILE%"
echo [%date% %time%] Starting Claude Code (attempt %RESTART_COUNT%)...

claude --channels plugin:telegram@claude-plugins-official --settings "C:\projects\hlc-agents\telegram-session-settings.json"

echo %date% %time% ^| Claude exited with code %ERRORLEVEL% >> "%LOGFILE%"
echo [%date% %time%] Claude exited. Restarting in 10 seconds...
timeout /t 10 /nobreak > nul
goto loop
