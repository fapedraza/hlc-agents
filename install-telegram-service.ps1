# Install Claude Telegram as a scheduled task (run as Administrator)
# Usage: Run from an elevated PowerShell prompt

$TaskName = "ClaudeTelegramService"
$BatPath = "C:\projects\hlc-agents\claude-telegram-service.bat"

# Remove existing task if present
$existing = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if ($existing) {
    Write-Host "Removing existing task..."
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
}

# Action: launch the batch file in a minimized console window
# Claude Code requires a real console (TTY) — cannot run hidden/headless
$action = New-ScheduledTaskAction `
    -Execute "cmd.exe" `
    -Argument "/c start /min `"Claude Telegram Service`" `"$BatPath`"" `
    -WorkingDirectory "C:\projects\hlc-agents"

# Trigger: at user logon (needs a desktop session for the console window)
$trigger = New-ScheduledTaskTrigger -AtLogon

# Settings: restart on failure, don't stop on idle, run indefinitely
$settings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -StartWhenAvailable `
    -RestartCount 3 `
    -RestartInterval (New-TimeSpan -Minutes 1) `
    -ExecutionTimeLimit (New-TimeSpan -Days 0) `
    -DontStopOnIdleEnd

# Register — runs only when user is logged on (required for console window)
Register-ScheduledTask `
    -TaskName $TaskName `
    -Action $action `
    -Trigger $trigger `
    -Settings $settings `
    -RunLevel Highest `
    -Description "Keeps Claude Code running with Telegram channel for always-on messaging"

Write-Host ""
Write-Host "Task '$TaskName' installed successfully." -ForegroundColor Green
Write-Host ""
Write-Host "Note: Claude Code needs a console window (minimized in taskbar)."
Write-Host "      The service starts automatically when you log in."
Write-Host ""
Write-Host "Commands:"
Write-Host "  Start now:    Start-ScheduledTask -TaskName '$TaskName'"
Write-Host "  Stop:         Stop-ScheduledTask -TaskName '$TaskName'"
Write-Host "  Check status: Get-ScheduledTask -TaskName '$TaskName' | Select State"
Write-Host "  View logs:    Get-Content ~\.claude\logs\telegram-service.log -Tail 20"
Write-Host "  Uninstall:    Unregister-ScheduledTask -TaskName '$TaskName'"
