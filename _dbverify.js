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
  const output = (d.state && d.state.output) || '';
  // flag the two suspicious edits
  const isFail = os.includes('capturedUrls') && os.includes('if (!found.has(v.url))') && os.length < 200;
  const isGetFound = os.includes('get-found') && os.includes('config.bestOnly');
  if (isFail || isGetFound) {
    n++;
    console.log('===== EDIT #' + n + ' ' + rel + ' =====');
    console.log('OUTPUT:', String(output).slice(0, 200));
    console.log('OLD len=' + os.length + ' NEW len=' + ns.length);
    const st = d.state && d.state.status;
    console.log('STATUS:', st);
    const md = d.state && d.state.metadata;
    if (md && md.diagnostics) console.log('DIAGNOSTICS:', JSON.stringify(md.diagnostics).slice(0, 300));
    console.log('--- OLD head ---'); console.log(os.split('\n').slice(0, 8).join('\n'));
    console.log('--- NEW head ---'); console.log(ns.split('\n').slice(0, 8).join('\n'));
    console.log();
  }
}
console.log('total:', n);