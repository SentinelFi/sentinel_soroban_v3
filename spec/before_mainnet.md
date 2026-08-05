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
- [ ] Re-audit the bundle (5 prior audit rounds are on the current code; the
  upgrade invalidates that coverage for changed modules).

## Off-chain tooling

- [ ] **Fleet disable cap is wired to only one of five pause paths.**
  *(Found 2026-08-04; deliberately deferred — leave as-is until after the
  soak.)* The circuit breaker `max(3, 20% of fleet)` (`computeDisableCap`,
  `interventions.ts:84`) is claimed only by `exposure_collector.ts`.
  Weather-EXTREME, pricing-over-cap, cancellation and admin pauses all call
  `pauseRoute()` directly, which checks only `gov_frozen` and `pinned` — so
  four of five causes are uncapped. `architecture.md:2132` claims it is
  "enforced once, for every caller"; it is not. Weather pauses are also
  exempt from the job's own `MAX_TX_PER_RUN` (`weather.ts:195`), so nothing
  bounds them from either direction. At 1,069 routes the cap is **214**, and
  a single stormed hub already exceeds it — LAX touches 279 routes, ORD 270,
  DFW 218; a BOS/JFK/LGA/EWR nor'easter reaches 471. Recovery is the
  expensive half: no batch entrypoint, one tx per route per ledger, 300s
  function cap — a few hundred re-enables is hours of partial progress and
  real fees in both directions.
  **Proposed fix:** cap by cause shape rather than one global rule —
  airports for weather (≤2 of 14 per window; a route-count cap leaves an
  incoherent partial state, e.g. 214 of LAX's 279 disabled and 65 still
  sellable in hurricane-force gusts), route count for exposure + pricing,
  none for cancellation (acts on confirmed per-flight AeroAPI evidence),
  and admin exempt so a human can always pause more or revive. Emit refusals
  as `deferred` intervention rows so the `/admin` Interventions tab surfaces
  them with its count badge (today a refusal is only a `skipped` string
  buried in the job run's actions array), and add a deferred check to
  `/api/status/alert` so the uptime monitor below actually pages. Timing is
  forgiving — EXTREME is visible up to 72h out and the sale cutoff is 24h,
  leaving ~48h of actionable window, re-proposed every 2h — so email
  alerting is sufficient; the gap is that **nothing pushes at all today**.
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

## Services & costs (commercial posture)

- [ ] **Open-Meteo commercial license** (~€29/mo) — current keyless free tier
  is non-commercial only; mainnet with real premiums is commercial use.
- [ ] **Supabase Pro** (~$25/mo) — daily backups + no free-tier pause risk for
  the governance DB that drives live interventions.
- [ ] AeroAPI plan review at projected policy volume (cost scales ~½–1¢ per
  buy + one call per settle; fine at launch volume, revisit tiers with growth).
- [x] Render ML service: Starter ($7/mo) is fine — on the paid plan since
  2026-07-29. The "add a real `/healthz`, service 404s there" note was
  **wrong**: verified 2026-08-04 that `GET /healthz` already exists
  (`agent/app/main.py:216`), is `render.yaml`'s `healthCheckPath`, is
  covered by `agent/tests/test_predict.py:85`, and returns 200 live.
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

## Verification gates

- [x] **Full-catalog board** *(implemented 2026-08-04 on `soak_harness`)*: GET
  `/api/routes` (bundled fleet file + governance-DB pause overlay, CDN-cached
  5min) replaces the per-visitor on-chain board scan; board sells the whole
  seeded catalog, `routes.live.json` demoted to featured list; BetSlip
  re-verifies the single selected route on-chain at open. Soak exercises it.


- [ ] **Live soak test passes** (`spec/soak_test_plan.md`): 24–48h, 25–30
  policies, crons settle autonomously, reconciliation report clean.
- [ ] Docs drift cleanup: `DEPLOYMENT.md` says 8 crons / README says 11 /
  `vercel.json` has 10 — reconcile after the deployment settles; document the
  `.js`-extension requirement for `api/` imports (Vercel ESM, fix `982caba`).
- [ ] Check SDF's announced testnet reset schedule before long-running testnet
  commitments (resets wipe contracts + seeded state).
