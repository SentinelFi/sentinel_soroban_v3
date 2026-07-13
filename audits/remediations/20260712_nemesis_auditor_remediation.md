# Nemesis AI Auditor Report (2026-07-12) — Remediation Summary

**Source report:** [`20260712_nemesis_auditor_report.md`](../20260712_nemesis_auditor_report.md)
**Audited commit:** `fcde5aa` (main)
**Remediation date:** 2026-07-13
**Test status:** full workspace suite green — **423 tests pass**
(`cd contracts && cargo test`); `cargo clippy --all-targets -- -D warnings`
clean; `cargo fmt --all --check` clean; `stellar contract build` succeeds.

Both findings were validated as genuine at current `main` before fixing: the
code traces in the report were re-verified against the shipped sources
line-by-line (ratio enforced only in `controller/purchase.rs`; every vault
exit gated on the nominal `TMA − locked`; snapshot substitution in
`buy_insurance` with no re-validation), and the new regression tests encode
the report's exact trigger sequences and pass with the fixes in place.

| ID | Severity | Verdict | Status |
|----|----------|---------|--------|
| NM-001 | Medium | Confirmed | ✅ Fixed (vault exits now bounded by the same ratio-scaled reserve the purchase path enforces) |
| NM-002 | Medium | Confirmed | ✅ Fixed (pool-snapshot terms re-validated against the current governance limits on every purchase) |

---

## Fixed

### NM-001 — Vault exits can remove the configured solvency reserve

**Confirmed (Medium).** The solvency ratio was enforced only where liabilities
grow: `Controller::buy_insurance` required
`TMA >= ceil((locked + new_payoff) * ratio / 100)`. Every path where assets
leave — direct `withdraw`/`redeem`, the `max_withdraw`/`max_redeem` views, and
`process_withdrawal_queue` — gated on `get_free_capital() = TMA − locked`,
i.e. nominal 100% backing. With a ratio above 100%, any LP with enough shares
could withdraw the entire safety margin immediately after purchases were
admitted against it, collapsing the configured reserve to 100% backing
(the report's trigger: 1,000 TMA, 200% ratio, 500 locked → 500 withdrawn →
`TMA == locked == 500`).

