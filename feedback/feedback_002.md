# Feedback

## Things to Fix and Improve

1. **Add module-level doc comments to each contract.**
    Each contract's top-level file should start with a `//!` doc comment giving a high-level description of what the contract does. This gives contributors and reviewers immediate context before reading any implementation code.

2. **Add a GitHub Actions CI workflow.**
    Create a workflow that runs on every pull request with the following steps: `cargo test`, `stellar contract build`, `cargo clippy`, `cargo fmt --check`, and `cargo audit`.

3. **Document contract upgradeability and upgrade authority.**
    Explicitly document that the contracts are upgradeable, who holds the upgrade authority, and how the upgrade process works. This can live in a dedicated `upgrade.md` file inside contracts folder.

4. **Add a Dockerfile that sets up the contract development environment.**
    Create a `Dockerfile` in the contracts folder that installs the pinned Rust toolchain (matching `rust-toolchain.toml`), `cargo` (e.g. 1.94.0), `stellar-cli` (e.g. 26.0.0), the `wasm32v1-none` target.

5. **Add a one-liner comment above every contract function.**
    Each public function should have a brief, informative comment directly above it describing what it does. Skip, if already exists.

6. **Keep `lib.rs` lean.**
    `lib.rs` should contain only the `std` configuration, `mod` declarations, common `use` imports, tests imports. Move implementation details, and other logic into separate files/modules. This makes the entry point easier to read and keeps concerns separated.

7. **Move the upgrade function into a separate module per contract, and track contract version in instance storage.**
    For each contract, extract the upgrade function into its own module (e.g. `upgrade.rs`). Additionally, store and update the current contract version in instance storage so the deployed version can be queried on-chain. This makes upgrade logic easier to locate, audit.