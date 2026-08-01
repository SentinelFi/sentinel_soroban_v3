# Claude Fable 5: Dapp UI UX & Accessibility Review

**Assessment date:** 1 August 2026

**Report version:** v1.0

**Assessment status:** Final

**Assessment type:** AI-Assisted UX & Accessibility Review

**Auditor:** Claude Fable 5

---

## Assessment Information

| | |
| --- | --- |
| Project | Sentinel Protocol — FLIGHTS.FUN dapp |
| Component | Frontend UI — `dapp/src/**` (pages, components, styles) |
| Stack | React 19, Tailwind 4, custom theme system (fun/serious × dark/light) |
| Snapshot date | 2026-08-01 |

**Scope:** transaction UX (TxProgress/TransactionButton and every write
flow), wallet connect/disconnect UX, form and amount-input UX,
loading/empty/error states per page, accessibility (semantics, ARIA,
keyboard, focus, reduced motion, color reliance), responsive behavior, copy
and jargon, theme/FOUC, and — as a known risk area — how the two-phase
(6h-delayed) vault queues are communicated on the House page.

**Finding IDs:** `UX-<severity><n>` (H = high, M = medium, L = low).

---

## Summary

| ID | Severity | Title |
| --- | --- | --- |
| UX-H1 | High | The vault's 6-hour delay is never communicated anywhere |
| UX-H2 | High | `requested_at` fetched but never rendered — no countdown/ETA on queues |
| UX-H3 | High | RPC failure on Policies renders "No policies yet" |
| UX-H4 | High | Tx lifecycle states mislabeled relative to what's happening |
| UX-H5 | High | FlightCalendar keyboard navigation is invisible and inaudible |
| UX-H6 | High | BetSlip "modal" is not a dialog (no role, focus trap, or Escape) |
| UX-M1 | Medium | Errors vanish after 3–4s and are never toasted in most flows |
| UX-M2 | Medium | Raw SDK/contract errors surfaced verbatim |
| UX-M3 | Medium | No explorer link on any core transaction success |
| UX-M4 | Medium | Network-mismatch detection only works for Freighter/HOT |
| UX-M5 | Medium | No MAX button and no balance validation on deposit |
| UX-M6 | Medium | Withdraw denominated in shares with no USDC preview |
| UX-M7 | Medium | House/stat surfaces degrade to permanent "…" with no error affordance |
| UX-M8 | Medium | Status page pass/fail lamp is color-only and `aria-hidden` |
| UX-M9 | Medium | Marquee tickers inaccessible; clip content under reduced motion |
| UX-M10 | Medium | No pre-hydration theme script → guaranteed FOUC for non-default users |
| UX-M11 | Medium | Two-phase mint/execution pricing never explained to LPs |
| UX-M12 | Medium | Meaningful user-facing strings bypass `copy.ts` (theme-voice leaks) |
| UX-L1…L7 | Low | See below |

---

## 1. The two-phase vault (known risk area)

### UX-H1 (High) — The 6-hour delay is never communicated

Grep across `dapp/src` finds zero mention of the delay. The copy actively
understates it: "Deposits queue **briefly**, then shares mint to your wallet
automatically" (`copy.ts:118-119,404`) and "Cash-outs queue **until the vault
frees capital**" (`copy.ts:130-131,416`) — the latter implies the only wait is
capital availability, when there is also a fixed 6h minimum. A depositor
watching "150.00 USDC queued" has no idea whether "briefly" means seconds or
hours; an LP queuing a withdrawal cannot tell when step 2 (Collect) unlocks.
**Fix:** state the delay explicitly in `depositQueueHint`/`queueHint`
("processed after a ~6h safety delay at the then-current share price") and
add it to the House fineprint and the HowItWorks bubble.

### UX-H2 (High) — `requested_at` fetched but never rendered

