/**
 * EMPTY-SUCCESSOR EXPERIMENT — Anagha Krishnan (0125M026019), approved by Ferni.
 *
 *  1. INSERT an empty schedule: eventid 091026S1, startdate 2026-09-10, SCHG,
 *     NO clt_scheduling pattern rows. From 9/10 it is the newest schedule and
 *     generates nothing = silence instead of 7:30 noise.
 *  2. Tombstone the 7:30 placeholder 091126S1 (enddate = its startdate) so it
 *     never takes over on 9/11.
 *  Rollback: DELETE the inserted row; placeholder enddate -> NULL.
 */
const { execFile } = require('child_process');
const { writeFileSync, readFileSync, unlinkSync, mkdirSync } = require('fs');
const { join } = require('path');
const { randomBytes } = require('crypto');
const { tmpdir } = require('os');
const PS_32BIT = 'C:\\Windows\\SysWOW64\\WindowsPowerShell\\v1.0\\powershell.exe';
const cfg = JSON.parse(readFileSync('C:\\LCOS\\config-issaquah.json', 'utf-8'));
const centerCode = cfg.CenterCode;
const connStr = `Driver={SQL Anywhere 17};Host=${cfg.DB.Host || '127.0.0.1'};ServerName=${cfg.DB.ServerName || 'LCOS'};UID=${cfg.DB.User};PWD=${cfg.DB.Password}`;
const TEMP_DIR = join(tmpdir(), 'lcos-standalone');
try { mkdirSync(TEMP_DIR, { recursive: true }); } catch {}
const CLIENT = '0125M026019';
function runPs(body,t=120){const p=join(TEMP_DIR,`l_${randomBytes(8).toString('hex')}.ps1`);writeFileSync(p,body,'utf-8');
 return new Promise((res,rej)=>{execFile(PS_32BIT,['-NoProfile','-ExecutionPolicy','Bypass','-File',p],
 {maxBuffer:32*1024*1024,timeout:(t+30)*1000},(e,so,se)=>{try{unlinkSync(p)}catch{};if(e&&!so)return rej(new Error(se||e.message));res(String(so).trim())})});}
const q=sql=>`
$ErrorActionPreference='Stop'
$conn=New-Object System.Data.Odbc.OdbcConnection('${connStr.replace(/'/g,"''")}'); $conn.Open()
$cmd=$conn.CreateCommand(); $cmd.CommandText="${sql.replace(/"/g,'`"')}"; $cmd.CommandTimeout=120
$a=New-Object System.Data.Odbc.OdbcDataAdapter($cmd); $dt=New-Object System.Data.DataTable; [void]$a.Fill($dt)
foreach($r in $dt.Rows){ ($dt.Columns|ForEach-Object{"$($_.ColumnName)=$($r[$_.ColumnName])"}) -join ' ' }
$conn.Close()`;
const x=sql=>`
$ErrorActionPreference='Stop'
$conn=New-Object System.Data.Odbc.OdbcConnection('${connStr.replace(/'/g,"''")}'); $conn.Open()
$cmd=$conn.CreateCommand(); $cmd.CommandText="${sql.replace(/"/g,'`"')}"
"AFFECTED=$($cmd.ExecuteNonQuery())"
$conn.Close()`;
(async () => {
  // 1) the empty successor
  let out = await runPs(x(`INSERT INTO DBA.clt_changes (centercode, clientid, change_type, startdate, service, eventid, userid) VALUES ('${centerCode}','${CLIENT}','SCHG','2026-09-10','S1','091026S1','staff')`));
  console.log('INSERT 091026S1 (empty successor): ' + out);
  if (!/AFFECTED=1/.test(out)) { console.log('STOP.'); process.exit(1); }
  // 2) tombstone the placeholder
  out = await runPs(x(`UPDATE DBA.clt_changes SET enddate='2026-09-11' WHERE centercode='${centerCode}' AND clientid='${CLIENT}' AND eventid='091126S1' AND enddate IS NULL`));
  console.log('TOMBSTONE 091126S1 (7:30 placeholder): ' + out);
  if (!/AFFECTED=1/.test(out)) { console.log('STOP — rolling back the insert.');
    console.log(await runPs(x(`DELETE FROM DBA.clt_changes WHERE centercode='${centerCode}' AND clientid='${CLIENT}' AND eventid='091026S1'`)));
    process.exit(1); }

  console.log('\nROWS NOW:');
  console.log(await runPs(q(`SELECT eventid, startdate, enddate, userid FROM DBA.clt_changes WHERE centercode='${centerCode}' AND clientid='${CLIENT}' AND eventid IN ('090626S1','091026S1','091126S1')`)));
  console.log('\nSIGN-IN 9/6-9/12  (expect Sun 9/6 10:30 + Wed 9/9 18:30, NOTHING 9/10-9/12):');
  console.log(await runPs(q(`SELECT forday, starttime, endtime, attendcode FROM DBA.sp_sign_in_sheet_multidays('${centerCode}','2026-09-06','2026-09-12') WHERE clientid='${CLIENT}' ORDER BY forday`)) || '  (none)');
  console.log('\nSIGN-IN 9/13-9/20 (expect at most the standalone 9/14 7:30 VAC event):');
  console.log(await runPs(q(`SELECT forday, starttime, endtime, attendcode FROM DBA.sp_sign_in_sheet_multidays('${centerCode}','2026-09-13','2026-09-20') WHERE clientid='${CLIENT}' ORDER BY forday`)) || '  (none)');
  console.log('\nSIGN-IN 9/21-10/4 (expect EMPTY — the placeholder would have made Mondays here):');
  console.log(await runPs(q(`SELECT forday, starttime, endtime, attendcode FROM DBA.sp_sign_in_sheet_multidays('${centerCode}','2026-09-21','2026-10-04') WHERE clientid='${CLIENT}' ORDER BY forday`)) || '  (none)');
})().catch(e => { console.error('failed: ' + e.message); process.exit(1); });
