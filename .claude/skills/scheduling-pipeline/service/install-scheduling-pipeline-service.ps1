# Install the scheduling-pipeline as a PER-TICK scheduled task.
# Run from an elevated PowerShell prompt (Run as Administrator).
#
# Model: a fresh `claude -p` runs ONE pass every 15 minutes (run-pass.bat),
# then exits. Unlike the old long-lived /loop session (which stalled after
# ~9h and silently froze monitoring), a stall in one tick can't affect the next.
# Hidden window, runs only when the user is logged on (needs Claude auth),
# no overlapping instances, each pass capped at 14 min.

$TaskName = 'ClaudeSchedulingPipeline'
$Bat      = 'C:\projects\hlc-agents\.claude\skills\scheduling-pipeline\service\run-pass.bat'

$existing = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if ($existing) { Write-Host 'Removing existing task...'; Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false }

# Run the .bat through a hidden PowerShell so no console flashes every 15 min.
$argStr = '-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -Command "& ''' + $Bat + '''"'
$action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument $argStr -WorkingDirectory 'C:\projects\hlc-agents'

# Repeat every 15 min indefinitely; also (re)start at logon.
$repeat = New-TimeSpan -Minutes 15
$t1 = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval $repeat -RepetitionDuration (New-TimeSpan -Days 3650)
$t2 = New-ScheduledTaskTrigger -AtLogOn

$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Minutes 14) -DontStopOnIdleEnd

# Run as the current logged-on user so it has Claude auth + the project MCP context.
$principal = New-ScheduledTaskPrincipal -UserId ($env:USERDOMAIN + '\' + $env:USERNAME) -LogonType Interactive -RunLevel Limited

Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger @($t1, $t2) -Settings $settings -Principal $principal -Description 'Scheduling pipeline: every 15 min, one fresh claude -p pass — track new texts, post single recommendations, capture staff decisions.'

Write-Host 'Task installed (per-tick, every 15 min).'
Write-Host 'Run one now:  Start-ScheduledTask -TaskName ClaudeSchedulingPipeline'
Write-Host 'Pause:        Disable-ScheduledTask -TaskName ClaudeSchedulingPipeline'
Write-Host 'Resume:       Enable-ScheduledTask -TaskName ClaudeSchedulingPipeline'
Write-Host 'Pass log:     Get-Content ~\.claude\logs\scheduling-pipeline-pass.log -Tail 20'
