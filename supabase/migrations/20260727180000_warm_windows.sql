-- Demand-driven sale windows (TODO §C): the frontend "warms" a
-- (flight, day) when a user views a quote; with SALE_AUTH_DEMAND_MODE=true
-- the authorizer's near window attests warmed days only — an idle system
-- spends ~zero near-window API calls. Rows are harmless garbage-tolerant:
-- the authorizer intersects them with its own route/day grid, so warming
-- an unknown flight or day does nothing.
create table public.warm_windows (
  flight_id text not null,
  date bigint not null, -- UTC midnight, unix seconds (on-chain day key)
  warmed_at timestamptz not null default now(),
  primary key (flight_id, date)
);

alter table public.warm_windows enable row level security;
