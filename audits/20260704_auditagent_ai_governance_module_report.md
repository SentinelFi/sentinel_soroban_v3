# Nethermind AuditAgent AI: Sentinel GovernanceModule Findings Report

**Date:** 4 July 2026

This report presents the Nethermind AuditAgent AI Auditor findings for the Sentinel Protocol GovernanceModule. Severity reflects likely protocol impact, exploitability, and operational risk in the assessed repository snapshot.

---

## Assessment Information

| | |
| --- | --- |
| **Project Name** | Sentinel Protocol |
| **Network** | Stellar |
| **Smart Contract Platform** | Soroban |
| **Programming Language** | Rust |
| **Assessment Date(s)** | 2026-07-04 |
| **Report Version** | v1.0 |
| **Assessment Status** | Final |
| **Assessment Type** | AI-Assisted Internal Security Review |
| **Auditor(s)** | Nethermind AuditAgent AI Auditor |
| **Assessment Platform** | [https://app.auditagent.nethermind.io/](https://app.auditagent.nethermind.io/) |

---

## Repository Information

| | |
| --- | --- |
| **Repository URL** | [SentinelFi/sentinel_soroban_v3](https://github.com/SentinelFi/sentinel_soroban_v3/tree/main) |
| **Repository Visibility** | Public |
| **Branch Name** | `main` |
| **Git Commit Hash** | `6b0db9ea9d6b1a349e16490942a75d4ae936a7f7` |
| **Assessment Snapshot** | Source code state corresponding to the commit hash above |

---

## Scope

### In Scope

- `contracts/governance_module/src/admin.rs`
- `contracts/governance_module/src/auth.rs`
- `contracts/governance_module/src/constants.rs`
- `contracts/governance_module/src/error.rs`
- `contracts/governance_module/src/lib.rs`
- `contracts/governance_module/src/queries.rs`
- `contracts/governance_module/src/routes.rs`
- `contracts/governance_module/src/storage.rs`
- `contracts/governance_module/src/traits.rs`
- `contracts/governance_module/src/upgrade.rs`

Controller, FlightPoolManager, OracleAggregator, and the production TTL executor were reviewed where necessary to assess downstream impact and existing controls.

### Out of Scope

- Production infrastructure and operator configuration
- Frontend applications
- Compromise of owner or governance administrator credentials
- Contracts outside the GovernanceModule integration boundary, except for impact analysis
- Economic assumptions not represented by the assessed implementation

---

## Executive Summary

The assessment identified five findings: two Medium-severity issues and three Low-severity issues.

The highest-impact issues affect the invariant that one `flight_id` identifies one physical route. GovernanceModule stores routes and the uniqueness mapping in separate persistent entries. Independent archival or restoration can make those entries disagree, and `route_status` does not verify the mapping before returning a route as active. Separately, the normal `remove_route` flow intentionally frees a flight ID without checking whether old policies or flight records using that identifier remain live downstream. Both paths can cause different routes to share `(flight_id, date)` state in FlightPoolManager and OracleAggregator.

Three Low findings affect availability. Active route terms can change after a flight/date is registered, causing later purchases to fail the downstream idempotency check. Persistent routes can archive after inactivity and become indistinguishable from never-whitelisted routes. Finally, active route operations do not extend the contract instance TTL and therefore do not make ongoing use sufficient to preserve instance state if the separate TTL executor fails.

### Findings Summary

| ID | Severity | Title |
| --- | --- | --- |
| AA-GM-01 | Medium | Route and uniqueness-index archival can create conflicting active routes |
| AA-GM-02 | Medium | Removed flight IDs can be reused while downstream state remains live |
| AA-GM-03 | Low | Route term changes can deny later purchases for registered flights |
| AA-GM-04 | Low | Inactive persistent routes silently become unknown |
| AA-GM-05 | Low | Active route operations do not preserve contract instance TTL |

### Severity Distribution

| Critical | High | Medium | Low | Informational |
| ---: | ---: | ---: | ---: | ---: |
| 0 | 0 | 2 | 3 | 0 |

### Overall Risk Rating

**Medium**

The route-identity findings can break the isolation assumed by all downstream policy and oracle state. The remaining findings primarily cause configuration-dependent or TTL-dependent interruption of new policy sales.

---

# Detailed Findings

## [AA-GM-01] Route and uniqueness-index archival can create conflicting active routes

| Field | Value |
| --- | --- |
| **Severity** | Medium |
| **Affected Components** | `DataKey::Route`, `DataKey::FlightRoute`, `whitelist_route`, `route_status`, and `enable_route` |
| **Impact** | Cross-route state collision, incorrect outcome attribution, and purchase denial |

### Description

GovernanceModule stores the route record and its uniqueness index as separate persistent keys:

```rust
Route(Symbol, Symbol, Symbol),
FlightRoute(Symbol),
```

`whitelist_route` rejects a conflicting origin and destination only when the live index exists:

```rust
if let Some((existing_origin, existing_dest)) =
    e.storage().persistent().get::<_, (Symbol, Symbol)>(&fr_key)
{
    if !(existing_origin == origin && existing_dest == dest) {
        panic_with_error!(e, Error::FlightIdAlreadyMapped);
    }
}
```

Normal committed `route_status` calls renew both entries. However, the invariant is not atomic:

- the entries can be restored independently after archival;
- operational tooling can renew or restore one footprint without the other;
- `extend_route_index_ttl` silently does nothing when the index is absent;
- `route_status` does not verify that the current `FlightRoute` value points to the route being returned;
- `enable_route` does not recreate or verify the index.

The repository's TTL executor currently extends contract instances only. It does not implement the key-level route renewal described in GovernanceModule comments, increasing dependence on per-route traffic or external restoration.

### Failure Scenario

1. `F1 / A / B` is whitelisted and later archives.
2. Its uniqueness index is absent, so governance whitelists `F1 / C / D`.
3. A network participant restores the archived `Route(F1, A, B)` entry, or an operator restores/extends only that route key.
4. `route_status(F1, A, B)` reads the old approved record and returns it as active without checking that `FlightRoute(F1)` points to `(A, B)`.
5. Both routes can be used while downstream state remains keyed only by `(F1, date)`.

The same inconsistent state can occur if the index alone archives while the old route remains live.

### Impact

If the routes resolve to different terms, FlightPoolManager rejects registration for the second route, denying policy sales. If terms match, buyers for different physical routes can share one flight configuration and one oracle outcome, producing incorrect claims or denials.

### Recommendation

Make route identity and uniqueness non-divergent:

1. Prefer a canonical route record keyed by `flight_id`, with origin, destination, approval, and terms stored in one entry.
2. Verify the canonical mapping in every route read and enable operation.
3. Reject a route as inconsistent if the index is absent or points elsewhere.
4. If separate persistent keys remain, restore and extend them atomically through the same footprint.
5. Add tests for independently archived and independently restored route/index entries.

---

## [AA-GM-02] Removed flight IDs can be reused while downstream state remains live

| Field | Value |
| --- | --- |
| **Severity** | Medium |
| **Affected Components** | `remove_route`, `whitelist_route`, and downstream `(flight_id, date)` state |
| **Impact** | Old and new physical routes can collide in policy and oracle state |

### Description

After a route is disabled, `remove_route` deletes both its route entry and, when it still points to that route, the uniqueness index:

```rust
e.storage().persistent().remove(&key);

if let Some((idx_origin, idx_dest)) =
    e.storage().persistent().get::<_, (Symbol, Symbol)>(&fr_key)
{
    if idx_origin == origin && idx_dest == dest {
        e.storage().persistent().remove(&fr_key);
    }
}
```

This intentionally makes the `flight_id` available for a different origin and destination. GovernanceModule does not check whether FlightPoolManager or OracleAggregator still contains unresolved or future-dated state for the old route.

### Failure Scenario

1. Travelers purchase policies for `F1 / A / B` on date `D`.
2. Governance disables and removes the route while those policies remain unresolved.
3. Governance whitelists `F1 / C / D`.
4. A traveler purchases the new route for the same date.
5. Controller submits `(F1, D)` to the existing downstream namespace.

Different terms cause a deterministic registration revert. Matching terms allow the two physical routes to share one outcome and settlement record.

### Impact

The normal authorized lifecycle can make old policies and a replacement route indistinguishable downstream. This can deny purchases or apply one physical flight's result to policyholders of another.

### Recommendation

Treat flight identifiers as immutable or introduce a versioned canonical route identifier.

If reuse is required:

1. maintain an on-chain tombstone preventing reuse until the maximum downstream policy lifetime has elapsed;
2. query or receive confirmation from downstream modules that no live dates remain;
3. include route identity or a generation number in every downstream key;
4. make removal a two-step operation with a visible retirement deadline.

---

## [AA-GM-03] Route term changes can deny later purchases for registered flights

| Field | Value |
| --- | --- |
| **Severity** | Low |
| **Affected Components** | `whitelist_route`, `update_route_terms`, `set_defaults`, and route resolution |
| **Impact** | Later buyers cannot purchase an otherwise active registered flight/date |

### Description

Governance permits an existing route to be overwritten or updated. Routes with omitted fields also resolve against mutable global defaults.

FlightPoolManager snapshots terms on the first registration of `(flight_id, date)` and accepts later registration only when the supplied terms match. Consequently, changing route terms after the first purchase makes GovernanceModule return different terms for later buyers of the same flight/date.

### Failure Scenario

1. A buyer registers `(F1, D)` with premium `P1`, payoff `O1`, and delay `H1`.
2. Governance changes the route or inherited defaults.
3. A second buyer attempts to purchase `(F1, D)`.
4. Controller submits the new terms.
5. FlightPoolManager rejects the mismatch and the purchase reverts.

The downstream guard prevents state corruption and funds are not moved permanently because the transaction is atomic.

### Impact

Authorized configuration changes can interrupt sales for already-registered flight dates. Existing policies keep their snapshotted terms and remain settleable.

### Recommendation

Version route terms and bind each flight/date to the version active at initial registration. Alternatively, delay term changes until all affected sale windows close, or expose a Controller query that returns the already-registered terms for subsequent buyers.

---

## [AA-GM-04] Inactive persistent routes silently become unknown

| Field | Value |
| --- | --- |
| **Severity** | Low |
| **Affected Components** | Persistent `Route` entries and `route_status` |
| **Impact** | Policy sales fail for approved but inactive routes |

### Description

Routes are stored in persistent storage with an approximately 60-day TTL. Committed route reads and mutations renew the key, but an inactive approved route can archive if no key-level TTL executor renews it.

When the entry is missing, `route_status` returns `Unknown`:

```rust
match terms {
    None => RouteStatus::Unknown,
    // ...
}
```

The current production TTL executor explicitly does not extend individual route keys. Therefore, route longevity depends on committed traffic or a separate restoration/extension process.

### Impact

An approved route can become indistinguishable from a route that was never whitelisted. Controller then rejects purchases until the entry is restored or re-created.

### Recommendation

Implement monitored key-level TTL extension for all approved routes, or store a bounded canonical route registry in storage whose lifetime cannot diverge per route. Return a distinct operational state when a known route entry is archived, where feasible.

---

## [AA-GM-05] Active route operations do not preserve contract instance TTL

| Field | Value |
| --- | --- |
| **Severity** | Low |
| **Affected Components** | `route_status`, route mutation entrypoints, and instance-stored ownership/default/admin state |
| **Impact** | Governance and new policy sales can halt after an instance-TTL executor failure |

### Description

Defaults, admin flags, and ownership state are held in instance storage. Owner-only administrative functions call `extend_ttl`, but the purchase-facing `route_status` path and owner-or-admin route mutation functions do not.

As a result, route traffic can renew persistent route records while the contract instance continues toward archival. The repository includes a permissionless `extend_ttl` entrypoint and a scheduled executor, so this is an operational resilience issue rather than an immediate exploit.

### Impact

If instance TTL maintenance fails for the full retention period, GovernanceModule becomes unavailable until its contract instance is restored. Controller cannot validate routes during that interval, blocking new policy sales.

### Recommendation

Call `extend_ttl` from committed operational paths, particularly `route_status` when invoked by Controller and all route mutations. Retain the external extender as defense in depth and alert well before the instance reaches archival.

---

## Methodology

The assessment included:

- direct review of all in-scope GovernanceModule source files;
- route lifecycle, uniqueness, and restoration analysis;
- persistent and instance TTL analysis;
- Controller, FlightPoolManager, and OracleAggregator identity tracing;
- route-term snapshot and idempotency analysis;
- production TTL executor review;
- execution of the Controller, GovernanceModule, and OracleAggregator unit suites.

The relevant contract suites completed successfully with 137 passing tests and no failures.

---

# Limitations

This assessment represents a point-in-time review of the specified repository state. The assessment does not guarantee the absence of vulnerabilities, defects, design weaknesses, implementation errors, operational failures, or economic risks.

# Disclaimer

No representation, warranty, or guarantee is made regarding the completeness, accuracy, reliability, suitability, or correctness of the assessment results. The absence of reported findings does not imply the absence of vulnerabilities, defects, security weaknesses, or exploitable conditions. This assessment should not be relied upon as the sole basis for security, investment, deployment, governance, operational, or business decisions.

The assessment does not constitute:

- a formal security certification;
- a guarantee of security;
- legal advice;
- financial advice;
- investment advice;
- compliance certification;
- a substitute for professional security auditing services.

Neither the assessment provider, report author, AI systems used during analysis, nor any affiliated parties shall be liable for direct, indirect, incidental, consequential, special, or punitive damages arising from use of this report or reliance on its contents.