**Fix — one canonical required-backing bound, enforced on both sides of the
invariant (the report's recommendation):**

- **`RiskVault::get_withdrawable_capital()`** (new view) computes
  `max(TMA − ceil(locked × solvency_ratio / 100), 0)` — the same ceiling
  arithmetic as the purchase gate, rounded up so truncation can never
  under-provision the reserve, clamped at zero for the ratio-raised-after-lock
  case.
- **Every exit path now gates on it:** direct `withdraw` and `redeem`
  (still error 715 on breach), `max_withdraw` / `max_redeem` (so integrations
  never build doomed transactions), and `process_withdrawal_queue`, whose
  per-pass budget (`remaining_free`, including the head partial fill) starts
  from the withdrawable amount instead of the nominal margin.
- **The ratio is mirrored into the vault** (`VaultKey::SolvencyRatio`,
  instance, absent = 100). `Controller::set_solvency_ratio` pushes the value
  through a new controller-only `RiskVault::set_solvency_ratio` in the same
  transaction, so the two copies cannot diverge (atomicity) and there is a
  single owner-facing configuration point. A push is required rather than a
  read-back: the controller invokes `process_withdrawal_queue`, and a
  vault→controller call inside that invocation would be reentrant, which
  Soroban forbids. The vault validates the pushed value against the same
  [100, 10,000] bounds as the controller's owner setter, and emits
  `sentinel.ratio_set` so monitoring catches any unexpected loosening.
- `get_free_capital()` keeps its `TMA − locked` semantics as a reporting view
  (nominal margin over liabilities); with the default 100% ratio the two
  figures coincide, so behavior is unchanged for deployments that never tune
  the ratio.
- Deliberately NOT reserve-gated: `send_payout` (claims are what the reserve
  exists for) and `decrease_locked` / `increase_locked` (the controller's
  aggregate purchase check remains the admission gate; the vault-side
  `locked <= TMA` floor is unchanged).

*Files:* `risk_vault/src/{storage,constants,error,queries,capital,vault_ops,events,lib}.rs`,
`controller/src/{admin,interfaces}.rs`.
*Tests:* `test_solvency_reserve_gates_direct_exit` (200% ratio: withdrawable
= 200 of a 600 nominal margin; over-withdrawal rejected; exact amount leaves
the book precisely at the ratio), `test_redeem_into_solvency_reserve_panics`
(reproduces the report's PoC shape — full-TMA-required book rejects any
redemption), `test_queue_processing_holds_back_solvency_reserve` (head
partial-fills only to the reserve bound; re-processing cannot eat into it;
full drain after collateral release), `test_set_solvency_ratio_rejects_non_controller`,
`test_set_solvency_ratio_bounds`, controller `test_set_solvency_ratio`
(asserts the vault mirror), and integration
`lp_exit_cannot_drain_solvency_reserve` (end-to-end: 200% ratio, two
policies, nominal-margin withdrawal rejected, reserve-bounded withdrawal
leaves `TMA == 2 × locked` exactly). All pre-existing exit/queue/max-view
tests pass unchanged (default ratio 100 ⇒ identical behavior).

### NM-002 — Cached flight terms bypass newly lowered governance limits

**Confirmed (Medium).** `buy_insurance` validated the route's CURRENT terms
via `route_status` (which reports `Disabled` when resolved terms exceed the
current limits), then — for an already-registered `(flight_id, date)` bucket —
replaced them with the pool's `FlightConfig` snapshot and never re-checked the
terms it actually charged and locked. Lowering `max_payoff` /
`max_payoff_ratio` therefore could not stop new exposure on a pre-existing
oversized bucket: as long as the route itself was brought under the new cap,
every later buyer of that bucket still locked the old, larger payoff (the
report's trigger: bucket at payoff 50, cap lowered to 20, route updated to 20,
second buyer still locks 50).

**Fix — validate the terms actually used, at the moment they are used (the
report's "expose a governance check for arbitrary resolved terms" option):**

- **`GovernanceModule::terms_valid(terms: ResolvedTerms) -> bool`** (new
  view) applies the module's existing resolved-terms validation — the
  defaults-independent economics checks (premium > 0, payoff > premium,
  delay_hours > 0) plus the current owner-set `MaxPayoff` / `MaxPayoffRatio`
  bounds — to caller-supplied terms. Single source of truth: it delegates to
  the same internal predicate `route_status` uses, so the two checks can
  never drift.
- **`Controller::buy_insurance`** now calls it on the snapshot immediately
  after the pool-bucket substitution and panics with the new
  `SnapshotTermsExceedLimits` (320) when the snapshot is no longer
  admissible. First-purchase terms need no second check — they are exactly
  the `route_status`-validated current terms.
- Semantics match the report's recommendation: existing policies keep their
  snapshotted terms for settlement and claims (nothing in the settlement path
  touches the limits); only the admission of NEW buyers is judged against the
  limits in force now. A bucket priced out by a limits change simply stops
  accepting buyers; fresh flight dates re-snapshot the compliant current
  terms and sell normally, and re-raising the limits reopens the old bucket
  without any state surgery.

*Files:* `governance_module/src/queries.rs`,
`controller/src/{purchase,interfaces,error}.rs`.
*Tests:* `test_buy_insurance_rejects_snapshot_above_lowered_term_limits`
(reproduces the report's PoC — bucket at payoff 50, cap lowered to 20, route
made compliant, second buyer rejected with #320),
`test_lowered_term_limits_leave_new_buckets_sellable` (the closed bucket's
stored terms and `buyer_count` stay untouched; the next flight date sells at
the compliant terms), governance `test_terms_valid_tracks_current_limits`
(flips with the limits; rejects economically invalid shapes regardless of
limits). The pre-existing first-buyer-snapshot tests
(`test_buy_insurance_second_traveler_skips_register` etc.) pass unchanged.

---

## Interface changes in this pass

- `RiskVault` — new views `get_withdrawable_capital()`, `get_solvency_ratio()`;
  new controller-only entry `set_solvency_ratio(controller, ratio)`; new error
  `SolvencyRatioOutOfBounds` (724); new event `SolvencyRatioSet`
  (`sentinel.ratio_set`); new instance key `SolvencyRatio`. `withdraw`,
  `redeem`, `max_withdraw`, `max_redeem`, and `process_withdrawal_queue` now
  bound exits by withdrawable capital (identical to before at the default
  100% ratio). `get_free_capital` keeps its signature and semantics.
- `GovernanceModule` — new view `terms_valid(ResolvedTerms) -> bool`
  (read-only, no storage writes).
- `Controller` — `set_solvency_ratio` additionally pushes the ratio into the
  vault; `buy_insurance` re-validates pool-snapshot terms and can now revert
  with the new `SnapshotTermsExceedLimits` (320).
- Playground registry lists the three new vault functions. `terms_valid` is
  not form-callable there (the playground's argument encoder has no struct
  support); it remains callable via CLI/SDK.
- **Deployment notes for existing deployments:** after upgrading the vault
  and controller wasm, the owner must call `controller.set_solvency_ratio`
  once with the intended ratio — until then the vault's mirrored copy
  defaults to 100 and exits enforce only nominal backing, exactly the
  pre-fix behavior (no regression, but no reserve either). For fresh
  deployments, note the ordering constraint: `set_solvency_ratio` must run
  AFTER `RiskVault.set_controller`, or the mirror push reverts.

## Documentation updated

`spec/architecture.md` (withdrawable-capital semantics, vault storage layout
and event list, solvency invariant now stated for both directions, buy flow,
withdrawal flows, function reference, deployment ordering note),
`spec/simple_architecture.md` (vault state, invariants 2b/2c, queue gotchas),
`sequence_diagrams.md` (purchase diagram gains the snapshot re-validation
step; queue-maintenance note prices against the reserve), docs site pages
`contracts/risk-vault.md`, `contracts/controller.md`,
`concepts/solvency-and-safety.md`, `guides/provide-liquidity.md`, and
`playground/lib/registry.ts`.
