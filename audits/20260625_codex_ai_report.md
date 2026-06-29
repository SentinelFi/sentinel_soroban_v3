# Sentinel Protocol — Independent Smart Contract Security Assessment

**Assessment date:** 25 June 2026  
**Report version:** v1.0  
**Assessment status:** Final  
**Assessment type:** Manual, adversarial source-code review  
**Auditor:** Codex AI  

---

## Executive Summary

This assessment identified two previously unreported high-severity vulnerabilities in the reviewed Sentinel Protocol snapshot.

The most direct loss path arises from a mismatch between the on-chain policy identifier and the production oracle integration. A caller can create many policies for one physical flight by supplying different timestamps from the same calendar day. The contracts treat every timestamp as an independent insured flight, while the executor converts all of them to the same day and resolves them to the same AeroAPI flight record. A single delayed or cancelled flight can therefore produce many payouts to the same traveler and consume most or all vault capital.

The second issue allows liquidity providers to avoid losses, or capture gains, after a flight outcome is already public. Flight outcomes and settlement are recorded in separate transactions, while vault deposits and direct redemptions remain available between those transactions. An informed LP can redeem at the pre-loss share price after a cancellation is known but before the payout is charged to the vault. The remaining LPs absorb the exiting account's share of the loss.

Both findings were validated with dedicated integration reproductions against the assessed code. The temporary test files and generated snapshots were removed after validation and are not part of the repository changes.

### Findings Summary

| ID | Severity | Title | Primary Impact |
| --- | --- | --- | --- |
| CAI-H01 | High | Arbitrary timestamps create duplicate policies and payouts for one physical flight | Direct vault drain |
| CAI-H02 | High | Public outcomes give LPs a free option before settlement updates vault value | Loss evasion and value extraction from other LPs |

### Severity Distribution

| Critical | High | Medium | Low | Informational |
| ---: | ---: | ---: | ---: | ---: |
| 0 | 2 | 0 | 0 | 0 |

---

## Assessment Information

| Field | Value |
| --- | --- |
| Project | Sentinel Protocol |
| Network | Stellar |
| Smart contract platform | Soroban |
| Programming language | Rust |
| Repository | https://github.com/SentinelFi/sentinel_soroban_v3/tree/main |
| Branch | `main` |
| Commit | `2adc2f688a61b2bca0ae2a8e468814fae9dfb6d7` |
| Snapshot date | 2026-06-25 |

## Scope

### In Scope

- `contracts/controller`
- `contracts/flight_pool_manager`
- `contracts/governance_module`
- `contracts/mock_usdc`
- `contracts/oracle_aggregator`
- `contracts/risk_vault`
- `contracts/sentinel_types`

The production flight-data executor was reviewed only where necessary to establish whether an on-chain weakness is exploitable by the current protocol integration:

- `executor/centralized_cron/src/flight_data_fetcher.ts`
- `executor/centralized_cron/src/aeroapi_client.ts`

### Out of Scope

- `contracts/integration_tests`, except as a test harness for reproductions
- Frontend and unrelated off-chain services
- Compromise of owner, administrator, keeper, or oracle signing keys
- Economic assumptions not represented by the assessed implementation

## Methodology

The review traced:

- authorization and cross-contract invocation boundaries;
- policy purchase, collateral locking, outcome reporting, settlement, and claims;
- vault share issuance, redemption, queued withdrawals, and asset accounting;
- storage-key identity and state-machine consistency across contracts;
- oracle-to-contract data normalization;
- adversarial transaction ordering around outcome publication and settlement;
- direct and indirect paths capable of transferring or stranding vault assets.

Candidate findings were excluded unless their exploitability and material impact could be demonstrated from the current code. Previously documented findings were treated as known and were not repeated.

---

# Detailed Findings

## CAI-H01 — Arbitrary timestamps create duplicate policies and payouts for one physical flight

**Severity:** High  
**Impact:** Direct loss of vault assets  
**Likelihood:** High when an insured flight is delayed or cancelled  
**Confidence:** High

### Affected Components

