'use strict';

/**
 * Supabase Storage client: what it actually sends over the wire.
 *
 * Supabase replaced the legacy service_role JWT with `sb_secret_…` API keys,
 * which are read from the `apikey` header. This asserts every storage call
 * carries both `apikey` and `Authorization`, so either key format works — and it
 * fails loudly if someone drops one while refactoring.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

// Config is read on first use, so set the environment before requiring anything.
Object.assign(process.env, {
  NODE_ENV: 'test',
  APP_URL: 'https://campusconnect.test',
  DATABASE_URL: 'postgres://unused@127.0.0.1:5432/unused',
  DATABASE_SSL: 'false',
  JWT_SECRET: 'x'.repeat(48),
  OTP_PEPPER: 'y'.repeat(48),
  ALLOWED_EMAIL_DOMAINS: 'saiuniversity.edu.in',
  MAIL_TRANSPORT: 'capture',
  STORAGE_DRIVER: 'supabase',
  SUPABASE_URL: 'https://exampleproject.supabase.co',
  SUPABASE_SERVICE_ROLE_KEY: 'sb_secret_TESTKEY_abcdefghijklmnop',
  SUPABASE_BUCKET_PUBLIC: 'item-images',
  SUPABASE_BUCKET_PRIVATE: 'claim-evidence',
  LOG_LEVEL: 'silent',
});

const calls = [];
global.fetch = async (url, options = {}) => {
  calls.push({ url: String(url), method: options.method || 'GET', headers: options.headers || {} });
  return {
    ok: true,
    status: 200,
    text: async () => '',
    json: async () => ({ signedURL: '/object/sign/item-images/a.webp?token=abc' }),
  };
};

const storage = require('../src/services/storage');

const image = {
  buffer: Buffer.from('fake-bytes'),
  mime: 'image/webp',
  ext: 'webp',
  width: 10,
  height: 10,
  bytes: 10,
};

test.beforeEach(() => {
  calls.length = 0;
});

test('an upload sends both apikey and Authorization', async () => {
  const saved = await storage.saveImage({ ...image, visibility: 'public' });
  assert.ok(saved.key, 'returns the stored key');

  const put = calls.find((c) => c.method === 'POST');
  assert.ok(put, 'a POST was made');
  assert.equal(put.headers.apikey, 'sb_secret_TESTKEY_abcdefghijklmnop', 'apikey carries the new secret key');
  assert.equal(put.headers.Authorization, 'Bearer sb_secret_TESTKEY_abcdefghijklmnop');
  assert.match(put.url, /\/storage\/v1\/object\/item-images\//);
  assert.equal(put.headers['x-upsert'], 'false');
});

test('private evidence goes to the private bucket', async () => {
  await storage.saveImage({ ...image, visibility: 'private' });
  const put = calls.find((c) => c.method === 'POST');
  assert.match(put.url, /\/storage\/v1\/object\/claim-evidence\//);
});

test('a signed URL request authenticates the same way', async () => {
  const link = await storage.signedUrl('private/2026/11/abc.webp', 300);
  assert.ok(link, 'returns a link');
  const call = calls.find((c) => c.url.includes('/object/sign/'));
  assert.ok(call, 'called the sign endpoint');
  assert.equal(call.headers.apikey, 'sb_secret_TESTKEY_abcdefghijklmnop');
  assert.equal(call.headers.Authorization, 'Bearer sb_secret_TESTKEY_abcdefghijklmnop');
});

test('deleting an object authenticates the same way', async () => {
  await storage.deleteImage('public/2026/11/abc.webp');
  const call = calls.find((c) => c.method === 'DELETE');
  assert.ok(call, 'a DELETE was made');
  assert.equal(call.headers.apikey, 'sb_secret_TESTKEY_abcdefghijklmnop');
  assert.equal(call.headers.Authorization, 'Bearer sb_secret_TESTKEY_abcdefghijklmnop');
});
