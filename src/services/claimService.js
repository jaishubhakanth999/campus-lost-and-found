'use strict';

/**
 * Claims and item recovery.
 *
 * This module is where the previous version was most dangerous: a claim could
 * be approved twice, an approved claim could be rejected afterwards, and the
 * owner could not even read the claim message. All three are fixed here:
 *
 *  * decide() runs inside a transaction and locks the claim and item rows.
 *  * the item is moved open → claimed with a conditional UPDATE, so a second
 *    approval cannot succeed even under a race.
 *  * a decision is only possible from "pending"; everything else is a 409.
 *  * completing a claim is a separate, explicit step that marks the item
 *    returned, so "returned" always has a matching completed claim.
 */

const { query, withTransaction } = require('../db/pool');
const { badRequest, forbidden, notFound, conflict } = require('../lib/errors');
const storage = require('./storage');
const mailer = require('./mailer');
const templates = require('./emailTemplates');
const audit = require('./auditService');
const logger = require('../lib/logger');

const CLAIM_SELECT = `
  select c.id, c.item_id, c.claimant_id, c.message, c.evidence, c.status,
         c.decided_at, c.decision_note, c.handover_place, c.handover_at,
         c.completed_at, c.created_at, c.updated_at,
         i.title as item_title, i.type as item_type, i.status as item_status,
         i.owner_id, owner.name as owner_name,
         claimant.name as claimant_name, claimant.email as claimant_email
    from claims c
    join items i on i.id = c.item_id
    join users owner on owner.id = i.owner_id
    join users claimant on claimant.id = c.claimant_id`;

function shape(row, { includeContact = false } = {}) {
  if (!row) return null;
  return {
    id: row.id,
    itemId: row.item_id,
    itemTitle: row.item_title,
    itemType: row.item_type,
    itemStatus: row.item_status,
    status: row.status,
    message: row.message,
    evidence: (row.evidence || []).map((e) => ({ key: e.key, width: e.width, height: e.height })),
    decisionNote: row.decision_note,
    decidedAt: row.decided_at,
    handover: row.handover_place || row.handover_at
      ? { place: row.handover_place, at: row.handover_at }
      : null,
    completedAt: row.completed_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    claimant: {
      id: row.claimant_id,
      name: row.claimant_name,
      ...(includeContact ? { email: row.claimant_email } : {}),
    },
    owner: { id: row.owner_id, name: row.owner_name },
  };
}

/* --------------------------------- submit ---------------------------------- */

async function submit({ user, itemId, message, processedImages = [] }) {
  const { rows } = await query(
    `select id, owner_id, status, moderation_status, title, type from items where id = $1`,
    [itemId]
  );
  const item = rows[0];
  if (!item) throw notFound('That item could not be found');
  if (item.owner_id === user.id) throw badRequest('You cannot claim your own listing');
  if (item.type !== 'found') {
    throw badRequest('Only found items can be claimed. If you found this item, report it as found.');
  }
  if (item.status !== 'open') throw conflict('This item is no longer open for claims');
  if (item.moderation_status !== 'approved') throw conflict('This listing is not available');

  // F8: a suspended owner can never review a claim, so accepting one would strand it.
  const ownerRow = await query(`select status from users where id = $1`, [item.owner_id]);
  if (!ownerRow.rows[0] || ownerRow.rows[0].status !== 'active') {
    throw conflict("This listing's owner is currently unavailable. Please contact the campus help desk.");
  }

  const evidence = await storage.saveImages(processedImages, storage.PRIVATE_PREFIX);

  let claim;
  try {
    const inserted = await query(
      `insert into claims (item_id, claimant_id, message, evidence)
       values ($1, $2, $3, $4::jsonb)
       returning id`,
      [itemId, user.id, message.trim(), JSON.stringify(evidence)]
    );
    claim = inserted.rows[0];
  } catch (err) {
    // F18: the images were already written to the private bucket; remove them so
    // a refused claim does not leave files nothing references.
    await Promise.all(evidence.map((e) => storage.deleteImage(e.key).catch(() => {})));
    if (err.code === '23505') {
      throw conflict('You already have an active claim on this item');
    }
    throw err;
  }

  // Notify the owner (best effort — never blocks the claim).
  const { rows: ownerRows } = await query(`select name, email from users where id = $1`, [
    item.owner_id,
  ]);
  if (ownerRows[0]) {
    mailer
      .send({
        to: ownerRows[0].email,
        ...templates.claimReceivedEmail({
          ownerName: ownerRows[0].name,
          claimantName: user.name,
          itemTitle: item.title,
          claimMessage: message.trim().slice(0, 400),
          itemUrl: templates.absolute(`/item.html?id=${itemId}`),
        }),
      })
      .catch((err) => logger.warn('claim email failed', { message: err.message }));
  }

  const { rows: full } = await query(`${CLAIM_SELECT} where c.id = $1`, [claim.id]);
  return shape(full[0]);
}

