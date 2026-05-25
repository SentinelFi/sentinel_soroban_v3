# Phase 12 — Executor (centralized cron) port

Status: complete
Started: 2026-05-25
Completed: 2026-05-25

---

## Goal

Port the working `executor/centralized_cron/` from the phase-2 repo
(`../stellar_phase_2/executor/centralized_cron/`) into this repo, adapted to
the Phase 3 contract topology. Result is a runnable, type-checking TypeScript
service that schedules the on-chain keeper jobs against a deployed contract
set (testnet first, futurenet/mainnet later).

The phase-2 executor is the source of truth for the implementation pattern;
this phase is a faithful port with focused diffs where the contracts have
changed underneath. **No greenfield architecture.**

## Reference

- **Source:** `../stellar_phase_2/executor/centralized_cron/` — copy the
  source layout, `package.json`, `tsconfig.json`, helper scripts, and the
  HTTP server / run-log scheme.
- **Target:** `executor/centralized_cron/` in this repo. Mirrors the source
  layout so `executor/acurast/` can land in a later phase without
  restructuring.

## Diffs from the phase-2 port

These are the surface-area changes that the Phase 3 contract reorg forces.
Everything else is a straight copy.

| Area | Phase 2 | Phase 3 |
|---|---|---|
| Contracts in config | `recovery_pool`, `oracle`, `controller`, `risk_vault`, `governance` | **drop** `recovery_pool`; **add** `flight_pool_manager` |
| Settler cron | `execute_settlements` *also* drained queue + snapshot | **Settler only** — `execute_settlements` does not touch the queue (audit M-03 split) |
| Queue / snapshot | folded into settler | **New cron** — `QueueMaintainer` calls `run_queue_maintenance` (every 5 min, decoupled) |
| TTL extender contract list | 5 contracts incl. `recovery_pool` | 5 contracts: oracle, controller, risk_vault, governance, **flight_pool_manager** |
| Permissionless prune | n/a | **Add** `oracle.prune_settled` call to the TTL extender daily run (Phase 6) |
| Cron cadence | classifier 30m, settler 10m | classifier **60m**, settler **5m**, queue maintainer **5m** (architecture-stated cadences) |
| Optional health metric | — | Expose `whitelist_enabled` + `is_paused()` on `/api/health` so the UI can show protocol state (Phase 11 read accessor) |

## Out of scope for this phase

- **Frontend** — Phase 13 (or later).
- **Acurast TEE backend** — separate phase; lands as `executor/acurast/`.
- **Deployment scripts** — there is no `scripts/` dir in this repo yet (the
  phase-2 repo has one). Deferred to Phase 14+ (deploy).
- **Mock AeroAPI server** — phase-2 has `mock-api/`; we'll port that
  alongside or in Phase 13.
- **Real testnet smoke test.** Phase 12 closes on `npm run build` (tsc
  --noEmit) passing — actual against-testnet validation needs deployed
  contracts (no scripts/deploy yet). Smoke-test gate moves with deploy phase.

## Dependencies

- Phase 11 closed (contracts at their final shape for this generation).
- Node 22+, npm available locally (the same toolchain the phase-2 repo uses).
- No on-chain dependencies — the executor doesn't change contract code.

## Context Manifest

### Files to mirror from `../stellar_phase_2/executor/centralized_cron/`
- `package.json`, `tsconfig.json`, `.env.example`, `test.sh`, `test_pipeline.sh`
- `src/index.ts` — cron schedule wiring
- `src/config.ts` — env loader
- `src/types.ts` — Config, FlightStatus, RunLogEntry
- `src/soroban_client.ts` — generic Soroban tx builder (assemble + bump + sign + submit)
- `src/aeroapi_client.ts` — fetch wrapper with retry/backoff
- `src/flight_data_fetcher.ts` — Cron #1 (oracle)
- `src/flight_classifier.ts` — Cron #2 (keeper)
- `src/settlement_executor.ts` — Cron #3 (keeper)
- `src/ttl_extender.ts` — Cron #4 (own key)
- `src/run_log.ts` — in-memory ring buffer
- `src/server.ts` — HTTP API (health / logs / trigger)
- `src/run_once.ts` — CLI for single-job invocation
- `src/test_*.ts` — integration tests against testnet / mock

