-- Fleet-level governance guardrails (2026-07-27 audit).
--
-- 1. ops_flags — runtime kill switches the automation checks every run.
--    Row key 'gov_frozen' = true freezes the reconciler (and any future
--    acting job) WITHOUT a redeploy: GOV_DRY_RUN needs an env change +
--    deploy; this is the admin-toggleable brake. Absent row = not frozen.
create table public.ops_flags (
  key text primary key,
  value boolean not null,
  note text,
  updated_at timestamptz not null default now()
);

-- Deny-all RLS, same posture as every governance table: server-side
-- pooler access only.
alter table public.ops_flags enable row level security;

-- 2. Widen signals.type for new automated writers:
--    'ops'     — non-weather airport delay categories (traffic, equipment)
--    'pricing' — ML baseline-premium anchors (route_agent absorption)
alter table public.signals drop constraint signals_type_check;
alter table public.signals add constraint signals_type_check
  check (type in ('weather', 'geopolitical', 'exposure', 'schedule_drift',
                  'manual', 'ops', 'pricing'));
