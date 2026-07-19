# Claude Fable 5 Report (2026-07-19) — Remediation Summary

**Source report:** [`20260719_claude_fable5_report.md`](../20260719_claude_fable5_report.md)
**Audited commit:** `6fa82ac` (main)
**Remediation date:** 2026-07-19
**Test status:** full workspace suite green — **480 tests pass**
(`cd contracts && cargo test`); `cargo clippy --all-targets -- -D warnings`
clean; `cargo fmt --all --check` clean; `stellar contract build` succeeds.

All three findings were validated as genuine against the current sources.
All three carry documentation/runbook-level primary remediations (per the
assessment instructions), which were applied in full; each finding's
optional code-level hardening is recorded as not taken (team decision) with
the rationale. All six general improvements were applied — two as code
(new Controller wiring getters + a shared vault admission helper), four as
documentation.

| ID | Severity | Verdict | Status |
|----|----------|---------|--------|
| CF5D-L01 | Low | Confirmed | 📝 Documented — vault-seeding step added to the deployment runbook; un-clamped bootstrap minimum (option b) not taken |
| CF5D-L02 | Low | Confirmed | 📝 Documented — pause-asymmetry warning on `governance.pause`, in the spec's incident procedure, and in the docs site; pause-exempting `disable_route` not taken |
| CF5D-L03 | Low | Confirmed | 📝 Documented — eviction-pairing precondition on both recovery entry points, in the spec's function reference, and in the runbooks; on-chain pairing marker not taken |

---

## Documented (runbook / spec / doc comments)

### CF5D-L01 — Bootstrap-phase queue-slot squatting is cheap in absolute terms

**Confirmed (Low).** At near-zero TMA every request-floor term degenerates
to the one-token absolute minimum, and the anti-lockout clamp caps any
owner-configured minimum at the same one token — so pinning the bounded LP
queues full costs only ~50–75 tokens of refundable escrow (sustained by
cancel-and-refill inside the 6 h maturity window), during exactly the phase
the vault most needs deposits. Temporary entry-liveness DoS only; no funds
at risk; self-resolving once TMA exceeds ~2,500 tokens.

**Resolution — the report's option (a), runbook.** The deployment runbook
now instructs seeding the vault with an owner/genesis `request_deposit`
(processed through the normal two-phase queue) **before** announcing public
LP entry, so the value-relative `TMA/2500` term dominates the one-token
floor — and the owner's configuration lever binds — from the first public
request. Option (b) (letting the configured minimum bind un-clamped below a
TMA threshold) was deliberately not taken: it reopens the owner-lockout
surface the clamp exists to close, and seeding achieves the same protection
operationally with no new code path.

*Files:* `spec/architecture.md` (Deployment Order — new recommended step
after `set_min_withdrawal_request`), `contracts/deploy_order.md` (bootstrap
caveats under step 10), `docs/docs/contracts/risk-vault.md`.

### CF5D-L02 — Pausing governance alone keeps sales open and blocks the route-disable lever

