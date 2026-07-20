-- Governance DB core schema (Phase 1 of the governance module).
--
-- Access model: RLS is ENABLED on every table with ZERO policies —
-- deny-all for anon/authenticated. Only server-side code (Vercel
-- functions) touches these tables, via the service-role key over the
-- Supavisor transaction pooler (port 6543). Do not add policies here;
-- the admin UI goes through server-side API routes, never the DB.
--
-- Amounts are on-chain i128 base units (7 decimals, USDC_BASE_UNITS =
-- 10_000_000) stored as bigint — $100 = 1_000_000_000, far inside
-- bigint range. NULL base terms mean "inherit": routes-file / config
-- fallback, then on-chain global defaults resolve the rest.

-- ── updated_at maintenance ─────────────────────────────────────────

create function public.set_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

-- ── routes ─────────────────────────────────────────────────────────
-- One row per insurable route (flight_id + origin + dest is the
-- on-chain route key). Base terms are the admin-set anchor the
-- reconciler multiplies from; canonical schedule times let the
-- schedule checker detect drift against AeroAPI.

create table public.routes (
  id bigint generated always as identity primary key,
  flight_id text not null,
  origin text not null,
  dest text not null,
  carrier text,

  -- Base (anchor) terms; NULL = inherit from defaults chain.
  base_premium_units bigint check (base_premium_units > 0),
  base_payoff_units bigint check (base_payoff_units > 0),
  base_delay_hours integer check (base_delay_hours > 0),

  -- Canonical schedule (local wall-clock + IANA tz per endpoint).
  sched_dep_local time,
  sched_arr_local time,
  dep_tz text,
  arr_tz text,
  distance_mi integer check (distance_mi >= 0),

  -- Lifecycle. 'candidate' = known but not yet whitelisted on-chain;
  -- 'active'/'disabled' mirror desired on-chain state; 'removed' =
  -- remove_route submitted, kept for history.
  status text not null default 'candidate'
    check (status in ('candidate', 'active', 'disabled', 'removed')),

  -- Admin pin: while pinned (and pin_until unexpired), the reconciler
  -- must not touch this route. pin_until NULL = pinned indefinitely.
  pinned boolean not null default false,
  pin_until timestamptz,
  pin_reason text,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  unique (flight_id, origin, dest)
);

create trigger routes_set_updated_at
  before update on public.routes
  for each row execute function public.set_updated_at();

alter table public.routes enable row level security;

-- ── signals ────────────────────────────────────────────────────────
-- Layer-1 collectors and admins write here; only the reconciler reads
-- to act. A signal is active while cleared_at IS NULL and expires_at
-- (if set) is in the future. Scope: 'route' uses all three key
-- columns; 'origin'/'dest' use just that airport column.

create table public.signals (
  id bigint generated always as identity primary key,
  type text not null
    check (type in ('weather', 'geopolitical', 'exposure', 'schedule_drift', 'manual')),
  scope_kind text not null check (scope_kind in ('route', 'origin', 'dest')),
  flight_id text,
  origin text,
  dest text,
  severity text not null default 'info'
    check (severity in ('info', 'elevated', 'severe')),
  payload jsonb not null default '{}',
  -- Where it came from: 'metar', 'exposure-counter', 'schedule-check',
  -- 'admin:<email>' …
  source text not null,
  expires_at timestamptz,
  cleared_at timestamptz,
  created_at timestamptz not null default now(),

  constraint signals_scope_key check (
    case scope_kind
      when 'route' then flight_id is not null and origin is not null and dest is not null
      when 'origin' then origin is not null
      when 'dest' then dest is not null
    end
  )
);

create index signals_active_idx on public.signals (type, scope_kind)
  where cleared_at is null;
create index signals_route_idx on public.signals (flight_id, origin, dest);
create index signals_expiry_idx on public.signals (expires_at)
  where cleared_at is null;

alter table public.signals enable row level security;

