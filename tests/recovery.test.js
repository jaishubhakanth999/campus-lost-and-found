'use strict';

/**
 * Password reset and listing housekeeping.
 * Everything here hits the real HTTP API against real PostgreSQL.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { startDb, stopDb, loadApp, request } = require('./helpers/db');
const { registerAndVerify, loginAndVerify, createItem, lastMail } = require('./helpers/factory');
const { query } = require('../src/db/pool');
const mailer = require('../src/services/mailer');
const { expireListings } = require('../src/services/itemService');

let app;

test.before(async () => {
  await startDb();
  app = loadApp();
});
test.after(async () => {
  await stopDb();
});
test.beforeEach(() => mailer.clearCaptured());

function tokenFromEmail(email) {
  const mail = lastMail(email);
  assert.ok(mail, `no reset email for ${email}`);
  const match = mail.html.match(/reset\.html\?token=([a-f0-9]{64})/);
  assert.ok(match, 'the email must contain a 64-character reset token');
  return match[1];
}

/* ------------------------------- request flow ------------------------------ */

test('a reset link is emailed and only its hash is stored', async () => {
  await registerAndVerify(app, { email: 'reset1@saiuniversity.edu.in' });
  mailer.clearCaptured();

  const res = await request(app)
    .post('/api/auth/forgot-password')
    .send({ email: 'reset1@saiuniversity.edu.in' });

  assert.equal(res.status, 200);
  assert.match(res.body.message, /reset link is on its way/i);

  const token = tokenFromEmail('reset1@saiuniversity.edu.in');
  const { rows } = await query(
    `select t.token_hash, t.used_at from password_reset_tokens t
       join users u on u.id = t.user_id where u.email = $1`,
    ['reset1@saiuniversity.edu.in']
  );
  assert.equal(rows.length, 1);
  assert.notEqual(rows[0].token_hash, token, 'the plain token must not be stored');
  assert.match(rows[0].token_hash, /^[a-f0-9]{64}$/);
  assert.equal(rows[0].used_at, null);
});

test('an unknown address gets the same answer and no email', async () => {
  const res = await request(app)
    .post('/api/auth/forgot-password')
    .send({ email: 'nobody-here@saiuniversity.edu.in' });

  assert.equal(res.status, 200);
  assert.match(res.body.message, /reset link is on its way/i);
  assert.equal(lastMail('nobody-here@saiuniversity.edu.in'), undefined);
});

test('requesting a second link invalidates the first', async () => {
  await registerAndVerify(app, { email: 'reset2@saiuniversity.edu.in' });
  mailer.clearCaptured();
  await request(app).post('/api/auth/forgot-password').send({ email: 'reset2@saiuniversity.edu.in' });
  const firstToken = tokenFromEmail('reset2@saiuniversity.edu.in');

  await request(app).post('/api/auth/forgot-password').send({ email: 'reset2@saiuniversity.edu.in' });
  const secondToken = tokenFromEmail('reset2@saiuniversity.edu.in');
  assert.notEqual(firstToken, secondToken);

  const oldTry = await request(app)
    .post('/api/auth/reset-password')
    .send({ token: firstToken, password: 'BrandNew123' });
  assert.equal(oldTry.status, 400, 'the superseded link must stop working');

  const newTry = await request(app)
    .post('/api/auth/reset-password')
    .send({ token: secondToken, password: 'BrandNew123' });
  assert.equal(newTry.status, 200);
});

/* -------------------------------- reset flow ------------------------------ */

test('resetting the password changes it, signs sessions out and burns the link', async () => {
  const user = await registerAndVerify(app, { email: 'reset3@saiuniversity.edu.in' });
  mailer.clearCaptured();
  await request(app).post('/api/auth/forgot-password').send({ email: 'reset3@saiuniversity.edu.in' });
  const token = tokenFromEmail('reset3@saiuniversity.edu.in');

  const res = await request(app)
    .post('/api/auth/reset-password')
    .send({ token, password: 'FreshStart123' });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.ok(res.body.sessionsRevoked >= 1, 'existing sessions must be revoked');

  // The old session no longer works.
  const oldSession = await request(app)
    .get('/api/auth/me')
    .set('Authorization', `Bearer ${user.token}`);
  assert.equal(oldSession.status, 401);

  // The old password no longer works, the new one does.
  const oldLogin = await request(app)
    .post('/api/auth/login')
    .send({ email: 'reset3@saiuniversity.edu.in', password: 'CampusLife#2026' });
  assert.equal(oldLogin.status, 401);

  const newLogin = await request(app)
    .post('/api/auth/login')
    .send({ email: 'reset3@saiuniversity.edu.in', password: 'FreshStart123' });
  assert.equal(newLogin.status, 200);
  assert.equal(newLogin.body.purpose, 'login');

  // The link cannot be used twice.
  const reuse = await request(app)
    .post('/api/auth/reset-password')
    .send({ token, password: 'AnotherPass123' });
  assert.equal(reuse.status, 400);
});

