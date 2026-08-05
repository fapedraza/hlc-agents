const fs=require('fs');
const rep=JSON.parse(fs.readFileSync('replay-report.json','utf8'));
const c=(rep.cases||rep.results||[]).find(x=>/c22/.test(x.name||x.case||''));
const s=JSON.stringify(c);
console.log('  case verdict : '+(c.verdict||c.result));
console.log('  action/tutor : '+(c.action||'')+' -> '+(c.tutor||''));
console.log('  Leta mentioned anywhere in the result: '+/Hamilton|Leta/i.test(s));
