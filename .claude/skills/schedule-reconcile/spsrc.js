/** READ-ONLY: the sign-in SP's own source — how does it treat enddate? */
const { execFile } = require('child_process');
const { writeFileSync, readFileSync, unlinkSync, mkdirSync } = require('fs');
const { join } = require('path');
const { randomBytes } = require('crypto');
const { tmpdir } = require('os');
const PS_32BIT = 'C:\\Windows\\SysWOW64\\WindowsPowerShell\\v1.0\\powershell.exe';
const cfg = JSON.parse(readFileSync('C:\\LCOS\\config-issaquah.json', 'utf-8'));
const connStr = `Driver={SQL Anywhere 17};Host=${cfg.DB.Host || '127.0.0.1'};ServerName=${cfg.DB.ServerName || 'LCOS'};UID=${cfg.DB.User};PWD=${cfg.DB.Password}`;
const TEMP_DIR = join(tmpdir(), 'lcos-standalone');
try { mkdirSync(TEMP_DIR, { recursive: true }); } catch {}
function runPs(body,t=120){const p=join(TEMP_DIR,`l_${randomBytes(8).toString('hex')}.ps1`);writeFileSync(p,body,'utf-8');
 return new Promise((res,rej)=>{execFile(PS_32BIT,['-NoProfile','-ExecutionPolicy','Bypass','-File',p],
 {maxBuffer:64*1024*1024,timeout:(t+30)*1000},(e,so,se)=>{try{unlinkSync(p)}catch{};if(e&&!so)return rej(new Error(se||e.message));res(String(so).trim())})});}
(async () => {
  const body = `
$ErrorActionPreference='Stop'
$conn=New-Object System.Data.Odbc.OdbcConnection('${connStr.replace(/'/g,"''")}'); $conn.Open()
$cmd=$conn.CreateCommand()
$cmd.CommandText="SELECT proc_name, proc_defn FROM SYS.SYSPROCEDURE WHERE proc_name LIKE 'sp_sign_in%'"
$a=New-Object System.Data.Odbc.OdbcDataAdapter($cmd); $dt=New-Object System.Data.DataTable; [void]$a.Fill($dt)
foreach($r in $dt.Rows){ "===== $($r['proc_name']) ====="; $r['proc_defn'] }
$conn.Close()`;
  const src = await runPs(body, 120);
  // print only the lines that mention enddate, with context
  const lines = src.split(/\r?\n/);
  lines.forEach((l, i) => {
    if (/enddate/i.test(l) || /^=====/.test(l)) console.log(String(i).padStart(4) + ': ' + l.trim().slice(0, 160));
  });
  require('fs').writeFileSync(join(TEMP_DIR, 'sp_src.txt'), src);
  console.log('\n(full source saved to ' + join(TEMP_DIR, 'sp_src.txt') + ', ' + lines.length + ' lines)');
})().catch(e => { console.error('failed: ' + e.message); process.exit(1); });