test('an expired reset link is refused', async () => {
  await registerAndVerify(app, { email: 'reset4@saiuniversity.edu.in' });
  mailer.clearCaptured();
  await request(app).post('/api/auth/forgot-password').send({ email: 'reset4@saiuniversity.edu.in' });
  const token = tokenFromEmail('reset4@saiuniversity.edu.in');

  await query(
    `update password_reset_tokens set expires_at = now() - interval '1 minute'
      where user_id = (select id from users where email = $1)`,
    ['reset4@saiuniversity.edu.in']
  );

  const res = await request(app)
    .post('/api/auth/reset-password')
    .send({ token, password: 'TooLate12345' });
  assert.equal(res.status, 400);
  assert.match(res.body.error.message, /expired/i);
});

test('a weak or mismatched new password is rejected', async () => {
  await registerAndVerify(app, { email: 'reset5@saiuniversity.edu.in' });
  mailer.clearCaptured();
  await request(app).post('/api/auth/forgot-password').send({ email: 'reset5@saiuniversity.edu.in' });
  const token = tokenFromEmail('reset5@saiuniversity.edu.in');

  const weak = await request(app)
    .post('/api/auth/reset-password')
    .send({ token, password: 'short' });
  assert.equal(weak.status, 400);
  assert.ok(weak.body.error.fields.password);

  // The link survives a rejected attempt, so the user can try again.
  const good = await request(app)
    .post('/api/auth/reset-password')
    .send({ token, password: 'StrongEnough123' });
  assert.equal(good.status, 200);
});

test('a garbage token is rejected without leaking anything', async () => {
  const res = await request(app)
    .post('/api/auth/reset-password')
    .send({ token: 'a'.repeat(64), password: 'SomePassword123' });
  assert.equal(res.status, 400);
  assert.match(res.body.error.message, /invalid or has already been used/i);
});

test('the reset request is recorded in the security log', async () => {
  await registerAndVerify(app, { email: 'reset6@saiuniversity.edu.in' });
  await request(app).post('/api/auth/forgot-password').send({ email: 'reset6@saiuniversity.edu.in' });

  const { rows } = await query(
    `select event, outcome from auth_events
      where email = $1 and event = 'password_reset_requested'
      order by id desc limit 1`,
    ['reset6@saiuniversity.edu.in']
  );
  assert.equal(rows[0].event, 'password_reset_requested');
  assert.equal(rows[0].outcome, 'success');
});

/* ------------------------------ listing expiry ---------------------------- */

test('a new listing gets an expiry date', async () => {
  const user = await registerAndVerify(app, { email: 'expiry1@saiuniversity.edu.in' });
  const created = await createItem(app, user.token, { title: 'Expiry check' });
  assert.ok(created.body.item.expiresAt, 'expiresAt must be returned');

  const days = Math.round(
    (new Date(created.body.item.expiresAt) - Date.now()) / 86400000
  );
  assert.ok(days >= 59 && days <= 61, `expected ~60 days, got ${days}`);
});

test('expired listings are closed and claimed ones are left alone', async () => {
  const user = await registerAndVerify(app, { email: 'expiry2@saiuniversity.edu.in' });
  const stale = await createItem(app, user.token, { title: 'Stale listing' });
  const claimed = await createItem(app, user.token, { type: 'found', title: 'Claimed listing' });

  await query(`update items set expires_at = now() - interval '1 day' where id = $1`, [
    stale.body.item.id,
  ]);
  await query(
    `update items set expires_at = now() - interval '1 day', status = 'claimed' where id = $1`,
    [claimed.body.item.id]
  );

  const result = await expireListings({ warnDays: 0 });
  assert.ok(result.closed >= 1);

  const rows = await query(`select id, status from items where id in ($1, $2)`, [
    stale.body.item.id,
    claimed.body.item.id,
  ]);
  const byId = Object.fromEntries(rows.rows.map((r) => [r.id, r.status]));
  assert.equal(byId[stale.body.item.id], 'closed');
  assert.equal(byId[claimed.body.item.id], 'claimed', 'a claimed item must not be closed');
});

test('owners are warned once before their listing expires', async () => {
  const user = await registerAndVerify(app, { email: 'expiry3@saiuniversity.edu.in' });
  const item = await createItem(app, user.token, { title: 'Closing soon' });
  await query(`update items set expires_at = now() + interval '3 days' where id = $1`, [
    item.body.item.id,
  ]);
  mailer.clearCaptured();

  const first = await expireListings({ warnDays: 7 });
  assert.ok(first.warned >= 1);

  const mail = lastMail('expiry3@saiuniversity.edu.in');
  assert.ok(mail, 'the owner is emailed');
  assert.match(mail.subject, /closes in/i);

  const second = await expireListings({ warnDays: 7 });
  const stillOne = mailer
    .capturedMessages()
    .filter((m) => m.to === 'expiry3@saiuniversity.edu.in' && /closes in/i.test(m.subject));
  assert.equal(stillOne.length, 1, 'the warning must not be repeated');
  assert.ok(second.warned === 0 || second.warned < first.warned + 1);
});