The queue hooks return `requested_at` for both queues
(`useContracts.ts:237-271`), yet House renders only amount + position
(`House.tsx:431-460,578-654`). No "eligible at HH:MM", no countdown, no
distinction between "waiting out the 6h" and "delayed further because capital
is locked". **Fix:** compute `requested_at + delay` per entry and show a live
countdown / "ready, awaiting next pool pass" state; consider a toast/badge
when claimable flips > 0.

### UX-M11 (Medium) — Two-phase pricing never explained

The depositor's share count is unknown at request time (post-delay share
price, per the source comment at `House.tsx:180-182`) — a material fact for
LPs that lives only in a code comment. A one-line "shares are minted at the
share price after the delay" belongs next to the deposit CTA.

**Good practices already there:** cancel controls for both queues with
per-entry busy states; the withdrawal line visualized with the user's own
position highlighted ("#2 · YOU", `House.tsx:578-604`); a distinct "READY TO
COLLECT" section appearing only when `get_claimable_balance > 0`; the
fully-utilized warning informs rather than blocks (`House.tsx:144-149,
524-543`); success toasts describe queue semantics rather than pretending
instant settlement.

---

## 2. Transaction UX

### UX-H4 (High) — Tx lifecycle states mislabeled

`House.tsx:177-187` (also :222-231, :264-269), `Markets.tsx:391-400`,
`Policies.tsx:240-249`. Every write flow sets `"awaiting"` (label "CHECK
WALLET… / Sign") *before* `client.method({...})` — the RPC build/simulate
step, no wallet involved — then sets `"confirming"` *before*
`tx.signAndSend()`, which is where the wallet popup actually opens. So while
the user is being asked to sign, the UI says "CONFIRMING…", and "CHECK
WALLET…" shows during simulation. **Fix:** add a "building/simulating" stage
(or reuse `verifying`) and flip `awaiting → confirming` inside a wrapped
`signTransaction` so the state changes when the wallet is actually invoked.

### UX-M1 (Medium) — Errors vanish after 3–4 seconds, never toasted

`House.tsx:162-172` (`fail()` → `setTimeout(() => setState("idle"), 4000)`;
TxProgress returns `null` at idle; House has no error toast),
`Markets.tsx:412-416` (3s). The NotificationProvider deliberately makes error
toasts sticky ("users need time to read/copy them",
`NotificationProvider.tsx:104-107`), but deposit/withdraw/collect/buy errors
never reach it — only the self-destructing inline stepper. Policies claim is
the only flow that both toasts and inlines the error (`Policies.tsx:266`).
**Fix:** keep the inline error rendered until the next attempt and/or route
errors through `addNotification(msg, "error")` everywhere.

### UX-M2 (Medium) — Raw SDK/contract errors surfaced verbatim

`lib/utils.ts:29-41` `errorMessage()` passes through `err.message` unchanged;
Soroban failures look like `HostError: Error(Contract, #10)` plus simulation
diagnostics/XDR fragments. No mapping from contract error codes to human text
("Amount below vault minimum", user-rejected-signature, etc.). In the fun
theme it is even uppercased into the pixel stamp line (`TxProgress.tsx:195`).
**Fix:** add an error-translation layer keyed on common patterns
(`Error(Contract, #n)`, "User declined", "insufficient balance") with the raw
string demoted to a details/copy affordance.

### UX-M3 (Medium) — No explorer link on core tx successes

The infrastructure exists (`addNotification(..., { txHash })` → "View on
Stellar.expert" link, `NotificationProvider.tsx:152-161`; `txHashOf()` in
`lib/utils.ts:48-52`) but only the faucet mint uses it (`TopBar.tsx:129-134`).
Buy (`Markets.tsx:400-406`), deposit/withdraw/collect (`House.tsx`), and
claim (`Policies.tsx:249-255`) all discard the `signAndSend` result.
**Fix:** capture the result and pass `txHash: txHashOf(sent)` in each success
notification.

### UX-L1 (Low) — Explorer URL hardcodes testnet

`NotificationProvider.tsx:76-78`; derive from `stellarNetwork`.

**Good practices:** double-submit properly prevented (button disables while
busy, `TransactionButton.tsx:29-34`, plus `!== "idle"` guards and
`cancelingId`/`claimingId` mutexes); per-flow error strings so failures don't
bleed between steppers (`House.tsx:97-107`); TxProgress has `role="status"
aria-live="polite"`; elapsed-time counter in serious mode; the BetSlip's
`verifying` stage gives real feedback during the sale-auth check.

---

## 3. Wallet UX

### UX-M4 (Medium) — Network-mismatch detection only works for Freighter/HOT

`util/wallet.ts:69-79` stores network/passphrase only for
`freighter`/`hot-wallet`; `WalletProvider.tsx:132` skips `getNetwork()`
polling for everything except Freighter, and the mismatch flag intentionally
stays false on empty passphrase (`WalletProvider.tsx:194-199`). Users on
xBull/Lobstr/etc. pointed at the wrong network get no banner — their first
transaction just fails with a raw error. (Acknowledged in code as FSA-L01.)
**Fix:** a passive "network unverified" hint for non-reporting wallets, or
catch the signing failure and suggest a network check.

### UX-L2 (Low) — Wallet errors silently sign the user out

`WalletProvider.tsx:149-156` — any `getAddress`/`getNetwork` throw calls
`nullify()` with only a console.error; the session vanishes with no toast
(the ActivityLog does record the disconnect, which softens this).

**Good practices:** address truncation with copy-to-clipboard and
success/failure toasts (`TopBar.tsx:60-68`); menu closes on outside
click/Escape with `aria-haspopup`/`aria-expanded`/`role="menu"`;
StellarWalletsKit `authModal` with `defaultModules()` shows install links
when no wallet is present (`util/wallet.ts:41-48`); the modal is themed from
app tokens so it follows fun/serious/light/dark; connect/disconnect logged to
the ActivityLog including session restores; the mismatch banner has
`role="alert"` (`App.tsx:42-55`).

---

## 4. Form / input UX

### UX-M5 (Medium) — No MAX button, no balance validation on deposit

`House.tsx:394-424`: the deposit input shows wallet balance as text but never
validates `depositAssets > usdcBalance` — the user finds out via a raw
simulation error. Withdraw does validate (`insufficientShares`,
`House.tsx:128,519-523`) with a friendly message. Neither input has a
MAX/percentage shortcut — table stakes for vault UIs. **Fix:** add MAX
buttons and a pre-submit `insufficientBalance` message mirroring withdraw's.

### UX-M6 (Medium) — Withdraw denominated in shares with no USDC preview

`House.tsx:505-517` asks for "AMOUNT (SHARES)" but users think in USDC.
`useConvertToAssets` exists (`useContracts.ts:210-222`) and is already used
for the position tile; a live "≈ X USDC" line under the input (and a
"withdraw all" using the exact share balance) would prevent under/over-requests.

### UX-L3 (Low) — Disabled buttons carry no reason

`TransactionButton` renders `disabled` with no tooltip/`aria-describedby`;
e.g. the BetSlip CTA is dead until a date is picked (`Markets.tsx:510`) with
nothing pointing at the date field. (The connect/whitelist cases do get
explanatory text — good.)

### UX-L4 (Low) — `parseUsdc` float path and truncating display

`useContracts.ts:62-66` — float parsing loses precision (see security report
SEC-L3); `formatUsdc` truncates to 2dp so a 0.009 balance displays "0.00".

**Good practices:** real `<label>`-wrapped fields; `min="0"`, numeric
placeholder; negative/garbage input parses to `0n` which disables the button;
page-size select and search reset pagination correctly.

---

## 5. Loading / empty / error states

### UX-H3 (High) — RPC failure on Policies renders "No policies yet"

`Policies.tsx:106-110,292-312`: `isLoading` covers only the loading flags; if
`useTravelerFlights`/`usePolicyStateBatch` error out (retry:1 then give up),
`bets` is `[]` and the page confidently shows the empty state with a "Browse
flights" CTA. A user with active coverage during an RPC outage is told they
have no policies — for an insurance product that is a trust-destroying
message. **Fix:** branch on `isError` and show "Couldn't load your policies —
retry".

### UX-M7 (Medium) — Stat surfaces degrade to permanent "…"

`House.tsx:334-353` etc.: every read shows "…" when data is undefined,
indistinguishable between "loading" and "RPC down"; nothing ever says the
numbers failed to load or offers retry. Same for the TopBar balance chip and
StatsTicker (`Markets.tsx:271-313`).

**Good practices:** the Markets board never blocks on the chunked 200-route
chain scan — demo rows render instantly, clearly flagged DEMO/Sample with a
"SCANNING CHAIN" indicator (`Markets.tsx:74-84,576-580`;
`useContracts.ts:313-362` streams partial chunks); honest "no live markets
whitelisted" note; per-page empty states all exist (queue rail,
nothing-to-collect, no-match search with hint, globe "pick a flight"); the
Status page has loading, error, and standby states (`Status.tsx:80-93`); lazy
routes have a Suspense fallback.

