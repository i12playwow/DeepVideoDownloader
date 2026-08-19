const { DatabaseSync } = require('node:sqlite');
const db = new DatabaseSync('C:/Users/SOKCHHORN PC/.local/share/opencode/opencode.db');
const parts = db.prepare("SELECT session_id, data FROM part ORDER BY time_created ASC").all();
const hits = new Map();
for (const p of parts) {
  let d;
  try { d = JSON.parse(p.data); } catch (e) { continue; }
  if (d && d.type === 'tool' && d.tool === 'read') {
    const input = d.input || {};
    const f = input.filePath || (input.input && input.input.filePath) || '';
    if (f && !hits.has(f)) {
      hits.set(f, { session: p.session_id, len: d.output ? String(d.output).length : 0 });
    }
  }
}
for (const [f, v] of hits) {
  console.log(v.session.slice(0, 30), '|', String(v.len).padStart(7), '|', f);
}