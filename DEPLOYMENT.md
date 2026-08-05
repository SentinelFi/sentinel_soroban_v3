# Deployment

How to deploy Sentinel end to end. The frontend and all ten cron jobs ship as **one Vercel project** rooted at `dapp/`; the ML prediction service runs on Render; the governance database is Supabase; the contracts live on Stellar testnet.

## Surfaces

| Surface | Source | Host | Status |
|---------|--------|------|--------|
| Smart contracts (×6) | `contracts/` | Stellar testnet | Live — addresses in [`deployments/testnet.json`](deployments/testnet.json) |
| Frontend + `/admin` + crons (×10) | `dapp/` | Vercel | This guide |
| ML prediction service | `agent/` | Render | Service `flight-delay-predictions` (see render.yaml) |
| Governance DB | `supabase/` | Supabase | Live — project `murcgnleczppbooifkya` |

The contracts, agent, and database are already deployed. The remaining work is the **Vercel** deploy plus the one-time on-chain wiring at the end.

## Prerequisites

- The four signing keypairs, each a funded testnet account: **oracle**, **keeper**, **TTL extender**, **governance admin**. The governance admin must be (or become) a `GovernanceModule` admin — see [step 4](#4-one-time-on-chain-setup).
- A **FlightAware AeroAPI** key (optional — without it the fetcher, the buy-click sale-auth endpoint, and the route guard fail soft, so no sales open; the contract-only jobs still run).
- The **Supabase** transaction-pooler connection string and an admin email allowlist.
- A **Vercel** account. The 5-minute crons require **Vercel Pro** (see [plan caveat](#plan-caveat)).

## 1. Import the project

In Vercel: **New Project → import the repo → set Root Directory to `dapp/`**. Framework preset auto-detects as Vite. Leave the build command default (`npm run build`); the output directory is `dist`.

## 2. Environment variables

Set these in **Vercel → Project → Settings → Environment Variables**. Full annotated list with defaults is in [`dapp/.env.example`](dapp/.env.example).

**Public (bundled into the browser — no secrets):**

```
PUBLIC_STELLAR_NETWORK=TESTNET
PUBLIC_STELLAR_NETWORK_PASSPHRASE=Test SDF Network ; September 2015
PUBLIC_STELLAR_RPC_URL=https://soroban-testnet.stellar.org
PUBLIC_STELLAR_HORIZON_URL=https://horizon-testnet.stellar.org
PUBLIC_SUPABASE_URL=https://murcgnleczppbooifkya.supabase.co
PUBLIC_SUPABASE_ANON_KEY=sb_publishable_...        # anon key (RLS deny-all; reads nothing)
```

**Server-side (never shipped to the browser):**

```
# Contract IDs default to deployments/testnet.json if omitted, but set them explicitly.
ORACLE_AGGREGATOR_ID=CDMKBMNJ2YZTARAM4ZUU7HZJZA7UUYJU76ZOAN2SCR3WJYZSSHXV7ESW
CONTROLLER_ID=CBDJIPZOC7KH3ICK57MAUZMUXBQ5XF56WJLRP2OY6FF5V2HOFDOFXVY3
RISK_VAULT_ID=CCJLBWEOPNUHIUNOGZMUDQ6EGO563SA3WSEX2NENEDCTJDZOKN3LLDKF
GOVERNANCE_ID=CATUCJILWACDDEAIFXRL6HXSYDZ7TLOXHMUBKBG4URDOUJHEO7QAJ6NE
FLIGHT_POOL_MANAGER_ID=CAA7DVZKQEA7JENAMI7DEKPGAWJQMPY6MKDED2DG2ZCK2G535X5V2PI7

# Signing keys — REQUIRED, no defaults.
ORACLE_SECRET_KEY=S...
KEEPER_SECRET_KEY=S...
TTL_EXTENDER_SECRET_KEY=S...
GOVERNANCE_ADMIN_SECRET_KEY=S...        # a GovernanceModule admin, never the owner key

# AeroAPI (optional; without a key, flight jobs fail soft)
AEROAPI_BASE_URL=https://aeroapi.flightaware.com/aeroapi
AEROAPI_KEY=...

# Cron auth — shared bearer secret; strongly recommended.
CRON_SECRET=<random-string>

# ML prediction service (Render service "flight-delay-predictions").
AGENT_BASE_URL=https://flight-delay-predictions.onrender.com
AGENT_TOKEN=<must match the Render service's AGENT_TOKEN, if it sets one>

# Governance DB — Supabase TRANSACTION pooler (port 6543), not the direct host.
GOVERNANCE_DB_URL=postgresql://postgres.murcgnleczppbooifkya:<password>@aws-0-us-east-1.pooler.supabase.com:6543/postgres

# Admin console auth
SUPABASE_URL=https://murcgnleczppbooifkya.supabase.co
SUPABASE_ANON_KEY=sb_publishable_...
ADMIN_EMAILS=you@example.com,ops@example.com

# Governance safety — keep true until add_admin lands (step 4).
GOV_DRY_RUN=true
```

Notes:
- `AGENT_BASE_URL` is the bare Render origin; the cron appends `/price`. Leave it unset to price routes from the routes file only.
- `AGENT_TOKEN` is only needed if the Render service enforces one; it must match on both sides.
- Use the Supabase **transaction pooler** (`...pooler.supabase.com:6543`) — serverless functions exhaust direct Postgres connections, and the direct host is IPv6-only.

## 3. Deploy

Click **Deploy**. Vercel builds the Vite frontend and registers the functions in `dapp/api/`; the crons in [`dapp/vercel.json`](dapp/vercel.json) start on their schedules automatically. Confirm the deploy is healthy:

```sh
curl https://<your-app>.vercel.app/api/cron/health      # network, contract IDs, hasKeys booleans
curl -i https://<your-app>.vercel.app/api/status/alert  # 200 healthy / 503 + problem list
```

Then open `https://<your-app>.vercel.app/status` — the public cron-run health page — and `https://<your-app>.vercel.app/admin` (sign in with a Supabase Auth account whose email is in `ADMIN_EMAILS`).

Magic-link sign-in needs the Supabase project's **Authentication → URL Configuration** to point at the deployed app: set **Site URL** to your production URL and add it to **Redirect URLs**. If the allow-list does not match, Supabase silently falls back to Site URL — the classic symptom is an access link that opens `localhost`.

Point an uptime monitor (UptimeRobot, cron-job.org — free tiers are fine) at `/api/status/alert` and alert on any non-200. It catches failed runs, stale jobs, and jobs that crashed on import and therefore never recorded a run at all.

## 4. One-time on-chain setup

Done once, from a machine with the [Stellar CLI](https://developers.stellar.org/docs/tools/cli) and the **owner** key:

1. **Delegate the governance admin** — the owner authorizes the governance-admin address so the governance jobs and the intake scripts can write:
   ```sh
   stellar contract invoke --id $GOVERNANCE_ID --source owner --network testnet \
     -- add_admin --admin <GOVERNANCE_ADMIN_PUBLIC_KEY>
   ```
2. **Seed routes** — the manual intake pipeline, run from `dapp/`. Never scheduled; each step is a deliberate human action:
   ```sh
   npx tsx ../scripts/discover_routes.ts   # candidates -> config/routes.discovered.json
   npx tsx ../scripts/price_routes.ts      # ML pricing -> staged config/route_whitelist.json
   git diff dapp/config/route_whitelist.json   # REVIEW — the human gate
   npx tsx ../scripts/seed_routes.ts       # whitelist_route per missing route (idempotent)
   npx tsx ../scripts/seed_routes.ts --apply-terms   # also push terms onto live routes
   ```
   This needs `GOVERNANCE_ADMIN_SECRET_KEY` in the local env, or a local Stellar identity named `sentinel-governor`. Seeding is one transaction per route, so a large catalog takes hours — size it deliberately.
3. **Flip governance live** — set `GOV_DRY_RUN=false` in Vercel and **redeploy** (env values bind at deploy time, so editing the variable alone changes nothing). Until then every detector computes and logs without submitting.

After this the pipeline is self-driving: sales authorize on each buy click, and the governance jobs pause and revive routes on their own.

## Plan caveat

The 5-minute crons (`settle`, `queue`) and `maxDuration: 300` require **Vercel Pro** (the live deployment runs on Pro). On the **Hobby** plan, cron granularity is daily-only and function durations are shorter — reduce or remove those entries in `vercel.json` and drive the endpoints with an external pinger (GitHub Actions schedule, cron-job.org, UptimeRobot) that curls each one with the `Authorization: Bearer $CRON_SECRET` header.

## Cron auth

- With `CRON_SECRET` set, every cron request must carry `Authorization: Bearer $CRON_SECRET`. Vercel's scheduler sends it automatically for scheduled runs.
- With `CRON_SECRET` unset, only requests carrying Vercel's `x-vercel-cron` header (set on scheduled invocations, stripped from external traffic) are accepted.
- Anything else gets `401`.

## Redeploying contracts

Only if the contracts change. Redeploy from `contracts/` following [`contracts/deploy_order.md`](contracts/deploy_order.md), update [`deployments/testnet.json`](deployments/testnet.json), regenerate bindings (`dapp/rebuild-bindings.sh`), update the contract IDs in `dapp/src/contracts/*.ts` and the Vercel env, and redeploy. See the [dapp README](dapp/README.md#serverless-crons-vercel) for the serverless details.
