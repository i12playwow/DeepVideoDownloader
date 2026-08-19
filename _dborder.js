const { DatabaseSync } = require('node:sqlite');
const db = new DatabaseSync('C:/Users/SOKCHHORN PC/.local/share/opencode/opencode.db');
const sid = 'ses_030a6c2d1ffeYqok3rOuR1TTBe';
const parts = db.prepare("SELECT data FROM part WHERE session_id = ? ORDER BY time_created ASC").all(sid);
const PROJ = 'C:\\Users\\SOKCHHORN PC\\OneDrive\\Desktop\\Project WorkSpace\\deep-video-downloader\\extension\\content.js';
let i = 0;
for (const p of parts) {
  let d; try { d = JSON.parse(p.data); } catch (e) { continue; }
  if (d.type !== 'tool') continue;
  const input = d.state && d.state.input;
  if (!input || !input.filePath || input.filePath !== PROJ) continue;
  i++;
  const isRead = d.tool === 'read';
  const off = input.offset || 1;
  const lim = input.limit || 0;
  if (isRead) {
    console.log(`#${String(i).padStart(3)} READ  offset=${off} limit=${lim} outLen=${d.state.output ? String(d.state.output).length : 0}`);
  } else if (d.tool === 'edit') {
    const os = input.oldString || '', ns = input.newString || '';
    const firstLine = os.split('\n')[0] || '';
    const ok = (d.state.output || '').includes('successfully');
    console.log(`#${String(i).padStart(3)} EDIT  -${os.length}/+${ns.length} ${ok ? 'OK' : 'FAIL'}  | ${firstLine.slice(0, 90)}`);
  }
}