/* ---------------------------------- read ----------------------------------- */

async function listMine(userId) {
  const { rows } = await query(
    `${CLAIM_SELECT} where c.claimant_id = $1 order by c.created_at desc`,
    [userId]
  );
  return rows.map((r) => shape(r));
}

async function listReceived(userId) {
  const { rows } = await query(
    `${CLAIM_SELECT} where i.owner_id = $1 order by
       case c.status when 'pending' then 0 else 1 end, c.created_at desc`,
    [userId]
  );
  return rows.map((r) => shape(r, { includeContact: true }));
}

async function getOne(claimId, user) {
  const { rows } = await query(`${CLAIM_SELECT} where c.id = $1`, [claimId]);
  const row = rows[0];
  if (!row) throw notFound('That claim could not be found');
  const isOwner = row.owner_id === user.id;
  const isClaimant = row.claimant_id === user.id;
  if (!isOwner && !isClaimant && user.role !== 'admin') throw forbidden();
  return shape(row, { includeContact: isOwner || user.role === 'admin' });
}

/** Short-lived signed links for private claim evidence. */
async function evidenceLinks(claimId, user) {
  const { rows } = await query(
    `select c.id, c.evidence, i.owner_id, c.claimant_id
       from claims c join items i on i.id = c.item_id where c.id = $1`,
    [claimId]
  );
  const row = rows[0];
  if (!row) throw notFound('That claim could not be found');
  if (row.owner_id !== user.id && row.claimant_id !== user.id && user.role !== 'admin') {
    throw forbidden();
  }
  const out = [];
  for (const e of row.evidence || []) {
    out.push({ key: e.key, url: await storage.signedUrl(e.key, 300) });
  }
  return out;
}

/* --------------------------------- decide ---------------------------------- */

async function decide({ claimId, actor, decision, note = null, ip = null }) {
  if (!['approved', 'rejected'].includes(decision)) {
    throw badRequest('Decision must be approved or rejected');
  }

  const outcome = await withTransaction(async (client) => {
    const { rows } = await client.query(
      `select c.id, c.status, c.item_id, c.claimant_id, c.message,
              i.owner_id, i.status as item_status, i.title
         from claims c
         join items i on i.id = c.item_id
        where c.id = $1
        for update of c, i`,
      [claimId]
    );
    const claim = rows[0];
    if (!claim) throw notFound('That claim could not be found');
    if (claim.owner_id !== actor.id && actor.role !== 'admin') {
      throw forbidden('Only the listing owner can review this claim');
    }
    // F3: an administrator reviewing a claim they filed themselves is self-dealing.
    if (claim.claimant_id === actor.id) {
      throw forbidden('You cannot decide a claim you submitted yourself');
    }
    if (claim.status !== 'pending') {
      throw conflict(`This claim was already ${claim.status.replace('_', ' ')}`);
    }

    if (decision === 'approved') {
      // Conditional update: only the request that finds the item "open" wins.
      const moved = await client.query(
        `update items set status = 'claimed'
          where id = $1 and status = 'open' and moderation_status = 'approved'
          returning id`,
        [claim.item_id]
      );
      if (!moved.rowCount) throw conflict('This item is no longer open for claims');

      await client.query(
        `update claims
            set status = 'approved', decided_by = $2, decided_at = now(), decision_note = $3
          where id = $1`,
        [claimId, actor.id, note]
      );
      await client.query(
        `update claims
            set status = 'rejected', decided_by = $2, decided_at = now(),
                decision_note = 'Another claim was approved for this item'
          where item_id = $1 and id <> $3 and status = 'pending'`,
        [claim.item_id, actor.id, claimId]
      );
    } else {
      await client.query(
        `update claims
            set status = 'rejected', decided_by = $2, decided_at = now(), decision_note = $3
          where id = $1`,
        [claimId, actor.id, note]
      );
    }

    await audit.record(
      {
        actor,
        action: `claim.${decision}`,
        targetType: 'claim',
        targetId: claimId,
        details: { itemId: claim.item_id, note },
        ip,
      },
      client
    );

    return { claim, decision };
  });

  // Notifications after the commit so a mail failure cannot roll back the decision.
  const { rows: claimantRows } = await query(`select name, email from users where id = $1`, [
    outcome.claim.claimant_id,
  ]);
  if (claimantRows[0]) {
    mailer
      .send({
        to: claimantRows[0].email,
        ...templates.claimDecisionEmail({
          claimantName: claimantRows[0].name,
          itemTitle: outcome.claim.title,
          decision,
          note,
          itemUrl: templates.absolute(`/item.html?id=${outcome.claim.item_id}`),
        }),
      })
      .catch((err) => logger.warn('decision email failed', { message: err.message }));
  }

  const { rows } = await query(`${CLAIM_SELECT} where c.id = $1`, [claimId]);
  return shape(rows[0]);
}

