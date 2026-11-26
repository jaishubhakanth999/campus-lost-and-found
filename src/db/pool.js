'use strict';

/**
 * PostgreSQL access layer (Supabase compatible).
 *
 * Why `pg` and not the Supabase JS client: every write in this app happens on
 * the server, and the claim workflow needs real multi-statement transactions.
 * A direct Postgres connection gives us both, and works identically against
 * Supabase's pooler, a local Postgres or the in-memory test server.
 */

const { Pool } = require('pg');
const { getConfig } = require('../config/env');

let pool;

function createPool(overrides = {}) {
  const cfg = getConfig();
  return new Pool({
    connectionString: overrides.connectionString || cfg.DATABASE_URL,
    max: overrides.max || cfg.DATABASE_POOL_MAX,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
    ssl: (overrides.ssl ?? cfg.DATABASE_SSL) ? { rejectUnauthorized: false } : undefined,
    application_name: 'campusconnect',
  });
}

function getPool() {
  if (!pool) {
    pool = createPool();
    pool.on('error', (err) => {
      // A dead idle client must never crash the process.
      console.error('[db] idle client error:', err.message);
    });
  }
  return pool;
}

async function query(text, params) {
  const started = Date.now();
  const result = await getPool().query(text, params);
  const ms = Date.now() - started;
  if (ms > 500 && process.env.LOG_LEVEL !== 'silent') {
    console.warn(`[db] slow query ${ms}ms: ${text.replace(/\s+/g, ' ').slice(0, 120)}`);
  }
  return result;
}

/** Run `fn(client)` inside a transaction, rolling back on any throw. */
async function withTransaction(fn) {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch {
      /* connection already broken */
    }
    throw err;
  } finally {
    client.release();
  }
}

async function health() {
  const started = Date.now();
  const { rows } = await query('select 1 as ok');
  return { ok: rows[0].ok === 1, latencyMs: Date.now() - started };
}

async function close() {
  if (pool) {
    await pool.end();
    pool = undefined;
  }
}

/** Test helper: point the module at another database. */
function _setPool(p) {
  pool = p;
}

module.exports = { getPool, createPool, query, withTransaction, health, close, _setPool };