---

## 6. Accessibility

### UX-H5 (High) — FlightCalendar keyboard navigation is invisible and inaudible

`FlightCalendar.tsx:129-161,221-266`: arrow keys update `focusDay` state, but
(a) no `is-focus` class is applied to the day cell — the only visual is
`:focus-visible` on the button, which never fires because DOM focus stays on
the grid container (`tabIndex={0}`, line 226), and (b) DOM focus is never
moved (`.focus()` never called), so screen readers announce nothing as the
user arrows around, and Enter selects a day they cannot perceive. The
`role="grid"` also lacks `role="row"` children (gridcells are direct children
— invalid ARIA grid), producing a double tab stop. **Fix:** on `focusDay`
change, `.focus()` the corresponding day button (proper roving tabindex),
drop `tabIndex` from the container, wrap weeks in `role="row"`, and announce
the month via `aria-live`.

### UX-H6 (High) — BetSlip "modal" is not a dialog

`Markets.tsx:419-548`: full-screen portal overlay with no `role="dialog"`, no
`aria-modal`, no focus trap, no initial focus, no Escape handler (only scrim
click and ✕). Keyboard users tab through into the obscured page; screen-reader
users are never told a dialog opened. **Fix:** `role="dialog"
aria-modal="true" aria-labelledby`, focus the panel on open, trap Tab, close
on Escape, return focus to the triggering row button.

