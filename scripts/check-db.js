#!/usr/bin/env node
'use strict';

/**
 * Finds the Supabase pooler host that actually serves your project.
 *
 * The pooler identifies a tenant by the host you connect to, so the wrong
 * cluster answers "(ENOTFOUND) tenant/user postgres.<ref> not found" even when
 * the project ref is correct. This tries the candidates and reports which one
 * accepts your credentials.
 *
 *   node scripts/check-db.js 'postgresql://postgres.<ref>:<password>@<host>:5432/postgres'
 *   DATABASE_URL='...' node scripts/check-db.js
 *
 * Nothing is written anywhere; the password is only used to open the connection.
 */

const { Client } = require('pg');

function parse(url) {
  const u = new URL(url);
  const ref = (u.username.split('.')[1] || '').trim();
  const region = (u.hostname.match(/-([a-z]{2}-[a-z]+-\d)\.pooler\./) || [])[1] || 'ap-south-1';
  return { ref, region, password: decodeURIComponent(u.password), database: u.pathname.slice(1) || 'postgres' };
}

async function tryOne(host, port, { ref, password, database }) {
  const user = ref ? `postgres.${ref}` : 'postgres';
  // A local Postgres speaks no TLS; Supabase always requires it.
  const isLocal = /^(127\.0\.0\.1|localhost|::1)$/.test(host);
  const client = new Client({
    host, port, user, password, database,
    ssl: isLocal ? false : { rejectUnauthorized: false },
    connectionTimeoutMillis: 8000,
    statement_timeout: 8000,
  });
  const started = Date.now();
  try {
    await client.connect();
    const r = await client.query('select current_database() as db, version() as v');
    const ms = Date.now() - started;
    return { ok: true, ms, detail: `${r.rows[0].db} · ${String(r.rows[0].v).split(' ').slice(0, 2).join(' ')}` };
  } catch (err) {
    return { ok: false, error: String(err.message || err).split('\n')[0] };
  } finally {
    await client.end().catch(() => {});
  }
}

(async () => {
  const url = process.argv[2] || process.env.DATABASE_URL;
  if (!url) {
    console.error('Usage: node scripts/check-db.js <DATABASE_URL>');
    process.exit(1);
  }

  const parsed = parse(url);
  if (!parsed.ref) {
    console.error('That URL has no project ref in the user name (expected postgres.<ref>).');
    process.exit(1);
  }

  console.log(`project ref : ${parsed.ref}`);
  console.log(`region      : ${parsed.region}`);
  console.log(`password    : ${parsed.password ? 'present (' + parsed.password.length + ' chars)' : 'MISSING'}`);
  console.log('');

  // The URL you passed is tried first, so a working local or direct connection
  // is reported too — and so the success path is testable without Supabase.
  const candidates = [{ host: new URL(url).hostname, port: Number(new URL(url).port) || 5432 }];
  for (const cluster of ['aws-1', 'aws-0']) {
    for (const port of [5432, 6543]) {
      candidates.push({ host: `${cluster}-${parsed.region}.pooler.supabase.com`, port });
    }
  }
  // the direct host last: it is IPv6-only on new projects, but worth reporting
  if (!candidates.some((c) => c.host === `db.${parsed.ref}.supabase.co`)) {
    candidates.push({ host: `db.${parsed.ref}.supabase.co`, port: 5432 });
  }

  let winner = null;
  for (const c of candidates) {
    process.stdout.write(`${c.host}:${c.port}`.padEnd(52) + ' ');
    const res = await tryOne(c.host, c.port, parsed);
    if (res.ok) {
      console.log(`✓ connected in ${res.ms} ms  (${res.detail})`);
      if (!winner) winner = c;
    } else {
      console.log(`✗ ${res.error}`);
    }
  }

  console.log('');
  if (!winner) {
    console.log('None of them worked.');
    console.log('· "tenant/user not found" on every host → the ref is wrong, or the project is paused.');
    console.log('· "password authentication failed" → the password is wrong (reset it in Settings → Database).');
    process.exit(1);
  }

  const port = winner.port === 6543 ? '6543 (transaction pooler)' : '5432 (session pooler)';
  console.log('USE THIS AS DATABASE_URL:');
  console.log(
    `postgresql://postgres.${parsed.ref}:<PASSWORD>@${winner.host}:${winner.port}/${parsed.database}`
  );
  console.log(`port ${port}`);
})().catch((e) => {
  console.error('probe failed:', e.message);
  process.exit(1);
});
