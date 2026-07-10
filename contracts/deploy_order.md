# Contract Deploy & Call Order

Canonical order for deploying the Sentinel contracts and wiring them together.
Every step below matters: the contracts reference each other by address, two of
the references are **one-time writes**, and one optional-looking step
(`risk_vault.set_oracle`) is load-bearing for LP protection. For CLI syntax
details (identities, build, bindings) see [workflow.md](workflow.md); for the
full design rationale see [../spec/architecture.md](../spec/architecture.md).

## Dependency graph

```
mock_usdc / USDC SAC          (no dependencies — must exist first)
governance_module             (no contract dependencies)
oracle_aggregator             (no contract dependencies at deploy time)
risk_vault                    (needs: asset address)
flight_pool_manager           (needs: asset address, risk_vault address)
controller                    (needs: ALL of the above)
```

The circular references (vault/pool/oracle need the controller's address, the
controller needs theirs) are resolved by deploying the controller **last** and
then wiring its address back via one-time `set_controller` calls.

## Phase 1 — Build

```bash
stellar contract build --optimize
```

## Phase 2 — Deploy (in this order)

### 1. Asset

- **Testnet:** deploy `mock_usdc` (permissionless mint/faucet — testnet-only,
  see the crate's warning):

  ```bash
  stellar contract deploy --wasm target/wasm32v1-none/release/mock_usdc.wasm \
    --source-account <deployer> --network testnet --alias mock_usdc \
    -- --admin <OWNER>
  ```

- **Mainnet:** do NOT deploy the mock. Use the Stellar Asset
  Contract address as `<ASSET>` everywhere below.

### 2. GovernanceModule

```bash
stellar contract deploy --wasm target/wasm32v1-none/release/governance_module.wasm \
  --source-account <deployer> --network <net> --alias governance_module \
  -- --owner <OWNER> \
     --default_premium <PREMIUM> \
     --default_payoff <PAYOFF> \
     --default_delay_hours <HOURS>
```

Constructor validates the defaults (`premium > 0`, `payoff > premium`,
`delay_hours > 0`) — invalid economics fail at deploy time.

### 3. OracleAggregator

```bash
stellar contract deploy --wasm target/wasm32v1-none/release/oracle_aggregator.wasm \
  --source-account <deployer> --network <net> --alias oracle_aggregator \
  -- --owner <OWNER> \
     --authorized_oracle <ORACLE_EXECUTOR>
```

`authorized_oracle` can be a placeholder at deploy time — it is
owner-updatable later via `set_oracle` (step 12).

### 4. RiskVault

```bash
stellar contract deploy --wasm target/wasm32v1-none/release/risk_vault.wasm \
  --source-account <deployer> --network <net> --alias risk_vault \
  -- --owner <OWNER> --asset_token <ASSET>
```

### 5. FlightPoolManager

```bash
stellar contract deploy --wasm target/wasm32v1-none/release/flight_pool_manager.wasm \
  --source-account <deployer> --network <net> --alias flight_pool_manager \
  -- --owner <OWNER> --asset_token <ASSET> --risk_vault <RISK_VAULT>
```

### 6. Controller (last — needs every other address)

```bash
stellar contract deploy --wasm target/wasm32v1-none/release/controller.wasm \
  --source-account <deployer> --network <net> --alias controller \
  -- --owner <OWNER> \
     --governance <GOVERNANCE> \
     --risk_vault <RISK_VAULT> \
     --oracle <ORACLE_AGGREGATOR> \
     --flight_pool_manager <FLIGHT_POOL_MANAGER> \
     --asset_token <ASSET> \
     --authorized_keeper <KEEPER_EXECUTOR> \
     --min_lead_time_secs 3600 \
     --claim_expiry_window_secs 5184000
```

Notes:

- The solvency ratio is **not** a constructor argument — it initializes to
  100 (%) and is tuned afterwards via `controller.set_solvency_ratio`
  (bounded to [100, 10_000]).
- `min_lead_time_secs` must be strictly below the 90-day booking horizon;
  `claim_expiry_window_secs` must be in [1 day, 60 days]. Both are validated
  at construction.
- The controller's downstream addresses (governance / vault / oracle / pool /
  asset) are **immutable** — there are no setters. A wrong address here means
  redeploying the controller. Only the keeper is rotatable.

## Phase 3 — Wire (call order after deploy)

Order within this phase matters where noted. All calls are made by `<OWNER>`.

