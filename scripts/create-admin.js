#!/usr/bin/env node
'use strict';

/**
 * Creates or promotes an administrator.
 *
 * There is deliberately no public administrator registration. An administrator
 * exists only because someone with shell access to the deployment ran this
 * command. The password is never echoed, never defaulted and never stored
 * anywhere except as a bcrypt hash.
 *
 *   ADMIN_EMAIL=... ADMIN_NAME="Portal Admin" ADMIN_PASSWORD=... npm run create-admin
 */

const bcrypt = require('bcryptjs');
const { buildConfig } = require('../src/config/env');

let cfg;
try { cfg = buildConfig(process.env); } catch (err) { console.error(err.message); process.exit(1); }

const { query, close } = require('../src/db/pool');
const authService = require('../src/services/authService');
const audit = require('../src/services/auditService');

async function main() {
  const email = String(process.env.ADMIN_EMAIL || '').trim().toLowerCase();
  const name = String(process.env.ADMIN_NAME || 'Portal Administrator').trim();
  const password = process.env.ADMIN_PASSWORD || '';

  if (!email) throw new Error('ADMIN_EMAIL is required');
  if (!authService.domainAllowed(email, 'admin')) {
    throw new Error(`ADMIN_EMAIL must be on an approved administrator domain (${authService.allowedDomainHint('admin')})`);
  }
  if (password.length < 12 || !/[A-Za-z]/.test(password) || !/[0-9]/.test(password)) {
    throw new Error('ADMIN_PASSWORD must be at least 12 characters and contain a letter and a number');
  }

  const hash = await bcrypt.hash(password, cfg.BCRYPT_ROUNDS);
  const existing = await authService.findUserByEmail(email, { withPassword: true });

  let id;
  if (existing) {
    const { rows } = await query(
      `update users set role = 'admin', is_email_verified = true,
              email_verified_at = coalesce(email_verified_at, now()),
              status = 'active', password_hash = $2, name = coalesce(nullif($3,''), name)
        where id = $1 returning id`,
      [existing.id, hash, name]
    );
    id = rows[0].id;
    console.log(`Promoted existing account ${email} to administrator.`);
  } else {
    const { rows } = await query(
      `insert into users (name, email, password_hash, role, is_email_verified, email_verified_at)
       values ($1, $2, $3, 'admin', true, now()) returning id`,
      [name, email, hash]
    );
    id = rows[0].id;
    console.log(`Created administrator ${email}.`);
  }

  await audit.record({
    actor: { id, email },
    action: 'admin.provisioned',
    targetType: 'user',
    targetId: id,
    details: { via: 'scripts/create-admin.js' },
  });

  console.log('Sign in at /admin/ — email OTP is still required on every login.');
  await close();
}

main().catch(async (err) => {
  console.error(`Failed: ${err.message}`);
  await close().catch(() => {});
  process.exit(1);
});
