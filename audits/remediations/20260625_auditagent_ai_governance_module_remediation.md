# Nethermind AuditAgent AI — GovernanceModule Report — Remediation Summary

**Source report:** [`20260625_auditagent_ai_governance_module_report.md`](../20260625_auditagent_ai_governance_module_report.md)
**Remediation date:** 2026-07-01
**Scope:** `contracts/governance_module` (+ Controller / FlightPoolManager for
downstream impact).
**Test status:** full workspace suite green — **327 tests pass**
(`cd contracts && cargo test`); `cargo clippy --all-targets -- -D warnings`
clean; `cargo fmt --all --check` clean.

Both findings were substantially resolved in the Nemesis pass on the same commit
(NM-007, NM-010). AA-GM-01 is fully covered by that work; AA-GM-02 is additionally
hardened here with the report's `enable_route` recommendation.

| ID | Severity | Verdict | Status |
|----|----------|---------|--------|
| AA-GM-01 | Medium | Confirmed | ✅ Already fixed (index TTL synced + conditional removal) |
| AA-GM-02 | Low | Confirmed | ✅ Fixed (invalid routes not Active; enable_route revalidates) |

---

## AA-GM-01 — FlightRoute uniqueness index can expire independently and permit route collisions
**= Nemesis NM-007. Already fixed.** See
[`20260625_nemesis_auditor_remediation.md`](20260625_nemesis_auditor_remediation.md).

The desync arose because `route_status` (and the route mutations) re-extended the
`Route(flight_id, origin, dest)` key but not the separate `FlightRoute(flight_id)`
uniqueness index, so the index could archive while an actively-used route stayed
live — after which a second `whitelist_route` would see no index and accept a
conflicting `(origin, dest)` for the same flight number.

The fix renews the index in lockstep with the route on **every** on-chain touch:
`extend_route_index_ttl(flight_id)` is called alongside `extend_route_ttl` in
`route_status` (the read/buy path), `disable_route`, `enable_route`, and
`update_route_terms`; `whitelist_route` already writes + extends it. Because
there is now no path that extends the `Route` key without also extending the
index, the two can no longer diverge — an actively-used route keeps both alive
together, and an idle route lets both lapse together (neither is cron-extended),
so a collision window cannot form. `remove_route` additionally deletes the index
only when its stored `(origin, dest)` matches the route being removed, so
removing one route cannot strip another route's ownership.

The report's further suggestions (verify the index matches inside
disable/enable/update; add missing-index recovery) target an already-collided
state, which the lockstep renewal prevents from arising on a fresh deployment, so
no additional guard was needed. Covered by the existing NM-007 tests
(`test_whitelist_route_rejects_conflicting_flight_id`,
`test_remove_route_frees_flight_id_mapping`).

---

## AA-GM-02 — Mutable defaults can leave active routes with terms rejected by FlightPoolManager
**Confirmed (Low). Fixed.** A partially-defaulted route (some fields inherit the
mutable global defaults) that is valid when written can resolve to economically
invalid terms (e.g. `payoff <= premium`) after a later `set_defaults`, with no
revalidation. The FlightPoolManager registration guard already blocks fund loss,
but the route still *reported as active* and appeared sellable.

Two complementary fixes:
- **`route_status` no longer advertises an invalid route as `Active`** (landed in
  the Nemesis pass, NM-010): it resolves the terms and, if they fail the
  economic invariants (`resolved_terms_valid`), returns `RouteStatus::Disabled`,
  which the controller already rejects cleanly (`RouteDisabled`) instead of
  proceeding into a downstream registration revert. Covered by
  `test_route_status_disabled_when_defaults_make_terms_invalid`.
- **`enable_route` now revalidates resolved terms** (added here — the report's
  recommendation #5): re-enabling a previously disabled route asserts the
  resolved terms are valid against the *current* defaults, so an admin cannot
  re-activate a route that a defaults change has made invalid. They must fix the
  route's own terms (via `update_route_terms`, which already validates) or the
  defaults first. This mirrors the validation already performed by
  `whitelist_route` and `update_route_terms`, closing the last write path that
  could leave an approved-but-invalid route.
  *Files:* `governance_module/src/routes.rs`.
  *Test:* `test_enable_route_rejects_invalid_resolved_terms`.

> **Deferred (documented):** the deeper options — storing fully-resolved
> immutable terms per route, or maintaining an enumerable route index to
> revalidate every dependent route on `set_defaults` — both require route
> enumeration (deliberately not maintained on-chain; enumeration lives in the
> off-chain indexer). The `route_status` + `enable_route` guards deterministically
> prevent the concrete harm (an invalid route being sold or advertised as active),
> which is the finding's impact.

---

## Files changed

Source (1): `governance_module/src/routes.rs`.
Tests (1): `governance_module/src/test.rs`.
