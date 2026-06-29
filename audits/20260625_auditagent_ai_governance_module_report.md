# Nethermind AuditAgent AI: Sentinel GovernanceModule Findings Report

**Date:** 25 June 2026

This report presents the Nethermind AuditAgent AI Auditor findings for the Sentinel Protocol GovernanceModule. Severity reflects likely protocol impact, exploitability, and operational risk in the assessed repository snapshot.

---

## Assessment Information

| | |
| --- | --- |
| **Project Name** | Sentinel Protocol |
| **Network** | Stellar |
| **Smart Contract Platform** | Soroban |
| **Programming Language** | Rust |
| **Assessment Date(s)** | 2026-06-25 |
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
| **Git Commit Hash** | `2adc2f688a61b2bca0ae2a8e468814fae9dfb6d7` |
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

The Controller, FlightPoolManager, and production TTL executor were reviewed where necessary to assess downstream impact and existing defense-in-depth controls.

### Out of Scope

- Production infrastructure and operator configuration
- Frontend applications
- Compromise of owner or governance administrator credentials
- Contracts outside the GovernanceModule integration boundary, except for impact analysis
- Economic assumptions not represented by the assessed implementation

---

## Executive Summary

The assessment identified two findings: one Medium-severity issue and one Low-severity issue.

The primary risk is caused by inconsistent TTL management between route records and the separate `FlightRoute` uniqueness index. Normal route reads and updates keep `Route(flight_id, origin, destination)` alive but do not renew `FlightRoute(flight_id)`. Once the index archives, governance can accept a second route using the same flight ID. Downstream contracts omit origin and destination from their policy and oracle keys, so the two routes collide in shared `(flight_id, date)` state.

The second issue concerns mutable global defaults. A valid defaults update can cause an existing partially overridden route to resolve to economically invalid terms while `route_status` continues reporting the route as active. FlightPoolManager now rejects these terms before funds move, preventing the previously possible settlement failure. However, purchases for the affected route remain unavailable until governance repairs its configuration.

### Findings Summary

| ID | Severity | Title |
| --- | --- | --- |
| AA-GM-01 | Medium | FlightRoute uniqueness index can expire independently and permit route collisions |
| AA-GM-02 | Low | Mutable defaults can leave active routes with terms rejected by FlightPoolManager |

### Severity Distribution

| Critical | High | Medium | Low | Informational |
| ---: | ---: | ---: | ---: | ---: |
| 0 | 0 | 1 | 1 | 0 |

### Overall Risk Rating

**Medium**

The route-identity issue can corrupt the protocol's assumption that each flight ID represents one physical route and can mix or deny policies in downstream contracts. The defaults issue is contained by a downstream registration guard but can still interrupt policy sales.

---

# Detailed Findings

## [AA-GM-01] FlightRoute uniqueness index can expire independently and permit route collisions

| Field | Value |
| --- | --- |
| **Severity** | Medium |
| **Affected Components** | `whitelist_route`, `route_status`, route mutation functions, `remove_route`, and `DataKey::FlightRoute` |
| **Impact** | Downstream policy-state collision, purchase denial, and incorrect flight-outcome attribution |

### Description

Governance stores each route under:

```text
Route(flight_id, origin, destination)
```

It separately stores:

```text
FlightRoute(flight_id) -> (origin, destination)
```

The second entry enforces the invariant that one flight ID maps to only one route. This invariant is necessary because FlightPoolManager and OracleAggregator identify flight state only by `(flight_id, date)`.

`whitelist_route` writes both persistent entries and assigns both a 60-day TTL:

```rust
let fr_key = DataKey::FlightRoute(flight_id.clone());
if let Some((existing_origin, existing_dest)) =
    e.storage().persistent().get::<_, (Symbol, Symbol)>(&fr_key)
{
    if !(existing_origin == origin && existing_dest == dest) {
        panic_with_error!(e, Error::FlightIdAlreadyMapped);
    }
}

e.storage().persistent().set(&key, &terms);
extend_route_ttl(e, &key);

e.storage()
    .persistent()
    .set(&fr_key, &(origin.clone(), dest.clone()));
extend_route_ttl(e, &fr_key);
```

The entries do not remain synchronized. `route_status` renews only the route key:

```rust
let key = DataKey::Route(flight_id, origin, dest);
let terms: Option<RouteTerms> = e.storage().persistent().get(&key);

// ...
extend_route_ttl(e, &key);
```

`disable_route`, `enable_route`, and `update_route_terms` also renew only `Route(...)`. The current executor extends contract instance TTL but does not implement key-level extension for route-related persistent entries.

An actively used route can therefore remain live while its uniqueness index archives. After archival, `whitelist_route` reads `None` for `FlightRoute(flight_id)` and accepts a different origin and destination for the same flight ID.

### Failure Scenario

1. Governance whitelists `AA100 / JFK / LAX`.
2. Purchases and route management continue renewing `Route(AA100, JFK, LAX)`.
3. `FlightRoute(AA100)` receives no further renewal and archives after its TTL.
4. An owner or administrator later whitelists `AA100 / SFO / ORD`.
5. The uniqueness check sees no `FlightRoute(AA100)` entry and accepts the second route.
6. Both routes are active, but downstream policy and oracle state for the same date is keyed only by `(AA100, date)`.

