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

- [ ] **P0 — Fix `useProtocolStats` mislabeling.** `Controller.get_stats`
  returns (TotalPoliciesSold, TotalPremiumsCollected,
  TotalPayoutsDistributed); `useContracts.ts` labels them (totalTravelers,
  totalLocked, totalPremiums). Markets' stats ticker shows PAYOUTS under
  "PREMIUMS" and policies-sold under "TRAVELERS"; House shows payouts as
  premium income. Fix mapping + labels; locked capital comes from the
  vault read.
- [ ] **P0 — Dev workflow for /api.** Vite dev serves only the SPA. Add a
  vite `server.proxy` for `/api → localhost:3000` + run
  `vercel dev --listen 3000` beside it (existing .env). Unblocks the JIT
  buy flow and every admin panel in dev.
- [ ] **P0 — Wire JIT sale-auth into the buy flow.** BetSlip must POST
  `/api/sale-auth/request {flight_id, date}` before `buy_insurance`;
  refusals show the reason verbatim (departs <24h / cancelled / not in
  schedule / beyond horizon); success proceeds inside the window.
- [ ] **P1 — Admin routes board at 1000s of routes.**
  `/api/admin/routes?chain=1` today returns ALL rows with one sequential
  on-chain read per route per 60s refetch. Server-side `?q=&page=&limit=`,
  chain status only for the visible page, pause/unpause via the
  interventions endpoint, "admin-paused" filter (cause=admin).
- [ ] **P1 — Interventions log pagination.** `/api/admin/interventions`
  gains `?page=&limit=&cause=&state=open|closed`; panel gets cause filter
  chips, open/history tabs, expandable evidence, pager — the
  "what's paused/unpaused and why" view.
- [ ] **P1 — Flight-outcomes panel.** New
  `GET /api/admin/outcomes?page=&limit=&outcome=` over `flight_outcomes`
  (outcome, delay minutes, weather both airports) + paginated admin table.
- [ ] **P1 — Markets route universe from the fleet file.** Replace the
  hand-typed `src/config/routes.ts` candidate list (stale — newly
  whitelisted routes won't appear) with a build-time import of
  `config/routes.testnet.json`; fix the globe's ROUTE_BY_ID the same way;
  add a "TRACKING NOW" strip (active insured flights + oracle status).
- [ ] **P1 — Public stats endpoint + Markets stats strip.** Sanitized
  `GET /api/status/stats` (~60s cache): chain get_stats + DB `settlements`
  counts by outcome (DB-optional, chain-only fallback). Markets shows:
  flights insured, insurances paid, delayed count, cancelled count, total
  paid out (payouts figure = gross claimable, incl. the premium portion).
- [ ] **P2 — TxProgress waiting UX.** Shared stepper replacing button-label
  tx states (buy/claim/deposit/withdraw/admin runs): VERIFY (JIT) → SIGN
  (wallet) → CONFIRM (Stellar) → done, each stage a real await. Fun theme:
  boarding-pass runway (radar sweep, taxi/takeoff, COVERED/DENIED stamps,
  ticket tear, confetti). Serious: 3-dot stepper + shimmer + status line +
  elapsed counter. Never blocks the UI; skeleton rows during board scans.
- [ ] **P2 — Micro-animation pass (fun more, serious less).** Split-flap
  status chips + board row stream-in (signature move), RiskBar fill on
  mount, MyBets claim-button gold pulse, stat count-ups, status-lamp
  breathing, notification settle, TopBar coin flip (fun only), globe dot
  pulse. Serious = opacity/transform 150–300ms; fun = steps() pixel
  motion; all behind the existing prefers-reduced-motion block; Admin
  stays minimal. Assets via Pixellab: radar sweep, stamps
  (COVERED/DENIED/PAID), coin flip, ticket tear.
- [ ] **P2 — Cron-health polish + perf pass.** JOBS board: expandable
  last-error + durations. Lazy admin tabs (only the visible panel
  fetches), cap `useFlightDataBatch` concurrency (~50), modest refetch
  intervals.
