'use strict';

/** Small helpers that drive the real HTTP API, not the services directly. */

const assert = require('node:assert');
const sharp = require('sharp');
const { request } = require('./db');
const mailer = require('../../src/services/mailer');
const { query } = require('../../src/db/pool');

function extractOtp(email) {
  const mail = mailer.lastCapturedTo(email);
  if (!mail) throw new Error(`no email captured for ${email}`);
  const match = mail.html.match(/>(\d{6})</);
  if (!match) throw new Error('no 6-digit code found in the email');
  return match[1];
}

function lastMail(email) {
  return mailer.lastCapturedTo(email);
}

async function registerAndVerify(app, { name = 'Test Student', email, password = 'Campus123' }) {
  const reg = await request(app).post('/api/auth/register').send({ name, email, password });
  assert.strictEqual(reg.status, 201, `register failed: ${JSON.stringify(reg.body)}`);
  const code = extractOtp(email);
  const verify = await request(app)
    .post('/api/auth/verify-otp')
    .send({ email, code, purpose: 'signup' });
  assert.strictEqual(verify.status, 200, `verify failed: ${JSON.stringify(verify.body)}`);
  return { token: verify.body.token, user: verify.body.user, password, code };
}

async function loginAndVerify(app, { email, password = 'Campus123', portal = 'student' }) {
  const path = portal === 'admin' ? '/api/auth/admin/login' : '/api/auth/login';
  const login = await request(app).post(path).send({ email, password, portal });
  assert.strictEqual(login.status, 200, `login failed: ${JSON.stringify(login.body)}`);
  const code = extractOtp(email);
  const verify = await request(app)
    .post('/api/auth/verify-otp')
    .send({ email, code, purpose: login.body.purpose });
  assert.strictEqual(verify.status, 200, `otp verify failed: ${JSON.stringify(verify.body)}`);
  return { token: verify.body.token, user: verify.body.user, session: verify.body.session };
}

const bcrypt = require('bcryptjs');

/** Creates an administrator directly in the database (no public route exists). */
async function createAdmin(app, { name = 'Portal Admin', email = 'admin@saiuniversity.edu.in', password = 'AdminPass123' } = {}) {
  const hash = await bcrypt.hash(password, 10);
  await query(
    `insert into users (name, email, password_hash, role, is_email_verified, email_verified_at)
     values ($1,$2,$3,'admin',true, now())
     on conflict (lower(email)) do update set role = 'admin', is_email_verified = true, password_hash = excluded.password_hash`,
    [name, email, hash]
  );
  return loginAndVerify(app, { email, password, portal: 'admin' });
}

async function pngBuffer(width = 24, height = 18) {
  return sharp({
    create: { width, height, channels: 3, background: { r: 35, g: 107, b: 80 } },
  })
    .png()
    .toBuffer();
}

function itemPayload(overrides = {}) {
  return {
    type: 'lost',
    title: 'Black leather wallet',
    category: 'Accessories',
    description: 'Black leather wallet with a blue sticker on the back and a library card inside.',
    location: 'Central Library',
    occurredOn: '2026-11-20',
    occurredTime: '14:30',
    additionalInfo: 'Reward offered',
    ...overrides,
  };
}

/** Multipart create, as the browser does it. */
async function createItem(app, token, overrides = {}, { image = true, imageBuffer = null } = {}) {
  const payload = itemPayload(overrides);
  let req = request(app).post('/api/items').set('Authorization', `Bearer ${token}`);
  for (const [key, value] of Object.entries(payload)) {
    if (value !== undefined) req = req.field(key, String(value));
  }
  if (image) req = req.attach('images', imageBuffer || (await pngBuffer()), 'photo.png');
  return req;
}

module.exports = {
  extractOtp,
  lastMail,
  registerAndVerify,
  loginAndVerify,
  createAdmin,
  pngBuffer,
  itemPayload,
  createItem,
};
