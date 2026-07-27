# TODO — Off-Chain Roadmap

Living roadmap for the off-chain layer (keepers, oracle, governance, ops).
Source: the 2026-07-27 AeroAPI spec review + full-system audit. The completed
contract-reorg checklist lives in [improvements.md](improvements.md); the
current architecture in [architecture.md](architecture.md).

Legend: **P0** = do before mainnet-serious traffic · **P1** = high value, not
blocking · **P2** = when scale demands it.

---

## A. Deployment & operational gaps (audit results — highest value)

- [ ] **P0 — Actually schedule the backend (prepped 2026-07-27; blocked on
  Vercel Pro).** Ready-made config exists: `dapp/vercel.backend.json` carries
  all 11 cron schedules — flip with
  `mv vercel.backend.json vercel.json && rm .vercelignore`, set the server
  env vars (four signer keys, `AEROAPI_KEY`, `GOVERNANCE_DB_URL`,
  `CRON_SECRET`, `ADMIN_EMAILS`, `AGENT_BASE_URL`), deploy. Until then the
  backend runs locally as bots (`npm run bot -- <name>`), which is the
  current operating mode. **Full ordered bring-up runbook: §H below.**
- [x] **P0 — Governance unblock (done 2026-07-27).** Owner
  (`GCEODBNV…E6KD`) called `add_admin(sentinel-governor GC2QDXUD…)` on the
  07-18 GovernanceModule (`CANSHOFU…`); `is_admin` now true, `GovAdminAdded`
  emitted. The reconciler can now submit for real — flip `GOV_DRY_RUN=false`
  in Vercel env once the backend is deployed (A/#1) and route_agent is gated
  (done) so it can't act ungoverned in prod.
- [x] **P0 — Seed routes (done 2026-07-27).** `npm run whitelist:routes`
  whitelisted AA100 (JFK→LAX, 45/450) and UA456 (ORD→SFO, 50/500) on-chain;
  both report `Active`. DL789 stays disabled (file `enabled:false`).
  NOTE: these are the 3 file routes — the ~200-route discovery run needs an
  AeroAPI key (C is not blocking). And they are NOT yet in the DB `routes`
  table, so the reconciler can't see them yet — the invisibility gap (D:
  gov_onboard / DB-as-canonical) until closed.
- [x] **P1 — Pending-outcome age monitoring (done 2026-07-27).**
  `/api/cron/health`: `pendingOutcomes` + `barrierEngaged` + `barrierSince`;
  the settler records first-seen in `ops_flags('barrier')` (best-effort,
  DB-optional); the public `/api/status/runs` feed carries
  `barrier: { engaged, since, age_secs, pending, stalled }` with
  `stalled: true` past 2 settler cycles (600s) — the alert condition.
  Remaining (needs a credential): wiring `stalled` to an external pager
  (email/Slack) — until then it is surfaced, not pushed.
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

- [x] **P1 — `aeroapi_cache` (done 2026-07-27).** Table + `cachedFetch`
  helper (~24h TTL for /schedules chunks), strictly DB-optional: no DB /
  DB error → direct call, failures never cached, stores best-effort.
  Migration applied live.
- [x] **P1 — Batched /schedules (done 2026-07-27, PAIR-batched).** One
  call per DIRECTED PAIR per ≤20-day chunk (200 routes share ~30 pairs;
  the pair filter also excludes multi-leg flight numbers server-side) —
  ~30 cached schedule calls/day at a 7-day horizon vs 2,400/day
  per-flight. Airline-only batching was evaluated and REJECTED: an
  unfiltered airline query returns the carrier's entire global schedule.
- [x] **P2 — Demand-driven near windows (done 2026-07-27, API side).**
  `POST /api/sale-auth/warm` marks (flight, day) hot; with
  `SALE_AUTH_DEMAND_MODE=true` the authorizer's near window attests hot
  days only (48h prune, garbage-tolerant — marks intersect the route/day
  grid). Default OFF. Remaining: the one-line frontend quote-view ping.
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

- [x] **P1 — URGENT mitigation: gate `route_agent` (done 2026-07-27).** It
  now honors GOV_DRY_RUN on every mutation (was the one actor ignoring the
  kill switch). Remaining half — actions_log parity — lands with the
  absorption below (its writes still bypass GovSubmitter until then).
