# Contracts — Live Testnet Deployment

Deployed from scratch **2026-07-29** (deployer/owner: local stellar
identity `contract-owner`). Canonical machine-readable manifest:
[`deployments/testnet.json`](../deployments/testnet.json) — this page is
the human view. All six contracts share one owner and are fully wired
(`set_controller` ×3, withdrawal floor, term limits, gov admin added).

## Addresses

| Contract | Address |
|---|---|
| **Controller** | `CBDJIPZOC7KH3ICK57MAUZMUXBQ5XF56WJLRP2OY6FF5V2HOFDOFXVY3` |
| **GovernanceModule** | `CATUCJILWACDDEAIFXRL6HXSYDZ7TLOXHMUBKBG4URDOUJHEO7QAJ6NE` |
| **OracleAggregator** | `CDMKBMNJ2YZTARAM4ZUU7HZJZA7UUYJU76ZOAN2SCR3WJYZSSHXV7ESW` |
| **RiskVault** | `CCJLBWEOPNUHIUNOGZMUDQ6EGO563SA3WSEX2NENEDCTJDZOKN3LLDKF` |
| **FlightPoolManager** | `CAA7DVZKQEA7JENAMI7DEKPGAWJQMPY6MKDED2DG2ZCK2G535X5V2PI7` |
| **MockUSDC** (7 decimals, permissionless testnet faucet) | `CDYZY5QA77SCNRKS7AOSVLCRKGI7TKYCWNAIHMOAKTZ5FLS3SR5MAE5Z` |

## Keys

| Role | Address | Notes |
|---|---|---|
| **Owner** | `GCEODBNVUGJVYQKWY7NMU4U3EIYQOXA7LADMQOPNB5PBBKMYCQJ7E6KD` | local identity `contract-owner`; also in `dapp/.env` as `CONTRACT_OWNER_ADDRESS`. Owner-only: `set_defaults`, `set_term_limits`, `add_admin`, `set_oracle`, `set_keeper`, pause switches |
| Authorized oracle | `GD7YY6ESNMW23QXSUJ4KWD2I3P5VCEHK3Z6KJJFANON7NWLZFZE7RNVU` | identity `sentinel-oracle` — sale windows + flight outcomes |
| Authorized keeper | `GAWMULSQDZWFKBUCFBSPFXGN7PVPDB3JCP6YL4VPQOSVQ5C4GKI3KKI5` | identity `sentinel-keeper` — classify/settle/queue |
| Governance admin | `GC2QDXUDKLRX2EJSGHDDMZE7V5LF2GOCNZCT3V6JTSXIHTJYAJ34LQ2J` | identity `sentinel-governor` — route lifecycle via GovSubmitter (`add_admin`'d at deploy) |

## Deployment parameters

| Parameter | Value |
|---|---|
| Module defaults (routes track these via `UseDefault`) | premium **$15** / payoff **$100** / delay threshold **3h** |
| Term limits (owner backstop) | `max_payoff` disabled (0), `max_payoff_ratio` 100 |
| `min_lead_time_secs` | 3600 (buy up to 1h before the flight day) |
| `claim_expiry_window_secs` | **604800 (7 days)** — raised from the previous deploy's ~24h so real travelers don't lose payouts to the sweep |
| Vault `min_withdrawal_request` | 10 base units |

## State

Fresh deployment = **empty state by design** (this replaced a 2h on-chain
wipe of the previous deploy): no routes whitelisted, no policies, no vault
capital. Route intake happens ONLY through the manual admin pipeline —
see [Admin Runbook — Route Seeding](architecture.md#admin-runbook--route-seeding).

## History

| Deploy | Date | Status |
|---|---|---|
| This one | 2026-07-29 | **live** |
| `CCWDQVAJ…ZGHB` (controller) et al. | 2026-07-18 | abandoned (superseded — ~640 routes left on it, harmless) |
| 2026-07-11 set | 2026-07-11 | abandoned |
