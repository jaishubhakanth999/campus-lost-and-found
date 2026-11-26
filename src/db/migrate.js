'use strict';

/**
 * Minimal forward-only migration runner.
 *
 * Each file in db/migrations is applied once, in filename order, inside its own
 * transaction, and recorded in schema_migrations. Running it twice is safe.
 */

const fs = require('node:fs');
const path = require('node:path');
const { getPool, close } = require('./pool');

const MIGRATIONS_DIR = path.join(__dirname, '..', '..', 'db', 'migrations');

async function ensureTable(client) {
  await client.query(`
    create table if not exists schema_migrations (
      name       text primary key,
      applied_at timestamptz not null default now()
    )
  `);
}

async function migrate({ silent = false } = {}) {
  const files = fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort();

  const client = await getPool().connect();
  const applied = [];
  try {
    await ensureTable(client);
    const { rows } = await client.query('select name from schema_migrations');
    const done = new Set(rows.map((r) => r.name));

    for (const file of files) {
      if (done.has(file)) continue;
      const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8');
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('insert into schema_migrations (name) values ($1)', [file]);
        await client.query('COMMIT');
        applied.push(file);
        if (!silent) console.log(`[migrate] applied ${file}`);
      } catch (err) {
        await client.query('ROLLBACK');
        throw new Error(`Migration ${file} failed: ${err.message}`);
      }
    }
    if (!silent) {
      console.log(
        applied.length ? `[migrate] ${applied.length} migration(s) applied` : '[migrate] up to date'
      );
    }
    return applied;
  } finally {
    client.release();
  }
}

module.exports = { migrate, MIGRATIONS_DIR };

if (require.main === module) {
  migrate()
    .then(() => close())
    .then(() => process.exit(0))
    .catch((err) => {
      console.error(err.message);
      process.exit(1);
    });
}
