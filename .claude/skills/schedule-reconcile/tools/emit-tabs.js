const fs = require('fs');
const path = require('path');

const payloadPath = process.argv[2];
const payload = JSON.parse(fs.readFileSync(payloadPath, 'utf8'));
const outDir = path.dirname(payloadPath);

// Each file contains one JSON array on one line — compact
function emit(name, rows) {
  fs.writeFileSync(path.join(outDir, `tab_${name}.json`), JSON.stringify(rows));
}
emit('dashboard', payload.tabs.dashboard);
emit('discrepancies', payload.tabs.discrepancies);

// Chunk large tabs
function chunk(name, rows, size) {
  let idx = 0;
  for (let i = 0; i < rows.length; i += size) {
    fs.writeFileSync(path.join(outDir, `tab_${name}_${idx}.json`), JSON.stringify(rows.slice(i, i + size)));
    idx++;
  }
  fs.writeFileSync(path.join(outDir, `tab_${name}_chunks.json`), JSON.stringify({ count: idx, size, total: rows.length }));
}
// Write full tabs as single files (preferred — one API call each)
emit('lcos', payload.tabs.lcosSchedule);
emit('aplus', payload.tabs.aplusSchedule);

// Also emit chunks as fallback if single-call write fails (500 rows each)
chunk('lcos', payload.tabs.lcosSchedule, 500);
chunk('aplus', payload.tabs.aplusSchedule, 500);

console.log('Emitted tab files to', outDir);
console.log('lcos rows:', payload.tabs.lcosSchedule.length, '(chunks:', Math.ceil(payload.tabs.lcosSchedule.length / 500) + ')');
console.log('aplus rows:', payload.tabs.aplusSchedule.length, '(chunks:', Math.ceil(payload.tabs.aplusSchedule.length / 500) + ')');

// Subject + email HTML in its own file
fs.writeFileSync(path.join(outDir, 'subject.txt'), payload.subject);
