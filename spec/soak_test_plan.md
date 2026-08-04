# e2e_live — Real-Stack Soak Harness (testnet contracts, everything else real)

> Status: DRAFT plan — edit freely; implementation happens in a separate session.

## Context

After the production-shaped deployment goes live (dapp + serverless API + crons on Vercel Pro via `dapp/vercel.backend.json`, paid Render FastAPI ML service, live Supabase, real FlightAware AeroAPI, real Open-Meteo weather), we want a second e2e suite — separate from the existing mock suites but following their principles — where **only the contracts (live testnet deploy, `deployments/testnet.json`) and money (mock USDC) are simulated**. 14 actors (underwriters + travelers) run the full lifecycle — **20–30 policies** — over a compressed **24–48h soak**; the deployed crons settle everything autonomously; the **frontend itself is verified by browser automation** (every button; displayed TVL/APY/stats reconciled against on-chain truth). Deliverable after ~2 days: a self-contained HTML **reconciliation report**.

## Locked decisions

- Compressed 24–48h soak; real flights landing within the window; crons do all protocol work.
- Env-gated **test-mode signer** in the dapp (inert in prod builds) so Playwright drives the real UI write paths.
- Local CLI runner in-repo; **20–30 policies** (~25–30 buys ≈ ≤60 attributable AeroAPI calls) — scaled up to make real Delayed/Cancelled outcomes likely. Candidates skew toward high-`p_covered` routes and evening/last-bank departures (delay-prone); even so, payouts are probabilistic — expected ~3–5 at avg p≈0.15, and the report stays outcome-conditional.
- **Buyer whitelist DISABLED** for this run (whitelist-gate checks auto-skip as "conditional — whitelist off").
- **Check cadence: manual + Claude sessions** — `check` is idempotent + catch-up-capable, so cadence never affects correctness; the report timeline is reconstructed from chain events + DB `cron_runs`, not poll times. A Claude Code `/loop` session is an optional hourly convenience while the Mac is awake. Actor actions are deadline-tolerant (claim expiry 7d).
- Harness NEVER runs admin-gated steps (seed/wipe/route intake) and holds no admin secrets.

## Key verified facts

- Frontend `/api/*` calls are relative fetches; `dapp/vite.config.ts:40` already proxies `"/api" → http://localhost:3000`. One env-driven change (`E2E_PROXY_TARGET`) points a local UI at the deployed backend.
- Signing chokepoint: `dapp/src/providers/WalletProvider.tsx` (module-level `signTransaction` + context). All writes (`buy_insurance`, vault ops, `claim`, faucet `+MINT`) flow through `tx.signAndSend({signTransaction})`.
- Existing harness reporter: `check()/summarize()` in `dapp/scripts/e2e/harness.ts` (reuse, wrapped with journal). DB read pattern: `getDb()` in `dapp/api/_lib/governance/db.ts` (as in `test_interventions_e2e.ts`).
- `mock_usdc` faucet/mint are permissionless; friendbot funds XLM. Vault deposits mint shares only after **6h LP_PRICING_DELAY** → COLLECT.
- Sale-auth endpoint (`/api/sale-auth/request`) is the ONLY AeroAPI toucher at buy time; staged `dapp/config/route_whitelist.json` has `dep_time_hhmm` per route → flight selection needs **zero** harness-side AeroAPI calls.
- `dapp/config/routes.live.json` currently EMPTY (board shows demo rows) → route seeding + curation is a user-run prerequisite.
- Settle latency bound: ETA + 5h (`SETTLE_AFTER_ETA_SECS`) + 2h fetcher cadence + slack.
- `/admin` is Supabase magic-link gated → skip UI automation (screenshot the gate); optional stretch: read-only `/api/admin/diagnostics` with a user-supplied JWT.
- TVL/APY sparklines + route risk bars are synthetic "illustrative" series (`dapp/src/data/derived.ts`) — assert the labeling, not values.

## Evidence model ("how do we know what happened")

Four independent, cross-checked sources:

1. **On-chain truth** (testnet RPC): contract state + events — vault balances, policies, settlements, USDC transfers per actor. Ground truth for "did the payout happen."
2. **Supabase**: `cron_runs`, `settlements`, `flight_outcomes`, `interventions`, `routes` — what the cron pipeline believed and did.
3. **Run journal** (local JSONL, written at action time): every harness action with tx hashes + expectations — the "expected" side of each assertion.
4. **Frontend evidence**: checkpoint screenshots + scraped displayed values (TVL, APY, policy status) compared to sources 1–2.

