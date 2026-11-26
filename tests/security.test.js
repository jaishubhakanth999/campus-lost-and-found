'use strict';

/**
 * Cross-cutting security checks: token handling, headers, CORS, file access.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const jwt = require('jsonwebtoken');
const { startDb, stopDb, loadApp, request } = require('./helpers/db');
const { registerAndVerify } = require('./helpers/factory');

let app;
let user;

test.before(async () => {
  await startDb();
  app = loadApp();
  user = await registerAndVerify(app, { email: 'sec@saiuniversity.edu.in' });
});
test.after(async () => {
  await stopDb();
});

test('security headers are present on API responses', async () => {
  const res = await request(app).get('/api/health');
  assert.match(res.headers['content-security-policy'] || '', /default-src 'self'/);
  assert.equal(res.headers['x-content-type-options'], 'nosniff');
  assert.equal(res.headers['x-frame-options'], 'SAMEORIGIN');
  assert.equal(res.headers['x-powered-by'], undefined);
});

test('a tampered token is rejected', async () => {
  const parts = user.token.split('.');
  const forged = `${parts[0]}.${parts[1]}.${'a'.repeat(43)}`;
  const res = await request(app).get('/api/auth/me').set('Authorization', `Bearer ${forged}`);
  assert.equal(res.status, 401);
});

test('an unsigned (alg:none) token is rejected', async () => {
  const forged = jwt.sign({ sub: user.user.id, sid: 'x', role: 'admin' }, '', { algorithm: 'none' });
  const res = await request(app).get('/api/admin/overview').set('Authorization', `Bearer ${forged}`);
  assert.equal(res.status, 401);
});

test('a token signed with the wrong secret is rejected', async () => {
  const forged = jwt.sign({ sub: user.user.id, sid: 'x', role: 'admin' }, 'not-the-real-secret-but-long-enough-123', {
    algorithm: 'HS256',
    issuer: 'campusconnect',
  });
  const res = await request(app).get('/api/auth/me').set('Authorization', `Bearer ${forged}`);
  assert.equal(res.status, 401);
});

test('a token whose session was deleted stops working', async () => {
  const fresh = await registerAndVerify(app, { email: 'sec2@saiuniversity.edu.in' });
  const { query } = require('../src/db/pool');
  await query(`delete from user_sessions where user_id = $1`, [fresh.user.id]);

  const res = await request(app).get('/api/auth/me').set('Authorization', `Bearer ${fresh.token}`);
  assert.equal(res.status, 401);
});

test('private files are not served without a session', async () => {
  const res = await request(app).get('/api/files/private/private/2026/01/whatever.webp');
  assert.equal(res.status, 401);
});

test('path traversal in the private file route is blocked', async () => {
  const res = await request(app)
    .get('/api/files/private/../../.env')
    .set('Authorization', `Bearer ${user.token}`);
  assert.ok([400, 401, 403, 404].includes(res.status));
});

test('no CORS header is emitted for an unlisted origin', async () => {
  const res = await request(app)
    .get('/api/health')
    .set('Origin', 'https://evil.example.com');
  assert.equal(res.headers['access-control-allow-origin'], undefined);
});

test('unknown routes return a JSON 404, not a stack trace', async () => {
  const res = await request(app).get('/api/does-not-exist');
  assert.equal(res.status, 404);
  assert.equal(res.body.error.code, 'not_found');
});

test('error responses never include stack traces or SQL', async () => {
  const res = await request(app).get('/api/items/00000000-0000-0000-0000-000000000000');
  assert.equal(res.status, 404);
  const body = JSON.stringify(res.body);
  assert.doesNotMatch(body, /at Object|node_modules|select |insert /i);
});

test('an XSS payload in a listing is stored but the API returns it as data', async () => {
  const { createItem } = require('./helpers/factory');
  const payload = '<img src=x onerror=alert(1)>';
  const res = await createItem(app, user.token, { title: `Test ${payload}` });
  assert.equal(res.status, 201);
  // The API returns JSON (never HTML), and the browser client escapes on render.
  assert.equal(res.headers['content-type'].split(';')[0], 'application/json');
  assert.ok(res.body.item.title.includes('<img'));
});

test('oversized JSON bodies are rejected', async () => {
  const big = { name: 'x'.repeat(2 * 1024 * 1024), email: 'big@saiuniversity.edu.in', password: 'Campus123' };
  const res = await request(app).post('/api/auth/register').send(big);
  assert.equal(res.status, 413);
});

test('the health endpoint does not leak configuration', async () => {
  const res = await request(app).get('/api/health');
  const body = JSON.stringify(res.body);
  assert.doesNotMatch(body, /postgres:\/\/|password|secret|pepper/i);
});