- [x] **P1 — `gov_onboard` (done 2026-07-27).** Shipped as
  `_lib/governance/onboard.ts` + `/api/cron/gov-onboard` (6-hourly): file/
  chain→DB sync (LIVE-verified: AA100+UA456 synced as `active`, reconciler
  now evaluates them — invisibility gap closed), discovery-file candidate
  ingest (unattestable/conflicting idents skipped), capped promote via
  GovSubmitter — `GOV_ONBOARD_AUTO=true` opt-in, default propose-only,
  `GOV_ONBOARD_MAX_PER_RUN` cap, pins respected, GOV_DRY_RUN honored.
  Deferred bits: sched_* column fill + ML scoring hook (need AeroAPI /
  agent service).
- [x] **P1 — Exposure collector (done 2026-07-27, simpler design).**
  Shipped as `_lib/governance/exposure_collector.ts` + `/api/cron/
  gov-exposure` (hourly :07): reads AUTHORITATIVE on-chain state (payoff ×
  buyer_count per active flight vs vault TMA — no events mirror needed) and
  projects route/airport `exposure` signals (≥25% elevated / ≥50% severe,
  env-tunable), same self-expiring source-owned lifecycle as gov_signals;
  LIVE-verified against testnet. The `policies` event-ingest mirror
  (durable per-policy history via `ingest_cursors`) remains open as a P2
  analytics/audit item — the exposure SIGNAL no longer depends on it.
  UPDATE later same day: SHIPPED — `event_ingest.ts` mirrors
  InsuranceBought → policies and FlightSettled → settlements (cursor
  resume via ingest_cursors), runs inside the hourly gov_exposure job;
  live-verified over 118k real ledgers.
- [x] **P1 — Absorb `route_agent` (done 2026-07-27).** route_agent is now a
  facts-only COLLECTOR: daily ML baseline → `pricing` signals (reconciler
  consumes as `anchorPremium`), Open-Meteo verdicts → route-scoped
  `weather` signals; zero chain writes. Legacy `_lib/governance.ts` DELETED
  (whitelist script ported onto GovSubmitter; `OnChainRoute` moved into
  submitter.ts; route_rules keeps only pure weather/math). Render schema
  drift fixed (dep_time_hhmm + distance_mi sent when the DB row has them —
  columns fill via gov_onboard/admin). LIVE-verified across 200 routes
  against real Open-Meteo.
- [x] **P1 — Fleet-level guardrails (done 2026-07-27).** (a) mass-disable
  circuit breaker: per-run cap `max(3, 20% of fleet)`, beyond → flag;
  (b) runtime freeze: `ops_flags.gov_frozen` DB flag (migration
  `20260727140000_gov_guardrails.sql`, applied live) checked at the top of
  every reconciler run, admin-toggleable via `POST /api/admin/freeze` —
  LIVE-verified (frozen run takes zero actions); (c) flap damping: ≥2
  pause-state transitions per route per 24h → flag instead of transition.
- [x] **P1 — Consolidate route truth: DB as canonical (done 2026-07-27).**
  Authorizer reads `routes` where `status='active'` when the DB has rows;
  falls back to the file when `GOVERNANCE_DB_URL` is unset, the DB is
  unreachable, or the table is EMPTY (unseeded bootstrap) — an all-disabled
  table attests nothing rather than falling back. DB-optional invariant
  preserved (E2E runs the file path).
- [x] **P2 — `gov_schedule_check` (done 2026-07-27).** Daily 04:45; fills
  sched_*/distance_mi when NULL (authorizer-aligned cache keys — warm
  cache = zero extra calls) and emits schedule_drift signals (retimed ≥45m
  → elevated, dropped → severe). Fail-safe: failed/partial pair fetches
  are "couldn't verify", never "dropped" (learned live under quota).
- [x] **P2 — `signals.type` migration (done 2026-07-27).** `ops` and
  `pricing` types added in `20260727140000_gov_guardrails.sql`, applied
  live.

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

