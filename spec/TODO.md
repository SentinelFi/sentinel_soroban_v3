# TODO — Frontend: correctness, scale, and UX (audit 2026-08-01)

Priority-ordered list from the 2026-08-01 frontend audit (dapp/src + the
admin API). Rule for everything here: pages fetch only what's visible,
servers paginate, chain reads never scale with fleet size.

(The old off-chain roadmap sections A–H were removed 2026-08-01 — largely
superseded by the demand-driven AeroAPI rework, the interventions
unification, and the Decentralization Roadmap section in
[architecture.md](architecture.md); the history lives in git.)

Legend: **P0** = do first · **P1** = high value · **P2** = polish.

---

- [x] **P0 — Fix `useProtocolStats` mislabeling.** `Controller.get_stats`
  returns (TotalPoliciesSold, TotalPremiumsCollected,
  TotalPayoutsDistributed); `useContracts.ts` labels them (totalTravelers,
  totalLocked, totalPremiums). Markets' stats ticker shows PAYOUTS under
  "PREMIUMS" and policies-sold under "TRAVELERS"; House shows payouts as
  premium income. Fix mapping + labels; locked capital comes from the
  vault read.
- [x] **P0 — Dev workflow for /api.** Vite dev serves only the SPA. Added a
  vite `server.proxy` for `/api → localhost:3000` + `npm run dev:api`,
  which runs beside it (existing .env). Not `vercel dev`: it doesn't
  correctly execute `/api/**` in this repo (falls through to the Vite
  dev-command proxy and returns transpiled source instead of running the
  handler, confirmed on CLI 58.4.0) — `dev:api` is instead a small local
  server (`scripts/dev_api.ts`) that mounts every `api/**/*.ts` handler
  directly, no `vercel` CLI dependency. Unblocks the JIT buy flow and
  every admin panel in dev.
- [x] **P0 — Wire JIT sale-auth into the buy flow.** BetSlip POSTs
  `/api/sale-auth/request {flight_id, date}` before `buy_insurance`;
  refusals throw `reason` verbatim into the existing error UI; success
  proceeds to the buy tx. New `TxState` phase `verifying` (label
  "VERIFYING…") covers the check so it isn't mislabeled "CHECK WALLET…".
- [x] **P1 — Admin routes board at 1000s of routes.**
  `?q=&page=&limit=&cause=` added; on-chain reads now scoped to the
  returned page only. Halt/Resume switched from raw `disable`/`enable`
  actions to POST/PATCH `/api/admin/interventions` (audited, reason
  required, cause-tracked) — falls back to the raw `enable` action only
  for routes disabled before the interventions ledger existed. Header
  figures now come from two cheap DB-only counts instead of a client-side
  scan over on-chain data. Not browser-verified against a real admin
  session (none available here) or with live data (this sandbox's
  governance DB has 0 rows) — SQL confirmed valid read-only against the
  real schema; typecheck clean; HTTP auth gate confirmed intact (401).
- [x] **P1 — Interventions log pagination.** `/api/admin/interventions`
  GET now takes `?state=open|closed&page=&limit=&cause=`; response is
  `{ rows, total, page, limit, state, open_count }` (`open_count` is a
  cheap fleet-wide count, decoupled from the current tab/filter, for the
  header "Open pauses" stat). Panel gets Open/History tabs, cause filter
  chips (cancellation/exposure/weather/pricing/admin), per-row expandable
  evidence (raw JSON), and a pager. The "closed" history was fetched by
  the backend before but never rendered anywhere — now it's the History
  tab. Same verification caveats as the routes-board item above (no real
  admin session, empty local DB): SQL validated read-only against the
  real schema, typecheck clean, 401 gate confirmed intact.
- [x] **P1 — Flight-outcomes panel.** New `api/admin/outcomes.ts` —
  `GET ?page=&limit=&outcome=ontime|delayed|cancelled|diverted` over
  `flight_outcomes`, `{ rows, total, page, limit }`. Extracted the
  self-creating table DDL out of `_lib/outcome_log.ts` into an exported
  `ensureOutcomesTable` so the read path can guarantee the table exists
  without ever having logged an outcome (same pattern as the
  interventions ledger). New admin panel: outcome filter chips, pager,
  table (flight, route, date, outcome, delay minutes, weather at both
  airports — gust/snow/precip). Same verification caveats as the two
  items above.
