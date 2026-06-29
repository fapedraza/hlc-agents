@echo off
cd /d C:\projects\hlc-agents
set PLAYWRIGHT_BROWSERS_PATH=C:\ProgramData\ms-playwright
node .claude\skills\schedule-reconcile\run-reconcile-standalone.js > scheduled-runs\reconcile-output.log 2>&1
