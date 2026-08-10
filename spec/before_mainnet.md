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
  **`14-day-void-as-on-time` now has a concrete counter-example** (ASA287, see
  *Off-chain tooling*): a flight that provably did not operate settles on-time,
  denying the buyer a 100 USDC payout and moving their premium to vault yield.
  Re-affirming that residual now means accepting a false negative against
  buyers, not merely accepting void-path income.
- [ ] **[contract] Make the 14-day void dispute-aware.**
  `controller/src/settle.rs:219` voids a still-`NotInitiated` flight by settling
  it **on-time**, and that settlement is terminal:
  `flight_pool_manager/src/settle.rs:122` panics `FlightNotActive` unless the
  bucket is `Active`, and the oracle machine is forward-only with no correction
  path. So the timer closes the case permanently and an operator adjudicating on
  day 15 has nothing left to act on — any manual-settlement path must RACE the
  void rather than override it. Add a suppression so an open
  dispute/intervention on `(flight_id, date)` blocks the auto-void, or commit to
  a hard "adjudicate within 14 days" SLA and document that instead. The
  off-chain half is split out under *Off-chain tooling* and *Incident response*;
  the ASA287 evidence is recorded there.
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
- [ ] **SEO/robots at cutover.** Indexing is ON by default today — no
  `noindex` anywhere, and `dapp/public/robots.txt` only
  blocks `/admin` + `/api/` from crawlers; Vercel auto-noindexes *preview*
  deploys only, production is crawlable. At cutover: (1) add
  `rel="canonical"` to `dapp/index.html` once the domain exists (ties to the
  Name + domain item — canonical prevents the `*.vercel.app` alias competing
  with the custom domain); (2) `noindex` the **testnet** deployment (meta tag
  or `X-Robots-Tag` header on that Vercel project) so search results only
  ever surface the mainnet app, never the faucet-enabled testnet UI; (3)
  prefix the custom domain onto the deliberately-relative URLs in
  `dapp/public/sitemap.xml` and `robots.txt`'s `Sitemap:` line — the sitemap
  protocol requires absolute URLs, so both are inert (harmlessly ignored by
  crawlers) until this is done; then submit the sitemap in Search Console,
  and keep both files in sync if page routes change. Also swap the
  `sentinel-dapp.vercel.app` origin hardcoded in the `og:url` / `og:image` /
  `twitter:image` tags in `dapp/index.html` (those NEED an absolute URL —
  scrapers drop relative ones — so unlike the sitemap they carry the
  interim origin now).
- [ ] **SEO backlog.** In rough impact order:
  - **Content-rich landing at the apex is the biggest lever** — the app is
    UI, not content; search engines have almost nothing to rank. A landing
    page (what parametric flight insurance is, how payouts work, FAQ)
    interlinked with the docs site would outweigh everything else here. The
    Docusaurus site should enable its sitemap (a default plugin) and link
    to/from the dapp.
  - **Prerender the static-content pages.** The SPA serves an empty
    `<div id="root">` — Google executes JS but ranks rendered-late content
    worse, and Bing/DuckDuckGo/LLM crawlers mostly don't. Full SSR is
    overkill; build-time prerendering of `/information`, `/privacy`,
    `/terms`, `/disclaimers`, and a static hero for `/` gets real HTML into
    the index cheaply (e.g. `vite-plugin-prerender` or a post-build
    Playwright snapshot).
  - **JSON-LD structured data** — `Organization` + `WebSite` on the shell;
    `FAQPage` markup if the information page has Q&A-shaped content
    (eligible for rich results).
  - **`<noscript>` fallback** — one paragraph describing the product with a
    link to the docs, so no-JS crawlers and preview bots see something
    instead of an empty body.
  - **Core Web Vitals pass** — page speed is a ranking input; close out the
    2026-07-30 performance-audit findings. The font preloads and preconnects
    in `index.html` are already the right pattern.
  - **Soft-404 hygiene** — the catch-all route renders Markets with HTTP 200
    for any garbage URL, so crawlers see infinite duplicate pages. At
    minimum render a real "not found" component (Google detects those); the
    `/house`→`/earn` redirect via `<Navigate replace>` is already fine.
  - **Register the domain in Google Search Console + Bing Webmaster Tools
    at cutover** — submit the sitemap there; it is also where the
    og/canonical/soft-404 issues above surface. Free monitoring, and Bing's
    index feeds several AI assistants' answers.
