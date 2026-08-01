# Claude Fable 5 Dapp UI Code Quality Audit (2026-08-01) — Remediation Summary

**Source report:** [`20260801_claude_fable5_dapp_ui_code_quality_report.md`](../20260801_claude_fable5_dapp_ui_code_quality_report.md)
**Audited commit:** `dc49540` (main; remediated in the same working tree as the build/config remediation of the same date)
**Remediation date:** 2026-08-01
**Test status:** `tsc -b --noEmit` clean across all three projects;
`oxlint` clean (0 errors; the 3 deliberate fast-refresh warnings on the
provider files remain); production `vite build` green with the chunk
graph unchanged (main ≈345 KB gzip, Admin/Globe/Quant still route-lazy).
Browser-verified on a dev preview: all seven routes render with **zero
console errors**; the globe's wheel event is now actually cancelable
(`defaultPrevented: true` on a dispatched wheel); the Quant simulation
at 1,000 travelers × 2,000 trials returns mean −$30,153 against the
analytic −$30,000 expectation, confirming the O(runs) sampler is
statistically sound while recomputing behind `useDeferredValue`.

| ID | Severity | Verdict | Status |
|----|----------|---------|--------|
| CQ-H1 | High | Confirmed | ✅ Fixed — error boundaries at root and around the routes/Suspense |
| CQ-M1 | Medium | Confirmed | ✅ Fixed — poll loop reads current state through a ref |
| CQ-M2 | Medium | Confirmed | ✅ Fixed — deep-link param survives until live routes load |
| CQ-M3 | Medium | Confirmed | ✅ Fixed — native non-passive wheel listener; verified in-browser |
| CQ-M4 | Medium | Confirmed | ✅ Fixed — one `useTxFlow` hook; all six stepper flows converted |
| CQ-M5 | Medium | Confirmed | ✅ Fixed — O(runs) binomial sampler + `useDeferredValue` |
| CQ-M6 | Medium | Confirmed | ✅ Fixed — typed, centralized in WalletProvider; hook deleted |
| CQ-M7 | Medium | Confirmed | ✅ Fixed — 10 payload interfaces + generic `api<T>()`; zero `any` |
| CQ-M8 | Medium | Confirmed | ✅ Fixed — 300 ms debounce + `keepPreviousData` |
| CQ-M9 | Medium | Confirmed | ✅ Fixed — QueryClient `defaultOptions` |
| CQ-M10 | Medium | Confirmed | ✅ Fixed — single `lib/format.ts`; duplicates deleted |
| CQ-M11 | Medium | Confirmed | ✅ Fixed — hero + all tx notifications through `copy.ts` |
| CQ-L1 | Low | Confirmed | ✅ Fixed — `"safe"` storage reads in the poll loop |
| CQ-L2 | Low | Confirmed | ✅ Fixed — `displayBalance` field; raw `balance` untouched |
| CQ-L3 | Low | Confirmed | ✅ Fixed — `.catch` + console context on the connect-time `getNetwork` |
| CQ-L4 | Low | Confirmed | ✅ Fixed — invalidation scoped to `admin-*` keys via predicate |
| CQ-L5 | Low | Confirmed | ✅ Fixed — run-history keys use `ran_at` |
| CQ-L6 | Low | Confirmed | ✅ Fixed — every `tx.result as X` cast removed; binding types flow |
| CQ-L7 | Low | Confirmed | ✅ Fixed — one `contracts/ids.ts` with `PUBLIC_*_ID` env overrides |
| CQ-L8 | Low | Confirmed | ✅ Fixed — `.json().catch(() => ({}))` on the sale-auth response |
| CQ-L9 | Low | Confirmed | ✅ Fixed — non-null assertions replaced by a defaulted local |

---

## High

### CQ-H1 — Error boundaries

New `components/ErrorBoundary.tsx` (class component,
`getDerivedStateFromError` + `componentDidCatch` logging) with a
RELOAD / BACK TO BOARD fallback. Mounted twice: in `App.tsx` **outside**
`<Suspense>` — so a failed `React.lazy` chunk load (the stale-deploy
case) rejects through Suspense into the boundary instead of
white-screening — and at the root in `main.tsx` as a last resort above
the providers. The fallback deliberately uses theme-independent copy:
the root boundary can catch before `useCopy`/`useTheme` are usable.

*Files:* `src/components/ErrorBoundary.tsx` (new), `src/App.tsx`,
`src/main.tsx`.

## Medium

### CQ-M1 + CQ-L1 — Wallet polling loop

