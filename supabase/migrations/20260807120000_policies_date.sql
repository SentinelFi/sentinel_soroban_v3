-- The `bought` event topics carry the flight's UTC-midnight date bucket,
-- but the policies mirror dropped it on ingest — so a buyer holding the
-- same flight number on two different days was ambiguous, and a per-policy
-- tx lookup could return the wrong purchase. Nullable by design: rows
-- ingested before this migration keep null and simply never match a dated
-- lookup (the reader fails open to "no tx link").
alter table public.policies add column date bigint;

create index policies_flight_date_idx on public.policies (flight_id, date);
