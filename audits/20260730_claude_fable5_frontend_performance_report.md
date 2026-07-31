# Claude Fable 5: Sentinel Frontend Performance Audit

**Assessment date:** 30 July 2026

**Report version:** v1.0

**Assessment status:** Final

**Assessment type:** AI-Assisted Frontend Performance Review

**Auditor:** Claude Fable 5

---

## Assessment Information

| | |
| --- | --- |
| Project | Sentinel Protocol — FLIGHTS.FUN dapp |
| Component | Frontend — `dapp/` (Vite + React SPA, generated Soroban bindings) |
| Network | Stellar (Soroban testnet) |
| Language | TypeScript / React 19 / Vite 7 |
| Snapshot date | 2026-07-30 |

**Scope:** page-load performance of the `dapp/` SPA — bundle size and
composition, code-splitting posture, static assets (images, fonts), and
runtime data-fetching patterns that affect time-to-usable-board. Measured
against a production `vite build` with sourcemap attribution and live
browser inspection of every route.

**Explicitly out of scope:** the off-chain backend (`dapp/api/**` — covered
by the same-day off-chain security review), on-chain contracts, and the
retired `frontend/` / `frontend2/` trees.

---

## Methodology

- Production build (`vite build`) with `--sourcemap`, per-package byte
  attribution from the emitted sourcemap.
- Chunk-graph inspection of `dist/assets/`.
- Live inspection of every route in a production preview
  (`vite preview` + Chrome DevTools): network waterfall, console, RPC
  traffic to `soroban-testnet.stellar.org`.
- Static analysis of the data-fetching hooks (`src/hooks/useContracts.ts`)
  against the fleet-file / seeding pipeline they scale with.

**Baseline measurement:** one JavaScript chunk of **8,877 KB
(2,485 KB gzip)** downloaded and parsed by every visitor on every page,
plus 70 KB CSS. Static image assets were found healthy (`public/` totals
188 KB) and are not a finding.

---

## Findings Summary

| ID | Severity | Title |
| --- | --- | --- |
| FPA-H01 | High | stellar-sdk bundled seven times — six nested v14 UMD copies plus root v16 |
| FPA-M01 | Medium | No route-level code splitting; a cross-page helper import welds Admin (and supabase-js) into the main chunk |
| FPA-M02 | Medium | Markets board issues one RPC simulate-call per fleet route per visitor |
| FPA-L01 | Low | Two unused Outfit font weights downloaded on every visit |
| FPA-L02 | Low | Per-flight polling (`useFlightDataBatch`) scales linearly with active flights |
| FPA-I01 | Informational | react-router ships its `dist/development` build to production — investigated, no size impact |

### Severity Distribution

| High | Medium | Low | Info |
| ---: | ---: | ---: | ---: |
| 1 | 2 | 2 | 1 |

---

## High

### FPA-H01 — stellar-sdk bundled seven times — six nested v14 UMD copies plus root v16

**Files:** `dapp/packages/*/package.json` (×6), `dapp/package.json`,
`dapp/vite.config.ts`

The root app depends on `@stellar/stellar-sdk` **16.1.0**, while all six
generated contract-binding workspaces (`controller`, `governance_module`,
`oracle_aggregator`, `risk_vault`, `mock_usdc`, `flight_pool_manager`)
pinned `^14.5.0`. npm cannot hoist a shared copy across a major-version
split, so each binding received its own nested v14 install — and v14's
`browser` export field resolves to `dist/stellar-sdk.min.js`, a **972 KB
pre-minified webpack UMD** that Rollup can neither tree-shake nor minify
further. Sourcemap attribution showed that exact artifact bundled **six
times** (~5.8 MB), alongside the root's v16 (used by
`stellar-wallets-kit`), its `stellar-base` (435 KB) and transitive
axios/urijs/eventsource.

**Impact:** ~7.7 MB of the 8.9 MB bundle; every visitor pays multi-second
parse cost on every page, dominated by dead duplicate code.

**Recommendation:** pin the six binding packages to the root's exact SDK
version so npm hoists one copy; add
`resolve.dedupe: ["@stellar/stellar-sdk", "@stellar/stellar-base"]` in
Vite as a permanent guard (freshly regenerated bindings will silently
reintroduce the nesting whenever their pinned version drifts from the
root). Verify the wallet write path end-to-end after the major-version
jump, since the bindings were generated against v14.

---

## Medium

### FPA-M01 — No route-level code splitting; a cross-page helper import welds Admin (and supabase-js) into the main chunk

**Files:** `dapp/src/App.tsx`, `dapp/src/pages/Status.tsx`,
`dapp/src/pages/Admin.tsx`, `dapp/src/lib/utils.ts`

