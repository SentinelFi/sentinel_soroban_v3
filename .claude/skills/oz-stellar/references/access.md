# OZ Stellar — Access Control

## Two modules

| Module | Use when |
|---|---|
| **Ownable** | Single owner with exclusive access to restricted functions |
| **AccessControl (RBAC)** | Multiple roles, role hierarchies, fine-grained permissions |

---

## Ownable

### Imports

```rust
use stellar_access::ownable::{self as ownable, Ownable};
use stellar_macros::only_owner;
```

### Setup

```rust
#[contractimpl]
impl MyContract {
    pub fn __constructor(e: &Env, initial_owner: Address) {
        ownable::set_owner(e, &initial_owner);
    }

    #[only_owner]
    pub fn restricted_fn(e: &Env) {
        // only owner can call
    }
}

#[contractimpl(contracttrait)]
impl Ownable for MyContract {}
```

### Key functions

```rust
ownable::set_owner(e, &owner)           // set owner (constructor only)
ownable::renounce_ownership(e)          // permanently remove owner (irreversible)
```

### Two-step ownership transfer

1. Current owner initiates transfer specifying new owner + `live_until_ledger` expiration
2. New owner explicitly accepts the transfer

Cannot renounce ownership while a transfer is in progress.

### Warning

`renounce_ownership()` is **irreversible** — all `#[only_owner]` functions become permanently inaccessible.

---

## Role-Based Access Control (RBAC)

### Imports

```rust
use stellar_access::access_control::{self as access_control, AccessControl};
use stellar_macros::{only_admin, only_role, only_any_role, has_role, has_any_role};
```

### Setup with role hierarchy

```rust
use soroban_sdk::{symbol_short, Symbol};

const MANAGER_ROLE: Symbol = symbol_short!("manager");
const GUARDIAN_ROLE: Symbol = symbol_short!("guardian");

#[contractimpl]
impl MyContract {
    pub fn __constructor(e: &Env, admin: Address, manager: Address) {
        access_control::set_admin(e, &admin);
        // MANAGER_ROLE is the admin of GUARDIAN_ROLE (managers can grant/revoke guardians)
        access_control::set_role_admin_no_auth(e, &admin, &GUARDIAN_ROLE, &MANAGER_ROLE);
        access_control::grant_role_no_auth(e, &admin, &manager, &MANAGER_ROLE);
    }
}

#[contractimpl(contracttrait)]
impl AccessControl for MyContract {}
```

### Key functions

```rust
access_control::set_admin(e, &admin)
access_control::grant_role_no_auth(e, &grantor, &account, &role)
access_control::revoke_role_no_auth(e, &revoker, &account, &role)
access_control::set_role_admin_no_auth(e, &admin, &role, &admin_role)
```

### Macro usage

```rust
// Only admin can call
#[only_admin]
pub fn admin_fn(e: &Env) { /* ... */ }

// Only callers with "minter" role (enforces auth)
#[only_role(caller, "minter")]
pub fn mint(e: &Env, to: Address, token_id: u32, caller: Address) {
    Base::mint(e, &to, token_id);
}

// Caller must have any of the listed roles (enforces auth)
#[only_any_role(caller, ["minter", "burner"])]
pub fn multi_role_fn(e: &Env, caller: Address) { /* ... */ }

// Check role without enforcing auth (caller must call require_auth themselves)
#[has_role(caller, "minter")]
pub fn check_fn(e: &Env, caller: Address) {
    caller.require_auth();
    // ...
}

// Check any of multiple roles without enforcing auth
#[has_any_role(caller, ["minter", "burner"])]
pub fn check_multi_fn(e: &Env, caller: Address) {
    caller.require_auth();
    // ...
}
```

### `only_*` vs `has_*` macros

| Macro family | Auth enforcement | Use when |
|---|---|---|
| `only_role` / `only_any_role` / `only_admin` | Automatic (calls `require_auth`) | Default choice — handles auth for you |
| `has_role` / `has_any_role` | Manual (you call `require_auth`) | Need custom auth logic before the role check |
