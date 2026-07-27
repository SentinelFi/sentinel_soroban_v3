# TODO — Off-Chain Roadmap

Living roadmap for the off-chain layer (keepers, oracle, governance, ops).
Source: the 2026-07-27 AeroAPI spec review + full-system audit. The completed
contract-reorg checklist lives in [improvements.md](improvements.md); the
current architecture in [architecture.md](architecture.md).

Legend: **P0** = do before mainnet-serious traffic · **P1** = high value, not
blocking · **P2** = when scale demands it.

---

## A. Deployment & operational gaps (audit results — highest value)

- [ ] **P0 — Actually schedule the backend.** The checked-in `dapp/vercel.json`
  has the `crons` block removed and `.vercelignore` excludes `api/` (the
  current Vercel deploy is frontend-only). Every robustness property assumes
  the jobs run. Action: Vercel Pro project → delete `.vercelignore`, restore
  the crons block from `JOB_REGISTRY` (`api/_lib/governance/runs.ts`), set the
  server env vars (four signer keys, `AEROAPI_KEY`, `GOVERNANCE_DB_URL`,
  `CRON_SECRET`, `ADMIN_EMAILS`, `AGENT_BASE_URL`).
- [ ] **P0 — Governance unblock.** `GovernanceModule.add_admin(gov-admin)` on
  the 07-18 deployment still needs the owner key (held by JS). Until it lands,
  keep `GOV_DRY_RUN=true`. Then flip dry-run off deliberately.
- [ ] **P0 — Seed routes on the 07-18 deployment.** `npm run whitelist:routes`
  (the deployment is live but unseeded; the frontend + crons already point at
  it).
- [ ] **P1 — Pending-outcome age monitoring.** The architecture's stated
  alerting invariant — age of the oldest pending outcome, which freezes every
  LP entry/exit — is not surfaced anywhere. Add
  `oracle.get_pending_outcomes()` (+ a first-seen timestamp) to
  `/api/cron/health` and the public `/status` page; alert when nonzero for
  more than ~2 sweep cycles.
- [ ] **P2 — Relax backstop cadences once JIT is trusted.** The targeted
  classify+settle path (fetcher/authorizer) is now the primary latency route;
  the classifier (hourly) and settler (5 min) sweeps are repair backstops and
  can slow down (e.g. settler → 15 min) to cut Vercel invocations. Revisit
  after observing JIT hit-rate in `cron_runs`.

## B. AeroAPI webhook (push alerts) — cancellation/arrival latency → seconds

Design agreed 2026-07-27 (see also dapp/README.md "Future improvement"):

- [ ] **P1 — Alert lifecycle tied to insured flights.** Create the AeroAPI
  alert when a flight gets its first policy (hook: the fetcher's T-2d ETA
  write), delete it after settlement. Alert count tracks insured flights, not
  the whitelist.
