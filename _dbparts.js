const { DatabaseSync } = require('node:sqlite');
const db = new DatabaseSync('C:/Users/SOKCHHORN PC/.local/share/opencode/opencode.db');
const sid = 'ses_ff75516c7ffeF7eIdg56RBEB44';
const parts = db.prepare("SELECT id, data FROM part WHERE session_id = ? ORDER BY time_created ASC").all(sid);
console.log('parts:', parts.length);
let readCount = 0;
for (const p of parts) {
  let d;
  try { d = JSON.parse(p.data); } catch (e) { continue; }
  const t = d && d.type;
  const tool = d && d.tool;
  const input = d && d.input;
  const output = d && d.output;
  if (t === 'tool' && tool === 'read') {
    readCount++;
    const f = input && (input.filePath || (input.input && input.input.filePath));
    console.log('--- READ #' + readCount, f, 'len=', output ? String(output).length : 0);
  }
}
console.log('total reads:', readCount);