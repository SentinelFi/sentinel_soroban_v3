# Codex: Sentinel Soroban Findings Report

## Assessment Information

|                              |                                      |
| ---------------------------- | ------------------------------------ |
| Project Name                 | Sentinel Protocol                    |
| Network                      | Stellar                              |
| Smart Contract Platform      | Soroban                              |
| Programming Language         | Rust                                 |
| Assessment Date(s)           | 2026-05-31                           |
| Report Version               | v1.0                                 |
| Assessment Status            | Final                                |
| Assessment Type              | AI-Assisted Internal Security Review |
| Auditor(s)                   | Codex                                |

---

## Repository Information

|                           |                                                             |
| ------------------------- | ----------------------------------------------------------- |
| Repository URL            | https://github.com/SentinelFi/sentinel_soroban_v3/tree/main |
| Repository Visibility     | Public                                                      |
| Branch Name               | main                                                        |
| Git Commit Hash           | 09b32f3c8f9fde657b1b21b8def214af8822b816                  |
| Assessment Snapshot       | Source code state corresponding to the commit hash above    |

---

## Scope

### In Scope

The following files and folders were included in the assessment scope:

- `contracts/controller`
- `contracts/flight_pool_manager`
- `contracts/governance_module`
- `contracts/mock_usdc`
- `contracts/oracle_aggregator`
- `contracts/risk_vault`
- `contracts/sentinel_types`

### Out of Scope

The following files and folders were explicitly excluded from the assessment:

- `contracts/integration_tests`

---

## Executive Summary

| ID | Severity | Title |
| --- | --- | --- |
| ASF-01 | High | Future-dated purchases can outlive buyer policy keys, making valid claims impossible |
| ASF-02 | Medium | Direct withdraw/redeem bypasses the withdrawal queue and can take liquidity before queued exits |
| ASF-03 | Deployment Critical | `mock_usdc` has permissionless minting and must never back production value |

## ASF-01: Future-Dated Purchases Can Outlive Buyer Policy Keys, Making Valid Claims Impossible

**Severity:** High

**Affected code:**

- `contracts/controller/src/purchase.rs::buy_insurance`
- `contracts/controller/src/storage.rs::MAX_MIN_LEAD_TIME_SECS`
- `contracts/flight_pool_manager/src/storage.rs::BUYER_TTL_LEDGERS`
- `contracts/flight_pool_manager/src/lifecycle.rs::add_buyer`
- `contracts/flight_pool_manager/src/claim.rs::claim`

**Issue:**

`buy_insurance` enforces only a minimum lead time:

```rust
assert!(date > earliest_allowed, "departure too soon");
```

There is no maximum future booking date. A buyer can purchase insurance for a flight date more than 180 days in the future.

The pool records the buyer under:

```rust
PoolKey::Buyer(flight_id, date, buyer)
```

and extends that key to a fixed 180-day TTL:

```rust
pub(crate) const BUYER_TTL_LEDGERS: u32 = 3_110_400;
```

The code comment says this covers a worst-case 90-day book-ahead window plus a 60-day claim window and 30-day buffer, but the 90-day book-ahead assumption is not enforced by `buy_insurance`. The only 90-day bound in the controller is the maximum configurable minimum lead time, not a maximum allowed flight date.

When the flight eventually settles delayed or cancelled, `claim` requires the buyer key to still exist:

```rust
let has_policy: bool = e.storage().persistent().get(&buyer_key).unwrap_or(false);
assert!(has_policy, "no policy");
```

If the buyer key expired before settlement/claim, the buyer is treated as having no policy.

**Impact:**

A valid buyer can pay premium, have vault collateral locked for their policy, and later be unable to claim solely because the buyer policy key aged out. If the flight is delayed or cancelled, the pool still has aggregate `buyer_count` accounting, but the individual buyer cannot prove policy ownership through `claim`.

After claim expiry, `sweep_expired` can move the unclaimed payoff into `RecoveredBalance`, allowing the pool owner to withdraw funds that should have been claimable by the buyer. This is not an external attacker drain by itself, but it is a concrete user-fund loss path and can become value extraction under an owner/operator adversary model.

**Exploit scenario:**

1. Buyer purchases insurance for a whitelisted route with `date = now + 365 days`.
2. `buy_insurance` accepts the date because it only checks `date > now + min_lead_time`.
3. `add_buyer` writes `Buyer(flight_id, date, buyer)` with a 180-day TTL.
4. More than 180 days pass before the flight reaches the claimable lifecycle.
5. The buyer key expires.
6. Flight settles delayed or cancelled.
7. Buyer calls `claim`, but `has_policy` returns `false`; the claim reverts with `no policy`.
8. After `claim_expiry`, unclaimed payoff can be swept to recovered funds.

**Recommendation:**

Add an explicit maximum future booking window in `buy_insurance`, and make it consistent with all policy-related TTLs. For example:

