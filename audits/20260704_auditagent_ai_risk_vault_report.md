# Nethermind AuditAgent AI: Sentinel RiskVault Findings Report

**Date:** 4 July 2026

This report presents the Nethermind AuditAgent AI Auditor findings for the Sentinel Protocol RiskVault. Severity reflects likely protocol impact, exploitability, and operational risk in the assessed repository snapshot.

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

- `contracts/risk_vault/src/auth.rs`
- `contracts/risk_vault/src/capital.rs`
- `contracts/risk_vault/src/claims.rs`
- `contracts/risk_vault/src/constants.rs`
- `contracts/risk_vault/src/error.rs`
- `contracts/risk_vault/src/events.rs`
- `contracts/risk_vault/src/lib.rs`
- `contracts/risk_vault/src/queries.rs`
- `contracts/risk_vault/src/snapshot.rs`
- `contracts/risk_vault/src/storage.rs`
- `contracts/risk_vault/src/traits.rs`
- `contracts/risk_vault/src/upgrade.rs`
- `contracts/risk_vault/src/vault_ops.rs`

The Controller settlement integration and FlightPoolManager payout flow were reviewed where necessary to determine withdrawal-queue reachability and liquidity conditions.

### Out of Scope

- Production infrastructure and operator configuration
- Frontend applications
- Compromise of owner, Controller, or keeper credentials
- Contracts outside the RiskVault integration boundary, except for impact analysis
- Third-party dependencies except where directly invoked by RiskVault
- Economic assumptions not represented by the assessed implementation

---

## Executive Summary

The assessment identified four findings: one Medium-severity withdrawal-availability issue, two Low-severity integration/accounting issues, and one Informational reporting issue.

The finding concerns the shared bounded withdrawal queue. RiskVault limits each address to 20 pending withdrawal requests and caps the queue at 250 total requests, but the limit is not bound to an economic actor. Because vault shares are fungible and transferable, one funded participant can split shares across enough addresses to occupy the full queue. Once full, later underwriters cannot enter the FIFO exit path, and direct withdrawals remain unavailable while any request is pending.

The Low findings concern executable ERC-4626-style paths and their view functions. Direct `withdraw` and `redeem` intentionally revert while the withdrawal queue is active, but `max_withdraw` and `max_redeem` can still return positive limits. Separately, `deposit` and `redeem` do not reject positive inputs whose rounded conversion result is zero, allowing successful transactions that transfer value while minting no shares or burning shares for no assets.

The Informational finding concerns the daily snapshot path. Runtime vault pricing uses `TotalManagedAssets` as the net backing basis, but `snapshot()` uses the underlying `Vault::total_assets(e)` raw token balance. Processed-but-uncollected claimable balances can therefore inflate reported snapshot prices even though they no longer back outstanding shares.

### Findings Summary

| ID | Severity | Title |
| --- | --- | --- |
| AA-RV-01 | Medium | Sybil addresses can monopolize the bounded withdrawal queue |
| AA-RV-02 | Low | `max_withdraw` and `max_redeem` ignore active withdrawal queue |
| AA-RV-03 | Low | Zero-result conversions can donate user value |
| AA-RV-04 | Informational | Share-price snapshots use raw token balance instead of managed assets |

### Severity Distribution

| Critical | High | Medium | Low | Informational |
| ---: | ---: | ---: | ---: | ---: |
| 0 | 0 | 1 | 2 | 1 |

### Overall Risk Rating

**Medium**

The issue can deny underwriters access to the queued withdrawal path during stressed liquidity conditions. It does not directly steal assets and requires the attacker to own and escrow positive-value shares, but it can block exits for other underwriters until queue processing or cancellations reduce queue occupancy.

---

# Detailed Findings

## [AA-RV-01] Sybil addresses can monopolize the bounded withdrawal queue

| Field | Value |
| --- | --- |
| **Severity** | Medium |
| **Affected Components** | `request_withdrawal`, `cancel_withdrawal`, `process_withdrawal_queue`, direct `withdraw`, and direct `redeem` |
| **Impact** | Honest underwriters can be prevented from entering the FIFO withdrawal path |

