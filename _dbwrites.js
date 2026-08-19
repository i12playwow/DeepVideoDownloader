const { DatabaseSync } = require('node:sqlite');
const db = new DatabaseSync('C:/Users/SOKCHHORN PC/.local/share/opencode/opencode.db');
const sid = 'ses_030a6c2d1ffeYqok3rOuR1TTBe';
const parts = db.prepare("SELECT data FROM part WHERE session_id = ? ORDER BY time_created ASC").all(sid);
const writes = [];
for (const p of parts) {
  let d; try { d = JSON.parse(p.data); } catch (e) { continue; }
  if (d.type !== 'tool') continue;
  const input = d.state && d.state.input;
  if (!input) continue;
  const f = input.filePath || '';
  if (!f) continue;
  const norm = f.replace(/^C:\\Users\\SOKCHHORN PC\\OneDrive\\Desktop\\Project WorkSpace\\deep-video-downloader\\/i, '');
  if (d.tool === 'write') {
    writes.push({ f: norm, content: input.content || '', out: d.state.output || '' });
  }
}
console.log('WRITES:', writes.length);
for (const w of writes) {
  console.log(`\n===== WRITE ${w.f} (${w.content.length}b) =====`);
  console.log(w.content.slice(0, 400));
  if (w.content.length > 400) console.log('  ...TRUNCATED...');
}