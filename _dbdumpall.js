const { DatabaseSync } = require('node:sqlite');
const fs = require('fs');
const path = require('path');
const db = new DatabaseSync('C:/Users/SOKCHHORN PC/.local/share/opencode/opencode.db');
const sid = 'ses_030a6c2d1ffeYqok3rOuR1TTBe';
const parts = db.prepare("SELECT data FROM part WHERE session_id = ? ORDER BY time_created ASC").all(sid);
const outdir = 'C:/Users/SOKCHHORN PC/AppData/Local/Temp/opencode/recov';
fs.mkdirSync(outdir, { recursive: true });
const reads = [];
const edits = [];
const writes = [];
let idx = 0;
for (const p of parts) {
  let d; try { d = JSON.parse(p.data); } catch (e) { continue; }
  if (d.type !== 'tool') continue;
  const input = d.state && d.state.input;
  if (!input) continue;
  const f = input.filePath || '';
  if (!f) continue;
  idx++;
  const base = f.replace(/^C:\\Users\\SOKCHHORN PC\\OneDrive\\Desktop\\Project WorkSpace\\deep-video-downloader\\/i, 'recov/proj/');
  if (d.tool === 'read') {
    const out = d.state && d.state.output ? String(d.state.output) : '';
    if (out.length > 100) {
      const fn = path.join(outdir, 'READ_' + String(idx).padStart(3, '0') + '_' + sanitize(base) + '.txt');
      fs.writeFileSync(fn, 'SOURCE: ' + f + '\n' + out);
      reads.push({ f, fn, len: out.length });
    }
  } else if (d.tool === 'edit') {
    const fn = path.join(outdir, 'EDIT_' + String(idx).padStart(3, '0') + '_' + sanitize(base) + '.txt');
    const diff = (d.state && d.state.metadata && d.state.metadata.diff) || '';
    fs.writeFileSync(fn, 'SOURCE: ' + f + '\n\n' + diff);
    edits.push({ f, fn, len: diff.length, oldLen: (input.oldString || '').length, newLen: (input.newString || '').length });
  } else if (d.tool === 'write') {
    const fn = path.join(outdir, 'WRITE_' + String(idx).padStart(3, '0') + '_' + sanitize(base) + '.txt');
    fs.writeFileSync(fn, 'SOURCE: ' + f + '\n' + (input.content || ''));
    writes.push({ f, fn, len: (input.content || '').length });
  }
}
function sanitize(s) { return s.replace(/[^A-Za-z0-9_.-]/g, '_').slice(0, 80); }
console.log('reads:', reads.length, 'edits:', edits.length, 'writes:', writes.length);
console.log('\n=== READS ===');
for (const r of reads) console.log(r.len, r.f);
console.log('\n=== WRITES (project only) ===');
for (const w of writes) console.log(w.len, w.f);
console.log('\n=== EDITS ===');
for (const e of edits) console.log(`-${e.oldLen}/+${e.newLen}`, e.f);