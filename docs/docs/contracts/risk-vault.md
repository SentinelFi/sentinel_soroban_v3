---
sidebar_position: 3
title: Risk Vault
---

# Risk Vault

The Risk Vault holds all underwriter capital. It is built on the OpenZeppelin `FungibleVault`, an ERC-4626 equivalent for Soroban. Depositors receive transferable share tokens named **RiskVault Share (RVS)**.

## Share accounting

- The vault prices shares against an internal **total managed assets** counter rather than its raw token balance, so direct token transfers to the vault cannot manipulate the share price.
- A virtual share offset (`decimals_offset = 3`) defends against inflation attacks on an empty vault.
- Rounding always favors the vault, protecting solvency.

## Capital states

- **Locked capital** backs outstanding policies. It is increased when a policy is sold and decreased at settlement.
- **Free capital** equals total managed assets minus locked capital — the nominal margin above policy liabilities.
- **Withdrawable capital** is what exits may actually remove: total managed assets minus locked capital scaled by the solvency ratio (rounded up). With the default 100% ratio it equals free capital; at a higher ratio the difference is the protocol's safety reserve, which underwriter exits must leave in place just as new policy sales must. The ratio is configured once on the Controller and mirrored into the vault automatically.

## Underwriter functions

- `deposit(assets, receiver, from, operator)` and `mint`: enter the vault.
- `redeem` and `withdraw`: exit immediately, capped to withdrawable capital.
- `request_withdrawal(shares)`: join the FIFO withdrawal queue, shares are escrowed, returns a stable request id.
- `cancel_withdrawal(caller, request_id)`: cancel a pending request.

Queue processing is strict FIFO with **head partial fills**: if the oldest request is worth more than the currently withdrawable capital, the fundable slice is paid out immediately (shares burned, value credited) and the remainder stays at the head of the queue. Withdrawable capital always flows to the oldest request first, and a single oversized request can never freeze everyone else's exit while payable capital sits idle. Partial fills emit a `wd_partial` event alongside the regular credit.
- `collect()`: pull USDC credited by processed withdrawal requests.
- `snapshot()`: permissionless, records the daily share price (kept 30 days).

## Controller-only functions

`increase_locked`, `decrease_locked`, `send_payout`, `process_withdrawal_queue`, `record_premium_income`, and `set_solvency_ratio` (the mirror push from the Controller's owner setter) can only be called by the Controller.

## Settlement barrier

The vault is wired at construction with the Oracle Aggregator address. While any flight outcome is publicly known but not yet settled, deposits and withdrawals are blocked so nobody can trade against a stale share price.

## Owner functions

- `set_min_withdrawal_request(amount)`: anti-dust floor for queue entries (clamped at request time).
- `recover_uncollected(user, amount, mode)`: recovery path for archived claimable balances, either re-crediting the user or transferring out.
- `set_oracle(oracle)`: rotate the settlement-barrier oracle. Refuses while the current oracle still reports pending public outcomes — a fresh oracle starts with none, so swapping mid-incident would open the barrier at a stale share price.
- `force_set_oracle(oracle)`: the escape hatch when the old oracle is unreachable. Requires the vault to be paused first, and the emitted event is flagged as forced, so exits stay blocked until the pending profit and loss is reconciled and the owner deliberately unpauses.
