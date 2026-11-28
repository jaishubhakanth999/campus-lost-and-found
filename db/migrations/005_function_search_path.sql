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