-- ── pause_events ───────────────────────────────────────────────────
-- History of every pause the reconciler (or an admin directly)
-- enacted on-chain, with the signal that caused it. ended_at set when
-- the route is re-enabled.

create table public.pause_events (
  id bigint generated always as identity primary key,
  flight_id text not null,
  origin text not null,
  dest text not null,
  signal_id bigint references public.signals (id),
  reason text not null,
  -- 'cron:reconciler' or 'admin:<email>'.
  actor text not null,
  started_at timestamptz not null default now(),
  ended_at timestamptz
);

create index pause_events_route_idx on public.pause_events (flight_id, origin, dest);
create index pause_events_open_idx on public.pause_events (started_at)
  where ended_at is null;

alter table public.pause_events enable row level security;

-- ── premium_adjustments ────────────────────────────────────────────
-- Every premium change the reconciler applied: the base it started
-- from, the multiplier stack, and the clamped result. reverted_at set
-- when terms return to base/UseDefault. Doubles as the hysteresis
-- record ("max 1 premium change per route per day" = look for an
-- applied_at within the last day).

create table public.premium_adjustments (
  id bigint generated always as identity primary key,
  flight_id text not null,
  origin text not null,
  dest text not null,
  base_premium_units bigint not null,
  -- e.g. [{"kind": "weather", "factor": 1.25, "signal_id": 7}, …]
  multipliers jsonb not null default '[]',
  final_premium_units bigint not null,
  reason text not null,
  applied_at timestamptz not null default now(),
  reverted_at timestamptz
);

create index premium_adjustments_route_idx
  on public.premium_adjustments (flight_id, origin, dest, applied_at desc);

alter table public.premium_adjustments enable row level security;

-- ── actions_log ────────────────────────────────────────────────────
-- Append-only record of every on-chain governance call: who, what,
-- state before/after, tx hash, outcome. No update/delete path exists
-- in application code; RLS with no policies keeps everyone else out.

create table public.actions_log (
  id bigint generated always as identity primary key,
  ts timestamptz not null default now(),
  -- 'cron:<rule>' (e.g. 'cron:reconciler/pause-expand') or 'admin:<email>'.
  actor text not null,
  -- Contract entry point: whitelist_route, disable_route, enable_route,
  -- remove_route, update_route_terms.
  action text not null,
  flight_id text,
  origin text,
  dest text,
  tx_hash text,
  before jsonb,
  after jsonb,
  success boolean not null,
  error text
);

create index actions_log_ts_idx on public.actions_log (ts desc);
create index actions_log_route_idx on public.actions_log (flight_id, origin, dest);

alter table public.actions_log enable row level security;

-- ── policies (exposure ingest) ─────────────────────────────────────
-- One row per InsuranceBought event pulled from RPC. Event retention
-- on testnet RPC is short, so the collector keeps its own durable
-- copy; exposure counts per route/origin/dest are queries over this
-- table. (tx_hash, event_index) dedupes re-reads after cursor resets.

create table public.policies (
  id bigint generated always as identity primary key,
  tx_hash text not null,
  event_index integer not null,
  ledger integer not null,
  flight_id text not null,
  origin text not null,
  dest text not null,
  buyer text not null,
  premium_units bigint,
  payoff_units bigint,
  bought_at timestamptz not null,
  ingested_at timestamptz not null default now(),

  unique (tx_hash, event_index)
);

create index policies_route_idx on public.policies (flight_id, origin, dest);
create index policies_origin_idx on public.policies (origin);
create index policies_dest_idx on public.policies (dest);

alter table public.policies enable row level security;

-- ── ingest_cursors ─────────────────────────────────────────────────
-- Per-collector resume point (e.g. exposure collector's last-seen
-- ledger). One row per collector name.

create table public.ingest_cursors (
  name text primary key,
  cursor text not null,
  updated_at timestamptz not null default now()
);

create trigger ingest_cursors_set_updated_at
  before update on public.ingest_cursors
  for each row execute function public.set_updated_at();

alter table public.ingest_cursors enable row level security;
