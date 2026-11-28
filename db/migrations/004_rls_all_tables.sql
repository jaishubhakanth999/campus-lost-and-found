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
