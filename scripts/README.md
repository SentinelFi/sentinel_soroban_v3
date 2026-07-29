# Ops scripts

Operational scripts for the live testnet deployment. These import the
dapp's libraries, so run them **from `dapp/`** with its toolchain:

```sh
cd dapp && npx tsx ../scripts/<script>.ts [flags]
```

## The route-intake pipeline (manual, admin-gated — NEVER automated)

Route whitelisting is deliberately human-gated: no cron runs any of this,
there is no auto-promotion anywhere, and nothing reaches the chain until
the admin has reviewed the staged file and said go.

```
1. discover_routes  →  2. price_routes  →  [ADMIN REVIEWS + SAYS GO]  →  3. seed_routes
   (API → catalog)      (catalog → staged     config/route_whitelist.json    (staged → chain
                         ML-priced whitelist)                                  + fleet file)
```

| Step | Script | Reads | Writes |
|---|---|---|---|
| 1 | `discover_routes.ts` | real AeroAPI `/schedules` (80 directed pairs, paced) | `dapp/config/routes.discovered.json` — deduped, uncapped catalog. Filters: attestable idents only (airline-code+number), operating mainline flights, **tracked carriers only: American, Delta, United, Alaska, Southwest, JetBlue, Frontier, Spirit, Hawaiian** |
| 2 | `price_routes.ts` | the catalog + the **live ML service** (`/predict` per route: real local dep time, great-circle distance) | `dapp/config/route_whitelist.json` — every route with `p_covered`, `premium = clamp(p × $100 × 1.3, $10–$30)`, payoff $100, delay 3h, model version |
| 3 | `seed_routes.ts` | the staged whitelist (**only after admin approval**) | on-chain `whitelist_route` with the exact staged terms (audited GovSubmitter, idempotent: Active→no-op with drift report, Disabled→skipped) + mirrors seeded routes into `dapp/config/routes.testnet.json` (the operational fleet file the authorizer/jobs read) |

Flags: `--dry` (discover: sweep only), `--date YYYY-MM-DD` (discover:
sample date; price: pricing date), `--dry-run` (seed: table only, no
transactions).

Signing: `seed_routes` uses `GOVERNANCE_ADMIN_SECRET_KEY` from the
environment, falling back to the local `sentinel-governor` stellar
identity (`stellar keys show sentinel-governor`).
