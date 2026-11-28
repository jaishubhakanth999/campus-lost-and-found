-- =============================================================================
--  CampusConnect — complete Supabase setup, in one paste
--
--  Paste this whole file into: Supabase dashboard → SQL Editor → New query → Run.
--  It is idempotent: running it twice changes nothing the second time.
--
--  What it creates
--    · 8 tables: users, items, claims, user_sessions, otp_codes,
--      password_reset_tokens, auth_events, admin_audit_logs
--    · constraints (one account per email, one live OTP per purpose, one live
--      claim per person per item, bcrypt-only password hashes), indexes,
--      full-text search, updated_at triggers, RLS enabled with no policies
--    · 2 storage buckets: item-images (public), claim-evidence (private)
--
--  This is the same SQL the app applies with `npm run migrate`, plus
--  db/supabase/storage_setup.sql — generated from those files so it cannot drift.
-- =============================================================================

-- ###########################################################################
-- SECTION 1 — schema
-- ###########################################################################

-- =============================================================================
-- CampusConnect — PostgreSQL schema (Supabase compatible, PostgreSQL 15+)
-- Migration 001 — initial schema
--
-- Design notes
--  * Replaces the previous MongoDB/Mongoose models (User, Item, Claim) with
--    relational tables, and adds UserSessions, OTPVerifications (otp_codes),
--    AuthEvents and AdminAuditLogs.
--  * Emails are stored lower-cased and uniqueness is enforced on lower(email),
--    so "Ravi@Uni.ac.in" and "ravi@uni.ac.in" cannot both register.
--  * OTPs are never stored in plain text: only an HMAC-SHA256 digest of the
--    6-digit code (with a server-side pepper) is written to code_hash.
--  * Row Level Security is enabled on every table with NO policies. The API
--    connects with the service role / direct Postgres connection which
--    bypasses RLS; the public anon key can therefore read nothing at all.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- Helper: keep updated_at accurate without trusting the application layer
-- ---------------------------------------------------------------------------
create or replace function set_updated_at() returns trigger
language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

