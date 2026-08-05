# Phase 13 — Unified deploy script (testnet / futurenet / mainnet / local)

Status: planned
Started: —
Completed: —

---

## Goal

Ship `scripts/deploy.ts` — **one** TypeScript orchestrator that deploys the
Phase 3 contract set to any Stellar network, wires the one-time
`set_controller` calls, optionally seeds demo data (whitelist routes, mint
demo USDC, deposit underwriter capital), generates the executor's `.env`
file, and writes a canonical `deployments/<network>.json` record.

Network is a runtime flag — `npm run deploy -- --network testnet` (or
`mainnet`, `futurenet`, `local`). The same code path runs everywhere; only
network metadata + USDC source + safety gates differ.

Phase 13 also activates the gated `test_pipeline.sh` (deferred in Phase 12)
by shipping the `test_pipeline.ts` end-to-end driver that consumes a deploy
record.

## Reference

- **Source-of-truth deploy order:** `spec/architecture.md` § "Deployment Order"
  (lines ~1741–1819).
- **Closest existing deploy script:** `../stellar_phase_2/scripts/deploy-testnet.ts`.
  Single-file 418-line orchestrator. Hardcoded to testnet, used the old
  contract set (recovery_pool, flight_pool_wasm install). Phase 13 generalizes
  the network and adapts to the new contract set.
- **Stellar CLI version in this env:** v25.1.0 (matches contracts' soroban-sdk
  v25.3.1 line — confirmed compatible).

## Diffs from the phase-2 deploy

| Area | Phase 2 deploy | Phase 13 deploy |
|---|---|---|
| Network | Hardcoded `testnet` | **`--network` flag** — testnet, futurenet, mainnet, local |
| USDC source | Always deploy mock_usdc | Non-mainnet: deploy mock_usdc; **mainnet: read `MAINNET_USDC_ID` env**, no deploy |
| Friendbot funding | Implicit (testnet only) | Network-aware — friendbot for testnet/futurenet, error on mainnet if keys aren't funded, local quickstart for `local` |
| Contracts deployed | mock_usdc + governance + recovery_pool + oracle + flight_pool (WASM install) + risk_vault + controller (7 ops) | mock_usdc (non-mainnet) + governance + oracle + flight_pool_manager + risk_vault + controller (6 ops) — recovery_pool dropped, FPM replaces flight_pool WASM install |
| Controller args | 11 — owner, gov, vault, oracle, recovery_pool, usdc, flight_pool_wasm, keeper, min_lead_time, claim_expiry, [solvency_ratio] | 9 — owner, gov, risk_vault, oracle, flight_pool_manager, usdc, keeper, min_lead_time, claim_expiry (Phase 3 constructor) |
| Demo seeding | Always run | Gated by `--seed-demo` flag; **off by default on mainnet** |
| Output | `scripts/testnet-deploy.json` + `scripts/.env.testnet` | `deployments/<network>.json` (canonical record) + `executor/centralized_cron/.env.<network>` (auto-generated env file consuming the new flight_pool_manager + Phase 11 surface) |
| Frontend env sync | Updated `frontend/environments.toml` + wrappers + `.env` | **Out of scope** — frontend isn't in this repo yet (Phase 14+) |
| Idempotency | Re-deploy creates new contract IDs | **Skip already-deployed contracts** — read existing `deployments/<network>.json`, only run missing steps. `--force` to override. |
| Mainnet safety | n/a | Require `--confirm-mainnet` flag; print full plan + 5-second pause before submission |

## Out of scope for this phase

- **Frontend deploy / config sync.** The frontend doesn't exist in this repo
  yet (Phase 14+). When it lands, an additive `npm run sync-frontend` step
  can read `deployments/<network>.json` and update the frontend's env.
