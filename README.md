# Sentinel

[![CI](https://github.com/SentinelFi/sentinel_soroban_v3/actions/workflows/ci.yml/badge.svg)](https://github.com/SentinelFi/sentinel_soroban_v3/actions/workflows/ci.yml)
[![Deploy Docs](https://github.com/SentinelFi/sentinel_soroban_v3/actions/workflows/deploy-docs.yml/badge.svg)](https://github.com/SentinelFi/sentinel_soroban_v3/actions/workflows/deploy-docs.yml)
[![Stellar](https://img.shields.io/badge/Stellar-Soroban-brightgreen?logo=stellar)](https://stellar.org)
[![Coverage](https://img.shields.io/endpoint?url=https%3A%2F%2Fsentinelfi.github.io%2Fsentinel_soroban_v3%2Fcoverage%2Fbadge.json)](https://sentinelfi.github.io/sentinel_soroban_v3/coverage/)
[![Ask DeepWiki](https://deepwiki.com/badge.svg)](https://deepwiki.com/SentinelFi/sentinel_soroban_v3)

## About

Sentinel is decentralized parametric flight delay insurance on Stellar: underwriters deposit capital to back claims, and travelers pay a small premium for a fixed, automatic payout when their flight is delayed or cancelled.

- Documentation: https://sentinelfi.github.io/sentinel_soroban_v3/
- DeepWiki: https://deepwiki.com/SentinelFi/sentinel_soroban_v3
- Architecture: [spec/architecture.md](spec/architecture.md)
- Playground (testnet): https://sentinel-soroban-v3.vercel.app/
- Frontend demo: https://sentinel-soroban-v3-frontend.vercel.app/
- Arcade demo: https://sentinel-soroban-v3-arcade.vercel.app/
- Slides: https://sentinel-soroban-v3-slides.vercel.app/

## Table of Contents

- [About](#about)
- [Project Structure](#project-structure)
- [Key Contracts](#key-contracts)
- [How a Flight Moves Through the System](#how-a-flight-moves-through-the-system)
  - [Flight status state machine](#flight-status-state-machine)
- [Off-Chain Executors (Oracles and Keepers)](#off-chain-executors-oracles-and-keepers)
- [Automated Governance (Route Agent)](#automated-governance-route-agent)
- [Deployment Plan](#deployment-plan)
- [Getting Started](#getting-started)
- [License](#license)
- [Contributing](#contributing)
- [Security](#security)

## Project Structure

| Folder | What it does |
|--------|--------------|
| [contracts/](contracts/) | Soroban smart contracts (Rust workspace): [controller/](contracts/controller/) (orchestrator), [risk_vault/](contracts/risk_vault/) (underwriter capital), [flight_pool_manager/](contracts/flight_pool_manager/) (per-flight policy state), [oracle_aggregator/](contracts/oracle_aggregator/) (flight status state machine), [governance_module/](contracts/governance_module/) (route whitelist + terms), [mock_usdc/](contracts/mock_usdc/) (testnet stablecoin), [sentinel_types/](contracts/sentinel_types/) (shared types), [integration_tests/](contracts/integration_tests/) |
| [dapp/](dapp/) | The deployable app: Vite + React frontend at the root, plus [dapp/api/](dapp/api/) — Vercel serverless functions running all seven cron jobs (see [Off-chain executors](#off-chain-executors-oracles-and-keepers)). [dapp/config/routes.testnet.json](dapp/config/routes.testnet.json) is the human source of truth for insurable routes; [dapp/scripts/](dapp/scripts/) holds the governance whitelist script; contract TypeScript bindings live in [dapp/packages/](dapp/packages/). One Vercel project serves UI and crons together. |
| [agent/](agent/) | Python premium-pricing service: FastAPI + XGBoost delay-probability model (Kaggle 2008 / BTS data) returning expected-loss premiums with hard rails. Too heavy for Vercel functions — deploys as a Render web service via [render.yaml](render.yaml). Consumed only by the daily route-agent cron; optional (the cron degrades to routes-file terms). |
| [executor/](executor/) | Off-chain executor layer, long-running node-cron variant, and [mock-api/](executor/mock-api/) (AeroAPI fixture server for local testing). The Vercel functions in `dapp/api/` are the primary deployment; this service remains as a reference/failover. |
| [playground/](playground/) | Web playground for poking the testnet deployment ([live](https://sentinel-soroban-v3.vercel.app/)). |
| [deployments/](deployments/) | Deployed contract addresses, wasm hashes, executor accounts, and constructor parameters per network. |
| [spec/](spec/) | Architecture and design documents ([architecture.md](spec/architecture.md), chain-agnostic [simple_architecture.md](spec/simple_architecture.md)). |
| [docs/](docs/) | Documentation site (Docusaurus), published via CI. |
| [audits/](audits/) | Audit reports and remediations, by date and auditor. |
| [slides/](slides/) | Project slide deck ([live](https://sentinel-soroban-v3-slides.vercel.app/)). |
| [sequence_diagrams.md](sequence_diagrams.md) | End-to-end message sequence diagrams for the core flows. |

## Key Contracts

| Contract | Description |
|----------|-------------|
| [Controller](contracts/controller/) | The system orchestrator; routes funds and calls between contracts but never holds any money itself. |
| [RiskVault](contracts/risk_vault/) | The capital backing layer where all underwriter USDC sits, built on the OpenZeppelin Stellar `FungibleVault`. |
| [FlightPoolManager](contracts/flight_pool_manager/) | A single contract managing all flight insurance pools and recovery accounting, keyed by `(flight_id, date)`. |
| [OracleAggregator](contracts/oracle_aggregator/) | On-chain registry of flight data and the single source of truth for settlement pipeline state. |
| [GovernanceModule](contracts/governance_module/) | The route authority owning canonical terms (premium, payoff, delay threshold) for whitelisted flight routes. |

Deployed addresses are listed in [deployments/](deployments/).

## How a Flight Moves Through the System

A flight goes from whitelisted route, to purchasable market, to tracked flight, to settled outcome. Every step below is enforced on-chain; the off-chain executors only *trigger* transitions, they never decide outcomes locally.

1. **Route whitelisting** — a human fills [dapp/config/routes.testnet.json](dapp/config/routes.testnet.json) and runs `npm run whitelist:routes`, which calls `GovernanceModule.whitelist_route(flight_id, origin, dest, [term overrides])` as a governance admin. Terms (premium, payoff, delay-hours threshold) fold with global defaults; routes can later be disabled, re-enabled, updated, or removed. Only routes reporting `Active` status are buyable. Listing new routes is always human-initiated — the route agent never whitelists.
2. **Sale window** — the sale-authorizer cron (oracle identity) checks AeroAPI for every enabled flight over the sale horizon and attests via `OracleAggregator.open_sale(flight_id, date, expires_at)` (max 24h) that the instance is scheduled and not cancelled; unverifiable or cancelled instances get their windows closed immediately. `buy_insurance` fails closed without a live attestation.
3. **Purchase and registration** — `Controller.buy_insurance` checks: route `Active`, lead time (`date > now + min_lead_time`), live sale window, oracle status has no recorded outcome, and vault solvency on *aggregate* liabilities (`TMA >= ceil((locked + payoff) * solvency_ratio / 100)`). The first buyer registers the flight in both `FlightPoolManager` (locks the terms snapshot) and `OracleAggregator` (status `NotInitiated`, joins the active flight list). The premium escrows in the pool; the full payoff is locked in the vault. If the Controller's buyer allowlist is enabled (admin-toggled `set_whitelist_enabled` + `add_whitelisted_buyer`), only allowlisted addresses can buy.
4. **Activation** — the oracle-role fetcher cron reads the active list, queries AeroAPI, and pushes the **scheduled** arrival via `set_estimated_arrival` → status becomes `Active`. A flight cancelled before ever activating is pushed as `set_cancelled` immediately, closing the purchase gate in the same cycle.
5. **Tracking** — every fetcher cycle re-checks Active flights. Cancellations are pushed the moment they are visible; the landed resolution waits until ETA + 1h and requires an actual gate-arrival timestamp (`actual_in`) before `set_landed`. Ambiguous AeroAPI data (more than one physical flight for the day) is never guessed at — the flight stays unresolved for operator attention.
6. **Classification** — the keeper cron calls `Controller.classify_flights`, which compares actual vs. estimated arrival against the route's delay threshold and moves `Landed`/`Cancelled` flights to `ToBeSettledOnTime` / `ToBeSettledDelayed` / `ToBeSettledCancelled`. Flights with no oracle data for ≥ 14 days are voided to on-time (no payout against an unattested outcome, and a dead row can never pin vault collateral forever).
7. **Settlement** — the keeper cron calls `Controller.execute_settlements`. On-time: pooled premiums forward to the vault as underwriter yield and the locked payoff is released. Delayed/cancelled: the vault tops the pool up to `payoff × buyers` and a claim window opens. The oracle marks the flight `Settled`.
8. **Claim, sweep, prune** — travelers call `FlightPoolManager.claim` before the claim window expires; after expiry, anyone may `sweep_expired` (unclaimed funds accrue to the protocol's recovered balance, withdrawable by the Owner). `OracleAggregator.prune_settled` (permissionless, run daily by the TTL cron) evicts flights settled ≥ 30 days ago from the active list.

### Flight status state machine

`OracleAggregator` enforces a forward-only state machine — an oracle bug or replay can never move a flight backwards or double-pay a settlement:

```
NotInitiated ──▶ Active            (oracle: set_estimated_arrival)
     │  └──────▶ Cancelled         (oracle: set_cancelled, pre-activation)
     └─────────▶ ToBeSettledOnTime (controller: void, ≥14 days, no data)

Active ────────▶ Landed            (oracle: set_landed, actual arrival)
     │  └──────▶ Cancelled         (oracle: set_cancelled)
     └─────────▶ ToBeSettledOnTime (controller: void, ≥14 days past ETA)

Landed ────────▶ ToBeSettledOnTime | ToBeSettledDelayed   (keeper: classify)
Cancelled ─────▶ ToBeSettledCancelled                     (keeper: classify)

ToBeSettled* ──▶ Settled           (keeper: execute_settlements)
```

## Off-Chain Executors (Oracles and Keepers)

Four trusted signing identities drive the protocol forward; their addresses are registered on-chain and every entry point checks the caller. Flight *outcomes* are always decided on-chain — the crons only trigger transitions. The route agent is the one exception that writes governance state, and it is boxed in by rails at three layers (its own, the routes file's, and the on-chain owner-set term limits).

| Identity | Authorized for | Env var |
|----------|----------------|---------|
| **Oracle** | `OracleAggregator`: `open_sale`/`close_sale`, `set_estimated_arrival`, `set_landed`, `set_cancelled` | `ORACLE_SECRET_KEY` |
| **Keeper** | `Controller`: `classify_flights`, `execute_settlements`, `run_queue_maintenance` | `KEEPER_SECRET_KEY` |
| **Governance admin** | `GovernanceModule` route mutations (`whitelist_route` via the script; `update_route_terms` / `disable_route` / `enable_route` via the route agent). An admin added by the owner via `add_admin` — never the owner key. | `GOVERNANCE_ADMIN_SECRET_KEY` |
| **TTL extender** | Permissionless housekeeping: `extend_ttl` on all five contracts, `prune_settled` (any funded account works) | `TTL_EXTENDER_SECRET_KEY` |

Seven cron jobs use those identities, deployed as Vercel serverless functions ([dapp/api/cron/](dapp/api/cron/), schedules in [dapp/vercel.json](dapp/vercel.json); the node-cron service in [executor/centralized_cron/](executor/centralized_cron/) remains as reference/failover):

| Job | Identity | Cadence | What it triggers |
|-----|----------|---------|------------------|
| Sale authorizer | Oracle | every 2h, offset | AeroAPI schedule check → `open_sale` / `close_sale` for every enabled route over the sale horizon; cancellations tombstoned + settled immediately (fail closed: no attestation, no sales) |
| Flight data fetcher | Oracle | every 2h | AeroAPI → `set_estimated_arrival` / `set_landed` / `set_cancelled` |
| Flight classifier | Keeper | hourly | `Controller.classify_flights` |
| Settlement executor | Keeper | every 5 min | `Controller.execute_settlements` |
| Queue maintainer | Keeper | every 5 min, offset | `Controller.run_queue_maintenance` — drains the underwriter withdrawal queue + share-price snapshot; decoupled so heavy settlements can't starve exits |
| Route agent | Governance admin | daily | ML baseline premium + weather rules + 24h re-evaluation of disabled routes — see [Automated Governance](#automated-governance-route-agent) |
| TTL extender | TTL | daily | `extend_ttl` × 5 contracts + `prune_settled` (Soroban storage-rent housekeeping) |

See the [dapp README](dapp/README.md#serverless-crons-vercel) for serverless deployment, auth, and plan caveats, and [spec/simple_architecture.md](spec/simple_architecture.md) for the full chain-agnostic flows and invariants.

## Automated Governance (Route Agent)

Whitelisting stays human; *pricing and weather response* are automated with hard rails. Three pieces:

1. **The routes file** — [dapp/config/routes.testnet.json](dapp/config/routes.testnet.json): route list with optional term overrides, the rails (premium/payoff min-max, max daily premium step, elevated-weather multiplier), the sale horizon, and per-route `enabled` flags. `enabled: false` is permanent human intent — the agent enforces it on-chain and **never** re-enables such a route. The sale authorizer derives its attestation list from the same file, so governance whitelist and sale windows cannot drift apart.
2. **The pricing service** — [agent/](agent/): FastAPI + XGBoost delay-probability model. `POST /price` maps a flight tuple to `premium = clamp(p_delay × payoff × margin, min, max)`. Runs on Render ([render.yaml](render.yaml)); optional — when down or unset, the cron falls back to the routes-file terms.
3. **The daily route-agent cron** — `dapp/api/cron/agent.ts`. Per route: read on-chain `route_status` → ML baseline premium → Open-Meteo forecasts for both airports → a pure decision module ([route_rules.ts](dapp/api/_lib/route_rules.ts)) picks one of `noop` / `update_premium` / `disable` / `reenable_with_terms`:
   - **elevated** weather (gusts ≥ 60 km/h, snow ≥ 5 cm, storm codes, precip ≥ 80%) → premium × multiplier, clamped to the rails and a max daily step
   - **severe** weather (gusts ≥ 90 km/h, snow ≥ 20 cm, hail-storm codes) → `disable_route`
   - disabled route + clear weather + `enabled: true` in the file → re-enabled with fresh terms (this daily pass **is** the 24-hour re-evaluation)
   - sub-$1 premium drift → `noop` (no churn transactions)

Failure posture: model down → file terms; forecast API down or unknown airport → no weather signal → `noop`. The agent can degrade to doing nothing, never to unsafe writes — and everything it *can* write is bounded by the on-chain owner-set term limits (payoff cap + payoff/premium ratio).

## Deployment Plan

What runs where. Three hosted surfaces plus the chain itself:

| What | Source | Deployed on | Notes |
|------|--------|-------------|-------|
| Smart contracts (×6) | [`contracts/`](contracts/) | **Stellar testnet** (Soroban) | Addresses in [`deployments/testnet.json`](deployments/testnet.json); deployed via `make deploy-testnet` |
| dApp frontend (Fun/Serious UI) | [`dapp/`](dapp/) | **Vercel** (static build) | One Vercel project, root = `dapp/` |
| Serverless crons (×7) | [`dapp/api/cron/`](dapp/api/) | **Vercel** (same project) | Schedules in [`dapp/vercel.json`](dapp/vercel.json); 5-min crons need Vercel Pro (Hobby: external pinger with the `CRON_SECRET` bearer) |
| ML pricing service | [`agent/`](agent/) | **Render** (Docker web service) | Via root [`render.yaml`](render.yaml); crons reach it over HTTPS (`AGENT_BASE_URL` + `AGENT_TOKEN`); optional — unset falls back to routes-file terms |
| Node executor (legacy/local) | [`executor/centralized_cron/`](executor/) | **not deployed** (local/self-host option) | Superseded by the Vercel crons; kept for local runs and reference |
| Mock AeroAPI | [`executor/mock-api/`](executor/) | **local only** | Keyless test fixture; point `AEROAPI_BASE_URL` at it for demos |

Secrets live only in host env stores (Vercel project settings / Render env), never in the repo:

- **Vercel**: `ORACLE_SECRET_KEY`, `KEEPER_SECRET_KEY`, `TTL_EXTENDER_SECRET_KEY`, `GOVERNANCE_ADMIN_SECRET_KEY`, `AEROAPI_KEY`, `AGENT_BASE_URL`, `AGENT_TOKEN`, `CRON_SECRET` (full list + defaults in [`dapp/.env.example`](dapp/.env.example))
- **Render**: `AGENT_TOKEN` (matching the Vercel value)

First-time deploy order:

1. **Contracts** — already live on testnet (see `deployments/testnet.json`); redeploys follow [`contracts/deploy_order.md`](contracts/deploy_order.md)
2. **Render** — deploy `agent/` (Docker), set `AGENT_TOKEN`
3. **Vercel** — import the repo with root directory `dapp/`, set the env vars above, deploy; crons start on their schedules automatically
4. **One-time on-chain setup** — owner runs `GovernanceModule.add_admin` for the governance-admin key; fill [`dapp/config/routes.testnet.json`](dapp/config/routes.testnet.json) and run `npm run whitelist:routes`

## Getting Started

Prerequisites: [Rust](https://www.rust-lang.org/tools/install) (the pinned toolchain installs automatically via `rust-toolchain.toml`), the [Stellar CLI](https://developers.stellar.org/docs/tools/cli), and `make`.

All commands run from the `contracts/` directory:

```bash
cd contracts

make test            # run the full test suite
make coverage        # line-coverage summary (published report: see badge above)
make build           # build all contracts to wasm + verify network size caps
make check-wasm-size # re-check built wasm sizes against the Soroban cap
make check           # formatting, clippy, and tests
make ci              # full local CI (check + dependency audit)

make keys            # generate and fund a testnet identity
make deploy-testnet  # build and deploy all contracts to testnet
```

Run `make help` for the complete target list.

- [Makefile](contracts/Makefile) — all build, test, lint, and deploy targets
- [deploy_order.md](contracts/deploy_order.md) — canonical deploy and wiring order
- [upgrade.md](contracts/upgrade.md) — contract upgradeability and upgrade authority

## License

Licensed under the Apache License 2.0. See [LICENSE](LICENSE).

## Contributing

Contributions are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md).

## Security

Audit reports live in [audits/](audits/). Please report any findings through GitHub's private vulnerability reporting, as described in [SECURITY.md](SECURITY.md).

> [!WARNING]
> While we strive to ensure this software functions as intended, it is provided "as is" with no warranties or guarantees of any kind. Smart contracts are inherently complex and may contain bugs, vulnerabilities, or unintended behaviors. By using this software, you acknowledge and agree that: You use it entirely at your own risk. You should perform your own due diligence, and it is strongly recommended to consult qualified professionals (e.g., security auditors, legal advisors).

---

Copyright © @SentinelFi
