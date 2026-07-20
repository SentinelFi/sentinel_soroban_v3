# React + TypeScript + Vite

This template provides a minimal setup to get React working in Vite with HMR and some Oxlint rules.

Currently, two official plugins are available:

- [@vitejs/plugin-react](https://github.com/vitejs/vite-plugin-react/blob/main/packages/plugin-react) uses [Oxc](https://oxc.rs)
- [@vitejs/plugin-react-swc](https://github.com/vitejs/vite-plugin-react/blob/main/packages/plugin-react-swc) uses [SWC](https://swc.rs/)

## React Compiler

The React Compiler is not enabled on this template because of its impact on dev & build performances. To add it, see [this documentation](https://react.dev/learn/react-compiler/installation).

## Expanding the Oxlint configuration

If you are developing a production application, we recommend enabling type-aware lint rules by installing `oxlint-tsgolint` and editing `.oxlintrc.json`:

```json
{
  "$schema": "./node_modules/oxlint/configuration_schema.json",
  "plugins": ["react", "typescript", "oxc"],
  "options": {
    "typeAware": true
  },
  "rules": {
    "react/rules-of-hooks": "error",
    "react/only-export-components": ["warn", { "allowConstantExport": true }]
  }
}
```

See the [Oxlint rules documentation](https://oxc.rs/docs/guide/usage/linter/rules) for the full list of rules and categories.

## Serverless crons (Vercel)

The six executor cron jobs (`executor/centralized_cron`) are also available as Vercel serverless functions inside this app, so a single Vercel deployment serves the frontend **and** keeps the protocol running. The logic is a faithful port — same contract calls, same AeroAPI handling, same simulate → assemble (with 40% resource-fee bump) → sign → send → poll transaction pattern.

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
  cron/               routed functions
    authorize.ts  fetcher.ts  classify.ts  settle.ts  queue.ts  agent.ts  ttl.ts  health.ts
vercel.json           cron schedules
tsconfig.api.json     type-checks api/ with node types (wired into tsc -b)
```

### Schedules (vercel.json)

| Endpoint             | Schedule       | Job                                             |
| -------------------- | -------------- | ----------------------------------------------- |
| `/api/cron/authorize`| `30 */2 * * *` | Sale authorizer (cron #0) — attests sale windows for the enabled flights in `config/routes.testnet.json` over the sale horizon; closes windows / tombstones cancellations (fail closed) |
| `/api/cron/fetcher`  | `0 */2 * * *`  | AeroAPI → oracle (ETA / landed / cancelled)     |
| `/api/cron/classify` | `0 * * * *`    | `Controller.classify_flights`                   |
| `/api/cron/settle`   | `*/5 * * * *`  | `Controller.execute_settlements`                |
| `/api/cron/queue`    | `2-59/5 * * * *` | `Controller.run_queue_maintenance` (off-tempo from settle to avoid keeper sequence-number contention) |
| `/api/cron/agent`    | `0 6 * * *`    | Route agent — ML baseline premium (Python service) + Open-Meteo weather rules (elevated → premium × multiplier, severe → disable) + 24h re-evaluation of disabled routes; all writes clamped to the routes-file rails and the on-chain term limits |
| `/api/cron/ttl`      | `0 0 * * *`    | `extend_ttl` on all 5 contracts + `prune_settled` |

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
- `WEATHER_BASE_URL` — Open-Meteo override (keyless; testing only)
- `CRON_SECRET` — shared secret guarding the cron endpoints (recommended)

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

Without an `AEROAPI_KEY`, everything still runs safely: the four contract-only
jobs are fully functional, and the fetcher fails soft — API errors are logged,
each flight is recorded as `skipped: "No AeroAPI data"`, nothing bad is written
on-chain, and it retries next cycle. For a keyless demo, point
`AEROAPI_BASE_URL` at a hosted `executor/mock-api` instance instead (scripted
scenarios, no key needed).

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

To exercise the fetcher without spending AeroAPI credits, start the fixture server in `executor/mock-api` and set `AEROAPI_BASE_URL=http://localhost:3001`.

