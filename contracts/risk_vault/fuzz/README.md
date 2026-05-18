# risk_vault fuzz harness

Property-based fuzzing for the RiskVault solvency invariant. Each fuzz input
is a `Vec<Op>` that drives a freshly-registered vault through a random sequence
of deposit / withdraw / mint / redeem / queue / capital / recover / snapshot
operations. After every step, the harness asserts:

- `get_locked_capital() <= get_total_managed_assets()` — solvency invariant
- `get_total_managed_assets() >= 0`
- `get_locked_capital() >= 0`
- USDC balance of the vault stays non-negative

## Requirements

- Nightly Rust (`rustup install nightly`)
- `cargo-fuzz` (`cargo install --locked cargo-fuzz`)

## Run (macOS)

```bash
RUSTFLAGS="-Cunsafe-allow-abi-mismatch=sanitizer" \
  cargo +nightly fuzz run --sanitizer=thread solvency
```

The `--sanitizer=thread` flag works around a known ASan issue with
soroban-sdk's `#[ctor]` initializers (stellar/rs-soroban-sdk#1056).
The `-Cunsafe-allow-abi-mismatch=sanitizer` RUSTFLAGS silences an ABI
mismatch with `typenum` / `zeroize` / `subtle` introduced by newer nightly
strictness; the sanitizer instrumentation is still applied to *our* code,
the workaround only affects core / compiler-builtins.

## Run (Linux / CI)

Default ASan should work; drop the `--sanitizer=thread` flag.

## Time-boxed run

```bash
RUSTFLAGS="-Cunsafe-allow-abi-mismatch=sanitizer" \
  cargo +nightly fuzz run --sanitizer=thread solvency -- -max_total_time=300
```

## Coverage report

```bash
RUSTFLAGS="-Cunsafe-allow-abi-mismatch=sanitizer" \
  cargo +nightly fuzz coverage --sanitizer=thread solvency
```
