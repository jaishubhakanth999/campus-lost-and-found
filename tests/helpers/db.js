'use strict';

/**
 * Test harness: a real PostgreSQL server (PGlite, PostgreSQL 19 compiled to
 * WASM) exposed over TCP so the production `pg` pool talks to it exactly as it
 * would talk to Supabase. Every SQL statement, constraint, trigger and index in
 * db/migrations is therefore genuinely executed by these tests.
 */

const net = require('node:net');

process.env.NODE_ENV = 'test';
process.env.APP_URL = 'https://campusconnect.test';
process.env.JWT_SECRET = 'test-jwt-secret-that-is-long-enough-1234';
process.env.OTP_PEPPER = 'test-otp-pepper-that-is-long-enough-1234';
process.env.ALLOWED_EMAIL_DOMAINS = 'saiuniversity.edu.in';
process.env.MAIL_TRANSPORT = 'capture';
process.env.STORAGE_DRIVER = 'local';
process.env.LOCAL_UPLOAD_DIR = 'tmp/test-uploads';
process.env.DATABASE_SSL = 'false';
process.env.DATABASE_POOL_MAX = '1'; // the in-memory test server serialises connections
process.env.LOG_LEVEL = 'silent';
process.env.BCRYPT_ROUNDS = '4'; // keeps the suite fast; production uses 12
process.env.RATE_LIMIT_MAX = '100000';
process.env.RATE_LIMIT_AUTH_MAX = '100000';
process.env.RATE_LIMIT_OTP_MAX = '100000';
process.env.RATE_LIMIT_WRITE_MAX = '100000';
process.env.OTP_RESEND_COOLDOWN_SECONDS = '0';
process.env.MAX_UPLOAD_MB = '2';

const { PGlite } = require('@electric-sql/pglite');
const { PGLiteSocketServer } = require('@electric-sql/pglite-socket');

let server;
let db;
let port;

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const p = s.address().port;
      s.close(() => resolve(p));
    });
  });
}

async function startDb() {
  db = await PGlite.create();
  for (let attempt = 0; attempt < 5; attempt += 1) {
    port = await freePort();
    server = new PGLiteSocketServer({ db, port, host: '127.0.0.1', debug: false });
    try {
      await server.start();
      break;
    } catch (err) {
      if (attempt === 4) throw err;
    }
  }
  process.env.DATABASE_URL = `postgres://postgres@127.0.0.1:${port}/postgres`;
  const { migrate } = require('../../src/db/migrate');
  await migrate({ silent: true });
  return { port };
}

async function stopDb() {
  const { close } = require('../../src/db/pool');
  try {
    await close();
  } catch {
    /* ignore */
  }
  if (server) await server.stop();
  if (db) await db.close();
}

/** Loads the app *after* the environment is configured. */
function loadApp() {
  const { createApp } = require('../../src/app');
  return createApp();
}

const request = require('supertest');

module.exports = { startDb, stopDb, loadApp, request };
