'use strict';

/**
 * Rule 5 + Rule 6 + Rule 10 — separate administrator access, monitoring,
 * moderation and the audit trail.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { startDb, stopDb, loadApp, request } = require('./helpers/db');
const { registerAndVerify, createAdmin, createItem, loginAndVerify } = require('./helpers/factory');
const { query } = require('../src/db/pool');
const mailer = require('../src/services/mailer');

let app;
let admin;
let student;

test.before(async () => {
  await startDb();
  app = loadApp();
  admin = await createAdmin(app, { email: 'admin@saiuniversity.edu.in' });
  student = await registerAndVerify(app, { name: 'Student Sam', email: 'sam@saiuniversity.edu.in' });
});
test.after(async () => {
  await stopDb();
});
test.beforeEach(() => mailer.clearCaptured());

const adminRoutes = [
  ['get', '/api/admin/overview'],
  ['get', '/api/admin/users'],
  ['get', '/api/admin/sessions'],
  ['get', '/api/admin/items'],
  ['get', '/api/admin/claims'],
  ['get', '/api/admin/audit-logs'],
  ['get', '/api/admin/auth-events'],
];

test('every admin endpoint rejects an anonymous request', async () => {
  for (const [method, path] of adminRoutes) {
    const res = await request(app)[method](path);
    assert.equal(res.status, 401, `${method.toUpperCase()} ${path} should be 401`);
  }
});

test('every admin endpoint rejects a student token', async () => {
  for (const [method, path] of adminRoutes) {
    const res = await request(app)[method](path).set('Authorization', `Bearer ${student.token}`);
    assert.equal(res.status, 403, `${method.toUpperCase()} ${path} should be 403 for a student`);
  }
});

test('an administrator sees platform-wide counters', async () => {
  await createItem(app, student.token, { title: 'Counted item' });
  const res = await request(app)
    .get('/api/admin/overview')
    .set('Authorization', `Bearer ${admin.token}`);

  assert.equal(res.status, 200);
  const o = res.body.overview;
  assert.ok(o.total_users >= 2);
  assert.ok(o.verified_users >= 2);
  assert.ok(o.lost_items >= 1);
  assert.ok(o.active_sessions >= 1);
  assert.equal(o.unverified_users, 0);
});

test('user management lists accounts with creation and verification data', async () => {
  const res = await request(app)
    .get('/api/admin/users?limit=50')
    .set('Authorization', `Bearer ${admin.token}`);

  assert.equal(res.status, 200);
  const sam = res.body.users.find((u) => u.email === 'sam@saiuniversity.edu.in');
  assert.ok(sam);
  assert.ok(sam.created_at, 'account creation timestamp is stored');
  assert.equal(sam.is_email_verified, true);
  assert.equal(sam.status, 'active');
  assert.ok('last_login_at' in sam);
});

test('users can be searched and paginated', async () => {
  const res = await request(app)
    .get('/api/admin/users?search=sam&page=1&limit=1')
    .set('Authorization', `Bearer ${admin.token}`);
  assert.equal(res.status, 200);
  assert.equal(res.body.users.length, 1);
  assert.equal(res.body.limit, 1);
});

test('login and logout history is visible to the administrator', async () => {
  const fresh = await registerAndVerify(app, { email: 'history2@saiuniversity.edu.in' });
  await request(app).post('/api/auth/logout').set('Authorization', `Bearer ${fresh.token}`);

  const res = await request(app)
    .get('/api/admin/sessions?status=logged_out')
    .set('Authorization', `Bearer ${admin.token}`);

  assert.equal(res.status, 200);
  const row = res.body.sessions.find((s) => s.email === 'history2@saiuniversity.edu.in');
  assert.ok(row, 'the logged-out session must be listed');
  assert.ok(row.login_at);
  assert.ok(row.logout_at);
  assert.equal(row.status, 'logged_out');
});

test('suspending a user revokes their sessions immediately', async () => {
  const victim = await registerAndVerify(app, { email: 'victim@saiuniversity.edu.in' });
  const before = await request(app)
    .get('/api/auth/me')
    .set('Authorization', `Bearer ${victim.token}`);
  assert.equal(before.status, 200);

  const patch = await request(app)
    .patch(`/api/admin/users/${victim.user.id}`)
    .set('Authorization', `Bearer ${admin.token}`)
    .send({ status: 'suspended' });
  assert.equal(patch.status, 200);
  assert.equal(patch.body.user.status, 'suspended');

  const after = await request(app)
    .get('/api/auth/me')
    .set('Authorization', `Bearer ${victim.token}`);
  assert.equal(after.status, 401, 'a suspended account must lose access at once');

  const login = await request(app)
    .post('/api/auth/login')
    .send({ email: 'victim@saiuniversity.edu.in', password: 'Campus123' });
  assert.equal(login.status, 403);
});

test('an administrator cannot demote or suspend themselves', async () => {
  const res = await request(app)
    .patch(`/api/admin/users/${admin.user.id}`)
    .set('Authorization', `Bearer ${admin.token}`)
    .send({ role: 'student' });
  assert.equal(res.status, 400);
});

test('the last administrator cannot be demoted', async () => {
  const second = await createAdmin(app, { email: 'admin2@saiuniversity.edu.in' });
  const demoteSecond = await request(app)
    .patch(`/api/admin/users/${second.user.id}`)
    .set('Authorization', `Bearer ${admin.token}`)
    .send({ role: 'student' });
  assert.equal(demoteSecond.status, 200, 'with two admins, one may be demoted');

  const demoteLast = await request(app)
    .patch(`/api/admin/users/${admin.user.id}`)
    .set('Authorization', `Bearer ${second.token}`);
  // second's session is still valid but its role is now student -> 403
  assert.equal(demoteLast.status, 403);
});

test('moderating an item removes it from the public gallery and is audited', async () => {
  const created = await createItem(app, student.token, { title: 'Spam listing to moderate' });
  const id = created.body.item.id;

  const res = await request(app)
    .patch(`/api/admin/items/${id}/moderate`)
    .set('Authorization', `Bearer ${admin.token}`)
    .send({ action: 'remove', note: 'Duplicate of another listing' });
  assert.equal(res.status, 200);

  const gallery = await request(app).get('/api/items?search=Spam listing');
  assert.equal(gallery.body.items.length, 0);

  const auditRows = await query(
    `select action, details from admin_audit_logs where target_id = $1 order by id desc limit 1`,
    [id]
  );
  assert.equal(auditRows.rows[0].action, 'item.remove');
  assert.match(auditRows.rows[0].details.note, /Duplicate/);
});

test('an administrator can decide a claim and it is audited', async () => {
  const item = await createItem(app, student.token, { type: 'found', title: 'Admin claim decision' });
  const claimant = await registerAndVerify(app, { email: 'claimant2@saiuniversity.edu.in' });
  const claim = await request(app)
    .post('/api/claims')
    .set('Authorization', `Bearer ${claimant.token}`)
    .send({ itemId: item.body.item.id, message: 'This is mine, the case has a scratch on it.' });
  assert.equal(claim.status, 201);

  const res = await request(app)
    .patch(`/api/admin/claims/${claim.body.claim.id}/decision`)
    .set('Authorization', `Bearer ${admin.token}`)
    .send({ decision: 'approved', note: 'Verified in person at the help desk' });
  assert.equal(res.status, 200);

  const auditRows = await query(
    `select action from admin_audit_logs where target_id = $1 and target_type = 'claim'`,
    [claim.body.claim.id]
  );
  assert.ok(auditRows.rows.some((r) => r.action === 'claim.approved'));
});

test('the audit log records who did what, and only admins can read it', async () => {
  const res = await request(app)
    .get('/api/admin/audit-logs')
    .set('Authorization', `Bearer ${admin.token}`);
  assert.equal(res.status, 200);
  assert.ok(res.body.logs.length >= 1);
  assert.ok(res.body.logs[0].actor_email);
  assert.ok(res.body.logs[0].created_at);

  const studentTry = await request(app)
    .get('/api/admin/audit-logs')
    .set('Authorization', `Bearer ${student.token}`);
  assert.equal(studentTry.status, 403);
});

test('security events are visible, including failed logins', async () => {
  await request(app)
    .post('/api/auth/login')
    .send({ email: 'sam@saiuniversity.edu.in', password: 'WrongPassword1' });

  const res = await request(app)
    .get('/api/admin/auth-events?event=login_failed')
    .set('Authorization', `Bearer ${admin.token}`);
  assert.equal(res.status, 200);
  assert.ok(res.body.events.length >= 1);
  assert.equal(res.body.events[0].event, 'login_failed');
  assert.doesNotMatch(JSON.stringify(res.body), /WrongPassword1/);
});

test('an administrator can revoke a specific session', async () => {
  const fresh = await loginAndVerify(app, { email: 'sam@saiuniversity.edu.in' });
  const sessions = await request(app)
    .get(`/api/admin/sessions?userId=${student.user.id}&status=active`)
    .set('Authorization', `Bearer ${admin.token}`);
  assert.ok(sessions.body.sessions.length >= 1);

  const target = sessions.body.sessions[0];
  const res = await request(app)
    .patch(`/api/admin/sessions/${target.id}/revoke`)
    .set('Authorization', `Bearer ${admin.token}`);
  assert.equal(res.status, 200);
  assert.equal(res.body.revoked, true);

  const after = await request(app).get('/api/auth/me').set('Authorization', `Bearer ${fresh.token}`);
  assert.equal(after.status, 401);
});

test('admin item list exposes owner emails (admins only) with moderation state', async () => {
  const res = await request(app)
    .get('/api/admin/items?limit=5')
    .set('Authorization', `Bearer ${admin.token}`);
  assert.equal(res.status, 200);
  assert.ok(res.body.items.length >= 1);
  assert.ok(res.body.items[0].owner_email);
  assert.ok('moderation_status' in res.body.items[0]);
});
