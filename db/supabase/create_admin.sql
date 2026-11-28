-- =============================================================================
-- Create the CampusConnect administrator
--
-- Run this in the Supabase SQL Editor. There is no public admin registration:
-- an administrator exists only because someone ran this (or `npm run
-- create-admin`), and still receives an email OTP on every sign-in.
--
-- HOW TO USE
--   1. On your machine:  node scripts/hash-password.js
--      It asks for a password (never echoed, never saved) and prints a bcrypt
--      hash plus this block already filled in.
--   2. Replace the placeholder on the line marked below with that hash.
--   3. Run the whole file.
--
-- If you forget step 2, Postgres refuses the insert with a check-constraint
-- error (users_password_hash_bcrypt). That is deliberate: it is impossible to
-- create an administrator whose password nobody knows.
-- =============================================================================

insert into users (name, email, password_hash, role, is_email_verified, email_verified_at, status)
values (
  'Jai Shubhakanth Mangali',
  'jaishubhakanth.m-29@scds.saiuniversity.edu.in',
  'PASTE_BCRYPT_HASH_HERE',   -- <<< replace this, and only this
  'admin',
  true,
  now(),
  'active'
)
on conflict (lower(email)) do update
  set role             = 'admin',
      is_email_verified = true,
      email_verified_at = coalesce(users.email_verified_at, now()),
      status            = 'active',
      password_hash     = excluded.password_hash;

-- Verify: one row, role = admin, verified = true.
select id, name, email, role, is_email_verified, status, created_at
  from users
 where role = 'admin'
 order by created_at;

-- =============================================================================
-- Notes
-- =============================================================================
-- * The email domain must be allowed. With ALLOWED_EMAIL_DOMAINS set to
--   "saiuniversity.edu.in", sub-domains such as scds.saiuniversity.edu.in are
--   accepted automatically.
-- * Never commit this file with a real hash in it. Paste, run, and leave the
--   placeholder in the repository.
-- * Running this twice is safe: it updates the existing account instead of
--   creating a duplicate.
-- * To rotate the password later: sign in to /admin/ → Security, or re-run
--   scripts/create-admin.js.
