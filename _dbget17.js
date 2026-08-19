const { DatabaseSync } = require('node:sqlite');
const db = new DatabaseSync('C:/Users/SOKCHHORN PC/.local/share/opencode/opencode.db');
const sid = 'ses_030a6c2d1ffeYqok3rOuR1TTBe';
const parts = db.prepare("SELECT data FROM part WHERE session_id = ? ORDER BY time_created ASC").all(sid);
const PROJ = 'C:\\Users\\SOKCHHORN PC\\OneDrive\\Desktop\\Project WorkSpace\\deep-video-downloader\\extension\\content.js';
let seq = 0;
for (const p of parts) {
  let d; try { d = JSON.parse(p.data); } catch (e) { continue; }
  if (d.type !== 'tool' || d.tool !== 'edit') continue;
  const input = d.state && d.state.input;
  if (!input || input.filePath !== PROJ) continue;
  seq++;
  const os = input.oldString || '', ns = input.newString || '';
  if (os.length === 145 && ns.length === 457) {
    const diff = (d.state && d.state.metadata && d.state.metadata.diff) || '';
    console.log('=== EDIT #' + seq + ' capturedUrls bestOnly (diff metadata) ===');
    console.log(diff);
    console.log('\n--- OLD (145) ---'); console.log(os);
    console.log('--- NEW (457) ---'); console.log(ns);
  }
}