- enforce `date <= now + MAX_BOOK_AHEAD_SECS`;
- set `MAX_BOOK_AHEAD_SECS + MAX_CLAIM_EXPIRY_WINDOW_SECS + safety_buffer` lower than the buyer key TTL;
- extend buyer keys at settlement if claims may outlive the initial TTL;
- consider storing per-policy ownership in a structure whose TTL is tied to the actual claim deadline rather than purchase time.

Also apply the same maximum-date reasoning to `FlightConfig`, `FlightData`, and traveler indexes so policy lifecycle storage cannot expire before the policy lifecycle ends.

## ASF-02: Direct withdraw/redeem Bypasses the Withdrawal Queue and Can Take Liquidity Before Queued Exits

**Severity:** Medium

**Affected code:**

- `contracts/risk_vault/src/vault_ops.rs::withdraw`
- `contracts/risk_vault/src/vault_ops.rs::redeem`
- `contracts/risk_vault/src/claims.rs::request_withdrawal`
- `contracts/risk_vault/src/capital.rs::process_withdrawal_queue`

**Issue:**

The vault implements a queued withdrawal path:

```rust
request_withdrawal -> process_withdrawal_queue -> collect
```

but direct ERC-4626-style exits remain callable:

```rust
fn withdraw(...)
fn redeem(...)
```

These direct exits are only limited by `assets <= Self::get_free_capital(e)`. They do not check whether a withdrawal queue exists and do not reserve newly available free capital for already queued requests.

This means an LP who has not entered the queue can redeem or withdraw free capital immediately, while earlier LPs who did enter the queue must wait for keeper-driven `process_withdrawal_queue`.

**Impact:**

The queue does not provide reliable ordering or liquidity reservation. After settlement frees capital, a direct redeemer can consume available free capital before queue maintenance runs, delaying or starving queued exits.

This is not a protocol-wide value creation bug: the direct redeemer still burns shares and is capped by free capital. The security issue is fairness and liquidity priority. If the queue is intended to be the canonical exit path during constrained liquidity, leaving direct exits open defeats that design.

**Scenario:**

1. LP-A calls `request_withdrawal`; their shares are escrowed in the vault and they wait in `WithdrawalQueue`.
2. Locked capital prevents the queue from being processed immediately.
3. A flight settles on time or otherwise unlocks free capital.
4. Before the keeper calls `run_queue_maintenance`, LP-B directly calls `redeem` or `withdraw`.
5. LP-B consumes the newly freed capital.
6. LP-A remains queued, even though they requested exit first.

**Recommendation:**

Choose one exit model and enforce it consistently:

- If the queue is the intended constrained-liquidity path, make direct `withdraw` and `redeem` return/revert when `WithdrawalQueue` is non-empty or when locked capital exists.
- Alternatively, remove the queue and rely on direct pro-rata exits only.
- If both paths must exist, reserve free capital for queued requests before allowing direct withdrawals, or process a bounded queue prefix inside direct exit calls before serving the caller.

## ASF-03: `mock_usdc` Has Permissionless Minting and Must Never Back Production Value

**Severity:** Deployment Critical

**Affected code:**

- `contracts/mock_usdc/src/lib.rs::mint`
- `contracts/mock_usdc/src/lib.rs::faucet`

**Issue:**

The mock token allows anyone to mint arbitrary balances:

```rust
pub fn mint(e: &Env, to: Address, amount: i128) {
    Base::mint(e, &to, amount);
}
```

and also exposes a permissionless faucet.

This is acceptable for local tests, but catastrophic if this contract is deployed as the `usdc_token` backing `RiskVault`, `Controller`, and `FlightPoolManager` in any environment where balances are treated as economically meaningful.

**Impact:**

If `mock_usdc` backs a live deployment, any user can mint unlimited "USDC", buy arbitrary policies, provide fake vault capital, distort share accounting, and render all insurance/vault economics meaningless. This would not drain an external real USDC issuer, but it would fully compromise any deployment that treats this token as valuable.

**Recommendation:**

Keep `mock_usdc` out of production deployment manifests and scripts. Add an explicit warning to deployment documentation, and consider adding a compile-time feature gate so permissionless minting is only available in test builds.

## Limitations

This assessment represents a point-in-time review of the specific repository state. The assessment does not guarantee the absence of vulnerabilities, defects, design weaknesses, implementation errors, or economic risks.

## Disclaimer

No representation, warranty, or guarantee is made regarding the completeness, accuracy, reliability, suitability, or correctness of the assessment results. The absence of reported findings does not imply the absence of vulnerabilities, defects, security weaknesses, or exploitable conditions. This assessment should not be relied upon as the sole basis for security, investment, deployment, governance, operational, or business decisions.

The assessment does not constitute:

- A formal security certification
- A guarantee of security
- Legal advice
- Financial advice
- Investment advice
- Compliance certification
- A substitute for professional security auditing services

Neither the assessment provider, report author(s), AI systems used during analysis, nor any affiliated parties shall be liable for any direct, indirect, incidental, consequential, special, or punitive damages arising from the use of this report or reliance on its contents.
