---
sidebar_position: 1
title: Build and Test
---

# Build and Test

The contracts live in the [`contracts/`](https://github.com/SentinelFi/sentinel_soroban_v3/tree/main/contracts) Cargo workspace. A Makefile wraps the common commands.

## Prerequisites

- [Rust](https://www.rust-lang.org/tools/install) (the toolchain version is pinned by `rust-toolchain.toml`).
- [Stellar CLI](https://developers.stellar.org/docs/tools/cli/install-cli).

## Build

Build WASM contracts with the Stellar CLI, not plain Cargo:

```bash
cd contracts
stellar contract build            # or: make build
stellar contract build --optimize # optimized, or: make optimize
```

The target is `wasm32v1-none`. Release builds use `opt-level = "z"`, LTO, `panic = "abort"`, and overflow checks enabled.

### Contract size caps

Soroban enforces a hard per-contract code-size cap at upload time (64 KiB). `make build` and CI both run `scripts/check_wasm_size.sh` after building, which fails when any contract exceeds the cap and warns when one is within 10% of it — so a size regression turns into a red pull request, not a failed deploy:

```bash
make check-wasm-size   # re-check already-built artifacts
```

## Test

```bash
cargo test        # or: make test
```

Unit tests live in each contract crate, and cross-contract scenarios in `integration_tests`. Coverage reports use `cargo-llvm-cov`:

```bash
make coverage       # summary
make coverage-html  # HTML report
```

The report generated from `main` is published with this site at [/coverage/](https://sentinelfi.github.io/sentinel_soroban_v3/coverage/), and the README coverage badge reads its `badge.json` endpoint.

## Lint and format

```bash
cargo clippy --all-targets -- -D warnings   # or: make clippy
cargo fmt --all                             # or: make format
```

Additional checks: `cargo audit` for dependency advisories and `make scout-run` for [Scout](https://github.com/CoinFabrik/scout-soroban) static analysis.

## TypeScript bindings

Frontends consume auto-generated bindings:

```bash
stellar contract bindings typescript \
  --wasm target/wasm32v1-none/release/<contract>.wasm \
  --output-dir bindings/<contract>
```
