'use strict';

/**
 * Items: lost/found reports, public galleries, lifecycle.
 *
 * Public reads only ever see rows that are approved and not removed, and the
 * owner's email address is never part of a public response — only a display
 * name. Lifecycle changes go through an explicit transition map so a listing
 * cannot jump from "returned" back to "open" and confuse the claim flow.
 */

const { query, withTransaction } = require('../db/pool');
const { AppError, badRequest, forbidden, notFound, conflict } = require('../lib/errors');
const storage = require('./storage');

const CATEGORIES = [
  'Electronics',
  'Books',
  'ID Cards',
  'Bags',
  'Clothing',
  'Accessories',
  'Documents',
  'Keys',
  'Other',
];

const STATUSES = ['open', 'claimed', 'returned', 'closed', 'removed'];

/** Which lifecycle moves are legal, and who may perform them. */
const TRANSITIONS = {
  open: { closed: ['owner', 'admin'], returned: ['owner', 'admin'] },
  claimed: { returned: ['owner', 'admin'], open: ['admin'] },
  returned: { closed: ['owner', 'admin'] },
  closed: { open: ['admin'] },
  removed: { open: ['admin'] },
};

const PUBLIC_COLUMNS = `i.id, i.type, i.title, i.category, i.description, i.location,
  i.occurred_on, i.occurred_time, i.additional_info, i.status, i.images, i.view_count,
  i.returned_at, i.created_at, i.updated_at, u.name as owner_name`;

function assertTransition(item, nextStatus, role) {
  const allowed = TRANSITIONS[item.status] || {};
  const actors = allowed[nextStatus];
  if (!actors) {
    throw conflict(`An item that is "${item.status}" cannot be marked "${nextStatus}"`);
  }
  if (!actors.includes(role)) {
    throw forbidden(`Only the ${actors.join(' or ')} can make that change`);
  }
}

function shapeItem(row) {
  if (!row) return null;
  return {
    id: row.id,
    type: row.type,
    title: row.title,
    category: row.category,
    description: row.description,
    location: row.location,
    occurredOn: row.occurred_on,
    occurredTime: row.occurred_time,
    additionalInfo: row.additional_info,
    status: row.status,
    images: row.images || [],
    viewCount: row.view_count,
    returnedAt: row.returned_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    owner: { id: row.owner_id || null, name: row.owner_name || 'Campus member' },
    claimCount: row.claim_count !== undefined ? Number(row.claim_count) : undefined,
  };
}

/* --------------------------------- create ---------------------------------- */

async function createItem({ user, data, processedImages = [] }) {
  const images = await storage.saveImages(processedImages, storage.PUBLIC_PREFIX);
  const { rows } = await query(
    `insert into items (owner_id, type, title, category, description, location,
                        occurred_on, occurred_time, additional_info, images, moderation_status)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,'approved')
     returning id`,
    [
      user.id,
      data.type,
      data.title.trim(),
      data.category,
      data.description.trim(),
      data.location.trim(),
      data.occurredOn,
      data.occurredTime || null,
      data.additionalInfo ? data.additionalInfo.trim() : null,
      JSON.stringify(images),
    ]
  );
  return getItem(rows[0].id, { viewer: user });
}

/* ---------------------------------- read ----------------------------------- */

async function listItems({ filters = {}, page = 1, limit = 12 }) {
  const params = [];
  const where = [`i.moderation_status = 'approved'`, `i.status <> 'removed'`];

  if (filters.type) {
    params.push(filters.type);
    where.push(`i.type = $${params.length}`);
  }
  if (filters.category) {
    params.push(filters.category);
    where.push(`i.category = $${params.length}`);
  }
  if (filters.status) {
    params.push(filters.status);
    where.push(`i.status = $${params.length}`);
  }
  if (filters.location) {
    params.push(`%${filters.location}%`);
    where.push(`i.location ilike $${params.length}`);
  }
  if (filters.search) {
    params.push(filters.search);
    where.push(`i.search_vector @@ websearch_to_tsquery('english', $${params.length})`);
  }

  const whereSql = `where ${where.join(' and ')}`;
  const order =
    filters.sort === 'oldest'
      ? 'i.created_at asc'
      : filters.sort === 'recent'
        ? 'i.occurred_on desc'
        : 'i.created_at desc';

  const countRes = await query(`select count(*)::int as n from items i ${whereSql}`, params);
  const total = countRes.rows[0].n;
  const offset = (page - 1) * limit;

  const rows = await query(
    `select ${PUBLIC_COLUMNS}
       from items i
       join users u on u.id = i.owner_id
       ${whereSql}
      order by ${order}
      limit $${params.length + 1} offset $${params.length + 2}`,
    [...params, limit, offset]
  );

  return {
    items: rows.rows.map(shapeItem),
    page,
    limit,
    total,
    pages: Math.max(1, Math.ceil(total / limit)),
  };
}