```
 7. oracle_aggregator.set_controller(CONTROLLER)     # ONE-TIME, irreversible
 8. risk_vault.set_controller(CONTROLLER)            # ONE-TIME, irreversible
 9. flight_pool_manager.set_controller(CONTROLLER)   # ONE-TIME, irreversible
10. risk_vault.set_oracle(ORACLE_AGGREGATOR)         # REQUIRED — see below
11. risk_vault.set_min_withdrawal_request(MIN)       # REQUIRED — see below
12. oracle_aggregator.set_oracle(ORACLE_EXECUTOR)    # off-chain oracle key
13. controller.set_keeper(KEEPER_EXECUTOR)           # off-chain keeper key
    (12/13 only needed if the constructor values were placeholders)
```

Steps 7–9 are **one-time writes** — each panics on a second call. Verify the
controller address before submitting; a mistake here cannot be corrected
without redeploying the affected contract.

Step 10 is easy to miss and must not be skipped: it points the vault at the
oracle **contract** (distinct from step 12, which sets the off-chain oracle
**executor account** on the oracle contract). Until it is set, the vault's
settlement barrier is inactive — LPs could enter/exit at a stale share price
while a flight outcome is public but unsettled. It is owner-updatable, so it
can also be fixed later, but the gap is open until then.

Step 11 ships disabled (0). Left at 0, one actor can occupy every slot of the
bounded withdrawal queue with dust requests spread across addresses, locking
other LPs out of the exit path. Pick a per-asset value meaningfully above dust
and well below typical LP positions (e.g. `100_0000000` = 100 USDC at
7 decimals). Enforcement is clamped at request time to TMA/2500, so no
configured value can lock ordinary positions out.

## Phase 4 — Configure the protocol

```
14. governance_module.set_defaults(premium, payoff, delay_hours)
      (only if the constructor defaults need changing)
15. governance_module.add_admin(ADMIN)                    # per route manager
16. governance_module.whitelist_route(caller, flight_id, origin, dest,
                                      premium?, payoff?, delay_hours?)
      # one per route; omit optional terms to inherit the defaults
17. controller.set_solvency_ratio(ratio)                  # optional, default 100
18. (optional) controller.set_whitelist_enabled(true)
      + controller.add_whitelisted_buyer(caller, addr)    # per buyer
```

## Phase 5 — Start the executor

```
19. Fund ORACLE_EXECUTOR and KEEPER_EXECUTOR accounts with XLM (tx fees).
20. Start the executor backend (executor/) with the contract IDs + keys:
      - FlightDataFetcher   (oracle key,  ~2 h)  → oracle set_estimated_arrival /
                                                    set_landed / set_cancelled
      - FlightClassifier    (keeper key,  ~1 h;  → controller.classify_flights
                             run at 5 min under load — see architecture.md)
      - SettlementExecutor  (keeper key,  5 min) → controller.execute_settlements
      - QueueMaintainer     (keeper key,  5 min) → controller.run_queue_maintenance
      - TTLExtender         (any funded key, 24 h) → ExtendFootprintTTLOp over
                             active FlightConfig / FlightData / ClaimableBalance /
                             TravelerFlights / Route keys
```

## Verification checklist

After wiring, confirm on-chain:

```
oracle_aggregator.get_authorized_controller() == CONTROLLER
risk_vault.get_controller()                   == CONTROLLER
flight_pool_manager.get_controller()          == Some(CONTROLLER)
risk_vault.get_oracle()                       == Some(ORACLE_AGGREGATOR)   # barrier active
risk_vault.get_min_withdrawal_request()       >  0
oracle_aggregator.get_authorized_oracle()     == ORACLE_EXECUTOR
controller.get_keeper()                       == KEEPER_EXECUTOR
governance_module.get_defaults()              == expected terms
controller.get_solvency_ratio()               == expected ratio
<each contract>.version()                     == 1
```

Then run one end-to-end smoke test: underwriter `deposit` → traveler
`buy_insurance` on a whitelisted route → oracle pushes data → keeper
classifies and settles → traveler `claim` (or premiums arrive as vault
yield).

## Runtime call order (steady state)

For reference, the recurring call sequence once live:

```
Underwriter:  risk_vault.deposit / request_withdrawal / collect / cancel_withdrawal
Traveler:     controller.buy_insurance → (later) flight_pool_manager.claim
Oracle cron:  oracle.set_estimated_arrival → set_landed | set_cancelled
Keeper cron:  controller.classify_flights → controller.execute_settlements
              → controller.run_queue_maintenance
Anyone:       oracle.prune_settled, flight_pool_manager.sweep_expired,
              <contract>.extend_ttl, risk_vault.snapshot
Owner:        flight_pool_manager.withdraw_recovered,
              risk_vault.recover_uncollected,
              pause/unpause (all five contracts as a set),
              oracle.evict_missing_flight → controller.settle_evicted_flight
              (always in that pair; restore-and-settle is preferred over both)
```
