# Example Testnet Workflow

## Prerequisites

Before getting started, make sure to have the following:

- Stellar CLI
- Cargo (Rust)
- Target wasm32v1-none
- This repository cloned and open

## CLI Command Reference

The commands below are meant to be run from inside the `contracts` folder. Use them as a reference guide, not as a production deployment workflow.

### Generate a Test Identity

```bash
stellar keys generate alice --network testnet --fund

stellar keys address alice
```

### Format Code

```bash
cargo fmt --all
```

### Lint

```bash
cargo clippy --all-targets -- -D warnings
```

### Audit Dependencies

```bash
cargo audit
```

### Run Tests

```bash
cargo test
```

### Code Coverage

Coverage uses `cargo-llvm-cov`.

```bash
cargo install cargo-llvm-cov
```

Print a line-coverage summary to the terminal:

```bash
cargo llvm-cov test
```

Generate a browsable HTML report (written to `target/llvm-cov/html/`, which is
gitignored) and open it:

```bash
cargo llvm-cov test --html --open
```

### Build

```bash
cargo build

stellar contract build
```

### Optimize

```bash
stellar contract build --optimize
```

### Deploy to Testnet

```bash
stellar contract deploy --wasm target/wasm32v1-none/release/mock_usdc.wasm --source-account alice --network testnet --alias mock_usdc -- --admin alice

stellar contract deploy --wasm target/wasm32v1-none/release/oracle_aggregator.wasm --source-account alice --network testnet --alias oracle_aggregator -- --owner alice --authorized_oracle alice

stellar contract deploy --wasm target/wasm32v1-none/release/risk_vault.wasm --source-account alice --network testnet --alias risk_vault -- --owner alice --asset_token alice --oracle oracle_aggregator

stellar contract deploy --wasm target/wasm32v1-none/release/flight_pool_manager.wasm --source-account alice --network testnet --alias flight_pool_manager -- --owner alice --asset_token alice --risk_vault risk_vault

stellar contract deploy --wasm target/wasm32v1-none/release/governance_module.wasm --source-account alice --network testnet --alias governance_module -- --owner alice --default_premium 100 --default_payoff 200 --default_delay_hours 3 

stellar contract deploy --wasm target/wasm32v1-none/release/controller.wasm --source-account alice --network testnet --alias controller -- --owner alice --governance alice --risk_vault alice --oracle alice --flight_pool_manager alice --asset_token alice --authorized_keeper alice --min_lead_time_secs 3600 --claim_expiry_window_secs 86500
```

### Generate TypeScript Bindings

```bash
stellar contract bindings typescript --network testnet --wasm target/wasm32v1-none/release/mock_usdc.wasm --output-dir ../bindings/mock_usdc --overwrite

stellar contract bindings typescript --network testnet --wasm target/wasm32v1-none/release/flight_pool_manager.wasm --output-dir ../bindings/flight_pool_manager --overwrite

stellar contract bindings typescript --network testnet --wasm target/wasm32v1-none/release/risk_vault.wasm --output-dir ../bindings/risk_vault --overwrite

stellar contract bindings typescript --network testnet --wasm target/wasm32v1-none/release/oracle_aggregator.wasm --output-dir ../bindings/oracle_aggregator --overwrite

stellar contract bindings typescript --network testnet --wasm target/wasm32v1-none/release/governance_module.wasm --output-dir ../bindings/governance_module --overwrite

stellar contract bindings typescript --network testnet --wasm target/wasm32v1-none/release/controller.wasm --output-dir ../bindings/controller --overwrite
```