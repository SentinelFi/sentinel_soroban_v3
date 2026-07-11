---
sidebar_position: 1
title: Introduction
---

# Introduction

**Sentinel** is a decentralized parametric insurance framework built on [Stellar](https://stellar.org) using [Soroban](https://developers.stellar.org/docs/build/smart-contracts) smart contracts. Its first product is **flight delay insurance**: travelers buy coverage for a specific flight, and if that flight is delayed beyond a threshold or cancelled, they receive an automatic on-chain payout.

The framework is designed to support any risk market with a reliable data source, such as flight delays or wildfire alerts.

## How it works in one paragraph

Travelers pay a fixed **premium** to insure a flight. Liquidity providers (**underwriters**) deposit USDC into a shared **Risk Vault** and receive vault shares in return. If the flight arrives on time, the premium stays in the protocol as yield for underwriters. If the flight is delayed beyond the agreed threshold or cancelled, the traveler can claim a fixed **payoff** backed by vault capital. Flight status is delivered on-chain by an oracle, and settlement is fully automated. No claims process, no paperwork.

## Key properties

- **Parametric**: payouts depend only on objective flight data, not on loss assessment.
- **Always solvent**: coverage is never sold unless vault capital fully backs the payout.
- **Pull based payments**: travelers and underwriters withdraw funds themselves, the protocol never pushes funds to arbitrary addresses.
- **Non-custodial orchestration**: the Controller contract coordinates everything but never holds funds.
- **Open source**: all contracts are written in Rust and licensed under Apache 2.0.

## Where to go next

- [How It Works](concepts/how-it-works): the full lifecycle of a policy.
- [Buy Insurance](guides/buy-insurance) and [Provide Liquidity](guides/provide-liquidity): user guides.
- [Smart Contracts](contracts/overview): architecture and contract reference.
- [Developers](developers/build-and-test): build, test, deploy, and run the off-chain executor.
- [Security](security): audits and the trust model.

## Links

- GitHub: [github.com/SentinelFi](https://github.com/SentinelFi)
- X (Twitter): [@sentinel_fi](https://x.com/sentinel_fi/)
- Medium: [@sentineldefi](https://medium.com/@sentineldefi/)
