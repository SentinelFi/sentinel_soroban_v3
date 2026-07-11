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
| Sale authorizer | Every 2 hours, offset | `open_sale`, `close_sale`, `set_cancelled` on the oracle | Oracle key |
| Flight data fetcher | Every 2 hours | `set_estimated_arrival`, `set_landed`, `set_cancelled` on the oracle | Oracle key |
| Flight classifier | Hourly | `classify_flights` on the controller | Keeper key |
| Settlement executor | Every 5 minutes | `execute_settlements` on the controller | Keeper key |
| Queue maintainer | Every 5 minutes, offset | `run_queue_maintenance` on the controller | Keeper key |
| TTL extender | Daily | Extends storage TTLs for flight, claim, and route entries | Any funded key |

Schedules are defaults defined in `src/index.ts`, not on-chain constraints. Adjust them to your own operational needs.

The sale authorizer deserves special attention: `buy_insurance` requires a live oracle sale authorization (24-hour maximum validity), so if this job stops — or its flight list does not cover a whitelisted route — the affected sales fail closed. Keep its cadence comfortably inside `SALE_AUTH_VALIDITY_SECS`.

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
```

## Running

```bash
cd executor/centralized_cron
npm install
npm start
```

Each job can also run once from the CLI: `npm run authorize`, `fetch`, `classify`, `settle`, `queue`, or `ttl`.

A small HTTP API is exposed for operations: `GET /api/health`, `GET /api/logs`, and `POST /api/trigger/<job>` to run a job on demand.

## Mock flight API

[`executor/mock-api/`](https://github.com/SentinelFi/sentinel_soroban_v3/tree/main/executor/mock-api) is a local Express server that mimics FlightAware AeroAPI responses, so the whole pipeline runs without a real API key. Flight scenarios are defined in `scenarios.json` per flight number, with outcomes `on_time`, `delayed`, `cancelled`, or `en_route`, and are re-read on every request. Start it with `npm run dev` (default port 3001).
