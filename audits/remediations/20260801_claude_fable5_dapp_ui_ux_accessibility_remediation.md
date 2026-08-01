# Claude Fable 5 Dapp UI UX & Accessibility Audit (2026-08-01) — Remediation Summary

**Source report:** [`20260801_claude_fable5_dapp_ui_ux_accessibility_report.md`](../20260801_claude_fable5_dapp_ui_ux_accessibility_report.md)
**Audited commit:** `dc49540`; remediated on top of `c15a56a` after the
same-day build/config (PR #101), code-quality (PR #102), and security
remediations — several findings landed there and are credited below.
**Remediation date:** 2026-08-01
**Test status:** `tsc -b --noEmit` clean; `oxlint` clean (3 known
fast-refresh warnings); production `vite build` green. Browser-verified
live: the BetSlip opens as a real dialog (`role="dialog"`,
`aria-modal`, labelled by its title, focus lands inside, Escape closes);
calendar arrow keys move REAL DOM focus between day buttons
(`2026-08-02 → 2026-08-03` observed) with the container tab stop gone
and 7 ARIA rows exposed; both marquee loops are `aria-hidden` with a
single-copy static list present; the House page shows three "6-hour"
mentions, two MAX buttons, and zero "ERC-4626" occurrences; no console
errors on any checked page.

| ID | Severity | Verdict | Status |
|----|----------|---------|--------|
| UX-H1 | High | Confirmed | ✅ Fixed — 6h delay stated in both queue hints, the fineprint, and the HowItWorks bubble |
| UX-H2 | High | Confirmed | ✅ Fixed — live "UNLOCKS IN ~Xh Ym" / "READY" countdown on every own queue entry |
| UX-H3 | High | Confirmed | ✅ Fixed — dedicated error state with retry; empty state gated on `!loadFailed` |
| UX-H4 | High | Confirmed | ✅ Fixed — `stagedSigner` flips states at the actual wallet invocation |
| UX-H5 | High | Confirmed | ✅ Fixed — roving DOM focus, valid grid rows, live month announcement |
| UX-H6 | High | Confirmed | ✅ Fixed — dialog semantics, initial focus, Tab trap, Escape, focus return |
| UX-M1 | Medium | Confirmed | ✅ Fixed — every stepper flow now also raises a sticky error toast |
| UX-M2 | Medium | Confirmed | ✅ Fixed — `humanizeTxError` translation layer; raw stays in console |
| UX-M3 | Medium | Confirmed | ✅ Fixed (PR #102) — `useTxFlow` passes `txHash` on every success toast |
| UX-M4 | Medium | Confirmed | ✅ Fixed — failures on non-reporting wallets get a check-your-network tip |
| UX-M5 | Medium | Confirmed | ✅ Fixed — MAX button + insufficient-balance validation on deposit |
| UX-M6 | Medium | Confirmed | ✅ Fixed — live "≈ X USDC" preview + MAX (exact share balance) on withdraw |
| UX-M7 | Medium | Confirmed | ✅ Fixed (scoped) — House stat tiles + TopBar chip distinguish failed from loading |
| UX-M8 | Medium | Confirmed | ✅ Fixed — lamp + ✓/✕ glyph + screen-reader text |
| UX-M9 | Medium | Confirmed | ✅ Fixed — clones aria-hidden; static list becomes the reduced-motion layout |
| UX-M10 | Medium | Confirmed | ✅ Fixed (PR #101, BC-M4) — pre-paint `/theme-init.js` |
| UX-M11 | Medium | Confirmed | ✅ Fixed — processing-time share price stated at the deposit CTA |
| UX-M12 | Medium | Confirmed | ✅ Fixed (main leaks) — Policies outcomes/live labels, network banner, jargon; small ops surfaces deferred |
| UX-L1 | Low | Confirmed | ✅ Fixed (security pass, SEC-I1) — network-derived explorer URLs |
| UX-L2 | Low | Confirmed | 📝 Mitigated as-is — the address-transition watcher already toasts the disconnect |
| UX-L3 | Low | Confirmed | ✅ Fixed — TransactionButton `title` prop; BetSlip explains the missing date |
| UX-L4 | Low | Confirmed | ✅ Fixed (security pass, SEC-L3) — decimal-string `parseUsdc`; display truncation kept deliberately |
| UX-L5 | Low | Confirmed | ✅/📝 — wheel listener fixed (PR #102, CQ-M3); node keyboard focus deferred (mirrored list is the accessible path, per the report's own assessment) |
| UX-L6 | Low | Confirmed | ✅ Fixed — arrow/Home/End navigation + focus-first-item on the wallet menu |
| UX-L7 | Low | Confirmed | ✅ Fixed — mobile toast stack drops below the wrapped header, full-width |

---

## 1. The two-phase vault (UX-H1, UX-H2, UX-M11)

The 6-hour reality is now stated everywhere an LP decides or waits:

- **Copy** (`copy.ts`, both voices): `depositQueueHint` — "Deposits
  queue for a ~6-hour safety delay, then shares mint … at the share
  price when processed, not when queued" (covers UX-M11's pricing
  disclosure at the CTA); `queueHint` — "Cash-outs unlock after a
  ~6-hour safety delay, then pay out as the vault frees capital";
  the House fineprint and the shared HowItWorks bubble both carry the
  delay + pricing sentence.
- **Countdowns** (`House.tsx`): a module constant mirrors the on-chain
  `LP_PRICING_DELAY_SECS` (6h, `contracts/risk_vault/src/constants.rs` —
  no getter exposes it; the comment records the source). Every one of
  the user's own queue entries — deposits and withdrawals — now renders
  `requested_at + delay` as a live label on a 30s clock:
  "UNLOCKS IN ~5h 42m" while the delay runs, then
  "READY — AWAITING NEXT POOL PASS", separating the two waiting reasons
  the report called out. The report's optional claimable-flip toast was
  not added — the existing "READY TO COLLECT" section appearing is
  already the visible state change; revisit if users miss it.
- **Jargon:** "ERC-4626-style" removed from both fineprints (Ethereum
  vocabulary on a Stellar app); the mechanics description stands alone.

## 2. Transaction UX (UX-H4, UX-M1, UX-M2, UX-M4)

- **UX-H4:** new `stagedSigner(step, signTransaction)` wrapper in
  `useTxFlow` — flows now run `verifying` through the RPC
  build/simulate, flip to `awaiting` (CHECK WALLET…) at the moment the
  wallet's `signTransaction` is actually invoked, and to `confirming`
  once the signature returns. All six flows (buy, deposit,
  queue-withdrawal, collect, claim, mint) converted; the House/Policies
  steppers now show all three stages.
- **UX-M1:** every flow passes `notifyError: true` — errors reach the
  NotificationProvider's deliberately-sticky error toasts (read/copy at
  leisure) in addition to the self-resetting inline stepper. (Explorer
  links on success — UX-M3 — were already universal via PR #102's
  `useTxFlow`.)
- **UX-M2:** new `lib/errors.ts` `humanizeTxError()`: wallet
  declines → "Signature request was declined in the wallet.",
  underfunded → "Insufficient balance…", `Error(Contract, #n)` → a
  sentence with the code, bad-seq and timeout patterns, and a
  160-char cap so an XDR/diagnostic blob can never hit the UI (fun
  theme uppercases the stepper line — a blob would have been worst
  there). The raw error still goes to `console.error` for support.
  Used by `useTxFlow` and House's cancel handlers.
- **UX-M4:** wallets that never report a network (everything beyond
  Freighter/HOT) can't trip the mismatch banner — so when a signing
  flow fails on such a wallet, the error now appends "(Tip: this wallet
  doesn't report its network — check that it's on TESTNET.)". Declined
  signatures are exempt (the user's own action needs no tip). A
  permanent passive "network unverified" badge was considered and
  rejected as always-on noise; the failure-time hint targets the actual
  moment of confusion.

## 3. Loading / error states (UX-H3, UX-M7)

- **UX-H3 (`Policies.tsx`):** `isError` from both queries now branches
  to a `role="alert"` panel — "Couldn't load your policies — the
  network didn't respond / Your policies are safe on-chain…" — with a
  RETRY button wired to both refetches. The "No policies yet" empty
  state is gated on `!loadFailed`, so an RPC outage can never tell an
  insured user they hold nothing.
- **UX-M7 (scoped):** the three House pool tiles backed by single reads
  (TVL / backing / free) show "—" on query error instead of an eternal
  "…", with one shared `role="status"` line — "Some pool numbers didn't
  load — retrying automatically." The TopBar balance chip does the
  same with a tooltip. The StatsTicker was left as-is: it's a marquee
  of nine mixed-source values where per-item error states would be
  unreadable; its values already render "…"/"—" per source.

## 4. Accessibility (UX-H5, UX-H6, UX-M8, UX-M9, UX-L6)

- **UX-H6 (`Markets.tsx` BetSlip):** the portal is now a real modal —
  `role="dialog" aria-modal="true" aria-labelledby="betslip-title"`,
  panel focused on open (`tabIndex={-1}`), Tab/Shift-Tab trapped within
  the panel's focusables, Escape closes, and focus returns to the
  opener on unmount. Browser-verified end to end.
- **UX-H5 (`FlightCalendar.tsx`):** arrowing now moves REAL DOM focus —
  an effect focuses the `data-day` button matching `focusDay`, so the
  focus ring is visible and screen readers announce each day; the
  container's `tabIndex={0}` is gone (single roving tab stop); weeks
  are wrapped in `role="row"` via `display: contents` (valid
  grid → row → gridcell without breaking the CSS grid); the weekday
  header row exposes `role="columnheader"` with full names; the month
  title is `aria-live="polite"`; Escape returns focus to the field.
- **UX-M8 (`Status.tsx`):** pass/fail is now lamp + ✓/✕ glyph +
  visually-hidden "last run passed/failed/no recent run".
- **UX-M9 (`Markets.tsx` + `index.css`):** both marquee loops are
  `aria-hidden` (no more 4× repetition to screen readers) with a
  single-copy `.ticker-static` list that is visually hidden while the
  marquee animates and becomes the visible flex-wrapped layout under
  `prefers-reduced-motion` — the frozen `overflow-hidden` strip that
  made content unreachable is gone.
- **UX-L6 (`TopBar.tsx`):** the wallet menu focuses its first item on
  open and supports ArrowUp/Down (wrapping), Home, and End.

## 5. Forms (UX-M5, UX-M6, UX-L3, UX-L7)

- **UX-M5:** deposit gains a MAX button (exact wallet balance via the
  new `unitsToInput()` — no-grouping decimal string that round-trips
  through `parseUsdc` to the last unit) and a pre-submit "That's more
  USDC than your wallet holds." message mirroring withdraw's, wired
  into both the guard and the disabled state.
- **UX-M6:** withdraw gains MAX (exact share balance) and a live
  "≈ X USDC at the current share price" preview under the input, fed by
  the already-existing `useConvertToAssets` on the typed amount.
- **UX-L3:** `TransactionButton` accepts a `title` shown only while
  disabled-and-not-busy; the BetSlip CTA explains "Pick a flight date
  first." when the date is the missing piece.
- **UX-L7:** on ≤640px the toast stack drops to `top: 112px` (below
  the two-row wrapped TopBar) and spans the viewport width minus
  margins instead of hugging a 340px column.

## 6. Copy voice (UX-M12)

The remaining theme-voice leaks with user reach are closed: all Policies
outcome strings ("ON TIME — NO PAYOUT", "DELAYED — PAID", …) and the
live-tracking labels moved into `copy.ts` with proper sentence-case
serious variants; the network-mismatch banner reads from
`t.wallet.mismatchBanner`. Still outside copy.ts, deliberately: the
Status page and Admin console (ops surfaces with a single voice), the
RiskBar tooltip, and ActivityLog internals — recorded here so a future
localization pass knows where they are. (The fun hero and all
transaction toasts were already centralized in PR #102.)

## Already fixed by earlier same-day passes (verified, not re-done)

- **UX-M3** — explorer link on every success toast: PR #102's
  `useTxFlow` returns `txHash` from all six flows.
- **UX-M10** — pre-paint theme stamp: PR #101's `/theme-init.js`
  (external file — the CSP has no `unsafe-inline`), verified live then.
- **UX-L1** — network-derived explorer URLs: security pass (SEC-I1).
- **UX-L4** — decimal `parseUsdc`: security pass (SEC-L3).
  `formatUsdc`'s 2-decimal truncation is kept deliberately (a balance
  display should never overstate); a 0.009 balance showing "0.00" is
  the accepted cost.
- **UX-L5 (wheel half)** — native non-passive wheel listener: PR #102
  (CQ-M3), browser-verified.

## Deferred (with reasoning)

- **UX-L5 (node focus half):** globe nodes stay click-only. The report
  itself rates the page "acceptable overall" — the mirrored list is the
  keyboard/screen-reader path, and the stage already has arrow-key
  rotation + zoom. Adding 100+ SVG tab stops would degrade keyboard
  navigation more than it helps.
- **UX-L2:** wallet-error sign-outs already surface as the
  "WALLET DISCONNECTED" warning toast via the address-transition
  watcher in ActivityLog — a second toast from the provider would
  duplicate it. No change.
