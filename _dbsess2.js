const { DatabaseSync } = require('node:sqlite');
const db = new DatabaseSync('C:/Users/SOKCHHORN PC/.local/share/opencode/opencode.db');
const sid = 'ses_0248c5d0bffeBnASGpD7i5f171';
const parts = db.prepare("SELECT id, data FROM part WHERE session_id = ? ORDER BY time_created ASC").all(sid);
console.log('parts:', parts.length);
const types = {};
for (const p of parts) {
  let d; try { d = JSON.parse(p.data); } catch (e) { continue; }
  const k = d.type + (d.tool ? ':' + d.tool : '');
  types[k] = (types[k] || 0) + 1;
  if (d.type === 'tool' && (d.tool === 'read' || d.tool === 'write' || d.tool === 'edit')) {
    const f = (d.input && (d.input.filePath || (d.input.input && d.input.input.filePath))) || '';
    console.log(k, '=>', f, 'outlen=', d.output ? String(d.output).length : 0);
  }
}
console.log('types:', JSON.stringify(types, null, 1));