## New package: `dapp/tests/e2e_live/`

Sibling of `e2e_mock/` (resolves dapp deps/bindings; keeps the plain-tsx pattern). New devDependency: `playwright` (library API, not `@playwright/test`) — chosen because the runner is an unattended CLI needing per-actor contexts, localStorage init scripts, headless operation + screenshots.

```
dapp/tests/e2e_live/
├── cli.ts            # verbs: start | check | watch | report | smoke  (--run <id>, default latest)
├── config.ts         # loads dapp/.env.e2e_live; contract IDs default from deployments/testnet.json
├── journal.ts        # append-only JSONL (runs/<id>/journal.jsonl) + state.json run state machine;
│                     #   records: action|expectation|observation|check|screenshot
├── checks.ts         # journalCheck() → harness check() + journal append
├── actors.ts         # Keypair.random, friendbot w/ backoff + skip-if-funded, persistence to
│                     #   .actors.json (gitignored, reused across runs)
├── chain.ts          # read-only binding clients (total_assets, get_stats, get_flight_data, queues,
│                     #   balances, is_whitelisted); rpc getEvents() w/ persisted cursor; tx lookup
├── db.ts             # read-only via getDb(): cron_runs, settlements, flight_outcomes, interventions,
│                     #   flight_schedules, routes
├── flights.ts        # (route,date) candidates from route_whitelist.json ∩ routes.live.json, verified
│                     #   Active on-chain; dep in next 6–30h, est. arrival ≥8h before soak end;
│                     #   rank by p_covered desc + prefer evening/last-bank departures; needs a pool of
│                     #   ~40+ candidates to place 25-30 buys (sale-auth refusals expected)
├── browser/
│   ├── server.ts     # spawn/kill local vite (PUBLIC_E2E_SIGNER=1, E2E_PROXY_TARGET=<backend>), port 5199
│   ├── context.ts    # chromium launch; newActorContext(actor) seeds localStorage e2eSecret; snap() helper
│   └── pages/        # markets.ts (board/BetSlip/buy/stats scrape), house.ts (5 vault actions + scrapes),
│                     #   mybets.ts (rows/CLAIM/badges), misc.ts (+MINT, globe, calculator, status,
│                     #   network-mismatch banner, /admin gate render)
├── scenarios/
│   ├── preflight.ts  # deployed health: /api/cron/health, Render /healthz, Supabase select+cron_runs
│   │                 #   recency, RPC getHealth, routes seeded/Active, whitelist_enabled read
│   ├── setup_actors.ts  # fund + per-actor UI +MINT
│   ├── underwrite.ts    # UI deposits incl. cancel paths
│   ├── buy.ts           # UI purchases incl. negatives
│   └── poll.ts          # `check` body: observe transitions + execute due actions
├── report/
│   ├── reconcile.ts  # assertions matrix (below)
│   └── html.ts       # self-contained HTML, template literals, base64 screenshots, no deps
└── runs/             # gitignored: runs/<id>/{journal.jsonl,state.json,shots/,report.html}
```

npm scripts (`dapp/package.json`): `e2e:live`, `e2e:live:start|check|watch|report|smoke`, `e2e:live:ui` (manual debug server). `.gitignore` adds: `tests/e2e_live/runs/`, `tests/e2e_live/.actors.json`, `.env.e2e_live`.

## dapp changes (all inert in prod)

1. **`dapp/src/util/e2eSigner.ts`** (new): returns null unless `import.meta.env.PUBLIC_E2E_SIGNER === "1"` (statically false on Vercel → dead-code-eliminated) AND `localStorage.e2eSecret` present AND passphrase is testnet. Signs via stellar-sdk `Keypair`/`TransactionBuilder` (already bundled), returning the wallets-kit `{signedTxXdr, signerAddress}` shape.
2. **`dapp/src/providers/WalletProvider.tsx`**: if `getE2eSigner()` non-null → skip kit polling; provide address/signTransaction/network from the e2e signer (passphrase from localStorage so the mismatch banner can be deliberately triggered). All downstream code paths (useContractSync, signAndSend sites, hooks) unchanged.
3. **`dapp/vite.config.ts`**: `"/api": process.env.E2E_PROXY_TARGET || "http://localhost:3000"`.
4. **`data-testid`s** (inert markup) on: TopBar balance chip + MINT; Markets stats strip + BetSlip inputs/CTA/error; House TVL/free/locked, inputs, 5 action buttons, queue rows; MyBets rows/badges/claim; Status rows; mismatch banner.