`WalletProvider` now keeps a `current` ref mirroring
address/network/passphrase (updated every render); the mount-once poll
reads through it, so the change checks compare against live values
instead of the first render's `undefined`s — `walletAddress` is written
on actual change, not once per second. The four storage reads use
`"safe"` mode: a legacy non-JSON value returns `null` instead of
throwing, which previously killed the loop permanently (the next tick
was never scheduled). `POLL_INTERVAL` stays at 1000 ms **deliberately**
(the report suggested considering 5 s): each tick is normally just four
localStorage reads — the wallet extension is only queried for Freighter
or when no address is stored — and a 5 s tick would make connect feel
sluggish, since the kit modal's result is picked up from storage by this
same loop.

*Files:* `src/providers/WalletProvider.tsx`.

### CQ-M2 — Globe deep-link vs. demo data

The `?flight=` effect now returns early (param intact) when there is no
match **and** the board is still on the demo sample; it consumes the
param on a match, or once the live list has loaded and genuinely lacks
the flight. The `eslint-disable` on the dependency array is gone — the
effect's deps are now honest (`displayRoutes` identity is stable between
scans).

*Files:* `src/pages/Markets.tsx`.

### CQ-M3 — Globe wheel zoom

The `onWheel` prop is replaced by a native `wheel` listener on the stage
ref registered with `{ passive: false }` (with cleanup). Verified live:
a dispatched cancelable wheel event reports `defaultPrevented: true`,
so the page no longer scrolls under the globe.

*Files:* `src/pages/MarketsGlobe.tsx`.

### CQ-M4 — One tx state machine (`useTxFlow`)

New `hooks/useTxFlow.ts` owns the whole sequence every chain write used
to hand-roll: idle-guard → caller-driven step transitions → success
toast (with explorer link) → scoped query invalidation → timed reset →
`onSettled`. Errors are formatted once (`errorMessage`), surfaced on
`flow.error` for the stepper, optionally toasted, and **all timers are
cleared on unmount** — the late `onClose()`/setState after unmount and
the per-page behavioral drift are gone. Converted flows: BetSlip buy
(Markets), deposit / queue-withdrawal / collect (House), claim
(Policies), faucet mint (TopBar) — the mint gaining a proper
awaiting/confirming state and an explorer link in the process. The two
cancel actions (deposit/withdrawal) keep their simpler busy-id shape:
they have no stepper UI and no timers to leak, so the hook would add
state they don't render; their notifications now come from `copy.ts`
like everything else.

*Files:* `src/hooks/useTxFlow.ts` (new), `src/pages/Markets.tsx`,
`src/pages/House.tsx`, `src/pages/Policies.tsx`,
`src/components/TopBar.tsx`.

### CQ-M5 — Monte Carlo cost

Two changes: a `sampleBinomial` helper replaces the per-traveler
Bernoulli loop with a continuity-corrected normal approximation
(Box–Muller) whenever `n·p·(1−p) > 9` — dropping the worst case from
runs×travelers (5M) RNG calls to ~2×runs (10k) — with the exact loop
retained for small-variance inputs where the approximation is weak; and
all six simulation inputs feed the `useMemo` through `useDeferredValue`,
so the slider thumb and readouts update at input priority while the
simulation recomputes in a deferred render. The seeded-PRNG determinism
is preserved (same inputs → same distribution across renders).

*Files:* `src/pages/Quant.tsx`.

### CQ-M6 — Contract-client publicKey sync

The sync now lives in `WalletProvider` — one effect over all six client
singletons, running for every page — and is **typed**: the generated
clients expose `readonly options: ClientOptions`, so
`client.options.publicKey = address` needs no cast at all (the old
`as any` was never necessary). `useContractSync` is deleted along with
its four per-page call sites; a future write page can no longer forget
it.

*Files:* `src/providers/WalletProvider.tsx`, `src/hooks/useContracts.ts`,
`src/data/index.ts`, plus the four former call sites.

### CQ-M7 — Admin typed end-to-end

`api()` is now `api<T>(): Promise<T>`, and ten interfaces mirror the
actual `api/admin/*` response shapes (verified against the handlers):
`AdminRoute`/`RoutesResponse`, `AdminIntervention`/`InterventionsResponse`,
`JobRegistryEntry`/`JobRun`/`JobsResponse`/`JobRunResult`,
`AdminOutcome`/`OutcomesResponse`, `AdminAction`/`ActionsResponse`.
Every `any[]` prop and `(r: any)` lambda is gone; an API field rename is
now a compile error instead of a runtime `undefined` in the ops console.

*Files:* `src/pages/Admin.tsx`.

### CQ-M8 — Route search request-per-keystroke

New `hooks/useDebouncedValue.ts` (trailing-edge, 300 ms); the debounced
value feeds the `admin-routes` query key while the input stays
immediate. `placeholderData: keepPreviousData` added to the routes,
interventions, and outcomes queries, so neither typing nor page turns
flash the "Reading the board…" row.

*Files:* `src/hooks/useDebouncedValue.ts` (new), `src/pages/Admin.tsx`.

### CQ-M9 — QueryClient defaults

