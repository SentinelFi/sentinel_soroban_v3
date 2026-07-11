---
sidebar_position: 4
title: Flight Pool Manager
---

# Flight Pool Manager

The Flight Pool Manager is a singleton contract holding per-flight policy state and all premium funds. It replaces the earlier design of deploying one pool contract per flight.

## Flight state

Each flight instance, keyed by flight number and date, stores a `FlightConfig`:

- Terms locked at registration: premium, payoff, delay threshold.
- Counters: `buyer_count`, `claimed_count`.
- `status`: `Active`, `SettledOnTime`, `SettledDelayed`, or `SettledCancelled`.
- `claim_expiry`: when the claim window closes for a settled flight.

Registration is idempotent for matching terms but rejects re-registration with different terms.

## Money flow

- Premiums arrive at purchase time and stay in the pool while the flight is active.
- **On time**: premiums are forwarded to the Risk Vault as underwriter income.
- **Delayed or cancelled**: the vault sends `(payoff - premium) * buyer_count` to the pool, so each buyer's claimable balance equals the full payoff.

## Traveler functions

- `claim(flight_id, date)`: transfers the payoff to the caller if they hold a policy on a delayed or cancelled flight, the claim window is open, and they have not claimed before.

## Permissionless housekeeping

- `sweep_expired(flight_id, date)`: after the claim window closes, moves unclaimed payouts into an internal recovered balance.

## Controller-only functions

`register_flight`, `add_buyer`, `settle_on_time`, `settle_delayed`, `settle_cancelled`.

## Owner functions

- `withdraw_recovered(amount)`: withdraws swept, expired funds.

## Reads

`get_flight_config`, `has_policy`, `has_claimed`, `get_active_flights`, `get_recovered_balance`.
