# Claude Fable 5: Dapp Build, Tooling & Config Review

**Assessment date:** 1 August 2026

**Report version:** v1.0

**Assessment status:** Final

**Assessment type:** AI-Assisted Build/Tooling/Configuration Review

**Auditor:** Claude Fable 5

---

## Assessment Information

| | |
| --- | --- |
| Project | Sentinel Protocol — FLIGHTS.FUN dapp |
| Component | `dapp/` build & deploy configuration |
| Files | `package.json`, `package-lock.json`, `vite.config.ts`, `tsconfig*.json`, `index.html`, `vercel.json`, `vercel.backend.json`, `.vercelignore`, `.oxlintrc.json`, `.env` / `.env.example`, `.gitignore`, `README.md`, `rebuild-bindings.sh`, repo CI (`.github/workflows/*`) |
| Snapshot date | 2026-08-01 |

**Finding IDs:** `BC-<severity><n>` (H = high, M = medium, L = low, I = info).

---

## Summary

| ID | Severity | Title |
| --- | --- | --- |
| BC-H1 | High | No dapp job in CI — typecheck/lint/build never run automatically |
| BC-M1 | Medium | No `functions.maxDuration` in either Vercel config despite README relying on 300s |
| BC-M2 | Medium | Linting is effectively not wired up |
| BC-M3 | Medium | No SEO/social/theme meta in index.html |
| BC-M4 | Medium | Theme FOUC — no inline theme bootstrap script |
| BC-M5 | Medium | Weak CSP — only `frame-ancestors` |
| BC-L1 | Low | No `engines` field, no `.nvmrc` |
| BC-L2 | Low | Duplicate stellar-sdk majors in the lockfile (nested under Trezor) |
| BC-L3 | Low | stellar-wallets-kit loaded eagerly with `defaultModules` |
| BC-L4 | Low | No preconnect hints for RPC/Supabase origins |
| BC-L5 | Low | `.env.example` missing vars the README documents |
| BC-L6 | Low | No `noUncheckedIndexedAccess` in any tsconfig |
| BC-L7 | Low | `rebuild-bindings.sh` ships a DEBUG block; `set -eo` without `-u` |
| BC-I1…I6 | Info | See below |

---

## Findings

### BC-H1 (High) — No dapp job in CI

- **Where:** `.github/workflows/ci.yml`, `deploy-docs.yml`.
- **Issue:** `ci.yml` is 100% Rust/contracts (cargo test/clippy/fmt/audit, wasm size); `deploy-docs.yml` is the Docusaurus site. Nothing runs `npm run typecheck` or `vite build` for `dapp/`.
- **Consequence:** a PR can break the frontend/api TypeScript and merge green; the first failure signal is the Vercel deploy.
- **Fix:** add a `dapp` job (Node 22: `npm ci && npm run install:contracts && npm run typecheck && vite build`), plus the lint from BC-M2.

### BC-M1 (Medium) — No `functions.maxDuration` in either Vercel config

- **Where:** `dapp/vercel.json`, `dapp/vercel.backend.json`, `dapp/README.md:319` ("The 5-minute schedules … and `maxDuration: 300` require Vercel Pro").
- **Issue:** neither JSON has a `functions` block, so cron functions get Vercel's default duration. The settle/queue jobs do simulate→sign→send→poll loops that can exceed defaults.
- **Consequence:** when the backend config is flipped on (`mv vercel.backend.json vercel.json`), long sweeps get killed mid-run.
- **Fix:** add `"functions": { "api/cron/*.ts": { "maxDuration": 300 } }` (or per-function values) to `vercel.backend.json`.

### BC-M2 (Medium) — Linting is effectively not wired up

- **Where:** `dapp/.oxlintrc.json`, `dapp/package.json`.
- **Issue:** `.oxlintrc.json` exists (react/typescript/oxc plugins, only 2 explicit rules), but there is **no `lint` script**, **oxlint is not in devDependencies or the lockfile** — the config's own `$schema` points at `./node_modules/oxlint/configuration_schema.json`, which doesn't exist. No prettier config, no husky/lint-staged, no lint in CI.
- **Consequence:** the lint config is decorative unless someone runs oxlint via editor extension or ad-hoc `npx`.
- **Fix:** add `oxlint` to devDependencies, a `"lint": "oxlint"` script, and run it in the BC-H1 CI job.