### UX-M8 (Medium) — Color-only status lamp on the Status page

`Status.tsx:96-107`: pass/fail is conveyed solely by a green/red square that
is `aria-hidden` — screen readers get no success/failure signal, and
colorblind users must infer from the banner. **Fix:** visually-hidden
"passed/failed" text and a shape difference (✓/✕).

### UX-M9 (Medium) — Marquee tickers inaccessible; break under reduced motion

`Markets.tsx:186-218,315-335`: loop content is duplicated 4× and all copies
are exposed to screen readers (each stat read four times); with
`prefers-reduced-motion` the animation is correctly disabled
(`index.css:1165-1190`) but the strip is `overflow-hidden`, so stats beyond
the first viewport-width become permanently unreachable. **Fix:**
`aria-hidden` the clones, provide the stats in a static accessible list, and
let reduced-motion fall back to a wrapping grid.

### UX-L5 (Low) — Globe nodes are click-only

`MarketsGlobe.tsx:307,436-447` — acceptable overall because the left list
mirrors everything and the stage has `role="application"` with arrow/±-key
rotation+zoom and a descriptive `aria-label` (genuinely good), but node
`<g onClick>` elements aren't keyboard-focusable. Also the `onWheel`
`preventDefault()` (:161-164) is ineffective under React's passive listener
registration (see code-quality report CQ-M3).

### UX-L6 (Low) — WalletMenu `role="menu"` without arrow-key support

`TopBar.tsx:87-109`; items are buttons so it works, but arrow/Home/End
navigation expected of the menu role is absent.

