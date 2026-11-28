'use strict';

/**
 * Administrator data access. Every function here assumes the caller has
 * already passed `authenticate` + `requireRole('admin')` — the route layer
 * enforces that, and nothing in this file is reachable without it.
 */

const { query, withTransaction } = require('../db/pool');
const { conflict, forbidden, notFound, badRequest } = require('../lib/errors');
const audit = require('./auditService');
const authService = require('./authService');

async function overview() {
  const { rows } = await query(`
    select
      (select count(*)::int from users where role = 'student')                        as total_students,
      (select count(*)::int from users)                                              as total_users,
      (select count(*)::int from users where is_email_verified)                      as verified_users,
      (select count(*)::int from users where not is_email_verified)                  as unverified_users,
      (select count(*)::int from users where status = 'suspended')                   as suspended_users,
      (select count(*)::int from users where created_at > now() - interval '7 days')  as new_users_7d,
      (select count(*)::int from items where type = 'lost' and status <> 'removed')   as lost_items,
      (select count(*)::int from items where type = 'found' and status <> 'removed')  as found_items,
      (select count(*)::int from items where status = 'returned')                     as returned_items,
      (select count(*)::int from items where moderation_status = 'pending')           as pending_moderation,
      (select count(*)::int from claims)                                             as total_claims,
      (select count(*)::int from claims where status = 'pending')                     as pending_claims,
      (select count(*)::int from user_sessions where status = 'active' and expires_at > now()) as active_sessions,
      (select count(*)::int from auth_events where event = 'login_failed'
         and created_at > now() - interval '24 hours')                                as failed_logins_24h
  `);
  return rows[0];
}

async function listUsers({ search = '', page = 1, limit = 20, role = null, status = null, verified = null }) {
  const params = [];
  const where = ['1=1'];
  if (search) {
    params.push(`%${search}%`);
    where.push(`(u.name ilike $${params.length} or u.email ilike $${params.length})`);
  }
  if (role) {
    params.push(role);
    where.push(`u.role = $${params.length}`);
  }
  if (status) {
    params.push(status);
    where.push(`u.status = $${params.length}`);
  }
  if (verified !== null) {
    params.push(verified);
    where.push(`u.is_email_verified = $${params.length}`);
  }
  const whereSql = `where ${where.join(' and ')}`;

  const countRes = await query(`select count(*)::int as n from users u ${whereSql}`, params);
  const total = countRes.rows[0].n;

  const rows = await query(
    `select u.id, u.name, u.email, u.role, u.status, u.is_email_verified,
            u.created_at, u.last_login_at, u.email_verified_at, u.department, u.student_id,
            (select count(*)::int from items i where i.owner_id = u.id and i.status <> 'removed') as report_count,
            (select count(*)::int from user_sessions s where s.user_id = u.id and s.status = 'active'
               and s.expires_at > now()) as active_sessions
       from users u ${whereSql}
      order by u.created_at desc
      limit $${params.length + 1} offset $${params.length + 2}`,
    [...params, limit, (page - 1) * limit]
  );

  return {
    users: rows.rows,
    page,
    limit,
    total,
    pages: Math.max(1, Math.ceil(total / limit)),
  };
}

async function updateUser({ targetId, actor, patch, ip = null }) {
  if (targetId === actor.id && (patch.role || patch.status)) {
    throw badRequest('You cannot change your own role or status');
  }
  const { rows } = await query(`select id, email, role, status from users where id = $1`, [targetId]);
  const target = rows[0];
  if (!target) throw notFound('That account could not be found');

  if (patch.role && target.role === 'admin' && patch.role !== 'admin') {
    const { rows: admins } = await query(
      `select count(*)::int as n from users where role = 'admin' and status = 'active'`
    );
    if (admins[0].n <= 1) throw conflict('There must always be at least one active administrator');
  }

  const sets = [];
  const values = [];
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    values.push(value);
    sets.push(`${key} = $${values.length}`);
  }
  if (!sets.length) throw badRequest('Nothing to update');
  values.push(targetId);

  const updated = await query(
    `update users set ${sets.join(', ')} where id = $${values.length}
     returning id, name, email, role, status, is_email_verified, created_at, last_login_at`,
    values
  );

  if (patch.status === 'suspended') {
    // A suspended account must not keep working sessions.
    await authService.revokeAllSessions(targetId);
  }

  await audit.record({
    actor,
    action: 'user.updated',
    targetType: 'user',
    targetId,
    details: { changes: patch, previous: { role: target.role, status: target.status } },
    ip,
  });

  return updated.rows[0];
}

