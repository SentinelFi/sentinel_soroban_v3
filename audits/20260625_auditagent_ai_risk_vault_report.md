# Nethermind AuditAgent AI: Sentinel RiskVault Findings Report

**Date:** 25 June 2026

This report presents the Nethermind AuditAgent AI Auditor findings for the Sentinel Protocol RiskVault. Severity reflects likely protocol impact, exploitability, and operational risk in the assessed repository snapshot.

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

- `contracts/risk_vault/src/auth.rs`
- `contracts/risk_vault/src/capital.rs`
- `contracts/risk_vault/src/claims.rs`
- `contracts/risk_vault/src/constants.rs`
- `contracts/risk_vault/src/error.rs`
- `contracts/risk_vault/src/lib.rs`
- `contracts/risk_vault/src/queries.rs`
- `contracts/risk_vault/src/storage.rs`
- `contracts/risk_vault/src/traits.rs`
- `contracts/risk_vault/src/vault_ops.rs`

The `stellar-tokens` vault dependency and Controller settlement integration were reviewed where necessary to determine share-conversion behavior and reachable state transitions.

### Out of Scope

- Production infrastructure and operator configuration
- Frontend applications
- Compromise of owner, Controller, or keeper credentials
- Contracts outside the RiskVault integration boundary, except for impact analysis
- Third-party dependencies except where directly invoked by RiskVault
- Economic assumptions not represented by the assessed implementation

---

## Executive Summary

The assessment identified three findings: one High-severity accounting vulnerability and two Medium-severity withdrawal-liveness issues.

The High finding arises from inconsistent asset accounting. RiskVault removes processed withdrawals from `TotalManagedAssets` and records them as claimable liabilities, but the corresponding tokens remain at the vault address. The underlying share-conversion implementation prices deposits and redemptions using the vault's complete token balance. Assets already owed to withdrawing users therefore continue to increase the value of outstanding shares. Existing shareholders can use this mismatch to extract nearly all assets contributed by a later depositor.

The Medium finding affects queued withdrawals whose value changes after submission. RiskVault rejects requests that are already worth zero assets, but a valid dust request can become zero-valued after an insurance payout reduces the vault's share price. Fifty such requests can permanently occupy the complete processing batch. Later valid requests are never reached, while direct withdrawals and redemptions remain blocked because the queue is non-empty.

The second Medium finding is a hard capacity limit in the monolithic withdrawal queue. The complete queue is stored inside the contract instance and rewritten on every request. In the assessed configuration, 385 requests fit, while the 386th makes the contract instance exceed Soroban's 65,536-byte entry limit. A single underwriter can fill this capacity with many small requests and prevent other users from entering the queue until keeper processing or cancellation shrinks it.

### Findings Summary

| ID | Severity | Title |
| --- | --- | --- |
| AA-RV-01 | High | Claimable withdrawal liabilities inflate the asset basis used for share pricing |
| AA-RV-02 | Medium | Requests that become zero-valued can permanently pin the withdrawal batch |
| AA-RV-03 | Medium | Monolithic withdrawal queue imposes a hard request-capacity ceiling |

### Severity Distribution

| Critical | High | Medium | Low | Informational |
| ---: | ---: | ---: | ---: | ---: |
| 0 | 1 | 2 | 0 | 0 |

### Overall Risk Rating

**High**

The accounting mismatch permits material value extraction from later depositors during normal withdrawal processing. The queue findings can separately block exit progress or prevent additional underwriters from entering the withdrawal queue.

---

# Detailed Findings

## [AA-RV-01] Claimable withdrawal liabilities inflate the asset basis used for share pricing

| Field | Value |
| --- | --- |
| **Severity** | High |
| **Affected Components** | `process_withdrawal_queue`, `collect`, vault share conversions, deposits, mints, withdrawals, and redemptions |
| **Impact** | Theft from later depositors and incorrect withdrawal pricing |

### Description

RiskVault maintains two different asset values:

1. `TotalManagedAssets`, used to calculate free and locked capital.
2. The physical asset-token balance, used by the underlying vault implementation for share conversions.

When a queued withdrawal is processed, RiskVault burns the escrowed shares, reduces `TotalManagedAssets`, and credits a pull-based `ClaimableBalance`:

```rust
Base::update(e, Some(&vault_addr), None, request.shares);

let new_balance = claimable.checked_add(assets).expect("addition overflow");
e.storage().persistent().set(&key, &new_balance);

tma = tma.checked_sub(assets).expect("subtraction underflow");
e.storage()
    .instance()
    .set(&VaultKey::TotalManagedAssets, &tma);
```

The associated tokens are not transferred until the user calls `collect`. They remain at the RiskVault address even though they no longer belong to outstanding shareholders.

RiskVault delegates share pricing to the `stellar-tokens` vault implementation:

```rust
fn total_assets(e: &Env) -> i128 {
    Vault::total_assets(e)
}
```

That implementation defines total assets as the token balance of the vault address. Its conversion formulas consequently include processed-but-uncollected withdrawal liabilities.

### Exploit Scenario

