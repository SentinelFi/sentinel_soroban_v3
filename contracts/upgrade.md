# Contract Upgradeability & Upgrade Authority

All Sentinel contracts are **upgradeable**. Each one stores its compiled
WebAssembly (Wasm) on-chain behind a stable contract address; the code can be
swapped for a new Wasm without changing that address or losing storage. This
document describes which contracts are upgradeable, **who** may upgrade them,
and **how** the upgrade is performed.

---

- Every deployed contract exposes a single `upgrade(wasm_hash)` entrypoint.
- That entrypoint is gated by `#[only_owner]` — **only the contract's owner can
  upgrade it**, and each contract has its own independent owner set at
  deployment.
- An upgrade swaps code only. It does **not** migrate or transform storage.
- The owner can also transfer ownership (two-step) or renounce it.

---

## Which contracts are upgradeable

| Contract | Constructor arg |
|---|---|
| `controller` | `owner` |
| `risk_vault` | `owner` |
| `oracle_aggregator` | `owner` |
| `governance_module` | `owner` |
| `flight_pool_manager` | `owner` |
| `mock_usdc` *(testnet only)* | `admin` |

> `mock_usdc` is a testnet-only token and is never deployed to mainnet.
> Production uses the real USDC Stellar Asset Contract, which is
> outside this repo's upgrade authority.

---

## Upgrade authority

Upgrade authority is the **contract owner**, implemented with the OpenZeppelin
Stellar [`Ownable`](https://github.com/OpenZeppelin/stellar-contracts) module
(`stellar-access::ownable`).

- The owner is set **once**, in each contract's `__constructor`, via
  `ownable::set_owner(e, &owner)`.
- The `upgrade` function carries the `#[only_owner]` macro, so the call fails
  unless the stored owner authorizes the transaction (`require_auth`).
- Owners are **per-contract and independent** — there is no global super-admin.
  In practice the same key can be used as owner across all contracts at deployment,
  but each owner can be rotated independently afterward.

### Transferring or renouncing authority

Because the contracts derive `Ownable` (`#[contractimpl(contracttrait)] impl
Ownable for ...`), the standard ownership-management entrypoints are available:

- **Two-step transfer** — the current owner initiates a transfer to a new
  address with a `live_until_ledger` expiry, then the new owner must explicitly
  accept it. The two-step handshake prevents transferring ownership to a wrong
  or uncontrolled address. Ownership cannot be renounced while a transfer is
  pending.
- **Renounce** — `renounce_ownership` permanently removes the owner. This is
  **irreversible**: every `#[only_owner]` function — including `upgrade` —
  becomes permanently uncallable, which **freezes the contract's code forever**.
  Only do this if the contract is intended to become immutable.

---

## How the upgrade process works

Mechanically, every `upgrade` function does the same thing:

```rust
#[only_owner]
pub fn upgrade(e: &Env, wasm_hash: BytesN<32>) {
    e.deployer().update_current_contract_wasm(wasm_hash);
}
```

`wasm_hash` is the 32-byte SHA-256 hash of a Wasm blob that has **already been
uploaded** to the ledger. `update_current_contract_wasm` repoints the contract
instance at that code. The contract **address and all persistent/instance
storage are preserved**; only the executable code changes. The new code takes
effect for the **next** invocation after the upgrade transaction commits.

### Step-by-step (Stellar CLI)

1. **Build** the new Wasm:

   ```bash
   make build            # or: stellar contract build
   ```

2. **Upload** the new Wasm to the ledger to obtain its hash. This only installs
   the code; it does not yet affect any live contract:

   ```bash
   stellar contract upload \
     --wasm target/wasm32v1-none/release/<contract>.wasm \
     --source-account <owner> \
     --network <network>
   # prints the wasm hash
   ```

3. **Invoke `upgrade`** on the target contract, signed by its **owner**, passing
   the hash from step 2:

   ```bash
   stellar contract invoke \
     --id <contract-address> \
     --source-account <owner> \
     --network <network> \
     -- upgrade --wasm_hash <hash-from-step-2>
   ```

   The transaction fails if `--source-account` is not the contract's owner.

Repeat per contract that needs upgrading.

### Storage compatibility (important)

The new code reads the *existing* storage as written by the old code. Therefore:

- Storage **keys and value layouts** consumed by the new Wasm must remain
  compatible with what is already on-chain.
- Shared cross-contract types live in the `sentinel_types` crate specifically so
  their XDR layout stays consistent. As noted in that crate, **field/variant
  order is load-bearing** for the `#[contracttype]` codec — reordering or
  removing fields breaks decoding of already-stored data. Do not change those
  layouts without a deliberate, coordinated migration plan.
- If a future upgrade *must* change a stored layout, perform the migration
  explicitly (e.g. add a versioned read path or a one-shot owner-gated migration
  function in the new Wasm) before relying on the new format.

---

## Trust & safety summary

- **Code can change post-deployment.** Users and underwriters are trusting the
  owner not to deploy malicious or buggy logic. This is the principal
  centralization risk of the protocol.
- **Mitigations:** per-contract owners, two-step transfer to avoid fat-finger
  handoffs, the option to renounce for immutability, and the recommendation to
  hold ownership under a multisig.
- **No automatic storage migration** — upgrades are code-only and assume layout
  compatibility.

See [`spec/architecture.md`](../spec/architecture.md) and
[`spec/simple_architecture.md`](../spec/simple_architecture.md) for the broader
access-control and trust model.
