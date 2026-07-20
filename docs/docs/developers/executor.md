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
| **Governance admin** | Governance Module route mutations, used by the whitelist script, the route agent, the governance reconciler, and admin-console actions. An admin the owner delegates via `add_admin` — never the owner key. | `GOVERNANCE_ADMIN_SECRET_KEY` |
| **TTL extender** | Permissionless housekeeping: `extend_ttl` on all five contracts, `prune_settled` (any funded account works) | `TTL_EXTENDER_SECRET_KEY` |

## Jobs

| Job | Schedule | Calls | Signs as |
|---|---|---|---|
| Sale authorizer | Every 2 hours, offset | `open_sale`, `close_sale`, `set_cancelled` on the oracle; `classify_flight` + `settle_flight` on the controller after a cancellation write | Oracle key (keeper key for the targeted settlement) |
| Flight data fetcher | Every 2 hours | `set_estimated_arrival`, `set_landed`, `set_cancelled` on the oracle; `classify_flight` + `settle_flight` on the controller after each outcome write | Oracle key (keeper key for the targeted settlement) |
| Flight classifier | Hourly | `classify_flights` on the controller | Keeper key |
| Settlement executor | Every 5 minutes | `classify_flights` + `execute_settlements` on the controller, looped until the oracle reports no pending outcomes (bounded passes per run) | Keeper key |
| Queue maintainer | Every 5 minutes, offset | `run_queue_maintenance` on the controller (drains the deposit and withdrawal queues + records the share-price snapshot) | Keeper key |
| Route agent | Daily | ML-baseline repricing + weather rules on the Governance Module | Governance-admin key |
| Governance reconciler | Hourly, :10 | Recomputes each managed route's desired state from governance-DB signals (admin pins win, pauses expand, multipliers stack, hysteresis damps) and submits the minimal on-chain diff; `GOV_DRY_RUN=true` logs decisions without submitting | Governance-admin key |
| TTL extender | Daily | `extend_ttl` on all five contracts (instance-storage renewal) and `prune_settled` on the oracle | Any funded key |

Schedules are defaults (defined in `dapp/vercel.json`), not on-chain constraints — adjust them to your own operational needs. Jobs are single-flight (a tick is skipped while the previous run of the same job is still in progress), and all transaction submission is serialized per signing key with automatic rebuild-and-retry on sequence conflicts, so jobs sharing a key cannot race each other's account sequence.

Outcome-to-settlement latency does not depend on the rotating sweeps: whichever job writes an outcome immediately drives that exact flight through the controller's `classify_flight` and `settle_flight` entry points, so the vault's settlement barrier releases within seconds. The sweeping classifier and settler remain as repair backstops.

The sale authorizer deserves special attention: `buy_insurance` requires a live oracle sale authorization (24-hour maximum validity), so if this job stops — or its flight list does not cover a whitelisted route — the affected sales fail closed. Keep its cadence comfortably inside `SALE_AUTH_VALIDITY_SECS`. When it observes a cancellation it revokes the sale window with the pause-exempt `close_sale` before writing the `set_cancelled` tombstone, so a paused oracle contract cannot delay the revocation.

## Configuration

Secrets come from the Vercel env store, never the repo. The flight list and sale horizon derive from [`dapp/config/routes.testnet.json`](https://github.com/SentinelFi/sentinel_soroban_v3/blob/main/dapp/config/routes.testnet.json) — the single human source of truth shared with the whitelist script and the route agent, so governance whitelist and sale windows cannot drift apart. Beyond the four signing keys, the functions read `AEROAPI_KEY`, `AGENT_BASE_URL`/`AGENT_TOKEN` (the ML pricing service), the governance-DB settings (`GOVERNANCE_DB_URL`, `GOV_DRY_RUN`), and `CRON_SECRET`. The full list and defaults are in [`dapp/.env.example`](https://github.com/SentinelFi/sentinel_soroban_v3/blob/main/dapp/.env.example).

## Running

The functions run automatically once the `dapp/` project is deployed to Vercel with the env vars above; crons fire on the `dapp/vercel.json` schedules (5-minute crons need Vercel Pro — on Hobby, drive them with an external pinger carrying the `CRON_SECRET` bearer). See the [dapp README](https://github.com/SentinelFi/sentinel_soroban_v3/blob/main/dapp/README.md#serverless-crons-vercel) for deployment, auth, and plan caveats. Every run is recorded in the governance DB and surfaced on the dApp's public `/status` page.

## Mock flight API

[`tools/mock-aeroapi/`](https://github.com/SentinelFi/sentinel_soroban_v3/tree/main/tools/mock-aeroapi) is a local Express server that mimics FlightAware AeroAPI responses, so the whole pipeline runs without a real API key. Flight scenarios are defined in `scenarios.json` per flight number, with outcomes `on_time`, `delayed`, `cancelled`, or `en_route`, and are re-read on every request. Start it with `npm run dev` (default port 3001) and set `AEROAPI_BASE_URL=http://localhost:3001`.
