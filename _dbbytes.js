const { DatabaseSync } = require('node:sqlite');
const db = new DatabaseSync('C:/Users/SOKCHHORN PC/.local/share/opencode/opencode.db');
const sid = 'ses_030a6c2d1ffeYqok3rOuR1TTBe';
const parts = db.prepare("SELECT data FROM part WHERE session_id = ? ORDER BY time_created ASC").all(sid);
const PROJ = 'C:\\Users\\SOKCHHORN PC\\OneDrive\\Desktop\\Project WorkSpace\\deep-video-downloader\\renderer.js';
let readCount = 0;
for (const p of parts) {
  let d; try { d = JSON.parse(p.data); } catch (e) { continue; }
  if (d.type !== 'tool') continue;
  const input = d.state && d.state.input;
  if (!input || input.filePath !== PROJ) continue;
  if (d.tool === 'read') {
    readCount++;
    const out = String(d.state.output || '');
    const idx = out.indexOf('fmtSpeed');
    if (idx !== -1) {
      console.log('READ #' + readCount + ' fmtSpeed line bytes:', JSON.stringify(out.slice(idx, idx + 60)));
      // Show the raw byte values around
      const slice = Buffer.from(out.slice(idx - 2, idx + 30), 'utf8');
      console.log('   hex:', slice.toString('hex'));
    }
  }
}
console.log('readCount', readCount);