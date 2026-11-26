#!/usr/bin/env node
'use strict';

/**
 * Prints a bcrypt hash for a password you type.
 *
 * Use this only if you want to create an administrator by pasting SQL into the
 * Supabase SQL Editor instead of running `npm run create-admin` (which is the
 * safer, audited path). The password is typed, never echoed, never logged.
 *
 *   node scripts/hash-password.js
 */

const readline = require('node:readline');
const bcrypt = require('bcryptjs');

const ROUNDS = 12; // keep in step with BCRYPT_ROUNDS in production

function ask(question, { hidden = false } = {}) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    if (hidden) {
      rl._writeToOutput = function writeToOutput(chunk) {
        // Suppress the typed characters, keep the prompt.
        if (rl.stdoutMuted) {
          rl.output.write('*');
        } else {
          rl.output.write(chunk);
        }
      };
    }
    rl.question(question, (answer) => {
      rl.close();
      if (hidden) process.stdout.write('\n');
      resolve(answer);
    });
    if (hidden) rl.stdoutMuted = true;
  });
}

(async () => {
  const password = await ask('Password (at least 12 characters, letters and a number): ', { hidden: true });

  if (password.length < 12 || !/[A-Za-z]/.test(password) || !/[0-9]/.test(password)) {
    console.error('Rejected: use at least 12 characters and include a letter and a number.');
    process.exit(1);
  }

  const hash = await bcrypt.hash(password, ROUNDS);
  console.log('\nPaste this into the SQL below as password_hash:\n');
  console.log(hash);
  console.log('\nSQL:\n');
  console.log(`insert into users (name, email, password_hash, role, is_email_verified, email_verified_at)
values (
  'Portal Administrator',
  'jaishubhakanth.m-29@scds.saiuniversity.edu.in',
  '${hash}',
  'admin',
  true,
  now()
)
on conflict (lower(email)) do update
  set role              = 'admin',
      is_email_verified  = true,
      email_verified_at  = coalesce(users.email_verified_at, now()),
      status             = 'active',
      password_hash      = excluded.password_hash;`);
})();
