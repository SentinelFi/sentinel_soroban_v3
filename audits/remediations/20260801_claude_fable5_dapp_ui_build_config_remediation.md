# Claude Fable 5 Dapp Build/Tooling/Config Audit (2026-08-01) — Remediation Summary

**Source report:** [`20260801_claude_fable5_dapp_ui_build_config_report.md`](../20260801_claude_fable5_dapp_ui_build_config_report.md)
**Audited commit:** `dc49540` (main)
**Remediation date:** 2026-08-01
**Test status:** `npm run lint` clean (0 errors; 3 intentional fast-refresh
warnings in providers); `tsc -b --noEmit` clean across all three projects
**with `noUncheckedIndexedAccess` enabled**; production `vite build` green
(chunk graph unchanged); theme bootstrap verified live in a dev preview —
persisted `serious`/`light` restored on reload with the attributes stamped
before hydration and zero console errors.

| ID | Severity | Verdict | Status |
|----|----------|---------|--------|
| BC-H1 | High | Confirmed | ✅ Fixed — `dapp` job added to CI (Node 22: ci → bindings → lint → typecheck → build) |
| BC-M1 | Medium | Confirmed | ✅ Fixed — `functions.maxDuration: 300` for `api/cron/*.ts` in `vercel.backend.json` |
| BC-M2 | Medium | Confirmed | ✅ Fixed — oxlint installed, `lint` script added, config repaired, wired into CI |
| BC-M3 | Medium | Confirmed | ✅ Fixed — og/twitter/theme-color meta added (absolute og:url/og:image pending a final domain) |
| BC-M4 | Medium | Confirmed | ✅ Fixed — pre-paint theme stamp via external `/theme-init.js` (CSP-safe, no `unsafe-inline`) |
| BC-M5 | Medium | Confirmed | ✅ Fixed — backend config now carries the same full CSP/Permissions-Policy/HSTS as `vercel.json` |
| BC-L1 | Low | Confirmed | ✅ Fixed — `engines.node >=22.12` + `.nvmrc` (CI reads the `.nvmrc`) |
| BC-L2 | Low | Confirmed | 📝 No action — accepted per the report: `resolve.dedupe` protects the bundle; nested copies only cost install size |
| BC-L3 | Low | Confirmed | 📝 Deferred — optional; wallet-kit lazy-load / `manualChunks` left for a dedicated perf pass |
| BC-L4 | Low | Confirmed | ✅ Fixed — preconnects for RPC/Horizon/Supabase origins |
| BC-L5 | Low | Confirmed | ✅ Fixed — five documented vars added to `.env.example`; local `.env` completed |
| BC-L6 | Low | Confirmed | ✅ Fixed — `noUncheckedIndexedAccess` on in `tsconfig.api.json`; all 31 resulting errors fixed |
| BC-L7 | Low | Confirmed | ✅ Fixed — DEBUG block removed; `set -euo pipefail` |
| BC-I1/I2/I3/I5 | Info | Confirmed | 📝 No action — positive/accepted findings |
| BC-I4 | Info | Confirmed | ✅ Hardened — `.env*` / `!.env.example` added to `dapp/.gitignore` |
| BC-I6 | Info | Confirmed | ✅ Fixed — README cron count corrected (11 → 10, matching `JOB_REGISTRY` and `vercel.backend.json`) |

---

## Fixed

### BC-H1 — No dapp job in CI (+ BC-M2 lint wiring)

`.github/workflows/ci.yml` gains a second job `dapp` (runs alongside the
Rust job): `actions/setup-node@v4` pinned via `dapp/.nvmrc` with npm cache,
then `npm ci` → `npm run install:contracts` (builds the committed binding
packages) → `npm run lint` → `npm run typecheck` → `npx vite build`. The
frontend build needs no env vars in CI — every `PUBLIC_*` read in
`src/contracts/util.ts` has a fallback (verified before wiring the job).

*Files:* `.github/workflows/ci.yml`.

### BC-M1 — `functions.maxDuration` for the cron functions

`vercel.backend.json` now declares
`"functions": { "api/cron/*.ts": { "maxDuration": 300 } }`, so when the
backend config is flipped on (`mv vercel.backend.json vercel.json`) the
settle/queue sweeps get the 300s the README already documents as required
(Vercel Pro) instead of the platform default.