- `contracts/controller/src/purchase.rs:60-96`
- `contracts/controller/src/purchase.rs:98-145`
- `contracts/flight_pool_manager/src/lifecycle.rs:48-88`
- `contracts/flight_pool_manager/src/lifecycle.rs:104-129`
- `contracts/flight_pool_manager/src/storage.rs:21-26`
- `contracts/oracle_aggregator/src/lifecycle.rs:115-145`
- `contracts/oracle_aggregator/src/storage.rs:16-18`
- `executor/centralized_cron/src/flight_data_fetcher.ts:69-76`
- `executor/centralized_cron/src/flight_data_fetcher.ts:229-240`
- `executor/centralized_cron/src/aeroapi_client.ts:28-50`

### Description

`Controller::buy_insurance` accepts a caller-provided `u64 date`. The only temporal checks require that the value be later than the minimum lead time and earlier than the maximum booking horizon. The contract does not verify that the timestamp is the canonical scheduled departure of a real flight.

The timestamp is then used verbatim throughout the protocol:

- a flight pool is keyed by `(flight_id, date)`;
- oracle data is keyed by `(flight_id, date)`;
- buyer uniqueness is keyed by `(flight_id, date, traveler)`.

Consequently, timestamps that differ by one second create independent policies, independent buyer records, independent collateral locks, and independent claims. The same traveler is allowed to buy all of them.

The production executor does not preserve this distinction. `dateToString` converts a Unix timestamp to `YYYY-MM-DD`, discarding the time. `AeroApiClient::getFlightData` then queries every matching flight in that UTC day and returns the final element of the response without matching the policy's exact scheduled departure, origin, or destination.

All attacker-selected timestamps in the same UTC day are therefore resolved using the same physical flight record. If that record is delayed or cancelled, each artificial on-chain flight instance is independently settled as payable.

### Root Cause

The protocol uses an untrusted, non-canonical timestamp as the unique flight-instance identifier, while the oracle integration resolves only `(flight identifier, calendar day)` and does not prove which physical flight was insured.

The duplicate-purchase check is internally consistent but operates on the wrong identity boundary. It prevents a second purchase for one exact timestamp; it does not prevent multiple purchases for one real-world flight.

### Exploit Scenario

1. A route for flight `AA100` is active with a premium of 10 units and a payoff of 50 units.
2. The attacker submits purchases for `AA100` using 20 distinct timestamps from the same UTC calendar day.
3. Every timestamp passes the lead-time and booking-horizon checks.
4. Every purchase creates a separate flight configuration and buyer record, charges another 10-unit premium, and locks another 50 units in the vault.
5. The executor converts all 20 timestamps to the same `YYYY-MM-DD` string.
6. Every oracle entry is updated from the same AeroAPI flight record.
7. If that physical flight is cancelled, all 20 entries are settled as cancelled.
8. The attacker claims 20 independent 50-unit payouts.

The attacker pays 200 units and receives 1,000 units. The 800-unit difference is taken from the vault.

The same root cause also permits collateral griefing. Timestamps or dates for which no real flight exists remain `NotInitiated` when AeroAPI returns no data. There is no policy timeout or refund path, so the associated collateral can remain locked indefinitely.

### Reproduction Result

A local integration reproduction created 20 policies for one traveler and one flight identifier using `FLIGHT_DATE + offset` for offsets `0..19`. Each entry was assigned the same cancelled physical-flight outcome, matching the production executor's day-level resolution.

Observed result:

| Value | Before/Cost | After/Received |
| --- | ---: | ---: |
| Attacker premiums | 200 | — |
| Attacker claims | — | 1,000 |
| Vault managed assets | 1,000 | 200 |
| Net vault loss | — | 800 |

The test passed against commit `2adc2f688a61b2bca0ae2a8e468814fae9dfb6d7`.

### Impact

An attacker can multiply exposure to one real-world event until available vault capital is exhausted. The exploit:

- requires no privileged role;
- can be executed by one traveler address;
- bypasses the intended one-policy-per-traveler rule;
- converts one delayed or cancelled flight into many payable claims;
- can drain most or all vault assets permitted by the collateral checks;
- can permanently lock capital using unresolved, nonexistent flight instances.

Increasing the solvency ratio does not correct the identity failure. It may reduce the number of duplicate policies sold, but every accepted duplicate remains an independent claim on the same physical event.

### Recommendation

Do not allow travelers to define a flight instance with an arbitrary timestamp.

