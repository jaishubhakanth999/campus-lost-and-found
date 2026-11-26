'use strict';

/**
 * Rule 4 + Rule 10 — reporting, image validation, galleries, ownership.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { startDb, stopDb, loadApp, request } = require('./helpers/db');
const { registerAndVerify, createItem, pngBuffer, itemPayload } = require('./helpers/factory');
const { query } = require('../src/db/pool');
const mailer = require('../src/services/mailer');

let app;
let owner;
let stranger;

test.before(async () => {
  await startDb();
  app = loadApp();
  owner = await registerAndVerify(app, { name: 'Owner One', email: 'owner@saiuniversity.edu.in' });
  stranger = await registerAndVerify(app, { name: 'Other Student', email: 'other@saiuniversity.edu.in' });
});
test.after(async () => {
  await stopDb();
});
test.beforeEach(() => mailer.clearCaptured());

test('creating a report requires authentication', async () => {
  const res = await request(app).post('/api/items').field('title', 'Nope');
  assert.equal(res.status, 401);
});

test('a lost report with a photo is created and appears in the gallery', async () => {
  const res = await createItem(app, owner.token);
  assert.equal(res.status, 201, JSON.stringify(res.body));
  const item = res.body.item;

  assert.equal(item.type, 'lost');
  assert.equal(item.status, 'open');
  assert.equal(item.images.length, 1);
  assert.match(item.images[0].url, /^\/uploads\/public\//);
  assert.equal(item.images[0].mime, 'image/webp', 'images are re-encoded server-side');

  const gallery = await request(app).get('/api/items?type=lost');
  assert.equal(gallery.status, 200);
  assert.ok(gallery.body.total >= 1);
  assert.ok(gallery.body.items.some((i) => i.id === item.id));
});

test('the stored image is a real file on disk', async () => {
  const res = await createItem(app, owner.token, { title: 'File on disk check' });
  const url = res.body.item.images[0].url;
  const file = path.join(process.env.LOCAL_UPLOAD_DIR, url.replace('/uploads/', ''));
  assert.ok(fs.existsSync(file), 'the image must be written to storage');
  assert.ok(fs.statSync(file).size > 0);
});

test('a non-image upload is rejected with 400, not 500', async () => {
  const res = await request(app)
    .post('/api/items')
    .set('Authorization', `Bearer ${owner.token}`)
    .field('type', 'lost')
    .field('title', 'Text file')
    .field('category', 'Other')
    .field('description', 'This request attaches a text file instead of a photo.')
    .field('location', 'Library')
    .field('occurredOn', '2026-11-20')
    .attach('images', Buffer.from('not an image at all'), 'fake.png');

  assert.equal(res.status, 400);
  assert.ok(['invalid_image', 'unsupported_file_type'].includes(res.body.error.code));
});

test('a text file with an image extension is rejected by content sniffing', async () => {
  const res = await request(app)
    .post('/api/items')
    .set('Authorization', `Bearer ${owner.token}`)
    .field('type', 'found')
    .field('title', 'Sniff test')
    .field('category', 'Other')
    .field('description', 'Attaching a renamed text file to test content sniffing.')
    .field('location', 'Library')
    .field('occurredOn', '2026-11-20')
    .attach('images', Buffer.from('#!/bin/sh\necho hi'), {
      filename: 'photo.jpg',
      contentType: 'image/jpeg',
    });

  assert.equal(res.status, 400);
  assert.equal(res.body.error.code, 'invalid_image');
});

test('an oversized image is rejected with 413', async () => {
  const big = Buffer.alloc(3 * 1024 * 1024, 1); // 3 MB > MAX_UPLOAD_MB=2 in tests
  const res = await request(app)
    .post('/api/items')
    .set('Authorization', `Bearer ${owner.token}`)
    .field('type', 'found')
    .field('title', 'Big file')
    .field('category', 'Other')
    .field('description', 'A file larger than the configured upload limit.')
    .field('location', 'Library')
    .field('occurredOn', '2026-11-20')
    .attach('images', big, { filename: 'big.png', contentType: 'image/png' });

  assert.equal(res.status, 413);
});

test('invalid fields are rejected with field-level errors', async () => {
  const res = await request(app)
    .post('/api/items')
    .set('Authorization', `Bearer ${owner.token}`)
    .field('type', 'lost')
    .field('title', 'X')
    .field('category', 'Spaceships')
    .field('description', 'short')
    .field('location', 'L')
    .field('occurredOn', '3000-01-01');

  assert.equal(res.status, 400);
  const fields = res.body.error.fields;
  assert.ok(fields.title);
  assert.ok(fields.category);
  assert.ok(fields.description);
  assert.ok(fields.occurredOn);
});

test('the public detail view never exposes the owner email', async () => {
  const created = await createItem(app, owner.token, { title: 'Privacy check' });
  const res = await request(app).get(`/api/items/${created.body.item.id}`);
  assert.equal(res.status, 200);
  assert.equal(res.body.item.owner.name, 'Owner One');
  assert.doesNotMatch(JSON.stringify(res.body), /owner@saiuniversity\.edu\.in/);
});

test('the owner sees their own claims on the detail view', async () => {
  const created = await createItem(app, owner.token, { type: 'found', title: 'Found phone' });
  const itemId = created.body.item.id;
  await request(app)
    .post('/api/claims')
    .set('Authorization', `Bearer ${stranger.token}`)
    .send({ itemId, message: 'It has a cracked screen and a blue case, I can describe the lock screen.' });

  const res = await request(app)
    .get(`/api/items/${itemId}`)
    .set('Authorization', `Bearer ${owner.token}`);
  assert.equal(res.status, 200);
  assert.equal(res.body.item.claims.length, 1);
  assert.match(res.body.item.claims[0].message, /cracked screen/);
});

test('search, category, location and type filters combine', async () => {
  await createItem(app, owner.token, {
    title: 'Blue umbrella',
    category: 'Other',
    location: 'Sports Complex',
    type: 'found',
  });
  await createItem(app, owner.token, {
    title: 'Grey laptop bag',
    category: 'Bags',
    location: 'Computer Lab',
    type: 'lost',
  });

  const bySearch = await request(app).get('/api/items?search=umbrella');
  assert.ok(bySearch.body.items.some((i) => i.title === 'Blue umbrella'));

  const byCategory = await request(app).get('/api/items?category=Bags');
  assert.ok(byCategory.body.items.every((i) => i.category === 'Bags'));

  const byLocation = await request(app).get('/api/items?location=Computer');
  assert.ok(byLocation.body.items.some((i) => i.location === 'Computer Lab'));

  const combined = await request(app).get('/api/items?type=found&category=Other&location=Sports');
  assert.ok(combined.body.items.length >= 1);
  assert.ok(combined.body.items.every((i) => i.type === 'found' && i.category === 'Other'));
});

test('search input cannot inject SQL or regex operators', async () => {
  const res = await request(app).get(
    "/api/items?search=%27%20OR%201%3D1%3B%20DROP%20TABLE%20items%3B--"
  );
  assert.equal(res.status, 200);
  const stillThere = await query(`select count(*)::int as n from items`);
  assert.ok(stillThere.rows[0].n >= 1, 'the items table must still exist');
});

test('Mongo-style operator injection in query params is rejected', async () => {
  const res = await request(app).get('/api/items?status[$ne]=open');
  assert.equal(res.status, 400);
  assert.equal(res.body.error.code, 'validation_failed');
});

test('pagination reports the true total', async () => {
  for (let i = 0; i < 5; i += 1) {
    await createItem(app, owner.token, { title: `Pagination item ${i}` });
  }
  const res = await request(app).get('/api/items?limit=2&page=1');
  assert.equal(res.status, 200);
  assert.equal(res.body.items.length, 2);
  assert.ok(res.body.total >= 5);
  assert.ok(res.body.pages >= 3);
});

test('another student cannot edit or delete your report', async () => {
  const created = await createItem(app, owner.token, { title: 'Ownership test' });
  const id = created.body.item.id;

  const patch = await request(app)
    .patch(`/api/items/${id}`)
    .set('Authorization', `Bearer ${stranger.token}`)
    .send({ title: 'Hijacked title' });
  assert.equal(patch.status, 403);

  const del = await request(app)
    .delete(`/api/items/${id}`)
    .set('Authorization', `Bearer ${stranger.token}`);
  assert.equal(del.status, 403);
});

test('the owner can edit their report', async () => {
  const created = await createItem(app, owner.token, { title: 'Editable' });
  const res = await request(app)
    .patch(`/api/items/${created.body.item.id}`)
    .set('Authorization', `Bearer ${owner.token}`)
    .send({ title: 'Edited title', description: 'A much clearer description of the same item.' });
  assert.equal(res.status, 200);
  assert.equal(res.body.item.title, 'Edited title');
});

test('lifecycle transitions are enforced', async () => {
  const created = await createItem(app, owner.token, { title: 'Lifecycle' });
  const id = created.body.item.id;

  const closed = await request(app)
    .patch(`/api/items/${id}/status`)
    .set('Authorization', `Bearer ${owner.token}`)
    .send({ status: 'closed' });
  assert.equal(closed.status, 200);
  assert.equal(closed.body.item.status, 'closed');

  // An owner may not silently re-open a closed listing.
  const reopen = await request(app)
    .patch(`/api/items/${id}/status`)
    .set('Authorization', `Bearer ${owner.token}`)
    .send({ status: 'open' });
  assert.equal(reopen.status, 403);

  // Nor can they set "claimed" by hand: only a claim approval does that.
  const created2 = await createItem(app, owner.token, { title: 'Lifecycle 2' });
  const claimByHand = await request(app)
    .patch(`/api/items/${created2.body.item.id}/status`)
    .set('Authorization', `Bearer ${owner.token}`)
    .send({ status: 'claimed' });
  assert.equal(claimByHand.status, 409);
});

test('deleting hides the listing from the gallery but keeps the record', async () => {
  const created = await createItem(app, owner.token, { title: 'To be removed' });
  const id = created.body.item.id;

  const del = await request(app).delete(`/api/items/${id}`).set('Authorization', `Bearer ${owner.token}`);
  assert.equal(del.status, 200);

  const gallery = await request(app).get('/api/items?search=To be removed');
  assert.equal(gallery.body.items.length, 0, 'removed items must not appear publicly');

  const row = await query(`select status from items where id = $1`, [id]);
  assert.equal(row.rows[0].status, 'removed');
});

test('my listings returns only my own reports', async () => {
  await createItem(app, owner.token, { title: 'Mine only' });
  const mine = await request(app).get('/api/items/mine').set('Authorization', `Bearer ${owner.token}`);
  assert.equal(mine.status, 200);
  assert.ok(mine.body.items.length >= 1);
  assert.ok(mine.body.items.every((i) => i.owner.name === 'Owner One'));

  const theirs = await request(app)
    .get('/api/items/mine')
    .set('Authorization', `Bearer ${stranger.token}`);
  assert.equal(theirs.body.items.length, 0);
});

test('public stats count real rows', async () => {
  const res = await request(app).get('/api/items/stats/public');
  assert.equal(res.status, 200);
  assert.ok(res.body.stats.total >= 1);
  assert.ok(Array.isArray(res.body.locations));
});

test('an invalid item id returns 400, not 500', async () => {
  const res = await request(app).get('/api/items/not-a-uuid');
  assert.equal(res.status, 400);
});
