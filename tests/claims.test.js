'use strict';

/**
 * Rule 10 — claim workflow, including the three defects found in the audit:
 * unreadable claim messages, unguarded transitions and double approvals.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { startDb, stopDb, loadApp, request } = require('./helpers/db');
const { registerAndVerify, createItem, pngBuffer, lastMail } = require('./helpers/factory');
const { query } = require('../src/db/pool');
const mailer = require('../src/services/mailer');

let app;
let owner;
let claimant;
let rival;

test.before(async () => {
  await startDb();
  app = loadApp();
  owner = await registerAndVerify(app, { name: 'Finder Fatima', email: 'finder@saiuniversity.edu.in' });
  claimant = await registerAndVerify(app, { name: 'Owner Omar', email: 'omar@saiuniversity.edu.in' });
  rival = await registerAndVerify(app, { name: 'Rival Ria', email: 'ria@saiuniversity.edu.in' });
});
test.after(async () => {
  await stopDb();
});
test.beforeEach(() => mailer.clearCaptured());

async function freshFoundItem(title = 'Found black wallet') {
  const res = await createItem(app, owner.token, { type: 'found', title, category: 'Accessories' });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return res.body.item.id;
}

async function claimAs(user, itemId, message = 'It has my library card and a blue sticker inside.') {
  return request(app)
    .post('/api/claims')
    .set('Authorization', `Bearer ${user.token}`)
    .send({ itemId, message });
}

test('a student can claim a found item and the owner is emailed', async () => {
  const itemId = await freshFoundItem();
  const res = await claimAs(claimant, itemId);

  assert.equal(res.status, 201, JSON.stringify(res.body));
  assert.equal(res.body.claim.status, 'pending');

  const mail = lastMail('finder@saiuniversity.edu.in');
  assert.ok(mail, 'the owner must be notified');
  assert.match(mail.subject, /New claim/);
  assert.match(mail.html, /library card/, 'the owner email includes the claim text');
});

test('you cannot claim your own listing', async () => {
  const itemId = await freshFoundItem('Found my own thing');
  const res = await claimAs(owner, itemId);
  assert.equal(res.status, 400);
});

test('a duplicate live claim is rejected with 409', async () => {
  const itemId = await freshFoundItem('Found duplicate test');
  const first = await claimAs(claimant, itemId);
  assert.equal(first.status, 201);

  const second = await claimAs(claimant, itemId, 'Trying again with a different message here.');
  assert.equal(second.status, 409);
});

test('the owner can read the full claim message before deciding', async () => {
  const itemId = await freshFoundItem('Found readable claim');
  await claimAs(claimant, itemId, 'The wallet has a photo of a dog in the clear window.');

  const received = await request(app)
    .get('/api/claims/received')
    .set('Authorization', `Bearer ${owner.token}`);

  assert.equal(received.status, 200);
  const claim = received.body.claims.find((c) => c.itemId === itemId);
  assert.ok(claim, 'the owner must see the claim');
  assert.match(claim.message, /photo of a dog/);
  assert.equal(claim.claimant.name, 'Owner Omar');
  assert.ok(claim.claimant.email, 'the owner may contact the claimant');
});

test('a claimant cannot decide their own claim', async () => {
  const itemId = await freshFoundItem('Found decide test');
  const created = await claimAs(claimant, itemId);

  const res = await request(app)
    .patch(`/api/claims/${created.body.claim.id}/decision`)
    .set('Authorization', `Bearer ${claimant.token}`)
    .send({ decision: 'approved' });
  assert.equal(res.status, 403);
});

test('approving a claim marks the item claimed and rejects the rivals', async () => {
  const itemId = await freshFoundItem('Found approval test');
  const first = await claimAs(claimant, itemId, 'I can describe the engraving on the clasp.');
  const second = await claimAs(rival, itemId, 'It is mine, I lost it yesterday evening.');

  const approve = await request(app)
    .patch(`/api/claims/${first.body.claim.id}/decision`)
    .set('Authorization', `Bearer ${owner.token}`)
    .send({ decision: 'approved', note: 'The engraving matches.' });
  assert.equal(approve.status, 200, JSON.stringify(approve.body));
  assert.equal(approve.body.claim.status, 'approved');

  const item = await request(app).get(`/api/items/${itemId}`);
  assert.equal(item.body.item.status, 'claimed');

  const rivalRow = await query(`select status from claims where id = $1`, [second.body.claim.id]);
  assert.equal(rivalRow.rows[0].status, 'rejected');

  assert.ok(lastMail('omar@saiuniversity.edu.in'), 'the claimant is emailed the decision');
});

test('a second approval on the same item is impossible', async () => {
  const itemId = await freshFoundItem('Found double approval');
  const first = await claimAs(claimant, itemId, 'The strap has a small tear near the buckle.');
  const second = await claimAs(rival, itemId, 'Mine, it has a red keychain attached.');

  const approve1 = await request(app)
    .patch(`/api/claims/${first.body.claim.id}/decision`)
    .set('Authorization', `Bearer ${owner.token}`)
    .send({ decision: 'approved' });
  assert.equal(approve1.status, 200);

  const approve2 = await request(app)
    .patch(`/api/claims/${second.body.claim.id}/decision`)
    .set('Authorization', `Bearer ${owner.token}`)
    .send({ decision: 'approved' });
  assert.equal(approve2.status, 409, 'the second claim was already auto-rejected');

  const approved = await query(
    `select count(*)::int as n from claims where item_id = $1 and status = 'approved'`,
    [itemId]
  );
  assert.equal(approved.rows[0].n, 1, 'exactly one approved claim may exist');
});

test('an approved claim cannot be re-decided', async () => {
  const itemId = await freshFoundItem('Found re-decision');
  const created = await claimAs(claimant, itemId, 'It has my initials written on the inside.');

  await request(app)
    .patch(`/api/claims/${created.body.claim.id}/decision`)
    .set('Authorization', `Bearer ${owner.token}`)
    .send({ decision: 'approved' });

  const reject = await request(app)
    .patch(`/api/claims/${created.body.claim.id}/decision`)
    .set('Authorization', `Bearer ${owner.token}`)
    .send({ decision: 'rejected' });
  assert.equal(reject.status, 409);

  const item = await request(app).get(`/api/items/${itemId}`);
  assert.equal(item.body.item.status, 'claimed', 'the item state must not drift');
});

test('a rejected claim frees the item for other claimants', async () => {
  const itemId = await freshFoundItem('Found rejection path');
  const first = await claimAs(claimant, itemId, 'I think this is mine because of the colour.');

  const reject = await request(app)
    .patch(`/api/claims/${first.body.claim.id}/decision`)
    .set('Authorization', `Bearer ${owner.token}`)
    .send({ decision: 'rejected', note: 'The description does not match.' });
  assert.equal(reject.status, 200);

  const item = await request(app).get(`/api/items/${itemId}`);
  assert.equal(item.body.item.status, 'open');

  const second = await claimAs(rival, itemId, 'It is mine, here is a different detail to check.');
  assert.equal(second.status, 201);
});

test('a claimant can withdraw and then re-claim', async () => {
  const itemId = await freshFoundItem('Found withdrawal');
  const created = await claimAs(claimant, itemId, 'Withdrawing this because I found mine.');

  const withdraw = await request(app)
    .patch(`/api/claims/${created.body.claim.id}/withdraw`)
    .set('Authorization', `Bearer ${claimant.token}`);
  assert.equal(withdraw.status, 200);

  const again = await claimAs(claimant, itemId, 'Actually this is mine, re-opening the claim.');
  assert.equal(again.status, 201);
});

test('completing a claim marks the item returned for both parties', async () => {
  const itemId = await freshFoundItem('Found completion');
  const created = await claimAs(claimant, itemId, 'The inner pocket has a train ticket in it.');

  await request(app)
    .patch(`/api/claims/${created.body.claim.id}/decision`)
    .set('Authorization', `Bearer ${owner.token}`)
    .send({ decision: 'approved' });

  const handover = await request(app)
    .patch(`/api/claims/${created.body.claim.id}/handover`)
    .set('Authorization', `Bearer ${owner.token}`)
    .send({ place: 'Library front desk', at: new Date(Date.now() + 86400000).toISOString() });
  assert.equal(handover.status, 200);
  assert.equal(handover.body.claim.handover.place, 'Library front desk');

  const done = await request(app)
    .patch(`/api/claims/${created.body.claim.id}/complete`)
    .set('Authorization', `Bearer ${claimant.token}`);
  assert.equal(done.status, 200, JSON.stringify(done.body));
  assert.equal(done.body.claim.status, 'completed');

  const item = await request(app).get(`/api/items/${itemId}`);
  assert.equal(item.body.item.status, 'returned');
  assert.ok(item.body.item.returnedAt);
});

test('private claim evidence is only visible to the two parties', async () => {
  const itemId = await freshFoundItem('Found evidence privacy');
  const res = await request(app)
    .post('/api/claims')
    .set('Authorization', `Bearer ${claimant.token}`)
    .field('itemId', itemId)
    .field('message', 'Attaching a photo of the engraving as evidence for you.')
    .attach('evidence', await pngBuffer(), 'proof.png');
  assert.equal(res.status, 201, JSON.stringify(res.body));
  assert.equal(res.body.claim.evidence.length, 1);

  const claimId = res.body.claim.id;

  const ownerView = await request(app)
    .get(`/api/claims/${claimId}/evidence`)
    .set('Authorization', `Bearer ${owner.token}`);
  assert.equal(ownerView.status, 200);
  assert.equal(ownerView.body.links.length, 1);
  assert.match(ownerView.body.links[0].url, /^\/api\/files\/private\//);

  const outsider = await request(app)
    .get(`/api/claims/${claimId}/evidence`)
    .set('Authorization', `Bearer ${rival.token}`);
  assert.equal(outsider.status, 403);

  const anon = await request(app).get(`/api/claims/${claimId}/evidence`);
  assert.equal(anon.status, 401);

  // The private file is not reachable through the public gallery path.
  const gallery = await request(app).get('/api/items?search=evidence');
  assert.doesNotMatch(JSON.stringify(gallery.body), /private\//);
});

test('a claim cannot be completed once the listing was removed', async () => {
  const itemId = await freshFoundItem('Found removed before handover');
  const created = await claimAs(claimant, itemId, 'It has a small engraving on the clasp.');

  await request(app)
    .patch(`/api/claims/${created.body.claim.id}/decision`)
    .set('Authorization', `Bearer ${owner.token}`)
    .send({ decision: 'approved' });

  const removed = await request(app)
    .delete(`/api/items/${itemId}`)
    .set('Authorization', `Bearer ${owner.token}`);
  assert.equal(removed.status, 200);

  const complete = await request(app)
    .patch(`/api/claims/${created.body.claim.id}/complete`)
    .set('Authorization', `Bearer ${owner.token}`);
  assert.equal(complete.status, 409, 'a removed listing must not produce a completed claim');

  // the two records still agree
  const claimRow = await query(`select status from claims where id = $1`, [created.body.claim.id]);
  const itemRow = await query(`select status from items where id = $1`, [itemId]);
  assert.equal(claimRow.rows[0].status, 'approved');
  assert.equal(itemRow.rows[0].status, 'removed');
});

test('claiming a closed item is refused', async () => {
  const itemId = await freshFoundItem('Found closed item');
  await request(app)
    .patch(`/api/items/${itemId}/status`)
    .set('Authorization', `Bearer ${owner.token}`)
    .send({ status: 'closed' });

  const res = await claimAs(claimant, itemId);
  assert.equal(res.status, 409);
});

test('claim messages shorter than 10 characters are rejected', async () => {
  const itemId = await freshFoundItem('Found short message');
  const res = await claimAs(claimant, itemId, 'mine');
  assert.equal(res.status, 400);
});
