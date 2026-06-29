# Claude Code Telegram Service Wrapper
# Keeps Claude Code running with automatic restart on failure
# Designed to be run by Task Scheduler at system startup

# winpty provides a real Windows pseudo-terminal so Claude Code sees process.stdin.isTTY = true
$WinPty = "C:\Program Files\Git\usr\bin\winpty.exe"
$LogDir = "$env:USERPROFILE\.claude\logs"
$LogFile = "$LogDir\telegram-service.log"
$PidFile = "$LogDir\telegram-service.pid"
$WorkingDir = "C:\projects\hlc-agents"
$MaxRestarts = 50
$RestartDelaySec = 10
$CooldownMinutes = 60

if (!(Test-Path $LogDir)) { New-Item -ItemType Directory -Path $LogDir -Force | Out-Null }

function Write-Log {
    param([string]$Message)
    $ts = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
    "$ts | $Message" | Out-File -FilePath $LogFile -Append -Encoding utf8
}

# Write PID so we can stop the service cleanly
$PID | Set-Content $PidFile

Write-Log "Service starting (PID: $PID)"

$restartCount = 0
$windowStart = Get-Date

while ($true) {
    # Reset restart counter every cooldown period
    if (((Get-Date) - $windowStart).TotalMinutes -ge $CooldownMinutes) {
        $restartCount = 0
        $windowStart = Get-Date
    }

    if ($restartCount -ge $MaxRestarts) {
        Write-Log "ERROR: Hit $MaxRestarts restarts within $CooldownMinutes minutes. Stopping."
        break
    }

    Write-Log "Starting Claude Code (attempt $($restartCount + 1))..."

    try {
        # winpty allocates a real ConPTY so Node sees isTTY=true on stdin/stdout
        $pinfo = New-Object System.Diagnostics.ProcessStartInfo
        $pinfo.FileName = $WinPty
        $pinfo.Arguments = "C:\Users\hlcadmin\AppData\Roaming\npm\claude.cmd --channels plugin:telegram@claude-plugins-official --settings `"C:\projects\hlc-agents\telegram-session-settings.json`""
        $pinfo.WorkingDirectory = $WorkingDir
        $pinfo.UseShellExecute = $false
        $pinfo.CreateNoWindow = $true

        $process = [System.Diagnostics.Process]::Start($pinfo)

        Write-Log "Claude started via winpty (PID: $($process.Id))"
        $process.WaitForExit()
        $exitCode = $process.ExitCode
        Write-Log "Claude exited with code: $exitCode"
    }
    catch {
        Write-Log "ERROR starting Claude: $_"
    }

    $restartCount++
    Write-Log "Restarting in $RestartDelaySec seconds..."
    Start-Sleep -Seconds $RestartDelaySec
}

Write-Log "Service stopped."
Remove-Item $PidFile -ErrorAction SilentlyContinue