/* --------------------------------- lifecycle -------------------------------- */

async function withdraw({ claimId, user }) {
  const { rows } = await query(`select id, claimant_id, status from claims where id = $1`, [claimId]);
  const claim = rows[0];
  if (!claim) throw notFound('That claim could not be found');
  if (claim.claimant_id !== user.id) throw forbidden('You can only withdraw your own claim');
  if (claim.status !== 'pending') throw conflict(`This claim is already ${claim.status}`);
  await query(`update claims set status = 'withdrawn' where id = $1`, [claimId]);
  return { withdrawn: true };
}

async function proposeHandover({ claimId, user, place, at }) {
  const { rows } = await query(
    `select c.id, c.status, c.claimant_id, i.id as item_id, i.owner_id, i.title
       from claims c join items i on i.id = c.item_id where c.id = $1`,
    [claimId]
  );
  const claim = rows[0];
  if (!claim) throw notFound('That claim could not be found');
  if (claim.owner_id !== user.id && user.role !== 'admin') {
    throw forbidden('Only the listing owner can propose a handover');
  }
  if (claim.status !== 'approved') throw conflict('Only an approved claim can be handed over');

  await query(
    `update claims set handover_place = $2, handover_at = $3 where id = $1`,
    [claimId, place, at || null]
  );

  const { rows: claimantRows } = await query(`select name, email from users where id = $1`, [
    claim.claimant_id,
  ]);
  if (claimantRows[0]) {
    mailer
      .send({
        to: claimantRows[0].email,
        ...templates.claimDecisionEmail({
          claimantName: claimantRows[0].name,
          itemTitle: claim.title,
          decision: 'approved',
          note: `Handover arranged: ${place}${at ? ` at ${new Date(at).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })}` : ''}`,
          itemUrl: templates.absolute(`/item.html?id=${claim.item_id}`),
        }),
      })
      .catch(() => {});
  }

  return getOne(claimId, user);
}

async function complete({ claimId, user, ip = null }) {
  const result = await withTransaction(async (client) => {
    const { rows } = await client.query(
      `select c.id, c.status, c.claimant_id, i.id as item_id, i.owner_id, i.title,
              i.status as item_status
         from claims c join items i on i.id = c.item_id
        where c.id = $1
        for update of c, i`,
      [claimId]
    );
    const claim = rows[0];
    if (!claim) throw notFound('That claim could not be found');
    const isParty = claim.owner_id === user.id || claim.claimant_id === user.id;
    if (!isParty && user.role !== 'admin') throw forbidden();
    if (claim.status !== 'approved') {
      throw conflict('Only an approved claim can be completed');
    }
    // The listing was removed after the approval: completing it would leave the
    // claim "completed" while the item reads "removed".
    if (claim.item_status === 'removed') {
      throw conflict('This listing was removed, so the claim can no longer be completed');
    }

    await client.query(
      `update claims set status = 'completed', completed_at = now() where id = $1`,
      [claimId]
    );
    await client.query(
      `update items set status = 'returned', returned_at = now() where id = $1 and status <> 'removed'`,
      [claim.item_id]
    );
    await audit.record(
      {
        actor: user,
        action: 'claim.completed',
        targetType: 'claim',
        targetId: claimId,
        details: { itemId: claim.item_id },
        ip,
      },
      client
    );
    return claim;
  });

  const { rows: people } = await query(
    `select id, name, email from users where id in ($1, $2)`,
    [result.owner_id, result.claimant_id]
  );
  for (const person of people) {
    mailer
      .send({
        to: person.email,
        ...templates.itemReturnedEmail({
          name: person.name,
          itemTitle: result.title,
          itemUrl: templates.absolute(`/item.html?id=${result.item_id}`),
        }),
      })
      .catch(() => {});
  }

  const { rows } = await query(`${CLAIM_SELECT} where c.id = $1`, [claimId]);
  return shape(rows[0]);
}

module.exports = {
  submit,
  listMine,
  listReceived,
  getOne,
  evidenceLinks,
  decide,
  withdraw,
  proposeHandover,
  complete,
  shape,
};
