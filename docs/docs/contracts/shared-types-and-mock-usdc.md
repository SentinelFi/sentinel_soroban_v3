---
sidebar_position: 7
title: Shared Types and Mock USDC
---

# Shared Types and Mock USDC

## sentinel_types

`sentinel_types` is a shared Rust crate (not a deployed contract) holding every type that crosses a contract boundary: flight status and flight data, flight configuration and settlement status, route status and resolved terms, TTL constants, lifecycle timeouts, the shared paginated active-flight set (used by the Oracle Aggregator and Flight Pool Manager), contract interfaces, and the shared upgrade helper.

Keeping these in one crate guarantees that all contracts and their generated clients agree on a single XDR layout.

:::warning[Field order is load-bearing]
The Soroban type codec depends on field and variant order. Types in this crate must never be reordered without a coordinated version bump across all contracts.
:::

## Mock USDC

`mock_usdc` is a testnet-only fungible token used in place of real USDC:

- 7 decimals, matching the Stellar USDC convention.
- Permissionless `mint` and `faucet` functions. The faucet mints 10,000 USDC per call, so anyone can test the protocol.
- These functions are compiled in only under the default `testnet` feature. Building with `--no-default-features` removes them.

Mock USDC must not be used on mainnet.
