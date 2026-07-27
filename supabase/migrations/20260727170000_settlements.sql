-- Durable settlement mirror (chain-event ingest, TODO §D/§F).
--
-- RPC event retention is ~7 days but claim expiry is ~60: anything that
-- must react to a settlement long after the fact (the expired-claim
-- sweeper, analytics) needs a durable record written while the event is
-- still visible. One row per settled flight; swept_at tracks the sweeper.
create table public.settlements (
  flight_id text not null,
  date bigint not null,
  outcome text not null, -- OnTime | Delayed | Cancelled (event payload)
  ledger bigint not null,
  tx_hash text,
  settled_at timestamptz not null default now(),
  swept_at timestamptz,
  primary key (flight_id, date)
);

alter table public.settlements enable row level security;
