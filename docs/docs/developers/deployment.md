---
sidebar_position: 2
title: Contract Deployment
---

# Contract Deployment

Contracts must be deployed in dependency order, then wired together. The authoritative walkthrough is [`contracts/deploy_order.md`](https://github.com/SentinelFi/sentinel_soroban_v3/blob/main/contracts/deploy_order.md); `make deploy-testnet` automates it.

## Order

1. **Asset**: Mock USDC on testnet, or the real USDC SAC address on mainnet.
2. **Governance Module**.
3. **Oracle Aggregator** (must exist before the vault, which takes it as a constructor argument).
4. **Risk Vault** (constructor needs the asset and the oracle address).
5. **Flight Pool Manager** (constructor needs the asset and the vault).
6. **Controller** last (constructor needs all of the above).

Deploy with the Stellar CLI:

```bash
stellar contract deploy \
  --wasm target/wasm32v1-none/release/<contract>.optimized.wasm \
  --source <DEPLOYER_KEY> \
  --network testnet \
  -- <constructor args>
```

## Wiring

After deployment, one-time irreversible wiring points each contract at the Controller:

```bash
stellar contract invoke --id <ORACLE_ID> ... -- set_controller --controller <CONTROLLER_ID>
stellar contract invoke --id <VAULT_ID> ... -- set_controller --controller <CONTROLLER_ID>
stellar contract invoke --id <POOL_ID> ... -- set_controller --controller <CONTROLLER_ID>
```

Then configure the operational roles and required parameters:

```bash
stellar contract invoke --id <ORACLE_ID> ... -- set_oracle --oracle <ORACLE_EXECUTOR_ADDRESS>
stellar contract invoke --id <CONTROLLER_ID> ... -- set_keeper --keeper <KEEPER_EXECUTOR_ADDRESS>
stellar contract invoke --id <VAULT_ID> ... -- set_min_withdrawal_request --amount <AMOUNT>
```

Finally, whitelist at least one route through the Governance Module and the market is live.

:::warning
`set_controller` can only be called once per contract. Double-check the Controller address before wiring.
:::
