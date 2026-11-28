'use strict';

/**
 * Regressions for the second full-stack review.
 *
 * Every test here failed before the fix it locks down. The IDs (R1…) are the
 * review's finding numbers, so a future reader can match a failure to the
 * original report.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { startDb, stopDb, loadApp, request } = require('./helpers/db');
const { registerAndVerify, createAdmin, createItem } = require('./helpers/factory');
const { query } = require('../src/db/pool');
const mailer = require('../src/services/mailer');

let app;
let owner;
let claimant;
let admin;

test.before(async () => {
  await startDb();
  app = loadApp();
  owner = await registerAndVerify(app, { name: 'Owner', email: 'r-owner@saiuniversity.edu.in' });
  claimant = await registerAndVerify(app, { name: 'Claimant', email: 'r-claimant@saiuniversity.edu.in' });
  admin = await createAdmin(app, { email: 'r-admin@saiuniversity.edu.in' });
});
test.after(async () => {
  await stopDb();
});
test.beforeEach(() => mailer.clearCaptured());

async function foundItem(title) {
  const res = await createItem(app, owner.token, { type: 'found', title });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return res.body.item.id;
}

async function claim(itemId, message = 'It has a blue sticker and my library card inside.') {
  const res = await request(app)
    .post('/api/claims')
    .set('Authorization', `Bearer ${claimant.token}`)
    .send({ itemId, message });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return res.body.claim.id;
}

/* ------------------------- R1 · self-decided claims ----------------------- */

test('R1: an administrator cannot decide a claim they submitted themselves', async () => {
  const itemId = await foundItem('R1 admin self-dealing');
  const adminClaim = await request(app)
    .post('/api/claims')
    .set('Authorization', `Bearer ${admin.token}`)
    .send({ itemId, message: 'This is mine, I can describe the scratch on the back.' });
  assert.equal(adminClaim.status, 201, 'an admin may still file a claim');

  const decide = await request(app)
    .patch(`/api/claims/${adminClaim.body.claim.id}/decision`)
    .set('Authorization', `Bearer ${admin.token}`)
    .send({ decision: 'approved' });
  assert.equal(decide.status, 403, 'self-dealing must be refused');

  const item = await request(app).get(`/api/items/${itemId}`);
  assert.equal(item.body.item.status, 'open', 'the item must not have moved');
});

/* --------------------- R2 · rejected listing keeps claims ---------------- */

test('R2: rejecting a listing closes its pending claims', async () => {
  const itemId = await foundItem('R2 rejected listing');
  const claimId = await claim(itemId);

  const reject = await request(app)
    .patch(`/api/admin/items/${itemId}/moderate`)
    .set('Authorization', `Bearer ${admin.token}`)
    .send({ action: 'reject', note: 'Not a real listing' });
  assert.equal(reject.status, 200);

  const claimRow = await query(`select status from claims where id = $1`, [claimId]);
  assert.equal(claimRow.rows[0].status, 'rejected', 'the pending claim must be closed');

  const approve = await request(app)
    .patch(`/api/claims/${claimId}/decision`)
    .set('Authorization', `Bearer ${owner.token}`)
    .send({ decision: 'approved' });
  assert.equal(approve.status, 409);
});

/* ------------------ R3 · admin forces "returned" with a claim ------------ */

test('R3: an administrator marking an item returned also closes its live claims', async () => {
  const itemId = await foundItem('R3 admin returned');
  const claimId = await claim(itemId);
  await request(app)
    .patch(`/api/claims/${claimId}/decision`)
    .set('Authorization', `Bearer ${owner.token}`)
    .send({ decision: 'approved' });

  const forced = await request(app)
    .patch(`/api/admin/items/${itemId}/status`)
    .set('Authorization', `Bearer ${admin.token}`)
    .send({ status: 'returned' });
  assert.equal(forced.status, 200, JSON.stringify(forced.body));

  const item = await query(`select status from items where id = $1`, [itemId]);
  assert.equal(item.rows[0].status, 'returned');

  const live = await query(
    `select count(*)::int n from claims where item_id = $1 and status in ('pending', 'approved')`,
    [itemId]
  );
  assert.equal(live.rows[0].n, 0, 'no claim may be left live on a returned item');

  const claimRow = await query(`select status, completed_at from claims where id = $1`, [claimId]);
  assert.equal(claimRow.rows[0].status, 'completed');
  assert.ok(claimRow.rows[0].completed_at);
});

/* ------------------------- R4 · restore resurrection --------------------- */

