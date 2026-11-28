-- =============================================================================
-- Migration 003 — passwords must look like bcrypt hashes
--
-- Why this exists: a hand-written INSERT with a placeholder ("PASTE_BCRYPT_HASH_HERE")
-- or a future code path that forgets to hash would create an account nobody can
-- ever sign in to, and nothing would say so. The database now refuses any value
-- that is not a bcrypt digest.
--
-- Additive and safe: every password in the system is already written by bcryptjs,
-- so existing rows satisfy the constraint. If a row somehow does not, the ALTER
-- fails loudly and nothing is changed.
-- =============================================================================

alter table users
  drop constraint if exists users_password_hash_bcrypt;

alter table users
  add constraint users_password_hash_bcrypt
  check (password_hash ~ '^\$2[aby]\$[0-9]{2}\$[./A-Za-z0-9]{53}$');