### Files to add (Phase 3 only)
- `src/queue_maintainer.ts` — Cron #3b, calls `run_queue_maintenance`
- Update `src/ttl_extender.ts` to also call `oracle.prune_settled`
- Update `src/server.ts` `/api/trigger/queue_maintainer` endpoint

### Project files to read (this repo)
- `contracts/controller/src/lib.rs` + `settle.rs` — confirm
  `execute_settlements`, `classify_flights`, `run_queue_maintenance`
  signatures.
- `contracts/oracle_aggregator/src/lib.rs` — confirm `prune_settled`,
  `set_estimated_arrival`, `set_landed`, `set_cancelled` signatures.
- `spec/architecture.md` — cron cadences, executor section.

## Pre-work Notes

**Decisions confirmed by user (chat 2026-05-25):**

- Port the phase-2 centralized cron in full ("same thing but for the new
  contracts"). ✓
- Stack: TypeScript + Node + tsx + @stellar/stellar-sdk 14 + node-cron +
  express + dotenv (unchanged). ✓
- Place under `executor/centralized_cron/` (mirrors phase-2 layout; leaves
  room for `executor/acurast/`). ✓

**Decisions clarified from in-repo state:**

- **Cron cadences** match `spec/architecture.md`:
  - FlightDataFetcher: every 2 hours
  - FlightClassifier: every 1 hour
  - SettlementExecutor: every 5 minutes
  - **QueueMaintainer**: every 5 minutes (offset from settler to avoid
    seq# contention)
  - TTLExtender + prune: daily at 00:00 UTC
- **Settler / QueueMaintainer key sharing.** Same `KEEPER_SECRET_KEY` for
  both — they're authorized as the same `AuthorizedKeeper` on Controller.
  Schedule them off-tempo (settler at `:00/:05/:10/...`, queue maintainer at
  `:02/:07/:12/...`) so sequence numbers don't collide if both fire close
  together.
- **TTL extender behavior.** Same approach as phase-2: call each contract's
  `extend_ttl()` no-auth entry. The deeper Cron #4 (`ExtendFootprintTTLOp`
  over keyed Persistent entries — `FlightConfig`, `FlightData`, `Route`,
  `TravelerFlights`, `ClaimableBalance`, `BuyerWhitelisted`) is a follow-up
  phase (Improvement #6 / executor v2) — out of scope here.
- **Health endpoint additions.** Add `whitelist_enabled` and
  `is_paused()` reads to `/api/health` so the frontend (and ops) can see
  current protocol state at a glance.
- **Network target.** Default `.env.example` points to testnet
  (`https://soroban-testnet.stellar.org`) — same as phase-2. Local /
  futurenet are config swaps.

**Implementation hints:**

- The `assemble + bump 40%` pattern in `soroban_client.ts` is load-bearing
  — it's the workaround for Soroban simulation underestimating resource
  costs on deep cross-contract calls (buy_insurance hits Controller →
  Pool + Oracle + Vault + Token). Keep it verbatim.
- `parseFlightStatus()` in `flight_data_fetcher.ts` handles multiple
  scValToNative output shapes (number / string / array / object). Copy
  verbatim — same SDK version 14 means same quirks.
- Status enum order matters — `FlightStatus` indices must match the
  Soroban contract's enum order: `NotInitiated, Active, Landed, Cancelled,
  ToBeSettledOnTime, ToBeSettledDelayed, ToBeSettledCancelled, Settled`.
  Order is **unchanged** from phase 2, so the phase-2 array still applies.

## Subtasks

- [x] 1. **Scaffold** `executor/centralized_cron/` — `package.json`,
      `tsconfig.json`, `.env.example`, `.gitignore`. Update `package.json`
      to drop `recovery_pool` references; bump dep versions if needed but
      keep SDK at v14 line.
- [x] 2. **Port `types.ts`** — drop `recoveryPoolId`, add `flightPoolManagerId`.
      Add `queue_maintainer` to `JobName`. Keep `FlightStatus` enum order.
- [x] 3. **Port `config.ts`** — same env loader; updated required-env list
      (drop `RECOVERY_POOL_ID`, add `FLIGHT_POOL_MANAGER_ID`).
- [x] 4. **Port `soroban_client.ts`** — verbatim copy. Assemble + 40% bump +
      sign + submit + poll loop unchanged.
- [x] 5. **Port `aeroapi_client.ts`** — verbatim copy. Retry / backoff /
      404-on-not-found unchanged.
- [x] 6. **Port `flight_data_fetcher.ts`** — oracle interfaces (`set_estimated_arrival`,
      `set_landed`, `set_cancelled`, `get_active_flights`, `get_flight_data`)
      are unchanged. `FlightData` widened with `settled_at` in Phase 6 —
      doesn't affect the fetcher (it only reads `status` / `estimated_arrival_time`).
- [x] 7. **Port `flight_classifier.ts`** — `controller.classify_flights(keeper)`
      signature unchanged.
- [x] 8. **Port + update `settlement_executor.ts`** — `controller.execute_settlements(keeper)`
      signature unchanged. **Remove** the comment that says it drains the
      queue / snapshots (M-03 split moved both out).
- [x] 9. **NEW `queue_maintainer.ts`** — wraps `controller.run_queue_maintenance(keeper)`.
      Mirrors the settler structure.
- [x] 10. **Port + update `ttl_extender.ts`** — contracts list now:
       OracleAggregator, Controller, RiskVault, GovernanceModule,
       **FlightPoolManager** (drop RecoveryPool). After all `extend_ttl()`
       calls, also call `oracle.prune_settled()` (permissionless, no auth,
       Phase 6) as a daily cleanup.
- [x] 11. **Port `run_log.ts`** — add `queue_maintainer` to the `JobName`
       union + buffer + health response.
- [x] 12. **Port + update `server.ts`** — `POST /api/trigger/queue_maintainer`
       endpoint added. `/api/health` reads `whitelist_enabled` and
       `paused()` from Controller.
- [x] 13. **Port + update `index.ts`** — cron schedule:
       ```
       FlightDataFetcher:  0 */2 * * *      (every 2h at :00)
       FlightClassifier:   0 * * * *         (hourly at :00)
       SettlementExecutor: */5 * * * *       (every 5min)
       QueueMaintainer:    2-59/5 * * * *    (every 5min, offset by 2)
       TTLExtender:        0 0 * * *         (daily 00:00 UTC)
       ```
- [x] 14. **Port `run_once.ts`** — add `queue` as a subcommand alongside
       `fetch / classify / settle`.
- [x] 15. **Port test helper scripts** — `test.sh`, `test_pipeline.sh`.
       `test.sh` boots the in-repo `../mock-api/` and runs
       `test_run_log.ts` (no network) + `test_aeroapi.ts` (mock-api).
       `test_pipeline.sh` requires deployed contracts; gated by env vars
       with a clear error if anything's missing, fully wired up in the
       deploy phase.
- [x] 16. **`npm install` + `npx tsc --noEmit`** — the close-out gate. No
       runtime test against testnet (needs deployed contracts).
- [x] 17. **Docs** — append executor entry to `spec/architecture.md`,
       add Phase 12 row to `spec/progress.md`.

## Gate

- `executor/centralized_cron/` exists with all source files.
- `cd executor/centralized_cron && npm install` succeeds.
- `cd executor/centralized_cron && npx tsc --noEmit` clean (zero errors).
- `cd executor/centralized_cron && bash test.sh` → run-log 29/29 +
  aeroapi 12/12 (41/41 PASS).
- `cd executor/mock-api && bash test.sh` → 14/14 PASS.
- `cargo test --workspace` → 295/295 PASS across 8 crates (includes
  `group10_executor_simulation.rs` cron-orchestration tests).
- `.env.example` documents all required env vars including
  `FLIGHT_POOL_MANAGER_ID` (NEW) and the dropped `RECOVERY_POOL_ID`.

A live testnet smoke test (`npm run test:pipeline`) is **deferred** to the
deploy phase — needs deployed contract IDs which don't exist yet in this
repo.

### Layer 1 + mock-api follow-up (2026-05-25)

After the initial scaffold, two follow-ups landed:

- **`executor/mock-api/`** — ported verbatim from the phase-2 repo
  (`../stellar_phase_2/mock-api/`). Express server returning
  AeroAPI-shaped responses against `scenarios.json`. `bash test.sh` →
  14/14 PASS (curls all four scenarios + unknown ident).
- **`contracts/integration_tests/src/tests/group10_executor_simulation.rs`**
  — 7 Rust integration tests pinning down the contract behaviour under
  cron-style activation: fetcher push, classifier, settler (audit M-03:
  must NOT drain queue), queue maintainer (the actual drainer), pending
  flight carries across ticks (ttl_miss + recovery), daily TTL extender +
  prune, and the full 5-cron orchestration over a mixed portfolio (on-time
  + delayed + cancelled + underwriter queue, all settled in one cycle).
  7/7 PASS.

Full workspace: **295 / 295 tests pass** across 8 crates (was 288 at
Phase 11 close; +7 from group10).

---

## Work Log

### Session 2026-05-25

Reading the phase-2 executor at `../stellar_phase_2/executor/centralized_cron/`
to confirm port shape. 21 source files; 4 production cron jobs + helpers
+ tests + HTTP API.

Diffs from phase-2 locked in via the table above. Port begins with the
scaffold (subtask 1) and proceeds top-down.

All 17 subtasks landed in one session. Post-scaffold the user requested
Layer-1 test coverage + mock-api port; both added as a follow-up pass
(group10 integration test, mock-api fixture, run-log + aeroapi TS tests,
`test.sh` wrapper). `test_pipeline.sh` ships gated behind env vars with
a clear "deploy first" error message — the corresponding `test_pipeline.ts`
driver ships in the deploy phase.

### Session 2026-05-25 — Completed

Phase validated by user. All gate conditions met.

---

## Completion Summary

**What was built:**

- **`executor/centralized_cron/`** — TypeScript service that schedules five
  cron jobs against the Phase 3 contracts:
  - **FlightDataFetcher** (Cron #1, every 2h, oracle key) — reads
    `OracleAggregator.get_active_flights()`, calls AeroAPI for each, writes
    `set_estimated_arrival` / `set_landed` / `set_cancelled` back to oracle.
  - **FlightClassifier** (Cron #2, hourly, keeper key) — triggers
    `Controller.classify_flights(keeper)`.
  - **SettlementExecutor** (Cron #3, 5m, keeper key) — triggers
    `Controller.execute_settlements(keeper)`. Audit M-03: settler no longer
    drains the queue.
  - **QueueMaintainer** (Cron #3b NEW, 5m offset by 2, keeper key) — triggers
    `Controller.run_queue_maintenance(keeper)` for queue drain + snapshot.
  - **TTLExtender** (Cron #4, daily, own key) — calls `extend_ttl()` on all
    5 contracts plus `OracleAggregator.prune_settled()` (Phase 6 permissionless
    cleanup).
- **`executor/mock-api/`** — Express server returning FlightAware-shaped
  responses against `scenarios.json`. Local-only AeroAPI replacement.
- **HTTP API** (`server.ts`) — `/api/health` (with `whitelist_enabled` and
  `paused()` reads, Phase 11 surface), `/api/logs`, `POST /api/trigger/{job}`.
- **CLI** (`run_once.ts`) — `fetch / classify / settle / queue / ttl`
  one-shot invocations.
- **Test infra** — `test.sh` boots mock-api + runs run-log (29/29) + aeroapi
  (12/12). `test_pipeline.sh` env-gated, errors clearly if contract IDs
  aren't deployed. Rust-side `group10_executor_simulation.rs` adds 7
  cron-orchestration integration tests.

**Key decisions locked in:**

- **TypeScript stack at SDK v14.6.1** — preserves the `assemble + 40%
  resource bump` workaround that's load-bearing for deep cross-contract
  calls (`buy_insurance` → Controller → Pool + Oracle + Vault + Token).
- **Recovery pool removed from executor surface** — replaced by
  `FLIGHT_POOL_MANAGER_ID` in env / config / TTL extender contracts list.
- **Queue maintainer is its own cron** (audit M-03) — same keeper key as
  settler but scheduled off-tempo (settler at `:00/:05`, queue at `:02/:07`)
  to avoid sequence-number contention.
- **Cron cadences match `spec/architecture.md`** — classifier hourly (was
  30m in phase-2), settler 5m (was 10m), queue 5m, fetcher 2h, TTL daily.
- **Default `.env.example` points to testnet** — same as phase-2; futurenet
  / mainnet / local are env-only swaps.
- **TS tests run locally with no network** — mock-api + ring-buffer +
  AeroAPI parser are deterministic. Live testnet smoke (`test_pipeline.ts`)
  is correctly deferred to the deploy phase.
- **Deeper Persistent-key TTL extension** (FlightConfig / FlightData /
  Route / TravelerFlights / ClaimableBalance / BuyerWhitelisted via
  `ExtendFootprintTTLOp`) is **out of scope here** — that's executor v2 /
  Improvement #6. Current TTL cron only calls each contract's instance-
  level `extend_ttl()` + `prune_settled`.

**Files created:**

```
executor/centralized_cron/
├── package.json
├── tsconfig.json
├── .env.example
├── .gitignore
├── test.sh
├── test_pipeline.sh
└── src/
    ├── index.ts
    ├── config.ts
    ├── types.ts
    ├── soroban_client.ts
    ├── aeroapi_client.ts
    ├── flight_data_fetcher.ts
    ├── flight_classifier.ts
    ├── settlement_executor.ts
    ├── queue_maintainer.ts        # NEW for Phase 3 (audit M-03)
    ├── ttl_extender.ts
    ├── run_log.ts
    ├── server.ts
    ├── run_once.ts
    ├── test_run_log.ts
    └── test_aeroapi.ts

executor/mock-api/
├── package.json
├── tsconfig.json
├── scenarios.json
├── README.md
├── test.sh
├── .gitignore
└── src/server.ts

contracts/integration_tests/src/tests/group10_executor_simulation.rs
spec/phases/phase-12-executor-centralized-cron.md (this file)
```

**Files modified:**

- `contracts/integration_tests/src/tests/mod.rs` — register `group10`.
- `spec/architecture.md` — executor section: confirm centralized cron exists.
- `spec/progress.md` — Phase 12 row + Current Phase header.

**Final gate (all green):**

- `cargo test --workspace` → **295 / 295** across 8 crates.
- `executor/mock-api && bash test.sh` → **14 / 14**.
- `executor/centralized_cron && bash test.sh` → **41 / 41** (29 + 12).
- `executor/centralized_cron && npx tsc --noEmit` → exit 0.

**For the next phase to know:**

- The executor is **fully built and locally tested but not yet pointed at
  deployed contracts**. The next obvious phase is **deploy scripts** —
  ships `scripts/deploy*.{sh,ts}` plus `test_pipeline.ts` and
  `test_real_api.ts` driver scripts that activate the gated
  `test_pipeline.sh` and `test:real` npm targets.
- **Acurast TEE backend** is the parallel option — wraps the same core
  cron logic under `executor/acurast/`. Same `core/` extraction would
  benefit both. Not a blocker for deploy.
- **Frontend** (Phase 14+) consumes `/api/health`, `/api/logs`,
  `controller.get_flights_for_traveler`, `controller.is_whitelisted`,
  `controller.whitelist_enabled`. All already exposed.
- Phase 11 (buyer whitelist) is still showing `in_progress` in
  `spec/progress.md` — user-side validation pending (per phase-bundling
  convention, user runs `/start-phase N+1` before `/complete-phase N`).
  Close it via `/complete-phase 11` whenever ready.

**Known limitations / deferred items:**

- Live testnet `test_pipeline.ts` smoke test — needs deployed contracts.
- AeroAPI real-key test (`test_real_api.ts` in phase-2) — needs paid key.
- Deeper key-level `ExtendFootprintTTLOp` cron — Improvement #6 / executor v2.
- Acurast TEE backend — separate phase.

---

## Files Created (planned)

- `executor/centralized_cron/package.json`
- `executor/centralized_cron/tsconfig.json`
- `executor/centralized_cron/.env.example`
- `executor/centralized_cron/.gitignore`
- `executor/centralized_cron/src/index.ts`
- `executor/centralized_cron/src/config.ts`
- `executor/centralized_cron/src/types.ts`
- `executor/centralized_cron/src/soroban_client.ts`
- `executor/centralized_cron/src/aeroapi_client.ts`
- `executor/centralized_cron/src/flight_data_fetcher.ts`
- `executor/centralized_cron/src/flight_classifier.ts`
- `executor/centralized_cron/src/settlement_executor.ts`
- `executor/centralized_cron/src/queue_maintainer.ts` (NEW)
- `executor/centralized_cron/src/ttl_extender.ts`
- `executor/centralized_cron/src/run_log.ts`
- `executor/centralized_cron/src/server.ts`
- `executor/centralized_cron/src/run_once.ts`
- `executor/centralized_cron/test.sh`
- `executor/centralized_cron/test_pipeline.sh`
- `spec/phases/phase-12-executor-centralized-cron.md` (this file)

## Files Modified

- `spec/architecture.md` — executor section: confirm centralized cron exists.
- `spec/progress.md` — add Phase 12 row, update current phase.
