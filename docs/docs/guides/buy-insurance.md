---
sidebar_position: 1
title: Buy Insurance
---

# Buy Insurance

This guide describes the traveler flow. On testnet you can interact through the dApp frontend or directly with the contracts using the Stellar CLI.

## Prerequisites

- A funded Stellar account (testnet accounts can be funded with [Friendbot](https://developers.stellar.org/docs/build/guides/basics/create-account)).
- USDC to pay the premium. On testnet, Mock USDC has a permissionless `faucet` function that mints 10,000 USDC per call.
- The flight you want to insure must be on a whitelisted route, and the purchase must happen before the minimum lead time (1 hour on testnet) ahead of departure.

## Buying a policy

Call `buy_insurance` on the Controller with your address, the flight number, origin, destination, and departure date. The Controller will:

1. Verify the route is whitelisted and resolve its terms (premium, payoff, delay threshold).
2. Check the lead time and vault solvency.
3. Transfer the premium from your account to the Flight Pool Manager.
4. Lock the payoff amount in the Risk Vault and register you as a buyer.

Example with the Stellar CLI on testnet:

```bash
stellar contract invoke \
  --id <CONTROLLER_ADDRESS> \
  --source <YOUR_KEY> \
  --network testnet \
  -- buy_insurance \
  --traveler <YOUR_ADDRESS> \
  --flight_id FL123 \
  --origin JFK \
  --destination LAX \
  --date 2026-08-01
```

Contract addresses are listed in [Testnet Addresses](../developers/testnet-addresses).

## After the flight

- **On time**: nothing to do. The premium stays with the protocol.
- **Delayed beyond the threshold, or cancelled**: once settlement runs (automated, usually within minutes of landing data arriving), call `claim` on the Flight Pool Manager:

```bash
stellar contract invoke \
  --id <FLIGHT_POOL_MANAGER_ADDRESS> \
  --source <YOUR_KEY> \
  --network testnet \
  -- claim \
  --flight_id FL123 \
  --date 2026-08-01
```

The full payoff is transferred to your account. Each policy can be claimed once.

:::warning Claim window
Claims expire after the claim window (60 days on testnet). Unclaimed payouts after expiry are swept into a recovery balance. Claim promptly.
:::

## Checking your policies

- `get_flights_for_traveler(address)` on the Controller lists your insured flights.
- `has_policy` and `has_claimed` on the Flight Pool Manager report per-flight status.
- `get_flight_data` on the Oracle Aggregator shows the current flight status.