- [ ] **P1 — Webhook endpoint** `api/aeroapi/alert`: verify shared secret →
  write raw alert to Supabase and ack 200 IMMEDIATELY (AeroAPI must never
  wait on Stellar) → then the same pipeline the crons use: `close_sale` →
  corroborated `set_cancelled` (reuse `isConfirmedCancellation` /
  `isConfirmedDiversion` on the alert's flight payload) → targeted
  `classify_flight` + `settle_flight`.
- [ ] **P1 — Account setup**: `PUT /alerts/endpoint` once per account;
  requires an AeroAPI plan tier with alerts (the current blocker — poll
  economics are acceptable until then).
- Polling stays as the reconciliation layer: a missed alert is caught at the
  next fetcher/authorizer pass; if both die, sale windows self-expire (≤6h)
  and sales fail closed. The webhook improves latency only — it must never
  become a single point of failure.

## C. API-call reduction ladder (beyond what shipped 2026-07-27)

Already shipped: fetcher phase gates (T-2d / ETA−6h watch / +10d history
cutoffs — zero calls outside), authorizer near(/flights)+far(/schedules)
split, live-sale-window-as-cached-attestation skip, never re-verify
outcome-recorded days. Remaining, in value order:

- [ ] **P1 — `aeroapi_cache` table (Supabase) for /schedules chunks.**
  Published schedules barely change; cache per (airline, flight_number,
  chunk) with ~24h TTL. Cuts far-window calls ~12× (5/run → 5/day per
  flight). Shared helper so any future AeroAPI caller reuses it.
- [ ] **P1 — Airline-batched /schedules.** One call per airline per ≤20-day
  chunk (drop the flight_number filter, match client-side against all of
  that carrier's enabled routes). N routes on one carrier → ~N× fewer
  schedule calls. Combines multiplicatively with the cache.
- [ ] **P2 — Demand-driven near windows.** Only attest days with live
  purchase interest: frontend "warming" ping (e.g. `POST /api/sale-auth/warm`
  on quote view) marks (flight, day) hot in Supabase; the authorizer near
  window covers hot days only. Idle system → ~0 attestation calls. (This is
  the surviving piece of the original 2026-07-20 demand-driven plan.)
- [ ] **P2 — Webhook floor.** With B in place, arrival alerts replace landing
  polls too: ~1–2 REST calls per insured flight lifetime (the T-2d ETA fetch,
  plus reconciliation passes).

## D. Governance: full automation (2026-07-27 audit → the autonomy ladder)

Audit verdict: only **weather** signals have an automated writer today;
geopolitical/exposure/schedule_drift have none. The exposure subsystem
(`policies` + `ingest_cursors`) is **100% unimplemented** (DDL + a dead
`PolicyRow` type, zero collector code). Route onboarding, DB-route insertion,
ML pricing, signal declaration/clearing, pins, lifecycle, and remove are all
human-only. The DB `routes` table and `config/routes.testnet.json` are never
synced by code — **routes whitelisted via the file/script are invisible to
the reconciler**. And `route_agent` is an UN-AUDITED second automation actor
(no actions_log, no pause_events, not even gated by GOV_DRY_RUN).

The ladder to a fully automated governance:

### L2 — complete the deterministic pipeline (no LLM needed)

- [ ] **P1 — URGENT mitigation: gate or disable `route_agent`.** It mutates
  the chain daily with no audit trail and ignores GOV_DRY_RUN (it loads
  `Config`, not `GovConfig`). Until absorbed: make it honor GOV_DRY_RUN and
  write actions_log, or drop it from the schedule.
- [ ] **P1 — `gov_onboard`: automated route onboarding, closing the
  invisibility gap.** One pipeline: discovery output → INSERT DB `routes`
  rows as `status='candidate'` (with sched_* columns filled from the same
  /schedules data — feeding gov_schedule_check for free) → auto-score
  (ML `p_delay` within rails, schedule stability from days_seen) →
  auto-promote to `active` + `whitelist_route` via GovSubmitter, capped
  (max N new routes/day, default terms only, on-chain term limits as
  backstop). Config flag chooses auto-promote vs propose-only (candidates
  wait for admin approval). This one job removes BOTH remaining humans-in-
  the-loop for onboarding AND populates the DB so the reconciler manages
  every route.
- [ ] **P1 — Exposure collector (the missing subsystem).** RPC event ingest
  of `InsuranceBought` → `policies` table (resume via `ingest_cursors`) →
  per-route/per-airport exposure vs vault free capital → `exposure` signals
  (elevated → premium multiplier; severe → pause new sales on that route).
  Schema is already in place; only the code is missing.
- [ ] **P1 — Absorb `route_agent` into the reconciler** (then DELETE it +
  `_lib/route_rules.ts` + legacy `_lib/governance.ts` helpers). `rules.ts`
  needs one new input: an `anchorPremium` (ML baseline) on `ReconcileInput`,
  fed by `AgentClient` in `reconciler.ts` (or a daily `pricing` signal);
  multipliers/clamps/hysteresis already exist. Also fix the Render `/price`
  schema drift (`dep_time_hhmm` + `distance_mi` missing → 422 → silent
  fallback).
- [ ] **P1 — Fleet-level guardrails for full autonomy.** Per-route rails are
  solid (clamps, 1-change/day, 2h hysteresis, pins, terms-validation,
  dry-run) but: (a) NO cap on mass-disable — one broad severe signal can
  pause the whole fleet in a tick; add max-pauses-per-run / max-%-of-fleet
  circuit breaker that flags instead of acting beyond it; (b) GOV_DRY_RUN
  is the only kill switch and needs a redeploy — add a runtime freeze flag
  (DB row the reconciler checks, admin-toggleable, absent-DB = frozen);
  (c) disable/enable flap damping (daily transition cap like premiums have).
- [ ] **P1 — Consolidate route truth: DB as canonical** once gov_onboard
  populates it. Authorizer reads enabled routes from the DB (file = seed;
  DB unreachable → fall back to file, per the DB-optional invariant);
  admin/reconciler disables then also stop *attestation*, not just purchase.
- [ ] **P2 — `gov_schedule_check`**: compare `routes.sched_*` (populated by
  gov_onboard) against live /schedules → `schedule_drift` signals (retimed
  → re-verify terms; dropped → disable). The last placeholder job.
- [ ] **P2 — `signals.type` migration**: add `ops` (non-weather airport
  delays) and `pricing` (ML anchor) types.

After L2, the ONLY human actions left in governance: appetite changes
(rails/defaults/term limits — owner), emergencies (pause, pins), and
approving candidates if propose-only mode is chosen. Everything else —
listing, pricing, pausing, re-enabling, exposure management — is automated
facts → rules → audited submitter.

### L3 — agentic layer (LLM judgment on top of the rails)

- [ ] **P2 — Analyst agent as "just another collector".** An LLM agent
  (Claude via API, cron or anomaly-triggered) that reads active signals,
  exposure metrics, cron-run health, candidate routes, and open-web
  context (storm forecasts, geopolitical news, airline disruptions) — and
  WRITES ONLY FACTS: schema-validated `signals` rows (severity + rationale
  in payload) and candidate-route annotations. It never holds keys, never
  calls the chain, and cannot exceed the reconciler's rails — the same
  facts-not-actions inversion the admin console uses, extended to a model.
  Guardrails: JSON-schema-validated output, per-run caps (max K signals),
  every proposal logged with reasoning, kill = drop its cron; admin pins
  still beat everything it does.
- [ ] **P2 — Auditor agent (read-only).** Daily review of actions_log +
  premium_adjustments + outcomes: flags anomalies (premium oscillation,
  routes disabled longer than their signals justify, revenue loss from
  over-pausing) to the admin console. Never writes anything but reports.
- Safety framing (why full autonomy is acceptable): three nested cages —
  on-chain (term limits, payoff ratio, admin-key-not-owner, pausable) →
  rules layer (rails clamps, hysteresis, daily caps, fleet breaker, pins)
  → agent layer (facts only, schema-validated, capped, auditable). The
  blast radius of a wrong agent judgment is a bounded premium tweak or an
  unnecessary pause — never insolvency, never a payout.

## E. Keeper bots: open-sourcing + operator incentives

Direction (2026-07-27, refined): the crons are **three tiers** —
**governance** (gov_signals, gov_reconcile, route_agent) and **oracle**
(fetcher, sale_authorizer — the AeroAPI callers, the trust root) stay
**centralized with us, by design**; only the **keeper/liquidator tier**
(classifier, settler, queue_maintainer, ttl_extender + the permissionless
housekeeping entry points) is the decentralization target. Keepers move no
new information on-chain — they only execute what the oracle already
attested — so opening them costs no trust. `npm run bot -- <name>`
(`dapp/scripts/run_bot.ts`) is the standalone runner for all tiers.

- [ ] **P1 — Package the KEEPER bots for third parties.** Extract/publish
  the keeper job code (classifier, settler, queue_maintainer, ttl_extender)
  with a README: no AeroAPI key needed, no DB needed, just RPC + a funded
  key (+ the keeper authorization until bounties land). Docker/one-liner
  examples (systemd, GitHub Actions, Acurast harness). The oracle and
  governance bots stay in-repo, ours.
- [ ] **P1 — DB-optional invariant (design rule, enforce forever).** Oracle
  and keeper tiers must run with NO database: history recording is
  best-effort (already true — `recordRun` no-ops without `GOVERNANCE_DB_URL`
  and swallows DB errors; the e2e suite runs DB-less). Any future DB feature
  must degrade, not gate: e.g. the `aeroapi_cache` (C) must fall back to
  direct API calls when the DB is unreachable. Only the governance tier may
  REQUIRE the DB — that tier is the DB.
- [ ] **P2 — Paid keeper-running (trustless): bounties.** Contract-level
  design sketch, for the next natural upgrade window:
  - `classify_flights` / `execute_settlements` / `run_queue_maintenance` /
    the targeted per-flight pair go **permissionless**: the keeper gate is
    spam control, not integrity (classification is deterministic from
    attested on-chain data). Add a per-flight bounty paid to the caller
    (e.g. fixed USDC per settled flight), funded by a small protocol fee on
    premiums (today 100% flows to underwriters; carve 1–3% ops fee) or the
    owner's `RecoveredBalance`.
  - `sweep_expired` / `prune_settled` / `extend_ttl`: already permissionless
    — add a caller tip (e.g. % of swept value, small fixed tip) so
    housekeeping self-funds.
  - Bounty griefing is benign: racing keepers fight over the same tx,
    losers pay their own failed-tx fees; the bounty just needs to exceed
    Soroban fees (tiny). Interim, non-contract option: pay keeper operators
    off-chain (grants/revenue share) against `cron_runs`-style attribution.
  - Explicitly OUT of scope: decentralizing the oracle or governance tiers.
    The oracle stays our keyed trust root (its future trust upgrade is the
    TEE/Acurast backend, unchanged contracts); governance stays the
    admin-keyed reconciler pipeline.

## F. Keeper hardening (2026-07-27 audit — mostly fixed same day)

Audit found the keeper tier was a set of blind single-shot triggers. Fixed
2026-07-27 (see Done): pre-flight reads so settler/queue/classifier submit
NO transaction when there is nothing to do (the on-chain empty path still
writes TTL extensions — blind 5-minute submits were pure fee/sequence
waste); settler drain loop (classify+settle passes until pending outcomes
hit zero, with `execute_settlements_bounded` 10→3→1 fallback so an
oversized batch can never stall settlement); queue skips while the vault
barrier is engaged; ttl prune loops until nothing more ages out; and
`invokeContract` retries once on txBadSeq (shared keeper key + overlapping
schedules). Remaining:

- [ ] **P2 — Distinguish simulation failure from submission failure** in
  `soroban_client` errors, so run logs can tell "would never succeed"
  (paused contract, auth) from "transient" — and jobs/monitors can react
  differently.
- [ ] **P2 — Expired-claim sweeper.** `flight_pool_manager.sweep_expired`
  and `reconcile_settled_active_entry` are permissionless but have NO
  automated caller: enumerate settled flights past `claim_expiry` (from
  events or `get_active_flights_page` + `get_flight_config`) and sweep
  them, so unclaimed payouts actually reach `RecoveredBalance` without a
  manual run.
- [ ] **P2 — Diagnostics consumer.** Nothing watches `MissingFlightData` /
  `FlightConfigMissing` / `page_miss` events — surface them on the /admin
  board so operators learn a restore/evict runbook is needed before the
  active-void timeout does it the hard way.

## G. Contract-level items (only when justified)

- [ ] **P2 — `Diverted` outcome variant.** Policy today: diverted pays as
  cancellation via `set_cancelled` (off-chain mapping, corroborated). A
  contract-level `Diverted` status is only needed if diversion economics ever
  diverge from cancellation (partial payout, delay-at-final-destination).
  If added: append to `FlightStatus` — variant order is XDR-load-bearing —
  and fold into the next natural contract upgrade, never alone.
- [ ] **P2 — Key-level `ExtendFootprintTTLOp` job** for idle Persistent
  entries (`Route`, `ClaimableBalance`, `TravelerFlights`), enumerated from
  events — the long-planned deeper TTL layer behind the daily `ttl_extender`.

---

*Update this file as items land; move completed items to a dated "Done"
section rather than deleting them.*

## Done

- 2026-07-27 — AeroAPI call economy v1: fetcher phase gates, authorizer
  /schedules far window + cached-attestation skip, outcome corroboration
  (cancelled/diverted), diverted-pays-as-cancellation policy, `gov_signals`
  airport-delay collector, mock-aeroapi expansion, E2E suite
  (`npm run test:e2e`).
- 2026-07-27 — Bots CLI (`npm run bot -- <name>`: every job single-shot
  runnable, DB-optional); route discovery (`npm run discover:routes`: NYC ×
  SEA/SFO/LAX/ORD/MIA matrix via origin/dest-filtered /schedules, ~60 calls
  for 200+ routes; idempotent — skips known routes, drops multi-leg idents
  the contract would reject; internal tool, not e2e-tested); fixed silent
  /schedules pagination truncation (max_pages) that could close valid
  far-window days.
- 2026-07-27 — Keeper hardening (§G): pre-flight skip reads in settler /
  queue / classifier (no tx when nothing to do — was 288 blind fee-bearing
  submits/day/job), settler drain loop with bounded-window (10→3→1)
  fallback, barrier-aware queue skip, ttl prune drain loop, txBadSeq retry
  in soroban_client, u32 helper.
