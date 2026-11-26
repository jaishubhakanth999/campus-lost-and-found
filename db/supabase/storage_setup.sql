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