-- ---------------------------------------------------------------------------
-- users
-- ---------------------------------------------------------------------------
create table if not exists users (
  id                uuid primary key default gen_random_uuid(),
  name              text        not null check (char_length(btrim(name)) between 2 and 80),
  email             text        not null check (email = lower(email)),
  password_hash     text        not null,
  role              text        not null default 'student' check (role in ('student', 'admin')),
  is_email_verified boolean     not null default false,
  email_verified_at timestamptz,
  status            text        not null default 'active' check (status in ('active', 'suspended', 'deleted')),
  student_id        text,
  department        text,
  phone             text,
  last_login_at     timestamptz,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  constraint users_email_format check (email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$')
);

create unique index if not exists users_email_lower_key on users (lower(email));
create index if not exists users_role_idx        on users (role);
create index if not exists users_status_idx      on users (status);
create index if not exists users_created_at_idx  on users (created_at desc);

drop trigger if exists users_set_updated_at on users;
create trigger users_set_updated_at before update on users
  for each row execute function set_updated_at();

-- ---------------------------------------------------------------------------
-- otp_codes  (one active code per user + purpose; previous ones are superseded)
-- ---------------------------------------------------------------------------
create table if not exists otp_codes (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid        not null references users (id) on delete cascade,
  purpose       text        not null check (purpose in ('signup', 'login', 'admin_login')),
  code_hash     text        not null,
  attempts      integer     not null default 0,
  max_attempts  integer     not null default 5,
  consumed_at   timestamptz,
  expires_at    timestamptz not null,
  request_ip    inet,
  created_at    timestamptz not null default now()
);

create index if not exists otp_codes_user_purpose_idx
  on otp_codes (user_id, purpose, created_at desc);
create index if not exists otp_codes_expires_idx on otp_codes (expires_at);
-- at most one *live* code per user/purpose
create unique index if not exists otp_codes_one_active_idx
  on otp_codes (user_id, purpose) where consumed_at is null;

-- ---------------------------------------------------------------------------
-- user_sessions  (login / logout history + revocation)
-- ---------------------------------------------------------------------------
create table if not exists user_sessions (
  id               uuid primary key default gen_random_uuid(),
  user_id          uuid        not null references users (id) on delete cascade,
  session_id       uuid        not null unique,          -- carried in the JWT as `sid`
  login_at         timestamptz not null default now(),
  logout_at        timestamptz,
  last_activity_at timestamptz not null default now(),
  expires_at       timestamptz not null,
  status           text        not null default 'active'
                     check (status in ('active', 'logged_out', 'expired', 'revoked')),
  logout_reason    text,
  ip               inet,
  user_agent       text,
  created_at       timestamptz not null default now()
);

create index if not exists user_sessions_user_idx   on user_sessions (user_id, login_at desc);
create index if not exists user_sessions_status_idx on user_sessions (status, expires_at);
create index if not exists user_sessions_sid_idx    on user_sessions (session_id);

-- ---------------------------------------------------------------------------
-- auth_events  (security trail: successes, failures, OTP outcomes)
--   Never stores passwords, OTP codes or tokens.
-- ---------------------------------------------------------------------------
create table if not exists auth_events (
  id         bigserial primary key,
  user_id    uuid references users (id) on delete set null,
  email      text,
  event      text not null check (event in (
               'register', 'login_success', 'login_failed', 'otp_sent', 'otp_failed',
               'otp_verified', 'otp_expired', 'logout', 'session_revoked',
               'admin_login_success', 'admin_login_failed', 'password_reset_requested'
             )),
  outcome    text not null default 'success' check (outcome in ('success', 'failure', 'blocked')),
  reason     text,
  ip         inet,
  user_agent text,
  created_at timestamptz not null default now()
);

create index if not exists auth_events_email_idx  on auth_events (lower(email), created_at desc);
create index if not exists auth_events_user_idx   on auth_events (user_id, created_at desc);
create index if not exists auth_events_event_idx  on auth_events (event, created_at desc);

-- ---------------------------------------------------------------------------
-- items  (lost / found reports)
-- ---------------------------------------------------------------------------
create table if not exists items (
  id                uuid primary key default gen_random_uuid(),
  owner_id          uuid not null references users (id) on delete cascade,
  type              text not null check (type in ('lost', 'found')),
  title             text not null check (char_length(btrim(title)) between 3 and 100),
  category          text not null check (category in (
                      'Electronics', 'Books', 'ID Cards', 'Bags',
                      'Clothing', 'Accessories', 'Documents', 'Keys', 'Other')),
  description       text not null check (char_length(btrim(description)) between 10 and 1000),
  location          text not null check (char_length(btrim(location)) between 2 and 120),
  occurred_on       date not null,
  occurred_time     time,
  additional_info   text check (char_length(additional_info) <= 500),
  status            text not null default 'open'
                      check (status in ('open', 'claimed', 'returned', 'closed', 'removed')),
  moderation_status text not null default 'approved'
                      check (moderation_status in ('pending', 'approved', 'rejected')),
  images            jsonb not null default '[]'::jsonb,
  view_count        integer not null default 0,
  returned_at       timestamptz,
  closed_at         timestamptz,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  search_vector     tsvector generated always as (
                      to_tsvector('english',
                        coalesce(title, '') || ' ' || coalesce(description, '') || ' ' ||
                        coalesce(location, '') || ' ' || coalesce(category, ''))
                    ) stored
);

create index if not exists items_status_created_idx on items (status, created_at desc);
create index if not exists items_type_status_idx    on items (type, status, created_at desc);
create index if not exists items_owner_idx          on items (owner_id, created_at desc);
create index if not exists items_category_idx       on items (category, status);
create index if not exists items_moderation_idx     on items (moderation_status, created_at desc);
create index if not exists items_search_idx         on items using gin (search_vector);

drop trigger if exists items_set_updated_at on items;
create trigger items_set_updated_at before update on items
  for each row execute function set_updated_at();

-- ---------------------------------------------------------------------------
-- claims
-- ---------------------------------------------------------------------------
create table if not exists claims (
  id              uuid primary key default gen_random_uuid(),
  item_id         uuid not null references items (id) on delete cascade,
  claimant_id     uuid not null references users (id) on delete cascade,
  message         text not null check (char_length(btrim(message)) between 10 and 1000),
  evidence        jsonb not null default '[]'::jsonb,   -- private, never in the public gallery
  status          text not null default 'pending'
                    check (status in ('pending', 'approved', 'rejected', 'withdrawn', 'completed')),
  decided_by      uuid references users (id) on delete set null,
  decided_at      timestamptz,
  decision_note   text check (char_length(decision_note) <= 500),
  handover_place  text,
  handover_at     timestamptz,
  completed_at    timestamptz,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create index if not exists claims_item_idx     on claims (item_id, created_at desc);
create index if not exists claims_claimant_idx on claims (claimant_id, created_at desc);
create index if not exists claims_status_idx   on claims (status, created_at desc);
-- one live claim per (item, claimant): no duplicate pending/approved claims
create unique index if not exists claims_live_unique_idx
  on claims (item_id, claimant_id) where status in ('pending', 'approved');

drop trigger if exists claims_set_updated_at on claims;
create trigger claims_set_updated_at before update on claims
  for each row execute function set_updated_at();

-- ---------------------------------------------------------------------------
-- admin_audit_logs
-- ---------------------------------------------------------------------------
create table if not exists admin_audit_logs (
  id          bigserial primary key,
  actor_id    uuid references users (id) on delete set null,
  actor_email text,
  action      text not null,
  target_type text,
  target_id   uuid,
  details     jsonb not null default '{}'::jsonb,
  ip          inet,
  created_at  timestamptz not null default now()
);

create index if not exists audit_actor_idx  on admin_audit_logs (actor_id, created_at desc);
create index if not exists audit_target_idx on admin_audit_logs (target_type, target_id, created_at desc);
create index if not exists audit_action_idx on admin_audit_logs (action, created_at desc);

-- ---------------------------------------------------------------------------
-- Row Level Security — deny everything to anon / authenticated PostgREST roles.
-- The Express API connects as the table owner (or service_role) and is
-- unaffected. This means the public Supabase anon key can read nothing.
-- ---------------------------------------------------------------------------
do $$
declare t text;
begin
  foreach t in array array['users', 'otp_codes', 'user_sessions', 'auth_events',
                           'items', 'claims', 'admin_audit_logs']
  loop
    execute format('alter table %I enable row level security', t);
  end loop;
end $$;

-- ###########################################################################
-- SECTION 2 — password reset + listing expiry
-- ###########################################################################

-- =============================================================================
-- Migration 002 — password reset tokens and listing expiry
--
-- Additive only: no column is renamed or dropped, no row is deleted. Existing
-- items get an expiry date derived from their creation time.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- password_reset_tokens
--   Only a hashed token is stored. The plain token exists once, in the email.
-- ---------------------------------------------------------------------------
create table if not exists password_reset_tokens (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid        not null references users (id) on delete cascade,
  token_hash text        not null,
  expires_at timestamptz not null,
  used_at    timestamptz,
  request_ip inet,
  created_at timestamptz not null default now()
);

create index if not exists password_reset_user_idx
  on password_reset_tokens (user_id, created_at desc);
create index if not exists password_reset_expires_idx
  on password_reset_tokens (expires_at);

-- at most one live reset link per account
create unique index if not exists password_reset_one_live_idx
  on password_reset_tokens (user_id) where used_at is null;

-- ---------------------------------------------------------------------------
-- item expiry
-- ---------------------------------------------------------------------------
alter table items add column if not exists expires_at        timestamptz;
alter table items add column if not exists expiry_warned_at  timestamptz;

update items
   set expires_at = created_at + interval '60 days'
 where expires_at is null;

create index if not exists items_expiry_open_idx
  on items (expires_at) where status = 'open';

-- ---------------------------------------------------------------------------
-- new security event: a completed password reset
-- ---------------------------------------------------------------------------
alter table auth_events drop constraint if exists auth_events_event_check;
alter table auth_events add constraint auth_events_event_check check (event in (
  'register', 'login_success', 'login_failed', 'otp_sent', 'otp_failed',
  'otp_verified', 'otp_expired', 'logout', 'session_revoked',
  'admin_login_success', 'admin_login_failed',
  'password_reset_requested', 'password_reset_completed'
));

-- ###########################################################################
-- SECTION 3 — password hashes must be bcrypt
-- ###########################################################################

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

-- ###########################################################################
-- SECTION 4 — RLS on every table
-- ###########################################################################

-- =============================================================================
-- Migration 004 — RLS on every public table
--
-- 001 enabled RLS on the seven tables that existed then; 002 added
-- password_reset_tokens afterwards and it shipped without RLS, which the
-- Supabase advisor flagged as critical (the anon key could read reset tokens).
--
-- Rather than patch that one table, this enables RLS on any public table that is
-- missing it, so a future migration cannot reintroduce the gap.
--
-- RLS with no policies = deny-all for anon/authenticated. That is deliberate:
-- only the API (direct connection / service role) reads these tables.
-- =============================================================================

do $$
declare t record;
begin
  for t in
    select c.relname
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public'
       and c.relkind = 'r'
       and not c.relrowsecurity
  loop
    execute format('alter table public.%I enable row level security', t.relname);
    raise notice 'RLS enabled on public.%', t.relname;
  end loop;
end $$;

-- ###########################################################################
-- SECTION 5 — pinned search_path
-- ###########################################################################

-- =============================================================================
-- Migration 005 — pin the search_path on set_updated_at()
--
-- Supabase's advisor flags a mutable search_path as a warning: a caller can
-- shadow the objects a function resolves, which is how trigger helpers get
-- hijacked. Pinning it to pg_catalog, public closes that.
-- =============================================================================

create or replace function public.set_updated_at() returns trigger
language plpgsql
security invoker
set search_path = pg_catalog, public
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

-- ###########################################################################
-- SECTION 6 — storage buckets
-- ###########################################################################

-- =============================================================================
-- Supabase Storage setup — run once in the Supabase SQL Editor
--
-- Creates the two buckets the application expects, with the same size and
-- MIME limits the API enforces, so a file cannot be stored even if the API
-- check were bypassed.
--
-- Safe to run more than once (on conflict do nothing).
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 1. Public bucket: gallery photos for lost & found listings
-- ---------------------------------------------------------------------------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'item-images',
  'item-images',
  true,                                        -- public: gallery images are shown to everyone
  5242880,                                     -- 5 MB, matches MAX_UPLOAD_MB
  array['image/webp', 'image/jpeg', 'image/png']
)
on conflict (id) do update
  set public             = excluded.public,
      file_size_limit    = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

-- ---------------------------------------------------------------------------
-- 2. Private bucket: claim evidence (never shown in the public gallery)
-- ---------------------------------------------------------------------------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'claim-evidence',
  'claim-evidence',
  false,                                       -- private: reachable only via signed URLs
  5242880,
  array['image/webp', 'image/jpeg', 'image/png']
)
on conflict (id) do update
  set public             = excluded.public,
      file_size_limit    = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

