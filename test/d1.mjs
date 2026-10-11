// A small D1 stand-in over node:sqlite, enough to run the Worker locally.
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
export function makeD1(migrationsDir) {
  const db = new DatabaseSync(':memory:');
  for (const f of fs.readdirSync(migrationsDir).sort()) db.exec(fs.readFileSync(migrationsDir + '/' + f, 'utf8'));
  const norm = v => (v === undefined ? null : typeof v === 'boolean' ? (v ? 1 : 0) : v);
  function stmt(sql, params = []) {
    return {
      sql, params,
      bind: (...p) => stmt(sql, p.map(norm)),
      first: async () => { const r = db.prepare(sql).get(...params); return r ? { ...r } : null; },
      all: async () => ({ results: db.prepare(sql).all(...params).map(r => ({ ...r })) }),
      run: async () => { const r = db.prepare(sql).run(...params); return { meta: { changes: r.changes } }; },
    };
  }
  return {
    raw: db,
    prepare: sql => stmt(sql),
    batch: async stmts => { db.exec('BEGIN'); try { const out = stmts.map(s => db.prepare(s.sql).run(...s.params)); db.exec('COMMIT'); return out; } catch (e) { db.exec('ROLLBACK'); throw e; } },
  };
}