Prod-inertness verification: `vite build` without the flag → grep dist for the gated branch.

## Actors (14) & capital sizing

25–30 concurrent policies lock up to 3,000 USDC of vault capital (payoff 100 each), so investor deposits total ~12,000 USDC — comfortable headroom for buys while still letting withdrawal requests compete with locked capital.

| Actor | Role / scenario |
|---|---|
| U1 | Anchor underwriter: mint 2× (20k), deposit 6,000, **hold entire soak** → the clean share-price/APY growth observation |
| U2 | Deposit 3,000 → mid-soak partial `request_withdrawal` (while many policies still active → exercises withdrawal queue against locked capital) → collect after settlements free capital |
| U3 | `request_deposit` 1,000 → **cancel_deposit** (exact refund) → re-deposit 1,000 |
| U4 | Deposit 1,000 → `request_withdrawal` → **cancel_withdrawal** → re-request → collect |
| U5 | Deposit 800 → **full withdrawal** request late in soak (after payouts) → collect; asserts exit value = shares × final share price (captures net premium gain) |
| U6 | Deposit 500 → withdrawal requested in the SAME check as U2/U5 → asserts **queue ordering** (FIFO processing across concurrent requests) and per-request accounting |
| T1–T2 | 4 policies each, spread across days/routes |
| T3–T6 | 3 policies each, distinct routes/dep-times, skewed to high-`p_covered`/evening flights |
| T7 (hybrid) | Deposits 500 in vault AND buys 2 policies (LP-who-also-buys) |
| N1 | Negatives: buy with 0 USDC (failure surfaced in UI); sale-auth refusal (date inside 3600s min-lead); claim on an on-time flight. (Whitelist-block negative auto-skipped — whitelist off.) |

Policy total: 25–27 (+ retries on sale-auth refusals, capped at 30 buys). Funding: friendbot with spacing/backoff, skip already-funded. Minting via the real UI +MINT button (doubles as button coverage; faucet is 10k/click — U1 clicks twice).

## Verbs

- **`start`**: preflight → actors setup → underwriter deposits via UI (incl. U3/U4 cancels) → UI pass 1 + screenshots. Buys happen in `start` only if `get_free_capital` already covers 100×policies; otherwise journaled as pending (6h LP delay) and picked up by `check`.
- **`check`** (idempotent, catch-up-capable, safe to spam — run manually or from a Claude `/loop` session): read chain events since cursor + oracle states + queues + balances + `get_stats`; read DB deltas (`cron_runs`, `settlements`, `flight_outcomes`, `interventions`); journal transitions; execute **due actions** via UI (buys once capital ready — candidates re-selected relative to now; COLLECT once claimable; CLAIM once settled Won; N1 negative claim once its flight settles OnTime); screenshots per action; print status table.
- **`watch`**: optional loop of check every N min (default 20).
- **`report`**: reconcile all evidence → `runs/<id>/report.html`; exit code from `summarize()`.
- **`smoke`**: read-only Playwright pass against the REAL deployed frontend URL (no signer): every route loads, board render (demo vs live detected), stats strip vs deployed `/api/status/stats`, globe paints, /admin gate renders, zero uncaught console errors.

**User-facing driver**: the project slash command `.claude/commands/soak.md` wraps these — `/soak` (check + plain-English summary), `/soak report` (generate + open the HTML report), `/soak loop` (hourly babysit via `/loop`). The command refuses to run until the harness exists and never touches admin-gated steps.

## Assertions matrix (reconcile.ts)

Live deployment may have external traffic → aggregate assertions use our-attributable deltas (events filtered to actor addresses/flight keys) + an informational "unexplained external delta" line (flagged, not failed).

