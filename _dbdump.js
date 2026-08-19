const { DatabaseSync } = require('node:sqlite');
const db = new DatabaseSync('C:/Users/SOKCHHORN PC/.local/share/opencode/opencode.db');
const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all();
console.log('TABLES:', tables.map(r => r.name).join(', '));
for (const t of tables) {
  try {
    const cols = db.prepare(`PRAGMA table_info(${t.name})`).all().map(c => c.name);
    console.log(`\n=== ${t.name} (${cols.join(',')}) ===`);
  } catch (e) { console.log(t.name, 'ERR', e.message); }
}