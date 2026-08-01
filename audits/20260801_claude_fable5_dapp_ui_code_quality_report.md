# Claude Fable 5: Dapp UI Code Quality Review

**Assessment date:** 1 August 2026

**Report version:** v1.0

**Assessment status:** Final

**Assessment type:** AI-Assisted React/TypeScript Code Quality Review

**Auditor:** Claude Fable 5

---

## Assessment Information

| | |
| --- | --- |
| Project | Sentinel Protocol — FLIGHTS.FUN dapp |
| Component | Frontend UI — `dapp/src/**` (~13k lines) |
| Stack | React 19, Vite 7, TypeScript 5.9, @tanstack/react-query 5, react-router-dom 7, Tailwind 4 |
| Snapshot date | 2026-08-01 |

**Scope:** all of `dapp/src` — `App.tsx`, `main.tsx`, providers, hooks, data
layer, client-side contract wrappers, `lib/` and `util/`, all components, and
all six large pages read in full (Admin 1348 lines, Markets 1066,
MarketsGlobe 715, House 699, Quant 536, Policies 494). Focus: missing React /
TypeScript good practices, correctness hazards, and structure.

**Finding IDs:** `CQ-<severity><n>` (H = high, M = medium, L = low).

---

## Summary

| ID | Severity | Title |
| --- | --- | --- |
| CQ-H1 | High | No React error boundary anywhere in the app |
| CQ-M1 | Medium | Stale closure in the wallet polling loop |
| CQ-M2 | Medium | Globe deep-link can be consumed against demo data |
| CQ-M3 | Medium | Globe wheel-zoom `preventDefault()` is a no-op (passive listener) |
| CQ-M4 | Medium | ~8 hand-rolled copies of the tx state machine instead of one hook |
| CQ-M5 | Medium | Quant Monte Carlo runs synchronously on every slider tick |
| CQ-M6 | Medium | `useContractSync` is an `any`-cast per-page convention |
| CQ-M7 | Medium | Admin page typed `any` end-to-end |
| CQ-M8 | Medium | Admin route search fires a request per keystroke |
| CQ-M9 | Medium | QueryClient has no defaults; batch queries inherit retry×3 + focus refetch |
| CQ-M10 | Medium | Formatting duplicated and drifting (USDC, dates, relative time) |
| CQ-M11 | Medium | Hardcoded copy bypassing `copy.ts` |
| CQ-L1…L9 | Low | See below |

---

## Findings

### CQ-H1 (High) — No React error boundary anywhere in the app

- **Where:** `dapp/src/App.tsx`, `main.tsx` — grep for `ErrorBoundary|componentDidCatch|getDerivedStateFromError` returns zero hits.
- **Issue:** any render-time throw in a page (e.g. an unexpected shape behind the `tx.result as X` casts) unmounts the entire React tree to a white screen. The three `React.lazy` pages (`App.tsx:21-23`) sit inside `<Suspense>` (`App.tsx:68`) with no boundary: a failed dynamic `import()` — the classic stale-deploy / chunk-hash-changed case — is an unhandled rejection that blanks the app with no retry path.
- **Fix:** wrap `<Routes>` (or each route) in an error boundary with a "reload" fallback; optionally a second boundary around the whole shell.

### CQ-M1 (Medium) — Stale closure in the wallet polling loop

- **Where:** `dapp/src/providers/WalletProvider.tsx:162-192`.
- **Issue:** the mount-once effect captures the first render's `updateCurrentWalletState` (defined at :102, closing over `address`/`network`/`networkPassphrase`, all `undefined` on first render). Every subsequent 1-second poll runs that first closure, so the change checks at :111-120 and :140-143 always compare against `undefined`: the "did it change?" logic is permanently defeated, `storage.setItem("walletAddress", …)` (:144) runs every second, and the code only behaves because React bails out on identical setState values.
- **Fix:** move `updateCurrentWalletState` into the effect and read current values from a ref (or use `useEffectEvent` / functional updates); consider 5s instead of `POLL_INTERVAL = 1000` (:56) for calls that may hit the wallet extension.

### CQ-M2 (Medium) — Deep-link from the globe can be consumed before live routes arrive

- **Where:** `dapp/src/pages/Markets.tsx:585-599`.
- **Issue:** the `?flight=` effect searches `displayRoutes`, which is the random 14-row DEMO sample (:80-84, from `DEMO_ROUTES` = `randomSample(...)` in `config/routes.ts:104`) while the chunked chain scan is still streaming. The param is deleted unconditionally (:596-597) even when no match was found, so the effect is one-shot against the wrong list: linking `/markets?flight=AA100` intermittently opens nothing.
- **Fix:** only consume the param once real routes have loaded (or on match), e.g. gate on `!isDemo || match`.

### CQ-M3 (Medium) — Globe wheel-zoom `preventDefault()` is a no-op

- **Where:** `dapp/src/pages/MarketsGlobe.tsx:161-164`.
- **Issue:** React 17+ attaches `wheel` at the root as a passive listener, so `e.preventDefault()` in `onWheel` cannot cancel scrolling; the page scrolls while the globe zooms, plus a console error in dev.
- **Fix:** attach a native non-passive `wheel` listener via ref + `addEventListener("wheel", h, { passive: false })` with cleanup.