async function listSessions({ userId = null, status = null, page = 1, limit = 25 }) {
  const params = [];
  const where = ['1=1'];
  if (userId) {
    params.push(userId);
    where.push(`s.user_id = $${params.length}`);
  }
  if (status) {
    params.push(status);
    where.push(`s.status = $${params.length}`);
  }
  const whereSql = `where ${where.join(' and ')}`;

  const countRes = await query(`select count(*)::int as n from user_sessions s ${whereSql}`, params);
  const total = countRes.rows[0].n;

  const rows = await query(
    `select s.id, s.session_id, s.login_at, s.logout_at, s.last_activity_at, s.expires_at,
            s.status, s.logout_reason, s.ip, s.user_agent,
            u.name as user_name, u.email
       from user_sessions s join users u on u.id = s.user_id
       ${whereSql}
      order by s.login_at desc
      limit $${params.length + 1} offset $${params.length + 2}`,
    [...params, limit, (page - 1) * limit]
  );

  return {
    sessions: rows.rows,
    page,
    limit,
    total,
    pages: Math.max(1, Math.ceil(total / limit)),
  };
}

async function listAuthEvents({ page = 1, limit = 25, event = null, email = null }) {
  const params = [];
  const where = ['1=1'];
  if (event) {
    params.push(event);
    where.push(`event = $${params.length}`);
  }
  if (email) {
    params.push(`%${email.toLowerCase()}%`);
    where.push(`lower(email) like $${params.length}`);
  }
  const whereSql = `where ${where.join(' and ')}`;
  const countRes = await query(`select count(*)::int as n from auth_events ${whereSql}`, params);
  const rows = await query(
    `select id, user_id, email, event, outcome, reason, ip, created_at
       from auth_events ${whereSql}
      order by created_at desc
      limit $${params.length + 1} offset $${params.length + 2}`,
    [...params, limit, (page - 1) * limit]
  );
  const total = countRes.rows[0].n;
  return { events: rows.rows, page, limit, total, pages: Math.max(1, Math.ceil(total / limit)) };
}

async function listItems({ search = '', type = null, status = null, moderation = null, page = 1, limit = 20 }) {
  const params = [];
  const where = ['1=1'];
  if (search) {
    params.push(`%${search}%`);
    where.push(`(i.title ilike $${params.length} or i.location ilike $${params.length})`);
  }
  if (type) {
    params.push(type);
    where.push(`i.type = $${params.length}`);
  }
  if (status) {
    params.push(status);
    where.push(`i.status = $${params.length}`);
  }
  if (moderation) {
    params.push(moderation);
    where.push(`i.moderation_status = $${params.length}`);
  }
  const whereSql = `where ${where.join(' and ')}`;
  const countRes = await query(`select count(*)::int as n from items i ${whereSql}`, params);
  const total = countRes.rows[0].n;

  const rows = await query(
    `select i.id, i.type, i.title, i.category, i.location, i.status, i.moderation_status,
            i.images, i.created_at, i.occurred_on, i.view_count,
            u.name as owner_name, u.email as owner_email, u.id as owner_id,
            (select count(*)::int from claims c where c.item_id = i.id) as claim_count
       from items i join users u on u.id = i.owner_id
       ${whereSql}
      order by i.created_at desc
      limit $${params.length + 1} offset $${params.length + 2}`,
    [...params, limit, (page - 1) * limit]
  );

  return {
    items: rows.rows,
    page,
    limit,
    total,
    pages: Math.max(1, Math.ceil(total / limit)),
  };
}