*Files:* `vercel.backend.json`.

### BC-M2 — Linting wired up for real

`oxlint` (v1.76.0) added to devDependencies with a `"lint": "oxlint"`
script; the config's `$schema` path now resolves. `.oxlintrc.json` also
gains `ignorePatterns` for the generated `packages/` bindings and `dist/`
(the bulk of the old noise), and `no-unused-vars` is configured with
`ignoreRestSiblings` (the api/admin endpoints use rest-destructuring to
strip the `full_count` window column — idiomatic, not dead code) plus
`^_` ignore patterns. Result: 0 errors, 3 warnings — all the deliberate
`react/only-export-components` warns on the provider files, which the
config itself downgraded to `warn` by design. Lint runs in the BC-H1 CI
job; `npx oxlint --deny-warnings` remains available for a stricter local
pass.

*Files:* `package.json`, `package-lock.json`, `.oxlintrc.json`.

### BC-M3 — Social/SEO/theme meta

`index.html` now carries `og:type/site_name/title/description/image`,
`twitter:card/title/description/image` (large-summary card with
`/px/hero-airport.png` as the artwork) and two `theme-color` metas keyed
by `prefers-color-scheme` (`#0b1736` dark / `#e6ecf8` light — the
`--color-page` tokens).

**Follow-up:** `og:url`, a canonical link, and absolute `og:image` URLs
still need the final production domain — no deployed URL is recorded
anywhere in the repo, and most social scrapers require absolute image
URLs. Swap the root-relative image paths for absolute ones when the
domain is fixed.

*Files:* `index.html`.

### BC-M4 — Theme FOUC eliminated