### Description

RiskVault stores pending exits in one global withdrawal queue. New requests are rejected once the queue reaches `MAX_WITHDRAWAL_QUEUE_LEN`:

```rust
if queue.len() >= MAX_WITHDRAWAL_QUEUE_LEN {
    panic_with_error!(e, Error::WithdrawalQueueFull);
}
```

The current cap is:

```rust
pub(crate) const MAX_WITHDRAWAL_QUEUE_LEN: u32 = 250;
```

RiskVault also limits the number of active requests owned by the exact caller address:

```rust
let mut own_count: u32 = 0;
for i in 0..queue.len() {
    if queue.get(i).unwrap().owner == caller {
        own_count = own_count.checked_add(1).expect("count overflow");
    }
}
if own_count >= MAX_ACTIVE_REQUESTS_PER_ADDRESS {
    panic_with_error!(e, Error::TooManyActiveRequests);
}
```

The per-address cap is:

```rust
pub(crate) const MAX_ACTIVE_REQUESTS_PER_ADDRESS: u32 = 20;
```

This prevents a single address from filling the queue alone, but it does not prevent one economic actor from splitting vault shares across multiple addresses. Each request only needs to be positive-value at submission:

```rust
if managed_convert_to_assets(e, shares, Rounding::Floor) <= 0 {
    panic_with_error!(e, Error::SharesRedeemToZeroAssets);
}
```

The queued shares are not destroyed while waiting. They are escrowed at request time and can be returned through cancellation:

```rust
Base::update(
    e,
    Some(&e.current_contract_address()),
    Some(&caller),
    request.shares,
);
```

Direct exits are not available as a fallback while the queue is non-empty:

```rust
if !Self::get_withdrawal_queue(e).is_empty() {
    panic_with_error!(e, Error::WithdrawalQueueActive);
}
```

As a result, a funded participant can divide shares across enough addresses to fill the bounded queue, preventing later users from submitting withdrawal requests. With a 250-request global cap and a 20-request per-address cap, 13 addresses are sufficient to occupy every slot.

### Failure Scenario

1. Free capital is constrained by locked insurance exposure, so queued withdrawal is the practical exit path.
2. A funded participant splits vault shares across multiple addresses.
3. Those addresses submit positive-value withdrawal requests until the 250-slot queue is full.
4. A later underwriter attempts to submit a withdrawal request and receives `WithdrawalQueueFull`.
5. The later underwriter cannot bypass the queue with direct `withdraw` or `redeem` because any non-empty queue triggers `WithdrawalQueueActive`.
6. The queue remains unavailable for new entrants until keeper processing drains enough requests or existing request owners cancel.

### Impact

The queue can be monopolized by a single economic actor using Sybil addresses. This can:

- deny honest underwriters access to the FIFO exit path;
- let the occupying actor hold priority over newly available free capital;
- force exit availability to depend on keeper throughput and attacker cancellation behavior;
- amplify liquidity stress when underwriters most need predictable withdrawal access.

The attacker must own positive-value vault shares and escrow them while occupying the queue. Queue processing can also reduce occupancy when sufficient free capital is available. These constraints limit the issue to Medium severity.

### Recommendation

Add queue-admission controls that are harder to bypass through address splitting. Viable options include:

1. Require a meaningful minimum request size or minimum asset value per queue slot.
2. Charge a non-refundable or time-weighted queue admission fee that is large enough to make slot occupation economically expensive.
3. Store requests under individually keyed entries with a larger scalable capacity and paginated processing, so a bounded shared vector is not the scarce resource.
4. Add per-epoch or stake-weighted withdrawal admission rules that allocate queue capacity proportionally to economic ownership rather than address count.
5. Expose queue saturation metrics and alert operators when occupancy approaches the global cap.

The queue design should continue preserving FIFO fairness for accepted requests while preventing low-cost occupation of all admission slots.

