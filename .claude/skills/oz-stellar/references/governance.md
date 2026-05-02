# OZ Stellar — Governance: Timelock Controller

## Overview

A time-delayed execution mechanism. Operations must be scheduled, wait for a minimum delay, then executed. Uses role-based access for proposers, executors, and cancellers.

## Roles

```rust
const PROPOSER_ROLE: Symbol = symbol_short!("proposer");
const EXECUTOR_ROLE: Symbol = symbol_short!("executor");
const CANCELLER_ROLE: Symbol = symbol_short!("canceller");
```

## Constructor

```rust
pub fn __constructor(
    e: &Env,
    min_delay: u32,
    proposers: Vec<Address>,
    executors: Vec<Address>,
    admin: Option<Address>,
)
```

## Operation struct

```rust
pub struct Operation {
    pub target: Address,              // contract to call
    pub function: Symbol,             // function name
    pub args: Vec<Val>,               // serialized arguments
    pub predecessor: BytesN<32>,      // must execute first (use [0u8; 32] for none)
    pub salt: BytesN<32>,             // for uniqueness (same op, different IDs)
}
```

## Operation states

```rust
pub enum OperationState {
    Unset,     // not scheduled
    Waiting,   // scheduled, delay not passed
    Ready,     // delay passed, can execute
    Done,      // already executed
}
```

## Core functions

```rust
// Schedule (proposer role)
schedule_operation(e, &operation, delay: u32) -> BytesN<32>  // returns operation_id

// Execute (executor role, only when Ready)
execute_operation(e, &operation) -> Val

// Cancel (canceller role)
cancel_operation(e, operation_id: BytesN<32>)

// Query
get_operation_state(e, operation_id) -> OperationState
hash_operation(e, &operation) -> BytesN<32>
get_min_delay(e) -> u32
is_operation_pending(e, operation_id) -> bool
is_operation_ready(e, operation_id) -> bool
is_operation_done(e, operation_id) -> bool
```

## CustomAccountInterface

The timelock implements `CustomAccountInterface` for use as a smart account:

```rust
type Error = TimelockError;
type Signature = Vec<OperationMeta>;

fn __check_auth(
    e: Env,
    _signature_payload: Hash<32>,
    context_meta: Vec<OperationMeta>,
    auth_contexts: Vec<Context>,
) -> Result<(), Self::Error>
```

### OperationMeta

```rust
pub struct OperationMeta {
    pub predecessor: BytesN<32>,
    pub salt: BytesN<32>,
    pub executor: Option<Address>,
}
```
