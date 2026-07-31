-- FSA-H01 (2026-07-30 frontend security audit) — enforce the deny-all RLS
-- invariant on the four governance tables that self-create from the
-- application on first write, and therefore never passed through a
-- migration that enables RLS:
--
--   interventions, flight_schedules, flight_outcomes, pricing_runs
--
-- (see 20260801120000_drop_retired_governance_tables.sql, which documents
-- that these "self-create on first write from the application").
--
-- Why this matters: a new Postgres table defaults to RLS-DISABLED, and
-- Supabase grants the anon/authenticated roles full table privileges on
-- the public schema. A public-schema table without RLS is therefore world
-- READ AND WRITE through the PostgREST Data API using only the public
-- publishable key. Verified live on 2026-07-30: with RLS off, the anon
-- role could both SELECT and INSERT rows in `interventions`.
--
-- The durable fix lives in the application code that creates these tables
-- (each `create table if not exists` is now immediately followed by
-- `enable row level security`), so a freshly-provisioned developer/production
-- DB is born deny-all with no exposure window — the table never exists
-- without RLS.
--
-- This migration is the version-controlled record of that invariant and an
-- immediate backstop for any DB where the tables ALREADY exist: it enables
-- RLS in place WITHOUT recreating them (no schema duplication, no drift
-- against the application DDL), and is a no-op on a fresh DB where the
-- tables do not yet exist (the app secures them at self-create).
--
-- Deny-all = RLS enabled with ZERO policies, matching every other table in
-- this schema. The server-side postgres role OWNS these tables and bypasses
-- RLS, so application access is unaffected. Idempotent.

do $$
declare
  t text;
begin
  foreach t in array array['interventions', 'flight_schedules', 'flight_outcomes', 'pricing_runs']
  loop
    if exists (
      select 1 from pg_class
      where relname = t and relnamespace = 'public'::regnamespace
    ) then
      execute format('alter table public.%I enable row level security', t);
    end if;
  end loop;
end $$;
