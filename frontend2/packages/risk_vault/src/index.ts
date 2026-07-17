import { Buffer } from "buffer";
import { Address } from "@stellar/stellar-sdk";
import {
  AssembledTransaction,
  Client as ContractClient,
  ClientOptions as ContractClientOptions,
  MethodOptions,
  Result,
  Spec as ContractSpec,
} from "@stellar/stellar-sdk/contract";
import type {
  u32,
  i32,
  u64,
  i64,
  u128,
  i128,
  u256,
  i256,
  Option,
  Timepoint,
  Duration,
} from "@stellar/stellar-sdk/contract";
export * from "@stellar/stellar-sdk";
export * as contract from "@stellar/stellar-sdk/contract";
export * as rpc from "@stellar/stellar-sdk/rpc";

if (typeof window !== "undefined") {
  //@ts-ignore Buffer exists
  window.Buffer = window.Buffer || Buffer;
}


export const networks = {
  testnet: {
    networkPassphrase: "Test SDF Network ; September 2015",
    contractId: "CDW5YUJXGJWPVOQBXYVDZN7P7QQSE3U6VGIHBN24HZKKCS5QQ75OLIJE",
  }
} as const











/**
 * Mode for `recover_uncollected` — owner-driven manual recovery of an
 * archived `ClaimableBalance` entry. Carried on the wire via the
 * `vault.recovered` event so the off-chain indexer can update its
 * `claimable_balances` table accordingly.
 */
export type RecoveryMode = {tag: "Recredit", values: void} | {tag: "Transfer", values: void};


export interface WithdrawalRequest {
  owner: string;
  request_id: u64;
  shares: i128;
}












export interface Client {
  /**
   * Construct and simulate a extend_ttl transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Extend instance TTL. Called by cron as a safety net.
   */
  extend_ttl: (options?: MethodOptions) => Promise<AssembledTransaction<null>>

  /**
   * Construct and simulate a set_oracle transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Rotate the OracleAggregator address the vault consults to block
   * entry/exit while a flight outcome is public but not yet settled.
   * Owner-only. The initial oracle is wired at construction, so this
   * exists only for the (redeploy-the-oracle) contingency; note the
   * asymmetry with `set_controller`, which is deliberately one-time —
   * the barrier target must stay rotatable because the vault cannot
   * function safely against a dead oracle, while a controller swap has
   * no such recovery need. Emits `oracle_set` so monitoring catches any
   * re-wire of the barrier target.
   */
  set_oracle: ({oracle}: {oracle: string}, options?: MethodOptions) => Promise<AssembledTransaction<null>>

  /**
   * Construct and simulate a set_controller transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Set the vault controller address (one-time, owner-only).
   */
  set_controller: ({controller}: {controller: string}, options?: MethodOptions) => Promise<AssembledTransaction<null>>

  /**
   * Construct and simulate a set_min_withdrawal_request transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Set the minimum asset value a queued withdrawal request must carry at
   * submission time (owner-only). The withdrawal queue is a bounded shared
   * resource: without a value floor, one participant can split shares
   * across many addresses and occupy every slot with near-dust requests,
   * locking later underwriters out of the FIFO exit path. A meaningful
   * minimum makes each slot cost real escrowed capital. Zero disables the
   * floor. Choose the value in underlying-asset units, well below typical
   * LP position sizes so small underwriters can still queue their exits.
   * 
   * The enforcement is clamped at request time to a small fraction of
   * managed assets (see `MIN_REQUEST_FLOOR_DIVISOR`), so no configured
   * value — however large — can lock ordinary positions out of the queue.
   */
  set_min_withdrawal_request: ({min_assets}: {min_assets: i128}, options?: MethodOptions) => Promise<AssembledTransaction<null>>

  /**
   * Construct and simulate a collect transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Collect (transfer out) the caller's accrued claimable balance.
   */
  collect: ({caller}: {caller: string}, options?: MethodOptions) => Promise<AssembledTransaction<null>>

  /**
   * Construct and simulate a cancel_withdrawal transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Cancel a queued withdrawal by request_id (NOT queue index).
   * Indices shift when process_withdrawal_queue drains earlier entries;
   * a stable id avoids cancelling the wrong request.
   */
  cancel_withdrawal: ({caller, request_id}: {caller: string, request_id: u64}, options?: MethodOptions) => Promise<AssembledTransaction<null>>

  /**
   * Construct and simulate a request_withdrawal transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Submit a withdrawal request. Returns a monotonic request_id that the
   * caller can use to cancel the request later (immune to queue reorder
   * caused by intervening process_withdrawal_queue calls).
   */
  request_withdrawal: ({caller, shares}: {caller: string, shares: i128}, options?: MethodOptions) => Promise<AssembledTransaction<u64>>

  /**
   * Construct and simulate a recover_uncollected transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Owner-driven manual recovery of an archived `ClaimableBalance` entry
   * (or any user owed value the protocol couldn't deliver via
   * `process_withdrawal_queue` + `collect`). Uses event logs as the
   * audit trail for who is owed what.
   * 
   * - `RecoveryMode::Recredit` — SET `ClaimableBalance(user) = amount`,
   * extend TTL, emit `vault.recovered(.., Recredit)`. Use after
   * archival recovery.
   * - `RecoveryMode::Transfer` — directly `asset.transfer(vault → user,
   * amount)`. No storage write. Use when user wants funds in hand.
   * 
   * Layered defense:
   * 1. On-write 60-day TTL extension (`process_withdrawal_queue`).
   * 2. Off-chain TTL cron `ExtendFootprintTTLOp` covering
   * `ClaimableBalance(addr)` keys.
   * 3. This function (`recover_uncollected`) — owner manual fallback if
   * layers 1 and 2 fail.
   */
  recover_uncollected: ({user, amount, mode}: {user: string, amount: i128, mode: RecoveryMode}, options?: MethodOptions) => Promise<AssembledTransaction<null>>

  /**
   * Construct and simulate a name transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Returns the name for this token.
   * 
   * # Arguments
   * 
   * * `e` - Access to Soroban environment.
   */
  name: (options?: MethodOptions) => Promise<AssembledTransaction<string>>

  /**
   * Construct and simulate a pause transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   */
  pause: ({caller}: {caller: string}, options?: MethodOptions) => Promise<AssembledTransaction<null>>

  /**
   * Construct and simulate a paused transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Returns true if the contract is paused, and false otherwise.
   * 
   * # Arguments
   * 
   * * `e` - Access to Soroban environment.
   */
  paused: (options?: MethodOptions) => Promise<AssembledTransaction<boolean>>

  /**
   * Construct and simulate a symbol transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Returns the symbol for this token.
   * 
   * # Arguments
   * 
   * * `e` - Access to Soroban environment.
   */
  symbol: (options?: MethodOptions) => Promise<AssembledTransaction<string>>

  /**
   * Construct and simulate a approve transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Sets the amount of tokens a `spender` is allowed to spend on behalf of
   * an `owner`. Overrides any existing allowance set between `spender` and
   * `owner`.
   * 
   * # Arguments
   * 
   * * `e` - Access to Soroban environment.
   * * `owner` - The address holding the tokens.
   * * `spender` - The address authorized to spend the tokens.
   * * `amount` - The amount of tokens made available to `spender`.
   * * `live_until_ledger` - The ledger number at which the allowance
   * expires.
   * 
   * # Errors
   * 
   * * [`FungibleTokenError::InvalidLiveUntilLedger`] - Occurs when
   * attempting to set `live_until_ledger` that is less than the current
   * ledger number and greater than `0`.
   * * [`FungibleTokenError::LessThanZero`] - Occurs when `amount < 0`.
   * 
   * # Events
   * 
   * * topics - `["approve", from: Address, spender: Address]`
   * * data - `[amount: i128, live_until_ledger: u32]`
   */
  approve: ({owner, spender, amount, live_until_ledger}: {owner: string, spender: string, amount: i128, live_until_ledger: u32}, options?: MethodOptions) => Promise<AssembledTransaction<null>>

  /**
   * Construct and simulate a balance transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Returns the amount of tokens held by `account`.
   * 
   * # Arguments
   * 
   * * `e` - Access to the Soroban environment.
   * * `account` - The address for which the balance is being queried.
   */
  balance: ({account}: {account: string}, options?: MethodOptions) => Promise<AssembledTransaction<i128>>

  /**
   * Construct and simulate a unpause transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   */
  unpause: ({caller}: {caller: string}, options?: MethodOptions) => Promise<AssembledTransaction<null>>

  /**
   * Construct and simulate a decimals transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Returns the number of decimals used to represent amounts of this token.
   * 
   * # Arguments
   * 
   * * `e` - Access to Soroban environment.
   */
  decimals: (options?: MethodOptions) => Promise<AssembledTransaction<u32>>

  /**
   * Construct and simulate a transfer transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Transfers `amount` of tokens from `from` to `to`.
   * 
   * # Arguments
   * 
   * * `e` - Access to Soroban environment.
   * * `from` - The address holding the tokens.
   * * `to` - The address receiving the transferred tokens.
   * * `amount` - The amount of tokens to be transferred.
   * 
   * # Errors
   * 
   * * [`FungibleTokenError::InsufficientBalance`] - When attempting to
   * transfer more tokens than `from` current balance.
   * * [`FungibleTokenError::LessThanZero`] - When `amount < 0`.
   * 
   * # Events
   * 
   * * topics - `["transfer", from: Address, to: Address]`
   * * data - `[to_muxed_id: Option<u64>, amount: i128]`
   */
  transfer: ({from, to, amount}: {from: string, to: string, amount: i128}, options?: MethodOptions) => Promise<AssembledTransaction<null>>

  /**
   * Construct and simulate a allowance transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Returns the amount of tokens a `spender` is allowed to spend on behalf
   * of an `owner`.
   * 
   * # Arguments
   * 
   * * `e` - Access to Soroban environment.
   * * `owner` - The address holding the tokens.
   * * `spender` - The address authorized to spend the tokens.
   */
  allowance: ({owner, spender}: {owner: string, spender: string}, options?: MethodOptions) => Promise<AssembledTransaction<i128>>

  /**
   * Construct and simulate a get_owner transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Returns `Some(Address)` if ownership is set, or `None` if ownership has
   * been renounced.
   * 
   * # Arguments
   * 
   * * `e` - Access to the Soroban environment.
   */
  get_owner: (options?: MethodOptions) => Promise<AssembledTransaction<Option<string>>>

  /**
   * Construct and simulate a total_supply transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Returns the total amount of tokens in circulation.
   * 
   * # Arguments
   * 
   * * `e` - Access to the Soroban environment.
   */
  total_supply: (options?: MethodOptions) => Promise<AssembledTransaction<i128>>

  /**
   * Construct and simulate a transfer_from transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Transfers `amount` of tokens from `from` to `to` using the
   * allowance mechanism. `amount` is then deducted from `spender`
   * allowance.
   * 
   * # Arguments
   * 
   * * `e` - Access to Soroban environment.
   * * `spender` - The address authorizing the transfer, and having its
   * allowance consumed during the transfer.
   * * `from` - The address holding the tokens which will be transferred.
   * * `to` - The address receiving the transferred tokens.
   * * `amount` - The amount of tokens to be transferred.
   * 
   * # Errors
   * 
   * * [`FungibleTokenError::InsufficientBalance`] - When attempting to
   * transfer more tokens than `from` current balance.
   * * [`FungibleTokenError::LessThanZero`] - When `amount < 0`.
   * * [`FungibleTokenError::InsufficientAllowance`] - When attempting to
   * transfer more tokens than `spender` current allowance.
   * 
   * # Events
   * 
   * * topics - `["transfer", from: Address, to: Address]`
   * * data - `[amount: i128]`
   */
  transfer_from: ({spender, from, to, amount}: {spender: string, from: string, to: string, amount: i128}, options?: MethodOptions) => Promise<AssembledTransaction<null>>