---

## [AA-RV-02] `max_withdraw` and `max_redeem` ignore active withdrawal queue

| Field | Value |
| --- | --- |
| **Severity** | Low |
| **Affected Components** | `max_withdraw`, `max_redeem`, direct `withdraw`, and direct `redeem` |
| **Impact** | ERC-4626-style integrations can receive positive limits for calls that will revert |

### Description

RiskVault intentionally disables direct synchronous exits while the withdrawal queue is active:

```rust
if !Self::get_withdrawal_queue(e).is_empty() {
    panic_with_error!(e, Error::WithdrawalQueueActive);
}
```

This check exists in both `withdraw` and `redeem`. It preserves FIFO ordering once any underwriter is queued.

The corresponding maximum-view functions only account for pause state, user balance, and free capital:

```rust
fn max_withdraw(e: &Env, owner: Address) -> i128 {
    if paused(e) {
        return 0;
    }
    let owner_assets = managed_convert_to_assets(e, Base::balance(e, &owner), Rounding::Floor);
    let free = Self::get_free_capital(e);
    owner_assets.min(free)
}
```

```rust
fn max_redeem(e: &Env, owner: Address) -> i128 {
    if paused(e) {
        return 0;
    }
    let owner_shares = Base::balance(e, &owner);
    let free_shares = managed_convert_to_shares(e, Self::get_free_capital(e), Rounding::Floor);
    owner_shares.min(free_shares)
}
```

If the queue is non-empty and the owner has shares backed by free capital, these views can return positive values even though the executable direct exit path will revert.

### Failure Scenario

1. An underwriter submits a queued withdrawal request.
2. The global withdrawal queue becomes non-empty.
3. Another underwriter calls `max_withdraw` or `max_redeem`.
4. The view returns a positive amount because the vault is not paused and free capital exists.
5. The underwriter, frontend, or aggregator submits `withdraw` or `redeem` for that amount.
6. The transaction reverts with `WithdrawalQueueActive`.

### Impact

The issue can break integrations that rely on `max_withdraw` and `max_redeem` to avoid reverting calls. The impact is limited to integration reliability and user experience because funds are not lost and the queued withdrawal path remains available.

### Recommendation

Return zero from `max_withdraw` and `max_redeem` whenever the withdrawal queue is non-empty:

```rust
if paused(e) || !Self::get_withdrawal_queue(e).is_empty() {
    return 0;
}
```

Add tests proving that all `max_*` views reflect the same temporary execution limits as their corresponding state-changing entrypoints.

---

## [AA-RV-03] Zero-result conversions can donate user value

| Field | Value |
| --- | --- |
| **Severity** | Low |
| **Affected Components** | `deposit`, `redeem`, managed conversion helpers, and `stellar-tokens` internal vault plumbing |
| **Impact** | Users can execute value-destructive deposits or redemptions when rounding produces zero output |

### Description

RiskVault computes share and asset amounts with integer rounding, then passes the results directly into low-level vault plumbing:

```rust
let shares = managed_convert_to_shares(e, assets, Rounding::Floor);
Vault::deposit_internal(e, &receiver, assets, shares, &from, &operator);
```

```rust
let assets = managed_convert_to_assets(e, shares, Rounding::Floor);
Vault::withdraw_internal(e, &receiver, &owner, assets, shares, &operator);
```

The managed conversion helpers return zero for non-positive inputs and can also round a positive input down to zero when the input is too small relative to the current exchange rate:

```rust
mul_div_with_rounding(e, assets, supply_plus, managed_plus, rounding)
```

The underlying `deposit_internal` and `withdraw_internal` functions assume the caller has already validated the amounts. They transfer the asset and update share balances with the supplied values. `Base::update` rejects negative amounts but permits zero.

As a result, a positive `deposit` can transfer assets into the vault, increase `TotalManagedAssets`, and mint zero shares. A positive `redeem` can burn shares and transfer zero assets. In both cases, value is donated to the remaining shareholders rather than returned to the caller.

