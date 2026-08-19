const { DatabaseSync } = require('node:sqlite');
const db = new DatabaseSync('C:/Users/SOKCHHORN PC/.local/share/opencode/opencode.db');
const sid = 'ses_030a6c2d1ffeYqok3rOuR1TTBe';
const parts = db.prepare("SELECT data FROM part WHERE session_id = ? ORDER BY time_created ASC").all(sid);
const PROJ = 'C:\\Users\\SOKCHHORN PC\\OneDrive\\Desktop\\Project WorkSpace\\deep-video-downloader\\renderer.js';
for (const p of parts) {
  let d; try { d = JSON.parse(p.data); } catch (e) { continue; }
  if (d.type !== 'tool') continue;
  const input = d.state && d.state.input;
  if (!input || input.filePath !== PROJ) continue;
  const os = input.oldString || '', ns = input.newString || '';
  const check = (s, tag) => {
    const m = s.match(/fmtSpeed[\s\S]{0,80}/);
    if (m) console.log(tag, JSON.stringify(m[0]));
  };
  check(os, 'OLD');
  check(ns, 'NEW');
  const out = d.state.output ? String(d.state.output) : '';
  if (out.includes('fmtSpeed')) {
    const m = out.match(/fmtSpeed[\s\S]{0,80}/);
    if (m) console.log('OUT', JSON.stringify(m[0]));
  }
}
console.log('--- done ---');