'use strict';

/**
 * Guarded access to private claim evidence when STORAGE_DRIVER=local.
 * With Supabase storage the client receives short-lived signed URLs instead,
 * so this route is only used by the local development driver.
 */

const path = require('node:path');
const router = require('express').Router();
const { asyncHandler, forbidden, notFound } = require('../lib/errors');
const { authenticate } = require('../middleware/auth');
const { query } = require('../db/pool');
const { getConfig } = require('../config/env');

router.get(
  '/private/*',
  authenticate,
  asyncHandler(async (req, res) => {
    const key = decodeURIComponent(req.params[0] || '');
    if (!key.startsWith('private/')) throw notFound('File not found');

    const { rows } = await query(
      `select c.id
         from claims c
         join items i on i.id = c.item_id
        where c.evidence @> $1::jsonb
          and (c.claimant_id = $2 or i.owner_id = $2 or $3::boolean)
        limit 1`,
      [JSON.stringify([{ key }]), req.user.id, req.user.role === 'admin']
    );
    if (!rows[0]) throw forbidden('You do not have access to this file');

    const root = path.resolve(getConfig().LOCAL_UPLOAD_DIR);
    const full = path.resolve(root, key);
    if (!full.startsWith(root + path.sep)) throw notFound('File not found');
    return res.sendFile(full, { dotfiles: 'deny' });
  })
);

module.exports = router;