- [x] **P1 — Markets route universe from the fleet file.** `src/config/routes.ts`
  now build-time imports `config/routes.testnet.json` (same source
  `api/_lib/routes_config.ts` reads server-side) instead of a hand-typed
  200-route list; `ROUTE_BY_ID` (derived.ts) inherits the fix for free —
  every fleet entry included regardless of `enabled` (that flag gates the
  sale-authorizer, not display; the live chain read decides what's shown).
  "TRACKING NOW" turned out to already exist twice — Markets' "LIVE"
  ticker and the globe's tracked-flights list+map — both just starved by
  the stale candidate list. Verified the globe's filter (`useTrackedFlights`
  drops `Settled`/`ToBeSettledDelayed`) against the contract: necessary,
  not redundant — `get_active_flights()` reads the on-chain active_set,
  which only loses a settled flight when the DAILY `prune_settled` sweep
  runs, so a resolved flight can sit there ~24h. The Markets ticker had no
  equivalent filter — fixed to match (same two tags dropped from
  `liveRows`). Browser-verified: both pages load with no new console
  errors.
- [x] **P1 — Public stats endpoint + Markets stats strip.** New
  `api/status/stats.ts`, PUBLIC, `Cache-Control: s-maxage=60`. Chain
  (`Controller.get_stats`) always answers; DB (`settlements`, grouped by
  outcome) is optional — a DB outage degrades `insurances_paid`/
  `delayed_count`/`cancelled_count` to `null` while chain fields still
  return 200 (`db_available` flag tells the caller which mode it got).
  Traced `settlements.outcome`'s actual stored values through the contract
  (`FlightSettledEvent.outcome: FlightStatus`, the same enum controller-
  wide) — they're `ToBeSettledDelayed`/`ToBeSettledCancelled`, not the
  simpler "Delayed"/"Cancelled" the migration's own SQL comment implied;
  used the exact enum via `_lib/types.ts`'s `FlightStatus` rather than
  trusting the comment. Also confirmed `TotalPayoutsDistributed` already
  is the "gross claimable, incl. premium" figure the TODO asked for —
  `settle.rs` credits it for BOTH Delayed and Cancelled at the full
  `payoff * buyer_count`, no extra computation needed. Markets' stats
  ticker gained 4 items (insurances paid, delayed, cancelled, total paid
  out) via a new `usePublicStats` hook; "flights insured" already existed
  as "POLICIES SOLD" (same chain figure), not duplicated. Browser-verified
  end to end: new ticker items render "…" and degrade cleanly when the
  endpoint 500s (no local secret key here), no crash, nothing else on the
  page affected.
