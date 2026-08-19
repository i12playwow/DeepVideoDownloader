const { DatabaseSync } = require('node:sqlite');
const db = new DatabaseSync('C:/Users/SOKCHHORN PC/.local/share/opencode/opencode.db');
const sid = 'ses_030a6c2d1ffeYqok3rOuR1TTBe';
const parts = db.prepare("SELECT data FROM part WHERE session_id = ? ORDER BY time_created ASC").all(sid);
const PROJ = 'C:\\Users\\SOKCHHORN PC\\OneDrive\\Desktop\\Project WorkSpace\\deep-video-downloader\\';
let n = 0;
for (const p of parts) {
  let d; try { d = JSON.parse(p.data); } catch (e) { continue; }
  if (d.type !== 'tool' || d.tool !== 'edit') continue;
  const input = d.state && d.state.input;
  if (!input || !input.filePath || !input.filePath.startsWith(PROJ)) continue;
  const rel = input.filePath.slice(PROJ.length);
  const os = input.oldString || '', ns = input.newString || '';
  if (rel.includes('content.js') && (os.includes('capturedUrls') || os.includes('chrome.runtime.sendMessage'))) {
    n++;
    console.log('===== FAILED EDIT #' + n + ' on ' + rel + ' =====');
    console.log('--- OLD (' + os.length + ') ---');
    console.log(os);
    console.log('--- NEW (' + ns.length + ') ---');
    console.log(ns);
    console.log();
  }
}
console.log('total shown:', n);