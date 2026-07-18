---
sidebar_position: 3
title: Solvency and Safety
---

# Solvency and Safety

Sentinel is built around a small set of invariants that hold at all times.

## Always solvent

A policy is only sold if the vault's total managed assets cover all locked payoffs plus the new one, scaled by a configurable solvency ratio. At purchase time the payoff amount is locked, so every outstanding policy is fully collateralized. Locked capital can never exceed total managed assets.

The same reserve is enforced when capital leaves: underwriter withdrawals (direct or queued) are capped to the assets above the ratio-scaled locked capital, so an exit can never strip the safety margin that purchases were admitted against.

Term limits are also enforced on the terms a purchase actually uses. When a flight already has a registered pool with snapshotted terms, new buyers are only admitted if that snapshot still satisfies the current owner-set payoff caps — lowering the caps immediately stops new exposure at old, larger terms while existing policies keep their promised payout.

## Pull based payments

The protocol never pushes funds to arbitrary addresses. Travelers claim payouts themselves, underwriters collect processed withdrawals themselves. This removes entire classes of reentrancy and griefing issues.

## The Controller holds no funds

All USDC sits in exactly two places: the Risk Vault (underwriter capital) and the Flight Pool Manager (premiums and claimable payouts). The Controller only orchestrates, so compromising its logic cannot directly drain a balance it holds.

## Manipulation resistant share pricing

The Risk Vault tracks an internal total managed assets counter instead of reading its raw token balance, so donating tokens to the vault cannot distort the share price. A virtual share offset (decimals offset of 3) defends against inflation attacks, and rounding always favors the vault.

## Settlement barrier and delayed LP pricing

LP entry and exit are two-phase: requests escrow value immediately and are priced only after a 6-hour delay, at the share price current when processed. The delay guarantees that every flight outcome publicly knowable when a request was committed has reached the chain before the request prices — closing the window between an outcome becoming public and the oracle recording it. On top of that, once an outcome is written on-chain but not yet settled, queue processing pauses entirely, so no request is ever priced while recognized-but-unsettled PnL is missing from the share price.

## Forward-only oracle state machine

Flight status can only move forward:

```
NotInitiated -> Active -> Landed -> ToBeSettled -> Settled
                Active -> Cancelled -> ToBeSettled -> Settled
```

A status can never regress, so a compromised oracle cannot rewrite history for an already landed or settled flight.

Every state that locks vault collateral also has a bounded exit: a flight that never receives oracle data is voided 14 days past departure, and a flight that goes `Active` but never receives a terminal outcome is voided 14 days past its recorded scheduled arrival. Both voids settle with no payout — premiums become vault yield and the locked collateral is released — so a data outage can pause the protocol but can never pin underwriter capital forever.

## Sale attestation

Purchases require a live, short-lived sale authorization written by the oracle after verifying the flight is scheduled and not cancelled. Absence of an on-chain outcome is never treated as proof a flight is insurable — a publicly cancelled flight would look identical to a valid unreported one until the cancellation reaches the chain. If the oracle stops attesting, sale windows lapse (24 hours at most) and new purchases halt: availability degrades, never safety.

## Other safeguards

- Checked arithmetic and overflow checks are enabled in release builds.
- All state-changing entry points verify authorization against stored role addresses.
- No double claims: each policy can be claimed exactly once.
- All five production contracts are pausable by their owner for emergency response.
- Owner-tunable parameters are bounded (for example, the claim expiry window and minimum lead time have hard limits).
