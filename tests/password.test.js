'use strict';

/**
 * Password policy: the scoring function, the server rules that use it, and the
 * browser copy that drives the meter. The parity test is the important one — it
 * makes it impossible for the meter to promise something the API refuses.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { JSDOM } = require('jsdom');
const { strength, meetsPolicy } = require('../src/lib/passwordStrength');
const { startDb, stopDb, loadApp, request } = require('./helpers/db');
const { registerAndVerify } = require('./helpers/factory');

/* ------------------------------ the scorer ------------------------------- */

const TABLE = [
  ['password', 0, 'a common word'],
  ['password123', 0, 'a common word with digits appended'],
  ['12345678', 0, 'digits only'],
  ['aaaaaaaa', 0, 'one repeated character'],
  ['qwertyuiop', 0, 'a keyboard run'],
  ['letmein!2024', 0, 'common word plus a year'],
  ['CampusLife#2026', 0, 'contains the campus name with a 3-digit tail'],
  ['abc123xyz', 1, 'short, contains a common base'],
  ['CampusLife#2026', 2, 'long, mixed, but contains a common word'],
  ['Kanth@123', 3, 'nine characters, three classes, no pattern'],
  ['vzpzh5g3?+8s66L*b&bd', 4, '20 random characters'],
  ['correct horse battery staple', 4, 'a long passphrase'],
];

test('the scorer rates weak, fair, strong and very strong correctly', () => {
  for (const [pw, expected, why] of TABLE) {
    const result = strength(pw);
    assert.equal(result.score, expected, `${pw} (${why}) should score ${expected}, got ${result.score} (${result.label})`);
    assert.ok(result.label, 'every score has a label');
    if (result.score < 4) assert.ok(result.hints.length > 0, `${pw} should come with advice`);
  }
});

test('everything a student would try first is refused', () => {
  for (const pw of ['password', 'password123', 'qwerty123', 'aaaaaaaa', '12345678',
                    'letmein!2024', 'CampusLife#2026', 'abc123xyz', 'iloveyou123']) {
    assert.equal(meetsPolicy(pw, 'student').ok, false, `"${pw}" must be refused`);
  }
  // and the same list is refused for an administrator
  for (const pw of ['password', 'CampusLife#2026', 'abc123xyz']) {
    assert.equal(meetsPolicy(pw, 'admin').ok, false, `"${pw}" must be refused for admins`);
  }
});

test('the policy floor is 2 for students and 3 for administrators', () => {
  assert.equal(meetsPolicy('CampusLife#2026', 'student').ok, true);
  assert.equal(meetsPolicy('CampusLife#2026', 'admin').ok, false, 'admins need more');

  // length floors as well as score floors
  assert.equal(meetsPolicy('Ab1!efg', 'student').ok, false, '7 characters is below the floor');
  assert.equal(meetsPolicy('Ab1!efgh', 'student').ok, true, '8 characters with four classes clears it');
  assert.equal(meetsPolicy('Ab1!efghijkl', 'admin').ok, true, '12 characters, four classes');

  const message = meetsPolicy('password', 'student').message;
  assert.match(message, /too easy to guess/i);
  assert.match(message, /at least 8 characters|Longer is stronger|common word|Mix/i, 'the message says what to change');
});

/* ------------------------------- parity --------------------------------- */

function browserScorer() {
  // Load the real browser file and pull its scoring function out of the IIFE.
  const source = fs.readFileSync(path.join(__dirname, '..', 'public', 'assets', 'api.js'), 'utf8');
  const dom = new JSDOM('<!doctype html><html><body></body></html>', { runScripts: 'outside-only' });
  dom.window.CAMPUS_CONFIG = { apiBase: '' };
  dom.window.fetch = async () => ({ ok: true, status: 200, headers: { get: () => 'application/json' }, json: async () => ({}) });
  dom.window.eval(source);
  return Object.assign(dom.window.CC.passwordStrength, { policy: dom.window.CC.passwordPolicy });
}

test('the browser meter and the server agree on accept/reject, not just the score', () => {
  const client = browserScorer();
  const samples = ['password', 'CampusLife#2026', 'Kanth@123', 'Ab1!efg', 'Ab1!efgh', 'Ab1!efghijkl',
    'CampusLife#2026', 'vzpzh5g3?+8s66L*b&bd', 'AdminPass1234', 'correct horse battery staple'];
  for (const pw of samples) {
    for (const role of ['student', 'admin']) {
      const server = meetsPolicy(pw, role).ok;
      const browser = client.policy(pw, role).ok;
      assert.equal(browser, server, `"${pw}" as ${role}: browser says ${browser}, server says ${server}`);
    }
  }
});

test('the browser meter and the server use the same scoring', () => {
  const client = browserScorer();
  const samples = [
    ...TABLE.map(([pw]) => pw),
    'CampusLife#2026!', 'Aaaaaaaa1', 'sunshine2019', 'my-dog-is-named-biscuit',
    'Tr0ub4dor&3', 'xyz', '', '        ', 'Passw0rd!Passw0rd!', 'abcdefghijklmnop',
  ];
  for (const pw of samples) {
    const server = strength(pw);
    const browser = client(pw);
    assert.equal(browser.score, server.score, `score mismatch for "${pw}" (browser ${browser.score}, server ${server.score})`);
    assert.equal(browser.label, server.label, `label mismatch for "${pw}"`);
  }
});

/* --------------------------- the API enforces it ------------------------- */

let app;

test.before(async () => {
  await startDb();
  app = loadApp();
});
test.after(async () => {
  await stopDb();
});

test('registration refuses a weak password with a useful message', async () => {
  const res = await request(app)
    .post('/api/auth/register')
    .send({ name: 'Weak One', email: 'weak@saiuniversity.edu.in', password: 'password123' });
  assert.equal(res.status, 400);
  assert.ok(res.body.error.fields.password, 'the error points at the password field');
  assert.match(res.body.error.fields.password, /too easy to guess/i);
});

test('registration accepts a password that clears the floor', async () => {
  const res = await request(app)
    .post('/api/auth/register')
    .send({ name: 'Strong One', email: 'strong@saiuniversity.edu.in', password: 'CampusLife#2026' });
  assert.equal(res.status, 201, JSON.stringify(res.body));
});

test('changing a password applies the account role floor', async () => {
  const student = await registerAndVerify(app, { email: 'pw-student@saiuniversity.edu.in', password: 'CampusLife#2026' });

  // clears the student floor but not the administrator one
  const tooWeakForAdmin = 'Kanth@123';
  const asStudent = await request(app)
    .post('/api/auth/change-password')
    .set('Authorization', `Bearer ${student.token}`)
    .send({ currentPassword: 'CampusLife#2026', newPassword: tooWeakForAdmin });
  assert.equal(asStudent.status, 200, 'a student may use a 9-character password');

  const stillWeak = await request(app)
    .post('/api/auth/change-password')
    .set('Authorization', `Bearer ${student.token}`)
    .send({ currentPassword: tooWeakForAdmin, newPassword: 'password123' });
  assert.equal(stillWeak.status, 400, 'the floor is enforced on change too');
});

test('the reset endpoint enforces the same floor', async () => {
  const weak = await request(app)
    .post('/api/auth/reset-password')
    .send({ token: 'a'.repeat(64), password: 'password123' });
  // 400 either because the token is unknown or because the password is weak —
  // both are 400, so assert on the field-level message instead.
  assert.equal(weak.status, 400);
  assert.ok(weak.body.error.fields && weak.body.error.fields.password, 'the password is validated before the token is looked up');
});