`main.tsx` constructs the client with
`defaultOptions.queries = { retry: 1, refetchOnWindowFocus: false,
staleTime: 15_000 }`. The two batch hooks (`useFlightDataBatch`,
`usePolicyStateBatch`) that previously inherited retry×3 + focus
refetch now get one retry and no focus refetch; per-hook settings
override where present.

*Files:* `src/main.tsx`.

### CQ-M10 — One formatting module

New `lib/format.ts`: `formatUsdc` (now sign-aware) / `parseUsdc` /
`usdFromUnits` (bigint-precise dollar display for the admin unit
strings — replaces Admin's `Number(units)/1e7`, which lost bigint
precision), `relTime` (accepts ISO string or epoch-ms — absorbing
ActivityLog's near-duplicate `timeAgo`, now deleted), `formatDate`,
`utcDateTime`, `isoMinute`. Admin's three ad-hoc `toUTCString().slice`
calls, its `toISOString().slice` stamp, and Status's `as of` line all go
through the helpers. `useContracts` re-exports `formatUsdc`/`parseUsdc`
so the many existing import sites keep working against the single
implementation; `lib/utils.ts` keeps only `cn`/`errorMessage`/`txHashOf`.

*Files:* `src/lib/format.ts` (new), `src/lib/utils.ts`,
`src/components/ActivityLog.tsx`, `src/pages/{Admin,Status,Policies}.tsx`,
`src/hooks/useContracts.ts`.

### CQ-M11 — Copy through `copy.ts`

The fun-mode hero now renders `t.markets.heroLine1/heroLine2/heroSub` —
the former verbatim duplicates are deleted; a tiny `EmphasizeDelayed`
helper re-applies the red accent to the word "delayed" inside the copy
string, so the styling survived centralization. A new `notify` section
(fun + serious variants, shape-checked by the existing derived `Copy`
type) carries every transaction notification: mint success/failure,
cover purchase, deposit queued/cancelled, withdrawal
queued/cancelled/collected, claim.

*Files:* `src/copy.ts`, `src/pages/{Markets,House,Policies}.tsx`,
`src/components/TopBar.tsx`.

## Low

- **CQ-L2** — `fetchBalances` no longer mutates the Horizon rows: each
  entry is `{ ...b, displayBalance }` (`WalletBalance` type), keeping
  `balance` as Horizon's raw numeric string. No current consumer read
  the formatted value (verified), so nothing else changed.
  *Files:* `src/util/wallet.ts`.
- **CQ-L3** — the fire-and-forget `getNetwork()` during connect has a
  `.catch` that logs with context instead of emitting an unhandled
  rejection. *Files:* `src/util/wallet.ts`.
- **CQ-L4** — Admin's `invalidate` uses a predicate over query keys
  starting with `admin-`, so an admin action no longer refetches every
  chain query in the app. *Files:* `src/pages/Admin.tsx`.
- **CQ-L5** — the run-history chips key on `r.ran_at` (unique per run)
  instead of the array index that shifted as new runs landed.
  *Files:* `src/pages/Admin.tsx`.
- **CQ-L6** — all ~20 `tx.result as X` casts in `useContracts.ts` are
  deleted; the generated bindings' `AssembledTransaction<T>` result
  types flow through unmodified, so a contract interface change now
  fails `tsc` instead of staying silent. *Files:*
  `src/hooks/useContracts.ts`.
- **CQ-L7** — the six hardcoded contract IDs moved to
  `src/contracts/ids.ts`: one edit point for the pending vault
  redeploy, with `PUBLIC_*_ID` env vars as a build-time override (same
  precedence pattern as `rpcUrl`). *Files:* `src/contracts/ids.ts`
  (new), `src/contracts/{controller,governance_module,oracle_aggregator,risk_vault,mock_usdc,flight_pool_manager}.ts`.
- **CQ-L8** — the sale-auth `authRes.json()` uses
  `.catch(() => ({}))` (same pattern as Admin's `api()`), so an HTML
  error page surfaces as the HTTP error message, not a raw
  `SyntaxError`. *Files:* `src/pages/Markets.tsx`.
- **CQ-L9** — House's `withdrawalQueue!` assertions replaced by a
  `withdrawalQueueRows = withdrawalQueue ?? []` local that `hasQueue`,
  the rail render, and the position lookup all share. *Files:*
  `src/pages/House.tsx`.

## Not done (and why)

- **The "Extraction opportunities" section** (splitting Admin's tab
  panels / BetSlip / the Globe component into files, a shared pagination
  footer, `useBoardControls`) is layout-refactoring guidance, not
  findings; the highest-value piece of it — the tx state machine — IS
  extracted (CQ-M4). The file splits are deferred to keep this
  remediation reviewable; nothing in them blocks the fixes above.
- **Poll interval left at 1 s** — see CQ-M1: deliberate, with the
  reasoning recorded there.