`App.tsx` statically imported all eight pages, so the landing paint paid
for: **Admin** (1,350+ lines, the sole consumer of `@supabase/supabase-js`
— which drags auth, storage, realtime and postgrest, ~800 KB source, into
every visit for an ops-only hidden route), **MarketsGlobe** (d3-geo +
topojson + the inlined `world-atlas` countries topology, ~700 KB source),
and **Quant** (the Monte Carlo calculator).

A subtlety that would defeat a naive fix: `Status.tsx` imported the small
`relTime` helper *from* `Admin.tsx`, so even after converting Admin to a
dynamic import, Rollup must keep Admin (and supabase) in the main graph.
Splitting only works once the shared helper moves to a neutral module.

**Impact:** ~400 KB (minified) of never-used-by-most-visitors code in the
critical path; `/admin`'s dependency weight is imposed on the public
storefront.

**Recommendation:** `React.lazy` + `Suspense` for MarketsGlobe, Quant and
Admin (Markets itself stays static — it is the first paint); relocate
`relTime` to `src/lib/utils.ts`. Keep future page-to-page imports out of
`Admin.tsx` — anything shared belongs in `lib/`.

### FPA-M02 — Markets board issues one RPC simulate-call per fleet route per visitor

**Files:** `dapp/src/config/routes.ts`, `dapp/src/hooks/useContracts.ts`
(`useRoutes`)

The GovernanceModule intentionally has no on-chain route enumeration, so
the board keeps a candidate list and verifies each entry live via
`route_status` — one `simulateTransaction` round-trip per route, in chunks
of 20, re-swept every 5 minutes per open tab. The candidate list is the
**entire fleet file**, which the seeding pipeline (`seed_routes.ts`)
mirrors every seeded route into: the previous harvest produced a 633-route
fleet, and the staged whitelist holds 1,302 candidates. Every visitor
would fire 600+ RPC calls against the public endpoint to paint a board
that shows a handful of rows.

**Impact:** slow first board paint (multi-second chunk streaming), RPC
rate-limit exposure that scales with fleet size × concurrent visitors, and
a cost model where seeding more routes directly degrades the storefront.

**Recommendation (accepted by owner):** decouple "what is seeded" from
"what the board verifies": a small admin-curated live list
(`config/routes.live.json`) that the board scans exactly (~6 routes → 6
calls), a capped fleet fallback for un-curated deployments, and static
in-code demo rows so a clean-slate deployment still shows a populated
board. A DB-backed `/api/routes` endpoint (single request, scales to any
fleet) remains the follow-up once a large fleet is actually seeded.

---

## Low

### FPA-L01 — Two unused Outfit font weights downloaded on every visit

**File:** `dapp/index.html`

The Google Fonts request loaded Outfit at six weights (300–800). Grep of
all Tailwind weight utilities and CSS `font-weight` declarations shows
only 400/500/600/700 (plus one synthesized 650) are ever used; **300 and
800 are downloaded and never drawn**. Press Start 2P and VT323 are
single-weight and correctly loaded.

**Recommendation:** trim the request to the four used weights. No family,
stack, or rendered output changes.

### FPA-L02 — Per-flight polling scales linearly with active flights

**File:** `dapp/src/hooks/useContracts.ts` (`useFlightDataBatch`,
`usePolicyStateBatch`)

Markets and Policies poll `get_flight_data` once per active flight every
30 s (bounded by a 50-concurrent worker pool). Harmless at today's volume;
at hundreds of simultaneously active flights it becomes a steady RPC drain
per open tab.

**Recommendation:** acknowledge and defer — fold into the future
`/api/routes`-style aggregation endpoint when flight volume warrants it.
No action taken now.

---

## Informational

### FPA-I01 — react-router ships its `dist/development` build to production

**File:** `dapp/package.json` (react-router-dom 7.12 → 7.18.2)

The installed react-router 7.x resolves every export condition to
`dist/development/*`, and dev-warning strings are present in the
production bundle — which pattern-matches a known class of bundler
misconfiguration. Investigated to ground truth: react-router 7.18.2's
`dist/development` and `dist/production` artifacts are **byte-identical**
(371,987 vs 371,988 bytes; the dual-build scaffolding exists but the
builds are not yet differentiated upstream). There is no size or behavior
win available; an alias to the production files was prototyped and
deliberately discarded as fragile complexity with zero benefit.

**Recommendation:** none required. Re-check when upgrading react-router
past the point where upstream actually differentiates the builds.

---

## Positive observations

- Static assets are already lean: `public/` totals 188 KB, the hero art is
  pixel-style PNG, CSS is 70 KB (13.6 KB gzip).
- `useRoutes` streams partial chunk results into the query cache on first
  scan, and background refetches never shrink the visible list — good UX
  discipline around a slow scan.
- The demo-row fallback keeps the board honest (`DEMO` badges, explicit
  "no live markets" note) rather than faking liveness.
- React Query polling is focus-gated by default, so backgrounded tabs do
  not multiply RPC load.
