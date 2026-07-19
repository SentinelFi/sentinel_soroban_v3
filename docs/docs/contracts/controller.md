---
sidebar_position: 2
title: Controller
---

# Controller

The Controller is the protocol orchestrator. It is the only contract with policy logic and the only one that talks to every other contract. It never holds USDC.

## Traveler entry point

### `buy_insurance(traveler, flight_id, origin, dest, date)`

The single purchase flow:

1. Resolves the route through the Governance Module and rejects unknown or disabled routes.
2. Enforces the minimum lead time before departure.
3. Requires the flight to be open for sale on the Oracle Aggregator: no outcome recorded yet, and a live, unexpired sale authorization (the oracle's attestation that the flight is scheduled and not cancelled). Without one the purchase fails closed — absence of on-chain data is never treated as proof a flight is insurable.
4. On the first purchase for a flight instance, registers the flight with the Flight Pool Manager and Oracle Aggregator. Later purchases of the same flight instance use the terms snapshotted at registration — after re-validating them against the current governance term limits, so lowering the limits stops new exposure at old, larger terms.
5. Checks vault solvency: total managed assets must cover the entire outstanding locked capital plus this payoff, scaled by the solvency ratio.
6. Transfers the premium from the traveler to the Flight Pool Manager.
7. Locks the payoff amount in the Risk Vault and records the buyer.
8. Appends the flight to the traveler's on-chain policy index.

If a buyer whitelist is enabled (off by default), only whitelisted addresses can buy. An approval carries an explicit 180-day inactivity deadline that every purchase slides forward: active buyers never lapse, dormant ones expire by the ledger clock and must be re-approved. The deadline is contract-checked state rather than a storage TTL, so it holds even if the entry archives and is later restored.

## Keeper entry points

All gated by the authorized keeper address:

- `classify_flights()`: compares actual versus scheduled arrival against each route's delay threshold and marks flights to be settled as on time, delayed, or cancelled. Runs hourly.
- `classify_flight(flight_id, date) -> bool`: classifies one exact flight instance without scanning the active list. The executor calls this right after writing an outcome so classification does not wait for the sweep's rotating cursor; the flight must be in the oracle active set, and the return value reports whether a transition ran.
- `execute_settlements()`: performs the money movement for classified flights, at most 10 per call (settlement writes many ledger entries per flight, and the window is sized to the network's per-transaction budgets; larger backlogs drain across successive runs). On time: premiums move from pool to vault and locked capital is released. Delayed or cancelled: the vault tops up the pool so each buyer can claim the full payoff. Runs every 5 minutes.
- `execute_settlements_bounded(limit)`: the same pass with a caller-chosen window (clamped to 1–10) — an operator escape hatch to keep settlement advancing if a full window ever exceeds transaction resource limits.
- `settle_flight(flight_id, date) -> bool`: settles one exact classified flight without scanning the active list — the companion to `classify_flight`, releasing the vault's settlement barrier as soon as the outcome's PnL is recognized instead of after a full cursor rotation.
- `run_queue_maintenance()`: processes the vault withdrawal queue and records share price snapshots. Kept separate from settlement so a heavy settlement batch can never block underwriter withdrawals. Runs every 5 minutes.

## Owner functions

Bounded, owner-only tunables:

| Function | Bounds |
|---|---|
| `set_solvency_ratio` | 100 to 10000 (percent, 100 = fully backed); mirrored into the Risk Vault so withdrawals preserve the same reserve |
| `set_min_lead_time` | less than 90 days |
| `set_claim_expiry_window` | 1 to 60 days |
| `set_keeper` | rotate the keeper address |
| `set_whitelist_enabled`, `add_whitelisted_buyer`, `remove_whitelisted_buyer` | optional buyer whitelist |

The addresses of the Governance Module, Risk Vault, Oracle Aggregator, Flight Pool Manager, and the USDC asset are set at deployment and cannot be changed.

## Reads

- `get_flights_for_traveler(address)`: list of flights a traveler has insured.
- `get_stats()`: returns `(total_policies_sold, total_premiums_collected, total_payouts_distributed)`.
- Wiring getters — `get_oracle()`, `get_risk_vault()`, `get_governance()`, `get_flight_pool_manager()`, `get_asset_token()`, `get_keeper()`: expose the controller's (immutable, construction-time) downstream addresses so every cross-contract wiring invariant is verifiable on-chain after deployment — in particular `controller.get_oracle() == vault.get_oracle()` (the settlement-barrier identity), `controller.get_risk_vault() == pool.get_risk_vault()`, and a single shared asset token across controller, pool, and vault.