1. LP A and LP B each deposit 500 asset units.
2. LP A requests and processes a withdrawal worth 500.
3. LP A's shares are burned and 500 becomes claimable.
4. RiskVault still physically holds 1,000, although only 500 remains managed for LP B.
5. A victim deposits another 500.
6. The victim receives too few shares because the deposit is priced against the liability-inflated physical balance.
7. LP B redeems at the inflated exchange rate for almost 1,000.
8. LP A collects the separately owed 500.
9. The victim is left with approximately one base unit.

The attack does not require privileged access. It relies on ordinary deposits, queued withdrawals, and redemptions.

### Root Cause

Assets owed through `ClaimableBalance` are removed from protocol-managed accounting but remain included in the asset basis used for ERC-4626-style share conversion.

### Impact

The mismatch can:

- transfer nearly all of a later depositor's assets to existing shareholders;
- overvalue outstanding shares while claimable balances remain uncollected;
- cause deposit, mint, withdrawal, and redemption previews to report economically incorrect results;
- distort valuation between withdrawal requests processed in the same queue pass;
- make `TotalManagedAssets` and the externally reported `total_assets` represent incompatible concepts.

### Recommendation

Track aggregate claimable liabilities and use one net-asset basis for every share conversion:

```text
net_assets = physical_token_balance - total_claimable_liabilities
```

Use this value consistently for:

- `total_assets`;
- deposit and mint conversions;
- withdrawal and redemption conversions;
- all preview functions;
- maximum withdrawal and redemption calculations;
- share-price snapshots;
- withdrawal-queue valuation.

Alternatively, transfer processed withdrawal assets into a separate escrow contract whose balance is excluded from RiskVault share pricing.

Add invariant tests proving that:

1. creating a claimable withdrawal does not change the exchange rate of unrelated outstanding shares;
2. collecting a claimable balance does not change that exchange rate;
3. total backing assets equal net physical assets after subtracting all outstanding liabilities.

---

## [AA-RV-02] Requests that become zero-valued can permanently pin the withdrawal batch

| Field | Value |
| --- | --- |
| **Severity** | Medium |
| **Affected Components** | `request_withdrawal`, `process_withdrawal_queue`, direct `withdraw`, and direct `redeem` |
| **Impact** | Indefinite denial of underwriter withdrawals |

### Description

RiskVault rejects withdrawal requests that are worth zero assets when submitted:

```rust
if Vault::preview_redeem(e, shares) <= 0 {
    panic_with_error!(e, Error::SharesRedeemToZeroAssets);
}
```

This check does not guarantee that the request remains nonzero. Insurance payouts can reduce the vault's asset balance and share price after a request enters the queue. A small request that initially redeemed for one base asset unit can later round down to zero.

Queue processing retains zero-valued requests:

```rust
if assets == 0 {
    kept.push_back(request);
    continue;
}
```

The loop examines only the first `MAX_QUEUE_BATCH` entries, currently 50. If those 50 entries are zero-valued:

- every entry is retained;
- `processed` remains zero;
- the queue is not rewritten;
- later requests are outside the batch window and are never evaluated.

Repeating the keeper call starts with the same 50 entries and produces no progress.

Direct exits do not provide a fallback. Both `withdraw` and `redeem` revert whenever the withdrawal queue is non-empty.

### Failure Scenario

1. An attacker deposits assets and obtains vault shares.
2. The attacker submits 50 small withdrawal requests. Each request is worth one base asset unit and passes the submission guard.
3. A victim submits a larger, serviceable withdrawal request behind them.
4. A delayed or cancelled flight payout reduces the vault's share price.
5. Each attacker request now previews to zero, while the victim's request remains valuable.
6. `process_withdrawal_queue` inspects the first 50 requests, retains all of them, and never reaches the victim.
7. Subsequent maintenance calls repeat the same batch.
8. The victim cannot use direct redemption because the queue remains non-empty.

An adversarial test reproduced this sequence: after a 50% vault loss, all 50 accepted dust requests became zero-valued, two consecutive queue-processing calls left all 51 requests unchanged, and the valid account's direct redemption remained blocked.

### Root Cause

The submission guard assumes a request's asset value cannot later round to zero. The processing path retains zero-valued entries but provides no permissionless mechanism to remove, cancel, or advance past a full batch of them.

### Impact

An attacker with a small number of shares can indefinitely block queued and direct withdrawals for every underwriter after a sufficient decline in share price. The attacker can cancel its own requests but has no incentive to do so.

The issue does not directly steal assets and requires both queue preparation and a later decline in vault value, supporting a Medium severity classification.

### Recommendation

Ensure zero-valued requests cannot permanently consume queue capacity. Suitable approaches include:

1. Remove zero-valued requests during processing and return their escrowed shares to the owner.
2. Move zero-valued requests into a separate recoverable list while advancing the active queue head.
3. Store requests under individual keys with a monotonic head pointer, allowing the processor to advance past non-serviceable dust.
4. Permit anyone to prune a zero-valued request while preserving the owner's right to recover its shares.
5. Bound the number of requests an address can place in one active queue.

Do not burn a zero-valued request's shares without compensation. Add a regression test in which requests are nonzero at submission, become zero after `send_payout`, and precede a valid withdrawal by at least `MAX_QUEUE_BATCH` positions.