**Good practices:** real `<button>`s essentially everywhere (the scrim close
is a labeled button, `Markets.tsx:422-427`); icon-only controls all carry
`aria-label`; `aria-sort` on sortable headers; `aria-pressed` on the theme
toggle; toasts use `role="status"`/`"alert"` correctly; comprehensive
`prefers-reduced-motion` coverage (`index.css:1165`, `wave3.css:451`,
`useCountUp.ts:15`, and `FlightBackground.tsx:105-123` paints a single static
frame); real alt text for all pixel art (`PixelArt.tsx:15-40`); focus-visible
styles for buttons/fields/sliders/rows in both themes; light-scheme tokens
explicitly tuned for ~4.5:1 contrast (`index.css:2051-2055`).

---

## 7. Responsive design

Mostly Tailwind-breakpoint-driven and in good shape: the departures table
gets `min-w-[820px]` + `overflow-x-auto` **plus a synced top scrollbar rail**
(`Markets.tsx:620-646,786-800`) — a genuinely nice touch. TopBar collapses to
a second-row mobile nav (`TopBar.tsx:240-258`); the globe layout reorders
(map above list) on mobile (`MarketsGlobe.tsx:592,668`); House stats go
2-col.

### UX-L7 (Low) — Toast stack can overlap the wrapped mobile header

`index.css:1197-1206` fixes toasts at `top: 72px; right: 16px; max-width:
340px`; on phones where the TopBar wraps to two rows (~100px+), sticky header
and toasts can overlap the first content, and 340px leaves ~20px margins at
375px width — acceptable but tight.

---

## 8. Copy / i18n

### UX-M12 (Medium) — Meaningful strings bypass `copy.ts`, including theme-voice leaks

The copy system is well designed (typed fun/serious parity,
`copy.ts:293-295`), but: Policies outcome labels are hardcoded ALL-CAPS
arcade voice shown even in serious mode ("ON TIME — NO PAYOUT", "DELAYED —
PAID", `Policies.tsx:175-209`, plus `liveLabel()` at :54-70); the fun Markets
hero is hardcoded JSX duplicating copy.ts (`Markets.tsx:698-712`); all
success/error toast strings, the network banner (`App.tsx:50-53`),
ActivityLog strings, RiskBar tooltip, and the Status page live outside
copy.ts. Any future localization or serious-voice pass will miss them.

**Low — jargon:** "ERC-4626-style Soroban vault" in user-facing fineprint
(`copy.ts:141,426`) means nothing to a traveler and is Ethereum jargon on a
Stellar app. Raw `HostError`/XDR strings can leak via errors (UX-M2). No
i128/stroops leakage found — amounts are consistently formatted.

---

## 9. Theme / FOUC

### UX-M10 (Medium) — No pre-hydration theme script

`index.html` has no inline script; `ThemeProvider.tsx:62-78` sets
`data-theme`/`data-scheme` on `<html>` only in `useEffect`, after first
paint. React state initializes synchronously from localStorage (components
render the right JSX), but every CSS rule keyed on `[data-theme]`/
`[data-scheme]` is inactive for the first frame(s): a light-scheme user gets
a dark flash; a serious-theme user gets pixel chrome flashing to clean.
**Fix:** inline a tiny `<head>` script that reads the two localStorage keys
and stamps the attributes before CSS applies.

**Good practices:** both themes × both schemes systematically covered via
token overrides with a documented specificity ladder (`index.css:2047-2176`);
`color-scheme` set so native widgets follow; the wallet-kit modal inherits
tokens; `::selection` fixed for light-serious; scanlines/starfield re-tuned
per scheme.

---

## Priority order

1. Communicate the 6h delay + render `requested_at` countdowns on House (UX-H1, UX-H2, UX-M11).
2. Policies error state showing "No policies yet" (UX-H3).
3. Fix awaiting/confirming stage ordering around `signAndSend` (UX-H4).
4. BetSlip dialog semantics/focus trap and FlightCalendar roving focus (UX-H5, UX-H6).
5. Persist errors + humanize contract errors + explorer links on success (UX-M1, UX-M2, UX-M3).
6. Pre-hydration theme stamp in index.html (UX-M10).
