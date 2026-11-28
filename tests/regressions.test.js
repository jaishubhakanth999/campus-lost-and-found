'use strict';

/**
 * Regression tests for the defects found by the independent audit.
 * Each test names the finding it locks down (F1…F14) so a future change that
 * reintroduces the bug fails loudly here.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { startDb, stopDb, loadApp, request } = require('./helpers/db');
const { registerAndVerify, loginAndVerify, createItem, pngBuffer, extractOtp, lastMail } = require('./helpers/factory');
const { query } = require('../src/db/pool');
const mailer = require('../src/services/mailer');
const { getConfig } = require('../src/config/env');

let app;
let owner;
let claimant;

test.before(async () => {
  await startDb();
  app = loadApp();
  owner = await registerAndVerify(app, { name: 'Owner', email: 'regowner@saiuniversity.edu.in' });
  claimant = await registerAndVerify(app, { name: 'Claimant', email: 'regclaimant@saiuniversity.edu.in' });
});
test.after(async () => {
  await stopDb();
});
test.beforeEach(() => mailer.clearCaptured());

/* ------------------------------ F1 · private evidence --------------------- */

test('F1: private claim evidence is not reachable through the public /uploads path', async () => {
  const item = await createItem(app, owner.token, { type: 'found', title: 'F1 evidence' });
  const claim = await request(app)
    .post('/api/claims')
    .set('Authorization', `Bearer ${claimant.token}`)
    .field('itemId', item.body.item.id)
    .field('message', 'Attaching a photo of the engraving as proof of ownership.')
    .attach('evidence', await pngBuffer(), 'proof.png');

  assert.equal(claim.status, 201, JSON.stringify(claim.body));
  const key = claim.body.claim.evidence[0].key;
  assert.match(key, /^private\//, 'evidence must be stored under the private prefix');

  const viaStatic = await request(app).get('/uploads/' + key);
  assert.equal(viaStatic.status, 404, 'static serving must refuse the private prefix');

  const viaGuard = await request(app).get('/api/files/private/' + key);
  assert.equal(viaGuard.status, 401, 'the guarded route requires a session');

  const allowed = await request(app)
    .get('/api/files/private/' + key)
    .set('Authorization', `Bearer ${owner.token}`);
  assert.equal(allowed.status, 200, 'the owner can still read the evidence');
});

/* ------------------------------ F2 · OTP races ---------------------------- */

test('F2: parallel verifications of one code yield exactly one session', async () => {
  await request(app)
    .post('/api/auth/register')
    .send({ name: 'Race', email: 'race@saiuniversity.edu.in', password: 'CampusLife#2026' });
  const code = extractOtp('race@saiuniversity.edu.in');

  const attempts = await Promise.all(
    Array.from({ length: 5 }, () =>
      request(app)
        .post('/api/auth/verify-otp')
        .send({ email: 'race@saiuniversity.edu.in', code, purpose: 'signup' })
    )
  );
  const successes = attempts.filter((r) => r.status === 200);
  assert.equal(successes.length, 1, `expected exactly one success, got ${successes.length}`);

  const { rows } = await query(
    `select count(*)::int as n from user_sessions s
       join users u on u.id = s.user_id where u.email = $1`,
    ['race@saiuniversity.edu.in']
  );
  assert.equal(rows[0].n, 1, 'only one session may be created for one code');
});

test('F2: parallel wrong guesses are all counted', async () => {
  await request(app)
    .post('/api/auth/register')
    .send({ name: 'Race2', email: 'race2@saiuniversity.edu.in', password: 'CampusLife#2026' });
  const real = extractOtp('race2@saiuniversity.edu.in');
  const wrong = real === '111111' ? '222222' : '111111';

  await Promise.all(
    Array.from({ length: 4 }, () =>
      request(app)
        .post('/api/auth/verify-otp')
        .send({ email: 'race2@saiuniversity.edu.in', code: wrong, purpose: 'signup' })
    )
  );

  const { rows } = await query(
    `select attempts from otp_codes o join users u on u.id = o.user_id
      where u.email = $1 order by o.created_at desc limit 1`,
    ['race2@saiuniversity.edu.in']
  );
  assert.equal(rows[0].attempts, 4, 'each failed attempt must increment the counter exactly once');
});

/* ------------------------ F3 · resend cannot mint a code ------------------ */

test('F3: resend-otp cannot create a login code without a password check', async () => {
  await registerAndVerify(app, { email: 'resendfix@saiuniversity.edu.in' });
  mailer.clearCaptured(); // ignore the signup email sent during registration

  const res = await request(app)
    .post('/api/auth/resend-otp')
    .send({ email: 'resendfix@saiuniversity.edu.in', purpose: 'login' });

  assert.equal(res.status, 200, 'the response stays generic');
  assert.equal(lastMail('resendfix@saiuniversity.edu.in'), undefined, 'no email may be sent');

  const { rows } = await query(
    `select count(*)::int as n from otp_codes o join users u on u.id = o.user_id
      where u.email = $1 and o.consumed_at is null`,
    ['resendfix@saiuniversity.edu.in']
  );
  assert.equal(rows[0].n, 0, 'no live code may exist');
});

test('F3: after a real login the code can be resent', async () => {
  await registerAndVerify(app, { email: 'resendok@saiuniversity.edu.in' });
  const login = await request(app)
    .post('/api/auth/login')
    .send({ email: 'resendok@saiuniversity.edu.in', password: 'CampusLife#2026' });
  assert.equal(login.status, 200);

  const res = await request(app)
    .post('/api/auth/resend-otp')
    .send({ email: 'resendok@saiuniversity.edu.in', purpose: 'login' });
  assert.equal(res.status, 200);

  const code = extractOtp('resendok@saiuniversity.edu.in');
  const verify = await request(app)
    .post('/api/auth/verify-otp')
    .send({ email: 'resendok@saiuniversity.edu.in', code, purpose: 'login' });
  assert.equal(verify.status, 200);
});

/* ------------------- F5 · unverified account cannot be taken over --------- */

test('F5: re-registering an unverified address does not change its password', async () => {
  await request(app)
    .post('/api/auth/register')
    .send({ name: 'Original', email: 'takeover@saiuniversity.edu.in', password: 'OriginalPass1' });

  const second = await request(app)
    .post('/api/auth/register')
    .send({ name: 'Attacker', email: 'takeover@saiuniversity.edu.in', password: 'AttackerPass1' });
  assert.equal(second.status, 201, 'the resume path still re-issues a code');

  const withOriginal = await request(app)
    .post('/api/auth/login')
    .send({ email: 'takeover@saiuniversity.edu.in', password: 'OriginalPass1' });
  assert.equal(withOriginal.status, 200, 'the original password must still work');

  const withAttacker = await request(app)
    .post('/api/auth/login')
    .send({ email: 'takeover@saiuniversity.edu.in', password: 'AttackerPass1' });
  assert.equal(withAttacker.status, 401, 'the injected password must not work');

  const { rows } = await query(`select name from users where email = $1`, [
    'takeover@saiuniversity.edu.in',
  ]);
  assert.equal(rows[0].name, 'Original', 'the stored name must not be overwritten');
});

/* --------------------------- F6 · student id persists --------------------- */

test('F6: the profile student id is saved, not silently dropped', async () => {
  const user = await registerAndVerify(app, { email: 'studentid@saiuniversity.edu.in' });
  const patch = await request(app)
    .patch('/api/auth/me')
    .set('Authorization', `Bearer ${user.token}`)
    .send({ studentId: 'SU2023001', department: 'Computer Science' });

  assert.equal(patch.status, 200, JSON.stringify(patch.body));
  assert.equal(patch.body.user.student_id, 'SU2023001');

  const { rows } = await query(`select student_id, department from users where email = $1`, [
    'studentid@saiuniversity.edu.in',
  ]);
  assert.equal(rows[0].student_id, 'SU2023001');
  assert.equal(rows[0].department, 'Computer Science');
});

/* --------------------- F7 · handover email links the item ----------------- */

test('F7: the handover email links to the item, not to the claim', async () => {
  const item = await createItem(app, owner.token, { type: 'found', title: 'F7 handover' });
  const claim = await request(app)
    .post('/api/claims')
    .set('Authorization', `Bearer ${claimant.token}`)
    .send({ itemId: item.body.item.id, message: 'It has a scratch on the back, I can show you.' });

  await request(app)
    .patch(`/api/claims/${claim.body.claim.id}/decision`)
    .set('Authorization', `Bearer ${owner.token}`)
    .send({ decision: 'approved' });

  mailer.clearCaptured();
  const handover = await request(app)
    .patch(`/api/claims/${claim.body.claim.id}/handover`)
    .set('Authorization', `Bearer ${owner.token}`)
    .send({ place: 'Library front desk' });
  assert.equal(handover.status, 200, JSON.stringify(handover.body));

  const mail = lastMail('regclaimant@saiuniversity.edu.in');
  assert.ok(mail, 'the claimant is emailed');
  assert.ok(
    mail.html.includes('/item.html?id=' + item.body.item.id),
    'the link must point at the item'
  );
  assert.ok(
    !mail.html.includes('/item.html?id=' + claim.body.claim.id),
    'the link must not point at the claim id'
  );
});

/* ------------------ F8 · purpose is bound to the account role ------------- */

test('F8: a student cannot obtain or redeem an admin_login code', async () => {
  const student = await registerAndVerify(app, { email: 'purpose@saiuniversity.edu.in' });

  const resend = await request(app)
    .post('/api/auth/resend-otp')
    .send({ email: 'purpose@saiuniversity.edu.in', purpose: 'admin_login' });
  assert.equal(resend.status, 200, 'the response stays generic');

  const { rows } = await query(
    `select count(*)::int as n from otp_codes o join users u on u.id = o.user_id
      where u.email = $1 and o.purpose = 'admin_login'`,
    ['purpose@saiuniversity.edu.in']
  );
  assert.equal(rows[0].n, 0, 'no admin_login code may exist for a student');

  const verify = await request(app)
    .post('/api/auth/verify-otp')
    .send({ email: 'purpose@saiuniversity.edu.in', code: '123456', purpose: 'admin_login' });
  assert.equal(verify.status, 400);
  assert.equal(student.user.role, 'student');
});

/* ------------- F14 · claims are only possible on found items -------------- */

test('F14: a lost report cannot be claimed through the API', async () => {
  const item = await createItem(app, owner.token, { type: 'lost', title: 'F14 lost item' });
  const res = await request(app)
    .post('/api/claims')
    .set('Authorization', `Bearer ${claimant.token}`)
    .send({ itemId: item.body.item.id, message: 'I found this item near the library yesterday.' });
  assert.equal(res.status, 400);
  assert.match(res.body.error.message, /found items/i);
});

/* --------- F4 · an item cannot be marked returned over a live claim ------- */

test('F4: marking returned is refused while a claim is still open', async () => {
  const item = await createItem(app, owner.token, { type: 'found', title: 'F4 drift' });
  const claim = await request(app)
    .post('/api/claims')
    .set('Authorization', `Bearer ${claimant.token}`)
    .send({ itemId: item.body.item.id, message: 'That is mine, it has my name written inside.' });

  const direct = await request(app)
    .patch(`/api/items/${item.body.item.id}/status`)
    .set('Authorization', `Bearer ${owner.token}`)
    .send({ status: 'returned' });
  assert.equal(direct.status, 409, 'the item must not be closed over a live claim');

  await request(app)
    .patch(`/api/claims/${claim.body.claim.id}/decision`)
    .set('Authorization', `Bearer ${owner.token}`)
    .send({ decision: 'rejected', note: 'Does not match.' });

  const afterRejection = await request(app)
    .patch(`/api/items/${item.body.item.id}/status`)
    .set('Authorization', `Bearer ${owner.token}`)
    .send({ status: 'returned' });
  assert.equal(afterRejection.status, 200, 'with no live claim the owner may close it');
});

/* -------------------- F12 · session lifetime never exceeds token ---------- */

test('F12: the session lifetime is clamped to the token lifetime', () => {
  const cfg = getConfig();
  const hours = /^(\d+)\s*([smhd])$/i.exec(cfg.JWT_EXPIRES_IN);
  assert.ok(hours, 'JWT_EXPIRES_IN should be a simple duration');
  const tokenHours = hours[2].toLowerCase() === 'h' ? Number(hours[1]) : Number(hours[1]) * 24;
  assert.ok(
    cfg.SESSION_TTL_HOURS <= tokenHours,
    `session TTL ${cfg.SESSION_TTL_HOURS}h must not exceed token lifetime ${tokenHours}h`
  );
});
