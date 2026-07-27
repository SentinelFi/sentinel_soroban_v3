-- AeroAPI response cache (call-economy ladder, TODO §C).
--
-- Published airline schedules barely change: caching a /schedules chunk
-- for ~24h cuts the authorizer's far-window API calls ~12x (every 2h run
-- reuses the day's fetch). DB-OPTIONAL by design: readers fall back to a
-- direct API call when the DB is unset/unreachable, and writes are
-- best-effort — the cache can only ever save calls, never gate them.
create table public.aeroapi_cache (
  cache_key text primary key,
  payload jsonb not null,
  fetched_at timestamptz not null default now()
);

alter table public.aeroapi_cache enable row level security;
