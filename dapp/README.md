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
npm run bot -- gov_signals
```

The bots fall into **three tiers with different decentralization stories**:

| Tier | Bots | Who runs them |
|---|---|---|
| **Governance** | `gov_signals`, `gov_reconcile`, `route_agent` | **Centralized (us), by design** — writes route policy with the gov-admin key, backed by the governance DB |
| **Oracle** | `fetcher`, `sale_authorizer` | **Centralized (us), by design** — the trust root: they spend AeroAPI calls and attest real-world facts with the `authorized_oracle` key |
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
- **DB-optional invariant.** The oracle + keeper bots NEVER require the
  governance DB: with `GOVERNANCE_DB_URL` unset they run fully (history
  recording is skipped); with the DB down, recording fails silently and the
  bot still reports its on-chain result. The e2e suite runs the entire
  pipeline with no DB attached. Only the governance tier needs the DB — that
  tier *is* the DB.

### Route discovery

```sh
npm run discover:routes                     # NYC (JFK/EWR/LGA) <-> SEA/SFO/LAX/ORD/MIA
npm run discover:routes -- --max 200 --date 2026-08-04
```

Finds insurable routes with the minimum API spend: one origin/destination-
filtered `/schedules` call per directed city pair per sample day (default: a
Tuesday + the following Saturday) — **~60 calls for the whole 30-pair matrix,
yielding 200+ routes**. Writes `config/routes.discovered.json`; review, merge
into `routes.testnet.json`, then `npm run whitelist:routes`.

The whole loop is **idempotent** — re-run it any time: discovery skips routes
already in the routes file (and drops multi-leg flight numbers the contract
would reject), the whitelist script diffs on-chain state first (`Active` →
noop), and the contract itself treats re-whitelisting the same route as a
no-op refresh. Internal ops tool — deliberately not part of the e2e suite.

## Serverless crons (Vercel)

Eight cron jobs run as Vercel serverless functions inside this app, so a single Vercel deployment can serve the frontend **and** keep the protocol running. All jobs share one transaction pattern: simulate → assemble (with 40% resource-fee bump) → sign → send → poll.

> **Current deploy state:** the checked-in `vercel.json` has the `crons` block
> **removed** and `.vercelignore` excludes `api/` — the present deployment is
> frontend-only while the backend rollout is WIP. To enable the backend, delete
> `.vercelignore` and restore the crons block from the schedule table below
> (`JOB_REGISTRY` in `api/_lib/governance/runs.ts` is the canonical list).

### Layout

```
api/
  _lib/               ported logic (underscore dir — not routed by Vercel)
    config.ts         env-driven config, testnet defaults for non-secrets
    soroban_client.ts raw stellar-sdk Contract calls (no bindings)
    aeroapi_client.ts AeroAPI fetch with retry/backoff + ambiguity guard
    handler.ts        auth + makeCronHandler wrapper
    types.ts          RunLogEntry / FlightStatus / Config (executor shapes)
    jobs/             authorizer, fetcher, classifier, settler, queue, ttl, route_agent — each exports run(config)
    governance/       DB-driven governance layer: reconciler, rules, submitter, run recorder
  cron/               routed functions
    authorize.ts  fetcher.ts  classify.ts  settle.ts  queue.ts  agent.ts  ttl.ts  gov-reconcile.ts  health.ts
  admin/              /admin console API (Supabase Auth identity + ADMIN_EMAILS allowlist)
  status/             public cron-run health backing /status
