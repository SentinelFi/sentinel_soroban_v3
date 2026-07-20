---
sidebar_position: 7
title: Terminology
---

# Terminology

A short glossary of the terms used, split into insurance vocabulary and technical vocabulary.

## Insurance Terms

### Parametric insurance

Insurance that pays out automatically when an objective, measurable condition is met. There is no claims adjuster and no proof of loss: the parameter alone decides the outcome.

### Policy

Coverage for one specific flight instance, keyed by flight number and departure date. A traveler buys a policy and, if the trigger condition is met, claims the payoff.

### Premium

The fixed price a traveler pays for a policy. If the flight arrives on time, premiums are forwarded to the Risk Vault as underwriter yield.

### Payoff

The fixed amount a traveler receives if their insured flight is delayed beyond the route threshold or cancelled. Payoff, premium, and threshold are set per route.

### Route

A flight number plus origin and destination. Routes are whitelisted by governance and carry the premium, payoff, and delay-threshold terms for all policies sold on them.

### Delay threshold

The number of hours a flight must arrive late for policies on that route to pay out. Actual arrival time is compared against the scheduled arrival pushed by the oracle.

### Underwriter

A liquidity provider who deposits asset (USDC) into the Risk Vault to back policies. Underwriters earn premiums from on-time flights and absorb payoffs for delayed and cancelled ones. See [Participants and Roles](./concepts/participants).

### Claim window

The period after settlement during which an affected traveler can claim their payoff. Payouts are pull based; unclaimed funds are swept into a recovery balance after the window expires.

### Settlement

The step that resolves a flight after landing or cancellation: a keeper classifies the outcome as on time, delayed, or cancelled, then either releases the locked capital and forwards premiums to the vault, or tops up the flight pool so buyers can claim.

### Solvency

The guarantee that the vault holds enough capital to cover every payoff it has promised. A policy purchase only succeeds if the vault can back the new payoff, and underwriter exits are only paid from capital above the solvency reserve. See [Solvency and Safety](./concepts/solvency-and-safety).

## Technical Terms

### Blockchain

A shared, append-only ledger maintained by a network of independent nodes. Sentinel runs on the Stellar blockchain, which records every deposit, purchase, settlement, and claim publicly and immutably.

### Smart contract

Code deployed on a blockchain that executes exactly as written, without an intermediary. See the [Contracts Overview](./contracts/overview).

### Soroban

Stellar's smart contract platform. Contracts are written in Rust and compiled to WebAssembly.

### Decentralization

Removing single points of control: rules are enforced by contracts rather than a company, and funds can only move along predefined paths.

### Asset

A token that carries value on-chain. For example, USDC is a stablecoin pegged to the US dollar (a mock USDC token is used on testnet).

### Vault

A contract that pools depositors' assets and issues shares against them, following a standard modeled on ERC-4626. Sentinel's Risk Vault holds underwriter capital and backs all active policies. See [Risk Vault](./contracts/risk-vault).

### Share token (RVS)

The transferable token underwriters receive when depositing into the Risk Vault. Each share represents a proportional claim on vault capital; its price rises with earned premiums and falls with paid payoffs.

### Oracle

A bridge that brings off-chain data on-chain. Sentinel's oracle pushes scheduled arrivals, landings, and cancellations from the external flight oracle API to the Oracle Aggregator contract, where the data becomes the ground truth for settlement.

### Keeper

An authorized automation address that drives the protocol forward: classifying flights, executing settlements, and processing deposit and withdrawal queues. The keeper can only trigger predefined transitions and cannot move funds to itself.

### Escrow

Holding assets in contract custody until a condition resolves. Sentinel escrows asset on deposit requests and shares on withdrawal requests, pricing them only after a delay so nobody can enter or exit on an outcome that is known but not yet on-chain.