### BC-M3 (Medium) — No SEO/social/theme meta in index.html

- **Where:** `dapp/index.html`.
- **Issue:** missing all `og:*` and `twitter:*` tags, `theme-color`, canonical URL. For a consumer-facing product ("FLIGHTS.FUN"), shared links render with no card.
- **Fix:** add og:title/description/image/url, twitter:card, and theme-color for both schemes.

### BC-M4 (Medium) — Theme FOUC: no inline theme bootstrap script

- **Where:** `dapp/index.html`, `dapp/src/providers/ThemeProvider.tsx:63`.
- **Issue:** `data-theme` is set in a React effect after hydration; `index.html` has no inline script reading localStorage. A user on the non-default theme/scheme gets a flash of the default on every load.
- **Fix:** tiny inline `<script>` in `<head>` that reads the two localStorage keys and stamps `data-theme`/`data-scheme` on `<html>` before paint. (Same finding as UX-M10 in the UX report.)

### BC-M5 (Medium) — Weak CSP; no Permissions-Policy; HSTS lacks includeSubDomains

- **Where:** `dapp/vercel.json`, `dapp/vercel.backend.json`.
- **Issue:** CSP is just `frame-ancestors 'none'` (good for clickjacking, duplicating X-Frame-Options), with no `default-src`/`script-src`/`connect-src` and no `Permissions-Policy` header.
- **Consequence:** no XSS-payload containment for a wallet dApp — the class of app where CSP matters most.
- **Fix:** full CSP (`default-src 'self'`; `connect-src` RPC/Horizon/Supabase; fonts origins; `wasm-unsafe-eval` may be needed for the wasm plugin) plus `Permissions-Policy: camera=(), microphone=(), geolocation=()`. (Same finding as SEC-M1 in the security report.)

### BC-L1 (Low) — No `engines` field, no `.nvmrc`

README says "Node.js 20.19+ (or 22.12+, required by Vite 7)" but nothing
enforces it; Vercel and contributors can build on mismatched Node.
**Fix:** `"engines": { "node": ">=22.12" }` + `.nvmrc`.

### BC-L2 (Low) — Duplicate stellar-sdk majors in the lockfile

`package-lock.json`: root **16.1.0** (line ~3800) plus **14.2.0** nested
under `@trezor/blockchain-link-utils` and `@trezor/blockchain-link`
(transitive from stellar-wallets-kit). `vite.config.ts` `resolve.dedupe`
pins bundled imports to the root 16.1.0, so the browser bundle is protected;
the 14.2.0 copies only bloat `node_modules`/install time. Only one
`@stellar/stellar-base` exists. Acceptable; worth knowing.

### BC-L3 (Low) — stellar-wallets-kit loaded eagerly with `defaultModules`

`dapp/src/util/wallet.ts` statically imports `StellarWalletsKit` +
`defaultModules` (pulls every wallet module including heavy Trezor/Ledger
deps). Heavy pages are route-lazy (`App.tsx`: MarketsGlobe/Quant/Admin — covers
d3-geo/world-atlas), but the kit + stellar-sdk land in the entry chunk; no
`manualChunks` either. **Fix (optional):** dynamic-import the kit on first
connect click, or add a `manualChunks` vendor split.

### BC-L4 (Low) — No preconnect hints for RPC/Supabase origins

`index.html` preconnects only to Google Fonts; the first RPC call to
`soroban-testnet.stellar.org` / Horizon / Supabase pays full DNS+TLS setup.
**Fix:** add `<link rel="preconnect">` for those origins. Related: Google
Fonts is a third-party runtime dependency — self-hosting the three families
would remove it.

### BC-L5 (Low) — `.env.example` missing documented vars

README's env list includes `SALE_MIN_LEAD_SECS`, `SETTLE_AFTER_ETA_SECS`,
`ROUTES_CONFIG_PATH`, `EXPOSURE_ELEVATED_PCT`, `EXPOSURE_SEVERE_PCT` — none
appear in `.env.example`. The local `.env` also lacks `RENDER_API_KEY` and
`CONTRACT_OWNER_ADDRESS`. **Fix:** add them (empty, same comment style).

