const { DatabaseSync } = require('node:sqlite');
const db = new DatabaseSync('C:/Users/SOKCHHORN PC/.local/share/opencode/opencode.db');
const sid = 'ses_030a6c2d1ffeYqok3rOuR1TTBe';
const parts = db.prepare("SELECT data FROM part WHERE session_id = ? ORDER BY time_created ASC").all(sid);
const ops = [];
for (const p of parts) {
  let d; try { d = JSON.parse(p.data); } catch (e) { continue; }
  if (d.type !== 'tool') continue;
  const input = d.input || {};
  let f = '';
  if (input.filePath) f = input.filePath;
  else if (input.input && input.input.filePath) f = input.input.filePath;
  const oldLen = (input.oldString || '').length;
  const newLen = (input.newString || '').length;
  const outLen = d.output ? String(d.output).length : 0;
  ops.push({ t: d.tool, f, oldLen, newLen, outLen });
}
const byFile = new Map();
for (const o of ops) {
  if (!o.f) continue;
  const norm = o.f.replace(/^C:\\Users\\SOKCHHORN PC\\OneDrive\\Desktop\\Project WorkSpace\\deep-video-downloader\\/i, '');
  const rec = byFile.get(norm) || { edits: 0, writes: 0, reads: 0, maxOut: 0 };
  if (o.t === 'edit') rec.edits++;
  if (o.t === 'write') rec.writes++;
  if (o.t === 'read') { rec.reads++; rec.maxOut = Math.max(rec.maxOut, o.outLen); }
  byFile.set(norm, rec);
}
for (const [f, r] of byFile) console.log(`${r.reads}r/${r.edits}e/${r.writes}w  maxReadOut=${r.maxOut}  ${f}`);