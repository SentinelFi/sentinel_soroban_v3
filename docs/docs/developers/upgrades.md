---
sidebar_position: 5
title: Upgrades
---

# Upgrades

Every Sentinel contract exposes an `upgrade(wasm_hash)` function gated by its owner. The full procedure is documented in [`contracts/upgrade.md`](https://github.com/SentinelFi/sentinel_soroban_v3/blob/main/contracts/upgrade.md).

## Procedure

```bash
# 1. Build and optimize the new WASM
stellar contract build --optimize

# 2. Upload it and note the returned hash
stellar contract upload \
  --wasm target/wasm32v1-none/release/<contract>.optimized.wasm \
  --source <OWNER_KEY> --network testnet

# 3. Point the contract at the new code
stellar contract invoke \
  --id <CONTRACT_ID> --source <OWNER_KEY> --network testnet \
  -- upgrade --wasm_hash <HASH>
```

## Rules and caveats

- Upgrades swap **code only**. There is no automatic storage migration, so the new code must keep the existing storage layout compatible. Shared types live in `sentinel_types` for exactly this reason, and field order in those types must never change without a coordinated plan.
- Ownership is per contract and independent.
- Ownership uses OpenZeppelin `Ownable` with two-step transfer. `renounce_ownership` is irreversible and freezes the contract code forever.
- Upgradeability is the main centralization point of the protocol. A multisig owner is recommended for production.
