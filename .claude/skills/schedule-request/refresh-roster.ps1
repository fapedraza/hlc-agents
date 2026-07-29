# refresh-roster.ps1 — rebuild lcos-roster.json from LCOS.
#
# WHY THIS EXISTS
# schedule-request/SKILL.md tells the agent to refresh the roster by calling
# `mcp__lcos__lcos_get_active_students`. That tool does not exist: the project's
# .mcp.json is `{"mcpServers": {}}`. So the roster silently froze on 2026-05-29
# and any student enrolled after that date could not be resolved, which sends
# the request to `skipped`.
#
# This replaces that tool with a direct ODBC read, mirroring the query in
# lcos-mcp-server/src/index.ts (lcos_get_active_students) so the output shape is
# byte-compatible with what the orchestrator already expects.
#
# MUST run under 32-bit PowerShell — the SQL Anywhere ODBC driver is 32-bit only:
#   C:\Windows\SysWOW64\WindowsPowerShell\v1.0\powershell.exe
#
# Uses the LCOS_REMOTE DSN so it works from a non-interactive session (the normal
# LCOS DSN tries to start/lock the database file, which fails while the desktop
# app holds it).
#
# Self-healing: no-ops when the roster is younger than -MaxAgeHours, so it is
# safe (and near-free) to call on every pipeline pass.

param(
    [string]$ConfigFile   = 'C:\LCOS\config-issaquah-mcp.json',
    [string]$OutFile      = 'C:\projects\hlc-agents\.claude\skills\schedule-request\lcos-roster.json',
    [int]   $MaxAgeHours  = 24,
    [switch]$Force,
    # -All writes the HISTORICAL set instead: every student with an enrollment
    # open in the last -MonthsBack months, regardless of current status.
    #
    # Needed because the active roster alone biases any analysis over past
    # sessions: students who finished are dropped, so a teacher's subject mix is
    # computed only over whoever happens to still be enrolled. That flipped
    # Tarun into "LC teacher" on 2026-07-29, contradicting Mariah's explicit
    # "Tarun is not a learning center teacher". Categorisation must see the same
    # population the sessions came from.
    [switch]$All,
    [int]   $MonthsBack   = 18
)

$ErrorActionPreference = 'Stop'

function Log($msg) { Write-Host ("[refresh-roster] " + $msg) }

# ── freshness guard ──────────────────────────────────────────────────────────
if (-not $Force -and (Test-Path $OutFile)) {
    $ageH = ((Get-Date) - (Get-Item $OutFile).LastWriteTime).TotalHours
    if ($ageH -lt $MaxAgeHours) {
        Log ("roster is {0:N1}h old (< {1}h) - skipping refresh" -f $ageH, $MaxAgeHours)
        exit 0
    }
}

if (-not (Test-Path $ConfigFile)) { Log "config not found: $ConfigFile"; exit 1 }
$cfg = Get-Content $ConfigFile -Raw | ConvertFrom-Json
$db  = $cfg.DB
$centerCode = $cfg.CenterCode

# ── query ────────────────────────────────────────────────────────────────────
if ($All) {
    # Historical population: students ENROLLED at any point in the window,
    # whether or not they still are. Used for analysis over past sessions, NOT
    # for student resolution.
    #
    # Must filter to ENR/ENRC: clt_status carries the whole CRM funnel (INQ, DT,
    # CONF, DROP), which is ~14k clients over 18 months and none of the non-
    # enrolled ones ever had a session.
    $sql = @"
SELECT c.clientid, c.lastname, c.firstname,
       s.statuscode, s.startdate, s.enddate,
       s.service, s.servicerate
FROM DBA.clt_clients c
JOIN DBA.clt_status s ON c.centercode = s.centercode AND c.clientid = s.clientid
WHERE c.centercode = '$centerCode'
  AND s.statuscode IN ('ENR', 'ENRC')
  AND (s.enddate IS NULL OR s.enddate >= DATEADD(month, -$MonthsBack, CURRENT DATE))
ORDER BY c.lastname, c.firstname, s.startdate
"@
} else {
    # Active roster - mirrors lcos_get_active_students.
    $sql = @"
SELECT c.clientid, c.lastname, c.firstname,
       s.statuscode, s.startdate, s.enddate,
       s.service, s.servicerate
FROM DBA.clt_clients c
JOIN DBA.clt_status s ON c.centercode = s.centercode AND c.clientid = s.clientid
WHERE c.centercode = '$centerCode'
  AND s.statuscode = 'ENR'
  AND (s.enddate IS NULL OR s.enddate >= CURRENT DATE)
ORDER BY c.lastname, c.firstname
"@
}

Log "connecting to $($db.DSN)..."
$conn = New-Object System.Data.Odbc.OdbcConnection("DSN=$($db.DSN);UID=$($db.User);PWD=$($db.Password)")
$conn.Open()

$cmd = $conn.CreateCommand()
$cmd.CommandText = $sql
$reader = $cmd.ExecuteReader()

$rows = [System.Collections.ArrayList]::new()
while ($reader.Read()) {
    # Match the existing file's shape exactly: null for absent dates, strings
    # elsewhere, and the .NET default datetime rendering the previous snapshot used.
    $startdate = if ($reader.IsDBNull(4)) { $null } else { ([datetime]$reader.GetValue(4)).ToString('M/d/yyyy h:mm:ss tt') }
    $enddate   = if ($reader.IsDBNull(5)) { $null } else { ([datetime]$reader.GetValue(5)).ToString('M/d/yyyy h:mm:ss tt') }
    [void]$rows.Add([ordered]@{
        enddate     = $enddate
        clientid    = if ($reader.IsDBNull(0)) { '' } else { $reader.GetValue(0).ToString().Trim() }
        firstname   = if ($reader.IsDBNull(2)) { '' } else { $reader.GetValue(2).ToString().Trim() }
        lastname    = if ($reader.IsDBNull(1)) { '' } else { $reader.GetValue(1).ToString().Trim() }
        servicerate = if ($reader.IsDBNull(7)) { $null } else { $reader.GetValue(7).ToString().Trim() }
        startdate   = $startdate
        service     = if ($reader.IsDBNull(6)) { '' } else { $reader.GetValue(6).ToString().Trim() }
        statuscode  = if ($reader.IsDBNull(3)) { '' } else { $reader.GetValue(3).ToString().Trim() }
    })
}
$reader.Close(); $cmd.Dispose(); $conn.Close()

if ($rows.Count -eq 0) {
    # Never overwrite a good roster with an empty one - a transient DB problem
    # would otherwise blind the resolver completely.
    Log "query returned 0 rows - refusing to overwrite the existing roster"
    exit 1
}

# ── write atomically, UTF-8 without BOM (JSON.parse chokes on a BOM) ─────────
$json = $rows | ConvertTo-Json -Depth 4
$tmp  = "$OutFile.tmp"
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)
[System.IO.File]::WriteAllText($tmp, $json, $utf8NoBom)
Move-Item -Path $tmp -Destination $OutFile -Force

Log ("wrote {0} active students to {1}" -f $rows.Count, $OutFile)
