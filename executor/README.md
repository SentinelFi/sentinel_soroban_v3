# Off-Chain Executor Layer

This folder contains the off-chain services that keep Sentinel Protocol running: a long-lived cron executor that drives the on-chain flight lifecycle, and a mock flight-data API for local testing.

Executors only *trigger* on-chain transitions. Every outcome (delay classification, payout amount, settlement) is computed and enforced by the smart contracts.

## Contents

| Directory | Purpose |
| --- | --- |
| [centralized_cron/](centralized_cron/) | Long-running Node service (node-cron + Express) that runs all six protocol jobs on schedule and exposes a small operator API. |
| [mock-api/](mock-api/) | Local Express server returning FlightAware AeroAPI-shaped responses, so the executor can be tested without an API key. See its [README](mock-api/README.md). |

**Deployment status:** the primary production deployment of these jobs is the set of Vercel serverless functions in `dapp/api/cron/` (schedules in `dapp/vercel.json`), which is a faithful port of this code. The service here is not deployed; it remains the reference implementation and a self-hosted failover option, and is the most convenient way to run the jobs locally.

## The six cron jobs

| # | Job | Schedule | Signing key | On-chain call |
| --- | --- | --- | --- | --- |
| 0 | SaleAuthorizer | every 2 h at :30 | oracle | `OracleAggregator.open_sale` / `close_sale` |
| 1 | FlightDataFetcher | every 2 h at :00 | oracle | `set_estimated_arrival`, `set_landed`, `set_cancelled` |
| 2 | FlightClassifier | hourly at :01 | keeper | `Controller.classify_flights` |
| 3 | SettlementExecutor | every 5 min at :00, :05, ... | keeper | `Controller.execute_settlements` |
| 3b | QueueMaintainer | every 5 min at :02, :07, ... | keeper | `Controller.run_queue_maintenance` |
| 4 | TTLExtender | daily at 00:00 UTC | ttl extender | `extend_ttl()` on each contract, plus `prune_settled` |

What each job does:

- **SaleAuthorizer** — the purchase gate requires an affirmative, unexpired attestation that a flight instance is scheduled and insurable (absence of a recorded outcome proves nothing). For every configured route and day in the sale horizon, this job checks AeroAPI and opens or refreshes the sale window, and revokes it immediately if a cancellation becomes visible. Its cadence must stay well inside the on-chain authorization validity period, or sale windows lapse between runs.
- **FlightDataFetcher** — polls AeroAPI for all active flights. Cancellations are pushed on-chain in the same cycle they are seen (an already-cancelled flight must stop being purchasable as fast as possible); landed outcomes wait for the estimated arrival plus a one-hour buffer before `set_landed`.
- **FlightClassifier** — asks the Controller to read landed/cancelled outcomes from the oracle, compare delays against each flight's threshold, and mark flights to be settled.
- **SettlementExecutor** — drains pending settlements in bounded passes (capped per run; on-chain cursors let the next run resume where this one stopped).
- **QueueMaintainer** — processes the underwriter withdrawal queue and records the daily share-price snapshot. Split out of the settler so heavy settlement runs cannot starve underwriter payouts.
- **TTLExtender** — renews Soroban instance-storage TTLs on all contracts daily and prunes settled flight state. Both calls are permissionless; a dedicated key just isolates the fee spend.

In addition, after the fetcher or sale authorizer writes a landed/cancelled outcome, it immediately drives that one flight through classify and settle (`targeted_settlement.ts`) so the vault's settlement barrier is released within seconds instead of waiting for the next sweep. The scheduled sweeps remain the backstop; a failed targeted attempt only delays settlement, never loses it.

### Concurrency safeguards

Three layers keep jobs sharing a signing key from racing one account's sequence number: the Soroban client serializes each build/sign/submit lifecycle per signer and retries sequence conflicts; every job is single-flight (a tick is skipped while the previous run of the same job is still in progress); and the schedules above are offset so same-key jobs rarely fire together in the first place.

## Running the executor

Requires Node.js 20+ and a deployed contract set (see `deployments/` for addresses).

```bash
cd executor/centralized_cron
npm install
cp .env.example .env   # fill in contract IDs and secret keys
npm run dev            # hot reload, or: npm start
```

The `.env` needs the five contract IDs, three secret keys (oracle, keeper, TTL extender), and the AeroAPI settings. For local testing without an AeroAPI key, start `mock-api` and set `AEROAPI_BASE_URL=http://localhost:3001`.

### Running a single job once

Each job can be run once and exit, which is the easiest way to test or debug:

```bash
npm run authorize   # SaleAuthorizer
npm run fetch       # FlightDataFetcher
npm run classify    # FlightClassifier
npm run settle      # SettlementExecutor
npm run queue       # QueueMaintainer
npm run ttl         # TTLExtender + prune
```

## Operator HTTP API

The long-running service also serves a small API (default `127.0.0.1:3002`; set `PORT` / `HOST` to change — binding beyond loopback is a deliberate deployment decision):

| Endpoint | Purpose |
| --- | --- |
| `GET /api/health` | Last run per job, plus live `whitelist_enabled` / `paused` reads from the Controller. |
| `GET /api/logs` | Recent run-log entries. |
| `POST /api/trigger/{job}` | Manually fire one job (`sale_authorizer`, `fetcher`, `classifier`, `settler`, `queue_maintainer`, `ttl_extender`). |

Manual triggers sign transactions with the configured keys, so they are protected: they require a `Bearer` token matching `EXECUTOR_API_TOKEN` (unset means triggers are disabled entirely; the scheduler still runs), are rate limited to 30 requests per minute, and return 409 if that job is already running. `CORS_ALLOWED_ORIGIN` optionally allows one browser origin; unset means no CORS headers are sent.

## Testing

```bash
npm test                # boots mock-api, runs run-log and AeroAPI client tests; no contracts needed
npm run test:pipeline   # end-to-end against a live network: buy insurance, fetch, classify, settle
npm run build           # type-check only (tsc --noEmit)
```

`test:pipeline` requires a deployed contract set plus the optional `.env` entries (`TRAVELER_SECRET_KEY`, `UNDERWRITER_SECRET_KEY`, `MOCK_USDC_ID`) and exits with a clear message if anything is missing.

## Related documentation

- Root [README](../README.md) — protocol overview, flight lifecycle, and the role split between oracle and keeper identities.
- [dapp/README](../dapp/README.md) — the Vercel serverless port of these jobs.
- [spec/architecture.md](../spec/architecture.md) — cadence rationale and system design.
