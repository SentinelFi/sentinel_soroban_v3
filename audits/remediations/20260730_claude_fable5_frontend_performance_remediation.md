# Claude Fable 5 Frontend Performance Audit (2026-07-30) — Remediation Summary

**Source report:** [`20260730_claude_fable5_frontend_performance_report.md`](../20260730_claude_fable5_frontend_performance_report.md)
**Audited commit:** `e01fba4` (main, post-PR #92 merge)
**Remediation date:** 2026-07-30 (branch `frontend_performance`)
**Test status:** `tsc --noEmit` clean; production `vite build` green; every
route driven in a production preview via Chrome DevTools with zero console
errors; wallet write path re-verified live on testnet after the SDK major
bump (faucet → `request_deposit` → queue read → `cancel_deposit` roundtrip
signed with a local key — 3 signed txs, 4 simulated reads, balances
restored exactly).

**Headline result:** first-visit JavaScript **8,877 KB → 1,124 KB
(gzip 2,485 KB → 332 KB), −87 %**, with heavy pages loading on first
navigation only and the board's RPC fan-out capped at 6 calls regardless
of fleet size.

| ID | Severity | Verdict | Status |
|----|----------|---------|--------|
| FPA-H01 | High | Confirmed | ✅ Fixed — one hoisted SDK copy + Vite dedupe guard; wallet path re-verified on testnet |
| FPA-M01 | Medium | Confirmed | ✅ Fixed — Admin/MarketsGlobe/Quant lazy-loaded; `relTime` relocated to `lib/utils.ts` |
| FPA-M02 | Medium | Confirmed | ✅ Fixed — curated `routes.live.json` + capped fleet fallback + static demo rows (owner-selected option) |
| FPA-L01 | Low | Confirmed | ✅ Fixed — font request trimmed to the four used weights; both themes visually verified |
| FPA-L02 | Low | Confirmed | 📝 Deferred — acceptable at current volume; fold into a future aggregation endpoint |
| FPA-I01 | Info | Refuted (no size impact) | ✅ No action — dev/prod artifacts byte-identical upstream; alias workaround discarded |

---

## Fixed

### FPA-H01 — stellar-sdk bundled seven times

All six `dapp/packages/*/package.json` now pin `@stellar/stellar-sdk`
`16.1.0` (exactly the root's version), collapsing seven bundled copies to
one hoisted, tree-shakeable ESM install; `vite.config.ts` adds
`resolve.dedupe` for `@stellar/stellar-sdk` + `@stellar/stellar-base` so a
future version drift in regenerated bindings degrades gracefully instead
of silently re-nesting. Verified `node_modules/*/node_modules/@stellar` is
empty after reinstall. Bundle: 8,877 KB → 1,521 KB in this step alone —
larger than predicted because v16 resolves to ESM rather than the v14
pre-minified UMD.

Because the bindings were generated against v14, the v14→v16 jump was
verified beyond compile: all pages exercised against live testnet RPC
(~25 successful `simulateTransaction` reads, `x-client-version: 16.1.0`),
plus the signed-write roundtrip described in the header — covering
transaction assembly, token `require_auth` sub-invocation auth, submission
and result decoding. The Freighter popup layer itself was already on the
root's v16 and is unchanged; one manual signed click remains a recommended
spot-check.

**Maintenance note:** regenerating bindings with a generator that pins a
different SDK version will reintroduce the nesting — keep the binding
`package.json` SDK version aligned with the root's (the dedupe guard makes
the failure soft, not invisible).

*Files:* `packages/{controller,governance_module,oracle_aggregator,risk_vault,mock_usdc,flight_pool_manager}/package.json`,
`vite.config.ts`, `package-lock.json`.

### FPA-M01 — No route-level code splitting

`App.tsx` now lazy-loads the three heavy pages via `React.lazy` behind a
`<Suspense>` fallback; Markets (the first paint) stays static. The
enabling change: `relTime` moved from `Admin.tsx` to `src/lib/utils.ts`,
severing the `Status → Admin` static edge that had welded Admin + all of
supabase-js into the main graph.

Resulting chunk graph (verified in `dist/` and live):

| Chunk | Size (gzip) | Loads |
| --- | --- | --- |
| main | 1,124 KB (332 KB) | first visit |
| Admin (incl. supabase-js) | 244 KB (64 KB) | `/admin` only |
| MarketsGlobe (d3 + world-atlas) | 144 KB (53 KB) | `/markets` only |
| Quant | 8 KB (3 KB) | `/calculator` only |

Browser-verified: the landing fetches only the main chunk; an in-app click
to LIVE fetches the globe chunk on demand; `/admin` initializes supabase
from its own chunk with no console errors.

*Files:* `src/App.tsx`, `src/pages/Admin.tsx`, `src/pages/Status.tsx`,
`src/lib/utils.ts`.

### FPA-M02 — Per-route RPC scan scales with the fleet

Owner selected the curated-list option (a DB-backed `/api/routes` endpoint
was offered and parked for when a large fleet is actually seeded). The
board's candidate source is now, in order:

1. **`config/routes.live.json`** (new) — the admin-curated subset the board
   verifies on-chain; non-empty → scan exactly these (~6 routes ⇒ 6 RPC
   calls per visitor, independent of fleet size). Documented workflow in
   the file's schema note: add a route after seeding it via
   `scripts/seed_routes.ts`, remove it to take it off the board.
2. Fleet-file fallback capped at `MAX_FLEET_SCAN = 6` enabled entries, so
   an un-curated fresh seed still shows something without a scan storm.
3. `STATIC_DEMO_ROUTES` — ten built-in sample routes rendered with DEMO
   badges when both files are empty (the current clean-slate deployment),
   so the demo board is never blank.

Browser-verified on the clean-slate testnet: board shows 10 demo rows with
the honest "no live markets whitelisted on-chain" note, zero route-scan
RPC traffic.

*Files:* `config/routes.live.json` (new), `src/config/routes.ts`.

### FPA-L01 — Unused font weights

`index.html`'s Google Fonts request trimmed from Outfit
`300;400;500;600;700;800` to `400;500;600;700`. No family, stack, or
weight used anywhere in `src/` changed (re-verified by grep for
light/extrabold utilities and `font-weight: 300|800` — zero matches);
FUN and SERIOUS modes visually confirmed identical.

*Files:* `index.html` (one line).

---

## Deferred

### FPA-L02 — Per-flight polling

Confirmed but acceptable at current volume (flights on the clean-slate
deployment: zero; worker pool already caps burst at 50). Revisit alongside
the `/api/routes` aggregation endpoint when active-flight counts make the
30 s × N-flights drain material. No code change.

---

## No action required

### FPA-I01 — react-router development build

Verified upstream `dist/development` and `dist/production` are
byte-identical in 7.18.2 — the finding is real as a path observation but
carries no size or behavior impact. The prototyped build-time alias to the
production files was discarded (fragile internal-path coupling for zero
byte savings). react-router-dom bumped 7.12 → 7.18.2 in passing.
