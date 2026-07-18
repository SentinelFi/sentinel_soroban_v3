---
sidebar_position: 4
title: Off-Chain Executor
---

# Off-Chain Executor

The off-chain executor drives protocol automation: it triggers on-chain transitions but never decides flight outcomes locally. It ships in two interchangeable forms that run the same jobs:

- **Vercel serverless functions** in [`dapp/api/cron/`](https://github.com/SentinelFi/sentinel_soroban_v3/tree/main/dapp/api/cron) — the **primary deployment**, running in the same Vercel project as the dApp frontend (schedules in [`dapp/vercel.json`](https://github.com/SentinelFi/sentinel_soroban_v3/blob/main/dapp/vercel.json)). This variant also runs the route agent.
- **A long-running node service** in [`executor/centralized_cron/`](https://github.com/SentinelFi/sentinel_soroban_v3/tree/main/executor/centralized_cron) — a Stellar SDK + node-cron + Express reference/failover implementation for local runs and self-hosting.

The oracle backend is intentionally swappable: contracts only check authorization against owner-rotatable addresses, so migrating to a different backend requires one owner transaction per contract, not a redeploy.

## Signing identities

Four trusted identities drive the protocol; their addresses are registered on-chain and every entry point checks the caller.

| Identity | Authorized for | Env var |
|---|---|---|
| **Oracle** | Oracle Aggregator: `open_sale`/`close_sale`, `set_estimated_arrival`, `set_landed`, `set_cancelled` | `ORACLE_SECRET_KEY` |
| **Keeper** | Controller: `classify_flights`, `execute_settlements`, `run_queue_maintenance` | `KEEPER_SECRET_KEY` |
| **Governance admin** | Governance Module route mutations driven by the route agent (`update_route_terms`, `disable_route`, `enable_route`). An admin the owner delegates via `add_admin` — never the owner key. | `GOVERNANCE_ADMIN_SECRET_KEY` |
| **TTL extender** | Permissionless housekeeping: `extend_ttl` on all five contracts, `prune_settled` (any funded account works) | `TTL_EXTENDER_SECRET_KEY` |

## Jobs

| Job | Schedule | Calls | Signs as |
|---|---|---|---|
| Sale authorizer | Every 2 hours, offset | `open_sale`, `close_sale`, `set_cancelled` on the oracle; `classify_flight` + `settle_flight` on the controller after a cancellation write | Oracle key (keeper key for the targeted settlement) |
| Flight data fetcher | Every 2 hours | `set_estimated_arrival`, `set_landed`, `set_cancelled` on the oracle; `classify_flight` + `settle_flight` on the controller after each outcome write | Oracle key (keeper key for the targeted settlement) |
| Flight classifier | Hourly at :01 | `classify_flights` on the controller | Keeper key |
| Settlement executor | Every 5 minutes | `classify_flights` + `execute_settlements` on the controller, looped until the oracle reports no pending outcomes (bounded passes per run) | Keeper key |
| Queue maintainer | Every 5 minutes, offset | `run_queue_maintenance` on the controller (drains the deposit and withdrawal queues + records the share-price snapshot) | Keeper key |
| Route agent | Daily | ML-baseline repricing + weather rules on the Governance Module (route agent). Serverless deployment only | Governance-admin key |
| TTL extender | Daily | `extend_ttl` on all five contracts (instance-storage renewal) and `prune_settled` on the oracle | Any funded key |

The route agent is the only job absent from the node-cron variant. Schedules are defaults (defined in `src/index.ts` for the node service, `dapp/vercel.json` for the serverless functions), not on-chain constraints — adjust them to your own operational needs. Jobs are single-flight (a tick is skipped while the previous run of the same job is still in progress), and all transaction submission is serialized per signing key with automatic rebuild-and-retry on sequence conflicts, so jobs sharing a key cannot race each other's account sequence.

Outcome-to-settlement latency does not depend on the rotating sweeps: whichever job writes an outcome immediately drives that exact flight through the controller's `classify_flight` and `settle_flight` entry points, so the vault's settlement barrier releases within seconds. The sweeping classifier and settler remain as repair backstops.

The sale authorizer deserves special attention: `buy_insurance` requires a live oracle sale authorization (24-hour maximum validity), so if this job stops — or its flight list does not cover a whitelisted route — the affected sales fail closed. Keep its cadence comfortably inside `SALE_AUTH_VALIDITY_SECS`. When it observes a cancellation it revokes the sale window with the pause-exempt `close_sale` before writing the `set_cancelled` tombstone, so a paused oracle contract cannot delay the revocation.

## Configuration

Both variants take their secrets from host environment stores, never the repo. The two differ in how they learn which routes to attest:

- **Serverless (`dapp/api/`)** derives its flight list and sale horizon from [`dapp/config/routes.testnet.json`](https://github.com/SentinelFi/sentinel_soroban_v3/blob/main/dapp/config/routes.testnet.json) — the single human source of truth shared with the whitelist script and the route agent, so governance whitelist and sale windows cannot drift apart. It additionally reads `GOVERNANCE_ADMIN_SECRET_KEY`, `AGENT_BASE_URL`/`AGENT_TOKEN` (the ML pricing service (route agent)), and `CRON_SECRET`. The full list and defaults are in [`dapp/.env.example`](https://github.com/SentinelFi/sentinel_soroban_v3/blob/main/dapp/.env.example).
- **Node service (`executor/centralized_cron/`)** takes an explicit flight list via `SALE_AUTH_FLIGHT_IDS`. Its environment variables (see `config.ts`):

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

The **serverless** functions run automatically once the `dapp/` project is deployed to Vercel with the env vars above; crons fire on the `dapp/vercel.json` schedules (5-minute crons need Vercel Pro — on Hobby, drive them with an external pinger carrying the `CRON_SECRET` bearer). See the [dapp README](https://github.com/SentinelFi/sentinel_soroban_v3/blob/main/dapp/README.md#serverless-crons-vercel) for deployment, auth, and plan caveats.

The **node service** runs as a long-lived process:

```bash
cd executor/centralized_cron
npm install
npm start
```

Each job can also run once from the CLI: `npm run authorize`, `fetch`, `classify`, `settle`, `queue`, or `ttl`.

A small HTTP API is exposed for operations: `GET /api/health`, `GET /api/logs`, and `POST /api/trigger/<job>` to run a job on demand. It binds to loopback by default; the trigger endpoints run signer-backed jobs, so they require the `EXECUTOR_API_TOKEN` bearer token (`Authorization: Bearer <token>`), are rate-limited, and answer `409` while the same job is already running. Keep the port unexposed at the firewall/container layer even with the token set.

## Mock flight API

[`executor/mock-api/`](https://github.com/SentinelFi/sentinel_soroban_v3/tree/main/executor/mock-api) is a local Express server that mimics FlightAware AeroAPI responses, so the whole pipeline runs without a real API key. Flight scenarios are defined in `scenarios.json` per flight number, with outcomes `on_time`, `delayed`, `cancelled`, or `en_route`, and are re-read on every request. Start it with `npm run dev` (default port 3001).