---

## [AA-RV-03] Monolithic withdrawal queue imposes a hard request-capacity ceiling

| Field | Value |
| --- | --- |
| **Severity** | Medium |
| **Affected Components** | `request_withdrawal`, `cancel_withdrawal`, `process_withdrawal_queue`, `get_withdrawal_queue`, and contract instance storage |
| **Impact** | Withdrawal admission denial and increasing queue-operation cost |

### Description

RiskVault stores every pending withdrawal request in one instance-storage vector:

```rust
WithdrawalQueue, // Vec<WithdrawalRequest>
```

Each request reads, appends to, and rewrites the complete vector:

```rust
let mut queue: Vec<WithdrawalRequest> = e
    .storage()
    .instance()
    .get(&VaultKey::WithdrawalQueue)
    .unwrap_or(Vec::new(e));

queue.push_back(WithdrawalRequest {
    request_id,
    owner: caller,
    shares,
    timestamp: e.ledger().timestamp(),
});

e.storage()
    .instance()
    .set(&VaultKey::WithdrawalQueue, &queue);
```

Cancellation also reads the full vector, performs a linear scan and removal, and rewrites the complete value. Queue processing examines at most 50 serviceable entries but still iterates over and reconstructs the entire vector to preserve entries outside the active batch.

Soroban applies a 65,536-byte limit to the complete contract-instance entry. The queue shares that entry with all other instance state and therefore has a finite capacity independent of available user shares or fees.

### Technical Evidence

A resource-enforced test submitted small, positive-value withdrawal requests from one funded account:

| Queue State | Result |
| --- | --- |
| 385 requests | Accepted and readable |
| 386th request | Reverted |
| Attempted contract-instance size | 65,692 bytes |
| Maximum permitted size | 65,536 bytes |

At 385 requests, processing a 50-request batch succeeded and reduced the queue to 335. Cancelling the last remaining request also succeeded. The capacity limit therefore does not permanently corrupt the queue, but no additional request can enter while it remains full.

The exact threshold can change if other instance fields or the serialized request representation change.

### Failure Scenario

1. An underwriter deposits assets and divides its shares among many small requests.
2. The account fills the queue to its instance-entry capacity.
3. Another underwriter attempts to request a withdrawal.
4. Appending the request would exceed the contract-instance size limit, so the transaction reverts.
5. Direct `withdraw` and `redeem` are also unavailable because any non-empty queue activates `WithdrawalQueueActive`.
6. Admission remains unavailable until the keeper processes requests or existing owners cancel enough entries.

An attacker can repeat submissions after maintenance to keep the queue near capacity. Every request requires owned, positive-value shares, which imposes an economic cost and prevents unlimited cost-free spam.

### Impact

The issue can:

- prevent legitimate underwriters from joining the withdrawal queue;
- make request, cancellation, query, and processing costs grow with total queue length;
- force all withdrawal availability to depend on timely keeper processing;
- let a high-volume participant repeatedly consume shared queue capacity;
- make future additions to contract instance state reduce queue capacity further.

Recovery through processing or cancellation remains possible at the demonstrated boundary. The issue does not directly steal funds and requires an attacker to escrow owned shares, supporting a Medium severity classification.

### Recommendation

Replace the monolithic vector with individually keyed requests and explicit queue pointers:

```text
WithdrawalHead -> u64
WithdrawalTail -> u64
WithdrawalRequest(request_id) -> request
```

Processing should advance a bounded head pointer without reconstructing unrelated requests. Cancellation can mark an individual request cancelled or remove its keyed entry.

Additionally:

1. enforce a per-address limit on active requests;
2. expose paginated queue queries instead of returning the entire collection;
3. add resource-enforced tests at the maximum supported queue depth;
4. publish capacity and maintenance metrics for keeper monitoring;
5. provide a migration path for the existing instance vector.

---

## Methodology

The assessment included:

- direct review of all in-scope RiskVault source files;
- Controller authorization and cross-contract call tracing;
- physical-balance, managed-asset, locked-capital, and liability reconciliation;
- review of the `stellar-tokens` vault conversion formulas;
- deposit, redemption, withdrawal-queue, and claimable-balance state analysis;
- transaction-ordering and share-price-change analysis;
- adversarial multi-account withdrawal sequences;
- dynamic reproduction of accounting and queue-liveness behavior;
- contract-instance entry-size and queue-capacity testing;
- review of transaction atomicity and existing defense-in-depth checks.

The review focused on reachable security impact. Findings dependent only on hypothetical misuse by the authenticated Controller were excluded where the production integration transfers assets before updating accounting in the same atomic transaction.

---

## Remediation Priority

1. **AA-RV-01:** Remove claimable liabilities from the asset basis used for share pricing.
2. **AA-RV-02:** Guarantee queue progress when accepted requests later become zero-valued.
3. **AA-RV-03:** Replace the monolithic withdrawal vector with individually keyed requests.

AA-RV-01 should be remediated before accepting production liquidity. AA-RV-02 and AA-RV-03 should be addressed before enabling unrestricted queued withdrawals.

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