New `public/theme-init.js`, loaded as a **blocking classic script in
`<head>`**, reads the two localStorage keys (`flightsfun_theme` /
`flightsfun_scheme`) and stamps `data-theme`/`data-scheme` on `<html>`
before first paint; `<html>` also carries the `fun`/`dark` defaults
statically as a no-JS fallback. Kept external rather than inline
deliberately: the CSP (BC-M5) is `script-src 'self'` with no
`'unsafe-inline'`, which would silently block an inline bootstrap — and a
hash-sourced inline script breaks on any whitespace edit. `'self'` allows
the file, and the render-blocking fetch is same-origin and tiny.
Storage keys and defaults mirror `ThemeProvider.tsx` (noted in both
files' comments — keep in sync).

Verified live: persisted `serious`/`light` survives reload with the
attributes present and no console errors.

*Files:* `public/theme-init.js` (new), `index.html`.

### BC-M5 — Full CSP + Permissions-Policy + HSTS on the backend config

The active `vercel.json` already carried the full header set from the
security-report remediation (SEC-M1): `default-src 'self'`, `script-src
'self' 'wasm-unsafe-eval'`, scoped `connect-src` (RPC/Horizon/Supabase),
fonts origins, `Permissions-Policy: camera=(), microphone=(),
geolocation=()`, HSTS with `includeSubDomains`. This pass copied the
identical header block into `vercel.backend.json`, which still had the
weak `frame-ancestors`-only CSP — closing the gap where flipping the
backend on would have silently downgraded the site's headers.

A follow-up review of the CSP against all 12 `defaultModules()` wallet
flows confirmed none break (ten wallets are extension-injected; Albedo
and xBull connect via `window.open` popups, which CSP does not restrict)
but found one gap: OneKey's modal icon loads from
`https://uni.onekey-asset.com` — now added to `img-src` in both configs.
**Maintenance note:** `connect-src` pins the testnet RPC/Horizon origins;
a mainnet flip must update the CSP in the same commit or every RPC call
gets blocked.

*Files:* `vercel.json`, `vercel.backend.json`.

### BC-L1 — Node version enforced

`"engines": { "node": ">=22.12" }` in `package.json` plus `dapp/.nvmrc`
(`22`); the CI job reads the `.nvmrc` so the enforced version and the
tested version can't drift.

*Files:* `package.json`, `.nvmrc` (new), `.github/workflows/ci.yml`.

### BC-L4 — Preconnects for first-call origins

`index.html` preconnects (with `crossorigin`) to
`soroban-testnet.stellar.org`, `horizon-testnet.stellar.org`, and the
Supabase project origin, alongside the existing Google Fonts pair.
Self-hosting the three font families (removing the fonts third-party
dependency entirely) remains an optional follow-up.

*Files:* `index.html`.

### BC-L5 — `.env.example` / `.env` completeness

Added to `.env.example` with the README's semantics: `SALE_MIN_LEAD_SECS`,
`SETTLE_AFTER_ETA_SECS`, `ROUTES_CONFIG_PATH` (sale/settle section) and
`EXPOSURE_ELEVATED_PCT` / `EXPOSURE_SEVERE_PCT` (governance section).
The local `.env` gained the two vars it lacked relative to the example
(`RENDER_API_KEY` empty, `CONTRACT_OWNER_ADDRESS` public address).

*Files:* `.env.example`, `.env` (untracked).

### BC-L6 — `noUncheckedIndexedAccess` in `tsconfig.api.json`

Enabled for the api/scripts/config project — the code that indexes into
AeroAPI responses, RPC event topics, and SQL result rows. All 31
resulting errors were fixed properly (no `!` assertions anywhere):

- **Genuine hardening:** `aeroapi_client.getFlightData` now returns
  `flights[0] ?? null` instead of a possibly-`undefined` crossing a
  `| null` contract; `event_ingest` handles a missing `Object.keys(v)[0]`
  (`?? "Unknown"`) and empty `split("-")` parts; `sale_auth` and
  `admin/interventions` PATCH capture the row once and guard it instead
  of length-check-then-index.
- **Type-precision fixes (no behavior change):** the two
  `TESTNET_DEFAULTS` tables dropped their `Record<string, string>`
  annotations so known-key access stays `string` — `envOrDefault` is now
  `keyof typeof TESTNET_DEFAULTS`, making an unknown env name a compile
  error; `loadPublicConfig` declares its real `contractIds` shape (which
  also fixed the `admin/diagnostics` computed-key errors); the
  `full_count` pagination reads became `Number(rows[0]?.full_count ?? 0)`;
  single-row `count(*)` destructures became explicit `rows[0]?.x ?? 0`
  reads; `scripts/env.ts` guards its regex groups.

`noImplicitOverride` / `exactOptionalPropertyTypes` (the report's
optional extras) were not enabled; the app/node tsconfigs keep their
existing flags.

*Files:* `tsconfig.api.json`, `api/_lib/aeroapi_client.ts`,
`api/_lib/config.ts`, `api/_lib/governance/{config,event_ingest,interventions}.ts`,
`api/_lib/sale_auth.ts`, `api/admin/{interventions,outcomes,routes}.ts`,
`api/status/runs.ts`, `scripts/{dev_api,env}.ts`.

### BC-L7 — `rebuild-bindings.sh` hygiene

The seven-line `=== DEBUG ===` dump is gone and the shebang guard is now
`set -euo pipefail`.

*Files:* `rebuild-bindings.sh`.

### BC-I4 (hardening) — `.env` ignore survives a repo split

`dapp/.gitignore` now ignores `.env*` with an `!.env.example` exception,
so the protection no longer depends on the repo-root `.gitignore`.

*Files:* `.gitignore` (dapp).

### BC-I6 (doc drift) — cron count

README's flip instructions said "all 11 cron schedules"; `JOB_REGISTRY`
and `vercel.backend.json` both have 10. Corrected to 10.

*Files:* `README.md`.

---

## Deferred / no action

- **BC-L2 (duplicate stellar-sdk majors under Trezor):** accepted as the
  report itself concludes — `resolve.dedupe` pins the bundle to the root
  16.1.0; the nested 14.2.0 copies cost only install size. Re-check when
  stellar-wallets-kit bumps its Trezor deps.
- **BC-L3 (eager wallet-kit + no `manualChunks`):** deferred. The kit is
  initialized at module scope (`StellarWalletsKit.init` in
  `src/util/wallet.ts`) with theme wiring that touches the live DOM
  tokens; converting to a first-click dynamic import is a behavioral
  change to the signing path and belongs in a dedicated performance pass
  with wallet re-verification (as in the 2026-07-30 perf remediation),
  not a config sweep. The route-level splits from that pass remain in
  place.
- **BC-I1/I2/I3/I5:** positive findings (dependency placement, exact pins
  on signing-path deps, e2e-only test trade-off, envPrefix hygiene) — no
  action needed. BC-I3's React component test gap remains a known,
  conscious trade-off.
