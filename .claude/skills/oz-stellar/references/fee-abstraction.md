# OZ Stellar — Fee Abstraction

## Overview

Enables gasless transactions by letting users pay fees in fungible tokens instead of XLM. A relayer executes the transaction and collects the fee token.

## Fee token allowlist

```rust
// Enable a token for fee payments
set_allowed_fee_token(e, &usdc_token, true);

// Disable a token
set_allowed_fee_token(e, &deprecated_token, false);

// Check if a token is allowed
let is_allowed = is_allowed_fee_token(e, &token);
```

## Token sweeping

```rust
// Transfer all accumulated fee tokens to a recipient (e.g. treasury)
let amount = sweep_token(e, &fee_token, &treasury);
```

## Approval strategies

| Strategy | Enum | How it works |
|---|---|---|
| **Eager** | `FeeAbstractionApproval::Eager` | Approval embedded in the forwarded call |
| **Lazy** | `FeeAbstractionApproval::Lazy` | Uses pre-existing allowance |

## Permissioned FeeForwarder (with role-based relayer)

```rust
use stellar_macros::only_role;

#[only_role(relayer, "executor")]
pub fn forward(
    e: &Env,
    fee_token: Address,
    fee_amount: i128,
    max_fee_amount: i128,
    expiration_ledger: u32,
    target_contract: Address,
    target_fn: Symbol,
    target_args: Vec<Val>,
    user: Address,
    relayer: Address,
) -> Val {
    collect_fee_then_invoke(
        e,
        &fee_token, fee_amount, max_fee_amount, expiration_ledger,
        &target_contract, &target_fn, &target_args,
        &user, &e.current_contract_address(),
        FeeAbstractionApproval::Lazy,
    )
}
```

## Permissionless FeeForwarder (anyone can relay)

```rust
pub fn forward(
    e: &Env,
    fee_token: Address,
    fee_amount: i128,
    max_fee_amount: i128,
    expiration_ledger: u32,
    target_contract: Address,
    target_fn: Symbol,
    target_args: Vec<Val>,
    user: Address,
    relayer: Address,
) -> Val {
    relayer.require_auth();
    collect_fee_and_invoke(
        e,
        &fee_token, fee_amount, max_fee_amount, expiration_ledger,
        &target_contract, &target_fn, &target_args,
        &user, &relayer,
        FeeAbstractionApproval::Eager,
    )
}
```

## Core invocation functions

| Function | Approval | Use with |
|---|---|---|
| `collect_fee_then_invoke()` | Lazy (pre-approved allowance) | Permissioned relayer |
| `collect_fee_and_invoke()` | Eager (embedded approval) | Permissionless relayer |
