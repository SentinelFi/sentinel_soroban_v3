---
sidebar_position: 2
title: Participants and Roles
---

# Participants and Roles

## Travelers (hedge buyers)

Travelers pay a fixed premium to insure a specific flight on a specific date. If the flight is delayed beyond the route threshold or cancelled, they claim a fixed payoff. If the flight arrives on time, the premium is kept by the protocol as underwriter yield. Payouts are pull based: the traveler calls `claim` on the Flight Pool Manager within the claim window.

## Underwriters (liquidity providers)

Underwriters deposit USDC into the Risk Vault and receive **RVS** share tokens, following a vault standard modeled on ERC-4626. They earn premiums from on-time flights and absorb payouts for delayed and cancelled ones. Shares are transferable. Entry and exit are both **two-phase**: capital (or shares) is escrowed by a request now and priced by the keeper only after a delay, so nobody can enter or exit on a flight outcome that is already publicly known but not yet on-chain. Exits are paid from a FIFO queue as capital above the solvency reserve allows.

## Owner

Each contract has an independent owner (OpenZeppelin `Ownable`, two-step transfer). The owner can upgrade contract code, pause contracts, tune bounded parameters, rotate the oracle and keeper addresses, and recover expired unclaimed funds. A multisig is recommended for this role in production.

## Admins

Governance admins are delegated route managers. They can whitelist, update, disable, enable, and remove routes, but nothing else.

## Oracle

A single authorized address that pushes flight data (scheduled arrival, landing, cancellation) to the Oracle Aggregator. The oracle is a trusted role: false data could trigger wrongful payouts. Mitigations include a forward-only status state machine, owner key rotation, and off-chain monitoring.

## Keeper

A single authorized address that drives automation: classifying flights, executing settlements, and processing the withdrawal queue. The keeper cannot move funds to itself, it can only trigger predefined protocol transitions.

## Anyone

Some housekeeping functions are permissionless: sweeping expired claims into the recovery balance, pruning settled flight data, extending storage TTLs, and recording share price snapshots.
