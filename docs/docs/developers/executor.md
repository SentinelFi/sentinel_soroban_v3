---
sidebar_position: 4
title: Off-Chain Executor
---

# Off-Chain Executor

The off-chain executor drives protocol automation: it triggers on-chain transitions but never decides flight outcomes locally. It runs as Vercel serverless functions in [`dapp/api/cron/`](https://github.com/SentinelFi/sentinel_soroban_v3/tree/main/dapp/api/cron), in the same Vercel project as the dApp frontend (schedules in [`dapp/vercel.json`](https://github.com/SentinelFi/sentinel_soroban_v3/blob/main/dapp/vercel.json)).

The oracle backend is intentionally swappable: contracts only check authorization against owner-rotatable addresses, so migrating to a different backend requires one owner transaction per contract, not a redeploy.

## Signing identities

Four trusted identities drive the protocol; their addresses are registered on-chain and every entry point checks the caller.

| Identity | Authorized for | Env var |
|---|---|---|
| **Oracle** | Oracle Aggregator: `open_sale`/`close_sale`, `set_estimated_arrival`, `set_landed`, `set_cancelled` | `ORACLE_SECRET_KEY` |
| **Keeper** | Controller: `classify_flights`, `execute_settlements`, `run_queue_maintenance` | `KEEPER_SECRET_KEY` |
| **Governance admin** | Governance Module route mutations, used by the manual intake scripts, the governance jobs, and admin-console actions. An admin the owner delegates via `add_admin` — never the owner key. | `GOVERNANCE_ADMIN_SECRET_KEY` |
| **TTL extender** | Permissionless housekeeping: `extend_ttl` on all five contracts, `prune_settled` (any funded account works) | `TTL_EXTENDER_SECRET_KEY` |

## Jobs

Ten scheduled jobs. `JOB_REGISTRY` in [`dapp/api/_lib/governance/runs.ts`](https://github.com/SentinelFi/sentinel_soroban_v3/blob/main/dapp/api/_lib/governance/runs.ts) is the source of truth for names, schedules, and signers.

| Job | Schedule | Calls | Signs as |
|---|---|---|---|
| Flight data fetcher | Every 2 hours | The settle sweep — `set_estimated_arrival`, `set_landed`, `set_cancelled` on the oracle, only for insured flights past scheduled arrival + 5h; `classify_flight` + `settle_flight` on the controller after each outcome write | Oracle key (keeper key for the targeted settlement) |
| Flight classifier | Hourly | `classify_flights` on the controller | Keeper key |
| Settlement executor | Every 5 minutes | `classify_flights` + `execute_settlements` on the controller, looped until the oracle reports no pending outcomes (bounded passes per run) | Keeper key |
| Queue maintainer | Every 5 minutes, offset | `run_queue_maintenance` on the controller (drains the deposit and withdrawal queues + records the share-price snapshot) | Keeper key |
| TTL extender | Daily | `extend_ttl` on all five contracts (instance-storage renewal) and `prune_settled` on the oracle | Any funded key |
| Exposure brake | Hourly, :07 | Liability concentration ≥50% of vault capacity on one route or airport → `disable_route`; also mirrors `InsuranceBought` events for exposure counting | Governance-admin key |
| Weather | Every 2 hours, :20 | `update_route_terms` — a flat storm surcharge over the fleet-file base; an EXTREME forecast pauses the route instead | Governance-admin key |
| Reprice | Monthly | Advisory ML repricing proposal (an admin applies it); live routes priced above the base cap are paused | Governance-admin key |
| Revive | Hourly, :40 | `enable_route` — the single counterpart to every automated pause: re-checks each open hold against its own cause's predicate and re-enables once the last one clears | Governance-admin key |
| Fleet sync | Every 6 hours, :15 | Route status file/chain → governance DB. Route *intake* is a manual admin pipeline, never a cron | Governance-admin key |

Schedules are defaults (defined in `dapp/vercel.json`), not on-chain constraints — adjust them to your own operational needs. Jobs are single-flight (a tick is skipped while the previous run of the same job is still in progress), and all transaction submission is serialized per signing key with automatic rebuild-and-retry on sequence conflicts, so jobs sharing a key cannot race each other's account sequence.

Outcome-to-settlement latency does not depend on the rotating sweeps: whichever job writes an outcome immediately drives that exact flight through the controller's `classify_flight` and `settle_flight` entry points, so the vault's settlement barrier releases within seconds. The sweeping classifier and settler remain as repair backstops.

## How pausing works

Five of the ten jobs are governance automation, and they all share one shape: **detector → executor → ledger → revive.** Each detector owns a single danger and fires on its own evidence — a dead flight found by the buy-click route guard, liability concentration, an EXTREME forecast, an over-cap price, or a human admin. None of them touch the chain directly. All of them go through one executor, which writes an open row to the `interventions` ledger and only then calls `disable_route`; the row is written first so the record survives a failed chain write.

The hourly revive job is the single counterpart. It re-checks every open row against its own cause's predicate and re-enables the route when the last hold clears — except admin holds, which only a human closes. That means a route can be held off for several independent reasons at once and comes back only when all of them are gone. Detail: [architecture.md](https://github.com/SentinelFi/sentinel_soroban_v3/blob/main/spec/architecture.md#off-chain-governance-automation).

## Sale authorization is not a job

`buy_insurance` requires a live oracle sale authorization, but nothing polls for one. Authorization happens **just in time**, on the buy click: the frontend calls `POST /api/sale-auth/request`, which checks AeroAPI for that single flight and attests via `open_sale` that the instance is scheduled and not cancelled. Cancelled or unverifiable instances are refused, as is anything inside the 24-hour lead cutoff, and a purchase with no live attestation fails closed.

This replaced a fleet-wide polling cron on 2026-07-31. The old job attested every enabled flight across the sale horizon every two hours whether or not anyone intended to buy; the JIT endpoint means an idle route costs zero API calls. A separate route guard sweeps for flights that have stopped operating altogether and pauses those routes.

## Configuration

Secrets come from the Vercel env store, never the repo. Note that Vercel binds env values at **deploy** time — changing one in the dashboard does nothing to already-running functions until you redeploy.

The fleet derives from [`dapp/config/routes.testnet.json`](https://github.com/SentinelFi/sentinel_soroban_v3/blob/main/dapp/config/routes.testnet.json) — the single human source of truth shared with the intake scripts and the pricing jobs, so the governance whitelist and the off-chain view cannot drift apart. Beyond the four signing keys, the functions read `AEROAPI_KEY`, `AGENT_BASE_URL`/`AGENT_TOKEN` (the ML pricing service), the governance-DB settings (`GOVERNANCE_DB_URL`, `GOV_DRY_RUN`), and `CRON_SECRET`. The full list and defaults are in [`dapp/.env.example`](https://github.com/SentinelFi/sentinel_soroban_v3/blob/main/dapp/.env.example).

## Running

The functions run automatically once the `dapp/` project is deployed to Vercel with the env vars above; crons fire on the `dapp/vercel.json` schedules (5-minute crons and `maxDuration: 300` need Vercel Pro — on Hobby, drive them with an external pinger carrying the `CRON_SECRET` bearer). See the [dapp README](https://github.com/SentinelFi/sentinel_soroban_v3/blob/main/dapp/README.md#serverless-crons-vercel) for deployment, auth, and plan caveats.

Every run is recorded in the governance DB and surfaced on the dApp's public `/status` page. For machine monitoring, `GET /api/status/alert` returns 200 when healthy and 503 with a problem list when any job's last run failed, a job is stale past twice its cadence, a job has never recorded a run, or the settlement barrier has stalled — point an uptime monitor at it.

## Mock flight API

[`tools/mock-aeroapi/`](https://github.com/SentinelFi/sentinel_soroban_v3/tree/main/tools/mock-aeroapi) is a local Express server that mimics FlightAware AeroAPI responses, so the whole pipeline runs without a real API key. Flight scenarios are defined in `scenarios.json` per flight number, with outcomes `on_time`, `delayed`, `cancelled`, or `en_route`, and are re-read on every request. Start it with `npm run dev` (default port 3001) and set `AEROAPI_BASE_URL=http://localhost:3001`.