async function getItem(id, { viewer = null } = {}) {
  const { rows } = await query(
    `select ${PUBLIC_COLUMNS}, i.owner_id,
            (select count(*) from claims c where c.item_id = i.id and c.status <> 'withdrawn') as claim_count
       from items i
       join users u on u.id = i.owner_id
      where i.id = $1`,
    [id]
  );
  const row = rows[0];
  if (!row) throw notFound('That item could not be found');

  const isOwner = viewer && viewer.id === row.owner_id;
  const isAdmin = viewer && viewer.role === 'admin';
  if (row.status === 'removed' && !isOwner && !isAdmin) {
    throw notFound('That item could not be found');
  }

  if (!isOwner && !isAdmin) {
    await query(`update items set view_count = view_count + 1 where id = $1`, [id]);
  }

  const item = shapeItem(row);
  if (viewer) {
    const { rows: mine } = await query(
      `select id, status, created_at from claims
        where item_id = $1 and claimant_id = $2
        order by created_at desc limit 1`,
      [id, viewer.id]
    );
    item.myClaim = mine[0] ? { id: mine[0].id, status: mine[0].status } : null;
  }
  if (isOwner || isAdmin) {
    const { rows: claims } = await query(
      `select c.id, c.status, c.message, c.created_at, u.name as claimant_name
         from claims c join users u on u.id = c.claimant_id
        where c.item_id = $1 order by c.created_at desc`,
      [id]
    );
    item.claims = claims.map((c) => ({
      id: c.id,
      status: c.status,
      message: c.message,
      createdAt: c.created_at,
      claimantName: c.claimant_name,
    }));
  }
  item.isOwner = Boolean(isOwner);
  return item;
}

async function listMine(userId) {
  const { rows } = await query(
    `select ${PUBLIC_COLUMNS},
            (select count(*) from claims c where c.item_id = i.id and c.status = 'pending') as claim_count
       from items i join users u on u.id = i.owner_id
      where i.owner_id = $1 and i.status <> 'removed'
      order by i.created_at desc`,
    [userId]
  );
  return rows.map(shapeItem);
}

async function publicStats() {
  const { rows } = await query(
    `select
       count(*) filter (where status <> 'removed')::int as total,
       count(*) filter (where type = 'lost' and status <> 'removed')::int as lost,
       count(*) filter (where type = 'found' and status <> 'removed')::int as found,
       count(*) filter (where status = 'returned')::int as returned
     from items where moderation_status = 'approved'`
  );
  return rows[0];
}

async function locationSuggestions() {
  const { rows } = await query(
    `select location, count(*)::int as n
       from items
      where moderation_status = 'approved' and status <> 'removed'
      group by location order by n desc limit 20`
  );
  return rows.map((r) => r.location);
}

/* --------------------------------- update ---------------------------------- */

async function updateItem(id, user, patch) {
  const { rows } = await query(`select owner_id, status, images from items where id = $1`, [id]);
  const item = rows[0];
  if (!item) throw notFound('That item could not be found');
  const isOwner = item.owner_id === user.id;
  if (!isOwner && user.role !== 'admin') throw forbidden('You can only edit your own reports');

  const sets = [];
  const values = [];
  const map = {
    title: 'title',
    category: 'category',
    description: 'description',
    location: 'location',
    occurredOn: 'occurred_on',
    occurredTime: 'occurred_time',
    additionalInfo: 'additional_info',
  };
  for (const [key, column] of Object.entries(map)) {
    if (patch[key] !== undefined) {
      values.push(patch[key] === '' ? null : patch[key]);
      sets.push(`${column} = $${values.length}`);
    }
  }
  if (!sets.length) return getItem(id, { viewer: user });

  values.push(id);
  await query(`update items set ${sets.join(', ')} where id = $${values.length}`, values);
  return getItem(id, { viewer: user });
}

async function setStatus(id, user, nextStatus) {
  const { rows } = await query(`select id, owner_id, status, type from items where id = $1`, [id]);
  const item = rows[0];
  if (!item) throw notFound('That item could not be found');
  const role = item.owner_id === user.id ? 'owner' : user.role === 'admin' ? 'admin' : 'other';
  if (role === 'other') throw forbidden('You can only change your own reports');

  assertTransition(item, nextStatus, role);

  // F4: "returned" must not strand live claims. Either the claim flow completes
  // them, or an administrator closes them explicitly.
  if (nextStatus === 'returned' && role !== 'admin') {
    const live = await query(
      `select count(*)::int as n from claims
        where item_id = $1 and status in ('pending', 'approved')`,
      [id]
    );
    if (live.rows[0].n > 0) {
      throw conflict(
        'This listing has an open claim. Complete the claim from your dashboard (or ask an administrator) instead of marking it returned directly.'
      );
    }
  }

  await query(
    `update items
        set status = $2,
            returned_at = case when $2 = 'returned' then now() else returned_at end,
            closed_at = case when $2 = 'closed' then now() else closed_at end
      where id = $1`,
    [id, nextStatus]
  );
  return getItem(id, { viewer: user });
}

/** Soft delete: the row is kept (with its claim history) but disappears publicly. */
async function removeItem(id, user) {
  const { rows } = await query(`select owner_id from items where id = $1`, [id]);
  const item = rows[0];
  if (!item) throw notFound('That item could not be found');
  if (item.owner_id !== user.id && user.role !== 'admin') {
    throw forbidden('You can only delete your own reports');
  }
  await withTransaction(async (client) => {
    await client.query(
      `update items set status = 'removed', moderation_status = 'rejected' where id = $1`,
      [id]
    );
    await client.query(
      `update claims set status = 'rejected', decision_note = coalesce(decision_note, 'Listing removed')
        where item_id = $1 and status = 'pending'`,
      [id]
    );
  });
  return { removed: true, id };
}

module.exports = {
  CATEGORIES,
  STATUSES,
  TRANSITIONS,
  createItem,
  listItems,
  getItem,
  listMine,
  publicStats,
  locationSuggestions,
  updateItem,
  setStatus,
  removeItem,
  shapeItem,
};