vercel.json           deploy config (crons block currently removed — see note above)
tsconfig.api.json     type-checks api/ with node types (wired into tsc -b)
```

### Schedules

| Endpoint             | Schedule       | Job                                             |
| -------------------- | -------------- | ----------------------------------------------- |
| `/api/cron/authorize`| `30 */2 * * *` | Sale authorizer (cron #0) — attests sale windows for the enabled flights in `config/routes.testnet.json`. Days 1–2 from live `/flights` data (cancellation tombstones need a corroborating status, not just the `cancelled` flag); days 3+ from published `/schedules` in ≤20-day chunks (~2 + ceil((horizon−2)/20) API calls per flight per run instead of one per day). Fail closed throughout |
| `/api/cron/fetcher`  | `0 */2 * * *`  | AeroAPI → oracle (ETA / landed / cancelled), phase-gated: ETA fetched at T-2d (AeroAPI's future-visibility limit), then ZERO calls until `FETCHER_WATCH_SECS` (default 6h) before the recorded arrival; corroborated diversions pay as cancellations (policy), uncorroborated cancelled/diverted flags are never attested; outcomes drive targeted classify+settle immediately |
| `/api/cron/classify` | `0 * * * *`    | `Controller.classify_flights` — skips (no tx) when the active set is empty |
| `/api/cron/settle`   | `*/5 * * * *`  | Drains pending outcomes: skips (no tx) when `get_pending_outcomes()==0`, else loops classify+settle passes until zero/stall, falling back to `execute_settlements_bounded` (3→1) on resource-budget failures |
| `/api/cron/queue`    | `2-59/5 * * * *` | `Controller.run_queue_maintenance` — skips (no tx) while the settlement barrier is engaged or when queues are empty + today's snapshot exists; off-tempo from settle (txBadSeq retried once in the client) |
| `/api/cron/agent`    | `0 6 * * *`    | Route agent — ML baseline premium (Python service) + Open-Meteo weather rules (elevated → premium × multiplier, severe → disable) + 24h re-evaluation of disabled routes; all writes clamped to the routes-file rails and the on-chain term limits |
| `/api/cron/ttl`      | `0 0 * * *`    | `extend_ttl` on all 5 contracts + `prune_settled` in a drain loop (repeats while the active count drops) |
| `/api/cron/gov-signals` | `5 * * * *` | Airport-delay collector — ONE AeroAPI `/airports/delays` call covers the whole network; projects red→`severe` / yellow→`elevated` signals (origin+dest scoped, self-expiring) into the governance DB for the airports enabled routes touch. Facts only, no chain writes; runs 5 min before the reconciler |
| `/api/cron/gov-reconcile` | `10 * * * *` | Governance reconciler — recomputes each managed route's desired state from DB signals (admin pins win, pauses expand, multipliers stack, hysteresis damps) and submits the minimal on-chain diff; `GOV_DRY_RUN=true` logs decisions without submitting |

`/api/cron/health` is an unauthenticated GET that returns the network, contract IDs, and `hasKeys` booleans (secrets are never echoed).

### Env vars

Server-side (no `PUBLIC_` prefix — set in Vercel project settings, never bundled into the browser; see `.env.example`):

- `STELLAR_RPC_URL`, `STELLAR_NETWORK_PASSPHRASE` — default to testnet
- `ORACLE_AGGREGATOR_ID`, `CONTROLLER_ID`, `RISK_VAULT_ID`, `GOVERNANCE_ID`, `FLIGHT_POOL_MANAGER_ID` — default to `deployments/testnet.json`
- `ORACLE_SECRET_KEY`, `KEEPER_SECRET_KEY`, `TTL_EXTENDER_SECRET_KEY` — **required**, no defaults
- `AEROAPI_BASE_URL` (defaults to the real FlightAware API), `AEROAPI_KEY`
- `GOVERNANCE_ADMIN_SECRET_KEY` — 4th identity for the route agent + whitelist script; must be a `GovernanceModule` admin (owner runs `add_admin` once), never the owner key
- `AGENT_BASE_URL`, `AGENT_TOKEN` — the Python pricing service (`agent/` on Render); unset = route agent prices from the routes file
- `SALE_AUTH_HORIZON_DAYS`, `SALE_AUTH_VALIDITY_SECS` — sale-authorizer overrides (horizon defaults to the routes file's `sale_horizon_days`)
- `FETCHER_WATCH_SECS` — how long before a flight's recorded scheduled arrival the fetcher starts polling AeroAPI (default 21600 = 6h; outside the window a flight costs zero API calls)
- `ROUTES_CONFIG_PATH` — alternate routes file (tests / other networks); defaults to the bundled `config/routes.testnet.json`
- `WEATHER_BASE_URL` — Open-Meteo override (keyless; testing only)
- `CRON_SECRET` — shared secret guarding the cron endpoints (recommended)
- `GOVERNANCE_DB_URL` — Supabase transaction-pooler Postgres URL (governance DB); `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `ADMIN_EMAILS` — admin-console auth; `GOV_DRY_RUN` — keep `true` until the governance key is an on-chain admin

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
npm run whitelist:routes                 # list missing + enable/disable per file
npm run whitelist:routes -- --sync-terms # also force file terms onto active routes
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

