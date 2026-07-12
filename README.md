# Sentinel

[![CI](https://github.com/SentinelFi/sentinel_soroban_v3/actions/workflows/ci.yml/badge.svg)](https://github.com/SentinelFi/sentinel_soroban_v3/actions/workflows/ci.yml)
[![Deploy Docs](https://github.com/SentinelFi/sentinel_soroban_v3/actions/workflows/deploy-docs.yml/badge.svg)](https://github.com/SentinelFi/sentinel_soroban_v3/actions/workflows/deploy-docs.yml)
[![Stellar](https://img.shields.io/badge/Stellar-Soroban-brightgreen?logo=stellar)](https://stellar.org)

## About

Sentinel is decentralized parametric flight delay insurance on Stellar: underwriters deposit capital to back claims, and travelers pay a small premium for a fixed, automatic payout when their flight is delayed or cancelled.

- Documentation: https://sentinelfi.github.io/sentinel_soroban_v3/
- DeepWiki: https://deepwiki.com/SentinelFi/sentinel_soroban_v3
- Architecture: [spec/architecture.md](spec/architecture.md)
- Playground (testnet): https://sentinel-soroban-v3.vercel.app/

## Project Structure

- [contracts/](contracts/) — Soroban smart contracts (Rust workspace)
  - [controller/](contracts/controller/)
  - [risk_vault/](contracts/risk_vault/)
  - [flight_pool_manager/](contracts/flight_pool_manager/)
  - [oracle_aggregator/](contracts/oracle_aggregator/)
  - [governance_module/](contracts/governance_module/)
  - [mock_usdc/](contracts/mock_usdc/)
  - [sentinel_types/](contracts/sentinel_types/)
  - [integration_tests/](contracts/integration_tests/)
- [executor/](executor/) — off-chain executor layer (oracle and keeper cron jobs)
- [playground/](playground/) — web playground for the testnet deployment ([live](https://sentinel-soroban-v3.vercel.app/))
- [deployments/](deployments/) — deployed contract addresses and parameters
- [spec/](spec/) — architecture and design documents
- [docs/](docs/) — documentation site (Docusaurus)
- [audits/](audits/) — audit reports and remediations

## Key Contracts

| Contract | Description |
|----------|-------------|
| [Controller](contracts/controller/) | The system orchestrator; routes funds and calls between contracts but never holds any money itself. |
| [RiskVault](contracts/risk_vault/) | The capital backing layer where all underwriter USDC sits, built on the OpenZeppelin Stellar `FungibleVault`. |
| [FlightPoolManager](contracts/flight_pool_manager/) | A single contract managing all flight insurance pools and recovery accounting, keyed by `(flight_id, date)`. |
| [OracleAggregator](contracts/oracle_aggregator/) | On-chain registry of flight data and the single source of truth for settlement pipeline state. |
| [GovernanceModule](contracts/governance_module/) | The route authority owning canonical terms (premium, payoff, delay threshold) for whitelisted flight routes. |

Deployed addresses are listed in [deployments/](deployments/).

## Getting Started

Prerequisites: [Rust](https://www.rust-lang.org/tools/install) (the pinned toolchain installs automatically via `rust-toolchain.toml`), the [Stellar CLI](https://developers.stellar.org/docs/tools/cli), and `make`.

All commands run from the `contracts/` directory:

```bash
cd contracts

make test            # run the full test suite
make build           # build all contracts to wasm
make check           # formatting, clippy, and tests
make ci              # full local CI (check + dependency audit)

make keys            # generate and fund a testnet identity
make deploy-testnet  # build and deploy all contracts to testnet
```

Run `make help` for the complete target list.

- [Makefile](contracts/Makefile) — all build, test, lint, and deploy targets
- [deploy_order.md](contracts/deploy_order.md) — canonical deploy and wiring order
- [upgrade.md](contracts/upgrade.md) — contract upgradeability and upgrade authority

## License

Licensed under the Apache License 2.0. See [LICENSE](LICENSE).

## Contributing

Contributions are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md).

## Security

Audit reports live in [audits/](audits/). Please report any findings through GitHub's private vulnerability reporting, as described in [SECURITY.md](SECURITY.md).

> [!WARNING]
> While we strive to ensure this software functions as intended, it is provided "as is" with no warranties or guarantees of any kind. Smart contracts are inherently complex and may contain bugs, vulnerabilities, or unintended behaviors. By using this software, you acknowledge and agree that: You use it entirely at your own risk. You should perform your own due diligence, and it is strongly recommended to consult qualified professionals (e.g., security auditors, legal advisors).

---

Copyright © @SentinelFi