- **Acurast TEE deploy.** Separate phase under `executor/acurast/`.
- **Contract upgrades / migration scripts.** Soroban supports upgrade-by-hash
  but only one of our contracts (Controller's Pausable) plausibly needs it
  in the near term. Deferred.
- **CI integration.** A GitHub Actions workflow that runs `--network futurenet`
  on every push would be nice but isn't this phase.
- **Multi-sig deployer keys.** Single-key deployer is fine for testnet /
  futurenet / initial mainnet. Mainnet ops can migrate to multi-sig once the
  contracts are live (Stellar account-level multi-sig works transparently).

## Dependencies

- Phase 12 closed (executor at `executor/centralized_cron/`; the deploy script
  generates its `.env`).
- Phase 11 closed (Controller's `whitelist_enabled` defaults `false`; deploy
  doesn't need to touch the whitelist).
- Stellar CLI ≥ v25 installed locally. Verified present at v25.1.0.
- `cargo` + `wasm32v1-none` target (already in `contracts/rust-toolchain.toml`).
- Working `stellar contract build` — produces `contracts/target/wasm32v1-none/release/*.wasm`.

## Context Manifest

### Files to mirror from `../stellar_phase_2/scripts/`

- `deploy-testnet.ts` — overall structure (one-file orchestrator,
  `run()`/`section()`/`deploy()`/`invoke()` helpers, JSON output).

### Project files to read (this repo)

- `spec/architecture.md` § Deployment Order — canonical step ordering.
- `contracts/controller/src/admin.rs` — Controller constructor signature
  (9 args, bounds on min_lead_time + claim_expiry_window).
- `contracts/risk_vault/src/lib.rs` constructor — args + `set_controller` shape.
- `contracts/oracle_aggregator/src/lib.rs` constructor — args.
- `contracts/flight_pool_manager/src/lib.rs` constructor — args.
- `contracts/governance_module/src/lib.rs` constructor — args.
- `contracts/mock_usdc/src/lib.rs` constructor — args.
- `executor/centralized_cron/.env.example` — env-var names the deploy
  script emits.

## Pre-work Notes

**Decisions confirmed by user (chat 2026-05-25):**

- **One script for everywhere.** No per-network duplication. Network is a
  runtime flag.
- **Easy network selection.** `--network <name>` CLI flag is the primary
  interface; an env-var fallback is fine for shell scripting.

**Decisions clarified from in-repo precedent:**

- **TypeScript + tsx + `stellar` CLI shell-out.** Mirrors the phase-2
  approach. Pure Stellar JS SDK is also possible (no shell-out, cleaner
  error handling) but the CLI handles identity management, friendbot
  funding, and account creation out of the box — significantly less code
  to maintain. Stick with CLI shell-out.
- **Single `deploy.ts` plus a small helper trio.** Helpers stay flat:
  - `scripts/src/networks.ts` — table mapping `--network` → RPC URL,
    passphrase, friendbot URL, USDC source.
  - `scripts/src/stellar_cli.ts` — `run`, `build`, `deploy`, `invoke`,
    `ensureIdentity`, `ensureNetwork` wrappers around the CLI.
  - `scripts/src/deployments.ts` — read/write `deployments/<network>.json`.
- **Network table:**

  | Name | RPC URL | Friendbot | USDC source |
  |---|---|---|---|
  | `local` | `http://localhost:8000/rpc` | n/a (quickstart) | deploy `mock_usdc` |
  | `testnet` | `https://soroban-testnet.stellar.org` | `https://friendbot.stellar.org` | deploy `mock_usdc` |
  | `futurenet` | `https://rpc-futurenet.stellar.org` | `https://friendbot-futurenet.stellar.org` | deploy `mock_usdc` |
  | `mainnet` | `https://mainnet.sorobanrpc.com` | n/a | `MAINNET_USDC_ID` env var (require) |

- **Identities:**
  - `sentinel-deployer` — protocol owner across all contracts.
  - `sentinel-oracle` — authorized_oracle on OracleAggregator.
  - `sentinel-keeper` — authorized_keeper on Controller (drives Cron #2/#3/#3b).
  - `sentinel-ttl-extender` — own keypair for the daily TTL cron.
  - **Non-mainnet only:** `sentinel-traveler` + `sentinel-underwriter` for
    demo seeding.
  - Non-mainnet: auto-generate + auto-fund via friendbot if missing.
  - Mainnet: keys MUST already exist locally; script errors if not — refuse
    to silently mint new mainnet keypairs.

- **`deployments/<network>.json` schema:**
  ```json
  {
    "network": "testnet",
    "rpc_url": "...",
    "deployed_at": "ISO-8601",
    "deployer_address": "G...",
    "contracts": {
      "mock_usdc": "C...",          // null on mainnet
      "governance_module": "C...",
      "oracle_aggregator": "C...",
      "risk_vault": "C...",
      "flight_pool_manager": "C...",
      "controller": "C..."
    },
    "accounts": {
      "oracle_executor": "G...",
      "keeper_executor": "G...",
      "ttl_extender": "G...",
      "demo_traveler": "G...",       // null on mainnet
      "demo_underwriter": "G..."     // null on mainnet
    },
    "config": {
      "default_premium": 100000000,
      "default_payoff": 500000000,
      "default_delay_hours": 3,
      "min_lead_time": 3600,
      "claim_expiry_window": 5184000,
      "solvency_ratio": 100
    },
    "demo_routes": [...]             // empty on mainnet
  }
  ```

- **Auto-generated executor env:**
  - File: `executor/centralized_cron/.env.<network>`
  - Pre-filled from the deployment record. Secrets (oracle/keeper/ttl
    secret keys) are **resolved from `stellar keys show <name>`** at deploy
    time and written to the env file. Treat the env file as secret and
    gitignore it (the existing `.gitignore` already covers `.env*` patterns).
  - Frontend env emission is **out of scope** until the frontend exists.

- **Idempotency model.** Each step checks
  `deployments/<network>.json.contracts[<name>]`:
  - Already-deployed contract → log "skip, already at <id>", do not redeploy.
  - Not yet deployed → run the step, append the ID to the record.
  - `--force` re-runs everything (issuing fresh contract IDs); requires
    `--confirm-mainnet` on mainnet.
  - `set_controller` calls are idempotent in failure mode: the contract
    rejects a second call with `"controller already set"`. The script
    catches that and treats it as success (wiring done).

- **Mainnet safety:**
  1. `--network mainnet` requires `--confirm-mainnet` flag.
  2. No friendbot. No demo seeding. No mock USDC deploy.
  3. Print the full plan (network, deployer address, contract config,
     USDC ID, identity addresses) and pause for 5 seconds before the
     first network write.
  4. Refuse to auto-generate missing keypairs — error and require the
     operator to fund the keys out-of-band.

- **Stellar CLI prerequisites the script checks before doing anything:**
  - `stellar --version` ≥ v25 — fail with a clear upgrade message otherwise.
  - `cargo` + `wasm32v1-none` target installed.
  - `stellar contract build` succeeded (or `--skip-build` flag passed).

**Implementation hints:**

- The script runs CLI via `execSync` (same as phase-2). Each step prints
  the command before running so a failure is debuggable from logs alone.
- `--dry-run` flag prints every command without executing — preserve this
  from phase-2; it's how the safety check actually works.
- Catch the `--no-emit-key` / `stellar keys generate --no-fund` distinction:
  on testnet, generate funds; on mainnet, require pre-existing keys.
- Use the `assemble + 40% bump` pattern from `executor/centralized_cron/src/soroban_client.ts`
  if any deploy step hits a resource-budget issue. Should not be needed for
  constructors (small footprint) but document the workaround.

**Forward-looking notes:**

- The `test_pipeline.ts` driver lives at `executor/centralized_cron/src/test_pipeline.ts`
  and is loaded by the existing gated `test_pipeline.sh`. After Phase 13
  deploys to testnet, `npm run test:pipeline` should pass.
- Once frontend lands (Phase 14+), add a small sync step that reads
  `deployments/<network>.json` and updates frontend env / contract bindings.
- Acurast deploy lands in its own phase under `executor/acurast/`. Re-uses
  the same `deployments/<network>.json` record for its config.

## Subtasks

- [ ] 1. **Scaffold** `scripts/` — `package.json` (tsx + @types/node only),
      `tsconfig.json`, `.gitignore` (node_modules + deployments/*.json
      kept; .env.* gitignored).
- [ ] 2. **`scripts/src/networks.ts`** — network table (rpc, passphrase,
      friendbot URL, USDC source). Includes a `requireMainnetConfirmation`
      flag check.
- [ ] 3. **`scripts/src/stellar_cli.ts`** — wrapper functions: `run` (exec
      + dry-run support), `ensureCliVersion`, `ensureNetwork`,
      `ensureIdentity` (auto-fund via friendbot on testnet/futurenet only),
      `build`, `deploy`, `invoke`, `installWasm`, `keysShowSecret`.
- [ ] 4. **`scripts/src/deployments.ts`** — read/write
      `deployments/<network>.json`; helpers to merge in new contract IDs;
      typed shape per the schema above.
- [ ] 5. **`scripts/src/deploy.ts`** — main orchestrator. CLI flags:
      `--network <name>` (required), `--seed-demo` (non-mainnet only),
      `--force`, `--dry-run`, `--skip-build`, `--confirm-mainnet`.
      Steps in order: setup → build → identities → USDC → governance →
      oracle → flight_pool_manager → risk_vault → controller → wire
      controllers → seed defaults → (optional) whitelist demo routes →
      (optional) mint demo USDC → (optional) seed underwriter deposit →
      emit `.env.<network>` → write deployments JSON → print summary.
- [ ] 6. **`scripts/src/verify.ts`** — post-deploy read-back sanity. Checks:
      `gov.get_defaults` matches expected, `ctrl.get_keeper` matches deployed
      keeper, `ctrl.get_solvency_ratio` == 100, `ctrl.whitelist_enabled` ==
      false, `vault.get_total_managed_assets` matches seeded amount,
      `pool.get_active_flights` returns empty (or only demo routes). Invoked
      by `deploy.ts` at the end. Exit non-zero if any mismatch.
- [ ] 7. **`scripts/README.md`** — usage docs (this one stays — load-bearing
      for ops):
      - Quick start for each network
      - Prereqs (CLI versions, target installed)
      - Mainnet checklist (pre-fund keys, set MAINNET_USDC_ID, etc.)
      - How to re-deploy / rotate keys
      - How idempotency works
- [ ] 8. **`scripts/package.json` scripts**:
      ```
      deploy           tsx src/deploy.ts
      deploy:testnet   tsx src/deploy.ts --network testnet --seed-demo
      deploy:futurenet tsx src/deploy.ts --network futurenet --seed-demo
      deploy:local     tsx src/deploy.ts --network local --seed-demo
      deploy:mainnet   tsx src/deploy.ts --network mainnet --confirm-mainnet
      verify           tsx src/verify.ts
      ```
- [ ] 9. **`executor/centralized_cron/src/test_pipeline.ts`** — end-to-end
      driver (port from `../stellar_phase_2/executor/centralized_cron/src/test_pipeline.ts`).
      Reads `deployments/<network>.json` via the `--network` arg or the
      `.env` it consumes. Walks: deposit underwriter capital → buy
      insurance → fetcher tick → oracle.set_landed (simulate flight
      finished) → classifier → settler → assert Settled status. Used by
      `test_pipeline.sh` once it can resolve a deployment.
- [ ] 10. **Update `executor/centralized_cron/test_pipeline.sh`** — read
       `deployments/<network>.json` if present and use it to populate the
       env vars `test_pipeline.ts` expects (network, contract IDs, demo
       keys). Keep the existing "deploy first" error path for unconfigured
       runs.
- [ ] 11. **Update `spec/architecture.md`** Deployment Order section —
       replace the manual-CLI-commands version with a `npm run deploy -- --network <X>`
       quick-start; keep the underlying CLI commands as the "what the
       script does" reference.
- [ ] 12. **Update `spec/progress.md`** — add Phase 13 row, update header.
- [ ] 13. **Smoke test the deploy script against testnet** —
       `npm run deploy:testnet`. Confirms: all 6 contracts deployed, env
       file written, `deployments/testnet.json` written, verify pass.
       Then `cd executor/centralized_cron && bash test_pipeline.sh` — the
       previously-gated pipeline now activates and passes.

### Gate

- `scripts/` exists with `src/`, `package.json`, `tsconfig.json`, `README.md`.
- `cd scripts && npm install && npx tsc --noEmit` clean.
- `npm run deploy -- --network testnet --dry-run` prints the full plan with
  no errors. Doesn't actually deploy.
- `npm run deploy:testnet` deploys all 6 contracts cleanly to Stellar
  testnet; `scripts/deployments/testnet.json` written; verify passes.
- `cd executor/centralized_cron && bash test_pipeline.sh` against the
  fresh testnet deploy — full lifecycle (buy → fetch → classify → settle
  → assert Settled) passes end-to-end.
- A re-run of `npm run deploy:testnet` (without `--force`) is a no-op:
  reports "all contracts already deployed; skipping" and exits 0.
- `cargo test --workspace` still **295 / 295** — no contract changes in
  this phase.

A **mainnet** deploy is intentionally NOT part of this phase's gate. The
gate confirms the script works against testnet and the no-op re-run path
is correct. Mainnet deploy happens when the operator decides to ship.

---

## Work Log

> Populated by the agent during work. Do not edit manually.

---

## Files Created (planned)

- `scripts/package.json`
- `scripts/tsconfig.json`
- `scripts/.gitignore`
- `scripts/README.md`
- `scripts/src/deploy.ts`
- `scripts/src/networks.ts`
- `scripts/src/stellar_cli.ts`
- `scripts/src/deployments.ts`
- `scripts/src/verify.ts`
- `scripts/deployments/.gitkeep` (or initial empty `testnet.json`)
- `executor/centralized_cron/src/test_pipeline.ts`
- `spec/phases/phase-13-deploy.md` (this file)

## Files Modified

- `executor/centralized_cron/test_pipeline.sh` — read deployments record.
- `spec/architecture.md` — Deployment Order quick-start.
- `spec/progress.md` — Phase 13 row.
