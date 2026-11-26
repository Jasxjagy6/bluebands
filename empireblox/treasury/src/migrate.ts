import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { pool, tx } from './db.js';

const sqlDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'sql');
try {
  await tx(async c => {
    await c.query("select pg_advisory_xact_lock(hashtext('empireblox migrations'))");
    await c.query('create table if not exists schema_migrations(name text primary key, applied_at timestamptz not null default now())');
    for (const file of readdirSync(sqlDir).filter(f => f.endsWith('.sql')).sort()) {
      if ((await c.query('select 1 from schema_migrations where name=$1',[file])).rowCount) continue;
      await c.query(readFileSync(join(sqlDir,file),'utf8'));
      await c.query('insert into schema_migrations(name) values($1)',[file]);
      console.log('Applied',file);
    }
  });
} finally { await pool.end(); }