### BC-L6 (Low) — No `noUncheckedIndexedAccess`

`tsconfig.app.json` / `tsconfig.api.json` / `tsconfig.node.json` all have
`strict`, `verbatimModuleSyntax`, `noUnusedLocals/Parameters`,
`noFallthroughCasesInSwitch`, `erasableSyntaxOnly` — good. Missing
everywhere: `noUncheckedIndexedAccess` (most valuable for the api/ job code
indexing into API responses); `noImplicitOverride` /
`exactOptionalPropertyTypes` optional extras. **Fix:** enable at least in
`tsconfig.api.json`.

### BC-L7 (Low) — `rebuild-bindings.sh` hygiene

Lines 10–16 print an `=== DEBUG ===` dump (ls of project root) on every run;
`set -eo pipefail` lacks `-u`. Cosmetic.

### Informational

- **BC-I1 — `postgres` in `dependencies` is correct and does not leak into the client.** Zero imports under `src/` (verified); only `api/_lib/governance/db.ts` uses it. Vite bundles only from the `src/main.tsx` graph. It must stay in `dependencies` because Vercel functions need it at runtime; `@vercel/node` in devDependencies is right (types only).
- **BC-I2 — Pinned wallet-critical deps are a deliberate good call.** `@creit.tech/stellar-wallets-kit` exact `2.5.0`, `@stellar/stellar-sdk` exact `16.1.0` (`package.json:24-25`). For signing-path deps, exact pins + lockfile protect against a compromised patch release; caret ranges elsewhere are fine with the committed lockfile.
- **BC-I3 — No UI test script (confirmed).** Only `test:e2e*` scripts (tsx-driven pipeline/testnet suites); no vitest/RTL for components. The e2e suites are substantial, so this is a conscious trade-off, but React code has zero coverage.
- **BC-I4 — `dapp/.env` IS git-covered.** `dapp/.gitignore` doesn't mention `.env`, but repo-root `.gitignore:5` (`.env`) matches at any depth; verified with `git check-ignore -v dapp/.env` and `git ls-files` (untracked). Optional hardening: add `.env*` / `!.env.example` to `dapp/.gitignore` so the protection survives a repo split.
- **BC-I5 — envPrefix verified consistent.** `vite.config.ts:33` `envPrefix: "PUBLIC_"` matches `.env.example`'s claims; server secrets have no prefix and cannot be bundled. `nodePolyfills` is configured minimally (`include: ["buffer"]`, Buffer global only). Prod sourcemaps: off (Vite default).
- **BC-I6 — vercel.json vs vercel.backend.json / .vercelignore state is coherent and documented.** Active `vercel.json` has no crons; `.vercelignore` excludes `api/`; `vercel.backend.json` holds the cron-ready config; README (:183-189) documents the flip. Tiny doc drift: vercel.backend.json has 10 crons, README says "all 11 cron schedules".

---

## Good practices already present

- Three-project `tsc -b` composite covering src + api/scripts/config + vite.config, all strict, wired into `build`.
- `resolve.dedupe` for stellar-sdk/base with an explanatory comment (and the lockfile shows exactly the nesting it defends against).
- Security headers present (frame-ancestors, XFO DENY, nosniff, Referrer-Policy, HSTS); SPA rewrite correctly excludes `/api`.
- Minimal node polyfills (buffer only); route-level code splitting for the globe/quant/admin pages.
- Cron auth fails closed (401 without CRON_SECRET), documented in `.env.example`.
- Exceptional README: setup, env var semantics, deploy state, bot tiers, plan caveats, e2e architecture.
- `.env` properly ignored; exact pins on signing-path dependencies; `--strictPort` dev servers.

## Priority order

1. Add the dapp CI job (BC-H1) and wire up oxlint in it (BC-M2).
2. Add `functions.maxDuration` to `vercel.backend.json` before the backend flip (BC-M1).
3. Full CSP + Permissions-Policy (BC-M5, with SEC-M1).
4. Inline theme bootstrap + social meta + preconnects in `index.html` (BC-M4, BC-M3, BC-L4).
5. `engines`/`.nvmrc`, `.env.example` completeness, `noUncheckedIndexedAccess` (BC-L1, BC-L5, BC-L6).