- [ ] **Lighthouse audit on preview deploys** — run Lighthouse (Chrome
  DevTools or [PageSpeed Insights](https://pagespeed.web.dev/)) against the
  deployed **landing** and **dapp** before cutover, and re-run after the
  domain switch. The landing should score high across the board (build-time
  prerendering, self-hosted subset fonts, ~3 KB WebP LCP image, zero
  third-party requests, security headers in `landing/vercel.json`); treat
  any Performance/SEO score below ~90 as a regression to investigate. Known
  acceptable flag: `style-src 'unsafe-inline'` in the CSP (required by the
  prerendered inline style attributes and the `<noscript>` style block) may
  ding Best Practices. Core Web Vitals feed rankings, so this pairs with the
  Search Console registration above.
- [ ] **Web analytics (optional, currently none).** Landing and dapp ship no
  analytics today. If traffic attribution becomes worth having, prefer a
  cookieless tool (Vercel Web Analytics or Plausible): no cookies or device
  identifiers means **no consent banner is required** — only a one-line
  disclosure in the Privacy page (which currently claims minimal data
  collection, so it must be updated in the same PR that enables analytics).
  A cookie-based tool (e.g. Google Analytics) would instead require a full
  consent banner + policy rewrite — avoid unless there's a hard requirement.
  Notes for whoever wires it: Vercel Analytics serves its script and beacons
  first-party, so the strict CSP in `landing/vercel.json` needs no changes;
  a `utm()` tagging helper already exists unused in `landing/src/links.ts`
  for attributing landing→dapp clicks per placement; and the dapp project
  needs Analytics toggled in its Vercel dashboard for UTM params to be
  visible there.
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

- [ ] **Flight-date semantics: we key on the UTC departure date, the world
  uses the LOCAL one.** *(Audited 2026-08-05. DEFERRED until after the soak —
  the fix changes which physical flight a date maps to.)* Every backend
  consumer resolves a policy date as "the instance whose `scheduled_out`
  falls on UTC date D" (`sale_auth.ts:260`, `route_guard.ts:85,116`,
  `aeroapi_client.ts:187`, `fetcher.ts:154`). Airlines, boarding passes and
  travellers use the local departure date at origin. **Measured: 204 of the
  1,069 seeded routes (19%) depart late enough that the two differ** — after
  20:00 Eastern, 19:00 Central, 18:00 Mountain, 17:00 Pacific. Worst
  origins: LAX 42, LAS 36, SFO 25, DFW 24.
  For those, a buyer selecting "Aug 6" holds cover on the flight departing
  local Aug 5 evening. The system is INTERNALLY consistent — all 72 captured
  schedules have key date == UTC departure date — so this is a
  product-semantics decision, not a code inconsistency. It is invisible to
  the buyer because `/api/routes` exposes no departure time.
  **Decide explicitly:** either label the board "departure date (UTC)" and
  surface the time, or key on local departure date end to end (which needs
  the origin's IANA zone at every resolution site).
- [ ] **The flight-date calendar is LOCAL while its label says UTC.**
  *(Audited 2026-08-05. Real bug, frontend-only. DEFERRED until after the
  soak — it changes which dates are selectable.)* `FlightCalendar.tsx` builds
  cells with `new Date(year, month, d)` and keys them with
  `getFullYear/getMonth/getDate` (`:33-38`, `:42`, `:58-62`) — all local —
  and `Markets.tsx:44` reinterprets those digits as UTC midnight. The field
  is labelled `"FLIGHT DATE (UTC)"` (`copy.ts:100,473`).
  **Consequence:** for a Pacific buyer at 19:00 local (02:00 UTC next day)
  the calendar's first selectable day keys to `dayOffset = 0`, which
  `sale_auth.ts:129` hard-refuses as "inside the minimum lead time". Every
  evening after 17:00 Pacific / 20:00 Eastern, the earliest date the UI
  offers is guaranteed to fail — ~29% of the day for west-coast users. East
  of UTC the failure inverts: those users silently lose the nearest sellable
  day. Fix belongs in the calendar (UTC getters), not in sale-auth, which
  defines the invariant correctly.
  Two smaller ones in the same file: the calendar has **no upper bound**, so
  a user can page to 2027 and pick a date refused as beyond the horizon; and
  `minDay`/`today` are `useMemo(…, [])`, so a slip left open across local
  midnight keeps a now-past day enabled.
- [ ] **ML training rows carry the wrong day's weather for the same ~19%
  cohort.** *(Audited 2026-08-05.)* `outcome_log.ts:89` derives `dateIso`
  from the UTC key, then passes it to Open-Meteo with `timezone=auto`
  (`weather_client.ts:97`), which aggregates the AIRPORT-LOCAL calendar day.
  So `flight_date` and the eight weather columns in the same row describe
  different 24-hour windows. The module docstring (`:41-44`) claims it uses
  "the flight's local date"; it does not. `flight_outcomes` is explicitly the
  weather-learnability log, so this corrupts the training signal it exists to
  provide. The fix needs an origin-local (and separately dest-local) date
  derived from `scheduled_out`, which `flight_schedules.scheduled_out_unix`
  already stores. The FORECAST path is unaffected — it takes a max over the
  horizon and never indexes a specific day.
- [ ] **`AIRPORT_TZ` covers 14 of 37 airports and fails silently.**
  `price_routes.ts:52-70` maps an origin to its IANA zone to derive local
  `dep_time_hhmm`; an unmapped origin returns **noon** with no warning
  (`:63`). Inert today because the discovery matrix only touches the mapped
  14 — but the airports table is already provisioned for 37 and
  `admin/airports.ts` exists to manage them, so widening the matrix would
  silently misprice every new-airport route. At minimum warn on the unmapped
  branch; better, fail the pricing run.
- [ ] **Pin the soak harness browser to UTC.** `browser/context.ts:38` calls
  `newContext()` with no `timezoneId`, so it inherits the host zone and its
  results depend on when and where it is run. It drives the local calendar
  via `[data-day="${dateISO}"]` where `dateISO` is a UTC date — so on a
  UTC-negative host in the evening it would fail on `dayOffset`-1 candidates,
  reporting the frontend bug above as an opaque harness error. Pinning
  `timezoneId: "UTC"` makes it deterministic.
- [ ] **Assert the DB session timezone is UTC.** `date_trunc('hour', …)` in
  `interventions.ts:122,142` (the disable-cap window) and `date_trunc('minute')`
  in `rate_limit.ts:57` are session-TZ dependent. Correct today only because
  Supabase defaults to UTC; nothing in code asserts it. Also worth recording
  as a rule: every migration column is `timestamptz` today, never bare
  `timestamp` — that is what keeps `new Date(row.col)` safe under postgres.js,
  and a single bare `timestamp` column would silently reintroduce local-time
  parsing.

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

- [ ] **Resolve and escalate "uncorroborated" flight outcomes.** *(Evidence:
  ASA287 EWR→LAX 2026-08-06, live testnet, during the 2026-08-04 soak.)*
  `isConfirmedCancellation` (`aeroapi_client.ts:56`) requires
  `cancelled && /cancel/i.test(status)`. AeroAPI returned `cancelled: true` with
  `status: "result unknown"`, so the fetcher skipped the flight on every tick
  from 12:01Z onward and it is now on course for the day-14 void. Three fixes,
  all off-chain:
  - **Corroborate with the position track.** The 08-06 instance had no
    `actual_out/off/on/in`, `progress_percent: 100`, and
    `/flights/{fa_flight_id}/track` returned **0 positions** — while 08-03/04/05
    each show `Arrived` with a real `actual_in`. A daily flight that transmitted
    nothing did not operate; that is the corroboration the status string is
    missing. One extra call, only on the ambiguous branch, so the demand-driven
    call economy is preserved.
  - **Raise an intervention after N consecutive unresolvable ticks.**
    `jobs/fetcher.ts` contains **no** intervention calls at all — its docstring's
    promise that "persistent cases surface to ops" has no implementation, which
    is why `interventions` stayed empty through four blocked ticks. The
    `cancellation` cause in `route_guard.ts` is route-health (stop selling), not
    per-policy adjudication.
  - **Persist the evidence at block time, not adjudication time.** Only the skip
    string survives, buried in a `cron_runs.actions` blob. AeroAPI visibility is
    −10d (`VISIBILITY_PAST_SECS`) but the void is day 14 — the proof expires
    FOUR DAYS before the case closes, so late adjudication is guesswork.
    Snapshot the raw flight payload + track result on first block.

  Money at stake in the recorded case: `delay_hours: 3` and an estimated 71-min
  arrival delay, so "landed late" settles on-time and pays 0, while "cancelled"
  pays the full 100 USDC payoff. The current path pays 0 and sweeps the premium
  to vault yield — a false negative against the buyer, not a conservative hold.

- [ ] **Mirror the chain events the DB does not keep — 2 of ~50 today.**
  `governance/event_ingest.ts` captures exactly `InsuranceBought` →
  `policies` and `FlightSettled` → `settlements`. Every other event is gone
  once it leaves RPC retention (~7 days): `SharePriceSnapshot`,
  `PayoutClaimed`, the entire LP flow (`DepositRequested/Processed/
  Cancelled/Dropped`, `WithdrawalRequested/Cancelled`,
  `RequestPartiallyFilled`, `RequestDropped`, `Collected`), the
  lifecycle/diagnostic set (`FlightClassified`, `FlightVoided`,
  `FlightEvicted`, `TtlMiss`, `MissingFlightData`, `FlightTimedOutActive`)
  and every route/governance event.

  **Nothing on-chain is an archive**, which is what makes this load-bearing
  rather than nice-to-have: share-price snapshots live in Temporary storage
  with a 30-day TTL, RPC events last ~7 days, and the contract's own comment
  says "historical analytics are off-chain via events". The DB is the only
  durable record the protocol has.

  **It has already cost us twice on testnet:**
  - `SharePriceSnapshot` fires on every snapshot but nothing ingests it, so
    `vault_history` is instead built by POLLING contract state from the
    queue cron. It therefore begins only when the poller began (2026-08-07),
    three days after the vault opened, and the /earn headline annualized
    from the vault's local peak — reporting −28.4% APR for a vault that was
    up +1.0% since inception. Had the events been ingested there would be no
    gap and no deadline. `scripts/backfill_share_price.ts` repairs it, but
    only while the on-chain snapshots survive their 30-day TTL.
  - The corrupt 2026-08-06 snapshot (recorded 10^3 low by the offset bug
    #119 fixed) was only diagnosable from live chain reads inside that same
    30-day window. Ask in November and the evidence is gone.

  Shape: one raw `chain_events` table (ledger, tx_hash, event_index,
  contract_id, topics jsonb, value jsonb), `(tx_hash, event_index)` unique —
  capture everything cheaply, then project into typed tables FROM it, so a
  projection bug is replayable instead of a permanent loss.

  Two structural fixes belong with it:
  - **Give ingest its own cron.** It piggybacks on the hourly `gov_exposure`
    job today; if that job breaks, the mirror stops silently.
  - **Alert on `gapLedgers > 0`.** The code already MEASURES permanent loss
    (ingest down longer than `RETENTION_LEDGERS = 118_000`, ~7 days) and
    only logs it. Same root cause as the settlement-mirror backfill item
    under *Incident response* — fix them together.
- [ ] **Run `scripts/backfill_share_price.ts --apply` before ~2026-09-03.**
  Written and dry-run verified; deliberately NOT executed (writes are
  per-step user-gated). It upserts the daily share-price series into
  `share_price_daily` from the on-chain snapshots, and quarantines
  implausible samples — it correctly rejected the corrupt 2026-08-06 point
  without being told about it. Two of the days it recovers (2026-08-04/05)
  predate the `vault_history` mirror, and recovering them moves the /earn
  headline from −28.4% APR to the true +61.2%. **After the 30-day Temporary
  TTL expires those days are unrecoverable anywhere**, which is what puts a
  date on this. It deliberately does not write into `vault_history`: four of
  that table's five NOT NULL columns are unrecoverable for past days, and
  rows without a bracketing `queue_maintainer` run trip the supply-violation
  check in `admin/security.ts`.
- [ ] **Frontend analytics now depend on the DB mirror — treat it as a
  serving path, not just a log.** The /earn headline (90-day APR/APY) and
  the share-price chart both read `/api/status/vault-history`; live SPOT
  values (TVL, free, locked) still read the chain, which is correct — that
  is current truth, not analytics. This cut `/earn` from 106 RPC requests
  per load to 13, and removed the corrupt on-chain snapshot from the chart.
  The trade is that a broken mirror now degrades visible UI (headline to a
  dash, chart to its labelled illustrative fallback) rather than only
  degrading ops dashboards. Needs an availability/staleness check on
  `vault_history` writes alongside the ingest cron above.

### Time handling — what the 2026-08-05 audit CLEARED

Recorded so this is not re-audited from scratch. The backend genuinely holds
the "UTC internally, local only as presentation" invariant: **zero** local
`getFullYear/getMonth/getDate/getHours/getDay`, **zero** `new Date(y,m,d)`
local constructors and **zero** `toLocale*` date formatting across
`dapp/api/**`, `scripts/**`, `agent/**` and `supabase/migrations/**`. Every
date string is `toISOString().slice(0,10)`; every day index is
`floor(epoch/86400)`. All nine migrations use `timestamptz`, never bare
`timestamp`. `sale_auth`'s `dayOffset` is UTC-vs-UTC and correct — its
CALLER is what is wrong. Day arithmetic everywhere operates on epoch
instants or explicit-`Z` parses, so DST cannot perturb it. `format.ts`
(`formatDate`, `utcDateTime`, `isoMinute`, `relTime`) is UTC-correct, and
the Status and Admin pages label their times UTC. The only local-time date
logic in the entire frontend is `FlightCalendar.tsx`.

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
- [ ] **Adjudication path for flights the pipeline cannot resolve.** No manual
  settlement route exists today: `admin/outcomes.ts` is read-only, and
  re-running the fetcher through `admin/jobs.ts` simply re-hits the same guard.
  Needs three pieces:
  - a **gated, evidence-logged admin settle action** for a reviewed outcome;
  - a **user-facing "raise an issue" on a policy**, so a buyer can dispute an
    outcome instead of silently absorbing it (today nothing in the UI can);
  - a **decided default for genuinely undecidable cases** — pay the payoff,
    refund the premium, or void as on-time. "An admin decides" is a mechanism,
    not a policy: it leaves a person guessing with no documented default, and
    today the answer is chosen by a timeout rather than by anyone.
    `sweep_expired`'s "recovered balance for owner-driven manual remediation" is
    the existing precedent to reuse if a premium-refund path is chosen.

  Sequencing matters: because settlement is terminal, this path only works
  BEFORE the day-14 void fires — see the dispute-aware-void item in the contract
  bundle, and the ASA287 case under *Off-chain tooling*.

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