Implement a canonical flight-instance registry populated or attested by the authorized oracle before purchase. Each insurable instance should include, at minimum:

- carrier and flight number;
- exact scheduled departure timestamp;
- origin and destination;
- an immutable provider flight identifier, if available.

`buy_insurance` should accept or derive a canonical instance ID and reject policies unless that instance already exists and its route and scheduled time match the approved data.

Additionally:

1. Key flight, buyer, and claim state by the canonical instance ID.
2. Enforce one policy per traveler per canonical instance.
3. Make the executor select the exact AeroAPI record by scheduled departure and route instead of returning the final record for a day.
4. Reject ambiguous responses containing multiple candidate flights.
5. Add an explicit expiry/refund process for instances that never receive valid oracle data.
6. Add adversarial tests using timestamps separated by one second, multiple same-day flights, nonexistent dates, and mismatched routes.

---

## CAI-H02 — Public outcomes give LPs a free option before settlement updates vault value

**Severity:** High  
**Impact:** LP loss evasion, dilution, and extraction of value from passive LPs  
**Likelihood:** High  
**Confidence:** High

### Affected Components

- `contracts/oracle_aggregator/src/lifecycle.rs:50-107`
- `contracts/controller/src/settle.rs:19-123`
- `contracts/controller/src/settle.rs:134-275`
- `contracts/risk_vault/src/vault_ops.rs:14-26`
- `contracts/risk_vault/src/vault_ops.rs:28-55`
- `contracts/risk_vault/src/vault_ops.rs:57-90`
- `contracts/risk_vault/src/capital.rs:82-103`
- `contracts/risk_vault/src/queries.rs:8-29`

### Description

Flight outcome recognition and its financial effect on the vault occur in separate, publicly observable state transitions:

1. The oracle records `Landed` or `Cancelled`.
2. `classify_flights` changes the state to a `ToBeSettled*` status.
3. A later `execute_settlements` call transfers premiums or charges the payout loss to the vault.

The adverse outcome is therefore known before the vault's managed assets and share price reflect the loss.

During this interval, `RiskVault::redeem` and `RiskVault::withdraw` remain open whenever the requested assets do not exceed current free capital and the withdrawal queue is empty. Their pricing uses the pre-settlement vault asset balance. There is no cooldown, settlement epoch, outcome lock, pending-loss reserve, or snapshot that binds an LP to risks that were already outstanding when its shares were held.

An LP can observe `Cancelled`, `Landed`, or `ToBeSettledCancelled/Delayed`, redeem at the old share price, and leave the payout loss entirely to the remaining LPs.

The inverse strategy is also available. After an on-time outcome is public but before premiums are transferred into the vault, an account can deposit at the old share price, receive shares, and participate in income from risk it never underwrote.

### Root Cause

The vault provides continuously liquid entry and exit at current asset value, but protocol liabilities and income are recognized asynchronously after their outcome is already public. Share pricing does not account for known but unsettled flight results.

The free-capital check protects collateral needed for the nominal payoff, but it does not enforce fair allocation of the eventual loss among the LPs who held shares while the policy was at risk.

### Exploit Scenario

1. Two LPs each supply 1,000 units, giving the vault 2,000 managed assets.
2. A policy with a 100-unit premium and 1,000-unit payoff locks 1,000 units.
3. The oracle reports that the flight is cancelled.
4. The outcome is visible on-chain, but the vault has not yet paid the 900-unit net loss.
5. One LP redeems all shares. The vault has 1,000 units of nominal free capital, so the redemption succeeds at approximately 1,000 units.
6. Settlement then transfers 900 units from the vault to the flight pool.
7. Only 100 units remain for the passive LP.

Without the early exit, the two LPs would share the 900-unit loss. By exiting after the outcome is known, the informed LP avoids its economic share of that loss and transfers it to the remaining LP.

### Reproduction Result

A local integration reproduction used:

- two deposits of 1,000 units;
- one cancelled policy;
- premium: 100 units;
- payoff: 1,000 units.

After classification produced `ToBeSettledCancelled`, the informed LP redeemed its full position before `execute_settlements`.

Observed result:

