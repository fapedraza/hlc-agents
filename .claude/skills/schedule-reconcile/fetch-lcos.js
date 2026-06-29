/**
 * fetch-lcos.js — Standalone LCOS query (replicates mcp__lcos__lcos_sign_in_sheet)
 *
 * Shells to 32-bit PowerShell executing ODBC queries against DSN LCOS.
 * Writes raw {columns, rows, rowCount} JSON matching the MCP tool's output shape.
 *
 * Override filter: sp_sign_in_sheet's CONF / DROP / ST-INQ / ST-DT branch lacks
 * the max(startdate) filter that the ENR branch applies. Result: for non-ENR
 * students with overlapping SCHG events (e.g. an old schedule and a new one
 * starting later), the SP returns rows from BOTH schedules concurrently. The
 * LCOS UI applies the max-startdate override on top, so we mirror that here:
 * a recurring row is kept only if its (dayofweek, starttime, endtime) matches
 * the *active* scheduleid for that client+date. SPEC rows (per-event entries)
 * are always kept.
 *
 * Usage: node fetch-lcos.js <YYYY-MM-DD start> <YYYY-MM-DD end> <out.json>
 *        [--no-override-filter]   (skip the override filter — debug only)
 */

const { execFile } = require('child_process');
const { writeFileSync, unlinkSync, mkdirSync, readFileSync } = require('fs');
const { join } = require('path');
const { randomBytes } = require('crypto');
const { tmpdir } = require('os');

const PS_32BIT = 'C:\\Windows\\SysWOW64\\WindowsPowerShell\\v1.0\\powershell.exe';
const CONFIG_PATH = 'C:\\LCOS\\config-issaquah.json';
const TEMP_DIR = join(tmpdir(), 'lcos-standalone');
try { mkdirSync(TEMP_DIR, { recursive: true }); } catch {}

const args = process.argv.slice(2);
const flags = new Set(args.filter(a => a.startsWith('--')));
const positional = args.filter(a => !a.startsWith('--'));
const [startDate, endDate, outPath] = positional;
if (!startDate || !endDate || !outPath) {
  console.error('Usage: node fetch-lcos.js <YYYY-MM-DD start> <YYYY-MM-DD end> <out.json> [--no-override-filter]');
  process.exit(1);
}
const skipFilter = flags.has('--no-override-filter');

const cfg = JSON.parse(readFileSync(CONFIG_PATH, 'utf-8'));
const centerCode = cfg.CenterCode;
const connStr = `Driver={SQL Anywhere 17};Host=${cfg.DB.Host || '127.0.0.1'};ServerName=${cfg.DB.ServerName || 'LCOS'};UID=${cfg.DB.User};PWD=${cfg.DB.Password}`;

function friendlyError(raw) {
  if (raw.includes('Database server not found')) return 'LCOS database engine is not running. Start SQLAnywhere_LCOS service or open the LCOS desktop app on the server.';
  if (raw.includes('already in use')) return 'LCOS database file is locked. Use a TCP DSN instead of file-based.';
  if (raw.includes('Communication error')) return 'Cannot reach LCOS via TCP. Check SQLAnywhere engine is running on 127.0.0.1.';
  return raw;
}

