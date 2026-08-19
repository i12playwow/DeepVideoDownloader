const { DatabaseSync } = require('node:sqlite');
const fs = require('fs');
const path = require('path');
const db = new DatabaseSync('C:/Users/SOKCHHORN PC/.local/share/opencode/opencode.db');
const sid = 'ses_030a6c2d1ffeYqok3rOuR1TTBe';
const parts = db.prepare("SELECT data FROM part WHERE session_id = ? ORDER BY time_created ASC").all(sid);
const PROJ = 'C:\\Users\\SOKCHHORN PC\\OneDrive\\Desktop\\Project WorkSpace\\deep-video-downloader\\';
const outdir = 'C:/Users/SOKCHHORN PC/AppData/Local/Temp/opencode/recov/final';
fs.mkdirSync(outdir, { recursive: true });

function stripRead(content) {
  // Remove the XML header lines and strip "N: " prefixes
  const lines = String(content).split('\n');
  const start = lines.findIndex(l => l.trim() === '<content>');
  if (start === -1) return null;
  const body = lines.slice(start + 1);
  const out = [];
  for (const l of body) {
    const m = /^(\d+): (.*)$/.exec(l);
    if (m) out.push(m[2]);
    else out.push(l); // continuation / blank
  }
  return out.join('\n');
}

// Group events by file, in chronological order
const eventsByFile = new Map();
let seq = 0;
for (const p of parts) {
  let d; try { d = JSON.parse(p.data); } catch (e) { continue; }
  if (d.type !== 'tool') continue;
  const input = d.state && d.state.input;
  if (!input) continue;
  const f = input.filePath || '';
  if (!f || !f.startsWith(PROJ)) continue;
  const rel = f.slice(PROJ.length).replace(/\\/g, '/');
  const ev = { seq: seq++, tool: d.tool };
  if (d.tool === 'read') {
    const out = d.state.output ? String(d.state.output) : '';
    ev.content = stripRead(out);
    ev.offset = input.offset || 1;
    ev.limit = input.limit || 0;
  } else if (d.tool === 'edit') {
    ev.oldString = input.oldString || '';
    ev.newString = input.newString || '';
  } else if (d.tool === 'write') {
    ev.content = input.content || '';
  }
  if (d.tool === 'read' && !ev.content) continue;
  if (d.tool === 'edit' && !ev.oldString) continue;
  const list = eventsByFile.get(rel) || [];
  list.push(ev);
  eventsByFile.set(rel, list);
}

const report = [];
for (const [rel, evs] of eventsByFile) {
  let current = null;
  let errors = [];
  let ops = [];
  for (const ev of evs) {
    if (ev.tool === 'read' && ev.offset === 1) {
      current = ev.content;
      ops.push('read(base)');
    } else if (ev.tool === 'read') {
      ops.push(`read(offset=${ev.offset})`); // partial, ignore
    } else if (ev.tool === 'write') {
      current = ev.content;
      ops.push('write(replace)');
    } else if (ev.tool === 'edit') {
      if (current === null) { errors.push('edit before any base'); continue; }
      const idx = current.indexOf(ev.oldString);
      if (idx === -1) {
        errors.push(`oldString not found (len=${ev.oldString.length}, head=${ev.oldString.slice(0, 40).replace(/\n/g,'\\n')})`);
        continue;
      }
      current = current.slice(0, idx) + ev.newString + current.slice(idx + ev.oldString.length);
      ops.push('edit');
    }
  }
  if (current !== null) {
    const fn = path.join(outdir, rel.split('/').join('__'));
    fs.mkdirSync(path.dirname(fn), { recursive: true });
    fs.writeFileSync(fn, current);
    report.push({ rel, bytes: current.length, ops: ops.join(','), errors });
  } else {
    report.push({ rel, bytes: -1, ops: ops.join(','), errors: errors.concat(['no base']) });
  }
}

for (const r of report) {
  console.log(`${String(r.bytes).padStart(7)}  ${r.rel}  [${r.ops}]`);
  for (const e of r.errors) console.log(`      !! ${e}`);
}
console.log('\nWrote to', outdir);