- **A. Money (exact, 7-dec)**: per-actor final USDC balance == Σmints − Σpremiums − Σdeposits + Σcancel-refunds + Σcollected-withdrawals + Σclaims; claim payout == exactly 100; cancel paths refund exactly.
- **B. Vault**: `total_assets` delta == our deposits − withdrawals + premium share − payouts ± flagged external; shares mint only ≥6h after request at snapshot price.
- **B2. Withdrawal queue**: concurrent requests (U2/U5/U6 same check) processed in queue order with correct per-request share accounting; requests submitted while capital is locked by active policies do not over-release (free capital never goes negative; queue drains as settlements unlock capital); cancel_withdrawal removes exactly one queue entry.
- **B3. APY / share-price growth**: with 25+ premiums flowing in, `get_snapshot_price` series must be non-decreasing except at payout events; final share price > initial iff Σpremiums > Σpayouts (evaluated against actuals); U1's held position value delta == share-price delta × shares (exact); U5's exit proceeds > deposit iff net-positive vault (outcome-conditional); report computes **realized APY** from the real snapshot series over the soak window and shows it alongside the UI's illustrative sparkline (labeling check only on the latter).
- **C. Stats**: `controller.get_stats` deltas vs journal buys; `/api/status/stats` == chain at same instant; DB `settlements` consistent.
- **D. Lifecycle (outcome-conditional)**: sale-auth authorized precedes each buy; refusals only on designed negatives; oracle transitions monotonic (registered → ETA → Landed/Cancelled → classified → settled); **IF actual arrival ≥3h late OR cancelled THEN payable + CLAIM succeeds ELSE no payout + negative claim fails**; settlement within ETA+5h+2h+30min; `flight_outcomes`+`settlements` rows match chain.
- **E. Crons/pipeline**: every `vercel.backend.json` job fired within 2× cadence for the whole window (`cron_runs`); `pendingOutcomes` (cron/health) returns to 0 within 15min; no unexpected `interventions` on our routes (if one occurs: conditional check that board shows route non-buyable).
- **F. UI truth**: House TVL == `total_assets` (2-dp rounding); stats strip == API == chain; balance chip == chain balance; MyBets rows/badges == chain policy state; sparklines/risk bars carry "illustrative" labels; network-mismatch banner appears for a wrong-passphrase context.
- **Coverage table**: every named button checkpoint (board search/sort/pagination, BetSlip open/close/buy/error, 5 House actions, CLAIM, +MINT, globe, calculator run, status page, banner, /admin gate).

## Report (`runs/<id>/report.html`)

Single self-contained HTML, no external deps, screenshots inlined base64 (downscaled): run summary + config fingerprint → preflight → per-actor ledgers (expected vs actual, mismatches highlighted) → per-flight timelines (chain events + cron_runs + journal merged; which conditional branch applied) → cron health grid (job × hour) → mismatch table (fail / external-info / skipped-conditional) → button-coverage table → screenshot gallery → raw journal appendix.

## Prerequisites (user-run, before `start`)

1. Vercel Pro backend project live with crons + `CRON_SECRET` + signer secrets (`/api/cron/health` confirms).
2. Render `flight-delay-predictions` live (`/healthz` 200); `AGENT_BASE_URL`/`AGENT_TOKEN` set in Vercel.
3. Routes seeded (`scripts/seed_routes.ts` — admin-gated, user runs) + **`routes.live.json` curated non-empty**. For 25–30 buys the seeded set must yield ~40+ viable (route, date) candidates inside the soak window — roughly **12–15 routes with daily departures** (staged `route_whitelist.json` already holds a large priced set to choose from).
4. `dapp/.env.e2e_live`: `DEPLOYED_APP_URL`, `DEPLOYED_BACKEND_URL`, `RENDER_HEALTH_URL`, `GOVERNANCE_DB_URL`, optional `ADMIN_JWT`, knobs (`E2E_MAX_POLICIES`, `E2E_HEADFUL`). No admin secrets.
5. `npm i` + `npx playwright install chromium`.
6. Working branch (not main; user merges).

## Implementation order

1. Scaffolding: config/journal/checks/cli skeleton, npm scripts, gitignore.
2. Read-only spine: chain.ts, db.ts, preflight, `smoke` — runnable immediately, validates env early.
3. dapp changes: e2eSigner, WalletProvider branch, vite proxy env, data-testids + prod-inertness check.
4. Browser layer: server/context/page drivers; actors; setup/underwrite/buy scenarios.
5. Poll engine: due-action machine, `check`/`watch`.
6. Reconcile + report.

## Verification (cheap, before the real 2-day soak)

- **Tier 0 (free)**: `smoke` + `preflight` + `check` on an empty run — plumbing only, zero writes.
- **Tier 1 (local stack, no AeroAPI)**: local `dev:api` + `tools/mock-aeroapi`; harness proxy → localhost:3000. Scope: vault lifecycle (tiny amounts, reversible on live contracts), N1 negatives, all scraping/journal/report. **No synthetic-flight buys against live contracts** (prod fetcher can't resolve fake idents → would wedge the settlement barrier).
- **Tier 2 (canary, ~2 AeroAPI calls)**: one real buy (T1) on a same-day flight through the deployed stack; confirm crons settle it end-to-end and the report renders its timeline. Then launch the full 10-actor soak.
