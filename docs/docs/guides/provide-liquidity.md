---
sidebar_position: 2
title: Provide Liquidity
---

# Provide Liquidity

This guide describes the underwriter flow: depositing USDC into the Risk Vault to earn premium yield.

## How returns work

Underwriter capital backs all outstanding policies. Premiums from on-time flights are added to the vault, increasing the value of every share. Payouts for delayed and cancelled flights are paid from the vault, decreasing it. Your return is the net of premiums earned minus payouts absorbed, proportional to your share of the vault.

## Depositing

Call `deposit` on the Risk Vault with the USDC amount and your address as the receiver. You receive **RVS** shares priced by the current share price:

```bash
stellar contract invoke \
  --id <RISK_VAULT_ADDRESS> \
  --source <YOUR_KEY> \
  --network testnet \
  -- deposit \
  --assets 1000000000 \
  --receiver <YOUR_ADDRESS> \
  --from <YOUR_ADDRESS> \
  --operator <YOUR_ADDRESS>
```

For a self-deposit, `receiver`, `from`, and `operator` are all your own address (`operator` is the account whose authorization is required).

Amounts use 7 decimals, so `1000000000` is 100 USDC.

## Withdrawing

There are two paths:

1. **Immediate**: call `redeem` with your shares. This succeeds when the vault has enough free (unlocked) capital.
2. **Queued**: call `request_withdrawal` with your shares. Your shares are escrowed and your request joins a FIFO queue. The queue is processed automatically every few minutes as capital frees up; a request larger than the currently free capital is filled progressively (partial fills), so the queue keeps moving whenever any capital is free. Once processed — fully or partially — call `collect` to receive the USDC credited so far. You can cancel a pending request (its remaining shares) with `cancel_withdrawal`.

A minimum withdrawal request size applies (100 USDC on testnet) to prevent dust spam.

:::info[Settlement barrier]
Deposits and withdrawals are briefly blocked while a flight outcome is publicly known but not yet settled on-chain. This protects existing shareholders from being front-run at a stale share price. Retry after settlement completes, which usually takes minutes.
:::

## Monitoring

- `balance(address)` on the vault shows your share balance.
- `total_assets` and share conversion functions (`convert_to_assets`, `convert_to_shares`) let you value your position.
- Daily share price snapshots are recorded on-chain for 30 days, so historic yield can be charted.

## Risks

- **Underwriting risk**: a cluster of delayed or cancelled flights reduces vault value.
- **Oracle trust**: flight data comes from an authorized oracle. See [Security](../security) for the full trust model.
- **Liquidity**: capital locked behind outstanding policies cannot be withdrawn until those policies settle.
