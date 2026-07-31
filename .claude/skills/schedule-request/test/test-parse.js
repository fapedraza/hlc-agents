const { parseStudentNote, wantsTutorChangeNotice } = require('../lib/parse-student-note');
const cases = [
  '7/13/2026 No Connie',
  '7/8/2026 No Leta for math',
  '10/10/2023 NO NAINA',
  '4/24/2026 No Jacob',
  '6/2/2016 Best: Amy, Jamie, Alicia, Anita\nOkay: Stacey, Josh, Ian\nNo: Beverly, Janis\n9/14/2',
  '12/29/2025 Hana preferred\nInform family of tutor changes',
  '7/7/2026 Family would like to be informed of any tutor changes',
  '2/14/2026 Send ALL schedule changes to BOTH Aaryan and his dad.',
  '10/21/2025 Quiet room preferred when possible',
  '',
];
for (const c of cases) {
  const r = parseStudentNote(c);
  const f = a => a.map(x => x.name + (x.scope ? `(${x.scope})` : '')).join(', ') || '-';
  console.log(`\n"${c.replace(/\n/g,' / ').slice(0,60)}"`);
  console.log(`   never=[${f(r.never)}]  prefer=[${f(r.prefer)}]  okay=[${f(r.okay)}]`);
  console.log(`   other=${JSON.stringify(r.other)}  notify=${wantsTutorChangeNotice(c)}`);
}
