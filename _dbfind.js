const { DatabaseSync } = require('node:sqlite');
const db = new DatabaseSync('C:/Users/SOKCHHORN PC/.local/share/opencode/opencode.db');
const parts = db.prepare("SELECT session_id, data FROM part").all();
const sessions = new Map();
for (const p of parts) {
  let d; try { d = JSON.parse(p.data); } catch (e) { continue; }
  const s = d ? JSON.stringify(d) : '';
  if (s.includes('bestOnly') || s.includes('qualityRank') || s.includes('reevaluateBest') || s.includes('waitForOpen')) {
    const list = sessions.get(p.session_id) || { count: 0, tools: {} };
    list.count++;
    const k = d.type + (d.tool ? ':' + d.tool : '');
    list.tools[k] = (list.tools[k] || 0) + 1;
    sessions.set(p.session_id, list);
  }
}
for (const [sid, v] of sessions) {
  const meta = db.prepare("SELECT title, time_created FROM session WHERE id = ?").get(sid);
  console.log(sid, '|', meta ? meta.title : '?', '| parts=', v.count, '|', JSON.stringify(v.tools));
}