- [x] **P2 — TxProgress waiting UX.** New shared `TxProgress` component
  (`src/components/TxProgress.tsx`), wired into all 5 flows: BetSlip buy
  (verify+sign+confirm, COVERED/DENIED stamps), MyBets claim (sign+confirm,
  PAID stamp — converted its bespoke `claimingId` pattern onto `TxState`),
  House deposit/withdraw/collect (sign+confirm, plain ✓/✕, no stamp — those
  aren't insurance-purchase outcomes), Admin job runs (single `confirming`
  stage, plain ✓/✕ — no wallet involved so the SIGN step doesn't apply).
  Fun theme: dashed runway, radar-sweep icon during verify, the existing
  `betslip-plane` sprite taxis stage-to-stage (`steps(6,end)` motion),
  COVERED/DENIED/PAID rubber-stamp pop-in on the terminal state, CSS-only
  radial confetti burst on success (12 pieces, angle via `--tx-angle`
  custom property + `rotate()+translateY()`, no JS physics). Serious
  theme: 3-dot stepper with per-step icons, a shimmer pulse on the active
  dot, a status line, and a live elapsed counter. New animations added to
  the existing `prefers-reduced-motion` block. Skipped generating a
  separate ticket-tear asset — not built into this pass.

  4 new Pixellab assets (`radar-sweep`, `stamp-covered`, `stamp-denied`,
  `stamp-paid`, registered in `PixelArt.tsx`) — hit an expired-subscription
  block mid-session, resolved after the user renewed. Note for next time:
  the model followed literal stamp text reliably for "DENIED"/"PAID" but
  rendered "COVERED" as generic "STAMP" on the first attempt — a stricter
  bordered-stamp prompt + higher `text_guidance_scale` fixed it on retry;
  worth over-specifying stamp text prompts up front.

  Verified for real: typecheck clean, then built a temporary preview route
  (deleted after) cycling every `TxState` × both themes × all 3 step
  configurations — confirmed runway/plane-position math, radar visibility,
  correct stamp per flow (including the no-stamp ✓/✕ fallback for
  deposit/withdraw/admin), error-message rendering, and the serious-theme
  dot/shimmer/elapsed-counter — with zero console errors throughout. This
  is real verification of the rendered output, not just a typecheck pass.
- [x] **P2 — Micro-animation pass (fun more, serious less).** All 9:
  split-flap status chips (board + own status chip — content-keyed
  remount replays a flip, `.status-flap`), board row stream-in
  (`.board-row-in`, nth-child stagger up to 12 rows, only replays for
  rows genuinely newly visible — unchanged rows keep their key across
  background refetches), RiskBar fill on mount (serious: scaleX grow;
  fun: per-cell staggered pop, `riskbar-cell-pop`/`riskbar-fill-grow`),
  MyBets claim-button gold pulse (`.claim-btn-pulse`, distinct from the
  card's existing `.win-flash`), stat count-ups (new `useCountUp` hook,
  requestAnimationFrame + cubic ease-out, applied to StatsTicker's
  whole-number fields only — currency figures stay static, not worth the
  bigint-interpolation complexity), status-lamp breathing (`.breathe` —
  a calmer alternative to the existing hard `.blink`, applied to the
  three "alive and tracking" LIVE dots across Markets/MyBets/
  MarketsGlobe; kept `.blink` for the DEMO-data dot specifically, since
  that state deserves more attention, not less), notification settle
  (drop + overshoot + settle, added directly to the existing `.toast-px`
  class), TopBar coin flip — fun only (reused the existing `coin-usdc`
  sprite with a `rotateY` flip instead of generating a redundant asset;
  serious theme keeps its plain `$` glyph, no pixel art), globe dot pulse
  (`wave2.css`, `transform-box: fill-box` scale+opacity on `.globe-node-*`
  — SVG shapes, not HTML, so no box-shadow trick). All new keyframes
  added to the existing `prefers-reduced-motion` block; Admin untouched
  (still minimal) per the item's own instruction.

  3 more Pixellab assets (`ticket-tear` used as a divider; skipped a new
  `coin-flip` asset — CSS 3D transform on the existing sprite was
  strictly better, no sprite-sheet needed). Verified: typecheck clean;
  browser-checked Markets/MyBets/MarketsGlobe for console errors (none —
  one unrelated pre-existing a11y warning, one unrelated stale
  `_next/static` cache reference from an unrelated project sharing this
  browser profile, harmless 304). Caveat stated plainly: this sandbox's
  fleet file is empty (0 routes, same constraint noted throughout this
  session), so the board has zero rows and the globe zero tracked
  flights — the row-level and node-pulse animations could not be
  visually exercised against real data here, only code-reviewed and
  typechecked; they reuse the same CSS techniques (transform-box/origin,
  nth-child stagger, content-keyed remount) already visually confirmed
  working for the TxProgress stepper and RiskBar in this session.
- [x] **P2 — Cron-health polish + perf pass.** JOBS board rows expand
  ("Details") to show the last error (if the last run failed) and up to 8
  recent run durations for that job, from `recent` (already fetched by
  `admin/jobs.ts`, previously discarded — the same "data fetched, never
  rendered" pattern as the interventions history fix earlier). Admin
  console is now tabbed (Jobs/Routes/Interventions/Outcomes/Log); jobs,
  outcomes, and log only fetch while their tab is active — routes and
  interventions stay always-on since they feed the header dashboard
  figures, which are tab-independent. `useFlightDataBatch` now runs
  through a 50-wide concurrency pool instead of unbounded `Promise.all`
  (the active_set caps at 100k flights — unbounded would let a busy fleet
  flood the public RPC every 30s). All admin queries got `staleTime:
  30_000` alongside their existing 60s `refetchInterval`. Typecheck
  clean; verified the admin route loads without a JS crash post-refactor
  — full interactive tab/expand behavior not browser-verified (no real
  Supabase admin session available in this sandbox, same constraint as
  every other Admin.tsx change this session).