  /**
   * Construct and simulate a accept_ownership transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Accepts a pending ownership transfer.
   * 
   * # Arguments
   * 
   * * `e` - Access to the Soroban environment.
   * 
   * # Errors
   * 
   * * [`crate::role_transfer::RoleTransferError::NoPendingTransfer`] - If
   * there is no pending transfer to accept.
   * 
   * # Events
   * 
   * * topics - `["ownership_transfer_completed"]`
   * * data - `[new_owner: Address]`
   */
  accept_ownership: (options?: MethodOptions) => Promise<AssembledTransaction<null>>

  /**
   * Construct and simulate a renounce_ownership transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Renounces ownership of the contract.
   * 
   * Permanently removes the owner, disabling all functions gated by
   * `#[only_owner]`.
   * 
   * # Arguments
   * 
   * * `e` - Access to the Soroban environment.
   * 
   * # Errors
   * 
   * * [`OwnableError::TransferInProgress`] - If there is a pending ownership
   * transfer.
   * * [`OwnableError::OwnerNotSet`] - If the owner is not set.
   * 
   * # Notes
   * 
   * * Authorization for the current owner is required.
   */
  renounce_ownership: (options?: MethodOptions) => Promise<AssembledTransaction<null>>

  /**
   * Construct and simulate a transfer_ownership transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Initiates a 2-step ownership transfer to a new address.
   * 
   * Requires authorization from the current owner. The new owner must later
   * call `accept_ownership()` to complete the transfer.
   * 
   * # Arguments
   * 
   * * `e` - Access to the Soroban environment.
   * * `new_owner` - The proposed new owner.
   * * `live_until_ledger` - Ledger number until which the new owner can
   * accept. A value of `0` cancels any pending transfer.
   * 
   * # Errors
   * 
   * * [`OwnableError::OwnerNotSet`] - If the owner is not set.
   * * [`crate::role_transfer::RoleTransferError::NoPendingTransfer`] - If
   * trying to cancel a transfer that doesn't exist.
   * * [`crate::role_transfer::RoleTransferError::InvalidLiveUntilLedger`] -
   * If the specified ledger is in the past.
   * * [`crate::role_transfer::RoleTransferError::InvalidPendingAccount`] -
   * If the specified pending account is not the same as the provided `new`
   * address.
   * 
   * # Notes
   * 
   * * Authorization for the current owner is required.
   */
  transfer_ownership: ({new_owner, live_until_ledger}: {new_owner: string, live_until_ledger: u32}, options?: MethodOptions) => Promise<AssembledTransaction<null>>

  /**
   * Construct and simulate a send_payout transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Controller-only: transfer a claim payout from managed assets to a recipient.
   */
  send_payout: ({controller, to, amount}: {controller: string, to: string, amount: i128}, options?: MethodOptions) => Promise<AssembledTransaction<null>>

  /**
   * Construct and simulate a decrease_locked transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Controller-only: release previously locked collateral capital.
   */
  decrease_locked: ({controller, amount}: {controller: string, amount: i128}, options?: MethodOptions) => Promise<AssembledTransaction<null>>

  /**
   * Construct and simulate a increase_locked transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Controller-only: lock additional capital as collateral.
   */
  increase_locked: ({controller, amount}: {controller: string, amount: i128}, options?: MethodOptions) => Promise<AssembledTransaction<null>>

  /**
   * Construct and simulate a record_premium_income transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Controller-only: credit received premium income to managed assets.
   */
  record_premium_income: ({controller, amount}: {controller: string, amount: i128}, options?: MethodOptions) => Promise<AssembledTransaction<null>>

  /**
   * Construct and simulate a process_withdrawal_queue transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Controller-only: drain queued withdrawals into claimable balances (batched, FIFO).
   */
  process_withdrawal_queue: ({controller}: {controller: string}, options?: MethodOptions) => Promise<AssembledTransaction<null>>

  /**
   * Construct and simulate a get_oracle transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Return the configured oracle address. Wired at construction, so this
   * is always `Some` on a live vault; the `Option` shape is kept for ABI
   * stability with existing tooling.
   */
  get_oracle: (options?: MethodOptions) => Promise<AssembledTransaction<Option<string>>>

  /**
   * Construct and simulate a get_controller transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Return the configured controller address.
   */
  get_controller: (options?: MethodOptions) => Promise<AssembledTransaction<string>>

  /**
   * Construct and simulate a get_free_capital transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Return free (unlocked) capital available for withdrawal/payout.
   */
  get_free_capital: (options?: MethodOptions) => Promise<AssembledTransaction<i128>>

  /**
   * Construct and simulate a get_locked_capital transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Return the amount of capital currently locked as collateral.
   */
  get_locked_capital: (options?: MethodOptions) => Promise<AssembledTransaction<i128>>

  /**
   * Construct and simulate a get_withdrawal_queue transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Return the current pending withdrawal request queue.
   */
  get_withdrawal_queue: (options?: MethodOptions) => Promise<AssembledTransaction<Array<WithdrawalRequest>>>

  /**
   * Construct and simulate a get_claimable_balance transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Return the claimable (collectible) balance owed to an address.
   */
  get_claimable_balance: ({address}: {address: string}, options?: MethodOptions) => Promise<AssembledTransaction<i128>>

  /**
   * Construct and simulate a get_total_managed_assets transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Return the total assets under management by the vault.
   */
  get_total_managed_assets: (options?: MethodOptions) => Promise<AssembledTransaction<i128>>

  /**
   * Construct and simulate a get_withdrawal_queue_len transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Return the number of pending withdrawal requests. Cheap saturation
   * gauge for operators: the queue is capped, so occupancy approaching the
   * cap means new exit requests are about to be rejected and warrants
   * intervention (more frequent draining, or raising the request minimum).
   */
  get_withdrawal_queue_len: (options?: MethodOptions) => Promise<AssembledTransaction<u32>>

  /**
   * Construct and simulate a get_min_withdrawal_request transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Return the minimum asset value a queued withdrawal request must carry
   * (0 = no minimum configured).
   */
  get_min_withdrawal_request: (options?: MethodOptions) => Promise<AssembledTransaction<i128>>

  /**
   * Construct and simulate a upgrade transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Owner-gated Wasm upgrade. Delegates to the shared implementation, which
   * also bumps the stored on-chain version.
   */
  upgrade: ({wasm_hash}: {wasm_hash: Buffer}, options?: MethodOptions) => Promise<AssembledTransaction<null>>

  /**
   * Construct and simulate a version transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Current on-chain contract version.
   */
  version: (options?: MethodOptions) => Promise<AssembledTransaction<u32>>

  /**
   * Construct and simulate a snapshot transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Record today's share price into temporary storage and emit it.
   * 
   * Access control: **intentionally permissionless** — any address may call
   * this, by design. It is a keeper/cron entrypoint meant to be triggered
   * by the off-chain scheduler, but anyone is allowed to keep the daily price
   * series alive. This is safe because the function:
   * - moves no funds and mutates no capital/locked accounting — it only
   * writes a derived price into temporary storage and emits an event;
   * - cannot be manipulated by the caller — the price is computed solely
   * from on-chain state, so a caller controls only *when* it runs, never
   * the recorded value;
   * - is idempotent and rate-limited — it no-ops if a snapshot already
   * exists for the current day (see the guard below), so repeated or
   * adversarial calls cost the caller gas but change nothing.
   * 
   * One residual caller degree of freedom: WHICH moment within the day is
   * recorded. An early caller can pin the day's price before that day's
   * settlements land (the pending-outcomes guard below only defers whi
   */
  snapshot: (options?: MethodOptions) => Promise<AssembledTransaction<null>>

  /**
   * Construct and simulate a get_snapshot_price transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Return the recorded share price for the given day (0 if expired/absent).
   */
  get_snapshot_price: ({day}: {day: u64}, options?: MethodOptions) => Promise<AssembledTransaction<i128>>

  /**
   * Construct and simulate a mint transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Mints `shares` to `receiver`, pulling the required assets priced on managed assets.
   */
  mint: ({shares, receiver, from, operator}: {shares: i128, receiver: string, from: string, operator: string}, options?: MethodOptions) => Promise<AssembledTransaction<i128>>

  /**
   * Construct and simulate a redeem transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Redeems `shares` for assets to `receiver`, blocked while the withdrawal queue is active or if it exceeds free capital.
   */
  redeem: ({shares, receiver, owner, operator}: {shares: i128, receiver: string, owner: string, operator: string}, options?: MethodOptions) => Promise<AssembledTransaction<i128>>

  /**
   * Construct and simulate a deposit transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Deposits `assets` for `receiver`, minting shares priced on managed assets.
   */
  deposit: ({assets, receiver, from, operator}: {assets: i128, receiver: string, from: string, operator: string}, options?: MethodOptions) => Promise<AssembledTransaction<i128>>

  /**
   * Construct and simulate a max_mint transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Returns the maximum shares mintable for `address`, or zero while
   * deposits are globally disabled (paused or settlement pending).
   */
  max_mint: ({address}: {address: string}, options?: MethodOptions) => Promise<AssembledTransaction<i128>>

  /**
   * Construct and simulate a withdraw transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Withdraws `assets` to `receiver`, blocked while the withdrawal queue is active or if it exceeds free capital.
   */
  withdraw: ({assets, receiver, owner, operator}: {assets: i128, receiver: string, owner: string, operator: string}, options?: MethodOptions) => Promise<AssembledTransaction<i128>>

  /**
   * Construct and simulate a max_redeem transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Returns the maximum shares `owner` can redeem (their balance capped by
   * the shares equivalent of free capital), or zero while direct exits are
   * globally disabled (paused, settlement pending, or queue active).
   */
  max_redeem: ({owner}: {owner: string}, options?: MethodOptions) => Promise<AssembledTransaction<i128>>

  /**
   * Construct and simulate a max_deposit transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   */
  max_deposit: ({address}: {address: string}, options?: MethodOptions) => Promise<AssembledTransaction<i128>>

  /**
   * Construct and simulate a query_asset transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Returns the address of the underlying asset token.
   */
  query_asset: (options?: MethodOptions) => Promise<AssembledTransaction<string>>

  /**
   * Construct and simulate a max_withdraw transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Returns the maximum assets `owner` can withdraw (their share balance
   * priced on managed assets, capped by free capital), or zero while direct
   * exits are globally disabled (paused, settlement pending, or queue active).
   */
  max_withdraw: ({owner}: {owner: string}, options?: MethodOptions) => Promise<AssembledTransaction<i128>>

  /**
   * Construct and simulate a preview_mint transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Previews the assets required to mint a given number of shares.
   */
  preview_mint: ({shares}: {shares: i128}, options?: MethodOptions) => Promise<AssembledTransaction<i128>>

  /**
   * Construct and simulate a total_assets transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Returns the vault's net backing assets — the internally tracked managed
   * assets, NOT the raw token balance (which includes owed-but-uncollected
   * withdrawal liabilities).
   */
  total_assets: (options?: MethodOptions) => Promise<AssembledTransaction<i128>>

  /**
   * Construct and simulate a preview_redeem transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Previews the assets that would be returned for redeeming a given number of shares.
   */
  preview_redeem: ({shares}: {shares: i128}, options?: MethodOptions) => Promise<AssembledTransaction<i128>>

  /**
   * Construct and simulate a preview_deposit transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Previews the shares that would be minted for a given deposit of assets.
   */
  preview_deposit: ({assets}: {assets: i128}, options?: MethodOptions) => Promise<AssembledTransaction<i128>>

  /**
   * Construct and simulate a preview_withdraw transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Previews the shares that would be burned to withdraw a given amount of assets.
   */
  preview_withdraw: ({assets}: {assets: i128}, options?: MethodOptions) => Promise<AssembledTransaction<i128>>

