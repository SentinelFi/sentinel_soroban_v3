---
sidebar_position: 3
title: Solvency and Safety
---

# Solvency and Safety

Sentinel is built around a small set of invariants that hold at all times.

## Always solvent

A policy is only sold if the vault's **free capital** (total managed assets minus already locked capital) covers the full payoff, scaled by a configurable solvency ratio. At purchase time the payoff amount is locked, so every outstanding policy is fully collateralized. Locked capital can never exceed total managed assets.

## Pull based payments

The protocol never pushes funds to arbitrary addresses. Travelers claim payouts themselves, underwriters collect processed withdrawals themselves. This removes entire classes of reentrancy and griefing issues.

## The Controller holds no funds

All USDC sits in exactly two places: the Risk Vault (underwriter capital) and the Flight Pool Manager (premiums and claimable payouts). The Controller only orchestrates, so compromising its logic cannot directly drain a balance it holds.

## Manipulation resistant share pricing

The Risk Vault tracks an internal total managed assets counter instead of reading its raw token balance, so donating tokens to the vault cannot distort the share price. A virtual share offset (decimals offset of 3) defends against inflation attacks, and rounding always favors the vault.

## Settlement barrier

Once a flight outcome is publicly known but not yet settled on-chain, underwriter deposits and withdrawals are temporarily blocked. This prevents anyone from entering or exiting the vault at a stale share price ahead of a known payout.

## Forward-only oracle state machine

Flight status can only move forward:

```
NotInitiated -> Active -> Landed -> ToBeSettled -> Settled
                Active -> Cancelled -> ToBeSettled -> Settled
```

A status can never regress, so a compromised oracle cannot rewrite history for an already landed or settled flight.

## Other safeguards

- Checked arithmetic and overflow checks are enabled in release builds.
- All state-changing entry points verify authorization against stored role addresses.
- No double claims: each policy can be claimed exactly once.
- All five production contracts are pausable by their owner for emergency response.
- Owner-tunable parameters are bounded (for example, the claim expiry window and minimum lead time have hard limits).