async function moderateItem({ id, actor, action, note = null, ip = null }) {
  // Moderation owns visibility; it must not overwrite the lifecycle. Hiding a
  // listing therefore leaves `status` untouched, so restoring a returned item
  // brings back a returned item rather than resurrecting it as 'open' (F7).
  // `status: null` = leave it alone. Restore additionally un-removes a listing
  // that the owner had deleted (status 'removed').
  const map = {
    approve: { moderation_status: 'approved', status: 'unremove' },
    reject: { moderation_status: 'rejected', status: null },
    remove: { moderation_status: 'rejected', status: null },
    restore: { moderation_status: 'approved', status: 'unremove' },
  };
  if (!map[action]) throw badRequest('Unknown moderation action');

  const { rows } = await query(`select id, status, moderation_status from items where id = $1`, [id]);
  const item = rows[0];
  if (!item) throw notFound('That item could not be found');

  await withTransaction(async (client) => {
    const target = map[action];
    if (target.status === 'unremove') {
      await client.query(
        `update items
            set moderation_status = $2,
                status = case when status = 'removed' then 'open' else status end
          where id = $1`,
        [id, target.moderation_status]
      );
    } else if (target.status) {
      await client.query(`update items set moderation_status = $2, status = $3 where id = $1`, [
        id,
        target.moderation_status,
        target.status,
      ]);
    } else {
      await client.query(`update items set moderation_status = $2 where id = $1`, [
        id,
        target.moderation_status,
      ]);
    }
    if (action === 'remove' || action === 'reject') {
      // F5: a hidden listing must not keep live claims — the owner could still
      // approve one and promise an item that is not publicly visible.
      await client.query(
        `update claims set status = 'rejected', decided_at = coalesce(decided_at, now()),
                decision_note = coalesce(decision_note, $2)
          where item_id = $1 and status = 'pending'`,
        [id, action === 'remove' ? 'Listing removed by a moderator' : 'Listing rejected by a moderator']
      );
    }
    await audit.record(
      {
        actor,
        action: `item.${action}`,
        targetType: 'item',
        targetId: id,
        details: { note, previous: { status: item.status, moderation: item.moderation_status } },
        ip,
      },
      client
    );
  });

  return { id, action };
}

async function listClaims({ status = null, page = 1, limit = 20 }) {
  const params = [];
  const where = ['1=1'];
  if (status) {
    params.push(status);
    where.push(`c.status = $${params.length}`);
  }
  const whereSql = `where ${where.join(' and ')}`;
  const countRes = await query(`select count(*)::int as n from claims c ${whereSql}`, params);
  const total = countRes.rows[0].n;

  const rows = await query(
    `select c.id, c.status, c.message, c.decision_note, c.created_at, c.decided_at,
            i.id as item_id, i.title as item_title, i.type as item_type,
            claimant.name as claimant_name, claimant.email as claimant_email,
            owner.name as owner_name
       from claims c
       join items i on i.id = c.item_id
       join users claimant on claimant.id = c.claimant_id
       join users owner on owner.id = i.owner_id
       ${whereSql}
      order by case c.status when 'pending' then 0 else 1 end, c.created_at desc
      limit $${params.length + 1} offset $${params.length + 2}`,
    [...params, limit, (page - 1) * limit]
  );

  return {
    claims: rows.rows,
    page,
    limit,
    total,
    pages: Math.max(1, Math.ceil(total / limit)),
  };
}

module.exports = {
  overview,
  listUsers,
  updateUser,
  listSessions,
  listAuthEvents,
  listItems,
  moderateItem,
  listClaims,
};
