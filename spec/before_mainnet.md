# Before mainnet — accumulated fix list

Everything known to need fixing, deciding, or upgrading before the tenure-gated
mainnet launch (see `spec/TODO.md` launch plan). Grouped by the kind of work;
items marked **[contract]** belong to one coherent contract-upgrade + re-audit
bundle so the chain is touched once.

## Contract upgrade bundle (one upgrade, re-audit together)

- [ ] **[contract] Insure both legs of out-and-back flight numbers.** The whole
  settlement path is keyed by `(flight_id, date)`: GovernanceModule maps each
  flight ID to exactly ONE route (`FlightIdAlreadyMapped` #505), and the oracle
  stores one outcome per flight per day. Airlines reuse the same number for the
  return leg (e.g. `DAL860` BOS→SFO morning / SFO→BOS evening, same date), so
  ~10% of the priced catalog (121 of 1,190 routes in the 2026-08-04 seed) is
  forfeited to duplicates. Fix is a coherent stack change: composite route key
  `(flight_id, origin, dest)` in GovernanceModule + leg-disambiguated outcome
  storage in OracleAggregator + AeroAPI client ambiguity guard selecting the
  leg by origin/dest (the client already validates legs — tractable).
- [ ] **[contract] Batch `whitelist_routes(vec)` entrypoint.** Seeding is one
  tx per route (Stellar: one tx per source account per ~5s ledger). The
  2026-08-04 testnet seed of ~1,190 routes took ~3h and would cost real XLM on
  mainnet. One tx per ~25–50 routes turns seeding into minutes and cuts fees
  proportionally.
- [ ] **[contract] Swap `mock_usdc` for the real USDC SAC** as the asset token
  (Controller `asset_token`, vault, pool manager). Includes trustline/funding
  strategy for actors and treasury.
- [ ] **[contract] Set real launch parameters at deploy** — three ship
  disabled/dust today: `min_withdrawal_request` is 10 stroops (queue-squat
  defense off; `deploy_order.md` says e.g. `100_0000000`), `max_payoff` is 0
  (no blast-radius cap on a compromised gov-admin key — the key that lives in
  Vercel env), and `set_solvency_ratio` is never called anywhere (defaults to
  100 = zero reserve buffer).
- [ ] **[contract] Genesis seed deposit (~25k) before public LP entry** — while
  TMA≈0 every request floor degenerates to the one-token minimum and pinning
  both bounded queues costs ~50–75 tokens of refundable escrow
  (`deploy_order.md` bootstrap caveats).
- [ ] **Owner custody decision: multisig or explicit accepted risk.** One key
  (currently shared across all five contracts) gates instant `upgrade()`; the
  audits defer multisig "to the runbook" — decide it at deploy time.
- [ ] USDC SAC swap add-ons: re-check the 7-decimal assumption behind
  `MIN_REQUEST_FLOOR_CAP_ABS` (a 6-dec asset shifts the floor 10×), and note
  the swap is also a frontend rename (`mock_usdc` naming is load-bearing in
  dapp code).
- [ ] Expose `LP_PRICING_DELAY_SECS` via a getter — `House.tsx` hand-mirrors
  the 6h constant; if it's ever tuned, every countdown silently lies.
- [ ] Reconfirm `MAX_CLASSIFY/SETTLE/QUEUE_BATCH` maxima with resource-enforced
  tests (deferred in the 2026-06-25 remediation as "before mainnet").
- [ ] Complete the archival-semantics testnet experiment (CF5-M01 ops backlog):
  the `evict_missing_flight` → `settle_evicted_flight` recovery path may be
  unreachable as written — realign code/tests/runbooks before mainnet.
- [ ] Re-affirm the accepted economic residuals at real-money scale (oracle
  outage past the 6h delay, pre-landing delay foreknowledge, void-path income,
  14-day-void-as-on-time) — or retune `LP_PRICING_DELAY_SECS`.
- [ ] Re-audit the bundle (5 prior audit rounds are on the current code; the
  upgrade invalidates that coverage for changed modules).

## Mainnet cutover (config must fail closed)

- [ ] **Fail-closed network config.** `dapp/api/_lib/config.ts` and
  `governance/config.ts` silently default RPC, passphrase, and all five
  contract IDs to testnet when env vars are missing — a typo'd Vercel var
  means crons sign against testnet while `/api/status/alert` reports healthy.
  Frontend `contracts/ids.ts` and `scripts/seed_routes.ts`/`wipe_routes.ts`
  do the same. Make network vars required, assert the passphrase matches the
  intended network, and add a build-time assertion that
  `PUBLIC_STELLAR_NETWORK=PUBLIC` implies all `PUBLIC_*_ID` set (also keeps
  the +MINT faucet gate consistent — it keys on a different var than signing).
- [ ] **CSP `connect-src` is testnet-pinned** (`dapp/vercel.json`): a mainnet
  build cannot reach RPC/Horizon at all. Update origins at cutover; validate a
  full enforcing CSP on a preview deploy (deferred from the 2026-07-30
  frontend remediation). Drop the testnet preconnects in `index.html`.
- [ ] **Mainnet route-catalog mechanism.** `routes.testnet.json` is statically
  bundled in the frontend board fallback, `/api/routes`, sale-auth fallback,
  and the weather/reprice jobs; `ROUTES_CONFIG_PATH` (runtime readFileSync) is
  not reliably bundled on Vercel. Decide: network-scoped file + build switch,
  or make the DB canonical.
- [ ] **Mainnet deployment runbook + manifest**: `deployments/mainnet.json`,
  env matrix (the `PUBLIC_*_ID` vars are currently undocumented anywhere),
  Makefile network target, post-deploy verification calls (`get_keeper`,
  `get_controller`, …). `DEPLOYMENT.md` is entirely testnet today.
- [ ] **Reproducible-build check**: recompute wasm hashes and compare against
  the deployment manifest so mainnet bytecode is verifiable against audited
  source; wire into CI.

## Off-chain tooling

- [ ] **Deliberate duplicate-leg dedupe in `price_routes.ts`.** Today
  first-occurrence-wins decides which leg of a duplicate flight number gets
  seeded — arbitrary, and in ~a dozen cases it picked the cheaper leg (e.g.
  `AAL2086` seeded BOS→PHL $10, dropped ORD→LGA $20). Rule: keep the
  higher-premium leg, tie-break earlier departure; write losers to an
  `excluded_duplicate_leg` section so the staged file matches what can land
  on-chain and idempotent re-seeds stop re-failing 121 zombie entries.
  (Superseded on-chain by the composite-key fix, but cheap and useful now.)
- [ ] Optional: sharded seeding across 2–3 extra governance admins
  (owner `add_admin`) for faster re-seeds until the batch entrypoint lands.
- [ ] **Time-budget + chunk `gov_onboard` and `ttl_extender`.** Both walk the
  full fleet sequentially with no budget and get hard-killed at 300s; worse, a
  partial onboard sync leaves the DB-canonical `routes` table incomplete →
  unreached routes refuse sales despite being live on-chain.
- [ ] **Serialize the oracle signing key.** Public sale-auth and the settle
  cron share the oracle key with no sequence coordination (single txBadSeq
  retry) — concurrent buys fail exactly at peak traffic. DB-backed lease/queue
  for oracle writes; consider a general cron-overlap lock while at it.
- [ ] **Global sale-auth spend cap.** Throttling is per-IP only; each novel
  (flight, date) costs a billed AeroAPI call + an oracle-signed tx. Add a
  global per-minute/day budget and per-flight cap; make the rate limiter fail
  closed and move its hot-path DDL into `supabase/migrations/`.
- [ ] **Settlement visibility.** The settler reports success with outcomes
  still pending (only the barrier-age flag fires) and targeted settlement
  swallows all failures into console.warn — surface both in
  `/api/status/alert`.
- [ ] **Governance DB hygiene**: move app-created tables (`interventions`,
  `gov_disable_slots`, `api_rate_limits`, `flight_schedules`,
  `flight_outcomes`) into `supabase/migrations/` (a restore or fresh project
  won't have them); delete the dead aeroapi_cache/warm_windows migrations;
  decide retention for the append-only tables; fix `policies` event-ingest
  joining routes on `flight_id` alone (same duplicate-number bug as the
  composite-key contract item).

## Services & costs (commercial posture)

- [ ] **Open-Meteo commercial license** (~€29/mo) — current keyless free tier
  is non-commercial only; mainnet with real premiums is commercial use.
- [ ] **Supabase Pro** (~$25/mo) — daily backups + no free-tier pause risk for
  the governance DB that drives live interventions.
- [ ] AeroAPI plan review at projected policy volume (cost scales ~½–1¢ per
  buy + one call per settle; fine at launch volume, revisit tiers with growth).
- [ ] Render ML service: Starter ($7/mo) is fine; add a real `/healthz` route
  (service 404s there today — probes currently use `/docs`).
- [ ] **Mainnet RPC + Horizon provider decision** (rate limits / cost): ~20
  polling queries per open tab hit `PUBLIC_STELLAR_RPC_URL`; the Horizon host
  is hardcoded per network in `util/wallet.ts` (ignores
  `PUBLIC_STELLAR_HORIZON_URL`) — fix so a paid provider is configurable.
- [ ] **Render auth fail-closed**: `/predict` is world-open when `AGENT_TOKEN`
  is unset and Render doesn't auto-provision it (`sync: false`). Fail closed in
  prod; surface reprice-run failures in the status alert (today a wrong token
  silently degrades repricing to file premiums); verify
  `route_whitelist.json` actually ships in the repricer's function bundle
  (readFileSync + swallow-to-empty today).
- [ ] **Name + domain** (launch blocker per launch plan): waitlist on apex,
  dapp at `app.<domain>`, game separate. Wire custom domain to the
  `sentinel-dapp` Vercel project.

## Keys, funding & ops

- [ ] **Mainnet XLM funding** for oracle / keeper / governor accounts — no
  friendbot on mainnet. Decide float per account + a low-balance alert (crons
  die silently when the signer can't pay fees).
- [ ] **Wire an external uptime monitor to `/api/status/alert`** *(endpoint
  shipped 2026-08-04)*: returns 200 healthy / 503 with a problem list on any
  failed last run, job stale past 2× cadence, never-recorded job while the
  system is alive (catches import-crash-class deaths the run recorder never
  sees — the 2026-08-04 four-crons-dark incident), or a stalled settlement
  barrier. UptimeRobot / cron-job.org free tier polling every 5min + email
  alert on non-200 is sufficient; do this BEFORE the soak if possible, it is
  free and takes 5 minutes.
- [ ] **Fresh mainnet keypairs** for all roles (testnet secrets have lived in
  local keychain + Vercel env; mint new ones for mainnet, owner key kept
  offline/local-only as today).
- [ ] State TTL rent is real money on mainnet — sanity-check `ttl` cron
  cadence + per-entry rent cost at 1k+ routes before seeding the full catalog.
- [ ] **Buyer whitelist ON at launch** (tenure-gated mainnet per launch plan;
  testnet runs whitelist-off). Decide the tenure criteria + credits mechanics
  (credits are mainnet-only).
- [ ] **Disable public Supabase sign-ups** (dashboard → Authentication →
  Sign In / Up → disable new user sign-ups): today anyone can create a
  session (authorization still 403s non-allowlisted emails on every admin
  API + deny-all RLS, so nothing is exposed) — but closing the outer door
  stops stranger identities accumulating in the auth table. Also expand
  ADMIN_EMAILS (currently a single address) to distinct per-admin emails
  so actions_log attribution stays meaningful with more operators.
- [ ] Seed a *curated* mainnet route set (small, high-liquidity pairs), not the
  full 1k+ catalog — seeding cost, TTL rent, and exposure all scale with it.
- [ ] **Filter low-`days_seen` routes from the mainnet seed.** Airlines reassign
  flight numbers at schedule changes — e.g. `AAL1193` flew DFW→ORD (our seeded
  route, `days_seen: 1`) through 2026-08-03, then American reused the number
  for ORD→CID from 2026-08-05. Stale entries are harmless (sale-auth re-verifies
  the real flight at buy time and refuses) but waste whitelist slots and TTL
  rent. Curate on high `days_seen` and consider a periodic staleness sweep
  (re-check seeded idents against AeroAPI schedules; pause/retire reassigned
  ones).

## Incident response (no runbook exists in the repo today)

- [ ] **One-page incident runbook + `pause_all`/`unpause_all` script.** Pausing
  is five owner-signed txs with an order-sensitive trap (controller must pause
  before or with the oracle; governance-only pause is counterproductive).
  Include: the pause-set rule, the never-evict-a-pending-flight rule, and the
  oracle-outage procedure (pause the vault before an outage threatens the 6h
  pricing delay; pause the Controller well before day-14 voids).
- [ ] **Oracle key compromise procedure.** Rotating `set_oracle` does NOT
  revoke outstanding sale auths (up to 24h, temporary storage, not enumerable
  on-chain). Either build the `close_sale` sweep tool (reconstruct open
  windows from SaleOpened/SaleClosed events) or pre-commit to "pause the
  controller for 24h" as the documented response.
- [ ] **Decide paused-state deposit escrow.** `cancel_deposit`/`collect` are
  pause-gated, so a long pause strands escrowed-but-unminted LP funds with no
  exit — add a pause exemption or document the decision explicitly.
- [ ] **Settlement-mirror backfill path.** Event ingest runs only inside the
  hourly exposure job and permanently loses events older than ~118k ledgers
  (~7 days); the mirror is the only source for the expired-claim sweeper
  (real unclaimed money). Document a backfill or add a second ingest trigger.

## Frontend user-safety

- [ ] **USDC trustline handling** — the likeliest mainnet first-run failure: a
  wallet without the trustline shows "0.00 USDC" and buys fail with an
  unmapped raw error. Add a trustline check + "add USDC trustline" CTA +
  XLM-for-fees hint (Horizon balances are already fetched but unused), and a
  BetSlip pre-check that the buyer holds the premium.
- [ ] **Protocol-paused banner**: nothing in the UI reads `paused()`; mid-
  incident the BUY/DEPOSIT buttons stay enabled and users get opaque contract
  errors. Mirror the network-mismatch banner pattern.
- [ ] **Client-side error reporting** (Sentry or similar; add its origin to the
  CSP) — launch is otherwise blind to failing buys (console.error only today).
- [ ] **Testnet copy sweep**: footer "Soroban testnet ·", Legal/Privacy
  "running on testnet", House "mint test USDC" deposit hint, RiskBar "no live
  route history on testnet".
- [ ] **Decide demo/synthetic data on mainnet**: the bundled testnet catalog
  renders "DEMO" rows + fabricated globe flights when `/api/routes` is down,
  and seeded-RNG "illustrative" TVL/APY sparklines sit next to real money
  numbers — real snapshot data or removal.
- [ ] **Terms acceptance + jurisdiction gate** before money actions (one-time
  risk/ToS acknowledgment on first connect, restricted-region notice, refresh
  "Last updated" dates); record the default-theme decision (`fun` vs `serious`) 
  as a deliberate launch choice.

## Security posture & CI

- [ ] **Third-party human audit** (Trail of Bits / OtterSec / Halborn class) —
  recommended in `spec/audit.md`, still unscheduled. 
  Include verifying deployed OZ crate versions match audited releases.
- [ ] **Bug bounty before real-money exposure** (Immunefi or similar) + expand
  `SECURITY.md` with SLA/reward posture.
- [ ] **CI gaps**: scheduled `cargo audit` (PR-only today — advisories between
  PRs go unseen), run the dapp mock e2e suites + `npm audit` in CI, and the
  wasm-hash reproducibility check from the cutover section.

## Legal

- [ ] **Legal review pass**: the privacy policy states the software "runs on
  testnet"; no geo/sanctions handling despite the disclaimer acknowledging the
  unlawful-jurisdiction question; treasury-funded promotional credit payouts —
  confirm framing alongside the credits decision. (Credits mean
  the treasury pays real premiums on users' behalf as a marketing incentive —
  a structure that can trip rules depending on wording and jurisdiction. Counsel
  should bless the terms — promotional, revocable, capped, points have no
  value until granted — before the mechanism is built and announced.)

## Verification gates

- [x] **Full-catalog board** *(implemented 2026-08-04 on `soak_harness`)*: GET
  `/api/routes` (bundled fleet file + governance-DB pause overlay, CDN-cached
  5min) replaces the per-visitor on-chain board scan; board sells the whole
  seeded catalog, `routes.live.json` demoted to featured list; BetSlip
  re-verifies the single selected route on-chain at open. Soak exercises it.


- [ ] **Live soak test passes** (`spec/soak_test_plan.md`): 24–48h, 25–30
  policies, crons settle autonomously, reconciliation report clean.
- [ ] **Governance automation live-fire gate**: owner `add_admin` executed,
  `GOV_DRY_RUN=false`, and at least one real automated pause + revive observed
  on testnet — the exposure breaker / weather pause / pricing brake have never
  written to chain.
- [ ] Docs drift cleanup: `DEPLOYMENT.md` says 8 crons / README says 11 /
  `vercel.json` has 10 — reconcile after the deployment settles; document the
  `.js`-extension requirement for `api/` imports (Vercel ESM, fix `982caba`).
- [ ] Check SDF's announced testnet reset schedule before long-running testnet
  commitments (resets wipe contracts + seeded state).
