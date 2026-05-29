# Feedback

## Things to Fix and Improve

1. **Add a Makefile to the contracts folder.**
   Create a `Makefile` inside the `contracts` folder with the following commands: `help` (default), `test` (`cargo test`), `build` (`cargo build` and/or `stellar contract build`), `optimize` (stellar command), `deploy-testnet` (stellar command, target `wasm32v1-none`), `clippy` (`cargo clippy --all-targets -- -D warnings`), `format` (`cargo fmt --all`), `audit` (`cargo audit`), `scout-install` (`cargo install cargo-scout-audit --locked`), and `scout-run` (`cargo scout-audit`).

2. **Add `test_snapshots` to `.gitignore`.**
   Snapshot files generated during testing should not be tracked in version control. Add the relevant path pattern to `.gitignore`. Example path: `contracts\controller\test_snapshots\test\test_buy_insurance_first_traveler_registers_flight.1.json`.

3. **Replace `assert!` and `panic!` with typed contract errors.**
   Define errors using the `#[contracterror]` attribute and use `panic_with_error!` to raise them. This makes error handling explicit and consistent. Using `expect()` is acceptable in cases where it is appropriate.

   ```rust
   #[contracterror]
   #[derive(Copy, Clone, PartialEq, Eq, PartialOrd, Ord)]
   pub enum Error {
       SomeError = 0,
   }

   // Usage
   panic_with_error!(e, Error::SomeError);
   ```

4. **Rename `usdc` to `asset` in contracts.**
   Avoid coupling contract logic to a specific asset name. Replace occurrences of `usdc` with the more generic term `asset` to keep the contracts reusable and asset-agnostic.

5. **Document constructor parameters.**
   Add brief documentation for each parameter passed into contract constructors. Even a short description improves readability and makes the intent of each parameter clear.

6. **Check for duplicate insurance purchases in `buy_insurance`.**
   Verify whether the `buy_insurance` function allows the same traveller to purchase the same insurance more than once using identical parameters. If it does, add a comment.

7. **Generate sequence diagrams for common contract flows.**
   Create sequence diagrams covering the main flows such as insurance purchase, claim processing, contract deployment order. These diagrams help new contributors and reviewers understand how the contracts interact.

8. **Fix hardcoded decimals value in `RiskVault`.**
   In `Base::set_metadata` inside the `RiskVault` constructor, replace the hardcoded value `10` with `Self::decimals(e)`.

9. **Clarify access control for `snapshot` function in `RiskVault`.**
   Confirm whether the `snapshot` function is intended to be callable by anyone. If it is, document this decision explicitly.

10. **Add a `CONTRIBUTING.md` file.**
    Create a `CONTRIBUTING.md` at the root of the repository with a welcoming, low-friction guide. The file should communicate the following:

    Contributions are welcome. Start by opening an issue on GitHub to discuss and align on the change. If no clarification is needed but a code fix is required, you may fork the repository and open a pull request directly. Before submitting, run the tests and make sure the project builds. Document your changes where it matters. Request a review when ready. Thank you for contributing.
