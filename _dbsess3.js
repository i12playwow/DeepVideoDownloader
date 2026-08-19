const { DatabaseSync } = require('node:sqlite');
const db = new DatabaseSync('C:/Users/SOKCHHORN PC/.local/share/opencode/opencode.db');
const sid = 'ses_030a6c2d1ffeYqok3rOuR1TTBe';
const s = db.prepare("SELECT id, title, slug, time_created, time_updated FROM session WHERE id = ?").get(sid);
console.log('session:', s);
const parts = db.prepare("SELECT id, data FROM part WHERE session_id = ? ORDER BY time_created ASC").all(sid);
console.log('parts:', parts.length);
const types = {};
for (const p of parts) {
  let d; try { d = JSON.parse(p.data); } catch (e) { continue; }
  const k = d.type + (d.tool ? ':' + d.tool : '');
  types[k] = (types[k] || 0) + 1;
}
console.log('types:', JSON.stringify(types, null, 1));