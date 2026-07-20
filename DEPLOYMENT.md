# Deployment

How to deploy Sentinel end to end. The frontend and all eight cron jobs ship as **one Vercel project** rooted at `dapp/`; the ML pricing service runs on Render; the governance database is Supabase; the contracts live on Stellar testnet.

## Surfaces

| Surface | Source | Host | Status |
|---------|--------|------|--------|
| Smart contracts (×6) | `contracts/` | Stellar testnet | Live — addresses in [`deployments/testnet.json`](deployments/testnet.json) |
| Frontend + `/admin` + crons (×8) | `dapp/` | Vercel | This guide |
| ML pricing service | `agent/` | Render | Live — https://sentinel-agent-f7u4.onrender.com |
| Governance DB | `supabase/` | Supabase | Live — project `murcgnleczppbooifkya` |

The contracts, agent, and database are already deployed. The remaining work is the **Vercel** deploy plus the one-time on-chain wiring at the end.

## Prerequisites

- The four signing keypairs, each a funded testnet account: **oracle**, **keeper**, **TTL extender**, **governance admin**. The governance admin must be (or become) a `GovernanceModule` admin — see [step 4](#4-one-time-on-chain-setup).
- A **FlightAware AeroAPI** key (optional — without it the fetcher and sale authorizer fail soft and no sales open; the four contract-only jobs still run).
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
ORACLE_AGGREGATOR_ID=CBSX3KRT4JI7XAOB33OTGZMZVOFXOS2LWDQCQKR2UAGHRMWYMC2D6QUL
CONTROLLER_ID=CCWDQVAJCNMU2P35JF5RNGC7PM2LGWBXBSO6QUME2PJFK5LTVFNQZGHB
RISK_VAULT_ID=CAHUWF7GMAKZK34C3BBQWHA4GLAI2OSXGL25KMLW45INBDJMVQRAL3QW
GOVERNANCE_ID=CANSHOFUFZPLZPCVUQYL3LBO25FW5BP6AEVAMNN2QS2BINGDIVZVEWYZ
FLIGHT_POOL_MANAGER_ID=CD6XRCMKALQLB63ZYMA7GCW3Q2BQROGKYASRRRNZEFRPINQ6JFXO6YZT

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

# ML pricing service — already deployed on Render.
AGENT_BASE_URL=https://sentinel-agent-f7u4.onrender.com
AGENT_TOKEN=<must match the Render service's AGENT_TOKEN, if it sets one>

# Governance DB — Supabase TRANSACTION pooler (port 6543), not the direct host.
GOVERNANCE_DB_URL=postgresql://postgres.murcgnleczppbooifkya:<password>@aws-0-us-east-1.pooler.supabase.com:6543/postgres

# Admin console auth
SUPABASE_URL=https://murcgnleczppbooifkya.supabase.co
SUPABASE_ANON_KEY=sb_publishable_...
ADMIN_EMAILS=you@example.com,ops@example.com

# Reconciler safety — keep true until add_admin lands (step 4).
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
```

Then open `https://<your-app>.vercel.app/status` — the public cron-run health page — and `https://<your-app>.vercel.app/admin` (sign in with a Supabase Auth account whose email is in `ADMIN_EMAILS`).

## 4. One-time on-chain setup

Done once, from a machine with the [Stellar CLI](https://developers.stellar.org/docs/tools/cli) and the **owner** key:

1. **Delegate the governance admin** — the owner authorizes the governance-admin address so the route agent, reconciler, and whitelist script can write:
   ```sh
   stellar contract invoke --id $GOVERNANCE_ID --source owner --network testnet \
     -- add_admin --admin <GOVERNANCE_ADMIN_PUBLIC_KEY>
   ```
2. **Whitelist routes** — fill [`dapp/config/routes.testnet.json`](dapp/config/routes.testnet.json) (the single human source of truth: route list, term overrides, rails, `enabled` flags), then from `dapp/`:
   ```sh
   npm run whitelist:routes                  # list missing routes + enable/disable per file
   npm run whitelist:routes -- --sync-terms  # also push file terms onto active routes
   ```
   This needs `GOVERNANCE_ADMIN_SECRET_KEY` in the local env.
3. **Flip the reconciler live** — set `GOV_DRY_RUN=false` in Vercel and redeploy (or redeploy after editing the env). Until then the reconciler computes and logs decisions without submitting.

After this, sales open on the next sale-authorizer run and the pipeline is self-driving.

## Plan caveat

The 5-minute crons (`settle`, `queue`) and `maxDuration: 300` require **Vercel Pro**. On the **Hobby** plan, cron granularity is daily-only and function durations are shorter — reduce or remove those entries in `vercel.json` and drive the endpoints with an external pinger (GitHub Actions schedule, cron-job.org, UptimeRobot) that curls each one with the `Authorization: Bearer $CRON_SECRET` header.

## Cron auth

- With `CRON_SECRET` set, every cron request must carry `Authorization: Bearer $CRON_SECRET`. Vercel's scheduler sends it automatically for scheduled runs.
- With `CRON_SECRET` unset, only requests carrying Vercel's `x-vercel-cron` header (set on scheduled invocations, stripped from external traffic) are accepted.
- Anything else gets `401`.

## Redeploying contracts

Only if the contracts change. Redeploy from `contracts/` following [`contracts/deploy_order.md`](contracts/deploy_order.md), update [`deployments/testnet.json`](deployments/testnet.json), regenerate bindings (`dapp/rebuild-bindings.sh`), update the contract IDs in `dapp/src/contracts/*.ts` and the Vercel env, and redeploy. See the [dapp README](dapp/README.md#serverless-crons-vercel) for the serverless details.
