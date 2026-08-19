const { DatabaseSync } = require('node:sqlite');
const db = new DatabaseSync('C:/Users/SOKCHHORN PC/.local/share/opencode/opencode.db');
const sessions = db.prepare("SELECT id, slug, title, time_created FROM session ORDER BY time_created DESC LIMIT 10").all();
console.log('SESSIONS:');
for (const s of sessions) console.log(s.id, '|', s.slug, '|', s.title, '|', new Date(s.time_created).toISOString());
console.log('\n=== project dirs ===');
const pd = db.prepare("SELECT * FROM project_directory").all();
for (const p of pd) console.log(JSON.stringify(p));