| State | Amount |
| --- | ---: |
| Vault assets before exit | 2,000 |
| Capital locked for policy | 1,000 |
| Informed LP redemption | approximately 1,000 |
| Net cancellation loss booked afterward | 900 |
| Assets remaining for passive LP | 100 |

The test passed against commit `2adc2f688a61b2bca0ae2a8e468814fae9dfb6d7`.

### Impact

The vulnerability makes underwriting exposure optional for active observers:

- sophisticated LPs can avoid known losses before they are booked;
- passive LPs bear a disproportionate share of claims;
- just-in-time deposits can dilute premium income after favorable outcomes are known;
- bots can systematically extract value around oracle and keeper transactions;
- rational LP behavior can cause a liquidity run as soon as an adverse outcome appears;
- vault shares cannot reliably represent pro-rata participation in protocol profit and loss.

This is not limited to the intermediate `ToBeSettled*` state. The opportunity begins as soon as the oracle's `Landed` or `Cancelled` state is publicly visible.

### Recommendation

Use epoch-based vault accounting or another design that makes outcome recognition and LP pricing atomic from an economic perspective.

A robust design should:

1. Record the financial effect of an outcome in the same transaction that first publishes that outcome, or immediately reserve the exact pending loss in vault accounting.
2. Queue deposits and withdrawals and finalize them only against a settlement-epoch share price.
3. Apply a withdrawal cooldown longer than the maximum oracle-to-settlement interval.
4. Prevent deposits submitted after a favorable outcome from sharing in income attributable to the completed risk period.
5. Price queued withdrawals using the post-settlement asset value for every policy whose risk was outstanding before the request became effective.
6. Ensure a keeper delay cannot create a longer arbitrage window.

Simply combining `classify_flights` and `execute_settlements` is insufficient if the oracle publishes `Cancelled` or `Landed` in an earlier transaction. The first public disclosure of the outcome must either book the loss/income or freeze the applicable vault epoch.

Add tests covering:

- redemption after `Cancelled` but before classification;
- redemption after classification but before settlement;
- deposits after `ToBeSettledOnTime`;
- multiple policies settled across batch boundaries;
- delayed keeper execution;
- queued withdrawal pricing across an adverse settlement.

---

## Excluded and Non-Reported Items

The review did not repeat findings already documented in the existing assessment material, including:

- claimable liabilities inflating vault share value;
- nested controller authorization affecting on-time settlement;
- route uniqueness-index TTL expiry;
- aggregate solvency-ratio enforcement;
- unbounded withdrawal-queue copying;
- previously documented TTL, batching, governance, pause, and mock-token observations.

Other reviewed hypotheses were excluded where they required privileged-key compromise, represented an explicitly trusted role, were stale against the assessed commit, duplicated an existing root cause, or could not be validated to the required confidence.

---

# Conclusion

The assessed snapshot should not be deployed with unrestricted policy purchases or liquid vault entry and exit.

CAI-H01 provides a practical method to multiply claims from one real-world flight outcome and can directly consume vault capital. CAI-H02 allows informed LPs to externalize losses or capture income after outcomes are known, undermining the core fairness and solvency assumptions of the underwriting pool.

Both issues require architectural corrections rather than isolated guard changes:

- policies must reference a canonical, oracle-verified physical flight instance;
- vault share accounting must bind LP entry and exit to settlement epochs or immediately recognized outcome liabilities.

Retesting should include adversarial integration tests across contracts and the production oracle executor.

---

# Limitations

This assessment represents a point-in-time review of the specified repository state. It does not guarantee the absence of vulnerabilities, defects, design weaknesses, implementation errors, economic risks, or integration failures.

# Disclaimer

No representation, warranty, or guarantee is made regarding the completeness, accuracy, reliability, suitability, or correctness of these assessment results. The absence of reported findings does not imply the absence of vulnerabilities, defects, security weaknesses, or exploitable conditions. This assessment should not be relied upon as the sole basis for security, investment, deployment, governance, operational, or business decisions.

This assessment does not constitute:

- a formal security certification;
- a guarantee of security;
- legal advice;
- financial or investment advice;
- compliance certification;
- a substitute for professional security auditing services.

Neither the assessment provider, report author, AI systems used during analysis, nor affiliated parties shall be liable for direct, indirect, incidental, consequential, special, or punitive damages arising from use of this report or reliance on its contents.
