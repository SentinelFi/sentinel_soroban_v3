---
sidebar_position: 3
title: Risk Vault
---

# Risk Vault

The Risk Vault holds all underwriter capital. It is built on the OpenZeppelin `FungibleVault`, an ERC-4626 equivalent for Soroban. Depositors receive transferable share tokens named **RiskVault Share (RVS)**.

All LP entry and exit is **two-phase**: a request escrows value (USDC on entry, shares on exit) immediately, and the keeper's queue-processing pass prices it only after the request is at least the LP pricing delay old (6 hours). By then, every flight outcome that was publicly knowable when the request was committed has reached the chain — either settled into the share price, or holding the queue via the settlement barrier — so nobody can enter before a known gain or exit before a known loss at the other LPs' expense. The immediate `deposit`/`mint`/`withdraw`/`redeem` operations are permanently disabled (any call-time price can be stale), and the `max_*` views report zero.

## Share accounting

- The vault prices shares against an internal **total managed assets** counter rather than its raw token balance, so direct token transfers to the vault cannot manipulate the share price.
- A virtual share offset (`decimals_offset = 3`) defends against inflation attacks on an empty vault.
- Rounding always favors the vault, protecting solvency.

## Capital states

- **Locked capital** backs outstanding policies. It is increased when a policy is sold and decreased at settlement.
- **Free capital** equals total managed assets minus locked capital — the nominal margin above policy liabilities.
- **Withdrawable capital** is what exits may actually remove: total managed assets minus locked capital scaled by the solvency ratio (rounded up). With the default 100% ratio it equals free capital; at a higher ratio the difference is the protocol's safety reserve, which underwriter exits must leave in place just as new policy sales must. The ratio is configured once on the Controller and mirrored into the vault automatically.

## Underwriter functions

- `request_deposit(caller, assets)`: queue an entry — USDC transfers into the vault immediately (escrowed, backing no shares yet) and returns a stable request id. Once matured, processing mints shares at the then-current price. A request whose assets no longer buy a single share (price rose sharply) is returned rather than minted for nothing (`dep_dropped` event).
- `cancel_deposit(caller, request_id)`: cancel a pending entry and take the escrowed USDC back. Cancellation carries no pricing optionality — a queued deposit always prices post-outcome, so backing out never dodges a loss or captures someone else's gain.
- `request_withdrawal(caller, shares)`: queue an exit — shares are escrowed FIFO, returns a stable request id. Once matured, processing pays out at the then-current price, bounded by withdrawable capital.
- `cancel_withdrawal(caller, request_id)`: cancel a pending exit request.

Withdrawal-queue processing is strict FIFO with **head partial fills**: if the oldest matured request is worth more than the currently withdrawable capital, the fundable slice is paid out immediately (shares burned, value credited) and the remainder stays at the head of the queue. Withdrawable capital always flows to the oldest request first, and a single oversized request can never freeze everyone else's exit while payable capital sits idle. Partial fills emit a `wd_partial` event alongside the regular credit; a fill remainder keeps its original request time, so maturity is never re-earned.
- `collect()`: pull USDC credited by processed withdrawal requests.
- `snapshot()`: permissionless, records the daily share price (kept 30 days).

## Controller-only functions

`increase_locked`, `decrease_locked`, `send_payout`, `process_deposit_queue`, `process_withdrawal_queue`, `record_premium_income`, and `set_solvency_ratio` (the mirror push from the Controller's owner setter) can only be called by the Controller.

## Settlement barrier and pricing delay

The vault is wired at construction with the Oracle Aggregator address. While any flight outcome is written on-chain but not yet settled, neither queue prices anything — requests stay committed and wait. The 6-hour pricing delay covers the window the on-chain barrier cannot see: the time between an outcome being observed by the oracle and the oracle transaction landing. Together they mean a request is always priced with every outcome the oracle could have written at its commitment already reflected. Outcomes that are publicly predictable before the oracle can write them (a long-haul flight already departed late, a stale flight approaching its void timeout) sit outside that horizon — see the pricing-delay-horizon residuals in the architecture spec's Known Limitations.

## Owner functions

- `set_min_withdrawal_request(amount)`: anti-dust floor for queue entries (clamped at request time to max(TMA/2500, one whole token) — the absolute term keeps queue slots priced during bootstrap, when the value-relative clamp would otherwise vanish). Note the same clamp caps the configured minimum at one token while TMA is near zero, so at launch the deployment runbook calls for seeding the vault with a genesis deposit before opening public LP entry — with TMA seeded, slot pricing is value-relative from the first public request.
- `recover_uncollected(user, amount, mode)`: recovery path for archived claimable balances, either re-crediting the user or transferring out.
- `set_oracle(oracle)`: rotate the settlement-barrier oracle. Refuses while the current oracle still reports pending public outcomes — a fresh oracle starts with none, so swapping mid-incident would open the barrier at a stale share price.
- `force_set_oracle(oracle)`: the escape hatch when the old oracle is unreachable. Requires the vault to be paused first, and the emitted event is flagged as forced, so exits stay blocked until the pending profit and loss is reconciled and the owner deliberately unpauses.