### Failure Scenario

1. The vault exchange rate rises enough that a very small positive asset deposit converts to zero shares under floor rounding.
2. A user or integration submits `deposit` with that positive asset amount.
3. The vault transfers the assets from the user and increases `TotalManagedAssets`.
4. The receiver receives zero shares.

The symmetric redemption case occurs when a small positive share amount converts to zero assets under floor rounding: the shares are burned, and the user receives no asset transfer.

### Impact

The issue can destroy user value in successful transactions. It does not allow an attacker to steal from another account directly, but it creates a footgun for users and integrations that submit small amounts without checking previews.

### Recommendation

Reject zero-result conversions in executable paths:

- `deposit`: require `assets > 0` and `shares > 0`;
- `mint`: require `shares > 0` and `assets > 0`;
- `withdraw`: require `assets > 0` and `shares > 0`;
- `redeem`: require `shares > 0` and `assets > 0`.

Use the existing RiskVault errors where appropriate, and add tests covering positive inputs that round to zero.

---

## [AA-RV-04] Share-price snapshots use raw token balance instead of managed assets

| Field | Value |
| --- | --- |
| **Severity** | Informational |
| **Affected Components** | `snapshot`, `get_snapshot_price`, `SharePriceSnapshot` events, and off-chain analytics |
| **Impact** | Reported historical share prices can include assets that no longer back outstanding shares |

### Description

RiskVault's executable share-conversion paths use `TotalManagedAssets` as the net backing basis:

```rust
fn total_assets(e: &Env) -> i128 {
    Self::get_total_managed_assets(e)
}
```

This is necessary because processed withdrawal amounts are removed from `TotalManagedAssets` and credited as `ClaimableBalance`, while the tokens remain physically held by the vault until `collect`.

The snapshot path uses the underlying `stellar-tokens` storage implementation directly:

```rust
let price = if total_supply > 0 {
    Vault::total_assets(e)
        .checked_mul(scale)
        .expect("multiplication overflow")
        .checked_div(total_supply)
        .expect("division by zero")
} else {
    scale
};
```

`Vault::total_assets(e)` reads the vault's raw token balance. That balance includes processed-but-uncollected `ClaimableBalance` liabilities and any unsolicited token transfers. Those assets no longer represent backing for outstanding shares, so the snapshot can report a higher price than RiskVault's executable conversions use.

The formula also omits the virtual share offset used by the conversion helpers, so low-supply snapshots can diverge from preview/conversion behavior even without claimable liabilities.

### Failure Scenario

1. An underwriter queues and processes a withdrawal.
2. RiskVault burns the shares and decreases `TotalManagedAssets`.
3. The withdrawn amount becomes a `ClaimableBalance`, but the tokens remain at the vault address until `collect`.
4. `snapshot()` runs before the underwriter collects.
5. The snapshot price uses the raw token balance and a reduced total supply.
6. The emitted and stored price is inflated relative to RiskVault's managed-asset share basis.

### Impact

No in-scope on-chain module uses snapshot prices for executable decisions. The impact is therefore limited to reporting, dashboards, monitoring, and any off-chain analytics that consume `SharePriceSnapshot` events or `get_snapshot_price`.

### Recommendation

Compute snapshots from the same managed-asset basis used by executable conversions:

```rust
Self::get_total_managed_assets(e)
```

If the snapshot is intended to mirror conversion previews exactly, include the same virtual offset terms used by `managed_convert_to_assets` and `managed_convert_to_shares`. Document whether the snapshot represents raw custody value or net managed share backing.

---

## Methodology

The assessment included:

- direct review of all in-scope RiskVault source files;
- withdrawal queue admission and cancellation analysis;
- direct exit behavior review while the queue is active;
- share-conversion and positive-value request checks;
- maximum-withdrawal view consistency review;
- snapshot price-basis review;
- Controller settlement and keeper processing reachability review;
- review of existing queue-cap and per-address-cap tests.

The review focused on user-reachable security impact under the stated trust model.

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
