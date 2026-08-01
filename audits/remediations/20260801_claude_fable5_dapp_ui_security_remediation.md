# Claude Fable 5 Dapp UI Security Audit (2026-08-01) — Remediation Summary

**Source report:** [`20260801_claude_fable5_dapp_ui_security_report.md`](../20260801_claude_fable5_dapp_ui_security_report.md)
**Audited commit:** `dc49540`; remediated on top of `c15a56a` (after the
same-day build/config PR #101 and code-quality PR #102, which already
resolved several of this report's findings — noted per-finding below)
**Remediation date:** 2026-08-01
**Test status:** `tsc -b --noEmit` clean; `oxlint` clean (3 known
fast-refresh warnings); production `vite build` green;
`npx npm@10 ci --dry-run` passes after the fontsource dependency
addition (lockfile regenerated with npm 10, per the CI lockfile
incident earlier the same day). Browser-verified: **zero requests to
`fonts.googleapis.com`/`fonts.gstatic.com`** — all three families load
as same-origin woff2 (`press-start-2p`/`vt323`/`outfit` latin subsets
confirmed in the resource log), `document.fonts.check` passes for each,
and every page renders with no console errors. `parseUsdc`
unit-checked: `"0.29"` → exactly `2900000`; `"12.3abc"`, `"1e3"`, `""`,
`"-5"` all → `0n`; `".5"` → `5000000`; 8th decimal truncated.

| ID | Severity | Verdict | Status |
|----|----------|---------|--------|
| SEC-M1 | Medium | Confirmed | ✅ Fixed (PR #101, BC-M5) — full CSP on both Vercel configs; tightened further here (fonts origins dropped) |
| SEC-L1 | Low | Confirmed | ✅ Fixed — admin session moved to `sessionStorage`; CSP is the primary mitigation |
| SEC-L2 | Low | Confirmed | ✅ Fixed — signing blocked on network mismatch (buttons + useTxFlow guard) |
| SEC-L3 | Low | Confirmed | ✅ Fixed — pure decimal-string parsing, no float detour |
| SEC-L4 | Low | Confirmed | ✅ Fixed (PR #102, CQ-L1) — `"safe"` storage reads in the wallet poll |
| SEC-L5 | Low | Confirmed | ✅ Fixed — fonts self-hosted via @fontsource; Google origins removed from HTML and CSP |
| SEC-I1 | Info | Confirmed | ✅ Fixed — explorer URLs derived from `stellarNetwork` |
| SEC-I2 | Info | Confirmed | ✅ Fixed (PR #101) — `includeSubDomains` + `Permissions-Policy`; `preload` deliberately deferred |
| SEC-I3 | Info | Confirmed | ✅ Documented — residual single-RPC trust noted at the `rpcUrl` definition |
| SEC-I4 | Info | Confirmed | ✅ Fixed — faucet button not rendered when `stellarNetwork === "PUBLIC"` |
| SEC-I5 | Info | Confirmed | ✅ Partly (PR #102) — `formatUsdc` now sign-aware; truncation kept deliberately |
| SEC-I6 | Info | Confirmed | ✅ Partly (PR #102) — Admin's `Number()/1e7` replaced by bigint `usdFromUnits`; Horizon display path accepted |

---

## Fixed in this pass

### SEC-L2 — Signing blocked on network mismatch

Two layers. **UI:** every signing control is disabled while
`networkMismatch` is true — the BetSlip buy button, House's
deposit/queue-withdrawal/collect `TransactionButton`s and both cancel
buttons, the Policies claim button, and the TopBar mint button (the
existing banner explains why). **Defense in depth:** `useTxFlow.run()`
itself refuses to start while the wallet positively reports a different
network, surfacing the same "switch networks" message through the
stepper and an error toast — so any future flow added without the
disabled-prop wiring still can't sign. The FSA-L01 design property is
preserved and its comment updated: the flag only trips when the
wallet's network is *positively known* to differ, so an unknown or
unreported network (the non-Freighter wallets the report notes never
set a passphrase) can never lock a user out. The report's optional
"network unverified" passive hint for those wallets was not added —
judged UX noise for a warn-only state the app can't act on; revisit if
support tickets say otherwise.

*Files:* `src/hooks/useTxFlow.ts`, `src/pages/{Markets,House,Policies}.tsx`,
`src/components/TopBar.tsx`, `src/App.tsx` (comment).

### SEC-L3 — `parseUsdc` decimal parsing

Rewritten as strict decimal-string parsing: regex-validated
digits-with-optional-point, fraction truncated/padded to 7 digits,
assembled with BigInt arithmetic only. `"0.29"` now signs as exactly
2,900,000 units (the float path lost 1 stroop); junk-suffixed input,
scientific notation, and negatives all parse to `0n`, which every
caller's `<= 0n` guard already treats as "nothing entered" (buttons
stay disabled) — strictly safer than `parseFloat`'s silent
acceptance of `"1e3"`.

*Files:* `src/lib/format.ts`.

### SEC-L5 — Fonts self-hosted

The three families now come from `@fontsource/outfit` (400/500/600/700),
`@fontsource/press-start-2p`, and `@fontsource/vt323` (all SIL OFL),
imported in `main.tsx` and bundled by Vite as same-origin, hashed woff2
assets. The Google stylesheet link and both fonts preconnects are gone
from `index.html`, and the CSP on **both** Vercel configs tightened to
`style-src 'self' 'unsafe-inline'` / `font-src 'self'` — closing the
styles-only injection surface and the per-visit IP disclosure the
report flagged. Lockfile regenerated with npm 10 and `npm ci`
dry-run-verified, so the new deps don't re-trigger the CI lockfile
failure mode.

*Files:* `package.json`, `package-lock.json`, `src/main.tsx`,
`index.html`, `vercel.json`, `vercel.backend.json`.

### SEC-L1 — Admin JWT out of localStorage

`lib/supabase.ts` passes `auth: { storage: window.sessionStorage }`:
the admin session survives reloads but dies with the tab, shrinking the
window in which an injected script (already constrained by the CSP, the
primary mitigation) could lift the token. Documented trade-off: the
magic-link flow establishes the session in the tab the link opens
(Supabase detects it from the URL there); other already-open tabs no
longer inherit it via storage events — admins work in the link's tab.
The report's alternative (shortening the Supabase JWT TTL) is a
dashboard-side setting, out of repo scope — flagged here for the
operator.

*Files:* `src/lib/supabase.ts`.

### SEC-I1 — Explorer links follow the configured network

New `lib/explorer.ts` derives the Stellar.expert network segment from
`stellarNetwork` (`PUBLIC` → `public`, everything else → testnet);
`NotificationProvider` re-exports it for its existing importers and
Admin's hardcoded testnet URL now calls the helper. A mainnet redeploy
can no longer point receipts at the wrong explorer.

*Files:* `src/lib/explorer.ts` (new),
`src/providers/NotificationProvider.tsx`, `src/pages/Admin.tsx`.

### SEC-I3 — Residual RPC trust documented

The single-endpoint trust assumption (display and simulation both come
from `PUBLIC_STELLAR_RPC_URL`; the wallet prompt is the user's real
verification point; `allowHttp` restricted to LOCAL prevents the MITM
downgrade, leaving endpoint compromise as the accepted residual) is now
stated at the `rpcUrl` definition itself, where the next maintainer
will see it.

*Files:* `src/contracts/util.ts`.

### SEC-I4 — Faucet gated off mainnet

The TopBar `+MINT` button renders only when
`stellarNetwork !== "PUBLIC"` — the mainnet flip can no longer ship a
faucet button pointing at a token that doesn't exist there. The balance
chip itself remains on all networks.

*Files:* `src/components/TopBar.tsx`.

## Already fixed by the same-day PRs (verified, not re-done)

- **SEC-M1** — PR #101 (BC-M5/SEC-M1 shared finding) deployed the full
  CSP on `vercel.json` and synced `vercel.backend.json`:
  `default-src 'self'`, `script-src 'self' 'wasm-unsafe-eval'`, scoped
  `connect-src`, `object-src 'none'`, `base-uri 'self'`,
  `form-action 'self'`. This pass tightened it further by dropping the
  two Google fonts origins (SEC-L5). The wallet-flow compatibility of
  this exact policy was separately audited in PR #101 (all 12
  `defaultModules()` wallets verified unaffected).
- **SEC-I2** — PR #101 added `includeSubDomains` to HSTS and the
  `Permissions-Policy: camera=(), microphone=(), geolocation=()`
  header. **`preload` deliberately not added:** submitting to the
  preload list is a hard-to-reverse commitment for the whole registered
  domain and shouldn't be signaled before the production domain is
  final (the same open item as the og:url/canonical follow-up in the
  build/config remediation).
- **SEC-L4** — PR #102 (CQ-L1 shared finding) switched all four wallet
  poll reads to `storage.getItem(key, "safe")`. The report's "(and
  connectWallet)" aside needs nothing: `util/wallet.ts` only ever
  *writes* storage.
- **SEC-I5 / SEC-I6 (partly)** — PR #102's `lib/format.ts` made
  `formatUsdc` sign-aware (negative i128 now renders `-1,234.56`
  instead of garbling) and replaced Admin's `Number(units)/1e7` with
  bigint-precise `usdFromUnits`.

## Accepted / no action (with reasoning)

- **SEC-I5 truncation:** `formatUsdc` still truncates to 2 decimals
  rather than rounding — deliberate for a balance display (never
  overstates what the user holds); display-only.
- **SEC-I6 Horizon balances:** `Number(b.balance)` in
  `fetchBalances` feeds a locale formatter on a display-only field
  (raw string preserved separately since CQ-L2); precision loss starts
  above 2^53 stroops (~900M USDC) — accepted.
- **SEC-I3:** inherent to any single-RPC frontend — documented rather
  than "fixed"; a second verification endpoint would be a product
  decision, not a patch.
