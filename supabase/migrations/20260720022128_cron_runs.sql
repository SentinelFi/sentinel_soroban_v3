-- Cron run history — one row per job execution, written by the cron
-- handler wrappers (schedule/external triggers) and the admin manual-run
-- endpoint. Feeds the /admin JOBS board and the public /status page
-- (public reads go through a server-side endpoint that sanitizes rows;
-- the table itself stays deny-all like everything else).

create table public.cron_runs (
  id bigint generated always as identity primary key,
  -- JobName from dapp/api/_lib/types.ts (fetcher, settler, gov_reconcile, …).
  job text not null,
  -- 'schedule' (Vercel cron), 'external' (curl w/ CRON_SECRET),
  -- 'manual:<email>' (admin JOBS board).
  trigger text not null,
  ran_at timestamptz not null,
  duration_ms integer not null,
  success boolean not null,
  error text,
  actions jsonb,
  created_at timestamptz not null default now()
);

create index cron_runs_job_idx on public.cron_runs (job, ran_at desc);

alter table public.cron_runs enable row level security;