test('R4: hiding and restoring a returned listing leaves it returned', async () => {
  const itemId = await foundItem('R4 restore');
  await request(app)
    .patch(`/api/items/${itemId}/status`)
    .set('Authorization', `Bearer ${owner.token}`)
    .send({ status: 'returned' });

  await request(app)
    .patch(`/api/admin/items/${itemId}/moderate`)
    .set('Authorization', `Bearer ${admin.token}`)
    .send({ action: 'remove' });
  const restore = await request(app)
    .patch(`/api/admin/items/${itemId}/moderate`)
    .set('Authorization', `Bearer ${admin.token}`)
    .send({ action: 'restore' });
  assert.equal(restore.status, 200);

  const row = await query(`select status, moderation_status from items where id = $1`, [itemId]);
  assert.equal(row.rows[0].status, 'returned', 'a returned item must stay returned');
  assert.equal(row.rows[0].moderation_status, 'approved');
});

/* -------------------- R5 · claims on a suspended owner ------------------- */

test('R5: a listing whose owner is suspended cannot be claimed', async () => {
  const itemId = await foundItem('R5 suspended owner');
  await query(`update users set status = 'suspended' where email = $1`, ['r-owner@saiuniversity.edu.in']);

  const res = await request(app)
    .post('/api/claims')
    .set('Authorization', `Bearer ${claimant.token}`)
    .send({ itemId, message: 'That is mine, the clasp has a small engraving.' });
  assert.equal(res.status, 409);
  assert.match(res.body.error.message, /unavailable/i);

  await query(`update users set status = 'active' where email = $1`, ['r-owner@saiuniversity.edu.in']);
});

/* --------------------------- R6 · type is applied ------------------------ */

test('R6: PATCH /api/items/:id actually changes the report type', async () => {
  const itemId = await foundItem('R6 type change');
  const res = await request(app)
    .patch(`/api/items/${itemId}`)
    .set('Authorization', `Bearer ${owner.token}`)
    .send({ type: 'lost' });
  assert.equal(res.status, 200);
  assert.equal(res.body.item.type, 'lost', 'the accepted field must not be silently dropped');
});

/* --------------------------- R7 · claim counts --------------------------- */

test('R7: the item page counts only live claims', async () => {
  const itemId = await foundItem('R7 claim count');
  const claimId = await claim(itemId);

  const before = await request(app).get(`/api/items/${itemId}`);
  assert.equal(before.body.item.claimCount, 1);

  await request(app)
    .patch(`/api/claims/${claimId}/decision`)
    .set('Authorization', `Bearer ${owner.token}`)
    .send({ decision: 'rejected' });

  const after = await request(app).get(`/api/items/${itemId}`);
  assert.equal(after.body.item.claimCount, 0, 'a rejected claim is not a live claim');

  const mine = await request(app).get('/api/items/mine').set('Authorization', `Bearer ${owner.token}`);
  const row = mine.body.items.find((i) => i.id === itemId);
  assert.equal(row.claimCount, 0, 'both endpoints must agree');
});

/* ------------------------ R8 · page past the end ------------------------- */

test('R8: a page past the end is clamped to the last page', async () => {
  const res = await request(app).get('/api/items?page=999&limit=5');
  assert.equal(res.status, 200);
  assert.ok(res.body.page <= res.body.pages, 'page must not exceed pages');
  assert.ok(res.body.items.length > 0, 'a stale page number must not read as “nothing exists”');
});

/* ---------------------- R9 · visibility is reversible -------------------- */

test('R9: moderating visibility is reversible and never lies about the result', async () => {
  const itemId = await foundItem('R9 visibility');

  const remove = await request(app)
    .patch(`/api/admin/items/${itemId}/moderate`)
    .set('Authorization', `Bearer ${admin.token}`)
    .send({ action: 'remove', note: 'Duplicate' });
  assert.equal(remove.status, 200);

  const hidden = await request(app).get(`/api/items/${itemId}`);
  assert.equal(hidden.status, 404, 'a removed listing must not be publicly readable');

  const asOwner = await request(app)
    .get(`/api/items/${itemId}`)
    .set('Authorization', `Bearer ${owner.token}`);
  assert.equal(asOwner.status, 200, 'the owner can still see their own hidden listing');

  const approve = await request(app)
    .patch(`/api/admin/items/${itemId}/moderate`)
    .set('Authorization', `Bearer ${admin.token}`)
    .send({ action: 'approve' });
  assert.equal(approve.status, 200);

  const visible = await request(app).get(`/api/items/${itemId}`);
  assert.equal(visible.status, 200, 'approving must actually restore visibility');

  const row = await query(`select status, moderation_status from items where id = $1`, [itemId]);
  assert.equal(row.rows[0].moderation_status, 'approved');
  assert.equal(row.rows[0].status, 'open');
});
