-- 2026-08-01 — the interventions unification + demand-driven rework
-- retired the signals/reconciler machinery and the AeroAPI polling
-- caches. These tables are orphaned (nothing reads or writes them);
-- their replacements self-create on first write from the application
-- (interventions, flight_schedules, flight_outcomes, pricing_runs):
--
--   signals              → interventions (the unified pause ledger)
--   pause_events         → interventions
--   route_health         → interventions (short-lived, 07-31..08-01)
--   premium_adjustments  → retired 2026-07-30 (stateless weather surcharge)
--   warm_windows         → retired 2026-07-31 (JIT sale-auth endpoint)
--   aeroapi_cache        → retired 2026-07-31 (no polling left to cache)
--
-- Applied to the live governance DB 2026-08-01 (all rows were 0 except
-- aeroapi_cache's 38 stale cached responses).

drop table if exists signals cascade;
drop table if exists pause_events cascade;
drop table if exists route_health cascade;
drop table if exists premium_adjustments cascade;
drop table if exists warm_windows cascade;
drop table if exists aeroapi_cache cascade;
