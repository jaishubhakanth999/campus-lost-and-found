'use strict';

/**
 * Rule 1 + Rule 10 — university email validation, OTP lifecycle, login gating.
 * Every assertion below hits the real HTTP API against real PostgreSQL.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { startDb, stopDb, loadApp, request } = require('./helpers/db');
const {
  extractOtp,
  registerAndVerify,
  loginAndVerify,
  createAdmin,
  lastMail,
} = require('./helpers/factory');
const { query } = require('../src/db/pool');
const mailer = require('../src/services/mailer');

let app;
test.before(async () => {
  await startDb();
  app = loadApp();
});
test.after(async () => {
  await stopDb();
});
test.beforeEach(() => mailer.clearCaptured());

test('health endpoint reports the database', async () => {
  const res = await request(app).get('/api/health');
  assert.equal(res.status, 200);
  assert.equal(res.body.ok, true);
  assert.equal(res.body.database.connected, true);
});

test('registration accepts a university email and issues an OTP, not a token', async () => {
  const res = await request(app)
    .post('/api/auth/register')
    .send({ name: 'Asha Rao', email: 'asha@saiuniversity.edu.in', password: 'Campus123' });

  assert.equal(res.status, 201);
  assert.equal(res.body.otpRequired, true);
  assert.equal(res.body.purpose, 'signup');
  assert.equal(res.body.token, undefined, 'no JWT may be issued before verification');

  const mail = lastMail('asha@saiuniversity.edu.in');
  assert.ok(mail, 'an OTP email must be sent');
  assert.match(mail.subject, /\d{6}/);
  assert.match(mail.html, /CampusConnect/);
  assert.match(mail.html, /https:\/\/campusconnect\.test\/auth\.html/, 'CTA must be an absolute https link');
});

test('registration accepts a sub-domain of an approved university domain', async () => {
  const res = await request(app)
    .post('/api/auth/register')
    .send({ name: 'Dept Student', email: 'student@scds.saiuniversity.edu.in', password: 'Campus123' });
  assert.equal(res.status, 201);
});

test('registration rejects a non-university email domain', async () => {
  const res = await request(app)
    .post('/api/auth/register')
    .send({ name: 'Outsider', email: 'someone@gmail.com', password: 'Campus123' });
  assert.equal(res.status, 403);
  assert.match(res.body.error.message, /university email/i);
  assert.equal(lastMail('someone@gmail.com'), undefined);
});

test('registration rejects a malformed email address', async () => {
  const res = await request(app)
    .post('/api/auth/register')
    .send({ name: 'Bad Email', email: 'not-an-email', password: 'Campus123' });
  assert.equal(res.status, 400);
  assert.equal(res.body.error.code, 'validation_failed');
  assert.ok(res.body.error.fields.email);
});

test('registration rejects a weak password', async () => {
  const res = await request(app)
    .post('/api/auth/register')
    .send({ name: 'Weak Pass', email: 'weak@saiuniversity.edu.in', password: 'password' });
  assert.equal(res.status, 400);
  assert.ok(res.body.error.fields.password);
});

test('a verified email cannot register twice', async () => {
  await registerAndVerify(app, { email: 'dup@saiuniversity.edu.in' });
  const res = await request(app)
    .post('/api/auth/register')
    .send({ name: 'Dup', email: 'dup@saiuniversity.edu.in', password: 'Campus123' });
  assert.equal(res.status, 409);
});

test('email uniqueness is case-insensitive', async () => {
  await registerAndVerify(app, { email: 'case@saiuniversity.edu.in' });
  const res = await request(app)
    .post('/api/auth/register')
    .send({ name: 'Case', email: 'CASE@SaiUniversity.edu.in', password: 'Campus123' });
  assert.equal(res.status, 409);
});

test('the correct OTP activates the account and returns a session', async () => {
  const reg = await request(app)
    .post('/api/auth/register')
    .send({ name: 'Ravi Kumar', email: 'ravi@saiuniversity.edu.in', password: 'Campus123' });
  assert.equal(reg.status, 201);

  const code = extractOtp('ravi@saiuniversity.edu.in');
  const verify = await request(app)
    .post('/api/auth/verify-otp')
    .send({ email: 'ravi@saiuniversity.edu.in', code, purpose: 'signup' });

  assert.equal(verify.status, 200);
  assert.ok(verify.body.token);
  assert.equal(verify.body.user.is_email_verified, true);
  assert.ok(verify.body.session.sessionId);

  const me = await request(app)
    .get('/api/auth/me')
    .set('Authorization', `Bearer ${verify.body.token}`);
  assert.equal(me.status, 200);
  assert.equal(me.body.user.email, 'ravi@saiuniversity.edu.in');
  assert.equal(me.body.user.password_hash, undefined, 'the hash must never be returned');

  const session = await query(
    `select login_at, status from user_sessions where session_id = $1`,
    [verify.body.session.sessionId]
  );
  assert.equal(session.rows[0].status, 'active');
  assert.ok(session.rows[0].login_at, 'login_at must be stored in the database');
});

test('an incorrect OTP is rejected and the attempt is counted', async () => {
  await request(app)
    .post('/api/auth/register')
    .send({ name: 'Wrong OTP', email: 'wrongotp@saiuniversity.edu.in', password: 'Campus123' });

  const res = await request(app)
    .post('/api/auth/verify-otp')
    .send({ email: 'wrongotp@saiuniversity.edu.in', code: '000000', purpose: 'signup' });

  assert.equal(res.status, 400);
  assert.match(res.body.error.message, /incorrect|invalid/i);

  const row = await query(
    `select attempts from otp_codes o join users u on u.id = o.user_id
      where u.email = $1 and o.consumed_at is null`,
    ['wrongotp@saiuniversity.edu.in']
  );
  assert.equal(row.rows[0].attempts, 1);
});

test('an OTP cannot be reused after a successful verification', async () => {
  const reg = await request(app)
    .post('/api/auth/register')
    .send({ name: 'Reuse', email: 'reuse@saiuniversity.edu.in', password: 'Campus123' });
  assert.equal(reg.status, 201);
  const code = extractOtp('reuse@saiuniversity.edu.in');

  const first = await request(app)
    .post('/api/auth/verify-otp')
    .send({ email: 'reuse@saiuniversity.edu.in', code, purpose: 'signup' });
  assert.equal(first.status, 200);

  const second = await request(app)
    .post('/api/auth/verify-otp')
    .send({ email: 'reuse@saiuniversity.edu.in', code, purpose: 'signup' });
  assert.equal(second.status, 400);
  assert.equal(second.body.token, undefined);
});

test('an expired OTP is rejected', async () => {
  await request(app)
    .post('/api/auth/register')
    .send({ name: 'Expired', email: 'expired@saiuniversity.edu.in', password: 'Campus123' });
  const code = extractOtp('expired@saiuniversity.edu.in');

  await query(
    `update otp_codes set expires_at = now() - interval '1 minute'
      where user_id = (select id from users where email = $1)`,
    ['expired@saiuniversity.edu.in']
  );

  const res = await request(app)
    .post('/api/auth/verify-otp')
    .send({ email: 'expired@saiuniversity.edu.in', code, purpose: 'signup' });
  assert.equal(res.status, 400);
  assert.match(res.body.error.message, /expired/i);
});

test('five wrong attempts lock the code', async () => {
  await request(app)
    .post('/api/auth/register')
    .send({ name: 'Brute', email: 'brute@saiuniversity.edu.in', password: 'Campus123' });
  const realCode = extractOtp('brute@saiuniversity.edu.in');
  const wrong = realCode === '111111' ? '222222' : '111111';

  let last;
  for (let i = 0; i < 5; i += 1) {
    last = await request(app)
      .post('/api/auth/verify-otp')
      .send({ email: 'brute@saiuniversity.edu.in', code: wrong, purpose: 'signup' });
  }
  assert.equal(last.status, 429);

  // Even the real code no longer works once the code is burned.
  const after = await request(app)
    .post('/api/auth/verify-otp')
    .send({ email: 'brute@saiuniversity.edu.in', code: realCode, purpose: 'signup' });
  assert.equal(after.status, 400);
});

test('resending supersedes the previous code', async () => {
  await request(app)
    .post('/api/auth/register')
    .send({ name: 'Resend', email: 'resend@saiuniversity.edu.in', password: 'Campus123' });
  const first = extractOtp('resend@saiuniversity.edu.in');

  const resend = await request(app)
    .post('/api/auth/resend-otp')
    .send({ email: 'resend@saiuniversity.edu.in', purpose: 'signup' });
  assert.equal(resend.status, 200);

  const second = extractOtp('resend@saiuniversity.edu.in');
  assert.notEqual(first, second, 'a new code must be generated');

  const oldTry = await request(app)
    .post('/api/auth/verify-otp')
    .send({ email: 'resend@saiuniversity.edu.in', code: first, purpose: 'signup' });
  assert.equal(oldTry.status, 400, 'the superseded code must stop working');

  const newTry = await request(app)
    .post('/api/auth/verify-otp')
    .send({ email: 'resend@saiuniversity.edu.in', code: second, purpose: 'signup' });
  assert.equal(newTry.status, 200);
});

test('the hourly OTP cap blocks code flooding', async () => {
  await request(app)
    .post('/api/auth/register')
    .send({ name: 'Flood', email: 'flood@saiuniversity.edu.in', password: 'Campus123' });

  let blocked = false;
  for (let i = 0; i < 8; i += 1) {
    const res = await request(app)
      .post('/api/auth/resend-otp')
      .send({ email: 'flood@saiuniversity.edu.in', purpose: 'signup' });
    if (res.status === 429) {
      blocked = true;
      break;
    }
  }
  assert.equal(blocked, true, 'the per-hour cap must eventually reject requests');
});

test('resending to an unknown address does not reveal that it is unknown', async () => {
  const res = await request(app)
    .post('/api/auth/resend-otp')
    .send({ email: 'ghost@saiuniversity.edu.in', purpose: 'login' });
  assert.equal(res.status, 200);
  assert.equal(lastMail('ghost@saiuniversity.edu.in'), undefined, 'no email is sent for unknown accounts');
});

test('an unverified account cannot log in, but is offered verification instead', async () => {
  await request(app)
    .post('/api/auth/register')
    .send({ name: 'Unverified', email: 'unverified@saiuniversity.edu.in', password: 'Campus123' });

  const res = await request(app)
    .post('/api/auth/login')
    .send({ email: 'unverified@saiuniversity.edu.in', password: 'Campus123' });

  assert.equal(res.status, 200);
  assert.equal(res.body.token, undefined);
  assert.equal(res.body.purpose, 'signup');
  assert.ok(res.body.expiresInSeconds > 0);
});

test('login with valid credentials issues an OTP challenge, never a token', async () => {
  await registerAndVerify(app, { email: 'login@saiuniversity.edu.in' });

  const res = await request(app)
    .post('/api/auth/login')
    .send({ email: 'login@saiuniversity.edu.in', password: 'Campus123' });

  assert.equal(res.status, 200);
  assert.equal(res.body.token, undefined);
  assert.equal(res.body.purpose, 'login');

  const code = extractOtp('login@saiuniversity.edu.in');
  const verify = await request(app)
    .post('/api/auth/verify-otp')
    .send({ email: 'login@saiuniversity.edu.in', code, purpose: 'login' });
  assert.equal(verify.status, 200);
  assert.ok(verify.body.token);
});

test('a wrong password and an unknown account give the same generic error', async () => {
  await registerAndVerify(app, { email: 'generic@saiuniversity.edu.in' });

  const wrongPass = await request(app)
    .post('/api/auth/login')
    .send({ email: 'generic@saiuniversity.edu.in', password: 'WrongPass123' });
  const unknown = await request(app)
    .post('/api/auth/login')
    .send({ email: 'nobody@saiuniversity.edu.in', password: 'WrongPass123' });

  assert.equal(wrongPass.status, 401);
  assert.equal(unknown.status, 401);
  assert.equal(wrongPass.body.error.message, unknown.body.error.message);
});

test('failed logins are recorded without any password material', async () => {
  await registerAndVerify(app, { email: 'audit@saiuniversity.edu.in' });
  await request(app)
    .post('/api/auth/login')
    .send({ email: 'audit@saiuniversity.edu.in', password: 'Nope12345' });

  const { rows } = await query(
    `select event, outcome, reason from auth_events where email = $1 and event = 'login_failed'`,
    ['audit@saiuniversity.edu.in']
  );
  assert.equal(rows.length, 1);
  assert.equal(rows[0].outcome, 'failure');
  assert.match(rows[0].reason, /wrong password/);
  const serialised = JSON.stringify(rows[0]);
  assert.doesNotMatch(serialised, /Nope12345/, 'passwords must never be stored in auth events');
});

test('a student cannot use the administrator portal', async () => {
  await registerAndVerify(app, { email: 'notadmin@saiuniversity.edu.in' });
  const res = await request(app)
    .post('/api/auth/admin/login')
    .send({ email: 'notadmin@saiuniversity.edu.in', password: 'Campus123' });
  assert.equal(res.status, 403);
});

test('an administrator must use the administrator portal', async () => {
  const admin = await createAdmin(app, { email: 'admin1@saiuniversity.edu.in' });
  assert.ok(admin.token);

  const res = await request(app)
    .post('/api/auth/login')
    .send({ email: 'admin1@saiuniversity.edu.in', password: 'AdminPass123' });
  assert.equal(res.status, 403);
  assert.match(res.body.error.message, /administrator portal/i);
});

test('admin login also requires the OTP step', async () => {
  await createAdmin(app, { email: 'admin2@saiuniversity.edu.in' });
  const res = await request(app)
    .post('/api/auth/admin/login')
    .send({ email: 'admin2@saiuniversity.edu.in', password: 'AdminPass123' });
  assert.equal(res.status, 200);
  assert.equal(res.body.token, undefined);
  assert.equal(res.body.purpose, 'admin_login');
});

test('logout records the timestamp and the token stops working', async () => {
  const { token } = await registerAndVerify(app, { email: 'logout@saiuniversity.edu.in' });

  const out = await request(app).post('/api/auth/logout').set('Authorization', `Bearer ${token}`);
  assert.equal(out.status, 200);
  assert.equal(out.body.loggedOut, true);
  assert.ok(out.body.logoutAt);

  const after = await request(app).get('/api/auth/me').set('Authorization', `Bearer ${token}`);
  assert.equal(after.status, 401);

  const { rows } = await query(
    `select s.status, s.logout_at, s.logout_reason
       from user_sessions s join users u on u.id = s.user_id where u.email = $1`,
    ['logout@saiuniversity.edu.in']
  );
  assert.equal(rows[0].status, 'logged_out');
  assert.ok(rows[0].logout_at);
  assert.equal(rows[0].logout_reason, 'user logout');
});

test('changing the password revokes other sessions', async () => {
  const { token } = await registerAndVerify(app, { email: 'pwchange@saiuniversity.edu.in' });
  const second = await loginAndVerify(app, { email: 'pwchange@saiuniversity.edu.in' });

  const res = await request(app)
    .post('/api/auth/change-password')
    .set('Authorization', `Bearer ${second.token}`)
    .send({ currentPassword: 'Campus123', newPassword: 'NewCampus123' });
  assert.equal(res.status, 200);
  assert.ok(res.body.otherSessionsRevoked >= 1);

  const old = await request(app).get('/api/auth/me').set('Authorization', `Bearer ${token}`);
  assert.equal(old.status, 401, 'the older session must be revoked');
});

test('a suspended account cannot sign in', async () => {
  await registerAndVerify(app, { email: 'suspended@saiuniversity.edu.in' });
  await query(`update users set status = 'suspended' where email = $1`, [
    'suspended@saiuniversity.edu.in',
  ]);
  const res = await request(app)
    .post('/api/auth/login')
    .send({ email: 'suspended@saiuniversity.edu.in', password: 'Campus123' });
  assert.equal(res.status, 403);
});

test('a student sees their own login history', async () => {
  const { token } = await registerAndVerify(app, { email: 'history@saiuniversity.edu.in' });
  const res = await request(app).get('/api/auth/sessions').set('Authorization', `Bearer ${token}`);
  assert.equal(res.status, 200);
  assert.ok(res.body.sessions.length >= 1);
  assert.equal(res.body.sessions[0].status, 'active');
});