If the two routes resolve to different terms, the second purchase for an already registered date reverts with `FlightTermsMismatch`. If their terms match, buyers from both physical routes are recorded in the same pool and use the same oracle lifecycle. One flight's outcome can consequently govern payouts for policies associated with the other route.

An additional consistency failure exists in `remove_route`. Once a collision exists, removing the older disabled route unconditionally removes `FlightRoute(flight_id)`, even when that index currently points to the newer route. This reopens the flight ID for further conflicting routes.

### Impact

The issue can:

- block legitimate purchases for one of the colliding routes;
- combine buyers from separate physical flights into one risk pool;
- attribute cancellation or delay outcomes to the wrong policies;
- misallocate vault payouts and premium income;
- allow repeated route collisions after removal operations;
- require governance intervention and potentially contract migration to restore consistent identity.

The collision requires an owner or governance administrator to whitelist the second route. However, the contract silently removes the intended safety invariant through normal TTL behavior, making an otherwise valid administrative operation unsafe.

### Recommendation

Keep the route and uniqueness ownership synchronized.

At minimum:

1. Renew `FlightRoute(flight_id)` whenever `Route(...)` is read or mutated.
2. In `route_status`, derive both keys before consuming the symbols and extend both TTLs.
3. In `disable_route`, `enable_route`, and `update_route_terms`, verify that `FlightRoute(flight_id)` matches the route being changed and renew it.
4. In `remove_route`, remove the index only if its stored `(origin, destination)` matches the route being removed.
5. Implement key-level TTL extension for both route entries in the production executor.
6. Add recovery logic for a missing index that reconstructs it only after proving no conflicting route exists.

Preferably, eliminate the parallel-key invariant by using one canonical flight-instance identifier throughout GovernanceModule, Controller, FlightPoolManager, and OracleAggregator.

---

## [AA-GM-02] Mutable defaults can leave active routes with terms rejected by FlightPoolManager

| Field | Value |
| --- | --- |
| **Severity** | Low |
| **Affected Components** | `set_defaults`, `resolve_terms`, `route_status`, and `enable_route` |
| **Impact** | Policy purchase denial for affected routes |

### Description

Routes may override only selected policy fields. Fields stored as `None` are resolved against mutable global defaults:

```rust
ResolvedTerms {
    premium: terms.premium.unwrap_or(default_premium),
    payoff: terms.payoff.unwrap_or(default_payoff),
    delay_hours: terms.delay_hours.unwrap_or(default_delay_hours),
}
```

Route writes validate the fully resolved values at the time of the write. `set_defaults`, however, validates only the new defaults against each other. It cannot determine whether those defaults remain compatible with every stored partial override.

For example:

1. Defaults are `premium = 10`, `payoff = 100`.
2. A route stores `premium = Some(90)` and `payoff = None`.
3. The route initially resolves to `premium = 90`, `payoff = 100` and is valid.
4. The owner updates defaults to `premium = 10`, `payoff = 50`.
5. The route now resolves to `premium = 90`, `payoff = 50`.
6. `route_status` still returns `Active(ResolvedTerms)`.

`enable_route` similarly changes only the `approved` flag and does not revalidate resolved terms against current defaults.

### Existing Downstream Control

FlightPoolManager applies a defense-in-depth check during registration:

```rust
if payoff <= premium {
    panic_with_error!(e, Error::PayoffNotAbovePremium);
}
```

Controller invokes `register_flight` before transferring the traveler's premium or locking vault collateral. Therefore, invalid terms cannot be stored in a new FlightConfig and cannot reach the settlement-underflow path.

This control limits the current impact to purchase denial. It does not correct the GovernanceModule inconsistency: an invalid route remains reported as active and appears sellable to callers.

Existing FlightConfig records are unaffected because their terms were already snapshotted at registration.

### Impact

A routine owner defaults update can silently disable policy sales for routes whose partial overrides become incompatible:

- `route_status` reports the route as active;
- Controller proceeds into the purchase flow;
- FlightPoolManager rejects registration;
- the transaction reverts before funds move;
- frontend and integration behavior can disagree with governance status.

The issue is owner-triggered and protected from financial loss by the downstream guard, supporting a Low severity classification.

### Recommendation

Ensure every route reported as active resolves to valid terms.

Options include:

1. Store fully resolved route terms rather than mutable fallback references.
2. Maintain an enumerable route index and revalidate all dependent routes before committing new defaults.
3. Track which routes depend on each default field and validate only affected routes.
4. Add validation to `route_status` and return a distinct invalid or disabled state instead of `Active`.
5. Revalidate resolved terms in `enable_route`.
6. Provide a two-step defaults update that first identifies incompatible routes and requires their remediation.

Retain the FlightPoolManager guard as defense in depth.

---

## Methodology

The assessment included:

- direct review of all in-scope GovernanceModule source files;
- authorization and administrative-role analysis;
- route lifecycle and storage-key analysis;
- persistent and instance TTL analysis;
- default-resolution and economic-invariant analysis;
- Controller and FlightPoolManager integration tracing;
- adversarial state-sequence testing;
- review of downstream defense-in-depth controls.

The review focused on reachable security and availability impact in the assessed implementation.

---

## Remediation Priority

1. **AA-GM-01:** Synchronize or eliminate the separate FlightRoute uniqueness index.
2. **AA-GM-02:** Prevent GovernanceModule from reporting economically invalid routes as active.

AA-GM-01 should be addressed before route volume or contract age approaches the 60-day uniqueness-index TTL.

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
