---
sidebar_position: 4
title: Off-Chain Executor
---

# Off-Chain Executor

The executor is a TypeScript service in [`executor/centralized_cron/`](https://github.com/SentinelFi/sentinel_soroban_v3/tree/main/executor/centralized_cron) that drives protocol automation. It uses the Stellar SDK, node-cron, and Express.

The oracle backend is intentionally swappable: contracts only check authorization against owner-rotatable addresses, so migrating to a different backend requires one owner transaction per contract, not a redeploy.

## Jobs

| Job | Schedule | Calls | Signs as |
|---|---|---|---|
| Sale authorizer | Every 2 hours, offset | `open_sale`, `close_sale`, `set_cancelled` on the oracle; `classify_flight` + `settle_flight` on the controller after a cancellation write | Oracle key (keeper key for the targeted settlement) |
| Flight data fetcher | Every 2 hours | `set_estimated_arrival`, `set_landed`, `set_cancelled` on the oracle; `classify_flight` + `settle_flight` on the controller after each outcome write | Oracle key (keeper key for the targeted settlement) |
| Flight classifier | Hourly at :01 | `classify_flights` on the controller | Keeper key |
| Settlement executor | Every 5 minutes | `classify_flights` + `execute_settlements` on the controller, looped until the oracle reports no pending outcomes (bounded passes per run) | Keeper key |
| Queue maintainer | Every 5 minutes, offset | `run_queue_maintenance` on the controller | Keeper key |
| TTL extender | Daily | `extend_ttl` on all five contracts (instance-storage renewal) and `prune_settled` on the oracle | Any funded key |

Schedules are defaults defined in `src/index.ts`, not on-chain constraints. Adjust them to your own operational needs. Jobs are single-flight (a tick is skipped while the previous run of the same job is still in progress), and all transaction submission is serialized per signing key with automatic rebuild-and-retry on sequence conflicts, so jobs sharing a key cannot race each other's account sequence.

Outcome-to-settlement latency does not depend on the rotating sweeps: whichever job writes an outcome immediately drives that exact flight through the controller's `classify_flight` and `settle_flight` entry points, so the vault's settlement barrier releases within seconds. The sweeping classifier and settler remain as repair backstops.

The sale authorizer deserves special attention: `buy_insurance` requires a live oracle sale authorization (24-hour maximum validity), so if this job stops — or its flight list does not cover a whitelisted route — the affected sales fail closed. Keep its cadence comfortably inside `SALE_AUTH_VALIDITY_SECS`. When it observes a cancellation it revokes the sale window with the pause-exempt `close_sale` before writing the `set_cancelled` tombstone, so a paused oracle contract cannot delay the revocation.

## Configuration

Environment variables (see `config.ts`):

```bash
STELLAR_RPC_URL=
STELLAR_NETWORK_PASSPHRASE=
ORACLE_AGGREGATOR_ID=
CONTROLLER_ID=
RISK_VAULT_ID=
GOVERNANCE_ID=
FLIGHT_POOL_MANAGER_ID=
ORACLE_SECRET_KEY=
KEEPER_SECRET_KEY=
TTL_EXTENDER_SECRET_KEY=
AEROAPI_BASE_URL=   # optional, defaults to http://localhost:3001
AEROAPI_KEY=        # optional
SALE_AUTH_FLIGHT_IDS=      # comma-separated flight numbers to attest for sale;
                           # empty means no sale windows open and purchases fail closed
SALE_AUTH_HORIZON_DAYS=    # optional, defaults to 90 (the booking horizon)
SALE_AUTH_VALIDITY_SECS=   # optional, defaults to 21600 (6h); capped at 86400 on-chain
PORT=                      # optional, HTTP API port, defaults to 3002
HOST=                      # optional, HTTP API bind address, defaults to 127.0.0.1
                           # (loopback only); set explicitly to expose the API
EXECUTOR_API_TOKEN=        # bearer token required by every POST /api/trigger/*;
                           # unset means manual triggers are disabled (crons still run)
CORS_ALLOWED_ORIGIN=       # optional, exact origin of a browser operator console;
                           # unset means no CORS headers are sent
```

## Running

```bash
cd executor/centralized_cron
npm install
npm start
```

Each job can also run once from the CLI: `npm run authorize`, `fetch`, `classify`, `settle`, `queue`, or `ttl`.

A small HTTP API is exposed for operations: `GET /api/health`, `GET /api/logs`, and `POST /api/trigger/<job>` to run a job on demand. It binds to loopback by default; the trigger endpoints run signer-backed jobs, so they require the `EXECUTOR_API_TOKEN` bearer token (`Authorization: Bearer <token>`), are rate-limited, and answer `409` while the same job is already running. Keep the port unexposed at the firewall/container layer even with the token set.

## Mock flight API

[`executor/mock-api/`](https://github.com/SentinelFi/sentinel_soroban_v3/tree/main/executor/mock-api) is a local Express server that mimics FlightAware AeroAPI responses, so the whole pipeline runs without a real API key. Flight scenarios are defined in `scenarios.json` per flight number, with outcomes `on_time`, `delayed`, `cancelled`, or `en_route`, and are re-read on every request. Start it with `npm run dev` (default port 3001).
