---
sidebar_position: 2
title: Provide Liquidity
---

# Provide Liquidity

This guide describes the underwriter flow: depositing USDC into the Risk Vault to earn premium yield.

## How returns work

Underwriter capital backs all outstanding policies. Premiums from on-time flights are added to the vault, increasing the value of every share. Payouts for delayed and cancelled flights are paid from the vault, decreasing it. Your return is the net of premiums earned minus payouts absorbed, proportional to your share of the vault.

All entry and exit is **two-phase**: you commit value now, and it is priced after a short delay. This is deliberate — it means nobody (including you) can enter or exit based on a flight outcome that is already publicly known but not yet recorded on-chain.

## Depositing

Call `request_deposit` on the Risk Vault with the USDC amount. Your USDC transfers into the vault immediately (escrowed), and after the pricing delay (6 hours) the keeper's next maintenance pass mints your **RVS** shares at the share price current at that moment:

```bash
stellar contract invoke \
  --id <RISK_VAULT_ADDRESS> \
  --source <YOUR_KEY> \
  --network testnet \
  -- request_deposit \
  --caller <YOUR_ADDRESS> \
  --assets 1000000000
```

Amounts use 7 decimals, so `1000000000` is 100 USDC. The call returns a request id; you can cancel with `cancel_deposit` any time before your request is processed and get the USDC back. `preview_deposit` quotes the shares at the current price — an estimate, since actual pricing happens at processing.

## Withdrawing

Call `request_withdrawal` with your shares. Your shares are escrowed and your request joins a FIFO queue; once it matures past the pricing delay it is paid at the then-current share price, as capital allows. A request larger than the currently withdrawable capital — assets above the solvency reserve held against outstanding policies (`get_withdrawable_capital` shows the figure) — is filled progressively (partial fills), so the queue keeps moving whenever any capital is payable. Once processed — fully or partially — call `collect` to receive the USDC credited so far. You can cancel a pending request (its remaining shares) with `cancel_withdrawal`.

A minimum request size applies to both queues (100 USDC on testnet) to prevent dust spam.

:::info[Why the delay?]
The share price only reflects a flight outcome once the oracle records and settles it on-chain, which happens some time after the outcome is publicly known. Pricing your request only after it is 6 hours old guarantees that everything knowable when you committed is already in the price — so an informed trader can never exit before a known loss or enter before a known gain at other LPs' expense. While an outcome is recorded but unsettled, queue processing additionally pauses; your request simply waits and prices after settlement.
:::

## Monitoring

- `balance(address)` on the vault shows your share balance.
- `total_assets` and share conversion functions (`convert_to_assets`, `convert_to_shares`) let you value your position.
- Daily share price snapshots are recorded on-chain for 30 days, so historic yield can be charted.

## Risks

- **Underwriting risk**: a cluster of delayed or cancelled flights reduces vault value.
- **Oracle trust**: flight data comes from an authorized oracle. See [Security](../security) for the full trust model.
- **Liquidity**: capital locked behind outstanding policies cannot be withdrawn until those policies settle.
