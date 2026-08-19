const { DatabaseSync } = require('node:sqlite');
const fs = require('fs');
const db = new DatabaseSync('C:/Users/SOKCHHORN PC/.local/share/opencode/opencode.db');
const sid = 'ses_030a6c2d1ffeYqok3rOuR1TTBe';
const parts = db.prepare("SELECT data FROM part WHERE session_id = ? ORDER BY time_created ASC").all(sid);
const outdir = 'C:/Users/SOKCHHORN PC/AppData/Local/Temp/opencode/recov';
let fCount = 0, pCount = 0;
for (const p of parts) {
  let d; try { d = JSON.parse(p.data); } catch (e) { continue; }
  if (d.type === 'file') {
    fCount++;
    const fn = outdir + '/FILE_' + fCount + '.json';
    fs.writeFileSync(fn, JSON.stringify(d, null, 1));
    console.log('FILE part', fCount, 'saved ->', fn, 'keys:', Object.keys(d).join(','));
  } else if (d.type === 'patch') {
    pCount++;
    if (pCount <= 3) {
      const fn = outdir + '/PATCH_' + pCount + '.json';
      fs.writeFileSync(fn, JSON.stringify(d, null, 1));
      console.log('PATCH part', pCount, 'saved ->', fn, 'keys:', Object.keys(d).join(','));
    }
  }
}
console.log('total file parts:', fCount, 'patch parts:', pCount);