# oracle_aggregator fuzz harness

Property-based fuzzing for the OracleAggregator forward-only state machine.
Each fuzz input is a `Vec<Op>` that drives a fresh oracle through random
`register_flight` / `set_estimated_arrival` / `set_landed` / `set_cancelled` /
`set_to_be_settled` / `set_settled` / `prune_settled` / ledger-advance
sequences. After every step, the harness asserts:

- For every entry in `get_active_flights()`:
  - `status` is one of the 8 `FlightStatus` variants (enum invariant — should
    always hold)
  - `status == Settled  ⇒  settled_at > 0`
- No invalid state transition succeeds (gated by `is_valid_transition`)
- The contract never panics outside the expected revert paths

## Requirements

- Nightly Rust (`rustup install nightly`)
- `cargo-fuzz` (`cargo install --locked cargo-fuzz`)

## Run (macOS)

```bash
RUSTFLAGS="-Cunsafe-allow-abi-mismatch=sanitizer" \
  cargo +nightly fuzz run --sanitizer=thread state_machine
```

See `../../risk_vault/fuzz/README.md` for an explanation of the macOS flags.

## Run (Linux / CI)

```bash
cargo +nightly fuzz run state_machine
```

## Time-boxed run

```bash
RUSTFLAGS="-Cunsafe-allow-abi-mismatch=sanitizer" \
  cargo +nightly fuzz run --sanitizer=thread state_machine -- -max_total_time=300
```
