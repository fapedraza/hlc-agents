/**
 * lookup-schedules.js — Show current + future recurring schedule blocks for a student
 *
 * LCOS stores recurring schedules in DBA.clt_scheduling. Each block shares a
 * `scheduleid` of the form `MMDDYY<service>` (e.g. `041826A1`) that encodes
 * the effective start date. `scheduleid = 'SPEC'` rows are single-event
 * exceptions (cancellations, makeups, etc.) and are listed separately.
 *
 * Usage:
 *   node lookup-schedules.js "<name or clientid>"
 *
 * Examples:
 *   node lookup-schedules.js "Hayley Boehl"
 *   node lookup-schedules.js 03032026135
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

const search = process.argv.slice(2).join(' ').trim();
if (!search) {
  console.error('Usage: node lookup-schedules.js "<name or clientid>"');
  process.exit(1);
}

const cfg = JSON.parse(readFileSync(CONFIG_PATH, 'utf-8'));
const centerCode = cfg.CenterCode;
const connStr = `Driver={SQL Anywhere 17};Host=${cfg.DB.Host || '127.0.0.1'};ServerName=${cfg.DB.ServerName || 'LCOS'};UID=${cfg.DB.User};PWD=${cfg.DB.Password}`;

function runQuery(sql, timeoutSec = 30) {
  const scriptPath = join(TEMP_DIR, `lcos_${randomBytes(8).toString('hex')}.ps1`);
  const ps = `[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
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
    $conn.Close(); $conn.Dispose()
    ConvertTo-Json @{ columns=$cols; rows=$rows } -Depth 10 -Compress
} catch {
    ConvertTo-Json @{ error=$_.Exception.Message } -Compress
    exit 1
}
`;
  writeFileSync(scriptPath, ps, 'utf-8');
  return new Promise((resolve, reject) => {
    execFile(PS_32BIT,
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', scriptPath],
      { maxBuffer: 50 * 1024 * 1024, timeout: (timeoutSec + 10) * 1000 },
      (err, stdout, stderr) => {
        try { unlinkSync(scriptPath); } catch {}
        if (err) return reject(new Error(`${err.message}\n${stderr}`));
        try {
          const parsed = JSON.parse(stdout);
          if (parsed.error) return reject(new Error(parsed.error));
          resolve(parsed.rows || []);
        } catch (e) { reject(new Error(`parse failed: ${e.message}\n${stdout}`)); }
      });
  });
}

function sqlEscape(s) { return String(s).replace(/'/g, "''"); }

async function resolveClient(input) {
  if (/^[0-9A-Z]{11}$/i.test(input)) {
    const rows = await runQuery(`SELECT clientid, firstname, lastname FROM DBA.clt_clients WHERE clientid = '${sqlEscape(input)}'`);
    if (rows.length) return rows[0];
  }
  const parts = input.split(/\s+/).filter(Boolean);
  let where;
  if (parts.length >= 2) {
    const first = sqlEscape(parts[0]);
    const last = sqlEscape(parts.slice(1).join(' '));
    where = `(firstname LIKE '${first}%' AND lastname LIKE '${last}%') OR (firstname LIKE '${last}%' AND lastname LIKE '${first}%')`;
  } else {
    const p = sqlEscape(parts[0]);
    where = `firstname LIKE '${p}%' OR lastname LIKE '${p}%'`;
  }
  const rows = await runQuery(`SELECT clientid, firstname, lastname FROM DBA.clt_clients WHERE centercode = '${centerCode}' AND (${where})`);
  return rows;
}

// Parse `MMDDYY<service>` → { effectiveDate: YYYY-MM-DD, service }
// Returns null for SPEC or anything that doesn't match the pattern.
function parseScheduleId(id) {
  if (!id || id === 'SPEC') return null;
  const m = /^(\d{2})(\d{2})(\d{2})(.+)$/.exec(id);
  if (!m) return null;
  const [, mm, dd, yy, service] = m;
  const year = 2000 + parseInt(yy, 10);
  return { effectiveDate: `${year}-${mm}-${dd}`, service };
}

const DOW_ORDER = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
function fmtTime(t) {
  if (!t) return '';
  const [h, m] = t.split(':').map(Number);
  const period = h >= 12 ? 'pm' : 'am';
  const h12 = h === 0 ? 12 : h > 12 ? h - 12 : h;
  return m === 0 ? `${h12}${period}` : `${h12}:${String(m).padStart(2, '0')}${period}`;
}
function fmtDate(ymd) {
  const [y, m, d] = ymd.split('-').map(Number);
  const dt = new Date(y, m - 1, d);
  return dt.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
}

function today() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}

async function main() {
  const resolved = await resolveClient(search);
  if (!resolved) return console.error(`No client found for "${search}"`);
  if (Array.isArray(resolved)) {
    if (resolved.length === 0) return console.error(`No client found for "${search}"`);
    if (resolved.length > 1) {
      console.log(`Multiple matches for "${search}" — specify clientid:\n`);
      for (const r of resolved) console.log(`  ${r.clientid}  ${r.firstname || ''} ${r.lastname || ''}`);
      return;
    }
    resolved.single = true;
  }
  const client = Array.isArray(resolved) ? resolved[0] : resolved;
  const clientid = client.clientid;

  const rows = await runQuery(
    `SELECT scheduleid, service, subjectarea, cdow, dayofweek, starttime, endtime, hours, attendcode, eventdate, referenceid, notes
     FROM DBA.clt_scheduling
     WHERE clientid = '${sqlEscape(clientid)}'
     ORDER BY scheduleid, dayofweek, starttime`
  );

  console.log(`\n${client.firstname || ''} ${client.lastname || ''}  (${clientid})`);
  console.log('='.repeat(64));

  const recurring = rows.filter(r => r.scheduleid !== 'SPEC');
  const exceptions = rows.filter(r => r.scheduleid === 'SPEC');

  const blocks = new Map();
  for (const r of recurring) {
    if (!blocks.has(r.scheduleid)) blocks.set(r.scheduleid, []);
    blocks.get(r.scheduleid).push(r);
  }

  const sorted = [...blocks.entries()].map(([id, rows]) => {
    const parsed = parseScheduleId(id);
    return { id, rows, effectiveDate: parsed?.effectiveDate || '', service: parsed?.service || '' };
  }).sort((a, b) => (a.effectiveDate || '').localeCompare(b.effectiveDate || ''));

  const now = today();
  let currentIdx = -1;
  for (let i = 0; i < sorted.length; i++) {
    if (sorted[i].effectiveDate && sorted[i].effectiveDate <= now) currentIdx = i;
  }

  if (sorted.length === 0) {
    console.log('\n(no recurring schedule blocks on file)');
  } else {
    console.log('\nRecurring schedule blocks:\n');
    sorted.forEach((b, i) => {
      let tag;
      if (i === currentIdx) tag = '[CURRENT]';
      else if (i < currentIdx) tag = '[past]   ';
      else tag = '[future] ';
      const hdr = `${tag}  scheduleid=${b.id}  service=${b.service}  effective ${b.effectiveDate ? fmtDate(b.effectiveDate) : '?'}`;
      console.log(hdr);
      const byDay = [...b.rows].sort((a, c) =>
        (DOW_ORDER[a.cdow] ?? 9) - (DOW_ORDER[c.cdow] ?? 9) || (a.starttime || '').localeCompare(c.starttime || '')
      );
      for (const r of byDay) {
        console.log(`         ${r.cdow}  ${fmtTime(r.starttime)}–${fmtTime(r.endtime)}  ${r.subjectarea || ''}  (${r.hours}h, ${r.attendcode || ''})`);
      }
      console.log('');
    });
  }

  if (exceptions.length) {
    console.log(`SPEC exceptions (${exceptions.length}):\n`);
    exceptions
      .sort((a, b) => (a.eventdate || '').localeCompare(b.eventdate || ''))
      .forEach(r => {
        const d = r.eventdate ? new Date(r.eventdate).toISOString().slice(0, 10) : '(no date)';
        console.log(`  ${d}  ${r.cdow || ''}  ${fmtTime(r.starttime)}–${fmtTime(r.endtime)}  ${r.attendcode}  ref=${r.referenceid || ''}  ${r.notes ? '— ' + r.notes : ''}`);
      });
    console.log('');
  }
}

main().catch(err => { console.error('lookup-schedules.js failed:', err.message); process.exit(1); });
