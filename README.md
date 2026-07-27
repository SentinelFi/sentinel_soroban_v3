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
- Slides: https://sentinel-soroban-v3-slides.vercel.app/

## Table of Contents

- [About](#about)
- [Project Structure](#project-structure)
- [Key Contracts](#key-contracts)
- [Underwriter Calculator](#underwriter-calculator)
- [How a Flight Moves Through the System](#how-a-flight-moves-through-the-system)
  - [Flight status state machine](#flight-status-state-machine)
- [Off-Chain Executors and Governance](#off-chain-executors-and-governance)
  - [Cron jobs](#cron-jobs)
  - [Governance database](#governance-database)
  - [Automated governance](#automated-governance)
  - [Admin console and status](#admin-console-and-status)
- [Deployment Plan](#deployment-plan)
- [Getting Started](#getting-started)
  - [Running the dApp locally](#running-the-dapp-locally)
- [License](#license)
- [Contributing](#contributing)
- [Security](#security)

## Project Structure

| Folder | What it does |
|--------|--------------|
| [contracts/](contracts/) | Soroban smart contracts (Rust workspace): [controller/](contracts/controller/) (orchestrator), [risk_vault/](contracts/risk_vault/) (underwriter capital), [flight_pool_manager/](contracts/flight_pool_manager/) (per-flight policy state), [oracle_aggregator/](contracts/oracle_aggregator/) (flight status state machine), [governance_module/](contracts/governance_module/) (route whitelist + terms), [mock_usdc/](contracts/mock_usdc/) (testnet stablecoin), [sentinel_types/](contracts/sentinel_types/) (shared types), [integration_tests/](contracts/integration_tests/) |
| [dapp/](dapp/) | The deployable app: Vite + React frontend, [dapp/api/](dapp/api/) — Vercel serverless functions running all eight cron jobs plus the admin/status APIs, [dapp/config/routes.testnet.json](dapp/config/routes.testnet.json) — the human source of truth for insurable routes, [dapp/scripts/](dapp/scripts/) — route discovery + governance whitelist scripts, [dapp/packages/](dapp/packages/) — generated contract bindings. One Vercel project serves UI, crons, and admin together. |
| [supabase/](supabase/) | Governance database: Supabase config and SQL migrations (route registry, signals, pause/premium state, actions log, cron runs). Consumed by the reconciler cron and the admin console. |
| [agent/](agent/) | Python premium-pricing service: FastAPI + XGBoost delay-probability model returning expected-loss premiums with hard rails. Deploys to Render via [render.yaml](render.yaml); optional — the route-agent cron degrades to routes-file terms without it. |
| [tools/](tools/) | [mock-aeroapi/](tools/mock-aeroapi/) — keyless AeroAPI fixture server for local testing and demos (point `AEROAPI_BASE_URL` at it). |
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

## Underwriter Calculator

Before depositing into the vault, an underwriter can size the risk on the **`/calculator`** page ([Quant.tsx](dapp/src/pages/Quant.tsx)) — an in-browser **Monte Carlo simulator** of a pool's monthly economics. A single expected-value line ("premiums look bigger than expected payouts, so this is profitable") hides the thing that actually matters to an underwriter: how *bad* an unlucky month can get. Monte Carlo answers that by simulating thousands of months and showing the whole distribution of outcomes, not just its average.

**The model.** Seven levers drive it — travelers, on-time %, delay-rate uncertainty, premium, payout, capital, and trial count (`runs`). Each trial is one hypothetical month, sampled in two stages:

1. **Parameter uncertainty.** We don't know a route's true delay rate exactly, so it isn't held fixed. The base rate is `pDelay = 1 − onTime%`, and each month draws its *own* true rate `p ~ Uniform(pDelay ± uncertainty)`, clamped to `[0, 1]`. The uncertainty lever is that band's half-width in percentage points; set it to 0 and every month uses the same rate (the naive model).
2. **Outcome sampling.** Given that month's `p`, each of the `travelers` policies is an independent Bernoulli trial, so the number of delayed flights is `Binomial(travelers, p)` — drawn by flipping one weighted coin per traveler. The month's result is `net = premiums − delayed × payout`, where `premiums = travelers × premium`.

Running this `runs` times (thousands of trials) produces a full sample of possible monthly nets.

**The output.** The nets are sorted and reduced to the stat cards the page shows:

| Stat | Meaning |
|------|---------|
| **Median** | The typical month (50th percentile) |
| **Mean / EV** | Average net across all trials — matches the deterministic readout |
| **5% VaR** | The 5th-percentile net: "1 month in 20 is at least this bad" — the tail an underwriter is really buying |
| **P(profit)** | Fraction of trials that finished ≥ 0 |
| **Yield** | Mean net as a return on the capital lever |

The distribution is also binned into a 21-bucket SVG histogram (spanning the observed range, always including 0 so the break-even line is visible), so the shape — tight and profitable vs. a fat loss tail — is legible at a glance next to the plain deterministic EV and break-even readouts.

**Determinism.** All math is pure client-side JS — no backend, no chain calls. The PRNG is a `mulberry32` generator seeded by hashing the seven inputs, so the same levers always yield the same distribution and dragging a slider recomputes smoothly (no unseeded `Math.random` reflow flicker). It's decision-support, not an oracle: garbage-in assumptions give garbage-out spreads, but the *shape* of the risk is exactly what a deterministic EV number can't convey.

## How a Flight Moves Through the System

A flight goes from whitelisted route, to purchasable market, to tracked flight, to settled outcome. Every step is enforced on-chain; the off-chain executors only *trigger* transitions, they never decide outcomes locally.

1. **Route discovery & whitelisting** — `npm run discover:routes` (in `dapp/`) finds candidate routes with minimal AeroAPI spend: one origin/destination-filtered `/schedules` call per directed city pair per sample day (~60 calls covers the default NYC ↔ SEA/SFO/LAX/ORD/MIA matrix, 200+ routes), skipping routes already in the file and multi-leg flight numbers the contract would reject. A human reviews the output, merges it into [dapp/config/routes.testnet.json](dapp/config/routes.testnet.json), and runs `npm run whitelist:routes`, which calls `GovernanceModule.whitelist_route` as a governance admin. The whole loop is idempotent — re-running discovery or the whitelist against already-listed routes is harmless (the script diffs on-chain state first; the contract treats a same-route re-whitelist as a no-op refresh). Terms (premium, payoff, delay-hours threshold) fold with global defaults; routes can later be disabled, re-enabled, updated, or removed. Only routes reporting `Active` status are buyable. Listing new routes is always human-initiated.
2. **Sale window** — the sale-authorizer cron checks AeroAPI for every enabled flight over the sale horizon and attests via `OracleAggregator.open_sale` (max 24h) that the instance is scheduled and not cancelled; unverifiable or cancelled instances get their windows closed immediately. `buy_insurance` fails closed without a live attestation.
3. **Purchase and registration** — `Controller.buy_insurance` checks: route `Active`, lead time, live sale window, no recorded oracle outcome, and vault solvency on *aggregate* liabilities (`TMA >= ceil((locked + payoff) * solvency_ratio / 100)`). The first buyer registers the flight in both `FlightPoolManager` (locks the terms snapshot) and `OracleAggregator` (status `NotInitiated`). The premium escrows in the pool; the full payoff is locked in the vault. An optional admin-toggled buyer allowlist can restrict who may buy.
4. **Activation** — the fetcher cron pushes the **scheduled** arrival via `set_estimated_arrival` → status `Active`. A flight cancelled before ever activating is pushed as `set_cancelled` immediately, closing the purchase gate in the same cycle.
5. **Tracking** — every fetcher cycle re-checks Active flights. Cancellations are pushed the moment they are visible; the landed resolution waits until ETA + 1h and requires an actual gate-arrival timestamp before `set_landed`. Ambiguous AeroAPI data (more than one physical flight for the day) is never guessed at — the flight stays unresolved for operator attention.
6. **Classification** — `Controller.classify_flights` compares actual vs. estimated arrival against the route's delay threshold and moves `Landed`/`Cancelled` flights to `ToBeSettledOnTime` / `ToBeSettledDelayed` / `ToBeSettledCancelled`. Flights with no oracle data for ≥ 14 days are voided to on-time, so a dead row can never pin vault collateral forever.
7. **Settlement** — `Controller.execute_settlements`. On-time: pooled premiums forward to the vault as underwriter yield and the locked payoff is released. Delayed/cancelled: the vault tops the pool up to `payoff × buyers` and a claim window opens. The oracle marks the flight `Settled`.
8. **Claim, sweep, prune** — travelers call `FlightPoolManager.claim` before the claim window expires; after expiry, anyone may `sweep_expired` (unclaimed funds accrue to the protocol's recovered balance, withdrawable by the Owner). `OracleAggregator.prune_settled` evicts flights settled ≥ 30 days ago from the active list.

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

## Off-Chain Executors and Governance

Four trusted signing identities drive the protocol forward; their addresses are registered on-chain and every entry point checks the caller. Flight *outcomes* are always decided on-chain — the crons only trigger transitions.

| Identity | Authorized for | Env var |
|----------|----------------|---------|
| **Oracle** | `OracleAggregator`: `open_sale`/`close_sale`, `set_estimated_arrival`, `set_landed`, `set_cancelled` | `ORACLE_SECRET_KEY` |
| **Keeper** | `Controller`: `classify_flights`, `execute_settlements`, `run_queue_maintenance` | `KEEPER_SECRET_KEY` |
| **Governance admin** | `GovernanceModule` route mutations, used by the whitelist script, the route agent, the reconciler, and admin-console actions. An admin added by the owner via `add_admin` — never the owner key. | `GOVERNANCE_ADMIN_SECRET_KEY` |
| **TTL extender** | Permissionless housekeeping: `extend_ttl` on all five contracts, `prune_settled` (any funded account works) | `TTL_EXTENDER_SECRET_KEY` |

External systems at a glance:

| System | Kind | Used by | Purpose |
|--------|------|---------|---------|
| **FlightAware AeroAPI** | third-party API (keyed) | sale authorizer, fetcher | Real flight schedules + outcomes: scheduled arrival (never live estimates), actual landing, cancellations. No key → jobs fail soft (skip + retry) |
| **Open-Meteo** | third-party API (keyless) | route agent | Origin/destination forecasts → elevated/severe weather rules |
| **ML pricing service** ([`agent/`](agent/), Render) | our service | route agent | XGBoost `p_delay` → baseline premium; unreachable → falls back to routes-file terms |
| **Governance DB** ([`supabase/`](supabase/), Supabase) | our database | reconciler, admin console, status page | Route registry, signals, pause/premium state, actions log, cron-run history. RLS deny-all; only the serverless functions touch data |
| **Vercel crons** ([`dapp/api/cron/`](dapp/api/cron/)) | our runtime | all 8 jobs | The scheduler + executors; guarded by `CRON_SECRET` |
| **Routes file** ([`dapp/config/routes.testnet.json`](dapp/config/routes.testnet.json)) | config (human-edited) | whitelist script, sale authorizer, route agent | Single source of human intent: which routes exist, term overrides, price rails, `enabled` flags |

### Cron jobs

Eight jobs run as Vercel serverless functions ([dapp/api/cron/](dapp/api/cron/), schedules in [dapp/vercel.json](dapp/vercel.json)):

| Job | Identity | Cadence | What it triggers |
|-----|----------|---------|------------------|
| Sale authorizer | Oracle | every 2h, offset | AeroAPI schedule check → `open_sale` / `close_sale` per enabled route (fail closed: no attestation, no sales) |
| Flight data fetcher | Oracle | every 2h | AeroAPI → `set_estimated_arrival` / `set_landed` / `set_cancelled` |
| Flight classifier | Keeper | hourly | `Controller.classify_flights` |
| Settlement executor | Keeper | every 5 min | `Controller.execute_settlements` |
| Queue maintainer | Keeper | every 5 min, offset | `Controller.run_queue_maintenance` — drains the underwriter deposit + withdrawal queues and takes the share-price snapshot; decoupled so heavy settlements can't starve exits |
| Route agent | Governance admin | daily | ML baseline premium + weather rules + 24h re-evaluation of disabled routes |
| Governance reconciler | Governance admin | hourly, :10 | Recomputes each managed route's desired state from DB signals and executes the minimal on-chain diff |
| TTL extender | TTL | daily | `extend_ttl` × 5 contracts + `prune_settled` (Soroban storage-rent housekeeping) |

Every run is recorded in the governance DB (`cron_runs`), surfaced on the public `/status` page. See the [dapp README](dapp/README.md#serverless-crons-vercel) for deployment, auth, and plan caveats.

### Governance database

The contracts are the source of truth for *money and terms* — balances, locked collateral, canonical route premiums. They are deliberately not a place to accumulate operational memory: every stored value costs rent, every read is an RPC round-trip, and there is no way to query "show me the weather alerts from the last 6 hours" or "who disabled this route and when." The governance layer needs exactly that kind of memory, so it lives off-chain in a **Supabase (Postgres)** database — the automation's working state and audit trail, distinct from the on-chain settlement state.

It holds seven tables:

| Table | Purpose |
|-------|---------|
| `routes` | The set of routes the automation manages, mirrored from the routes file |
| `signals` | Timestamped facts that should influence pricing/pausing — weather events, operational alerts — with a scope (route / origin / dest) and an expiry |
| `pause_events` | Which routes the system has paused and why, so it knows what it may later un-pause |
| `premium_adjustments` | Active multipliers stacked over base terms, with the admin pins that override automation |
| `actions_log` | Every on-chain write the layer makes, attributed to the actor (cron or a named admin) — the audit trail |
| `cron_runs` | Per-run health for all eight jobs, powering the public `/status` page |
| `ingest_cursors` / `policies` | Bookmarks for incremental signal ingestion and a local mirror of purchased policies |

Why it's needed: the **hourly reconciler** ([below](#automated-governance)) decides each route's state by reasoning over *history* — signals that arrived since the last run, how long a pause condition has been clear (hysteresis), whether an admin has pinned the route. None of that fits on-chain. Postgres gives it durable, queryable state; recomputing desired state from that state each run is what makes the reconciler idempotent and crash-safe. Supabase **Auth** additionally backs the `/admin` allowlist. Security posture: **RLS is deny-all with zero policies** — the anon key can read nothing, and the only data path is the server-side transaction-pooler connection used by the serverless functions.

### Automated governance

Whitelisting stays human — a route exists on-chain only after someone edits the routes file and runs `npm run whitelist:routes` with the governance-admin key. From then on, two automated layers may reprice or temporarily pause routes, and one manual layer supervises both:

1. **Route agent** (daily) — per route: on-chain `route_status` → ML baseline premium ([agent/](agent/)) → Open-Meteo forecasts for both airports → pure decision rules ([route_rules.ts](dapp/api/_lib/route_rules.ts)): elevated weather → premium × multiplier; severe weather → `disable_route`; disabled route + clear weather + still `enabled` in the file → re-enable with fresh terms; sub-$1 premium drift → no-op.
2. **Reconciler** (hourly) — the governance DB holds *signals* (facts: weather events, operational alerts) and admin intent; the reconciler ([reconciler.ts](dapp/api/_lib/governance/reconciler.ts)) recomputes each route's desired state from scratch every run through pure rules ([rules.ts](dapp/api/_lib/governance/rules.ts)) — admin pins win, pause scopes expand (route/origin/dest), premium multipliers stack, hysteresis damps flapping — then submits the minimal on-chain diff and logs it to `actions_log`. Idempotent: a crashed run heals on the next tick. `GOV_DRY_RUN=true` computes and logs decisions without submitting.
3. **Admin console** — see [below](#admin-console-and-status).

All automated writes are boxed in by three nested guardrails: the decision rules themselves, the routes-file rails (min/max premium/payoff, max daily step), and the on-chain owner-set term limits (payoff cap + payoff/premium ratio). The automation can never whitelist a new route, never touch the global defaults, and never re-enable a route a human disabled. The owner key alone changes defaults, term limits, and admins. Failure posture is degrade-to-nothing: model down → file terms; forecast API down → no weather signal → no-op.

### Admin console and status

- **`/admin`** (in the dapp) — operator console for the governance layer: route lifecycle actions (whitelist / disable / enable / remove / set terms / revert), signal management, pinning routes against automation, and job-run inspection. Identity via Supabase Auth restricted to an `ADMIN_EMAILS` allowlist; actions execute server-side ([dapp/api/admin/](dapp/api/admin/)) with the governance-admin key and are attributed per admin in `actions_log`. The Supabase anon key can read nothing (RLS deny-all with zero policies) — the server-side pooler connection is the only data path.
- **`/status`** (public) — cron-run health for all eight jobs from `cron_runs`.

## Deployment Plan

Step-by-step deploy instructions are in [DEPLOYMENT.md](DEPLOYMENT.md). What runs where — four hosted surfaces plus the chain itself:

| What | Source | Deployed on | Notes |
|------|--------|-------------|-------|
| Smart contracts (×6) | [`contracts/`](contracts/) | **Stellar testnet** (Soroban) | Addresses in [`deployments/testnet.json`](deployments/testnet.json); deployed via `make deploy-testnet` |
| dApp frontend + `/admin` | [`dapp/`](dapp/) | **Vercel** (static build) | One Vercel project, root = `dapp/` |
| Serverless crons (×8) + admin/status APIs | [`dapp/api/`](dapp/api/) | **Vercel** (same project) | Schedules in [`dapp/vercel.json`](dapp/vercel.json); 5-min crons need Vercel Pro (Hobby: external pinger with the `CRON_SECRET` bearer) |
| Governance DB | [`supabase/`](supabase/) | **Supabase** (Postgres + Auth) | Migrations in `supabase/migrations/`; serverless functions connect via the transaction pooler |
| ML pricing service | [`agent/`](agent/) | **Render** (Docker web service) | Via root [`render.yaml`](render.yaml); optional — unset falls back to routes-file terms |
| Mock AeroAPI | [`tools/mock-aeroapi/`](tools/mock-aeroapi/) | **local only** | Keyless test fixture; point `AEROAPI_BASE_URL` at it for demos |

Secrets live only in host env stores (Vercel / Render / Supabase), never in the repo — full list with defaults in [`dapp/.env.example`](dapp/.env.example).

First-time deploy order:

1. **Contracts** — `make deploy-testnet` following [`contracts/deploy_order.md`](contracts/deploy_order.md)
2. **Supabase** — create the project, apply `supabase/migrations/`
3. **Render** — deploy `agent/` (Docker), set `AGENT_TOKEN`
4. **Vercel** — import the repo with root directory `dapp/`, set the env vars, deploy; crons start automatically
5. **One-time on-chain setup** — owner runs `GovernanceModule.add_admin` for the governance-admin key; fill the routes file and run `npm run whitelist:routes` (until `add_admin` lands, keep `GOV_DRY_RUN=true`)

## Getting Started

Prerequisites: [Rust](https://www.rust-lang.org/tools/install) (the pinned toolchain installs automatically via `rust-toolchain.toml`), the [Stellar CLI](https://developers.stellar.org/docs/tools/cli), and `make`.

All commands run from the `contracts/` directory:

```bash
cd contracts

make test            # run the full test suite
make coverage        # line-coverage summary (published report: see badge above)
make build           # build all contracts to wasm + verify network size caps
make check           # formatting, clippy, and tests
make ci              # full local CI (check + dependency audit)

make keys            # generate and fund a testnet identity
make deploy-testnet  # build and deploy all contracts to testnet
```

Run `make help` for the complete target list. See also [deploy_order.md](contracts/deploy_order.md) (deploy and wiring order) and [upgrade.md](contracts/upgrade.md) (upgrade authority).

### Running the dApp locally

Prerequisites: Node.js 20.19+ (or 22.12+). From the `dapp/` directory:

```bash
cd dapp

npm install               # frontend dependencies
npm run install:contracts # install + build the contract-binding workspaces
cp .env.example .env      # testnet defaults (RPC, Horizon, contract IDs)
npm run dev               # serves at http://localhost:5175
```

Full instructions — including env-var details and cron-function local testing — in the [dapp README](dapp/README.md#run-locally).

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