**Confirmed (Low, operational interaction hazard).** The governance pause
halts only administrative writes; `route_status` deliberately keeps serving
`Active`, so purchases continue on every listed route while governance is
paused — and `disable_route`/`remove_route` are pause-gated. The intuitive
incident response "pause governance + disable the bad route" therefore does
the opposite of its intent, with no on-chain signal, and the correct levers
(pause the Controller; oracle's pause-exempt `close_sale`) live in other
contracts.

**Resolution — the warning, in every place an operator would look.** An
operator warning now sits on the governance `Pausable` implementation
itself, in the spec's "operate pause/unpause as a set" incident procedure
(new dedicated paragraph), and in a new "Pausing" section of the governance
docs page — each stating what the pause does and does not stop, and naming
the correct mid-incident levers. Pause-exempting `disable_route` was
considered and not taken: coverage is already guaranteed mid-incident by
two other levers, and the uniform gating of route lifecycle writes is a
previously-recorded deliberate invariant this pass does not overturn.

*Files:* `governance_module/src/traits.rs`, `spec/architecture.md`
(Emergency Stop section), `docs/docs/contracts/governance-module.md`.

### CF5D-L03 — `settle_evicted_flight` cannot verify its pairing with the eviction

**Confirmed (Low, inside the owner trust model).** The two recovery steps
(`oracle.evict_missing_flight(outcome_pending)` →
`controller.settle_evicted_flight`) are independently callable; the second
verifies only that the flight is outside the normal pipeline — not that an
eviction happened for it, nor which flag it carried. A mis-paired or
mis-flagged pair silently converts payouts buyers may have been owed into
vault income (void semantics), reconstructable only after the fact.

**Resolution — machine-unverifiable, so made procedurally explicit.** Both
entry points' doc comments now carry a runbook precondition: before running
the reconciliation, quote the flight's `FlightEvicted` event — including
its `outcome_pending` flag — in the change record, and confirm from the
flight's status-event history that denying its buyers a payout is the
intended outcome. The same precondition was added to the spec's
function-reference rows for both entry points and to the runtime-call-order
runbook. The optional persistent pairing marker (eviction writes, the
reconciliation consumes) is recorded as a candidate hardening but not
taken — it adds a storage key and a new error to an owner-only edge path
whose usage rate is expected to be near zero.

*Files:* `oracle_aggregator/src/admin.rs`, `controller/src/settle.rs`,
`spec/architecture.md` (function reference ×2),
`contracts/deploy_order.md` (runtime call order),
`docs/docs/contracts/oracle-aggregator.md`.

---

## General improvements (all six applied)

1. **Archival-semantics narrative unified** — the paginated active set's
   module doc now states the governing model (an archived persistent entry
   in a transaction footprint is restored before execution or the
   transaction fails — a committed execution never observes it as `None`)
   and reframes every missing-entry branch as fail-safe defense-in-depth
   that fires for explicitly-removed keys; the `prune_settled`
   missing-data arm carries the same clarification. The testnet
   archival-semantics experiment remains an open ops-backlog item; these
   annotations remove the risk of operators building procedures on the
   read-as-absent assumption in the meantime.
   *Files:* `sentinel_types/src/active_set.rs`,
   `oracle_aggregator/src/lifecycle.rs`.
2. **Controller wiring getters added** — new read-only `get_risk_vault()`,
   `get_governance()`, `get_asset_token()` (joining the existing
   `get_oracle()`/`get_flight_pool_manager()`/`get_keeper()`), so every
   cross-contract wiring invariant — one oracle for controller + barrier,
   one vault for controller + pool, one asset across controller, pool, and
   vault — is verifiable on-chain after deployment. The deploy-order
   verification checklist and the controller docs page now list the full
   invariant set. Covered by
   `test_wiring_getters_expose_construction_addresses`.
   *Files:* `controller/src/{queries,test}.rs`,
   `contracts/deploy_order.md`, `docs/docs/contracts/controller.md`.
3. **Whitelist-deadline monitoring rule documented** — deadline slides emit
   no event and are skipped within the 10-day refresh interval, so
   dormancy monitors must reconstruct the deadline as
   `latest(buyer_whitelisted event, last InsuranceBought) + 180 days`;
   watching `buyer_whitelisted` events alone false-alarms on active
   buyers. Documented on `add_whitelisted_buyer` and in the spec's
   whitelist section (`is_whitelisted` named as the on-chain truth).
   *Files:* `controller/src/whitelist.rs`, `spec/architecture.md`.
4. **Request-floor decimals assumption promoted to the deploy checklist** —
   `deploy_order.md` now flags that the one-token absolute floor is a
   compile-time constant assuming a 7-decimal asset and must be adjusted
   for a settlement asset with different decimals. Deriving it from
   `asset.decimals()` at construction was not taken (a storage/flow change
   disproportionate to a wiring-time checklist item).
5. **Spec sweep-boundary sync** — `architecture.md`'s sweep flow corrected
   from `<=` to the strict `<` the code enforces, annotated as the exact
   complement of `claim`'s cutoff. In the same file-hygiene pass, two stale
   references to the removed immediate `deposit` path in
   `deploy_order.md`'s smoke test and runtime call order were updated to
   the two-phase `request_deposit` flow.
6. **Vault admission logic deduplicated** — the request-value floor math
   and the per-address capacity scan, previously duplicated between
   `request_deposit` and `request_withdrawal`, now live once as
   `effective_request_minimum` / `require_per_address_capacity` in
   `risk_vault/src/claims.rs`, so the two queues' admission policies can
   no longer drift apart. Pure refactor — behavior, errors, and events
   unchanged; the existing floor/occupancy/per-address tests cover both
   call sites unmodified.

---

## Interface changes in this pass

- `Controller` — three new read-only entry points: `get_risk_vault`,
  `get_governance`, `get_asset_token`. Additive views; no signature,
  storage-layout, or wire-format changes.
- No other contract's ABI changed. The vault refactor is
  behavior-identical; all remaining changes are comments and
  documentation. No deployment action required.

## Documentation updated

`spec/architecture.md` (deployment-order vault-seeding step, governance
pause-asymmetry paragraph in Emergency Stop, eviction-pairing precondition
in the function reference ×2, whitelist-monitoring reconstruction rule,
sweep-boundary sync),
`contracts/deploy_order.md` (bootstrap seeding + decimals caveats,
expanded wiring-verification checklist, eviction-pairing note, two-phase
deposit references),
`docs/docs/contracts/risk-vault.md` (bootstrap seeding note),
`docs/docs/contracts/governance-module.md` (new Pausing section),
`docs/docs/contracts/oracle-aggregator.md` (eviction pairing),
`docs/docs/contracts/controller.md` (wiring getters),
plus the doc comments listed per finding above.