-- ---------------------------------------------------------------------------
-- 3. Verify
-- ---------------------------------------------------------------------------
-- Expected: two rows, item-images public = true, claim-evidence public = false.
select id, public, file_size_limit, allowed_mime_types
  from storage.buckets
 where id in ('item-images', 'claim-evidence')
 order by id;

-- ---------------------------------------------------------------------------
-- Notes
-- ---------------------------------------------------------------------------
-- * The Express API uploads with the service_role key, which bypasses RLS, so
--   no storage policies are required for the app to work.
--
-- * The public bucket serves files over its public URL without authentication —
--   that is intentional: gallery photos are public.
--
-- * The private bucket is only reachable through 5-minute signed URLs that the
--   API generates per request. Never make it public.
--
-- * If you ever let the browser talk to Supabase directly with the anon key,
--   you would need policies. Do not do that for `claim-evidence`; the API is
--   the only component that should read it.
--
-- * Storage is a paid feature above the free-tier allowance. Check the current
--   limits in your Supabase dashboard before a campus-wide launch.
-- ###########################################################################
-- SECTION 7 — verify (read-only; safe to re-run)
-- ###########################################################################

-- Expect 8 rows.
select table_name
  from information_schema.tables
 where table_schema = 'public'
   and table_type = 'BASE TABLE'
 order by table_name;

-- Expect item-images public = true, claim-evidence public = false.
select id, public, file_size_limit
  from storage.buckets
 where id in ('item-images', 'claim-evidence')
 order by id;

-- Expect 0: no account may exist with a non-bcrypt hash.
select count(*) as accounts_with_bad_hashes
  from users
 where password_hash !~ '^\$2[aby]\$[0-9]{2}\$';

-- ###########################################################################
-- NEXT STEP
-- ###########################################################################
-- Create the administrator with db/supabase/create_admin.sql, or from your
-- machine with:
--
--     DATABASE_URL='postgresql://…' \
--     ADMIN_EMAIL='jaishubhakanth.m-29@scds.saiuniversity.edu.in' \
--     ADMIN_NAME='Jai Shubhakanth Mangali' \
--     ADMIN_PASSWORD='…' \
--     npm run create-admin
--
-- Then set DATABASE_URL on Render to the *Session pooler* URI from
-- Supabase → Connect, and start the service.
