-- Barrier age tracking (TODO §A monitoring): ops_flags gains a jsonb
-- payload so state rows can carry data beyond a boolean. First consumer:
-- key 'barrier' — value = engaged, data = { since, pending } written
-- best-effort by the settler; read by /api/cron/health (age) and the
-- public /api/status feed.
alter table public.ops_flags add column if not exists data jsonb;