  /**
   * Construct and simulate a convert_to_assets transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Converts a number of shares to the equivalent amount of assets.
   */
  convert_to_assets: ({shares}: {shares: i128}, options?: MethodOptions) => Promise<AssembledTransaction<i128>>

  /**
   * Construct and simulate a convert_to_shares transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Converts an amount of assets to the equivalent number of shares.
   */
  convert_to_shares: ({assets}: {assets: i128}, options?: MethodOptions) => Promise<AssembledTransaction<i128>>

}
export class Client extends ContractClient {
  static async deploy<T = Client>(
        /** Constructor/Initialization Args for the contract's `__constructor` method */
        {owner, asset_token, oracle}: {owner: string, asset_token: string, oracle: string},
    /** Options for initializing a Client as well as for calling a method, with extras specific to deploying. */
    options: MethodOptions &
      Omit<ContractClientOptions, "contractId"> & {
        /** The hash of the Wasm blob, which must already be installed on-chain. */
        wasmHash: Buffer | string;
        /** Salt used to generate the contract's ID. Passed through to {@link Operation.createCustomContract}. Default: random. */
        salt?: Buffer | Uint8Array;
        /** The format used to decode `wasmHash`, if it's provided as a string. */
        format?: "hex" | "base64";
      }
  ): Promise<AssembledTransaction<T>> {
    return ContractClient.deploy({owner, asset_token, oracle}, options)
  }
  constructor(public readonly options: ContractClientOptions) {
    super(
      new ContractSpec([ "AAAAAAAAADRFeHRlbmQgaW5zdGFuY2UgVFRMLiBDYWxsZWQgYnkgY3JvbiBhcyBhIHNhZmV0eSBuZXQuAAAACmV4dGVuZF90dGwAAAAAAAAAAAAA",
        "AAAAAAAAAitSb3RhdGUgdGhlIE9yYWNsZUFnZ3JlZ2F0b3IgYWRkcmVzcyB0aGUgdmF1bHQgY29uc3VsdHMgdG8gYmxvY2sKZW50cnkvZXhpdCB3aGlsZSBhIGZsaWdodCBvdXRjb21lIGlzIHB1YmxpYyBidXQgbm90IHlldCBzZXR0bGVkLgpPd25lci1vbmx5LiBUaGUgaW5pdGlhbCBvcmFjbGUgaXMgd2lyZWQgYXQgY29uc3RydWN0aW9uLCBzbyB0aGlzCmV4aXN0cyBvbmx5IGZvciB0aGUgKHJlZGVwbG95LXRoZS1vcmFjbGUpIGNvbnRpbmdlbmN5OyBub3RlIHRoZQphc3ltbWV0cnkgd2l0aCBgc2V0X2NvbnRyb2xsZXJgLCB3aGljaCBpcyBkZWxpYmVyYXRlbHkgb25lLXRpbWUg4oCUCnRoZSBiYXJyaWVyIHRhcmdldCBtdXN0IHN0YXkgcm90YXRhYmxlIGJlY2F1c2UgdGhlIHZhdWx0IGNhbm5vdApmdW5jdGlvbiBzYWZlbHkgYWdhaW5zdCBhIGRlYWQgb3JhY2xlLCB3aGlsZSBhIGNvbnRyb2xsZXIgc3dhcCBoYXMKbm8gc3VjaCByZWNvdmVyeSBuZWVkLiBFbWl0cyBgb3JhY2xlX3NldGAgc28gbW9uaXRvcmluZyBjYXRjaGVzIGFueQpyZS13aXJlIG9mIHRoZSBiYXJyaWVyIHRhcmdldC4AAAAACnNldF9vcmFjbGUAAAAAAAEAAAAAAAAABm9yYWNsZQAAAAAAEwAAAAA=",
        "AAAAAAAAAoNJbml0aWFsaXplIHRoZSB2YXVsdC4KCiMgQXJndW1lbnRzCiogYG93bmVyYCAtIEFkZHJlc3MgZ3JhbnRlZCBvd25lciByaWdodHMgKHNldCB0aGUgY29udHJvbGxlciwgcGF1c2UsCnVwZ3JhZGUsIHJlY292ZXIgdW5jb2xsZWN0ZWQgYmFsYW5jZXMpLgoqIGBhc3NldF90b2tlbmAgLSBTQUMgYWRkcmVzcyBvZiB0aGUgdW5kZXJseWluZyBhc3NldCB0aGUgdmF1bHQKY3VzdG9kaWVzIGFuZCBkZW5vbWluYXRlcyBpdHMgc2hhcmVzIGFnYWluc3QuCiogYG9yYWNsZWAgLSBBZGRyZXNzIG9mIHRoZSBPcmFjbGVBZ2dyZWdhdG9yIHRoZSBzZXR0bGVtZW50IGJhcnJpZXIKY29uc3VsdHMuIFJlcXVpcmVkIGF0IGNvbnN0cnVjdGlvbiBzbyB0aGUgYmFycmllciBpcyBhY3RpdmUgZnJvbQpnZW5lc2lzOiBhIGRlcG9zaXQtYWNjZXB0aW5nIHZhdWx0IHdob3NlIGJhcnJpZXIgaXMgc2lsZW50bHkgdW53aXJlZAp3b3VsZCBsZXQgTFBzIGVudGVyL2V4aXQgYXQgc3RhbGUgc2hhcmUgcHJpY2VzIGR1cmluZwpvdXRjb21lLXB1YmxpYy1idXQtdW5zZXR0bGVkIHdpbmRvd3MuIChUaGUgZGVwbG95IG9yZGVyIHBsYWNlcyB0aGUKb3JhY2xlIGJlZm9yZSB0aGUgdmF1bHQsIHNvIHRoZSBhZGRyZXNzIGlzIGFsd2F5cyBhdmFpbGFibGUgaGVyZS4pAAAAAA1fX2NvbnN0cnVjdG9yAAAAAAAAAwAAAAAAAAAFb3duZXIAAAAAAAATAAAAAAAAAAthc3NldF90b2tlbgAAAAATAAAAAAAAAAZvcmFjbGUAAAAAABMAAAAA",
        "AAAAAAAAADhTZXQgdGhlIHZhdWx0IGNvbnRyb2xsZXIgYWRkcmVzcyAob25lLXRpbWUsIG93bmVyLW9ubHkpLgAAAA5zZXRfY29udHJvbGxlcgAAAAAAAQAAAAAAAAAKY29udHJvbGxlcgAAAAAAEwAAAAA=",
        "AAAAAAAAAvdTZXQgdGhlIG1pbmltdW0gYXNzZXQgdmFsdWUgYSBxdWV1ZWQgd2l0aGRyYXdhbCByZXF1ZXN0IG11c3QgY2FycnkgYXQKc3VibWlzc2lvbiB0aW1lIChvd25lci1vbmx5KS4gVGhlIHdpdGhkcmF3YWwgcXVldWUgaXMgYSBib3VuZGVkIHNoYXJlZApyZXNvdXJjZTogd2l0aG91dCBhIHZhbHVlIGZsb29yLCBvbmUgcGFydGljaXBhbnQgY2FuIHNwbGl0IHNoYXJlcwphY3Jvc3MgbWFueSBhZGRyZXNzZXMgYW5kIG9jY3VweSBldmVyeSBzbG90IHdpdGggbmVhci1kdXN0IHJlcXVlc3RzLApsb2NraW5nIGxhdGVyIHVuZGVyd3JpdGVycyBvdXQgb2YgdGhlIEZJRk8gZXhpdCBwYXRoLiBBIG1lYW5pbmdmdWwKbWluaW11bSBtYWtlcyBlYWNoIHNsb3QgY29zdCByZWFsIGVzY3Jvd2VkIGNhcGl0YWwuIFplcm8gZGlzYWJsZXMgdGhlCmZsb29yLiBDaG9vc2UgdGhlIHZhbHVlIGluIHVuZGVybHlpbmctYXNzZXQgdW5pdHMsIHdlbGwgYmVsb3cgdHlwaWNhbApMUCBwb3NpdGlvbiBzaXplcyBzbyBzbWFsbCB1bmRlcndyaXRlcnMgY2FuIHN0aWxsIHF1ZXVlIHRoZWlyIGV4aXRzLgoKVGhlIGVuZm9yY2VtZW50IGlzIGNsYW1wZWQgYXQgcmVxdWVzdCB0aW1lIHRvIGEgc21hbGwgZnJhY3Rpb24gb2YKbWFuYWdlZCBhc3NldHMgKHNlZSBgTUlOX1JFUVVFU1RfRkxPT1JfRElWSVNPUmApLCBzbyBubyBjb25maWd1cmVkCnZhbHVlIOKAlCBob3dldmVyIGxhcmdlIOKAlCBjYW4gbG9jayBvcmRpbmFyeSBwb3NpdGlvbnMgb3V0IG9mIHRoZSBxdWV1ZS4AAAAAGnNldF9taW5fd2l0aGRyYXdhbF9yZXF1ZXN0AAAAAAABAAAAAAAAAAptaW5fYXNzZXRzAAAAAAALAAAAAA==",
        "AAAAAAAAAD5Db2xsZWN0ICh0cmFuc2ZlciBvdXQpIHRoZSBjYWxsZXIncyBhY2NydWVkIGNsYWltYWJsZSBiYWxhbmNlLgAAAAAAB2NvbGxlY3QAAAAAAQAAAAAAAAAGY2FsbGVyAAAAAAATAAAAAA==",
        "AAAAAAAAALBDYW5jZWwgYSBxdWV1ZWQgd2l0aGRyYXdhbCBieSByZXF1ZXN0X2lkIChOT1QgcXVldWUgaW5kZXgpLgpJbmRpY2VzIHNoaWZ0IHdoZW4gcHJvY2Vzc193aXRoZHJhd2FsX3F1ZXVlIGRyYWlucyBlYXJsaWVyIGVudHJpZXM7CmEgc3RhYmxlIGlkIGF2b2lkcyBjYW5jZWxsaW5nIHRoZSB3cm9uZyByZXF1ZXN0LgAAABFjYW5jZWxfd2l0aGRyYXdhbAAAAAAAAAIAAAAAAAAABmNhbGxlcgAAAAAAEwAAAAAAAAAKcmVxdWVzdF9pZAAAAAAABgAAAAA=",
        "AAAAAAAAAL9TdWJtaXQgYSB3aXRoZHJhd2FsIHJlcXVlc3QuIFJldHVybnMgYSBtb25vdG9uaWMgcmVxdWVzdF9pZCB0aGF0IHRoZQpjYWxsZXIgY2FuIHVzZSB0byBjYW5jZWwgdGhlIHJlcXVlc3QgbGF0ZXIgKGltbXVuZSB0byBxdWV1ZSByZW9yZGVyCmNhdXNlZCBieSBpbnRlcnZlbmluZyBwcm9jZXNzX3dpdGhkcmF3YWxfcXVldWUgY2FsbHMpLgAAAAAScmVxdWVzdF93aXRoZHJhd2FsAAAAAAACAAAAAAAAAAZjYWxsZXIAAAAAABMAAAAAAAAABnNoYXJlcwAAAAAACwAAAAEAAAAG",
        "AAAAAAAAAv5Pd25lci1kcml2ZW4gbWFudWFsIHJlY292ZXJ5IG9mIGFuIGFyY2hpdmVkIGBDbGFpbWFibGVCYWxhbmNlYCBlbnRyeQoob3IgYW55IHVzZXIgb3dlZCB2YWx1ZSB0aGUgcHJvdG9jb2wgY291bGRuJ3QgZGVsaXZlciB2aWEKYHByb2Nlc3Nfd2l0aGRyYXdhbF9xdWV1ZWAgKyBgY29sbGVjdGApLiBVc2VzIGV2ZW50IGxvZ3MgYXMgdGhlCmF1ZGl0IHRyYWlsIGZvciB3aG8gaXMgb3dlZCB3aGF0LgoKLSBgUmVjb3ZlcnlNb2RlOjpSZWNyZWRpdGAg4oCUIFNFVCBgQ2xhaW1hYmxlQmFsYW5jZSh1c2VyKSA9IGFtb3VudGAsCmV4dGVuZCBUVEwsIGVtaXQgYHZhdWx0LnJlY292ZXJlZCguLiwgUmVjcmVkaXQpYC4gVXNlIGFmdGVyCmFyY2hpdmFsIHJlY292ZXJ5LgotIGBSZWNvdmVyeU1vZGU6OlRyYW5zZmVyYCDigJQgZGlyZWN0bHkgYGFzc2V0LnRyYW5zZmVyKHZhdWx0IOKGkiB1c2VyLAphbW91bnQpYC4gTm8gc3RvcmFnZSB3cml0ZS4gVXNlIHdoZW4gdXNlciB3YW50cyBmdW5kcyBpbiBoYW5kLgoKTGF5ZXJlZCBkZWZlbnNlOgoxLiBPbi13cml0ZSA2MC1kYXkgVFRMIGV4dGVuc2lvbiAoYHByb2Nlc3Nfd2l0aGRyYXdhbF9xdWV1ZWApLgoyLiBPZmYtY2hhaW4gVFRMIGNyb24gYEV4dGVuZEZvb3RwcmludFRUTE9wYCBjb3ZlcmluZwpgQ2xhaW1hYmxlQmFsYW5jZShhZGRyKWAga2V5cy4KMy4gVGhpcyBmdW5jdGlvbiAoYHJlY292ZXJfdW5jb2xsZWN0ZWRgKSDigJQgb3duZXIgbWFudWFsIGZhbGxiYWNrIGlmCmxheWVycyAxIGFuZCAyIGZhaWwuAAAAAAATcmVjb3Zlcl91bmNvbGxlY3RlZAAAAAADAAAAAAAAAAR1c2VyAAAAEwAAAAAAAAAGYW1vdW50AAAAAAALAAAAAAAAAARtb2RlAAAH0AAAAAxSZWNvdmVyeU1vZGUAAAAA",
        "AAAABQAAAAAAAAAAAAAACENyZWRpdGVkAAAAAgAAAAhzZW50aW5lbAAAAAhjcmVkaXRlZAAAAAMAAAAAAAAABHVzZXIAAAATAAAAAQAAAAAAAAAGYW1vdW50AAAAAAALAAAAAAAAAAAAAAALbmV3X2JhbGFuY2UAAAAACwAAAAAAAAAC",
        "AAAABQAAAAAAAAAAAAAACUNvbGxlY3RlZAAAAAAAAAIAAAAIc2VudGluZWwAAAAJY29sbGVjdGVkAAAAAAAAAgAAAAAAAAAEdXNlcgAAABMAAAABAAAAAAAAAAZhbW91bnQAAAAAAAsAAAAAAAAAAA==",
        "AAAABQAAAAAAAAAAAAAACU9yYWNsZVNldAAAAAAAAAIAAAAIc2VudGluZWwAAAAKb3JhY2xlX3NldAAAAAAAAQAAAAAAAAAGb3JhY2xlAAAAAAATAAAAAQAAAAA=",
        "AAAABQAAAAAAAAAAAAAACVJlY292ZXJlZAAAAAAAAAIAAAAIc2VudGluZWwAAAAJcmVjb3ZlcmVkAAAAAAAAAwAAAAAAAAAEdXNlcgAAABMAAAABAAAAAAAAAAZhbW91bnQAAAAAAAsAAAAAAAAAAAAAAARtb2RlAAAH0AAAAAxSZWNvdmVyeU1vZGUAAAAAAAAAAg==",
        "AAAABQAAAAAAAAAAAAAADUNvbnRyb2xsZXJTZXQAAAAAAAACAAAACHNlbnRpbmVsAAAADmNvbnRyb2xsZXJfc2V0AAAAAAABAAAAAAAAAApjb250cm9sbGVyAAAAAAATAAAAAQAAAAA=",
        "AAAABQAAAAAAAAAAAAAADlJlcXVlc3REcm9wcGVkAAAAAAACAAAACHNlbnRpbmVsAAAACndkX2Ryb3BwZWQAAAAAAAMAAAAAAAAABW93bmVyAAAAAAAAEwAAAAEAAAAAAAAACnJlcXVlc3RfaWQAAAAAAAYAAAAAAAAAAAAAAAZzaGFyZXMAAAAAAAsAAAAAAAAAAg==",
        "AAAABQAAAAAAAAAAAAAAElNoYXJlUHJpY2VTbmFwc2hvdAAAAAAAAgAAAAhzZW50aW5lbAAAAAhzbmFwc2hvdAAAAAIAAAAAAAAAA2RheQAAAAAGAAAAAQAAAAAAAAAFcHJpY2UAAAAAAAALAAAAAAAAAAI=",
        "AAAABQAAAAAAAAAAAAAAE1dpdGhkcmF3YWxDYW5jZWxsZWQAAAAAAgAAAAhzZW50aW5lbAAAAAl3ZF9jYW5jZWwAAAAAAAAEAAAAAAAAAAVvd25lcgAAAAAAABMAAAABAAAAAAAAAApyZXF1ZXN0X2lkAAAAAAAGAAAAAAAAAAAAAAAGc2hhcmVzAAAAAAALAAAAAAAAAAAAAAAJcXVldWVfbGVuAAAAAAAABAAAAAAAAAAC",
        "AAAABQAAAAAAAAAAAAAAE1dpdGhkcmF3YWxSZXF1ZXN0ZWQAAAAAAgAAAAhzZW50aW5lbAAAAAZ3ZF9yZXEAAAAAAAQAAAAAAAAABW93bmVyAAAAAAAAEwAAAAEAAAAAAAAACnJlcXVlc3RfaWQAAAAAAAYAAAAAAAAAAAAAAAZzaGFyZXMAAAAAAAsAAAAAAAAAAAAAAAlxdWV1ZV9sZW4AAAAAAAAEAAAAAAAAAAI=",
        "AAAABQAAAAAAAAAAAAAAF01pbldpdGhkcmF3YWxSZXF1ZXN0U2V0AAAAAAIAAAAIc2VudGluZWwAAAAObWluX3dkX3JlcV9zZXQAAAAAAAEAAAAAAAAACm1pbl9hc3NldHMAAAAAAAsAAAAAAAAAAA==",
        "AAAAAAAAAFVSZXR1cm5zIHRoZSBuYW1lIGZvciB0aGlzIHRva2VuLgoKIyBBcmd1bWVudHMKCiogYGVgIC0gQWNjZXNzIHRvIFNvcm9iYW4gZW52aXJvbm1lbnQuAAAAAAAABG5hbWUAAAAAAAAAAQAAABA=",
        "AAAAAAAAAAAAAAAFcGF1c2UAAAAAAAABAAAAAAAAAAZjYWxsZXIAAAAAABMAAAAA",
        "AAAAAAAAAHFSZXR1cm5zIHRydWUgaWYgdGhlIGNvbnRyYWN0IGlzIHBhdXNlZCwgYW5kIGZhbHNlIG90aGVyd2lzZS4KCiMgQXJndW1lbnRzCgoqIGBlYCAtIEFjY2VzcyB0byBTb3JvYmFuIGVudmlyb25tZW50LgAAAAAAAAZwYXVzZWQAAAAAAAAAAAABAAAAAQ==",
        "AAAAAAAAAFdSZXR1cm5zIHRoZSBzeW1ib2wgZm9yIHRoaXMgdG9rZW4uCgojIEFyZ3VtZW50cwoKKiBgZWAgLSBBY2Nlc3MgdG8gU29yb2JhbiBlbnZpcm9ubWVudC4AAAAABnN5bWJvbAAAAAAAAAAAAAEAAAAQ",
        "AAAAAAAAAyZTZXRzIHRoZSBhbW91bnQgb2YgdG9rZW5zIGEgYHNwZW5kZXJgIGlzIGFsbG93ZWQgdG8gc3BlbmQgb24gYmVoYWxmIG9mCmFuIGBvd25lcmAuIE92ZXJyaWRlcyBhbnkgZXhpc3RpbmcgYWxsb3dhbmNlIHNldCBiZXR3ZWVuIGBzcGVuZGVyYCBhbmQKYG93bmVyYC4KCiMgQXJndW1lbnRzCgoqIGBlYCAtIEFjY2VzcyB0byBTb3JvYmFuIGVudmlyb25tZW50LgoqIGBvd25lcmAgLSBUaGUgYWRkcmVzcyBob2xkaW5nIHRoZSB0b2tlbnMuCiogYHNwZW5kZXJgIC0gVGhlIGFkZHJlc3MgYXV0aG9yaXplZCB0byBzcGVuZCB0aGUgdG9rZW5zLgoqIGBhbW91bnRgIC0gVGhlIGFtb3VudCBvZiB0b2tlbnMgbWFkZSBhdmFpbGFibGUgdG8gYHNwZW5kZXJgLgoqIGBsaXZlX3VudGlsX2xlZGdlcmAgLSBUaGUgbGVkZ2VyIG51bWJlciBhdCB3aGljaCB0aGUgYWxsb3dhbmNlCmV4cGlyZXMuCgojIEVycm9ycwoKKiBbYEZ1bmdpYmxlVG9rZW5FcnJvcjo6SW52YWxpZExpdmVVbnRpbExlZGdlcmBdIC0gT2NjdXJzIHdoZW4KYXR0ZW1wdGluZyB0byBzZXQgYGxpdmVfdW50aWxfbGVkZ2VyYCB0aGF0IGlzIGxlc3MgdGhhbiB0aGUgY3VycmVudApsZWRnZXIgbnVtYmVyIGFuZCBncmVhdGVyIHRoYW4gYDBgLgoqIFtgRnVuZ2libGVUb2tlbkVycm9yOjpMZXNzVGhhblplcm9gXSAtIE9jY3VycyB3aGVuIGBhbW91bnQgPCAwYC4KCiMgRXZlbnRzCgoqIHRvcGljcyAtIGBbImFwcHJvdmUiLCBmcm9tOiBBZGRyZXNzLCBzcGVuZGVyOiBBZGRyZXNzXWAKKiBkYXRhIC0gYFthbW91bnQ6IGkxMjgsIGxpdmVfdW50aWxfbGVkZ2VyOiB1MzJdYAAAAAAAB2FwcHJvdmUAAAAABAAAAAAAAAAFb3duZXIAAAAAAAATAAAAAAAAAAdzcGVuZGVyAAAAABMAAAAAAAAABmFtb3VudAAAAAAACwAAAAAAAAARbGl2ZV91bnRpbF9sZWRnZXIAAAAAAAAEAAAAAA==",
        "AAAAAAAAAKpSZXR1cm5zIHRoZSBhbW91bnQgb2YgdG9rZW5zIGhlbGQgYnkgYGFjY291bnRgLgoKIyBBcmd1bWVudHMKCiogYGVgIC0gQWNjZXNzIHRvIHRoZSBTb3JvYmFuIGVudmlyb25tZW50LgoqIGBhY2NvdW50YCAtIFRoZSBhZGRyZXNzIGZvciB3aGljaCB0aGUgYmFsYW5jZSBpcyBiZWluZyBxdWVyaWVkLgAAAAAAB2JhbGFuY2UAAAAAAQAAAAAAAAAHYWNjb3VudAAAAAATAAAAAQAAAAs=",
        "AAAAAAAAAAAAAAAHdW5wYXVzZQAAAAABAAAAAAAAAAZjYWxsZXIAAAAAABMAAAAA",
        "AAAAAAAAAHxSZXR1cm5zIHRoZSBudW1iZXIgb2YgZGVjaW1hbHMgdXNlZCB0byByZXByZXNlbnQgYW1vdW50cyBvZiB0aGlzIHRva2VuLgoKIyBBcmd1bWVudHMKCiogYGVgIC0gQWNjZXNzIHRvIFNvcm9iYW4gZW52aXJvbm1lbnQuAAAACGRlY2ltYWxzAAAAAAAAAAEAAAAE",
        "AAAAAAAAAi5UcmFuc2ZlcnMgYGFtb3VudGAgb2YgdG9rZW5zIGZyb20gYGZyb21gIHRvIGB0b2AuCgojIEFyZ3VtZW50cwoKKiBgZWAgLSBBY2Nlc3MgdG8gU29yb2JhbiBlbnZpcm9ubWVudC4KKiBgZnJvbWAgLSBUaGUgYWRkcmVzcyBob2xkaW5nIHRoZSB0b2tlbnMuCiogYHRvYCAtIFRoZSBhZGRyZXNzIHJlY2VpdmluZyB0aGUgdHJhbnNmZXJyZWQgdG9rZW5zLgoqIGBhbW91bnRgIC0gVGhlIGFtb3VudCBvZiB0b2tlbnMgdG8gYmUgdHJhbnNmZXJyZWQuCgojIEVycm9ycwoKKiBbYEZ1bmdpYmxlVG9rZW5FcnJvcjo6SW5zdWZmaWNpZW50QmFsYW5jZWBdIC0gV2hlbiBhdHRlbXB0aW5nIHRvCnRyYW5zZmVyIG1vcmUgdG9rZW5zIHRoYW4gYGZyb21gIGN1cnJlbnQgYmFsYW5jZS4KKiBbYEZ1bmdpYmxlVG9rZW5FcnJvcjo6TGVzc1RoYW5aZXJvYF0gLSBXaGVuIGBhbW91bnQgPCAwYC4KCiMgRXZlbnRzCgoqIHRvcGljcyAtIGBbInRyYW5zZmVyIiwgZnJvbTogQWRkcmVzcywgdG86IEFkZHJlc3NdYAoqIGRhdGEgLSBgW3RvX211eGVkX2lkOiBPcHRpb248dTY0PiwgYW1vdW50OiBpMTI4XWAAAAAAAAh0cmFuc2ZlcgAAAAMAAAAAAAAABGZyb20AAAATAAAAAAAAAAJ0bwAAAAAAFAAAAAAAAAAGYW1vdW50AAAAAAALAAAAAA==",
        "AAAAAAAAAPBSZXR1cm5zIHRoZSBhbW91bnQgb2YgdG9rZW5zIGEgYHNwZW5kZXJgIGlzIGFsbG93ZWQgdG8gc3BlbmQgb24gYmVoYWxmCm9mIGFuIGBvd25lcmAuCgojIEFyZ3VtZW50cwoKKiBgZWAgLSBBY2Nlc3MgdG8gU29yb2JhbiBlbnZpcm9ubWVudC4KKiBgb3duZXJgIC0gVGhlIGFkZHJlc3MgaG9sZGluZyB0aGUgdG9rZW5zLgoqIGBzcGVuZGVyYCAtIFRoZSBhZGRyZXNzIGF1dGhvcml6ZWQgdG8gc3BlbmQgdGhlIHRva2Vucy4AAAAJYWxsb3dhbmNlAAAAAAAAAgAAAAAAAAAFb3duZXIAAAAAAAATAAAAAAAAAAdzcGVuZGVyAAAAABMAAAABAAAACw==",
        "AAAAAAAAAJBSZXR1cm5zIGBTb21lKEFkZHJlc3MpYCBpZiBvd25lcnNoaXAgaXMgc2V0LCBvciBgTm9uZWAgaWYgb3duZXJzaGlwIGhhcwpiZWVuIHJlbm91bmNlZC4KCiMgQXJndW1lbnRzCgoqIGBlYCAtIEFjY2VzcyB0byB0aGUgU29yb2JhbiBlbnZpcm9ubWVudC4AAAAJZ2V0X293bmVyAAAAAAAAAAAAAAEAAAPoAAAAEw==",
        "AAAAAAAAAGtSZXR1cm5zIHRoZSB0b3RhbCBhbW91bnQgb2YgdG9rZW5zIGluIGNpcmN1bGF0aW9uLgoKIyBBcmd1bWVudHMKCiogYGVgIC0gQWNjZXNzIHRvIHRoZSBTb3JvYmFuIGVudmlyb25tZW50LgAAAAAMdG90YWxfc3VwcGx5AAAAAAAAAAEAAAAL",
        "AAAAAAAAA2dUcmFuc2ZlcnMgYGFtb3VudGAgb2YgdG9rZW5zIGZyb20gYGZyb21gIHRvIGB0b2AgdXNpbmcgdGhlCmFsbG93YW5jZSBtZWNoYW5pc20uIGBhbW91bnRgIGlzIHRoZW4gZGVkdWN0ZWQgZnJvbSBgc3BlbmRlcmAKYWxsb3dhbmNlLgoKIyBBcmd1bWVudHMKCiogYGVgIC0gQWNjZXNzIHRvIFNvcm9iYW4gZW52aXJvbm1lbnQuCiogYHNwZW5kZXJgIC0gVGhlIGFkZHJlc3MgYXV0aG9yaXppbmcgdGhlIHRyYW5zZmVyLCBhbmQgaGF2aW5nIGl0cwphbGxvd2FuY2UgY29uc3VtZWQgZHVyaW5nIHRoZSB0cmFuc2Zlci4KKiBgZnJvbWAgLSBUaGUgYWRkcmVzcyBob2xkaW5nIHRoZSB0b2tlbnMgd2hpY2ggd2lsbCBiZSB0cmFuc2ZlcnJlZC4KKiBgdG9gIC0gVGhlIGFkZHJlc3MgcmVjZWl2aW5nIHRoZSB0cmFuc2ZlcnJlZCB0b2tlbnMuCiogYGFtb3VudGAgLSBUaGUgYW1vdW50IG9mIHRva2VucyB0byBiZSB0cmFuc2ZlcnJlZC4KCiMgRXJyb3JzCgoqIFtgRnVuZ2libGVUb2tlbkVycm9yOjpJbnN1ZmZpY2llbnRCYWxhbmNlYF0gLSBXaGVuIGF0dGVtcHRpbmcgdG8KdHJhbnNmZXIgbW9yZSB0b2tlbnMgdGhhbiBgZnJvbWAgY3VycmVudCBiYWxhbmNlLgoqIFtgRnVuZ2libGVUb2tlbkVycm9yOjpMZXNzVGhhblplcm9gXSAtIFdoZW4gYGFtb3VudCA8IDBgLgoqIFtgRnVuZ2libGVUb2tlbkVycm9yOjpJbnN1ZmZpY2llbnRBbGxvd2FuY2VgXSAtIFdoZW4gYXR0ZW1wdGluZyB0bwp0cmFuc2ZlciBtb3JlIHRva2VucyB0aGFuIGBzcGVuZGVyYCBjdXJyZW50IGFsbG93YW5jZS4KCiMgRXZlbnRzCgoqIHRvcGljcyAtIGBbInRyYW5zZmVyIiwgZnJvbTogQWRkcmVzcywgdG86IEFkZHJlc3NdYAoqIGRhdGEgLSBgW2Ftb3VudDogaTEyOF1gAAAAAA10cmFuc2Zlcl9mcm9tAAAAAAAABAAAAAAAAAAHc3BlbmRlcgAAAAATAAAAAAAAAARmcm9tAAAAEwAAAAAAAAACdG8AAAAAABMAAAAAAAAABmFtb3VudAAAAAAACwAAAAA=",
        "AAAAAAAAATBBY2NlcHRzIGEgcGVuZGluZyBvd25lcnNoaXAgdHJhbnNmZXIuCgojIEFyZ3VtZW50cwoKKiBgZWAgLSBBY2Nlc3MgdG8gdGhlIFNvcm9iYW4gZW52aXJvbm1lbnQuCgojIEVycm9ycwoKKiBbYGNyYXRlOjpyb2xlX3RyYW5zZmVyOjpSb2xlVHJhbnNmZXJFcnJvcjo6Tm9QZW5kaW5nVHJhbnNmZXJgXSAtIElmCnRoZXJlIGlzIG5vIHBlbmRpbmcgdHJhbnNmZXIgdG8gYWNjZXB0LgoKIyBFdmVudHMKCiogdG9waWNzIC0gYFsib3duZXJzaGlwX3RyYW5zZmVyX2NvbXBsZXRlZCJdYAoqIGRhdGEgLSBgW25ld19vd25lcjogQWRkcmVzc11gAAAAEGFjY2VwdF9vd25lcnNoaXAAAAAAAAAAAA==",
        "AAAAAAAAAYVSZW5vdW5jZXMgb3duZXJzaGlwIG9mIHRoZSBjb250cmFjdC4KClBlcm1hbmVudGx5IHJlbW92ZXMgdGhlIG93bmVyLCBkaXNhYmxpbmcgYWxsIGZ1bmN0aW9ucyBnYXRlZCBieQpgI1tvbmx5X293bmVyXWAuCgojIEFyZ3VtZW50cwoKKiBgZWAgLSBBY2Nlc3MgdG8gdGhlIFNvcm9iYW4gZW52aXJvbm1lbnQuCgojIEVycm9ycwoKKiBbYE93bmFibGVFcnJvcjo6VHJhbnNmZXJJblByb2dyZXNzYF0gLSBJZiB0aGVyZSBpcyBhIHBlbmRpbmcgb3duZXJzaGlwCnRyYW5zZmVyLgoqIFtgT3duYWJsZUVycm9yOjpPd25lck5vdFNldGBdIC0gSWYgdGhlIG93bmVyIGlzIG5vdCBzZXQuCgojIE5vdGVzCgoqIEF1dGhvcml6YXRpb24gZm9yIHRoZSBjdXJyZW50IG93bmVyIGlzIHJlcXVpcmVkLgAAAAAAABJyZW5vdW5jZV9vd25lcnNoaXAAAAAAAAAAAAAA",
        "AAAAAAAAA45Jbml0aWF0ZXMgYSAyLXN0ZXAgb3duZXJzaGlwIHRyYW5zZmVyIHRvIGEgbmV3IGFkZHJlc3MuCgpSZXF1aXJlcyBhdXRob3JpemF0aW9uIGZyb20gdGhlIGN1cnJlbnQgb3duZXIuIFRoZSBuZXcgb3duZXIgbXVzdCBsYXRlcgpjYWxsIGBhY2NlcHRfb3duZXJzaGlwKClgIHRvIGNvbXBsZXRlIHRoZSB0cmFuc2Zlci4KCiMgQXJndW1lbnRzCgoqIGBlYCAtIEFjY2VzcyB0byB0aGUgU29yb2JhbiBlbnZpcm9ubWVudC4KKiBgbmV3X293bmVyYCAtIFRoZSBwcm9wb3NlZCBuZXcgb3duZXIuCiogYGxpdmVfdW50aWxfbGVkZ2VyYCAtIExlZGdlciBudW1iZXIgdW50aWwgd2hpY2ggdGhlIG5ldyBvd25lciBjYW4KYWNjZXB0LiBBIHZhbHVlIG9mIGAwYCBjYW5jZWxzIGFueSBwZW5kaW5nIHRyYW5zZmVyLgoKIyBFcnJvcnMKCiogW2BPd25hYmxlRXJyb3I6Ok93bmVyTm90U2V0YF0gLSBJZiB0aGUgb3duZXIgaXMgbm90IHNldC4KKiBbYGNyYXRlOjpyb2xlX3RyYW5zZmVyOjpSb2xlVHJhbnNmZXJFcnJvcjo6Tm9QZW5kaW5nVHJhbnNmZXJgXSAtIElmCnRyeWluZyB0byBjYW5jZWwgYSB0cmFuc2ZlciB0aGF0IGRvZXNuJ3QgZXhpc3QuCiogW2BjcmF0ZTo6cm9sZV90cmFuc2Zlcjo6Um9sZVRyYW5zZmVyRXJyb3I6OkludmFsaWRMaXZlVW50aWxMZWRnZXJgXSAtCklmIHRoZSBzcGVjaWZpZWQgbGVkZ2VyIGlzIGluIHRoZSBwYXN0LgoqIFtgY3JhdGU6OnJvbGVfdHJhbnNmZXI6OlJvbGVUcmFuc2ZlckVycm9yOjpJbnZhbGlkUGVuZGluZ0FjY291bnRgXSAtCklmIHRoZSBzcGVjaWZpZWQgcGVuZGluZyBhY2NvdW50IGlzIG5vdCB0aGUgc2FtZSBhcyB0aGUgcHJvdmlkZWQgYG5ld2AKYWRkcmVzcy4KCiMgTm90ZXMKCiogQXV0aG9yaXphdGlvbiBmb3IgdGhlIGN1cnJlbnQgb3duZXIgaXMgcmVxdWlyZWQuAAAAAAASdHJhbnNmZXJfb3duZXJzaGlwAAAAAAACAAAAAAAAAAluZXdfb3duZXIAAAAAAAATAAAAAAAAABFsaXZlX3VudGlsX2xlZGdlcgAAAAAAAAQAAAAA",
        "AAAAAAAAAExDb250cm9sbGVyLW9ubHk6IHRyYW5zZmVyIGEgY2xhaW0gcGF5b3V0IGZyb20gbWFuYWdlZCBhc3NldHMgdG8gYSByZWNpcGllbnQuAAAAC3NlbmRfcGF5b3V0AAAAAAMAAAAAAAAACmNvbnRyb2xsZXIAAAAAABMAAAAAAAAAAnRvAAAAAAATAAAAAAAAAAZhbW91bnQAAAAAAAsAAAAA",
        "AAAAAAAAAD5Db250cm9sbGVyLW9ubHk6IHJlbGVhc2UgcHJldmlvdXNseSBsb2NrZWQgY29sbGF0ZXJhbCBjYXBpdGFsLgAAAAAAD2RlY3JlYXNlX2xvY2tlZAAAAAACAAAAAAAAAApjb250cm9sbGVyAAAAAAATAAAAAAAAAAZhbW91bnQAAAAAAAsAAAAA",
        "AAAAAAAAADdDb250cm9sbGVyLW9ubHk6IGxvY2sgYWRkaXRpb25hbCBjYXBpdGFsIGFzIGNvbGxhdGVyYWwuAAAAAA9pbmNyZWFzZV9sb2NrZWQAAAAAAgAAAAAAAAAKY29udHJvbGxlcgAAAAAAEwAAAAAAAAAGYW1vdW50AAAAAAALAAAAAA==",
        "AAAAAAAAAEJDb250cm9sbGVyLW9ubHk6IGNyZWRpdCByZWNlaXZlZCBwcmVtaXVtIGluY29tZSB0byBtYW5hZ2VkIGFzc2V0cy4AAAAAABVyZWNvcmRfcHJlbWl1bV9pbmNvbWUAAAAAAAACAAAAAAAAAApjb250cm9sbGVyAAAAAAATAAAAAAAAAAZhbW91bnQAAAAAAAsAAAAA",
        "AAAAAAAAAFJDb250cm9sbGVyLW9ubHk6IGRyYWluIHF1ZXVlZCB3aXRoZHJhd2FscyBpbnRvIGNsYWltYWJsZSBiYWxhbmNlcyAoYmF0Y2hlZCwgRklGTykuAAAAAAAYcHJvY2Vzc193aXRoZHJhd2FsX3F1ZXVlAAAAAQAAAAAAAAAKY29udHJvbGxlcgAAAAAAEwAAAAA=",
        "AAAAAAAAAKpSZXR1cm4gdGhlIGNvbmZpZ3VyZWQgb3JhY2xlIGFkZHJlc3MuIFdpcmVkIGF0IGNvbnN0cnVjdGlvbiwgc28gdGhpcwppcyBhbHdheXMgYFNvbWVgIG9uIGEgbGl2ZSB2YXVsdDsgdGhlIGBPcHRpb25gIHNoYXBlIGlzIGtlcHQgZm9yIEFCSQpzdGFiaWxpdHkgd2l0aCBleGlzdGluZyB0b29saW5nLgAAAAAACmdldF9vcmFjbGUAAAAAAAAAAAABAAAD6AAAABM=",
        "AAAAAAAAAClSZXR1cm4gdGhlIGNvbmZpZ3VyZWQgY29udHJvbGxlciBhZGRyZXNzLgAAAAAAAA5nZXRfY29udHJvbGxlcgAAAAAAAAAAAAEAAAAT",
        "AAAAAAAAAD9SZXR1cm4gZnJlZSAodW5sb2NrZWQpIGNhcGl0YWwgYXZhaWxhYmxlIGZvciB3aXRoZHJhd2FsL3BheW91dC4AAAAAEGdldF9mcmVlX2NhcGl0YWwAAAAAAAAAAQAAAAs=",
        "AAAAAAAAADxSZXR1cm4gdGhlIGFtb3VudCBvZiBjYXBpdGFsIGN1cnJlbnRseSBsb2NrZWQgYXMgY29sbGF0ZXJhbC4AAAASZ2V0X2xvY2tlZF9jYXBpdGFsAAAAAAAAAAAAAQAAAAs=",
        "AAAAAAAAADRSZXR1cm4gdGhlIGN1cnJlbnQgcGVuZGluZyB3aXRoZHJhd2FsIHJlcXVlc3QgcXVldWUuAAAAFGdldF93aXRoZHJhd2FsX3F1ZXVlAAAAAAAAAAEAAAPqAAAH0AAAABFXaXRoZHJhd2FsUmVxdWVzdAAAAA==",
        "AAAAAAAAAD5SZXR1cm4gdGhlIGNsYWltYWJsZSAoY29sbGVjdGlibGUpIGJhbGFuY2Ugb3dlZCB0byBhbiBhZGRyZXNzLgAAAAAAFWdldF9jbGFpbWFibGVfYmFsYW5jZQAAAAAAAAEAAAAAAAAAB2FkZHJlc3MAAAAAEwAAAAEAAAAL",
        "AAAAAAAAADZSZXR1cm4gdGhlIHRvdGFsIGFzc2V0cyB1bmRlciBtYW5hZ2VtZW50IGJ5IHRoZSB2YXVsdC4AAAAAABhnZXRfdG90YWxfbWFuYWdlZF9hc3NldHMAAAAAAAAAAQAAAAs=",
        "AAAAAAAAARJSZXR1cm4gdGhlIG51bWJlciBvZiBwZW5kaW5nIHdpdGhkcmF3YWwgcmVxdWVzdHMuIENoZWFwIHNhdHVyYXRpb24KZ2F1Z2UgZm9yIG9wZXJhdG9yczogdGhlIHF1ZXVlIGlzIGNhcHBlZCwgc28gb2NjdXBhbmN5IGFwcHJvYWNoaW5nIHRoZQpjYXAgbWVhbnMgbmV3IGV4aXQgcmVxdWVzdHMgYXJlIGFib3V0IHRvIGJlIHJlamVjdGVkIGFuZCB3YXJyYW50cwppbnRlcnZlbnRpb24gKG1vcmUgZnJlcXVlbnQgZHJhaW5pbmcsIG9yIHJhaXNpbmcgdGhlIHJlcXVlc3QgbWluaW11bSkuAAAAAAAYZ2V0X3dpdGhkcmF3YWxfcXVldWVfbGVuAAAAAAAAAAEAAAAE",
        "AAAAAAAAAGJSZXR1cm4gdGhlIG1pbmltdW0gYXNzZXQgdmFsdWUgYSBxdWV1ZWQgd2l0aGRyYXdhbCByZXF1ZXN0IG11c3QgY2FycnkKKDAgPSBubyBtaW5pbXVtIGNvbmZpZ3VyZWQpLgAAAAAAGmdldF9taW5fd2l0aGRyYXdhbF9yZXF1ZXN0AAAAAAAAAAAAAQAAAAs=",
        "AAAAAgAAAOxNb2RlIGZvciBgcmVjb3Zlcl91bmNvbGxlY3RlZGAg4oCUIG93bmVyLWRyaXZlbiBtYW51YWwgcmVjb3Zlcnkgb2YgYW4KYXJjaGl2ZWQgYENsYWltYWJsZUJhbGFuY2VgIGVudHJ5LiBDYXJyaWVkIG9uIHRoZSB3aXJlIHZpYSB0aGUKYHZhdWx0LnJlY292ZXJlZGAgZXZlbnQgc28gdGhlIG9mZi1jaGFpbiBpbmRleGVyIGNhbiB1cGRhdGUgaXRzCmBjbGFpbWFibGVfYmFsYW5jZXNgIHRhYmxlIGFjY29yZGluZ2x5LgAAAAAAAAAMUmVjb3ZlcnlNb2RlAAAAAgAAAAAAAADFUmUtY3JlZGl0IGBDbGFpbWFibGVCYWxhbmNlKHVzZXIpID0gYW1vdW50YC4gU2V0cyAobm90IGFkZHMpIHNvIHRoZQpvd25lciBwcm92aWRlcyB0aGUgZnVsbCBvd2VkIGFtb3VudCByZWNvbnN0cnVjdGVkIGZyb20gZXZlbnQgbG9ncy4KRnV0dXJlIGBwcm9jZXNzX3dpdGhkcmF3YWxfcXVldWVgIGNyZWRpdHMgQUREIG9uIHRvcCBub3JtYWxseS4AAAAAAAAIUmVjcmVkaXQAAAAAAAAAflRyYW5zZmVyIGFzc2V0IGRpcmVjdGx5IGZyb20gdmF1bHQgdG8gdXNlci4gTm8gYENsYWltYWJsZUJhbGFuY2VgCnN0b3JhZ2Ugd3JpdGUuIEluZGV4ZXIgREVMRVRFcyB0aGUgYWRkcmVzcyBmcm9tIGl0cyB0cmFja2VyLgAAAAAACFRyYW5zZmVy",
        "AAAAAQAAAAAAAAAAAAAAEVdpdGhkcmF3YWxSZXF1ZXN0AAAAAAAAAwAAAAAAAAAFb3duZXIAAAAAAAATAAAAAAAAAApyZXF1ZXN0X2lkAAAAAAAGAAAAAAAAAAZzaGFyZXMAAAAAAAs=",
        "AAAAAAAAAG9Pd25lci1nYXRlZCBXYXNtIHVwZ3JhZGUuIERlbGVnYXRlcyB0byB0aGUgc2hhcmVkIGltcGxlbWVudGF0aW9uLCB3aGljaAphbHNvIGJ1bXBzIHRoZSBzdG9yZWQgb24tY2hhaW4gdmVyc2lvbi4AAAAAB3VwZ3JhZGUAAAAAAQAAAAAAAAAJd2FzbV9oYXNoAAAAAAAD7gAAACAAAAAA",
        "AAAAAAAAACJDdXJyZW50IG9uLWNoYWluIGNvbnRyYWN0IHZlcnNpb24uAAAAAAAHdmVyc2lvbgAAAAAAAAAAAQAAAAQ=",
        "AAAAAAAABABSZWNvcmQgdG9kYXkncyBzaGFyZSBwcmljZSBpbnRvIHRlbXBvcmFyeSBzdG9yYWdlIGFuZCBlbWl0IGl0LgoKQWNjZXNzIGNvbnRyb2w6ICoqaW50ZW50aW9uYWxseSBwZXJtaXNzaW9ubGVzcyoqIOKAlCBhbnkgYWRkcmVzcyBtYXkgY2FsbAp0aGlzLCBieSBkZXNpZ24uIEl0IGlzIGEga2VlcGVyL2Nyb24gZW50cnlwb2ludCBtZWFudCB0byBiZSB0cmlnZ2VyZWQKYnkgdGhlIG9mZi1jaGFpbiBzY2hlZHVsZXIsIGJ1dCBhbnlvbmUgaXMgYWxsb3dlZCB0byBrZWVwIHRoZSBkYWlseSBwcmljZQpzZXJpZXMgYWxpdmUuIFRoaXMgaXMgc2FmZSBiZWNhdXNlIHRoZSBmdW5jdGlvbjoKLSBtb3ZlcyBubyBmdW5kcyBhbmQgbXV0YXRlcyBubyBjYXBpdGFsL2xvY2tlZCBhY2NvdW50aW5nIOKAlCBpdCBvbmx5CndyaXRlcyBhIGRlcml2ZWQgcHJpY2UgaW50byB0ZW1wb3Jhcnkgc3RvcmFnZSBhbmQgZW1pdHMgYW4gZXZlbnQ7Ci0gY2Fubm90IGJlIG1hbmlwdWxhdGVkIGJ5IHRoZSBjYWxsZXIg4oCUIHRoZSBwcmljZSBpcyBjb21wdXRlZCBzb2xlbHkKZnJvbSBvbi1jaGFpbiBzdGF0ZSwgc28gYSBjYWxsZXIgY29udHJvbHMgb25seSAqd2hlbiogaXQgcnVucywgbmV2ZXIKdGhlIHJlY29yZGVkIHZhbHVlOwotIGlzIGlkZW1wb3RlbnQgYW5kIHJhdGUtbGltaXRlZCDigJQgaXQgbm8tb3BzIGlmIGEgc25hcHNob3QgYWxyZWFkeQpleGlzdHMgZm9yIHRoZSBjdXJyZW50IGRheSAoc2VlIHRoZSBndWFyZCBiZWxvdyksIHNvIHJlcGVhdGVkIG9yCmFkdmVyc2FyaWFsIGNhbGxzIGNvc3QgdGhlIGNhbGxlciBnYXMgYnV0IGNoYW5nZSBub3RoaW5nLgoKT25lIHJlc2lkdWFsIGNhbGxlciBkZWdyZWUgb2YgZnJlZWRvbTogV0hJQ0ggbW9tZW50IHdpdGhpbiB0aGUgZGF5IGlzCnJlY29yZGVkLiBBbiBlYXJseSBjYWxsZXIgY2FuIHBpbiB0aGUgZGF5J3MgcHJpY2UgYmVmb3JlIHRoYXQgZGF5J3MKc2V0dGxlbWVudHMgbGFuZCAodGhlIHBlbmRpbmctb3V0Y29tZXMgZ3VhcmQgYmVsb3cgb25seSBkZWZlcnMgd2hpAAAACHNuYXBzaG90AAAAAAAAAAA=",
        "AAAAAAAAAEhSZXR1cm4gdGhlIHJlY29yZGVkIHNoYXJlIHByaWNlIGZvciB0aGUgZ2l2ZW4gZGF5ICgwIGlmIGV4cGlyZWQvYWJzZW50KS4AAAASZ2V0X3NuYXBzaG90X3ByaWNlAAAAAAABAAAAAAAAAANkYXkAAAAABgAAAAEAAAAL",
        "AAAAAAAAAFNNaW50cyBgc2hhcmVzYCB0byBgcmVjZWl2ZXJgLCBwdWxsaW5nIHRoZSByZXF1aXJlZCBhc3NldHMgcHJpY2VkIG9uIG1hbmFnZWQgYXNzZXRzLgAAAAAEbWludAAAAAQAAAAAAAAABnNoYXJlcwAAAAAACwAAAAAAAAAIcmVjZWl2ZXIAAAATAAAAAAAAAARmcm9tAAAAEwAAAAAAAAAIb3BlcmF0b3IAAAATAAAAAQAAAAs=",
        "AAAAAAAAAHZSZWRlZW1zIGBzaGFyZXNgIGZvciBhc3NldHMgdG8gYHJlY2VpdmVyYCwgYmxvY2tlZCB3aGlsZSB0aGUgd2l0aGRyYXdhbCBxdWV1ZSBpcyBhY3RpdmUgb3IgaWYgaXQgZXhjZWVkcyBmcmVlIGNhcGl0YWwuAAAAAAAGcmVkZWVtAAAAAAAEAAAAAAAAAAZzaGFyZXMAAAAAAAsAAAAAAAAACHJlY2VpdmVyAAAAEwAAAAAAAAAFb3duZXIAAAAAAAATAAAAAAAAAAhvcGVyYXRvcgAAABMAAAABAAAACw==",
        "AAAAAAAAAEpEZXBvc2l0cyBgYXNzZXRzYCBmb3IgYHJlY2VpdmVyYCwgbWludGluZyBzaGFyZXMgcHJpY2VkIG9uIG1hbmFnZWQgYXNzZXRzLgAAAAAAB2RlcG9zaXQAAAAABAAAAAAAAAAGYXNzZXRzAAAAAAALAAAAAAAAAAhyZWNlaXZlcgAAABMAAAAAAAAABGZyb20AAAATAAAAAAAAAAhvcGVyYXRvcgAAABMAAAABAAAACw==",
        "AAAAAAAAAH9SZXR1cm5zIHRoZSBtYXhpbXVtIHNoYXJlcyBtaW50YWJsZSBmb3IgYGFkZHJlc3NgLCBvciB6ZXJvIHdoaWxlCmRlcG9zaXRzIGFyZSBnbG9iYWxseSBkaXNhYmxlZCAocGF1c2VkIG9yIHNldHRsZW1lbnQgcGVuZGluZykuAAAAAAhtYXhfbWludAAAAAEAAAAAAAAAB2FkZHJlc3MAAAAAEwAAAAEAAAAL",
        "AAAAAAAAAG1XaXRoZHJhd3MgYGFzc2V0c2AgdG8gYHJlY2VpdmVyYCwgYmxvY2tlZCB3aGlsZSB0aGUgd2l0aGRyYXdhbCBxdWV1ZSBpcyBhY3RpdmUgb3IgaWYgaXQgZXhjZWVkcyBmcmVlIGNhcGl0YWwuAAAAAAAACHdpdGhkcmF3AAAABAAAAAAAAAAGYXNzZXRzAAAAAAALAAAAAAAAAAhyZWNlaXZlcgAAABMAAAAAAAAABW93bmVyAAAAAAAAEwAAAAAAAAAIb3BlcmF0b3IAAAATAAAAAQAAAAs=",
        "AAAAAAAAAM5SZXR1cm5zIHRoZSBtYXhpbXVtIHNoYXJlcyBgb3duZXJgIGNhbiByZWRlZW0gKHRoZWlyIGJhbGFuY2UgY2FwcGVkIGJ5CnRoZSBzaGFyZXMgZXF1aXZhbGVudCBvZiBmcmVlIGNhcGl0YWwpLCBvciB6ZXJvIHdoaWxlIGRpcmVjdCBleGl0cyBhcmUKZ2xvYmFsbHkgZGlzYWJsZWQgKHBhdXNlZCwgc2V0dGxlbWVudCBwZW5kaW5nLCBvciBxdWV1ZSBhY3RpdmUpLgAAAAAACm1heF9yZWRlZW0AAAAAAAEAAAAAAAAABW93bmVyAAAAAAAAEwAAAAEAAAAL",
        "AAAAAAAAAAAAAAALbWF4X2RlcG9zaXQAAAAAAQAAAAAAAAAHYWRkcmVzcwAAAAATAAAAAQAAAAs=",
        "AAAAAAAAADJSZXR1cm5zIHRoZSBhZGRyZXNzIG9mIHRoZSB1bmRlcmx5aW5nIGFzc2V0IHRva2VuLgAAAAAAC3F1ZXJ5X2Fzc2V0AAAAAAAAAAABAAAAEw==",
        "AAAAAAAAANdSZXR1cm5zIHRoZSBtYXhpbXVtIGFzc2V0cyBgb3duZXJgIGNhbiB3aXRoZHJhdyAodGhlaXIgc2hhcmUgYmFsYW5jZQpwcmljZWQgb24gbWFuYWdlZCBhc3NldHMsIGNhcHBlZCBieSBmcmVlIGNhcGl0YWwpLCBvciB6ZXJvIHdoaWxlIGRpcmVjdApleGl0cyBhcmUgZ2xvYmFsbHkgZGlzYWJsZWQgKHBhdXNlZCwgc2V0dGxlbWVudCBwZW5kaW5nLCBvciBxdWV1ZSBhY3RpdmUpLgAAAAAMbWF4X3dpdGhkcmF3AAAAAQAAAAAAAAAFb3duZXIAAAAAAAATAAAAAQAAAAs=",
        "AAAAAAAAAD5QcmV2aWV3cyB0aGUgYXNzZXRzIHJlcXVpcmVkIHRvIG1pbnQgYSBnaXZlbiBudW1iZXIgb2Ygc2hhcmVzLgAAAAAADHByZXZpZXdfbWludAAAAAEAAAAAAAAABnNoYXJlcwAAAAAACwAAAAEAAAAL",
        "AAAAAAAAAKlSZXR1cm5zIHRoZSB2YXVsdCdzIG5ldCBiYWNraW5nIGFzc2V0cyDigJQgdGhlIGludGVybmFsbHkgdHJhY2tlZCBtYW5hZ2VkCmFzc2V0cywgTk9UIHRoZSByYXcgdG9rZW4gYmFsYW5jZSAod2hpY2ggaW5jbHVkZXMgb3dlZC1idXQtdW5jb2xsZWN0ZWQKd2l0aGRyYXdhbCBsaWFiaWxpdGllcykuAAAAAAAADHRvdGFsX2Fzc2V0cwAAAAAAAAABAAAACw==",
        "AAAAAAAAAFJQcmV2aWV3cyB0aGUgYXNzZXRzIHRoYXQgd291bGQgYmUgcmV0dXJuZWQgZm9yIHJlZGVlbWluZyBhIGdpdmVuIG51bWJlciBvZiBzaGFyZXMuAAAAAAAOcHJldmlld19yZWRlZW0AAAAAAAEAAAAAAAAABnNoYXJlcwAAAAAACwAAAAEAAAAL",
        "AAAAAAAAAEdQcmV2aWV3cyB0aGUgc2hhcmVzIHRoYXQgd291bGQgYmUgbWludGVkIGZvciBhIGdpdmVuIGRlcG9zaXQgb2YgYXNzZXRzLgAAAAAPcHJldmlld19kZXBvc2l0AAAAAAEAAAAAAAAABmFzc2V0cwAAAAAACwAAAAEAAAAL",
        "AAAAAAAAAE5QcmV2aWV3cyB0aGUgc2hhcmVzIHRoYXQgd291bGQgYmUgYnVybmVkIHRvIHdpdGhkcmF3IGEgZ2l2ZW4gYW1vdW50IG9mIGFzc2V0cy4AAAAAABBwcmV2aWV3X3dpdGhkcmF3AAAAAQAAAAAAAAAGYXNzZXRzAAAAAAALAAAAAQAAAAs=",
        "AAAAAAAAAD9Db252ZXJ0cyBhIG51bWJlciBvZiBzaGFyZXMgdG8gdGhlIGVxdWl2YWxlbnQgYW1vdW50IG9mIGFzc2V0cy4AAAAAEWNvbnZlcnRfdG9fYXNzZXRzAAAAAAAAAQAAAAAAAAAGc2hhcmVzAAAAAAALAAAAAQAAAAs=",
        "AAAAAAAAAEBDb252ZXJ0cyBhbiBhbW91bnQgb2YgYXNzZXRzIHRvIHRoZSBlcXVpdmFsZW50IG51bWJlciBvZiBzaGFyZXMuAAAAEWNvbnZlcnRfdG9fc2hhcmVzAAAAAAAAAQAAAAAAAAAGYXNzZXRzAAAAAAALAAAAAQAAAAs=",
        "AAAABQAAATFBdWRpdC10cmFpbCBldmVudCBlbWl0dGVkIG9uIGV2ZXJ5IGNvbnRyYWN0IHVwZ3JhZGUuIERlZmluZWQgaGVyZSAocmF0aGVyCnRoYW4gcGVyLWNvbnRyYWN0KSBzbyBldmVyeSBjb250cmFjdCdzIHVwZ3JhZGUgbGVhdmVzIGFuIGlkZW50aWNhbCB0cmFpbC4KVGhlIGVtaXR0aW5nIGNvbnRyYWN0IGFkZHJlc3MgcmlkZXMgdGhlIGV2ZW50IGVudmVsb3BlLCBzbyBvZmYtY2hhaW4KaW5kZXhlcnMga25vdyAqd2hpY2gqIGNvbnRyYWN0IHdhcyB1cGdyYWRlZDsgYHdhc21faGFzaGAgYW5kIGB2ZXJzaW9uYApyZWNvcmQgKnRvIHdoYXQqLgAAAAAAAAAAAAAQQ29udHJhY3RVcGdyYWRlZAAAAAIAAAAIc2VudGluZWwAAAAHdXBncmFkZQAAAAACAAAAAAAAAAl3YXNtX2hhc2gAAAAAAAPuAAAAIAAAAAEAAAAAAAAAB3ZlcnNpb24AAAAABAAAAAAAAAAA",
        "AAAABQAAADZFdmVudCBlbWl0dGVkIHdoZW4gYW4gb3duZXJzaGlwIHRyYW5zZmVyIGlzIGluaXRpYXRlZC4AAAAAAAAAAAART3duZXJzaGlwVHJhbnNmZXIAAAAAAAABAAAAEm93bmVyc2hpcF90cmFuc2ZlcgAAAAAAAwAAAAAAAAAJb2xkX293bmVyAAAAAAAAEwAAAAAAAAAAAAAACW5ld19vd25lcgAAAAAAABMAAAAAAAAAAAAAABFsaXZlX3VudGlsX2xlZGdlcgAAAAAAAAQAAAAAAAAAAg==",
        "AAAABQAAACpFdmVudCBlbWl0dGVkIHdoZW4gb3duZXJzaGlwIGlzIHJlbm91bmNlZC4AAAAAAAAAAAAST3duZXJzaGlwUmVub3VuY2VkAAAAAAABAAAAE293bmVyc2hpcF9yZW5vdW5jZWQAAAAAAQAAAAAAAAAJb2xkX293bmVyAAAAAAAAEwAAAAAAAAAC",
        "AAAABQAAADZFdmVudCBlbWl0dGVkIHdoZW4gYW4gb3duZXJzaGlwIHRyYW5zZmVyIGlzIGNvbXBsZXRlZC4AAAAAAAAAAAAaT3duZXJzaGlwVHJhbnNmZXJDb21wbGV0ZWQAAAAAAAEAAAAcb3duZXJzaGlwX3RyYW5zZmVyX2NvbXBsZXRlZAAAAAEAAAAAAAAACW5ld19vd25lcgAAAAAAABMAAAAAAAAAAg==",
        "AAAABQAAACpFdmVudCBlbWl0dGVkIHdoZW4gdGhlIGNvbnRyYWN0IGlzIHBhdXNlZC4AAAAAAAAAAAAGUGF1c2VkAAAAAAABAAAABnBhdXNlZAAAAAAAAAAAAAI=",
        "AAAABQAAACxFdmVudCBlbWl0dGVkIHdoZW4gdGhlIGNvbnRyYWN0IGlzIHVucGF1c2VkLgAAAAAAAAAIVW5wYXVzZWQAAAABAAAACHVucGF1c2VkAAAAAAAAAAI=",
        "AAAABQAAAEJFdmVudCBlbWl0dGVkIHdoZW4gdW5kZXJseWluZyBhc3NldHMgYXJlIGRlcG9zaXRlZCBpbnRvIHRoZSB2YXVsdC4AAAAAAAAAAAAHRGVwb3NpdAAAAAABAAAAB2RlcG9zaXQAAAAABQAAAAAAAAAIb3BlcmF0b3IAAAATAAAAAQAAAAAAAAAEZnJvbQAAABMAAAABAAAAAAAAAAhyZWNlaXZlcgAAABMAAAABAAAAAAAAAAZhc3NldHMAAAAAAAsAAAAAAAAAAAAAAAZzaGFyZXMAAAAAAAsAAAAAAAAAAg==",
        "AAAABQAAAENFdmVudCBlbWl0dGVkIHdoZW4gc2hhcmVzIGFyZSBleGNoYW5nZWQgYmFjayBmb3IgdW5kZXJseWluZyBhc3NldHMuAAAAAAAAAAAIV2l0aGRyYXcAAAABAAAACHdpdGhkcmF3AAAABQAAAAAAAAAIb3BlcmF0b3IAAAATAAAAAQAAAAAAAAAIcmVjZWl2ZXIAAAATAAAAAQAAAAAAAAAFb3duZXIAAAAAAAATAAAAAQAAAAAAAAAGYXNzZXRzAAAAAAALAAAAAAAAAAAAAAAGc2hhcmVzAAAAAAALAAAAAAAAAAI=",
        "AAAABQAAACxFdmVudCBlbWl0dGVkIHdoZW4gYW4gYWxsb3dhbmNlIGlzIGFwcHJvdmVkLgAAAAAAAAAHQXBwcm92ZQAAAAABAAAAB2FwcHJvdmUAAAAABAAAAAAAAAAFb3duZXIAAAAAAAATAAAAAQAAAAAAAAAHc3BlbmRlcgAAAAATAAAAAQAAAAAAAAAGYW1vdW50AAAAAAALAAAAAAAAAAAAAAARbGl2ZV91bnRpbF9sZWRnZXIAAAAAAAAEAAAAAAAAAAI=",
        "AAAABQAAASFFdmVudCBlbWl0dGVkIHdoZW4gdG9rZW5zIGFyZSB0cmFuc2ZlcnJlZCBiZXR3ZWVuIGFkZHJlc3NlcyB3aXRob3V0IGEKbXV4ZWQgZGVzdGluYXRpb24uCgpQZXIgU0VQLTQxLCB0aGUgZXZlbnQgZGF0YSBpcyBhIGJhcmUgYGkxMjhgIHdoZW4gbm8gbXV4ZWQgYWRkcmVzcyBpcwppbnZvbHZlZC4gVGhlIGBkYXRhX2Zvcm1hdCA9ICJzaW5nbGUtdmFsdWUiYCBhdHRyaWJ1dGUgZW5zdXJlcyB0aGUKYGFtb3VudGAgZmllbGQgaXMgc2VyaWFsaXplZCBhcyBhIGJhcmUgdmFsdWUgcmF0aGVyIHRoYW4gYSBtYXAuAAAAAAAAAAAAAAhUcmFuc2ZlcgAAAAEAAAAIdHJhbnNmZXIAAAADAAAAAAAAAARmcm9tAAAAEwAAAAEAAAAAAAAAAnRvAAAAAAATAAAAAQAAAAAAAAAGYW1vdW50AAAAAAALAAAAAAAAAAA=",
        "AAAABQAAAZdFdmVudCBlbWl0dGVkIHdoZW4gdG9rZW5zIGFyZSB0cmFuc2ZlcnJlZCB0byBhIG11eGVkIGFkZHJlc3MuCgpQZXIgU0VQLTQxLCB3aGVuIHRoZSBkZXN0aW5hdGlvbiBpcyBhIFtgTXV4ZWRBZGRyZXNzYF0gdGhlIGV2ZW50IGRhdGEKY2FycmllcyBib3RoIHRoZSBhbW91bnQgYW5kIHRoZSBtdXhlZCBpZGVudGlmaWVyIHNvIHRoYXQgb2ZmLWNoYWluCmNvbnN1bWVycyBjYW4gYXR0cmlidXRlIHRoZSB0cmFuc2ZlciB0byB0aGUgY29ycmVjdCBzdWItYWNjb3VudC4KClVzZXMgYHRvcGljcyA9IFsidHJhbnNmZXIiXWAgc28gdGhhdCBib3RoIFtgVHJhbnNmZXJgXSBhbmQKW2BNdXhlZFRyYW5zZmVyYF0gc2hhcmUgdGhlIHNhbWUgYCJ0cmFuc2ZlciJgIGV2ZW50IHN5bWJvbCwgYXMgcmVxdWlyZWQKYnkgU0VQLTQxLgAAAAAAAAAADU11eGVkVHJhbnNmZXIAAAAAAAABAAAACHRyYW5zZmVyAAAABAAAAAAAAAAEZnJvbQAAABMAAAABAAAAAAAAAAJ0bwAAAAAAEwAAAAEAAAAAAAAAC3RvX211eGVkX2lkAAAAA+gAAAAGAAAAAAAAAAAAAAAGYW1vdW50AAAAAAALAAAAAAAAAAI=" ]),
      options
    )
  }
  public readonly fromJSON = {
    extend_ttl: this.txFromJSON<null>,
        set_oracle: this.txFromJSON<null>,
        set_controller: this.txFromJSON<null>,
        set_min_withdrawal_request: this.txFromJSON<null>,
        collect: this.txFromJSON<null>,
        cancel_withdrawal: this.txFromJSON<null>,
        request_withdrawal: this.txFromJSON<u64>,
        recover_uncollected: this.txFromJSON<null>,
        name: this.txFromJSON<string>,
        pause: this.txFromJSON<null>,
        paused: this.txFromJSON<boolean>,
        symbol: this.txFromJSON<string>,
        approve: this.txFromJSON<null>,
        balance: this.txFromJSON<i128>,
        unpause: this.txFromJSON<null>,
        decimals: this.txFromJSON<u32>,
        transfer: this.txFromJSON<null>,
        allowance: this.txFromJSON<i128>,
        get_owner: this.txFromJSON<Option<string>>,
        total_supply: this.txFromJSON<i128>,
        transfer_from: this.txFromJSON<null>,
        accept_ownership: this.txFromJSON<null>,
        renounce_ownership: this.txFromJSON<null>,
        transfer_ownership: this.txFromJSON<null>,
        send_payout: this.txFromJSON<null>,
        decrease_locked: this.txFromJSON<null>,
        increase_locked: this.txFromJSON<null>,
        record_premium_income: this.txFromJSON<null>,
        process_withdrawal_queue: this.txFromJSON<null>,
        get_oracle: this.txFromJSON<Option<string>>,
        get_controller: this.txFromJSON<string>,
        get_free_capital: this.txFromJSON<i128>,
        get_locked_capital: this.txFromJSON<i128>,
        get_withdrawal_queue: this.txFromJSON<Array<WithdrawalRequest>>,
        get_claimable_balance: this.txFromJSON<i128>,
        get_total_managed_assets: this.txFromJSON<i128>,
        get_withdrawal_queue_len: this.txFromJSON<u32>,
        get_min_withdrawal_request: this.txFromJSON<i128>,
        upgrade: this.txFromJSON<null>,
        version: this.txFromJSON<u32>,
        snapshot: this.txFromJSON<null>,
        get_snapshot_price: this.txFromJSON<i128>,
        mint: this.txFromJSON<i128>,
        redeem: this.txFromJSON<i128>,
        deposit: this.txFromJSON<i128>,
        max_mint: this.txFromJSON<i128>,
        withdraw: this.txFromJSON<i128>,
        max_redeem: this.txFromJSON<i128>,
        max_deposit: this.txFromJSON<i128>,
        query_asset: this.txFromJSON<string>,
        max_withdraw: this.txFromJSON<i128>,
        preview_mint: this.txFromJSON<i128>,
        total_assets: this.txFromJSON<i128>,
        preview_redeem: this.txFromJSON<i128>,
        preview_deposit: this.txFromJSON<i128>,
        preview_withdraw: this.txFromJSON<i128>,
        convert_to_assets: this.txFromJSON<i128>,
        convert_to_shares: this.txFromJSON<i128>
  }
}