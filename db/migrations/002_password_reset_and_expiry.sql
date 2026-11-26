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
