'use strict';

const { query } = require('../db/pool');
const logger = require('../lib/logger');

/**
 * Append-only audit trail for privileged actions.
 * Written inside the same transaction as the change wherever possible, so an
 * action can never happen without its record.
 */
async function record({ actor, action, targetType = null, targetId = null, details = {}, ip = null }, client = null) {
  const run = client ? client.query.bind(client) : query;
  try {
    await run(
      `insert into admin_audit_logs (actor_id, actor_email, action, target_type, target_id, details, ip)
       values ($1, $2, $3, $4, $5, $6, $7)`,
      [actor?.id || null, actor?.email || null, action, targetType, targetId, details, ip]
    );
  } catch (err) {
    logger.error('audit write failed', { action, message: err.message });
    throw err;
  }
}

async function list({ page = 1, limit = 25, action = null }) {
  const offset = (page - 1) * limit;
  const params = [];
  let where = 'where 1=1';
  if (action) {
    params.push(action);
    where += ` and action = $${params.length}`;
  }
  const countQ = await query(`select count(*)::int as n from admin_audit_logs ${where}`, params);
  params.push(limit, offset);
  const rows = await query(
    `select id, actor_id, actor_email, action, target_type, target_id, details, ip, created_at
       from admin_audit_logs ${where}
      order by created_at desc
      limit $${params.length - 1} offset $${params.length}`,
    params
  );
  const total = countQ.rows[0].n;
  return { logs: rows.rows, page, limit, total, pages: Math.max(1, Math.ceil(total / limit)) };
}

module.exports = { record, list };