### CQ-M4 (Medium) — Chain writes are ~8 copies of a hand-rolled tx state machine

- **Where:** `Markets.tsx:368-417` (BetSlip), `House.tsx:175-277` (deposit, cancel-deposit, request-withdrawal, cancel-withdrawal, collect — plus 5 parallel `TxState` + 5 error-string states, :88-107), `Policies.tsx:237-272` (claim), `TopBar.tsx:125-140` (mint).
- **Issue:** each repeats guard → set state → build tx → `signAndSend` → invalidate → `setTimeout` back to idle → catch/format. React Query is installed but `useMutation` is used only in Admin. The `setTimeout`s (`Markets.tsx:408-415`, `House.tsx:171,195,236,273`, `Policies.tsx:257-270`) are never cleared, so state updates fire after unmount (benign in React 19, but the BetSlip one also calls `onClose()` late), and behavior drifts between flows (some toast on error, some don't).
- **Fix:** extract one `useTxFlow` / `useContractMutation` hook (state machine + error formatting + invalidation keys + timed reset with cleanup).

### CQ-M5 (Medium) — Monte Carlo runs synchronously on every slider tick

- **Where:** `dapp/src/pages/Quant.tsx:336-339`, core at :151-211.
- **Issue:** worst case `runs × travelers` = 5,000 × 1,000 = 5M RNG calls inside `useMemo`, re-run per pixel of slider drag — tens of ms to 100ms+ per frame on mid hardware; visible jank.
- **Fix:** wrap the inputs in `useDeferredValue`, and/or replace the inner per-traveler loop with a normal-approximation / inverse-CDF binomial sample so cost is O(runs), not O(runs × travelers).

### CQ-M6 (Medium) — `useContractSync` is an `any`-cast on singletons every write-page must remember to call

- **Where:** `dapp/src/hooks/useContracts.ts:33-48`.
- **Issue:** `(client as any).options.publicKey = address` defeats typing, and the sync only happens in components that call the hook (TopBar, Markets, House, Policies). A future page doing writes without it silently builds transactions with `publicKey: undefined`.
- **Fix:** type the options access properly (the generated `Client` exposes `options`) and centralize the sync once (e.g. in `WalletProvider` or a module-level subscription).

### CQ-M7 (Medium) — Admin page typed `any` end-to-end

- **Where:** `dapp/src/pages/Admin.tsx:309-310` (`routes: any[]`, `interventions: any[]`), :457-459, :515, :580, :726, :996, :1166, :1284.
- **Issue:** every API row is `any`, so all field access (`r.on_chain?.terms?.premium`, `s.revived_at`, `o.delay_minutes`, …) is unchecked; an API rename becomes a runtime `undefined`/NaN in the ops console.
- **Fix:** declare interfaces for the five `/api/admin/*` payloads and type the client as `api<T>()`.

### CQ-M8 (Medium) — Admin route search fires a request per keystroke

- **Where:** `dapp/src/pages/Admin.tsx:247-261`, :683-688.
- **Issue:** `routeQuery` goes straight into the `queryKey`, so typing "JFK" issues 3 fetches, and without `placeholderData: keepPreviousData` the table flashes to "Reading the board…" on each key.
- **Fix:** debounce the value feeding the key (~300ms) and set `placeholderData: keepPreviousData`.

### CQ-M9 (Medium) — QueryClient has no defaults

- **Where:** `dapp/src/main.tsx:20` — `new QueryClient()` with no `defaultOptions`.
- **Issue:** most hooks set `retry: 1`, but `useFlightDataBatch` (`useContracts.ts:475-501`) and `usePolicyStateBatch` (:534-578) don't, so a down RPC gets 3 exponential retries per 30s tick across N flights; every chain query also refetches on window focus on top of its interval.
- **Fix:** `defaultOptions: { queries: { retry: 1, refetchOnWindowFocus: false, staleTime: 15_000 } }`, with per-hook overrides.

### CQ-M10 (Medium) — Formatting duplicated and drifting

- USDC: `formatUsdc`/`USDC_DIVISOR` (`useContracts.ts:50-59`) vs Admin's own `usd = Number(units)/1e7` (`Admin.tsx:41-42` — loses bigint precision and renders `$` instead of USDC) vs `SHARE_PRICE_SCALE = 10_000_000` (`derived.ts:168`). Decimals are at least consistently 7.
- Relative time: `relTime(iso)` (`lib/utils.ts:9-16`) vs near-identical `timeAgo(ms)` (`ActivityLog.tsx:55-62`).
- Dates: `formatDate` (`lib/utils.ts:18-22`) vs ad-hoc `toUTCString().slice(...)` (`Admin.tsx:1008/1012/1016`, `Status.tsx:62`) vs `toISOString().slice(0,16)` (`Admin.tsx:1317`).
- **Fix:** one `format.ts` (usdc, date, relative-time) imported everywhere.

### CQ-M11 (Medium) — Hardcoded copy bypassing `copy.ts`

- **Where:** `Markets.tsx:698-712` — the fun-mode hero hardcodes "INSURE YOUR FLIGHT. / GET PAID IF IT'S LATE." and the sub-paragraph, verbatim duplicates of `t.markets.heroLine1/heroLine2/heroSub` (`copy.ts:34-37`) used three lines above for serious mode — a guaranteed drift point. User-facing notification strings are also hardcoded English: `Markets.tsx:403`, `House.tsx:191-193/211/234/252/271`, `Policies.tsx:251-254`, `TopBar.tsx:132/136`.
- **Fix:** route these through `useCopy()`.

### Low

- **CQ-L1** — `util/storage.ts:40-62` `getItem` defaults to `"fail"` mode and `WalletProvider.tsx:106-109` calls it uncaught; a non-JSON legacy value throws inside `pollWalletState`, emitting an unhandled rejection and permanently killing the polling loop (the next `setTimeout` at :173 is never scheduled). Use `"safe"` mode. (Same finding as security report SEC-L4.)
- **CQ-L2** — `util/wallet.ts:110-124` `fetchBalances` mutates the Horizon response in place, replacing numeric-string `b.balance` with a locale-formatted string ("1,234.5") while keeping the `BalanceLine` type; any future consumer that parses `balance` gets NaN past 999. Map to a new display field.
- **CQ-L3** — `util/wallet.ts:70-79` fire-and-forget `getNetwork().then(...)` with no `.catch` → unhandled rejection if the wallet call fails during connect.
- **CQ-L4** — `Admin.tsx:232` `const invalidate = () => qc.invalidateQueries()` invalidates every query in the app after any admin action; scope to the `admin-*` keys.
- **CQ-L5** — Index key on a reordering list: `Admin.tsx:580` (`history.map((r, i) => key={i})` — run history shifts as new runs land). Other index keys (static headers, ticker clones, etc.) are fine.
- **CQ-L6** — `useContracts.ts` pervasive `tx.result as X` casts (:76, :99, :113, :123, :164, …) discard the generated bindings' result types; contract interface changes stay silent in TypeScript.
- **CQ-L7** — Contract IDs hardcoded in six source files (`src/contracts/*.ts:6`) while rpcUrl/passphrase come from env; a redeploy means editing six files (relevant to the pending vault-redeploy runbook).
- **CQ-L8** — `Markets.tsx:379` `await authRes.json()` throws a raw `SyntaxError` into the user-facing error line when the API returns an HTML error page; use the `.catch(() => ({}))` pattern Admin's `api()` already uses (`Admin.tsx:36`).
- **CQ-L9** — `House.tsx:579,611` `withdrawalQueue!` non-null assertions; guarded by `hasQueue` today, fragile to refactors.

---

## Good practices already present

- **Code splitting done right:** MarketsGlobe (d3-geo + world-atlas), Quant, and Admin (sole supabase-js consumer) are `React.lazy` with a Suspense fallback and documented rationale (`App.tsx:18-23`); the heavy topojson merge runs at module load of the lazy chunk, not the landing page.
- **React Query used consistently for all chain reads** — no ad-hoc `useEffect`+fetch anywhere; sensible per-query `refetchInterval` tiers (15/30/60/300s); `enabled` guards on address-dependent queries; a chunked route scan that streams partial results into the cache on first load (`useContracts.ts:313-362`) plus a concurrency-capped batch fetcher (:453-473).
- **Mutations invalidate the right key prefixes** after buy/deposit/withdraw/claim/mint, so balances and queues refetch after tx confirmation.
- **Animation/observer hygiene:** FlightBackground cancels rAF and removes its resize listener; `useCountUp` cancels rAF; Markets' ResizeObserver disconnected; WalletProvider's poll timer cleared with an `isMounted` flag; `prefers-reduced-motion` respected in both animation sites.
- **Structure:** providers memoize context values; a thin data facade (`src/data/index.ts`) decouples pages from the hook layer; typed localStorage wrapper; centralized `errorMessage`/`txHashOf`; `copy.ts` enforces fun/serious key parity via a derived type; demo data honestly labeled throughout.
- **Accessibility touches:** `aria-sort` on sortable headers, roving-tabindex keyboard calendar, `aria-live` tx steppers, sticky `role="alert"` error toasts, keyboard-rotatable globe.

## Extraction opportunities for the big pages

- **Admin.tsx (1348):** split the five tab panels into files; extract the pagination footer (identical block at :824-851, :1045-1072, :1252-1279); type + extract the `api()` client and payload interfaces.
- **Markets.tsx (1066):** `BetSlip` (~210 lines, self-contained portal) to `components/`; `Ticker`/`StatsTicker`/`usePublicStats` to their own module; board search/sort/pagination into a `useBoardControls` hook.
- **MarketsGlobe.tsx (715):** the `Globe` SVG component (~400 lines) to its own file; projection/drag/zoom state into a `useOrthographicGlobe` hook (natural home for the CQ-M3 fix).
- **House.tsx (699):** the `useTxFlow` hook (CQ-M4) collapses ten state variables and five handlers into five one-liners; split Deposit / Position / CashOut panels.
