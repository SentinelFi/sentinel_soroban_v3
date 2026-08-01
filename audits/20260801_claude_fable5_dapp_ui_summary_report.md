# Claude Fable 5: Dapp UI Audit — Summary & Priorities

**Assessment date:** 1 August 2026

**Report version:** v1.0

**Assessment status:** Final

**Auditor:** Claude Fable 5

---

This is the index for the four-part dapp UI review of 2026-08-01 (~13k lines
of `dapp/src` plus build/deploy config; every finding verified against
source):

| Report | Scope | Findings |
| --- | --- | --- |
| [Security](20260801_claude_fable5_dapp_ui_security_report.md) | XSS, wallet/signing flow, secret boundary, headers, storage, admin client | 0 H / 1 M / 5 L / 6 I |
| [Code quality](20260801_claude_fable5_dapp_ui_code_quality_report.md) | React/TS practices, hooks, state, structure | 1 H / 11 M / 9 L |
| [UX & accessibility](20260801_claude_fable5_dapp_ui_ux_accessibility_report.md) | Tx UX, forms, error states, a11y, theme, vault-queue comms | 6 H / 12 M / 7 L |
| [Build & config](20260801_claude_fable5_dapp_ui_build_config_report.md) | CI, Vercel, tsconfig, lint, index.html, env hygiene | 1 H / 5 M / 7 L / 6 I |

## Overall verdict

Security fundamentals are solid: zero XSS sinks, all external links carry
`rel="noopener noreferrer"`, hardcoded contract IDs + build-time-pinned
passphrase mean no API response can redirect what the user signs, the
`PUBLIC_` env boundary is enforced by Vite, admin auth is enforced
server-side, and prior audit remediations (FSA-L01/L02/M02) visibly landed.
The real gaps are operational (no frontend CI, no content CSP, no error
boundary) and product-level (the two-phase vault's 6h delay is invisible to
users).

## Cross-cutting top priorities

1. **Communicate the 6h vault delay and render queue countdowns** (UX-H1,
   UX-H2, UX-M11) — copy says "queues briefly"; `requested_at` is already
   fetched but never rendered. Known risk area from the two-phase pricing
   change; this is the pending frontend work.
2. **Add a React error boundary** (CQ-H1) — any render throw or stale-deploy
   chunk-load failure currently white-screens the app with no retry.
3. **Fix the Policies error state** (UX-H3) — an RPC outage tells users with
   active coverage "No policies yet".
4. **Add a dapp CI job** (BC-H1) and wire up oxlint (BC-M2) — typecheck/build
   currently never run automatically.
5. **Ship a full CSP** (SEC-M1 / BC-M5) plus Permissions-Policy and HSTS
   hardening — the missing browser-level backstop for a wallet dApp.
6. **Accessibility highs** (UX-H5, UX-H6) — FlightCalendar keyboard focus is
   invisible/inaudible; the BetSlip overlay lacks dialog semantics and a
   focus trap.
7. **Tx flow polish** (UX-H4, UX-M1–M3) — stepper labels out of sync with
   signing, errors self-destruct in 3–4s, raw `HostError` strings shown,
   no explorer link on success; best fixed together via the shared
   `useTxFlow` hook (CQ-M4).
8. **Theme FOUC** (UX-M10 / BC-M4) — inline pre-hydration theme stamp in
   `index.html`.

## Mainnet-redeploy checklist items surfaced by this review

- Replace float parsing in `parseUsdc` (SEC-L3).
- Derive explorer links from `stellarNetwork` (SEC-I1).
- Remove/gate the header faucet button (SEC-I4).
- Centralize the six hardcoded contract IDs (CQ-L7).
- Update CSP `connect-src` origins (SEC-M1).
- Add `functions.maxDuration` before flipping `vercel.backend.json` (BC-M1).