function runQuery(sql, timeoutSec = 60) {
  const scriptPath = join(TEMP_DIR, `lcos_${randomBytes(8).toString('hex')}.ps1`);
  const psScript = `[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$ErrorActionPreference = 'Stop'
try {
    $conn = New-Object System.Data.Odbc.OdbcConnection('${connStr.replace(/'/g, "''")}')
    $conn.Open()
    $cmd = $conn.CreateCommand()
    $cmd.CommandText = @"
${sql.replace(/"/g, '`"')}
"@
    $cmd.CommandTimeout = ${timeoutSec}
    $adapter = New-Object System.Data.Odbc.OdbcDataAdapter($cmd)
    $dt = New-Object System.Data.DataTable
    [void]$adapter.Fill($dt)
    $cols = @($dt.Columns | ForEach-Object { $_.ColumnName })
    $rows = @()
    foreach ($row in $dt.Rows) {
        $obj = @{}
        foreach ($c in $cols) {
            $v = $row[$c]
            if ($v -is [System.DBNull]) { $obj[$c] = $null } else { $obj[$c] = $v.ToString().Trim() }
        }
        $rows += $obj
    }
    $result = @{ columns=$cols; rows=$rows; rowCount=$dt.Rows.Count }
    $conn.Close(); $conn.Dispose()
    ConvertTo-Json $result -Depth 10 -Compress
} catch {
    ConvertTo-Json @{ error=$_.Exception.Message; detail=$_.ScriptStackTrace } -Compress
    exit 1
}
`;
  writeFileSync(scriptPath, psScript, 'utf-8');
  return new Promise((resolve, reject) => {
    execFile(PS_32BIT,
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', scriptPath],
      { maxBuffer: 100 * 1024 * 1024, timeout: (timeoutSec + 30) * 1000 },
      (error, stdout, stderr) => {
        try { unlinkSync(scriptPath); } catch {}
        if (error) {
          try {
            const parsed = JSON.parse(stdout || stderr);
            if (parsed.error || parsed.message) return reject(new Error(friendlyError(parsed.error || parsed.message)));
          } catch {}
          return reject(new Error(friendlyError(`${error.message}\n${stderr}`)));
        }
        try {
          const parsed = JSON.parse(stdout);
          if (parsed.error) return reject(new Error(friendlyError(parsed.error)));
          resolve(parsed);
        } catch (e) { reject(new Error(`parse failed: ${e.message}\n${stdout.slice(0, 500)}`)); }
      });
  });
}

function ymd(d) {
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}
function parseYmd(s) {
  const [y, m, d] = String(s).slice(0, 10).split('-').map(Number);
  return new Date(y, m - 1, d);
}
// Match SQL Anywhere dow(): 1=Sun, 2=Mon, ..., 7=Sat
function dowSqlAnywhere(date) { return date.getDay() + 1; }
function normTime(t) {
  if (!t) return '';
  const m = String(t).match(/^(\d{1,2}):(\d{2})/);
  return m ? `${m[1].padStart(2,'0')}:${m[2]}` : String(t);
}
function normDateAny(d) {
  if (!d) return '';
  const s = String(d).trim();
  const iso = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
  const us = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})/);
  if (us) {
    let y = us[3]; if (y.length === 2) y = '20' + y;
    return `${y}-${String(us[1]).padStart(2,'0')}-${String(us[2]).padStart(2,'0')}`;
  }
  return s;
}

/**
 * Apply the LCOS UI's max-startdate override: drop SP rows that came from a
 * superseded recurring schedule. SPEC-derived rows are always preserved.
 *
 * For each (clientid, sessiondate):
 *   activeScheduleId = scheduleid of the SCHG clt_changes row with the max
 *                      startdate where startdate <= sessiondate AND enddate IS NULL.
 *
 * A SP row is kept iff:
 *   (a) it matches a SPEC clt_scheduling entry (clientid, eventdate, starttime), OR
 *   (b) it matches a recurring clt_scheduling entry under activeScheduleId
 *       for that (clientid, dayofweek, starttime).
 *
 * Anything else is a stale row from a superseded schedule — drop it.
 */
function applyOverrideFilter(spRows, schgRows, schedRows) {
  // Per-client list of SCHG events (sorted by startdate ascending).
  const schgByClient = new Map();
  for (const r of schgRows) {
    if (!r.clientid || !r.eventid || !r.startdate) continue;
    if (r.enddate) continue; // already ended → SP also excludes it
    const list = schgByClient.get(r.clientid) || [];
    list.push({ scheduleid: r.eventid, startdate: normDateAny(r.startdate) });
    schgByClient.set(r.clientid, list);
  }
  for (const list of schgByClient.values()) list.sort((a, b) => a.startdate.localeCompare(b.startdate));

  // Index recurring slots: clientid|scheduleid|dow|HH:MM → true
  const recurringSlots = new Set();
  // Index SPEC entries: clientid|eventdate|HH:MM → true
  const specSlots = new Set();
  for (const r of schedRows) {
    if (!r.clientid) continue;
    const start = normTime(r.starttime);
    if (r.scheduleid === 'SPEC') {
      const ed = normDateAny(r.eventdate);
      if (ed) specSlots.add(`${r.clientid}|${ed}|${start}`);
    } else if (r.scheduleid && r.dayofweek != null) {
      recurringSlots.add(`${r.clientid}|${r.scheduleid}|${r.dayofweek}|${start}`);
    }
  }

  function activeScheduleId(clientid, dateYmd) {
    const list = schgByClient.get(clientid);
    if (!list) return null;
    let active = null;
    for (const e of list) {
      if (e.startdate <= dateYmd) active = e.scheduleid;
      else break;
    }
    return active;
  }

  let kept = 0, dropped = 0;
  const droppedExamples = [];
  const filtered = spRows.filter(r => {
    const date = normDateAny(r.forday);
    const start = normTime(r.starttime);
    const dow = String(dowSqlAnywhere(parseYmd(date)));
    const specKey = `${r.clientid}|${date}|${start}`;
    if (specSlots.has(specKey)) { kept++; return true; }
    const sid = activeScheduleId(r.clientid, date);
    if (sid && recurringSlots.has(`${r.clientid}|${sid}|${dow}|${start}`)) { kept++; return true; }
    dropped++;
    if (droppedExamples.length < 10) droppedExamples.push(`${r.lastname || '?'}, ${r.firstname || '?'} ${date} ${start} (active=${sid || 'none'})`);
    return false;
  });
  return { filtered, kept, dropped, droppedExamples };
}

(async () => {
  const t0 = Date.now();
  try {
    // 1. The SP — primary source.
    const spSql = `CALL DBA.sp_sign_in_sheet_multidays('${centerCode}', '${startDate}', '${endDate}')`;
    const spResult = await runQuery(spSql, 180);
    let rows = spResult.rows || [];
    const spCount = rows.length;

    if (!skipFilter && rows.length) {
      // Scope secondary queries to the clientids actually returned by the SP —
      // both clt_changes and clt_scheduling are large (~27K / ~179K rows for M56)
      // and the override only needs to validate clients we're already considering.
      const clientIds = [...new Set(rows.map(r => r.clientid).filter(Boolean))];
      const inList = clientIds.map(id => `'${id.replace(/'/g, "''")}'`).join(',');

      // 2. clt_changes — to compute active scheduleid per client+date.
      // Include SCHG (schedule change), CHGSRV (service change), and NEWSRV
      // (new service): all three can introduce a clt_scheduling block, and
      // the SP joins to all three (clauses 1, 2, 3) to produce session rows.
      const schgSql = `SELECT clientid, eventid, startdate, enddate, change_type
        FROM DBA.clt_changes
        WHERE centercode = '${centerCode}'
        AND change_type IN ('SCHG','CHGSRV','NEWSRV')
        AND clientid IN (${inList})`;
      const schgResult = await runQuery(schgSql, 60);

      // 3. clt_scheduling — to validate (dow, starttime) under the active scheduleid
      //    and to recognize SPEC per-event entries.
      const schedSql = `SELECT clientid, scheduleid, dayofweek, starttime, endtime, eventdate
        FROM DBA.clt_scheduling
        WHERE centercode = '${centerCode}'
        AND clientid IN (${inList})`;
      const schedResult = await runQuery(schedSql, 60);

      const { filtered, kept, dropped, droppedExamples } = applyOverrideFilter(rows, schgResult.rows || [], schedResult.rows || []);
      rows = filtered;
      console.log(`Override filter: kept ${kept}, dropped ${dropped} stale row(s) from superseded schedules`);
      if (dropped) {
        console.log('  dropped examples:');
        for (const ex of droppedExamples) console.log(`    - ${ex}`);
      }
    }

    writeFileSync(outPath, JSON.stringify({ rows }, null, 2));
    console.log(`LCOS: ${spCount} SP rows → ${rows.length} after filter in ${((Date.now()-t0)/1000).toFixed(1)}s → ${outPath}`);
  } catch (err) {
    console.error('fetch-lcos.js failed:', err.message);
    process.exit(1);
  }
})();
