# Sentinel dApp

The deployable app: Vite + React frontend (fun/serious dual theme), the
Vercel serverless cron functions in `api/`, and the generated contract
bindings in `packages/`.

## Run locally

Prerequisites: Node.js 20.19+ (or 22.12+, required by Vite 7) and npm.
All commands run from this `dapp/` directory.

**1. Install frontend dependencies**

```sh
npm install
```

**2. Install and build the contract bindings**

The generated TypeScript bindings for the five Soroban contracts live as
npm workspaces in `packages/*`. They need their own install + build before
the app can import them:

```sh
npm run install:contracts
```

**3. Create your `.env`**

```sh
cp .env.example .env
```

The defaults in `.env.example` point the frontend at **testnet** (public
RPC/Horizon plus the deployed contract IDs), which is what you want for a
local run. Don't skip this step: without a `.env` the app falls back to a
LOCAL network at `http://localhost:8000` and every RPC call fails unless
you are running a local Stellar quickstart node.

Only the `PUBLIC_`-prefixed vars reach the browser bundle; the rest are
server-side vars for the cron functions (see
[Serverless crons](#serverless-crons-vercel) below) and can stay empty for
frontend work.

**4. Start the dev server**

```sh
npm run dev
```

The app serves at [http://localhost:5175](http://localhost:5175) (strict
port). Connect a testnet wallet (e.g. Freighter set to Testnet) and use the
top-bar **+MINT** button to fund yourself with mock USDC.

Useful extras:

```sh
npm run typecheck         # tsc over app + api, no emit
npm run build             # production build (tsc -b && vite build)
npm run preview           # serve the production build locally
```

## Bots (the jobs behind the crons)

Every scheduled job is a plain, standalone **bot** — a `run(config)` function
with no Vercel dependency. The crons below are just *our* schedule for them:

```sh
npm run bot -- fetcher          # single-shot run, prints the RunLogEntry JSON
npm run bot -- settler          # exit 0 = success, 1 = failure
npm run bot -- gov_reconcile
```

The bots fall into **three tiers with different decentralization stories**:

| Tier | Bots | Who runs them |
|---|---|---|
| **Governance** | `gov_exposure`, `gov_reconcile`, `gov_onboard`, `weather`, `reprice`, `revive` | **Centralized (us), by design** — writes route policy with the gov-admin key, backed by the governance DB |
| **Oracle** | `fetcher` (the settle sweep) — plus the JIT sale-auth endpoint `POST /api/sale-auth/request`, which is a request handler, not a bot | **Centralized (us), by design** — the trust root: they spend AeroAPI calls and attest real-world facts with the `authorized_oracle` key |
| **Keepers / liquidators** | `classifier`, `settler`, `queue_maintainer`, `ttl_extender` | **The decentralization target** — they move no new information on-chain, only execute what the oracle already attested |

- **Keepers are the open-source, anyone-can-run tier.** `ttl_extender` (and
  the on-chain `sweep_expired` / `prune_settled` it drives) is permissionless
  today — any funded key works. `classifier` / `settler` / `queue_maintainer`
  currently require the `authorized_keeper` key (spam control, not
  integrity — classification is deterministic from attested oracle data);
  the planned contract upgrade makes them permissionless with per-flight
  bounties so third-party keeper bots earn for running them (spec/TODO.md §E).
- **Keys decide authority, not the runner.** A third-party bot run only lands
  writes if its signing address is authorized on-chain — publishing the code
  gives away no power.

### Run a keeper bot yourself

The keeper bots are plain TypeScript — where you run them is up to you
(laptop, server, CI, anything with Node 20+). The code:
[`scripts/run_bot.ts`](scripts/run_bot.ts) (entry point) →
[`api/_lib/jobs/`](api/_lib/jobs/) (the job logic) →
[`api/_lib/soroban_client.ts`](api/_lib/soroban_client.ts) (sign + submit).

```sh
git clone <this repo> && cd dapp
npm install && npm run install:contracts

# keeper bots need ONLY a Stellar RPC + a funded key — no AeroAPI, no DB
export STELLAR_RPC_URL="https://soroban-testnet.stellar.org"
export KEEPER_SECRET_KEY="S..."       # must be the on-chain authorized_keeper
export ORACLE_SECRET_KEY="S..."       # any funded key (read-source only for keepers)
export TTL_EXTENDER_SECRET_KEY="S..." # any funded key — extend_ttl is permissionless

npm run bot -- settler          # drain pending settlements (exit 0/1, JSON log)
npm run bot -- queue_maintainer # LP queue maintenance
npm run bot -- classifier       # classification sweep
npm run bot -- ttl_extender     # TTL upkeep + prune — runnable by ANYONE today
```

Until the bounty upgrade opens `classifier`/`settler`/`queue_maintainer` to
any key, their writes only land for the registered `authorized_keeper`; an
unauthorized run fails the on-chain auth check with no side effects.
- **DB-optional invariant.** The oracle + keeper bots NEVER require the
  governance DB: with `GOVERNANCE_DB_URL` unset they run fully (history
  recording is skipped); with the DB down, recording fails silently and the
  bot still reports its on-chain result. The e2e suite runs the entire
  pipeline with no DB attached. Only the governance tier needs the DB — that
  tier *is* the DB.

### Route discovery

```sh
npx tsx ../scripts/discover_routes.ts          # full 80-pair sweep → catalog
npx tsx ../scripts/discover_routes.ts --date 2026-08-12
```

Finds insurable routes with the minimum API spend: one origin/destination-
filtered `/schedules` call per directed city pair per sample day (default: a
Tuesday + the following Saturday) — **~60 calls for the whole 30-pair matrix,
yielding 200+ routes**.

**Two separate, individually idempotent steps** against one governance-consumed
JSON (`config/routes.testnet.json`):

1. **Discover + add** — the script APPENDS new routes directly into the file
   (everything else in it is preserved). Already-present routes are skipped and
   multi-leg flight numbers the contract would reject are dropped, so a re-run
   finds everything covered and writes nothing. Review the append with
   `git diff` (use `--dry` to preview without writing).
2. **Whitelist** — `npx tsx ../scripts/seed_routes.ts` pushes the ADMIN-REVIEWED
   staged whitelist (`config/route_whitelist.json`) on-chain. It
   diffs against live `route_status` first (`Active` → noop) and the contract
   treats a same-route re-whitelist as a no-op refresh — running it twice
   changes nothing.

(`gov_onboard`'s sync phase then mirrors the file into the governance DB so the
reconciler manages every listed route.) Internal ops tool — deliberately not
part of the e2e suite; both steps are hand-verified idempotent against the mock
and live testnet.

## Serverless crons (Vercel)

Eleven cron jobs run as Vercel serverless functions inside this app, so a single Vercel deployment can serve the frontend **and** keep the protocol running. All jobs share one transaction pattern: simulate → assemble (with 40% resource-fee bump) → sign → send → poll.

> **Current deploy state:** the checked-in `vercel.json` has the `crons` block
> **removed** and `.vercelignore` excludes `api/` — the present deployment is
> frontend-only while the backend runs LOCALLY as bots (`npm run bot -- <name>`;
> 5-minute Vercel crons need a Pro plan). To flip the backend on later:
> `mv vercel.backend.json vercel.json && rm .vercelignore` — the ready-made
> config carries all 11 cron schedules (`JOB_REGISTRY` in
> `api/_lib/governance/runs.ts` is the canonical list) — then set the server
> env vars and deploy.

### Layout

```
api/
  _lib/               ported logic (underscore dir — not routed by Vercel)
    config.ts         env-driven config, testnet defaults for non-secrets
    soroban_client.ts raw stellar-sdk Contract calls (no bindings)
    aeroapi_client.ts AeroAPI fetch with retry/backoff + ambiguity guard
    handler.ts        auth + makeCronHandler wrapper
    types.ts          RunLogEntry / FlightStatus / Config (executor shapes)
    sale_auth.ts      JIT sale authorization core (the buy-click check)
    route_guard.ts    anomaly-triggered 5-day cancellation sweep + route_health ledger
    jobs/             fetcher (settle sweep), classifier, settler, queue, ttl, weather, repricer, revive — each exports run(config)
    governance/       DB-driven governance layer: reconciler, rules, submitter, run recorder
  cron/               routed functions
    fetcher.ts  classify.ts  settle.ts  queue.ts  ttl.ts  weather.ts  reprice.ts  revive.ts  gov-*.ts  health.ts
  sale-auth/          request.ts — the public JIT buy-click endpoint
  admin/              /admin console API (Supabase Auth identity + ADMIN_EMAILS allowlist)
  status/             public cron-run health backing /status
vercel.json           deploy config (crons block currently removed — see note above)
tsconfig.api.json     type-checks api/ with node types (wired into tsc -b)
```

### Schedules

| Endpoint             | Schedule       | Job                                             |
| -------------------- | -------------- | ----------------------------------------------- |
| `/api/cron/fetcher`  | `0 */2 * * *`  | The settle sweep — insured flights past scheduled arrival + `SETTLE_AFTER_ETA_SECS` (default 5h): ONE AeroAPI call resolves the outcome (schedule + landing from the same response, or a corroborated cancellation/diversion — bare flags are never attested); outcomes drive targeted classify+settle immediately. Promise: settled within 24h of ETA |
| `/api/cron/classify` | `0 * * * *`    | `Controller.classify_flights` — skips (no tx) when the active set is empty |
| `/api/cron/settle`   | `*/5 * * * *`  | Drains pending outcomes: skips (no tx) when `get_pending_outcomes()==0`, else loops classify+settle passes until zero/stall, falling back to `execute_settlements_bounded` (3→1) on resource-budget failures |
| `/api/cron/queue`    | `2-59/5 * * * *` | `Controller.run_queue_maintenance` — skips (no tx) while the settlement barrier is engaged or when queues are empty + today's snapshot exists; off-tempo from settle (txBadSeq retried once in the client) |
| `/api/cron/weather`  | `20 */2 * * *` | Storm surcharge — stateless: fleet-file base + flat Open-Meteo forecast surcharge → `update_route_terms` (no DB) |
| `/api/cron/reprice`  | `0 8 1 * *`    | Monthly ADVISORY seasonal repricing — proposal → `pricing_runs`; the admin applies it via `seed_routes --apply-terms` (no chain writes) |
| `/api/cron/revive`   | `0 6 * * *`    | Revive check — re-sweeps the 20 most recently guard-paused routes (`route_health`); a schedule that is verifiably back → `enable_route` |
| `/api/cron/ttl`      | `0 0 * * *`    | `extend_ttl` on all 5 contracts + `prune_settled` in a drain loop (repeats while the active count drops) |
| `/api/cron/gov-exposure` | `7 * * * *` | Exposure collector — reads on-chain liability (payoff × buyers per active flight vs vault capacity, no AeroAPI) and projects route/airport concentration `exposure` signals (≥25% elevated, ≥50% severe; env-tunable). Facts only, no chain writes |
| `/api/cron/gov-onboard` | `15 */6 * * *` | Fleet status sync — file/on-chain routes → DB so the reconciler manages every real route. Route INTAKE is deliberately NOT here: whitelisting is the manual admin pipeline in `scripts/` (discover → price → review → seed) |
| `/api/cron/gov-reconcile` | `10 * * * *` | Governance reconciler (pause engine) — recomputes each managed route's desired state from DB signals (admin pins win, severe pauses expand, hysteresis damps re-enables) and submits the minimal on-chain diff; `GOV_DRY_RUN=true` logs decisions without submitting |

`/api/cron/health` is an unauthenticated GET that returns the network, contract IDs, and `hasKeys` booleans (secrets are never echoed).

**Not a cron:** `POST /api/sale-auth/request { flight_id, date }` — the JIT
sale authorization the frontend calls on every buy click. It verifies the
flight just-in-time (live `/flights` inside 2 days, published `/schedules`
presence further out; refuses anything departing <24h out), opens the
on-chain sale window with expiry `min(now+validity, departure−24h)`, and
fires the route guard's 2-call 5-day sweep when a buy attempt hits a
cancelled/vanished flight (all 5 days dead → route disabled + `route_health`
row; the daily revive cron heals it). Idle whitelisted routes cost ZERO
AeroAPI calls.

### Env vars

Server-side (no `PUBLIC_` prefix — set in Vercel project settings, never bundled into the browser; see `.env.example`):

- `STELLAR_RPC_URL`, `STELLAR_NETWORK_PASSPHRASE` — default to testnet
- `ORACLE_AGGREGATOR_ID`, `CONTROLLER_ID`, `RISK_VAULT_ID`, `GOVERNANCE_ID`, `FLIGHT_POOL_MANAGER_ID` — default to `deployments/testnet.json`
- `ORACLE_SECRET_KEY`, `KEEPER_SECRET_KEY`, `TTL_EXTENDER_SECRET_KEY` — **required**, no defaults
- `AEROAPI_BASE_URL` (defaults to the real FlightAware API), `AEROAPI_KEY`
- `GOVERNANCE_ADMIN_SECRET_KEY` — 4th identity for the governance jobs, the route guard's pause path, + the whitelist script; must be a `GovernanceModule` admin (owner runs `add_admin` once), never the owner key
- `AGENT_BASE_URL`, `AGENT_TOKEN` — the Python pricing service (`agent/` on Render); used by the intake pipeline + the monthly repricer
- `SALE_AUTH_HORIZON_DAYS`, `SALE_AUTH_VALIDITY_SECS` — JIT sale-auth overrides (horizon defaults to the routes file's `sale_horizon_days`; validity default 6h, on-chain cap 24h)
- `SALE_MIN_LEAD_SECS` — the purchase cutoff vs scheduled departure (default 86400 = 24h; no sale window ever authorizes a buy inside it)
- `SETTLE_AFTER_ETA_SECS` — how long after a flight's scheduled arrival the settle sweep makes its first (usually only) AeroAPI call (default 18000 = 5h; before it a flight costs zero API calls)
- `ROUTES_CONFIG_PATH` — alternate routes file (tests / other networks); defaults to the bundled `config/routes.testnet.json`
- `WEATHER_BASE_URL` — Open-Meteo override (keyless; testing only)
- `CRON_SECRET` — shared secret guarding the cron endpoints (recommended)
- `GOVERNANCE_DB_URL` — Supabase transaction-pooler Postgres URL (governance DB); `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `ADMIN_EMAILS` — admin-console auth; `GOV_DRY_RUN` — compute-only mode for all governance jobs (the gov-admin IS an on-chain admin since 2026-07-27; the runtime brake is the `ops_flags.gov_frozen` DB flag via `POST /api/admin/freeze`)
- `EXPOSURE_ELEVATED_PCT` / `EXPOSURE_SEVERE_PCT` — exposure-signal thresholds as fractions of vault capacity (defaults 0.25 / 0.5)

### Routes file + whitelist script

`config/routes.testnet.json` is the single human source of truth for
insurable routes: whitelist entries with optional term overrides, hard rails
(premium/payoff min-max, max daily premium step, weather multiplier), the
sale horizon, and per-route `enabled` flags. `enabled: false` is permanent
human intent — the route agent will disable such a route on-chain but will
NEVER re-enable it; flip the flag back to `true` to hand it back to the
agent's 24h re-evaluation.

Whitelisting NEW routes is deliberately script-only (the agent never lists
routes):

```sh
# after filling config/routes.testnet.json (needs GOVERNANCE_ADMIN_SECRET_KEY)
npx tsx ../scripts/seed_routes.ts --dry-run   # review the staged whitelist
npx tsx ../scripts/seed_routes.ts             # seed on-chain (admin go)
```

### Running without an AeroAPI key

Without an `AEROAPI_KEY`, everything still runs safely: the contract-only
jobs are fully functional, and the fetcher fails soft — API errors are logged,
each flight is recorded as `skipped: "No AeroAPI data"`, nothing bad is written
on-chain, and it retries next cycle. For a keyless demo, point
`AEROAPI_BASE_URL` at a `tools/mock-aeroapi` instance instead (scripted
scenarios, no key needed) — hosted, or locally at
`AEROAPI_BASE_URL=http://localhost:3001`.

### Future improvement: AeroAPI push alerts (webhook)

Cancellation detection is currently poll-only, so worst-case reaction time
equals the poll interval. AeroAPI supports configured push alerts (cancellation
/ departure / arrival events POSTed to an HTTPS endpoint), which would make
cancellations near-instant instead:

- a webhook function (e.g. `api/aeroapi/alert`) verifies a shared secret,
  writes the raw alert to the governance DB first (ack fast), then runs the
  same on-chain sequence the crons use today: `close_sale` → `set_cancelled` →
  targeted classify/settle;
- alerts are created when a flight first gets a policy and deleted after
  settlement, so the alert count tracks insured flights, not the whitelist;
- polling stays in place as the reconciliation/backup layer — a missed alert
  is caught at the next scheduled poll, and if both die, sale windows expire
  on their own (≤24h on-chain cap) and sales fail closed.

Not built yet: it needs an AeroAPI plan tier with alerts, and the poll-only
economics are acceptable at current scale (API cost tracks insured flights,
not whitelisted routes).

### Auth

- If `CRON_SECRET` is set, every cron request must carry `Authorization: Bearer $CRON_SECRET`. Vercel's scheduler sends this header automatically when the `CRON_SECRET` env var exists, so no extra config is needed for scheduled runs.
- If `CRON_SECRET` is unset, requests carrying the `x-vercel-cron` header are accepted (Vercel sets it on scheduled invocations and strips it from external traffic).
- Anything else gets `401`.

### Plan caveat

The 5-minute schedules (`settle`, `queue`) and `maxDuration: 300` require **Vercel Pro** — the Hobby plan only allows daily-granularity crons and shorter function durations. On Hobby, keep `vercel.json` crons for `authorize`/`fetcher`/`classify`/`agent`/`ttl` reduced to daily or remove them, and drive the endpoints with an external pinger (GitHub Actions schedule, cron-job.org, UptimeRobot, …) that curls each endpoint with the Bearer `CRON_SECRET` header.

### Local testing

```sh
# Option A — full emulation (needs vercel CLI; .env supplies server-side vars)
vercel dev

curl -H "Authorization: Bearer $CRON_SECRET" http://localhost:3000/api/cron/settle
curl http://localhost:3000/api/cron/health

# Option B — no vercel CLI: invoke a handler directly with tsx
npx tsx -e '
  import handler from "./api/cron/health";
  const res = { statusCode: 0, status(c){ this.statusCode = c; return this; }, json(b){ console.log(this.statusCode, JSON.stringify(b, null, 2)); } };
  handler({ method: "GET", headers: {} } as any, res as any);
'
```

To exercise the fetcher without spending AeroAPI credits, see
[Running without an AeroAPI key](#running-without-an-aeroapi-key).

### End-to-end pipeline tests (no real API, no real chain)

```sh
npm run test:e2e
```

`scripts/test_oracle_e2e.ts` spawns `tools/mock-aeroapi` on an ephemeral port
and runs the REAL fetcher + sale-authorizer job code (real `AeroApiClient`
over HTTP) against an in-memory fake of the OracleAggregator + Controller
(forward-only state machine, classify/settle semantics). It covers the full
on-time / delayed / cancelled lifecycles end to end, the refusal paths
(diverted, tracking-lost, ambiguous), and asserts the exact per-flight
AeroAPI call counts — including that flights outside their fetch windows cost
zero calls. The mock server's own smoke test is `tools/mock-aeroapi/test.sh`.

### Real-chain end-to-end tests (real contracts on testnet, mocked API)

```sh
npm run test:e2e:testnet:bootstrap   # once: deploy a dedicated e2e contract
                                     # set on testnet (throwaway — never the
                                     # live deployment), fund, capitalize.
                                     # The vault deposit then ripens for ~6h
                                     # (on-chain LP pricing delay).
npm run test:e2e:testnet             # each run: the same pipeline, real chain
```

`scripts/test_testnet_e2e.ts` is the depth complement to the hermetic suite:
same job code, same mock AeroAPI (runtime-scripted scenarios), but the chain
is REAL — it proves everything `FakeSoroban` cannot: the purchase flow
(sale-auth gate, premium transfer, vault payoff locking), the real Rust
state machine, the batch keeper jobs (classifier / settler / queue / ttl),
settlement money movement, and claims (delayed + cancelled pay the full
payoff; the on-time claim is rejected on-chain).

Each run is TWO phases, because the real oracle enforces
`date ≤ ETA ≤ date+3d` and `date ≤ actual_arrival` — a purchasable flight's
date is always in the future, so its landing physically cannot be attested
until the flight day arrives (the suite caught FakeSoroban not modeling
this on its first real run). The **buy-day** phase does routes → sale-auth
→ 3 purchases → ETA writes, and fully settles + claims the CANCELLED
flight (no timestamps involved). Rerunning the same command from ~12:00
UTC on the flight day runs the **flight-day** phase: landings, targeted
settlement, keeper sweeps, the delayed claim, and the on-time claim
rejection. The suite tracks the pending run in its cache and tells you
when the second phase is runnable (`--abandon` drops a stuck run).

Each run whitelists fresh flight idents on fresh routes (state never
collides across runs); shared harness bits live in `scripts/e2e/harness.ts`.
Redeploy with `--fresh` after a quarterly testnet reset.

