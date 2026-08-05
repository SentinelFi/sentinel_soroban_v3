# Before mainnet — accumulated fix list

Everything known to need fixing, deciding, or upgrading before the tenure-gated
mainnet launch (see `spec/TODO.md` launch plan). Grouped by the kind of work;
items marked **[contract]** belong to one coherent contract-upgrade + re-audit
bundle so the chain is touched once.

## Contract upgrade bundle (one upgrade, re-audit together)

- [ ] **[contract] Insure both legs of out-and-back flight numbers.**
  *(Researched 2026-08-05 — supersedes the earlier one-paragraph entry.
  DEFERRED until after the live soak test completes; nothing here is to be
  started while the soak is running. The off-chain half is split out below as
  its own items: this bundle entry is ONLY the contract change.)*

  GovernanceModule already keys `Route(flight_id, origin, dest)`. The block is
  entirely downstream: `OracleKey::FlightData`/`SaleAuth`,
  `PoolKey::FlightConfig`/`Buyer`/`Claimed`, the shared active-set index, and
  `CtrlKey::TravelerFlights` are all keyed `(Symbol, u64)`. The
  `FlightRoute(flight_id)` uniqueness index (`FlightIdAlreadyMapped` #505)
  exists purely to stop two routes colliding in that 2-part space.

  **The data already exists and is silently dropped.** `route_whitelist.json`
  holds 1,190 rows over 1,069 distinct flight_ids — **114 ids map to more than
  one leg** (108×2, 5×3, 1×4). All 121 whitelist triples missing from the fleet
  file are second/third/fourth legs rejected on-chain and swallowed by
  `seed_routes.ts`'s catch. `discover_routes`, `price_routes` and `seed_routes`
  are ALREADY multi-leg correct — only the contract refuses.

  **Blast radius:** 28 of 35 public entry points take `flight_id` without
  origin/dest; 25 typed events; 292 of 480 tests.

  **Two designs, decide by measurement, not taste:**
  - *A — add origin/dest to the downstream keys.* Self-describing on-chain
    data, and the fetcher gets the leg straight from `get_active_flights`.
    Costs: `TravelerFlights` goes 61% → **98%** of the 65,536-byte entry limit,
    so `MAX_TRAVELER_FLIGHTS` MUST drop 1,000 → ~600 (overflow permanently
    blocks that address from buying — the append is on the `buy_insurance`
    path); and every key gains two members on the classify/settle path.
  - *B — compound Symbol (`AAL1771_DFW_LAS`).* No signature changes, and
    size-safe (73% of the entry limit). But 15 chars crosses Soroban's 9-char
    `SymbolSmall` boundary, so every flight id becomes a heap-allocated
    `SymbolObject` — allocations and host calls where there are now register
    ops. Also breaks `symbol_short!` at ~277 test sites.

  Both land on the CPU budget that already forced `MAX_CLASSIFY_BATCH` 25 → 8
  and `MAX_SETTLE_BATCH` 10 → 8 (measured ~5.90M instructions/flight against a
  100M cap). **Measure `classify_flights` on a branch for each option before
  committing** — the same measurement that sized those constants.

  **Migration is the hard part, and is why this is pre-mainnet.** After the
  upgrade, code reads 4-part keys while existing entries are 2-part: live
  policies become invisible, collateral locked and claims impossible. There is
  no dual-read path today. The fleet must be drained to zero (settle + claim
  everything, then `wipe_routes` + re-seed) before the upgrade lands. Trivial
  on testnet; on mainnet it means "before there is real money".

  ### Scale check: the composite key is NOT the main constraint on sales
  *(Measured 2026-08-05. Read this before sizing the work — it changes what
  the fix is worth.)*

  A flight number is not a stable route identifier over time.
  `discover_routes.ts:90-94` samples exactly TWO days (a Tuesday and the
  following Saturday) and treats the result as permanent; airlines rotate
  numbers across routes constantly. Sampling 30 whitelisted routes against
  AeroAPI for how many still fly their whitelisted leg:

  | horizon | flying the whitelisted leg |
  |---|---|
  | d+1 | 6/8 (75%) |
  | d+7 | 2/6 (33%) |
  | d+14 | 3/6 (50%) |
  | d+30 | 0/6 — no published schedule at all |
  | d+60 / d+90 | 1/6 each (17%) |

  So the composite key recovers the 121 dropped legs (~10% more catalog), but
  every one of those is still subject to the same 33-50% date availability.
  **Schedule volatility dominates by a wide margin, and the composite key does
  nothing for it** — it solves "two legs, same day", not "same number,
  different route next week".

  Note the two live off-chain fixes below move buyability in OPPOSITE
  directions: resolving ambiguity RECOVERS buys (several candidates, one is
  ours), while verifying the leg LOSES buys that currently succeed wrongly
  (one candidate, wrong route). Expect the apparent success rate to drop when
  the leg check lands — that is the bug becoming visible, not a regression.

  ### Frontend changes this forces

  **Correctness — required by the contract change:**
  - `Markets.tsx:593` sends only `{flight_id, date}` to sale-auth, then passes
    the full triple to `buy_insurance` fifteen lines later. Sale-auth therefore
    calls `findSellableRoute(flight_id)`, which takes the FIRST match. Harmless
    while the chain enforces 1:1; the moment both legs are whitelisted,
    **buying leg B can authorise leg A**. Must send origin/dest.
  - `Markets.tsx:1189` sets `data-flight-id={route.flightId}` — the id alone.
    The React key is already the triple so rendering is fine, but any selector
    is ambiguous across two legs, including the soak harness
    (`tests/e2e_live/browser/pages/markets.ts:57` uses
    `[data-flight-id="X"]` + `.first()`, so it would buy an arbitrary leg).
    Needs the triple, or sibling data-origin/data-dest attributes.
  - Policies page: `get_flights_for_traveler` returns `(flight_id, date)`;
    under composite keys it returns 4-tuples. The page must render the leg or
    two policies on one number are indistinguishable and a claim could target
    the wrong one.
  - Search needs NO change: `matchesQuery` already matches flight id AND
    airports, and rows already display `ORIGIN → DEST`, so two legs are
    visually distinct.

  **UX — forced by the availability data above, and worth more than the
  contract work:** the board is route-centric while buyability is
  (route, date)-centric. A user searches DFW, sees 100+ routes, picks a date
  and is refused with no way to have known.

  The economics make this tractable: **schedule lookup is cheap per city-pair
  and expensive per flight.** One `/schedules` call filtered by
  origin+destination returns every flight on that pair that day, so ~80
  directed pairs x 14 days ~= 1,100 calls buys complete near-term
  availability — versus ~15,000 for per-flight verification. A daily cron on
  that cheap path could populate an availability table, letting the board
  filter by selected date, `FlightCalendar` grey out non-operating dates, and
  a refusal say "doesn't fly that date — try the 8th" instead of dead-ending.

  ### Open design question: is flight_id the right route identity at all?

  The ML model NEVER sees the flight number — `price_routes.ts` prices on
  (carrier, origin, dest, dep_time, distance). Pricing is already pair-based;
  only the ORACLE needs a specific flight, and only per policy.

  So governing **(carrier, origin, dest)** as the route, with a policy naming a
  specific flight verified at purchase, would DELETE this problem rather than
  solve it: no composite key, catalog drops 1,069 -> ~80 entries, the batch
  `whitelist_routes(vec)` entrypoint becomes unnecessary, and reassignment
  stops mattering.

  The cost is real: on-chain terms would be per-pair, losing time-of-day
  pricing — and the model says that matters (a 19:22 departure is ~2x a 07:00
  one on the same route). You would price the pair at a blended rate and carry
  the selection risk as buyers favour evening flights.

  **Decide this BEFORE building composite keys.** If pair-based governance is
  where this ends up, the composite-key work is effort spent on a model being
  replaced.
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

- [ ] **Sale-auth never checks that the flight IS the route we sold.**
  *(Found 2026-08-05. Live defect — it is writing wrong policies right now,
  and needs no contract change to fix. DEFERRED until after the soak: the
  fix REFUSES buys that currently succeed, which would change soak
  behaviour mid-run.)* `getFlightData` verifies only that a
  flight with that ident exists on that date and is not cancelled. It never
  compares origin/destination — `AeroApiFlight` (`aeroapi_client.ts:3-18`)
  does not even model those fields, though AeroAPI returns them.
  **Measured against the live soak: 2 of 8 sampled policies are attested
  against a different physical flight.** AAL1193 was sold as DFW→ORD but the
  2026-08-06 flight is ORD→CID; AAL1424 sold DFW→ORD, actual ORD→FLL. The
  premium was priced on one route's delay profile and settlement will read
  another's. Extrapolated, ~12 of the 50 soak policies may be mis-attested.
  **Fix:** model `origin`/`destination` on `AeroApiFlight`, pass the leg into
  `getFlightData`, and REFUSE when the returned flight is not the sold leg.
  The ICAO↔IATA `sameAirport` helper added to `sale_auth.ts` on 2026-08-05
  for `/schedules` should move into the client and serve both paths.
- [ ] **`getFlightData` cannot disambiguate a multi-leg ident.**
  *(Found 2026-08-05. Live defect; off-chain only. DEFERRED until after the
  soak.)* On more than one
  candidate it logs "refusing to guess" and returns `null`
  (`aeroapi_client.ts:194-201`) — the SAME `null` it returns for "no such
  flight". Three distinct outcomes (absent / wrong leg / genuinely ambiguous)
  collapse into one, so callers cannot tell them apart and the UI says
  "flight not verifiable for that date" for all three. This is what refused
  AAL1771 and UAL2382 in the 2026-08-05 smoke test even though those flights
  were operating and sellable.
  **`fetcher.ts:157` is the ONLY call site with no route context** — it
  iterates the oracle's bare `(flight_id, date)` list, so a multi-leg ident
  never settles; it just retries until the 14-day stale-void. Everything else
  (`sale_auth`, `route_guard`) already holds the route and discards it.
  **Ordering constraint:** the fetcher can resolve its route from the fleet
  file ONLY while the on-chain 1:1 constraint holds. So this fix must land
  BEFORE the composite-key contract change, not after — once a flight_id maps
  to two routes, the lookup is ambiguous again and the leg must come from the
  chain.
- [ ] **Four off-chain sites silently pick a winner when a flight_id has two
  routes.** They are latent today (the chain enforces 1:1) and become wrong
  the moment the contract change lands, so they are part of that bundle's
  off-chain half: `findSellableRoute` (`sale_auth.ts:92`) takes the FIRST
  match with no `ORDER BY`; `outcome_log.ts:86` takes the first, so the ML
  training row gets the wrong airports and the second leg's outcome is
  dropped by `on conflict do nothing`; `exposure_collector.ts:196-211` builds
  a `Map` keyed on flight_id so the LAST leg wins and the other reads zero
  liability; `event_ingest.ts:106-115` joins `routes` on flight_id alone, so
  the join fans out and `policies.origin/dest` is wrong for ~half the rows.
- [ ] **Two DB tables have uniqueness blind to the leg.** `settlements` is
  `primary key (flight_id, date)` and `flight_schedules` is
  `primary key (flight_id, date_unix)` — two legs on one day collide and the
  second is silently dropped (`on conflict do nothing` / overwritten). Both
  need origin/dest in the key alongside the contract change. `routes`,
  `interventions`, `flight_outcomes` and `policies` already carry the triple.
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
- [ ] **Deliberate duplicate-leg dedupe in `price_routes.ts`.** *(Interim
  measure only — obsolete once the composite-key contract change lands, since
  both legs become insurable. Keep it while the 1:1 constraint stands.)* Today
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
