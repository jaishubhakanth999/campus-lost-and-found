-- =============================================================================
-- Create the CampusConnect administrator
--
-- Run this in the Supabase SQL Editor. There is no public admin registration:
-- an administrator exists only because someone ran this (or `npm run
-- create-admin`), and still receives an email OTP on every sign-in.
--
-- BEFORE RUNNING: replace PASTE_BCRYPT_HASH_HERE with a real bcrypt hash.
-- Generate it on your machine with:
--
--     node scripts/hash-password.js
--
-- That script asks for a password (it is never echoed or saved), prints the
-- hash, and prints this same SQL ready to paste. Passwords must be at least
-- 12 characters and contain a letter and a number.
-- =============================================================================

insert into users (name, email, password_hash, role, is_email_verified, email_verified_at, status)
values (
  'Jai Shubhakanth Mangali',
  'jaishubhakanth.m-29@scds.saiuniversity.edu.in',
  'PASTE_BCRYPT_HASH_HERE',
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
-- * Never keep this file with a real hash in it. Paste, run, and leave the
--   placeholder in the repository.
-- * To rotate the password later, sign in to /admin/ and use Security →
--   Change password, or re-run scripts/create-admin.js.
