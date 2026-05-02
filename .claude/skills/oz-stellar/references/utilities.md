# OZ Stellar — Utilities

## Pausable

### Imports

```rust
use stellar_pausable::pausable::{self as pausable, Pausable};
use stellar_macros::{when_not_paused, when_paused, only_owner};
```

### Implementation

```rust
#[contractimpl(contracttrait)]
impl Pausable for MyContract {
    fn paused(e: &Env) -> bool {
        pausable::paused(e)
    }

    #[only_owner]
    fn pause(e: &Env, _caller: Address) {
        pausable::pause(e);
    }

    #[only_owner]
    fn unpause(e: &Env, _caller: Address) {
        pausable::unpause(e);
    }
}
```

### Guard macros

```rust
// Only runs when contract is NOT paused
#[when_not_paused]
pub fn transfer(e: &Env, from: Address, to: Address, amount: i128) {
    Base::transfer(&e, &from, &to, amount);
}

// Only runs when contract IS paused (e.g. emergency functions)
#[when_paused]
pub fn emergency_reset(e: &Env) {
    e.storage().instance().set(&DataKey::Counter, &0);
}
```

---

## Upgradeable

### Basic upgrade (WASM binary only)

```rust
use stellar_contract_utils::upgradeable::UpgradeableInternal;
use stellar_macros::Upgradeable;

#[derive(Upgradeable)]
#[contract]
pub struct MyContract;

impl UpgradeableInternal for MyContract {
    fn _require_auth(e: &Env, operator: &Address) {
        operator.require_auth();
        let owner: Address = e.storage().instance().get(&symbol_short!("OWNER")).unwrap();
        if *operator != owner {
            panic_with_error!(e, MyError::Unauthorized)
        }
    }
}
```

### Upgrade with migration (WASM + storage changes)

```rust
use stellar_contract_utils::upgradeable::UpgradeableMigratableInternal;
use stellar_macros::UpgradeableMigratable;

#[contracttype]
pub struct MigrationData {
    pub num1: u32,
    pub num2: u32,
}

#[derive(UpgradeableMigratable)]
#[contract]
pub struct MyContract;

impl UpgradeableMigratableInternal for MyContract {
    type MigrationData = MigrationData;

    fn _require_auth(e: &Env, operator: &Address) {
        operator.require_auth();
        let owner: Address = e.storage().instance().get(&symbol_short!("OWNER")).unwrap();
        if *operator != owner {
            panic_with_error!(e, MyError::Unauthorized)
        }
    }

    fn _migrate(e: &Env, data: &Self::MigrationData) {
        e.storage().instance().set(&symbol_short!("DATA_KEY"), data);
    }
}
```

### Atomic upgrade helper (separate Upgrader contract)

```rust
use stellar_contract_utils::upgradeable::UpgradeableClient;

#[contract]
pub struct Upgrader;

#[contractimpl]
impl Upgrader {
    pub fn upgrade_and_migrate(
        env: Env,
        contract_address: Address,
        operator: Address,
        wasm_hash: BytesN<32>,
        migration_data: Vec<Val>,
    ) {
        operator.require_auth();
        let client = UpgradeableClient::new(&env, &contract_address);
        client.upgrade(&wasm_hash, &operator);
        env.invoke_contract::<()>(&contract_address, &symbol_short!("migrate"), migration_data);
    }
}
```

### Limitations

The framework does NOT verify:
- Absence of constructors in new implementations
- Presence of upgradability in updated contracts
- Storage consistency between versions

---

## Cryptography

### Imports

```rust
use stellar_contract_utils::crypto::hasher::Hasher;
use stellar_contract_utils::crypto::keccak::Keccak256;
use stellar_contract_utils::crypto::sha256::Sha256;
use stellar_contract_utils::crypto::merkle::Verifier;
```

### Hasher trait

```rust
pub trait Hasher {
    type Output;
    fn new(e: &Env) -> Self;
    fn update(&mut self, input: Bytes);
    fn finalize(self) -> Self::Output;
}
```

Built-in implementations: `Sha256`, `Keccak256`
Built-in `Hashable` types: `BytesN<32>`, `Bytes`

### Merkle tree verification

```rust
use stellar_contract_utils::crypto::merkle::Verifier;

// Verify a Merkle proof
let is_valid = Verifier::<Keccak256>::verify(&env, proof, root, leaf);
```

### Utility functions

- `hash_pair` — hash two values together
- `commutative_hash_pair` — deterministic order hashing (for Merkle trees)