- [x] **P1 — Keeper bots runnable by third parties (done 2026-07-27,
  scoped per owner).** dapp/README "Run a keeper bot yourself": code links
  (run_bot.ts → jobs/ → soroban_client.ts) + copy-paste env/run example —
  RPC + funded key only, no AeroAPI, no DB. Deliberately NO npm package,
  NO docker (owner decision: where the TS runs is the operator's business).
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

- [x] **P2 — Sim-vs-submit error split (done 2026-07-27).** invokeContract
  errors carry [simulation] (would never succeed) vs [submission]
  (transient) prefixes.
- [x] **P2 — Expired-claim sweeper (done 2026-07-27).** ttl job sweeps
  settled Delayed/Cancelled flights past claim_expiry — candidates from
  the durable `settlements` event mirror (RPC retention ≪ claim window),
  amounts verified on-chain via get_flight_config, contract-idempotent,
  DB-optional (no DB → skip).
- [x] **P2 — Diagnostics consumer (done 2026-07-27).** GET
  /api/admin/diagnostics live-scans ~24h of oracle/controller/pool events
  (ttl_miss, cfg_missing, voided, timed_out, page_miss, prune_miss,
  evict_settled) — admin-gated, no storage needed.

## G. Contract-level items (only when justified)

- [ ] **P2 — `Diverted` outcome variant.** Policy today: diverted pays as
  cancellation via `set_cancelled` (off-chain mapping, corroborated). A
  contract-level `Diverted` status is only needed if diversion economics ever
  diverge from cancellation (partial payout, delay-at-final-destination).
  If added: append to `FlightStatus` — variant order is XDR-load-bearing —
  and fold into the next natural contract upgrade, never alone.
- [x] **P2 — Key-level `ExtendFootprintTTLOp` (done 2026-07-27).** ttl job
  extends idle Persistent keys to ~120d in ≤20-key batches: governance
  `Route(f,o,d)` rows (from the DB) + controller `TravelerFlights(buyer)`
  (from the policies mirror). LIVE-verified: 202 route keys extended in 11
  txs. ClaimableBalance keys remain (needs Credited-event ingest).

## H. Total-system testnet bring-up (the "turn it on" runbook)

Goal: the WHOLE system running unattended on testnet — chain state seeded,
ML service serving, all 12 crons firing on a schedule, UI pointing at live
APIs. Ordered: each step's output feeds the next. The only hard blocker is
**Vercel Pro** (step 2); everything else is config + verification.

### Step 0 — already live (no action needed)

- [x] **Contracts deployed + seeded** (07-18 testnet deploy in
  `deployments/testnet.json`; dapp bindings generated from the same wasm):
  Controller `CCWDQVAJ…`, GovernanceModule `CANSHOFU…`, OracleAggregator
  `CBSX3KRT…`, RiskVault, FlightPoolManager `CD6XRCMK…`. Owner ran
  `add_admin(sentinel-governor)`; **202 routes whitelisted Active** on-chain.
  No further on-chain deployment is needed for testnet.
- [x] **Supabase "sentinel" live**: every migration applied
  (governance_core, cron_runs, gov_guardrails, aeroapi_cache, event
  mirror); 202 route rows DB-synced; L2 pipeline live-verified against it.
- [x] **ML model v3 artifacts committed** (`agent/artifacts/`, AUC 0.789).
- [x] **Interim operating mode**: `npm run bot -- <name>` runs every job
  locally — the system is fully operable by hand today; the steps below
  only replace the hand with schedules.

### Step 1 — ML pricing service (Render — free tier is fine)

- [ ] Deploy (or redeploy) the `render.yaml` web service at repo root →
  serves agent v3 (`GET /healthz` must show version `…-btsM24-arr180m`).
  Optionally set `AGENT_TOKEN` (bearer auth on /price). Record the service
  URL — it becomes `AGENT_BASE_URL` in step 2. Consumers: the daily
  `/api/cron/agent` (pricing signals) and gov_onboard's ML scoring hook.

### Step 2 — backend + UI on Vercel (NEEDS PRO — the blocker)

- [ ] **Flip the config**: `cd dapp && mv vercel.backend.json vercel.json
  && rm .vercelignore`. One project then serves the vite UI *and* `/api`.
  The prepped config now carries **12 crons** (gov-schedule-check daily
  04:45 was added 2026-07-27 — it was missing).
- [ ] **Set project env vars** (server-side, from gitignored `dapp/.env`):
  - Chain: `STELLAR_RPC_URL`, `STELLAR_NETWORK_PASSPHRASE` (testnet)
  - Signers: `ORACLE_SECRET_KEY` (sentinel-oracle), `KEEPER_SECRET_KEY`
    (sentinel-keeper), `TTL_EXTENDER_SECRET_KEY`,
    `GOVERNANCE_ADMIN_SECRET_KEY` (sentinel-governor) — the owner key is
    NEVER deployed
  - Services: `AEROAPI_KEY`, `GOVERNANCE_DB_URL` (Supavisor pooler :6543 —
    direct host is IPv6-only), `AGENT_BASE_URL` (+ `AGENT_TOKEN` if set),
    `SUPABASE_URL` + `SUPABASE_ANON_KEY` (admin console)
  - Ops: `CRON_SECRET` (generate; Vercel sends it as the Bearer header —
    without it the cron endpoints fall back to accepting Vercel headers),
    `ADMIN_EMAILS`
  - Deliberately UNSET (defaults are the safe mode): `GOV_DRY_RUN`
    (unset = live submits), `GOV_ONBOARD_AUTO` (unset = propose-only),
    `SALE_AUTH_DEMAND_MODE` (unset = full near-window)
- [ ] **Deploy, then verify schedules**: every cron shows a run in the
  Vercel cron dashboard AND a row in `cron_runs` within its first period
  (settle/queue ≤5 min, classify/gov-* ≤1 h, fetcher/authorize ≤2 h,
  agent/ttl/schedule-check ≤24 h).

### Step 3 — end-to-end smoke on the running system

- [ ] `/api/cron/health` and public `/api/status/runs` green — barrier
  `stalled: false`, no accumulating `pendingOutcomes`.
- [ ] **One full policy lifecycle through the UI**: buy on a near-term
  whitelisted flight (sale-auth attestation must be fresh) → fetcher ETA
  write at T-2d/watch window → outcome recorded → classify → settle →
  claim pays. This exercises oracle, keeper, and contract tiers together.
- [ ] **Governance loop observed hands-off**: gov-signals/gov-exposure
  writing signals, gov-reconcile producing `actions_log` rows (or clean
  no-ops) for several consecutive hours without intervention.
- [ ] **Admin brake drill**: `POST /api/admin/freeze` on → next reconcile
  run takes zero actions → freeze off. Check `/api/admin/diagnostics`.
- [ ] AeroAPI quota watch: if the billing period hasn't reset, fetcher/
  authorizer runs are quota-breakered (safe, by design) — sale windows
  won't open until it resets; everything else runs normally.

### Step 4 — post-bring-up hardening (existing items, now unblocked)

- [ ] External pager on `stalled` (A/P1 remainder — needs a Slack webhook).
- [ ] Cadence relaxation after observing JIT hit-rate (A/P2).
- [ ] `GOV_ONBOARD_AUTO=true` once propose-only has built confidence (D).
- [ ] L3 agents (D — needs `ANTHROPIC_API_KEY`).

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
- 2026-07-27 — Keeper hardening (§F): pre-flight skip reads in settler /
  queue / classifier (no tx when nothing to do — was 288 blind fee-bearing
  submits/day/job), settler drain loop with bounded-window (10→3→1)
  fallback, barrier-aware queue skip, ttl prune drain loop, txBadSeq retry
  in soroban_client, u32 helper.
- 2026-07-27 — route_agent gated behind GOV_DRY_RUN (closes the ungoverned-
  actor hole until absorption); /api/cron/health exposes `pendingOutcomes`
  + `barrierEngaged` (the settlement-barrier gauge, best-effort read).
- 2026-07-27 — Governance L2 core shipped + LIVE-verified on testnet/
  Supabase: `gov_exposure` (on-chain concentration → exposure signals),
  `gov_onboard` (file/chain→DB sync — invisibility gap CLOSED for
  AA100/UA456, reconciler now evaluates them; candidate ingest; capped
  opt-in promote), fleet guardrails (`ops_flags.gov_frozen` runtime brake
  + `/api/admin/freeze` + circuit breaker + flap damping; migration
  applied live), authorizer routes now DB-canonical with file fallback,
  `vercel.backend.json` deploy-later config. E2E 61 checks.
- 2026-07-27 — AeroAPI key live: real route intake ran end-to-end — 297
  routes found in 60 calls, 200 appended to the governance JSON,
  whitelisted on-chain, DB-synced via gov_onboard. route_agent absorbed
  (facts-only collector; legacy chain helpers deleted; whitelist script
  on GovSubmitter). aeroapi_cache + PAIR-batched /schedules (~30 cached
  calls/day vs 2,400). Barrier age tracking end-to-end (settler →
  ops_flags → health + public /status `stalled` flag). Keeper-bot
  run-it-yourself README section.
