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




export const Errors = {
  701: {message:"ControllerAlreadySet"},
  702: {message:"NotController"},
  703: {message:"AmountMustBePositive"},
  704: {message:"WouldExceedTotalManagedAssets"},
  705: {message:"WouldGoNegative"},
  706: {message:"PremiumNotReceived"},
  707: {message:"InsufficientManagedAssets"},
  708: {message:"SharesMustBePositive"},
  709: {message:"SharesRedeemToZeroAssets"},
  710: {message:"NotYourRequest"},
  711: {message:"NothingToCollect"},
  712: {message:"RecreditWouldUnderpay"},
  713: {message:"AmountExceedsClaimableBalance"},
  716: {message:"WithdrawalQueueFull"},
  717: {message:"TooManyActiveRequests"},
  719: {message:"RequestBelowMinimum"},
  720: {message:"AssetsConvertToZeroShares"},
  721: {message:"RequestNotFound"},
  722: {message:"AmountMustBeNonNegative"},
  723: {message:"RecreditExceedsRecoverableSurplus"},
  724: {message:"SolvencyRatioOutOfBounds"},
  725: {message:"OraclePendingOutcomesUnreconciled"},
  726: {message:"ForcedRotationRequiresPause"},
  727: {message:"DirectEntryDisabled"},
  728: {message:"DirectExitDisabled"},
  729: {message:"DepositQueueFull"},
  730: {message:"OracleActiveExposureUnreconciled"}
}

















/**
 * Mode for `recover_uncollected` — owner-driven manual recovery of an
 * archived `ClaimableBalance` entry. Carried on the wire via the
 * `vault.recovered` event so the off-chain indexer can update its
 * `claimable_balances` table accordingly.
 */
export type RecoveryMode = {tag: "Recredit", values: void} | {tag: "Transfer", values: void};


/**
 * A pending LP entry: `assets` sit escrowed in the vault (excluded from
 * managed assets) until the request matures past the LP pricing delay and
 * queue processing mints shares at the then-current — post-outcome — share
 * price. See `WithdrawalRequest` on why pricing is delayed.
 */
export interface DepositRequest {
  assets: i128;
  owner: string;
  request_id: u64;
  requested_at: u64;
}


export interface WithdrawalRequest {
  owner: string;
  request_id: u64;
  requested_at: u64;
  shares: i128;
}


export const RoleTransferError = {
  2200: {message:"NoPendingTransfer"},
  2201: {message:"InvalidLiveUntilLedger"},
  2202: {message:"InvalidPendingAccount"},
  2203: {message:"TransferExpired"}
}

export const OwnableError = {
  2100: {message:"OwnerNotSet"},
  2101: {message:"TransferInProgress"},
  2102: {message:"OwnerAlreadySet"}
}




export const SorobanFixedPointError = {
  /**
   * Arithmetic overflow occurred
   */
  1500: {message:"Overflow"},
  /**
   * Division by zero
   */
  1501: {message:"DivisionByZero"}
}



export const PausableError = {
  /**
   * The operation failed because the contract is paused.
   */
  1000: {message:"EnforcedPause"},
  /**
   * The operation failed because the contract is not paused.
   */
  1001: {message:"ExpectedPause"}
}

export const VaultTokenError = {
  /**
   * Indicates access to uninitialized vault asset address.
   */
  400: {message:"VaultAssetAddressNotSet"},
  /**
   * Indicates that vault asset address is already set.
   */
  401: {message:"VaultAssetAddressAlreadySet"},
  /**
   * Indicates that vault virtual decimals offset is already set.
   */
  402: {message:"VaultVirtualDecimalsOffsetAlreadySet"},
  /**
   * Indicates the amount is not a valid vault assets value.
   */
  403: {message:"VaultInvalidAssetsAmount"},
  /**
   * Indicates the amount is not a valid vault shares value.
   */
  404: {message:"VaultInvalidSharesAmount"},
  /**
   * Attempted to deposit more assets than the max amount for address.
   */
  405: {message:"VaultExceededMaxDeposit"},
  /**
   * Attempted to mint more shares than the max amount for address.
   */
  406: {message:"VaultExceededMaxMint"},
  /**
   * Attempted to withdraw more assets than the max amount for address.
   */
  407: {message:"VaultExceededMaxWithdraw"},
  /**
   * Attempted to redeem more shares than the max amount for address.
   */
  408: {message:"VaultExceededMaxRedeem"},
  /**
   * Maximum number of decimals offset exceeded
   */
  409: {message:"VaultMaxDecimalsOffsetExceeded"},
  /**
   * Indicates overflow due to mathematical operations
   */
  410: {message:"MathOverflow"}
}




export const FungibleTokenError = {
  /**
   * Indicates an error related to the current balance of account from which
   * tokens are expected to be transferred.
   */
  100: {message:"InsufficientBalance"},
  /**
   * Indicates a failure with the allowance mechanism when a given spender
   * doesn't have enough allowance.
   */
  101: {message:"InsufficientAllowance"},
  /**
   * Indicates an invalid value for `live_until_ledger` when setting an
   * allowance.
   */
  102: {message:"InvalidLiveUntilLedger"},
  /**
   * Indicates an error when an input that must be >= 0
   */
  103: {message:"LessThanZero"},
  /**
   * Indicates overflow when adding two values
   */
  104: {message:"MathOverflow"},
  /**
   * Indicates access to uninitialized metadata
   */
  105: {message:"UnsetMetadata"},
  /**
   * Indicates that the operation would have caused `total_supply` to exceed
   * the `cap`.
   */
  106: {message:"ExceededCap"},
  /**
   * Indicates the supplied `cap` is not a valid cap value.
   */
  107: {message:"InvalidCap"},
  /**
   * Indicates the Cap was not set.
   */
  108: {message:"CapNotSet"},
  /**
   * Indicates the SAC address was not set.
   */
  109: {message:"SACNotSet"},
  /**
   * Indicates a SAC address different than expected.
   */
  110: {message:"SACAddressMismatch"},
  /**
   * Indicates a missing function parameter in the SAC contract context.
   */
  111: {message:"SACMissingFnParam"},
  /**
   * Indicates an invalid function parameter in the SAC contract context.
   */
  112: {message:"SACInvalidFnParam"},
  /**
   * The user is not allowed to perform this operation
   */
  113: {message:"UserNotAllowed"},
  /**
   * The user is blocked and cannot perform this operation
   */
  114: {message:"UserBlocked"}
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
   * 
   * Refuses while the CURRENT oracle reports pending public outcomes:
   * a fresh oracle starts with a zero pending count, so swapping the
   * barrier target mid-incident would open the barrier at the stale
   * pre-settlement share price — exactly the LP-vs-LP value transfer the
   * barrier exists to prevent. When the old oracle is unreachable and
   * this check cannot even execute, use `force_set_oracle`.
   * 
   * Also refuses while any capital is locked: locked collateral means
   * policies are
   */
  set_oracle: ({oracle}: {oracle: string}, options?: MethodOptions) => Promise<AssembledTransaction<null>>

  /**
   * Construct and simulate a set_controller transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Set the vault controller address (one-time, owner-only).
   */
  set_controller: ({controller}: {controller: string}, options?: MethodOptions) => Promise<AssembledTransaction<null>>

  /**
   * Construct and simulate a force_set_oracle transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Rotate the oracle WITHOUT consulting the current one — the escape
   * hatch for the very contingency rotation exists for: the old oracle is
   * dead, archived, or itself the incident, so `set_oracle`'s
   * pending-outcomes check cannot even execute (and its locked-capital
   * check may never clear if the dead pipeline can no longer settle the
   * outstanding policies). Requires the vault to be paused first: the new
   * oracle knows nothing of policies still outstanding or outcomes still
   * pending against the old one, so every LP entry/exit must stay blocked
   * until the owner reconciles that PnL and deliberately unpauses. The emitted
   * event carries `forced = true` so monitoring treats the rotation as an
   * open incident rather than routine configuration.
   */
  force_set_oracle: ({oracle}: {oracle: string}, options?: MethodOptions) => Promise<AssembledTransaction<null>>

  /**
   * Construct and simulate a set_min_withdrawal_request transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Set the minimum asset value a queued request — withdrawal or deposit —
   * must carry at submission time (owner-only). Both queues are bounded
   * shared resources: without a value floor, one participant can split
   * capital across many addresses and occupy every slot with near-dust
   * requests, locking later underwriters out of the FIFO paths. A meaningful
   * minimum makes each slot cost real escrowed capital. Zero disables the
   * configured floor (an occupancy-scaled protocol floor still applies at
   * request time, so unset does not mean slots are free to squat). Choose
   * the value in underlying-asset units, well below typical LP position
   * sizes so small underwriters can still queue their exits.
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
   * Construct and simulate a cancel_deposit transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Cancel a queued deposit by request_id and return the escrowed assets.
   * Cancellation carries no pricing optionality: a queued deposit is
   * always minted at the post-outcome price, so backing out never lets
   * the owner dodge a loss or capture a gain that belongs to others.
   */
  cancel_deposit: ({caller, request_id}: {caller: string, request_id: u64}, options?: MethodOptions) => Promise<AssembledTransaction<null>>

  /**
   * Construct and simulate a request_deposit transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Submit an LP entry request. The assets transfer into the vault
   * immediately (escrowed — NOT yet counted as managed assets and backing
   * no shares), and queue processing mints the shares only after the
   * request outlives the LP pricing delay, at the share price current at
   * processing time. Committing value before pricing is the point: by the
   * time the request is priced, every flight outcome that was publicly
   * knowable at request time has reached the chain, so an informed
   * depositor cannot capture a known-but-unrecognized gain from the
   * incumbent LPs. Returns a monotonic request_id usable with
   * `cancel_deposit`.
   */
  request_deposit: ({caller, assets}: {caller: string, assets: i128}, options?: MethodOptions) => Promise<AssembledTransaction<u64>>

  /**
   * Construct and simulate a cancel_withdrawal transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Cancel a queued withdrawal by request_id (NOT queue index).
   * Indices shift when process_withdrawal_queue drains earlier entries;
   * a stable id avoids cancelling the wrong request.
   */
  cancel_withdrawal: ({caller, request_id}: {caller: string, request_id: u64}, options?: MethodOptions) => Promise<AssembledTransaction<null>>

  /**
   * Construct and simulate a request_withdrawal transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Submit a withdrawal request — the only LP exit path. The shares
   * escrow immediately; queue processing pays out only after the request
   * outlives the LP pricing delay, at the share price current at
   * processing time (see `request_deposit` on why pricing is delayed).
   * Returns a monotonic request_id that the caller can use to cancel the
   * request later (immune to queue reorder caused by intervening
   * process_withdrawal_queue calls).
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
   * Construct and simulate a set_solvency_ratio transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Controller-only: mirror the owner-configured solvency ratio into the
   * vault so exit paths can hold back the same reserve the controller
   * admits new policies against. The controller pushes on every owner
   * update; the vault cannot pull the value itself because the controller
   * invokes `process_withdrawal_queue` and a read-back during that call
   * would be reentrant. Deliberately NOT pause-gated: propagating a risk
   * parameter is exactly the kind of action an incident response performs
   * while the vault is paused.
   */
  set_solvency_ratio: ({controller, ratio}: {controller: string, ratio: u32}, options?: MethodOptions) => Promise<AssembledTransaction<null>>

  /**
   * Construct and simulate a process_deposit_queue transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Controller-only: mint shares for matured deposit requests (batched,
   * FIFO) — the entry-side mirror of `process_withdrawal_queue`. Each
   * matured request's escrowed assets convert to shares at the CURRENT
   * share price and join managed assets; requests younger than the LP
   * pricing delay stay queued, and the whole pass is a no-op while a
   * public outcome is unsettled, so nobody is ever minted at a price that
   * omits recognized or imminent PnL.
   */
  process_deposit_queue: ({controller}: {controller: string}, options?: MethodOptions) => Promise<AssembledTransaction<null>>

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
   * Return the nominal margin above locked payoff liabilities
   * (`TMA − LockedCapital`). This is an accounting view, NOT the exit
   * gate: withdrawals are bounded by `get_withdrawable_capital`, which
   * additionally holds back the configured solvency reserve.
   */
  get_free_capital: (options?: MethodOptions) => Promise<AssembledTransaction<i128>>

  /**
   * Construct and simulate a get_deposit_queue transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Return the current pending deposit request queue (escrowed LP entries
   * awaiting delayed pricing).
   */
  get_deposit_queue: (options?: MethodOptions) => Promise<AssembledTransaction<Array<DepositRequest>>>

  /**
   * Construct and simulate a get_locked_capital transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Return the amount of capital currently locked as collateral.
   */
  get_locked_capital: (options?: MethodOptions) => Promise<AssembledTransaction<i128>>

  /**
   * Construct and simulate a get_solvency_ratio transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Return the solvency ratio (percent) the vault holds in reserve against
   * locked capital. Pushed by the controller alongside its own copy; 100
   * (nominal backing only) until the controller first configures it.
   */
  get_solvency_ratio: (options?: MethodOptions) => Promise<AssembledTransaction<u32>>

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
   * Construct and simulate a get_deposit_queue_len transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Return the number of pending deposit requests — the entry-side
   * occupancy gauge (see `get_withdrawal_queue_len`).
   */
  get_deposit_queue_len: (options?: MethodOptions) => Promise<AssembledTransaction<u32>>

  /**
   * Construct and simulate a get_total_managed_assets transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Return the total assets under management by the vault.
   */
  get_total_managed_assets: (options?: MethodOptions) => Promise<AssembledTransaction<i128>>

  /**
   * Construct and simulate a get_withdrawable_capital transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Return the capital LP exits may remove:
   * `max(TMA − ceil(LockedCapital × SolvencyRatio / 100), 0)`.
   * The same required-backing formula the controller admits new policies
   * against — using the nominal margin here instead would let exits drain
   * the configured reserve down to 100% backing the moment a purchase
   * passed. Gates withdrawal-queue processing — the only LP exit path now
   * that the immediate exit operations are disabled.
   */
  get_withdrawable_capital: (options?: MethodOptions) => Promise<AssembledTransaction<i128>>

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
   * Return the minimum asset value a queued request (withdrawal or
   * deposit) must carry (0 = no minimum configured).
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
   * Disabled — see `deposit`. There is no share-denominated request path;
   * use `request_deposit` with an asset amount.
   */
  mint: ({shares, receiver, from, operator}: {shares: i128, receiver: string, from: string, operator: string}, options?: MethodOptions) => Promise<AssembledTransaction<i128>>

  /**
   * Construct and simulate a redeem transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Disabled — see `withdraw`. Use `request_withdrawal` with a share
   * amount.
   */
  redeem: ({shares, receiver, owner, operator}: {shares: i128, receiver: string, owner: string, operator: string}, options?: MethodOptions) => Promise<AssembledTransaction<i128>>

  /**
   * Construct and simulate a deposit transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Disabled. LP entry is two-phase: `request_deposit` escrows the assets
   * and queue processing mints shares at the delayed, post-outcome price.
   * An immediate deposit would price at call time — stale with respect to
   * any outcome that is public but not yet written on-chain.
   */
  deposit: ({assets, receiver, from, operator}: {assets: i128, receiver: string, from: string, operator: string}, options?: MethodOptions) => Promise<AssembledTransaction<i128>>

  /**
   * Construct and simulate a max_mint transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Returns zero — immediate mints are disabled (see `mint`).
   */
  max_mint: ({address}: {address: string}, options?: MethodOptions) => Promise<AssembledTransaction<i128>>

  /**
   * Construct and simulate a withdraw transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Disabled. LP exit is two-phase: `request_withdrawal` escrows the
   * shares and queue processing pays out at the delayed, post-outcome
   * price. See `deposit`.
   */
  withdraw: ({assets, receiver, owner, operator}: {assets: i128, receiver: string, owner: string, operator: string}, options?: MethodOptions) => Promise<AssembledTransaction<i128>>

  /**
   * Construct and simulate a max_redeem transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Returns zero — immediate redemptions are disabled (see `redeem`).
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
   * Returns zero — immediate withdrawals are disabled (see `withdraw`).
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
   * Previews the shares a deposit of `assets` would mint at the CURRENT
   * share price. Informational — a queued deposit is priced at
   * processing time, not request time.
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
        "AAAAAAAABABSb3RhdGUgdGhlIE9yYWNsZUFnZ3JlZ2F0b3IgYWRkcmVzcyB0aGUgdmF1bHQgY29uc3VsdHMgdG8gYmxvY2sKZW50cnkvZXhpdCB3aGlsZSBhIGZsaWdodCBvdXRjb21lIGlzIHB1YmxpYyBidXQgbm90IHlldCBzZXR0bGVkLgpPd25lci1vbmx5LiBUaGUgaW5pdGlhbCBvcmFjbGUgaXMgd2lyZWQgYXQgY29uc3RydWN0aW9uLCBzbyB0aGlzCmV4aXN0cyBvbmx5IGZvciB0aGUgKHJlZGVwbG95LXRoZS1vcmFjbGUpIGNvbnRpbmdlbmN5OyBub3RlIHRoZQphc3ltbWV0cnkgd2l0aCBgc2V0X2NvbnRyb2xsZXJgLCB3aGljaCBpcyBkZWxpYmVyYXRlbHkgb25lLXRpbWUg4oCUCnRoZSBiYXJyaWVyIHRhcmdldCBtdXN0IHN0YXkgcm90YXRhYmxlIGJlY2F1c2UgdGhlIHZhdWx0IGNhbm5vdApmdW5jdGlvbiBzYWZlbHkgYWdhaW5zdCBhIGRlYWQgb3JhY2xlLCB3aGlsZSBhIGNvbnRyb2xsZXIgc3dhcCBoYXMKbm8gc3VjaCByZWNvdmVyeSBuZWVkLiBFbWl0cyBgb3JhY2xlX3NldGAgc28gbW9uaXRvcmluZyBjYXRjaGVzIGFueQpyZS13aXJlIG9mIHRoZSBiYXJyaWVyIHRhcmdldC4KClJlZnVzZXMgd2hpbGUgdGhlIENVUlJFTlQgb3JhY2xlIHJlcG9ydHMgcGVuZGluZyBwdWJsaWMgb3V0Y29tZXM6CmEgZnJlc2ggb3JhY2xlIHN0YXJ0cyB3aXRoIGEgemVybyBwZW5kaW5nIGNvdW50LCBzbyBzd2FwcGluZyB0aGUKYmFycmllciB0YXJnZXQgbWlkLWluY2lkZW50IHdvdWxkIG9wZW4gdGhlIGJhcnJpZXIgYXQgdGhlIHN0YWxlCnByZS1zZXR0bGVtZW50IHNoYXJlIHByaWNlIOKAlCBleGFjdGx5IHRoZSBMUC12cy1MUCB2YWx1ZSB0cmFuc2ZlciB0aGUKYmFycmllciBleGlzdHMgdG8gcHJldmVudC4gV2hlbiB0aGUgb2xkIG9yYWNsZSBpcyB1bnJlYWNoYWJsZSBhbmQKdGhpcyBjaGVjayBjYW5ub3QgZXZlbiBleGVjdXRlLCB1c2UgYGZvcmNlX3NldF9vcmFjbGVgLgoKQWxzbyByZWZ1c2VzIHdoaWxlIGFueSBjYXBpdGFsIGlzIGxvY2tlZDogbG9ja2VkIGNvbGxhdGVyYWwgbWVhbnMKcG9saWNpZXMgYXJlAAAACnNldF9vcmFjbGUAAAAAAAEAAAAAAAAABm9yYWNsZQAAAAAAEwAAAAA=",
        "AAAAAAAABABJbml0aWFsaXplIHRoZSB2YXVsdC4KCiMgQXJndW1lbnRzCiogYG93bmVyYCAtIEFkZHJlc3MgZ3JhbnRlZCBvd25lciByaWdodHMgKHNldCB0aGUgY29udHJvbGxlciwgcGF1c2UsCnVwZ3JhZGUsIHJlY292ZXIgdW5jb2xsZWN0ZWQgYmFsYW5jZXMpLgoqIGBhc3NldF90b2tlbmAgLSBTQUMgYWRkcmVzcyBvZiB0aGUgdW5kZXJseWluZyBhc3NldCB0aGUgdmF1bHQKY3VzdG9kaWVzIGFuZCBkZW5vbWluYXRlcyBpdHMgc2hhcmVzIGFnYWluc3QuCiogYG9yYWNsZWAgLSBBZGRyZXNzIG9mIHRoZSBPcmFjbGVBZ2dyZWdhdG9yIHRoZSBzZXR0bGVtZW50IGJhcnJpZXIKY29uc3VsdHMuIFJlcXVpcmVkIGF0IGNvbnN0cnVjdGlvbiBzbyB0aGUgYmFycmllciBpcyBhY3RpdmUgZnJvbQpnZW5lc2lzOiBhIGRlcG9zaXQtYWNjZXB0aW5nIHZhdWx0IHdob3NlIGJhcnJpZXIgaXMgc2lsZW50bHkgdW53aXJlZAp3b3VsZCBsZXQgTFBzIGVudGVyL2V4aXQgYXQgc3RhbGUgc2hhcmUgcHJpY2VzIGR1cmluZwpvdXRjb21lLXB1YmxpYy1idXQtdW5zZXR0bGVkIHdpbmRvd3MuIChUaGUgZGVwbG95IG9yZGVyIHBsYWNlcyB0aGUKb3JhY2xlIGJlZm9yZSB0aGUgdmF1bHQsIHNvIHRoZSBhZGRyZXNzIGlzIGFsd2F5cyBhdmFpbGFibGUgaGVyZS4pCgpJTlZBUklBTlQ6IHRoaXMgTVVTVCBiZSB0aGUgZXhhY3Qgc2FtZSBPcmFjbGVBZ2dyZWdhdG9yIHRoZSBjb250cm9sbGVyCmlzIGNvbnN0cnVjdGVkIHdpdGguIFRoZSBjb250cm9sbGVyIHJlZ2lzdGVycyBmbGlnaHRzIGFuZCBkcml2ZXMKc2V0dGxlbWVudCBhZ2FpbnN0IElUUyBvcmFjbGUgKGFuIGltbXV0YWJsZSwgY29uc3RydWN0aW9uLXRpbWUKcG9pbnRlciB3aXRoIG5vIHNldHRlciksIHdoaWxlIHRoZSBiYXJyaWVyIHJlYWRzIHBlbmRpbmcgb3V0Y29tZXMgZnJvbQp0aGUgdmF1bHQncyBvcmFjbGUuIElmIHRoZSB0d28gZXZlciBkaXZlcmdlLCB0aGUgcGVuZGluZy1vdXRjb21lCmNvdW50ZXIgdGhlIGJhcnJpZXIgd2F0Y2hlcyBpcyBtYWludGFpbmVkIG9uAAAADV9fY29uc3RydWN0b3IAAAAAAAADAAAAAAAAAAVvd25lcgAAAAAAABMAAAAAAAAAC2Fzc2V0X3Rva2VuAAAAABMAAAAAAAAABm9yYWNsZQAAAAAAEwAAAAA=",
        "AAAAAAAAADhTZXQgdGhlIHZhdWx0IGNvbnRyb2xsZXIgYWRkcmVzcyAob25lLXRpbWUsIG93bmVyLW9ubHkpLgAAAA5zZXRfY29udHJvbGxlcgAAAAAAAQAAAAAAAAAKY29udHJvbGxlcgAAAAAAEwAAAAA=",
        "AAAAAAAAAt1Sb3RhdGUgdGhlIG9yYWNsZSBXSVRIT1VUIGNvbnN1bHRpbmcgdGhlIGN1cnJlbnQgb25lIOKAlCB0aGUgZXNjYXBlCmhhdGNoIGZvciB0aGUgdmVyeSBjb250aW5nZW5jeSByb3RhdGlvbiBleGlzdHMgZm9yOiB0aGUgb2xkIG9yYWNsZSBpcwpkZWFkLCBhcmNoaXZlZCwgb3IgaXRzZWxmIHRoZSBpbmNpZGVudCwgc28gYHNldF9vcmFjbGVgJ3MKcGVuZGluZy1vdXRjb21lcyBjaGVjayBjYW5ub3QgZXZlbiBleGVjdXRlIChhbmQgaXRzIGxvY2tlZC1jYXBpdGFsCmNoZWNrIG1heSBuZXZlciBjbGVhciBpZiB0aGUgZGVhZCBwaXBlbGluZSBjYW4gbm8gbG9uZ2VyIHNldHRsZSB0aGUKb3V0c3RhbmRpbmcgcG9saWNpZXMpLiBSZXF1aXJlcyB0aGUgdmF1bHQgdG8gYmUgcGF1c2VkIGZpcnN0OiB0aGUgbmV3Cm9yYWNsZSBrbm93cyBub3RoaW5nIG9mIHBvbGljaWVzIHN0aWxsIG91dHN0YW5kaW5nIG9yIG91dGNvbWVzIHN0aWxsCnBlbmRpbmcgYWdhaW5zdCB0aGUgb2xkIG9uZSwgc28gZXZlcnkgTFAgZW50cnkvZXhpdCBtdXN0IHN0YXkgYmxvY2tlZAp1bnRpbCB0aGUgb3duZXIgcmVjb25jaWxlcyB0aGF0IFBuTCBhbmQgZGVsaWJlcmF0ZWx5IHVucGF1c2VzLiBUaGUgZW1pdHRlZApldmVudCBjYXJyaWVzIGBmb3JjZWQgPSB0cnVlYCBzbyBtb25pdG9yaW5nIHRyZWF0cyB0aGUgcm90YXRpb24gYXMgYW4Kb3BlbiBpbmNpZGVudCByYXRoZXIgdGhhbiByb3V0aW5lIGNvbmZpZ3VyYXRpb24uAAAAAAAAEGZvcmNlX3NldF9vcmFjbGUAAAABAAAAAAAAAAZvcmFjbGUAAAAAABMAAAAA",
        "AAAAAAAAA3xTZXQgdGhlIG1pbmltdW0gYXNzZXQgdmFsdWUgYSBxdWV1ZWQgcmVxdWVzdCDigJQgd2l0aGRyYXdhbCBvciBkZXBvc2l0IOKAlAptdXN0IGNhcnJ5IGF0IHN1Ym1pc3Npb24gdGltZSAob3duZXItb25seSkuIEJvdGggcXVldWVzIGFyZSBib3VuZGVkCnNoYXJlZCByZXNvdXJjZXM6IHdpdGhvdXQgYSB2YWx1ZSBmbG9vciwgb25lIHBhcnRpY2lwYW50IGNhbiBzcGxpdApjYXBpdGFsIGFjcm9zcyBtYW55IGFkZHJlc3NlcyBhbmQgb2NjdXB5IGV2ZXJ5IHNsb3Qgd2l0aCBuZWFyLWR1c3QKcmVxdWVzdHMsIGxvY2tpbmcgbGF0ZXIgdW5kZXJ3cml0ZXJzIG91dCBvZiB0aGUgRklGTyBwYXRocy4gQSBtZWFuaW5nZnVsCm1pbmltdW0gbWFrZXMgZWFjaCBzbG90IGNvc3QgcmVhbCBlc2Nyb3dlZCBjYXBpdGFsLiBaZXJvIGRpc2FibGVzIHRoZQpjb25maWd1cmVkIGZsb29yIChhbiBvY2N1cGFuY3ktc2NhbGVkIHByb3RvY29sIGZsb29yIHN0aWxsIGFwcGxpZXMgYXQKcmVxdWVzdCB0aW1lLCBzbyB1bnNldCBkb2VzIG5vdCBtZWFuIHNsb3RzIGFyZSBmcmVlIHRvIHNxdWF0KS4gQ2hvb3NlCnRoZSB2YWx1ZSBpbiB1bmRlcmx5aW5nLWFzc2V0IHVuaXRzLCB3ZWxsIGJlbG93IHR5cGljYWwgTFAgcG9zaXRpb24Kc2l6ZXMgc28gc21hbGwgdW5kZXJ3cml0ZXJzIGNhbiBzdGlsbCBxdWV1ZSB0aGVpciBleGl0cy4KClRoZSBlbmZvcmNlbWVudCBpcyBjbGFtcGVkIGF0IHJlcXVlc3QgdGltZSB0byBhIHNtYWxsIGZyYWN0aW9uIG9mCm1hbmFnZWQgYXNzZXRzIChzZWUgYE1JTl9SRVFVRVNUX0ZMT09SX0RJVklTT1JgKSwgc28gbm8gY29uZmlndXJlZAp2YWx1ZSDigJQgaG93ZXZlciBsYXJnZSDigJQgY2FuIGxvY2sgb3JkaW5hcnkgcG9zaXRpb25zIG91dCBvZiB0aGUgcXVldWUuAAAAGnNldF9taW5fd2l0aGRyYXdhbF9yZXF1ZXN0AAAAAAABAAAAAAAAAAptaW5fYXNzZXRzAAAAAAALAAAAAA==",
        "AAAABAAAAAAAAAAAAAAABUVycm9yAAAAAAAAGwAAAAAAAAAUQ29udHJvbGxlckFscmVhZHlTZXQAAAK9AAAAAAAAAA1Ob3RDb250cm9sbGVyAAAAAAACvgAAAAAAAAAUQW1vdW50TXVzdEJlUG9zaXRpdmUAAAK/AAAAAAAAAB1Xb3VsZEV4Y2VlZFRvdGFsTWFuYWdlZEFzc2V0cwAAAAAAAsAAAAAAAAAAD1dvdWxkR29OZWdhdGl2ZQAAAALBAAAAAAAAABJQcmVtaXVtTm90UmVjZWl2ZWQAAAAAAsIAAAAAAAAAGUluc3VmZmljaWVudE1hbmFnZWRBc3NldHMAAAAAAALDAAAAAAAAABRTaGFyZXNNdXN0QmVQb3NpdGl2ZQAAAsQAAAAAAAAAGFNoYXJlc1JlZGVlbVRvWmVyb0Fzc2V0cwAAAsUAAAAAAAAADk5vdFlvdXJSZXF1ZXN0AAAAAALGAAAAAAAAABBOb3RoaW5nVG9Db2xsZWN0AAACxwAAAAAAAAAVUmVjcmVkaXRXb3VsZFVuZGVycGF5AAAAAAACyAAAAAAAAAAdQW1vdW50RXhjZWVkc0NsYWltYWJsZUJhbGFuY2UAAAAAAALJAAAAAAAAABNXaXRoZHJhd2FsUXVldWVGdWxsAAAAAswAAAAAAAAAFVRvb01hbnlBY3RpdmVSZXF1ZXN0cwAAAAAAAs0AAAAAAAAAE1JlcXVlc3RCZWxvd01pbmltdW0AAAACzwAAAAAAAAAZQXNzZXRzQ29udmVydFRvWmVyb1NoYXJlcwAAAAAAAtAAAAAAAAAAD1JlcXVlc3ROb3RGb3VuZAAAAALRAAAAAAAAABdBbW91bnRNdXN0QmVOb25OZWdhdGl2ZQAAAALSAAAAAAAAACFSZWNyZWRpdEV4Y2VlZHNSZWNvdmVyYWJsZVN1cnBsdXMAAAAAAALTAAAAAAAAABhTb2x2ZW5jeVJhdGlvT3V0T2ZCb3VuZHMAAALUAAAAAAAAACFPcmFjbGVQZW5kaW5nT3V0Y29tZXNVbnJlY29uY2lsZWQAAAAAAALVAAAAAAAAABtGb3JjZWRSb3RhdGlvblJlcXVpcmVzUGF1c2UAAAAC1gAAAAAAAAATRGlyZWN0RW50cnlEaXNhYmxlZAAAAALXAAAAAAAAABJEaXJlY3RFeGl0RGlzYWJsZWQAAAAAAtgAAAAAAAAAEERlcG9zaXRRdWV1ZUZ1bGwAAALZAAAAAAAAACBPcmFjbGVBY3RpdmVFeHBvc3VyZVVucmVjb25jaWxlZAAAAto=",
        "AAAAAAAAAD5Db2xsZWN0ICh0cmFuc2ZlciBvdXQpIHRoZSBjYWxsZXIncyBhY2NydWVkIGNsYWltYWJsZSBiYWxhbmNlLgAAAAAAB2NvbGxlY3QAAAAAAQAAAAAAAAAGY2FsbGVyAAAAAAATAAAAAA==",
        "AAAAAAAAAQpDYW5jZWwgYSBxdWV1ZWQgZGVwb3NpdCBieSByZXF1ZXN0X2lkIGFuZCByZXR1cm4gdGhlIGVzY3Jvd2VkIGFzc2V0cy4KQ2FuY2VsbGF0aW9uIGNhcnJpZXMgbm8gcHJpY2luZyBvcHRpb25hbGl0eTogYSBxdWV1ZWQgZGVwb3NpdCBpcwphbHdheXMgbWludGVkIGF0IHRoZSBwb3N0LW91dGNvbWUgcHJpY2UsIHNvIGJhY2tpbmcgb3V0IG5ldmVyIGxldHMKdGhlIG93bmVyIGRvZGdlIGEgbG9zcyBvciBjYXB0dXJlIGEgZ2FpbiB0aGF0IGJlbG9uZ3MgdG8gb3RoZXJzLgAAAAAADmNhbmNlbF9kZXBvc2l0AAAAAAACAAAAAAAAAAZjYWxsZXIAAAAAABMAAAAAAAAACnJlcXVlc3RfaWQAAAAAAAYAAAAA",
        "AAAAAAAAAmBTdWJtaXQgYW4gTFAgZW50cnkgcmVxdWVzdC4gVGhlIGFzc2V0cyB0cmFuc2ZlciBpbnRvIHRoZSB2YXVsdAppbW1lZGlhdGVseSAoZXNjcm93ZWQg4oCUIE5PVCB5ZXQgY291bnRlZCBhcyBtYW5hZ2VkIGFzc2V0cyBhbmQgYmFja2luZwpubyBzaGFyZXMpLCBhbmQgcXVldWUgcHJvY2Vzc2luZyBtaW50cyB0aGUgc2hhcmVzIG9ubHkgYWZ0ZXIgdGhlCnJlcXVlc3Qgb3V0bGl2ZXMgdGhlIExQIHByaWNpbmcgZGVsYXksIGF0IHRoZSBzaGFyZSBwcmljZSBjdXJyZW50IGF0CnByb2Nlc3NpbmcgdGltZS4gQ29tbWl0dGluZyB2YWx1ZSBiZWZvcmUgcHJpY2luZyBpcyB0aGUgcG9pbnQ6IGJ5IHRoZQp0aW1lIHRoZSByZXF1ZXN0IGlzIHByaWNlZCwgZXZlcnkgZmxpZ2h0IG91dGNvbWUgdGhhdCB3YXMgcHVibGljbHkKa25vd2FibGUgYXQgcmVxdWVzdCB0aW1lIGhhcyByZWFjaGVkIHRoZSBjaGFpbiwgc28gYW4gaW5mb3JtZWQKZGVwb3NpdG9yIGNhbm5vdCBjYXB0dXJlIGEga25vd24tYnV0LXVucmVjb2duaXplZCBnYWluIGZyb20gdGhlCmluY3VtYmVudCBMUHMuIFJldHVybnMgYSBtb25vdG9uaWMgcmVxdWVzdF9pZCB1c2FibGUgd2l0aApgY2FuY2VsX2RlcG9zaXRgLgAAAA9yZXF1ZXN0X2RlcG9zaXQAAAAAAgAAAAAAAAAGY2FsbGVyAAAAAAATAAAAAAAAAAZhc3NldHMAAAAAAAsAAAABAAAABg==",
        "AAAAAAAAALBDYW5jZWwgYSBxdWV1ZWQgd2l0aGRyYXdhbCBieSByZXF1ZXN0X2lkIChOT1QgcXVldWUgaW5kZXgpLgpJbmRpY2VzIHNoaWZ0IHdoZW4gcHJvY2Vzc193aXRoZHJhd2FsX3F1ZXVlIGRyYWlucyBlYXJsaWVyIGVudHJpZXM7CmEgc3RhYmxlIGlkIGF2b2lkcyBjYW5jZWxsaW5nIHRoZSB3cm9uZyByZXF1ZXN0LgAAABFjYW5jZWxfd2l0aGRyYXdhbAAAAAAAAAIAAAAAAAAABmNhbGxlcgAAAAAAEwAAAAAAAAAKcmVxdWVzdF9pZAAAAAAABgAAAAA=",
        "AAAAAAAAAalTdWJtaXQgYSB3aXRoZHJhd2FsIHJlcXVlc3Qg4oCUIHRoZSBvbmx5IExQIGV4aXQgcGF0aC4gVGhlIHNoYXJlcwplc2Nyb3cgaW1tZWRpYXRlbHk7IHF1ZXVlIHByb2Nlc3NpbmcgcGF5cyBvdXQgb25seSBhZnRlciB0aGUgcmVxdWVzdApvdXRsaXZlcyB0aGUgTFAgcHJpY2luZyBkZWxheSwgYXQgdGhlIHNoYXJlIHByaWNlIGN1cnJlbnQgYXQKcHJvY2Vzc2luZyB0aW1lIChzZWUgYHJlcXVlc3RfZGVwb3NpdGAgb24gd2h5IHByaWNpbmcgaXMgZGVsYXllZCkuClJldHVybnMgYSBtb25vdG9uaWMgcmVxdWVzdF9pZCB0aGF0IHRoZSBjYWxsZXIgY2FuIHVzZSB0byBjYW5jZWwgdGhlCnJlcXVlc3QgbGF0ZXIgKGltbXVuZSB0byBxdWV1ZSByZW9yZGVyIGNhdXNlZCBieSBpbnRlcnZlbmluZwpwcm9jZXNzX3dpdGhkcmF3YWxfcXVldWUgY2FsbHMpLgAAAAAAABJyZXF1ZXN0X3dpdGhkcmF3YWwAAAAAAAIAAAAAAAAABmNhbGxlcgAAAAAAEwAAAAAAAAAGc2hhcmVzAAAAAAALAAAAAQAAAAY=",
        "AAAAAAAAAv5Pd25lci1kcml2ZW4gbWFudWFsIHJlY292ZXJ5IG9mIGFuIGFyY2hpdmVkIGBDbGFpbWFibGVCYWxhbmNlYCBlbnRyeQoob3IgYW55IHVzZXIgb3dlZCB2YWx1ZSB0aGUgcHJvdG9jb2wgY291bGRuJ3QgZGVsaXZlciB2aWEKYHByb2Nlc3Nfd2l0aGRyYXdhbF9xdWV1ZWAgKyBgY29sbGVjdGApLiBVc2VzIGV2ZW50IGxvZ3MgYXMgdGhlCmF1ZGl0IHRyYWlsIGZvciB3aG8gaXMgb3dlZCB3aGF0LgoKLSBgUmVjb3ZlcnlNb2RlOjpSZWNyZWRpdGAg4oCUIFNFVCBgQ2xhaW1hYmxlQmFsYW5jZSh1c2VyKSA9IGFtb3VudGAsCmV4dGVuZCBUVEwsIGVtaXQgYHZhdWx0LnJlY292ZXJlZCguLiwgUmVjcmVkaXQpYC4gVXNlIGFmdGVyCmFyY2hpdmFsIHJlY292ZXJ5LgotIGBSZWNvdmVyeU1vZGU6OlRyYW5zZmVyYCDigJQgZGlyZWN0bHkgYGFzc2V0LnRyYW5zZmVyKHZhdWx0IOKGkiB1c2VyLAphbW91bnQpYC4gTm8gc3RvcmFnZSB3cml0ZS4gVXNlIHdoZW4gdXNlciB3YW50cyBmdW5kcyBpbiBoYW5kLgoKTGF5ZXJlZCBkZWZlbnNlOgoxLiBPbi13cml0ZSA2MC1kYXkgVFRMIGV4dGVuc2lvbiAoYHByb2Nlc3Nfd2l0aGRyYXdhbF9xdWV1ZWApLgoyLiBPZmYtY2hhaW4gVFRMIGNyb24gYEV4dGVuZEZvb3RwcmludFRUTE9wYCBjb3ZlcmluZwpgQ2xhaW1hYmxlQmFsYW5jZShhZGRyKWAga2V5cy4KMy4gVGhpcyBmdW5jdGlvbiAoYHJlY292ZXJfdW5jb2xsZWN0ZWRgKSDigJQgb3duZXIgbWFudWFsIGZhbGxiYWNrIGlmCmxheWVycyAxIGFuZCAyIGZhaWwuAAAAAAATcmVjb3Zlcl91bmNvbGxlY3RlZAAAAAADAAAAAAAAAAR1c2VyAAAAEwAAAAAAAAAGYW1vdW50AAAAAAALAAAAAAAAAARtb2RlAAAH0AAAAAxSZWNvdmVyeU1vZGUAAAAA",
        "AAAABQAAAAAAAAAAAAAACENyZWRpdGVkAAAAAgAAAAhzZW50aW5lbAAAAAhjcmVkaXRlZAAAAAMAAAAAAAAABHVzZXIAAAATAAAAAQAAAAAAAAAGYW1vdW50AAAAAAALAAAAAAAAAAAAAAALbmV3X2JhbGFuY2UAAAAACwAAAAAAAAAC",
        "AAAABQAAAAAAAAAAAAAACUNvbGxlY3RlZAAAAAAAAAIAAAAIc2VudGluZWwAAAAJY29sbGVjdGVkAAAAAAAAAgAAAAAAAAAEdXNlcgAAABMAAAABAAAAAAAAAAZhbW91bnQAAAAAAAsAAAAAAAAAAA==",
        "AAAABQAAAAAAAAAAAAAACU9yYWNsZVNldAAAAAAAAAIAAAAIc2VudGluZWwAAAAKb3JhY2xlX3NldAAAAAAAAgAAAAAAAAAGb3JhY2xlAAAAAAATAAAAAQAAAAAAAAAGZm9yY2VkAAAAAAABAAAAAAAAAAA=",
        "AAAABQAAAAAAAAAAAAAACVJlY292ZXJlZAAAAAAAAAIAAAAIc2VudGluZWwAAAAJcmVjb3ZlcmVkAAAAAAAAAwAAAAAAAAAEdXNlcgAAABMAAAABAAAAAAAAAAZhbW91bnQAAAAAAAsAAAAAAAAAAAAAAARtb2RlAAAH0AAAAAxSZWNvdmVyeU1vZGUAAAAAAAAAAg==",
        "AAAABQAAAAAAAAAAAAAADUNvbnRyb2xsZXJTZXQAAAAAAAACAAAACHNlbnRpbmVsAAAADmNvbnRyb2xsZXJfc2V0AAAAAAABAAAAAAAAAApjb250cm9sbGVyAAAAAAATAAAAAQAAAAA=",
        "AAAABQAAAAAAAAAAAAAADkRlcG9zaXREcm9wcGVkAAAAAAACAAAACHNlbnRpbmVsAAAAC2RlcF9kcm9wcGVkAAAAAAMAAAAAAAAABW93bmVyAAAAAAAAEwAAAAEAAAAAAAAACnJlcXVlc3RfaWQAAAAAAAYAAAAAAAAAAAAAAAZhc3NldHMAAAAAAAsAAAAAAAAAAg==",
        "AAAABQAAAAAAAAAAAAAADlJlcXVlc3REcm9wcGVkAAAAAAACAAAACHNlbnRpbmVsAAAACndkX2Ryb3BwZWQAAAAAAAMAAAAAAAAABW93bmVyAAAAAAAAEwAAAAEAAAAAAAAACnJlcXVlc3RfaWQAAAAAAAYAAAAAAAAAAAAAAAZzaGFyZXMAAAAAAAsAAAAAAAAAAg==",
        "AAAABQAAAAAAAAAAAAAAEERlcG9zaXRDYW5jZWxsZWQAAAACAAAACHNlbnRpbmVsAAAACmRlcF9jYW5jZWwAAAAAAAQAAAAAAAAABW93bmVyAAAAAAAAEwAAAAEAAAAAAAAACnJlcXVlc3RfaWQAAAAAAAYAAAAAAAAAAAAAAAZhc3NldHMAAAAAAAsAAAAAAAAAAAAAAAlxdWV1ZV9sZW4AAAAAAAAEAAAAAAAAAAI=",
        "AAAABQAAAAAAAAAAAAAAEERlcG9zaXRQcm9jZXNzZWQAAAACAAAACHNlbnRpbmVsAAAACmRlcF9taW50ZWQAAAAAAAQAAAAAAAAABW93bmVyAAAAAAAAEwAAAAEAAAAAAAAACnJlcXVlc3RfaWQAAAAAAAYAAAAAAAAAAAAAAAZhc3NldHMAAAAAAAsAAAAAAAAAAAAAAAZzaGFyZXMAAAAAAAsAAAAAAAAAAg==",
        "AAAABQAAAAAAAAAAAAAAEERlcG9zaXRSZXF1ZXN0ZWQAAAACAAAACHNlbnRpbmVsAAAAB2RlcF9yZXEAAAAABAAAAAAAAAAFb3duZXIAAAAAAAATAAAAAQAAAAAAAAAKcmVxdWVzdF9pZAAAAAAABgAAAAAAAAAAAAAABmFzc2V0cwAAAAAACwAAAAAAAAAAAAAACXF1ZXVlX2xlbgAAAAAAAAQAAAAAAAAAAg==",
        "AAAABQAAAAAAAAAAAAAAEFNvbHZlbmN5UmF0aW9TZXQAAAACAAAACHNlbnRpbmVsAAAACXJhdGlvX3NldAAAAAAAAAEAAAAAAAAABXJhdGlvAAAAAAAABAAAAAAAAAAA",
        "AAAABQAAAAAAAAAAAAAAElNoYXJlUHJpY2VTbmFwc2hvdAAAAAAAAgAAAAhzZW50aW5lbAAAAAhzbmFwc2hvdAAAAAIAAAAAAAAAA2RheQAAAAAGAAAAAQAAAAAAAAAFcHJpY2UAAAAAAAALAAAAAAAAAAI=",
        "AAAABQAAAAAAAAAAAAAAE1dpdGhkcmF3YWxDYW5jZWxsZWQAAAAAAgAAAAhzZW50aW5lbAAAAAl3ZF9jYW5jZWwAAAAAAAAEAAAAAAAAAAVvd25lcgAAAAAAABMAAAABAAAAAAAAAApyZXF1ZXN0X2lkAAAAAAAGAAAAAAAAAAAAAAAGc2hhcmVzAAAAAAALAAAAAAAAAAAAAAAJcXVldWVfbGVuAAAAAAAABAAAAAAAAAAC",
        "AAAABQAAAAAAAAAAAAAAE1dpdGhkcmF3YWxSZXF1ZXN0ZWQAAAAAAgAAAAhzZW50aW5lbAAAAAZ3ZF9yZXEAAAAAAAQAAAAAAAAABW93bmVyAAAAAAAAEwAAAAEAAAAAAAAACnJlcXVlc3RfaWQAAAAAAAYAAAAAAAAAAAAAAAZzaGFyZXMAAAAAAAsAAAAAAAAAAAAAAAlxdWV1ZV9sZW4AAAAAAAAEAAAAAAAAAAI=",
        "AAAABQAAAAAAAAAAAAAAFlJlcXVlc3RQYXJ0aWFsbHlGaWxsZWQAAAAAAAIAAAAIc2VudGluZWwAAAAKd2RfcGFydGlhbAAAAAAABAAAAAAAAAAFb3duZXIAAAAAAAATAAAAAQAAAAAAAAAKcmVxdWVzdF9pZAAAAAAABgAAAAAAAAAAAAAADXNoYXJlc19maWxsZWQAAAAAAAALAAAAAAAAAAAAAAAQc2hhcmVzX3JlbWFpbmluZwAAAAsAAAAAAAAAAg==",
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
        "AAAAAAAAAfhDb250cm9sbGVyLW9ubHk6IG1pcnJvciB0aGUgb3duZXItY29uZmlndXJlZCBzb2x2ZW5jeSByYXRpbyBpbnRvIHRoZQp2YXVsdCBzbyBleGl0IHBhdGhzIGNhbiBob2xkIGJhY2sgdGhlIHNhbWUgcmVzZXJ2ZSB0aGUgY29udHJvbGxlcgphZG1pdHMgbmV3IHBvbGljaWVzIGFnYWluc3QuIFRoZSBjb250cm9sbGVyIHB1c2hlcyBvbiBldmVyeSBvd25lcgp1cGRhdGU7IHRoZSB2YXVsdCBjYW5ub3QgcHVsbCB0aGUgdmFsdWUgaXRzZWxmIGJlY2F1c2UgdGhlIGNvbnRyb2xsZXIKaW52b2tlcyBgcHJvY2Vzc193aXRoZHJhd2FsX3F1ZXVlYCBhbmQgYSByZWFkLWJhY2sgZHVyaW5nIHRoYXQgY2FsbAp3b3VsZCBiZSByZWVudHJhbnQuIERlbGliZXJhdGVseSBOT1QgcGF1c2UtZ2F0ZWQ6IHByb3BhZ2F0aW5nIGEgcmlzawpwYXJhbWV0ZXIgaXMgZXhhY3RseSB0aGUga2luZCBvZiBhY3Rpb24gYW4gaW5jaWRlbnQgcmVzcG9uc2UgcGVyZm9ybXMKd2hpbGUgdGhlIHZhdWx0IGlzIHBhdXNlZC4AAAASc2V0X3NvbHZlbmN5X3JhdGlvAAAAAAACAAAAAAAAAApjb250cm9sbGVyAAAAAAATAAAAAAAAAAVyYXRpbwAAAAAAAAQAAAAA",
        "AAAAAAAAAbVDb250cm9sbGVyLW9ubHk6IG1pbnQgc2hhcmVzIGZvciBtYXR1cmVkIGRlcG9zaXQgcmVxdWVzdHMgKGJhdGNoZWQsCkZJRk8pIOKAlCB0aGUgZW50cnktc2lkZSBtaXJyb3Igb2YgYHByb2Nlc3Nfd2l0aGRyYXdhbF9xdWV1ZWAuIEVhY2gKbWF0dXJlZCByZXF1ZXN0J3MgZXNjcm93ZWQgYXNzZXRzIGNvbnZlcnQgdG8gc2hhcmVzIGF0IHRoZSBDVVJSRU5UCnNoYXJlIHByaWNlIGFuZCBqb2luIG1hbmFnZWQgYXNzZXRzOyByZXF1ZXN0cyB5b3VuZ2VyIHRoYW4gdGhlIExQCnByaWNpbmcgZGVsYXkgc3RheSBxdWV1ZWQsIGFuZCB0aGUgd2hvbGUgcGFzcyBpcyBhIG5vLW9wIHdoaWxlIGEKcHVibGljIG91dGNvbWUgaXMgdW5zZXR0bGVkLCBzbyBub2JvZHkgaXMgZXZlciBtaW50ZWQgYXQgYSBwcmljZSB0aGF0Cm9taXRzIHJlY29nbml6ZWQgb3IgaW1taW5lbnQgUG5MLgAAAAAAABVwcm9jZXNzX2RlcG9zaXRfcXVldWUAAAAAAAABAAAAAAAAAApjb250cm9sbGVyAAAAAAATAAAAAA==",
        "AAAAAAAAAEJDb250cm9sbGVyLW9ubHk6IGNyZWRpdCByZWNlaXZlZCBwcmVtaXVtIGluY29tZSB0byBtYW5hZ2VkIGFzc2V0cy4AAAAAABVyZWNvcmRfcHJlbWl1bV9pbmNvbWUAAAAAAAACAAAAAAAAAApjb250cm9sbGVyAAAAAAATAAAAAAAAAAZhbW91bnQAAAAAAAsAAAAA",
        "AAAAAAAAAFJDb250cm9sbGVyLW9ubHk6IGRyYWluIHF1ZXVlZCB3aXRoZHJhd2FscyBpbnRvIGNsYWltYWJsZSBiYWxhbmNlcyAoYmF0Y2hlZCwgRklGTykuAAAAAAAYcHJvY2Vzc193aXRoZHJhd2FsX3F1ZXVlAAAAAQAAAAAAAAAKY29udHJvbGxlcgAAAAAAEwAAAAA=",
        "AAAAAAAAAKpSZXR1cm4gdGhlIGNvbmZpZ3VyZWQgb3JhY2xlIGFkZHJlc3MuIFdpcmVkIGF0IGNvbnN0cnVjdGlvbiwgc28gdGhpcwppcyBhbHdheXMgYFNvbWVgIG9uIGEgbGl2ZSB2YXVsdDsgdGhlIGBPcHRpb25gIHNoYXBlIGlzIGtlcHQgZm9yIEFCSQpzdGFiaWxpdHkgd2l0aCBleGlzdGluZyB0b29saW5nLgAAAAAACmdldF9vcmFjbGUAAAAAAAAAAAABAAAD6AAAABM=",
        "AAAAAAAAAClSZXR1cm4gdGhlIGNvbmZpZ3VyZWQgY29udHJvbGxlciBhZGRyZXNzLgAAAAAAAA5nZXRfY29udHJvbGxlcgAAAAAAAAAAAAEAAAAT",
        "AAAAAAAAAPlSZXR1cm4gdGhlIG5vbWluYWwgbWFyZ2luIGFib3ZlIGxvY2tlZCBwYXlvZmYgbGlhYmlsaXRpZXMKKGBUTUEg4oiSIExvY2tlZENhcGl0YWxgKS4gVGhpcyBpcyBhbiBhY2NvdW50aW5nIHZpZXcsIE5PVCB0aGUgZXhpdApnYXRlOiB3aXRoZHJhd2FscyBhcmUgYm91bmRlZCBieSBgZ2V0X3dpdGhkcmF3YWJsZV9jYXBpdGFsYCwgd2hpY2gKYWRkaXRpb25hbGx5IGhvbGRzIGJhY2sgdGhlIGNvbmZpZ3VyZWQgc29sdmVuY3kgcmVzZXJ2ZS4AAAAAAAAQZ2V0X2ZyZWVfY2FwaXRhbAAAAAAAAAABAAAACw==",
        "AAAAAAAAAGBSZXR1cm4gdGhlIGN1cnJlbnQgcGVuZGluZyBkZXBvc2l0IHJlcXVlc3QgcXVldWUgKGVzY3Jvd2VkIExQIGVudHJpZXMKYXdhaXRpbmcgZGVsYXllZCBwcmljaW5nKS4AAAARZ2V0X2RlcG9zaXRfcXVldWUAAAAAAAAAAAAAAQAAA+oAAAfQAAAADkRlcG9zaXRSZXF1ZXN0AAA=",
        "AAAAAAAAADxSZXR1cm4gdGhlIGFtb3VudCBvZiBjYXBpdGFsIGN1cnJlbnRseSBsb2NrZWQgYXMgY29sbGF0ZXJhbC4AAAASZ2V0X2xvY2tlZF9jYXBpdGFsAAAAAAAAAAAAAQAAAAs=",
        "AAAAAAAAAMxSZXR1cm4gdGhlIHNvbHZlbmN5IHJhdGlvIChwZXJjZW50KSB0aGUgdmF1bHQgaG9sZHMgaW4gcmVzZXJ2ZSBhZ2FpbnN0CmxvY2tlZCBjYXBpdGFsLiBQdXNoZWQgYnkgdGhlIGNvbnRyb2xsZXIgYWxvbmdzaWRlIGl0cyBvd24gY29weTsgMTAwCihub21pbmFsIGJhY2tpbmcgb25seSkgdW50aWwgdGhlIGNvbnRyb2xsZXIgZmlyc3QgY29uZmlndXJlcyBpdC4AAAASZ2V0X3NvbHZlbmN5X3JhdGlvAAAAAAAAAAAAAQAAAAQ=",
        "AAAAAAAAADRSZXR1cm4gdGhlIGN1cnJlbnQgcGVuZGluZyB3aXRoZHJhd2FsIHJlcXVlc3QgcXVldWUuAAAAFGdldF93aXRoZHJhd2FsX3F1ZXVlAAAAAAAAAAEAAAPqAAAH0AAAABFXaXRoZHJhd2FsUmVxdWVzdAAAAA==",
        "AAAAAAAAAD5SZXR1cm4gdGhlIGNsYWltYWJsZSAoY29sbGVjdGlibGUpIGJhbGFuY2Ugb3dlZCB0byBhbiBhZGRyZXNzLgAAAAAAFWdldF9jbGFpbWFibGVfYmFsYW5jZQAAAAAAAAEAAAAAAAAAB2FkZHJlc3MAAAAAEwAAAAEAAAAL",
        "AAAAAAAAAHJSZXR1cm4gdGhlIG51bWJlciBvZiBwZW5kaW5nIGRlcG9zaXQgcmVxdWVzdHMg4oCUIHRoZSBlbnRyeS1zaWRlCm9jY3VwYW5jeSBnYXVnZSAoc2VlIGBnZXRfd2l0aGRyYXdhbF9xdWV1ZV9sZW5gKS4AAAAAABVnZXRfZGVwb3NpdF9xdWV1ZV9sZW4AAAAAAAAAAAAAAQAAAAQ=",
        "AAAAAAAAADZSZXR1cm4gdGhlIHRvdGFsIGFzc2V0cyB1bmRlciBtYW5hZ2VtZW50IGJ5IHRoZSB2YXVsdC4AAAAAABhnZXRfdG90YWxfbWFuYWdlZF9hc3NldHMAAAAAAAAAAQAAAAs=",
        "AAAAAAAAAa1SZXR1cm4gdGhlIGNhcGl0YWwgTFAgZXhpdHMgbWF5IHJlbW92ZToKYG1heChUTUEg4oiSIGNlaWwoTG9ja2VkQ2FwaXRhbCDDlyBTb2x2ZW5jeVJhdGlvIC8gMTAwKSwgMClgLgpUaGUgc2FtZSByZXF1aXJlZC1iYWNraW5nIGZvcm11bGEgdGhlIGNvbnRyb2xsZXIgYWRtaXRzIG5ldyBwb2xpY2llcwphZ2FpbnN0IOKAlCB1c2luZyB0aGUgbm9taW5hbCBtYXJnaW4gaGVyZSBpbnN0ZWFkIHdvdWxkIGxldCBleGl0cyBkcmFpbgp0aGUgY29uZmlndXJlZCByZXNlcnZlIGRvd24gdG8gMTAwJSBiYWNraW5nIHRoZSBtb21lbnQgYSBwdXJjaGFzZQpwYXNzZWQuIEdhdGVzIHdpdGhkcmF3YWwtcXVldWUgcHJvY2Vzc2luZyDigJQgdGhlIG9ubHkgTFAgZXhpdCBwYXRoIG5vdwp0aGF0IHRoZSBpbW1lZGlhdGUgZXhpdCBvcGVyYXRpb25zIGFyZSBkaXNhYmxlZC4AAAAAAAAYZ2V0X3dpdGhkcmF3YWJsZV9jYXBpdGFsAAAAAAAAAAEAAAAL",
        "AAAAAAAAARJSZXR1cm4gdGhlIG51bWJlciBvZiBwZW5kaW5nIHdpdGhkcmF3YWwgcmVxdWVzdHMuIENoZWFwIHNhdHVyYXRpb24KZ2F1Z2UgZm9yIG9wZXJhdG9yczogdGhlIHF1ZXVlIGlzIGNhcHBlZCwgc28gb2NjdXBhbmN5IGFwcHJvYWNoaW5nIHRoZQpjYXAgbWVhbnMgbmV3IGV4aXQgcmVxdWVzdHMgYXJlIGFib3V0IHRvIGJlIHJlamVjdGVkIGFuZCB3YXJyYW50cwppbnRlcnZlbnRpb24gKG1vcmUgZnJlcXVlbnQgZHJhaW5pbmcsIG9yIHJhaXNpbmcgdGhlIHJlcXVlc3QgbWluaW11bSkuAAAAAAAYZ2V0X3dpdGhkcmF3YWxfcXVldWVfbGVuAAAAAAAAAAEAAAAE",
        "AAAAAAAAAG9SZXR1cm4gdGhlIG1pbmltdW0gYXNzZXQgdmFsdWUgYSBxdWV1ZWQgcmVxdWVzdCAod2l0aGRyYXdhbCBvcgpkZXBvc2l0KSBtdXN0IGNhcnJ5ICgwID0gbm8gbWluaW11bSBjb25maWd1cmVkKS4AAAAAGmdldF9taW5fd2l0aGRyYXdhbF9yZXF1ZXN0AAAAAAAAAAAAAQAAAAs=",
        "AAAAAgAAAOxNb2RlIGZvciBgcmVjb3Zlcl91bmNvbGxlY3RlZGAg4oCUIG93bmVyLWRyaXZlbiBtYW51YWwgcmVjb3Zlcnkgb2YgYW4KYXJjaGl2ZWQgYENsYWltYWJsZUJhbGFuY2VgIGVudHJ5LiBDYXJyaWVkIG9uIHRoZSB3aXJlIHZpYSB0aGUKYHZhdWx0LnJlY292ZXJlZGAgZXZlbnQgc28gdGhlIG9mZi1jaGFpbiBpbmRleGVyIGNhbiB1cGRhdGUgaXRzCmBjbGFpbWFibGVfYmFsYW5jZXNgIHRhYmxlIGFjY29yZGluZ2x5LgAAAAAAAAAMUmVjb3ZlcnlNb2RlAAAAAgAAAAAAAADFUmUtY3JlZGl0IGBDbGFpbWFibGVCYWxhbmNlKHVzZXIpID0gYW1vdW50YC4gU2V0cyAobm90IGFkZHMpIHNvIHRoZQpvd25lciBwcm92aWRlcyB0aGUgZnVsbCBvd2VkIGFtb3VudCByZWNvbnN0cnVjdGVkIGZyb20gZXZlbnQgbG9ncy4KRnV0dXJlIGBwcm9jZXNzX3dpdGhkcmF3YWxfcXVldWVgIGNyZWRpdHMgQUREIG9uIHRvcCBub3JtYWxseS4AAAAAAAAIUmVjcmVkaXQAAAAAAAAAflRyYW5zZmVyIGFzc2V0IGRpcmVjdGx5IGZyb20gdmF1bHQgdG8gdXNlci4gTm8gYENsYWltYWJsZUJhbGFuY2VgCnN0b3JhZ2Ugd3JpdGUuIEluZGV4ZXIgREVMRVRFcyB0aGUgYWRkcmVzcyBmcm9tIGl0cyB0cmFja2VyLgAAAAAACFRyYW5zZmVy",
        "AAAAAQAAARRBIHBlbmRpbmcgTFAgZW50cnk6IGBhc3NldHNgIHNpdCBlc2Nyb3dlZCBpbiB0aGUgdmF1bHQgKGV4Y2x1ZGVkIGZyb20KbWFuYWdlZCBhc3NldHMpIHVudGlsIHRoZSByZXF1ZXN0IG1hdHVyZXMgcGFzdCB0aGUgTFAgcHJpY2luZyBkZWxheSBhbmQKcXVldWUgcHJvY2Vzc2luZyBtaW50cyBzaGFyZXMgYXQgdGhlIHRoZW4tY3VycmVudCDigJQgcG9zdC1vdXRjb21lIOKAlCBzaGFyZQpwcmljZS4gU2VlIGBXaXRoZHJhd2FsUmVxdWVzdGAgb24gd2h5IHByaWNpbmcgaXMgZGVsYXllZC4AAAAAAAAADkRlcG9zaXRSZXF1ZXN0AAAAAAAEAAAAAAAAAAZhc3NldHMAAAAAAAsAAAAAAAAABW93bmVyAAAAAAAAEwAAAAAAAAAKcmVxdWVzdF9pZAAAAAAABgAAAAAAAAAMcmVxdWVzdGVkX2F0AAAABg==",
        "AAAAAQAAAAAAAAAAAAAAEVdpdGhkcmF3YWxSZXF1ZXN0AAAAAAAABAAAAAAAAAAFb3duZXIAAAAAAAATAAAAAAAAAApyZXF1ZXN0X2lkAAAAAAAGAAAAAAAAAAxyZXF1ZXN0ZWRfYXQAAAAGAAAAAAAAAAZzaGFyZXMAAAAAAAs=",
        "AAAAAAAAAG9Pd25lci1nYXRlZCBXYXNtIHVwZ3JhZGUuIERlbGVnYXRlcyB0byB0aGUgc2hhcmVkIGltcGxlbWVudGF0aW9uLCB3aGljaAphbHNvIGJ1bXBzIHRoZSBzdG9yZWQgb24tY2hhaW4gdmVyc2lvbi4AAAAAB3VwZ3JhZGUAAAAAAQAAAAAAAAAJd2FzbV9oYXNoAAAAAAAD7gAAACAAAAAA",
        "AAAAAAAAACJDdXJyZW50IG9uLWNoYWluIGNvbnRyYWN0IHZlcnNpb24uAAAAAAAHdmVyc2lvbgAAAAAAAAAAAQAAAAQ=",
        "AAAAAAAABABSZWNvcmQgdG9kYXkncyBzaGFyZSBwcmljZSBpbnRvIHRlbXBvcmFyeSBzdG9yYWdlIGFuZCBlbWl0IGl0LgoKQWNjZXNzIGNvbnRyb2w6ICoqaW50ZW50aW9uYWxseSBwZXJtaXNzaW9ubGVzcyoqIOKAlCBhbnkgYWRkcmVzcyBtYXkgY2FsbAp0aGlzLCBieSBkZXNpZ24uIEl0IGlzIGEga2VlcGVyL2Nyb24gZW50cnlwb2ludCBtZWFudCB0byBiZSB0cmlnZ2VyZWQKYnkgdGhlIG9mZi1jaGFpbiBzY2hlZHVsZXIsIGJ1dCBhbnlvbmUgaXMgYWxsb3dlZCB0byBrZWVwIHRoZSBkYWlseSBwcmljZQpzZXJpZXMgYWxpdmUuIFRoaXMgaXMgc2FmZSBiZWNhdXNlIHRoZSBmdW5jdGlvbjoKLSBtb3ZlcyBubyBmdW5kcyBhbmQgbXV0YXRlcyBubyBjYXBpdGFsL2xvY2tlZCBhY2NvdW50aW5nIOKAlCBpdCBvbmx5CndyaXRlcyBhIGRlcml2ZWQgcHJpY2UgaW50byB0ZW1wb3Jhcnkgc3RvcmFnZSBhbmQgZW1pdHMgYW4gZXZlbnQ7Ci0gY2Fubm90IGJlIG1hbmlwdWxhdGVkIGJ5IHRoZSBjYWxsZXIg4oCUIHRoZSBwcmljZSBpcyBjb21wdXRlZCBzb2xlbHkKZnJvbSBvbi1jaGFpbiBzdGF0ZSwgc28gYSBjYWxsZXIgY29udHJvbHMgb25seSAqd2hlbiogaXQgcnVucywgbmV2ZXIKdGhlIHJlY29yZGVkIHZhbHVlOwotIGlzIGlkZW1wb3RlbnQgYW5kIHJhdGUtbGltaXRlZCDigJQgaXQgbm8tb3BzIGlmIGEgc25hcHNob3QgYWxyZWFkeQpleGlzdHMgZm9yIHRoZSBjdXJyZW50IGRheSAoc2VlIHRoZSBndWFyZCBiZWxvdyksIHNvIHJlcGVhdGVkIG9yCmFkdmVyc2FyaWFsIGNhbGxzIGNvc3QgdGhlIGNhbGxlciBnYXMgYnV0IGNoYW5nZSBub3RoaW5nLgoKT25lIHJlc2lkdWFsIGNhbGxlciBkZWdyZWUgb2YgZnJlZWRvbTogV0hJQ0ggbW9tZW50IHdpdGhpbiB0aGUgZGF5IGlzCnJlY29yZGVkLiBBbiBlYXJseSBjYWxsZXIgY2FuIHBpbiB0aGUgZGF5J3MgcHJpY2UgYmVmb3JlIHRoYXQgZGF5J3MKc2V0dGxlbWVudHMgbGFuZCAodGhlIHBlbmRpbmctb3V0Y29tZXMgZ3VhcmQgYmVsb3cgb25seSBkZWZlcnMgd2hpAAAACHNuYXBzaG90AAAAAAAAAAA=",
        "AAAAAAAAAEhSZXR1cm4gdGhlIHJlY29yZGVkIHNoYXJlIHByaWNlIGZvciB0aGUgZ2l2ZW4gZGF5ICgwIGlmIGV4cGlyZWQvYWJzZW50KS4AAAASZ2V0X3NuYXBzaG90X3ByaWNlAAAAAAABAAAAAAAAAANkYXkAAAAABgAAAAEAAAAL",
        "AAAAAAAAAHNEaXNhYmxlZCDigJQgc2VlIGBkZXBvc2l0YC4gVGhlcmUgaXMgbm8gc2hhcmUtZGVub21pbmF0ZWQgcmVxdWVzdCBwYXRoOwp1c2UgYHJlcXVlc3RfZGVwb3NpdGAgd2l0aCBhbiBhc3NldCBhbW91bnQuAAAAAARtaW50AAAABAAAAAAAAAAGc2hhcmVzAAAAAAALAAAAAAAAAAhyZWNlaXZlcgAAABMAAAAAAAAABGZyb20AAAATAAAAAAAAAAhvcGVyYXRvcgAAABMAAAABAAAACw==",
        "AAAAAAAAAEpEaXNhYmxlZCDigJQgc2VlIGB3aXRoZHJhd2AuIFVzZSBgcmVxdWVzdF93aXRoZHJhd2FsYCB3aXRoIGEgc2hhcmUKYW1vdW50LgAAAAAABnJlZGVlbQAAAAAABAAAAAAAAAAGc2hhcmVzAAAAAAALAAAAAAAAAAhyZWNlaXZlcgAAABMAAAAAAAAABW93bmVyAAAAAAAAEwAAAAAAAAAIb3BlcmF0b3IAAAATAAAAAQAAAAs=",
        "AAAAAAAAAQxEaXNhYmxlZC4gTFAgZW50cnkgaXMgdHdvLXBoYXNlOiBgcmVxdWVzdF9kZXBvc2l0YCBlc2Nyb3dzIHRoZSBhc3NldHMKYW5kIHF1ZXVlIHByb2Nlc3NpbmcgbWludHMgc2hhcmVzIGF0IHRoZSBkZWxheWVkLCBwb3N0LW91dGNvbWUgcHJpY2UuCkFuIGltbWVkaWF0ZSBkZXBvc2l0IHdvdWxkIHByaWNlIGF0IGNhbGwgdGltZSDigJQgc3RhbGUgd2l0aCByZXNwZWN0IHRvCmFueSBvdXRjb21lIHRoYXQgaXMgcHVibGljIGJ1dCBub3QgeWV0IHdyaXR0ZW4gb24tY2hhaW4uAAAAB2RlcG9zaXQAAAAABAAAAAAAAAAGYXNzZXRzAAAAAAALAAAAAAAAAAhyZWNlaXZlcgAAABMAAAAAAAAABGZyb20AAAATAAAAAAAAAAhvcGVyYXRvcgAAABMAAAABAAAACw==",
        "AAAAAAAAADtSZXR1cm5zIHplcm8g4oCUIGltbWVkaWF0ZSBtaW50cyBhcmUgZGlzYWJsZWQgKHNlZSBgbWludGApLgAAAAAIbWF4X21pbnQAAAABAAAAAAAAAAdhZGRyZXNzAAAAABMAAAABAAAACw==",
        "AAAAAAAAAJhEaXNhYmxlZC4gTFAgZXhpdCBpcyB0d28tcGhhc2U6IGByZXF1ZXN0X3dpdGhkcmF3YWxgIGVzY3Jvd3MgdGhlCnNoYXJlcyBhbmQgcXVldWUgcHJvY2Vzc2luZyBwYXlzIG91dCBhdCB0aGUgZGVsYXllZCwgcG9zdC1vdXRjb21lCnByaWNlLiBTZWUgYGRlcG9zaXRgLgAAAAh3aXRoZHJhdwAAAAQAAAAAAAAABmFzc2V0cwAAAAAACwAAAAAAAAAIcmVjZWl2ZXIAAAATAAAAAAAAAAVvd25lcgAAAAAAABMAAAAAAAAACG9wZXJhdG9yAAAAEwAAAAEAAAAL",
        "AAAAAAAAAENSZXR1cm5zIHplcm8g4oCUIGltbWVkaWF0ZSByZWRlbXB0aW9ucyBhcmUgZGlzYWJsZWQgKHNlZSBgcmVkZWVtYCkuAAAAAAptYXhfcmVkZWVtAAAAAAABAAAAAAAAAAVvd25lcgAAAAAAABMAAAABAAAACw==",
        "AAAAAAAAAAAAAAALbWF4X2RlcG9zaXQAAAAAAQAAAAAAAAAHYWRkcmVzcwAAAAATAAAAAQAAAAs=",
        "AAAAAAAAADJSZXR1cm5zIHRoZSBhZGRyZXNzIG9mIHRoZSB1bmRlcmx5aW5nIGFzc2V0IHRva2VuLgAAAAAAC3F1ZXJ5X2Fzc2V0AAAAAAAAAAABAAAAEw==",
        "AAAAAAAAAEVSZXR1cm5zIHplcm8g4oCUIGltbWVkaWF0ZSB3aXRoZHJhd2FscyBhcmUgZGlzYWJsZWQgKHNlZSBgd2l0aGRyYXdgKS4AAAAAAAAMbWF4X3dpdGhkcmF3AAAAAQAAAAAAAAAFb3duZXIAAAAAAAATAAAAAQAAAAs=",
        "AAAAAAAAAD5QcmV2aWV3cyB0aGUgYXNzZXRzIHJlcXVpcmVkIHRvIG1pbnQgYSBnaXZlbiBudW1iZXIgb2Ygc2hhcmVzLgAAAAAADHByZXZpZXdfbWludAAAAAEAAAAAAAAABnNoYXJlcwAAAAAACwAAAAEAAAAL",
        "AAAAAAAAAKlSZXR1cm5zIHRoZSB2YXVsdCdzIG5ldCBiYWNraW5nIGFzc2V0cyDigJQgdGhlIGludGVybmFsbHkgdHJhY2tlZCBtYW5hZ2VkCmFzc2V0cywgTk9UIHRoZSByYXcgdG9rZW4gYmFsYW5jZSAod2hpY2ggaW5jbHVkZXMgb3dlZC1idXQtdW5jb2xsZWN0ZWQKd2l0aGRyYXdhbCBsaWFiaWxpdGllcykuAAAAAAAADHRvdGFsX2Fzc2V0cwAAAAAAAAABAAAACw==",
        "AAAAAAAAAFJQcmV2aWV3cyB0aGUgYXNzZXRzIHRoYXQgd291bGQgYmUgcmV0dXJuZWQgZm9yIHJlZGVlbWluZyBhIGdpdmVuIG51bWJlciBvZiBzaGFyZXMuAAAAAAAOcHJldmlld19yZWRlZW0AAAAAAAEAAAAAAAAABnNoYXJlcwAAAAAACwAAAAEAAAAL",
        "AAAAAAAAAKNQcmV2aWV3cyB0aGUgc2hhcmVzIGEgZGVwb3NpdCBvZiBgYXNzZXRzYCB3b3VsZCBtaW50IGF0IHRoZSBDVVJSRU5UCnNoYXJlIHByaWNlLiBJbmZvcm1hdGlvbmFsIOKAlCBhIHF1ZXVlZCBkZXBvc2l0IGlzIHByaWNlZCBhdApwcm9jZXNzaW5nIHRpbWUsIG5vdCByZXF1ZXN0IHRpbWUuAAAAAA9wcmV2aWV3X2RlcG9zaXQAAAAAAQAAAAAAAAAGYXNzZXRzAAAAAAALAAAAAQAAAAs=",
        "AAAAAAAAAE5QcmV2aWV3cyB0aGUgc2hhcmVzIHRoYXQgd291bGQgYmUgYnVybmVkIHRvIHdpdGhkcmF3IGEgZ2l2ZW4gYW1vdW50IG9mIGFzc2V0cy4AAAAAABBwcmV2aWV3X3dpdGhkcmF3AAAAAQAAAAAAAAAGYXNzZXRzAAAAAAALAAAAAQAAAAs=",
        "AAAAAAAAAD9Db252ZXJ0cyBhIG51bWJlciBvZiBzaGFyZXMgdG8gdGhlIGVxdWl2YWxlbnQgYW1vdW50IG9mIGFzc2V0cy4AAAAAEWNvbnZlcnRfdG9fYXNzZXRzAAAAAAAAAQAAAAAAAAAGc2hhcmVzAAAAAAALAAAAAQAAAAs=",
        "AAAAAAAAAEBDb252ZXJ0cyBhbiBhbW91bnQgb2YgYXNzZXRzIHRvIHRoZSBlcXVpdmFsZW50IG51bWJlciBvZiBzaGFyZXMuAAAAEWNvbnZlcnRfdG9fc2hhcmVzAAAAAAAAAQAAAAAAAAAGYXNzZXRzAAAAAAALAAAAAQAAAAs=",
        "AAAABQAAATFBdWRpdC10cmFpbCBldmVudCBlbWl0dGVkIG9uIGV2ZXJ5IGNvbnRyYWN0IHVwZ3JhZGUuIERlZmluZWQgaGVyZSAocmF0aGVyCnRoYW4gcGVyLWNvbnRyYWN0KSBzbyBldmVyeSBjb250cmFjdCdzIHVwZ3JhZGUgbGVhdmVzIGFuIGlkZW50aWNhbCB0cmFpbC4KVGhlIGVtaXR0aW5nIGNvbnRyYWN0IGFkZHJlc3MgcmlkZXMgdGhlIGV2ZW50IGVudmVsb3BlLCBzbyBvZmYtY2hhaW4KaW5kZXhlcnMga25vdyAqd2hpY2gqIGNvbnRyYWN0IHdhcyB1cGdyYWRlZDsgYHdhc21faGFzaGAgYW5kIGB2ZXJzaW9uYApyZWNvcmQgKnRvIHdoYXQqLgAAAAAAAAAAAAAQQ29udHJhY3RVcGdyYWRlZAAAAAIAAAAIc2VudGluZWwAAAAHdXBncmFkZQAAAAACAAAAAAAAAAl3YXNtX2hhc2gAAAAAAAPuAAAAIAAAAAEAAAAAAAAAB3ZlcnNpb24AAAAABAAAAAAAAAAA",
        "AAAABAAAAAAAAAAAAAAAEVJvbGVUcmFuc2ZlckVycm9yAAAAAAAABAAAAAAAAAARTm9QZW5kaW5nVHJhbnNmZXIAAAAAAAiYAAAAAAAAABZJbnZhbGlkTGl2ZVVudGlsTGVkZ2VyAAAAAAiZAAAAAAAAABVJbnZhbGlkUGVuZGluZ0FjY291bnQAAAAAAAiaAAAAAAAAAA9UcmFuc2ZlckV4cGlyZWQAAAAImw==",
        "AAAABAAAAAAAAAAAAAAADE93bmFibGVFcnJvcgAAAAMAAAAAAAAAC093bmVyTm90U2V0AAAACDQAAAAAAAAAElRyYW5zZmVySW5Qcm9ncmVzcwAAAAAINQAAAAAAAAAPT3duZXJBbHJlYWR5U2V0AAAACDY=",
        "AAAABQAAADZFdmVudCBlbWl0dGVkIHdoZW4gYW4gb3duZXJzaGlwIHRyYW5zZmVyIGlzIGluaXRpYXRlZC4AAAAAAAAAAAART3duZXJzaGlwVHJhbnNmZXIAAAAAAAABAAAAEm93bmVyc2hpcF90cmFuc2ZlcgAAAAAAAwAAAAAAAAAJb2xkX293bmVyAAAAAAAAEwAAAAAAAAAAAAAACW5ld19vd25lcgAAAAAAABMAAAAAAAAAAAAAABFsaXZlX3VudGlsX2xlZGdlcgAAAAAAAAQAAAAAAAAAAg==",
        "AAAABQAAACpFdmVudCBlbWl0dGVkIHdoZW4gb3duZXJzaGlwIGlzIHJlbm91bmNlZC4AAAAAAAAAAAAST3duZXJzaGlwUmVub3VuY2VkAAAAAAABAAAAE293bmVyc2hpcF9yZW5vdW5jZWQAAAAAAQAAAAAAAAAJb2xkX293bmVyAAAAAAAAEwAAAAAAAAAC",
        "AAAABQAAADZFdmVudCBlbWl0dGVkIHdoZW4gYW4gb3duZXJzaGlwIHRyYW5zZmVyIGlzIGNvbXBsZXRlZC4AAAAAAAAAAAAaT3duZXJzaGlwVHJhbnNmZXJDb21wbGV0ZWQAAAAAAAEAAAAcb3duZXJzaGlwX3RyYW5zZmVyX2NvbXBsZXRlZAAAAAEAAAAAAAAACW5ld19vd25lcgAAAAAAABMAAAAAAAAAAg==",
        "AAAABAAAAAAAAAAAAAAAFlNvcm9iYW5GaXhlZFBvaW50RXJyb3IAAAAAAAIAAAAcQXJpdGhtZXRpYyBvdmVyZmxvdyBvY2N1cnJlZAAAAAhPdmVyZmxvdwAABdwAAAAQRGl2aXNpb24gYnkgemVybwAAAA5EaXZpc2lvbkJ5WmVybwAAAAAF3Q==",
        "AAAABQAAACpFdmVudCBlbWl0dGVkIHdoZW4gdGhlIGNvbnRyYWN0IGlzIHBhdXNlZC4AAAAAAAAAAAAGUGF1c2VkAAAAAAABAAAABnBhdXNlZAAAAAAAAAAAAAI=",
        "AAAABQAAACxFdmVudCBlbWl0dGVkIHdoZW4gdGhlIGNvbnRyYWN0IGlzIHVucGF1c2VkLgAAAAAAAAAIVW5wYXVzZWQAAAABAAAACHVucGF1c2VkAAAAAAAAAAI=",
        "AAAABAAAAAAAAAAAAAAADVBhdXNhYmxlRXJyb3IAAAAAAAACAAAANFRoZSBvcGVyYXRpb24gZmFpbGVkIGJlY2F1c2UgdGhlIGNvbnRyYWN0IGlzIHBhdXNlZC4AAAANRW5mb3JjZWRQYXVzZQAAAAAAA+gAAAA4VGhlIG9wZXJhdGlvbiBmYWlsZWQgYmVjYXVzZSB0aGUgY29udHJhY3QgaXMgbm90IHBhdXNlZC4AAAANRXhwZWN0ZWRQYXVzZQAAAAAAA+k=",
        "AAAABAAAAAAAAAAAAAAAD1ZhdWx0VG9rZW5FcnJvcgAAAAALAAAANkluZGljYXRlcyBhY2Nlc3MgdG8gdW5pbml0aWFsaXplZCB2YXVsdCBhc3NldCBhZGRyZXNzLgAAAAAAF1ZhdWx0QXNzZXRBZGRyZXNzTm90U2V0AAAAAZAAAAAySW5kaWNhdGVzIHRoYXQgdmF1bHQgYXNzZXQgYWRkcmVzcyBpcyBhbHJlYWR5IHNldC4AAAAAABtWYXVsdEFzc2V0QWRkcmVzc0FscmVhZHlTZXQAAAABkQAAADxJbmRpY2F0ZXMgdGhhdCB2YXVsdCB2aXJ0dWFsIGRlY2ltYWxzIG9mZnNldCBpcyBhbHJlYWR5IHNldC4AAAAkVmF1bHRWaXJ0dWFsRGVjaW1hbHNPZmZzZXRBbHJlYWR5U2V0AAABkgAAADdJbmRpY2F0ZXMgdGhlIGFtb3VudCBpcyBub3QgYSB2YWxpZCB2YXVsdCBhc3NldHMgdmFsdWUuAAAAABhWYXVsdEludmFsaWRBc3NldHNBbW91bnQAAAGTAAAAN0luZGljYXRlcyB0aGUgYW1vdW50IGlzIG5vdCBhIHZhbGlkIHZhdWx0IHNoYXJlcyB2YWx1ZS4AAAAAGFZhdWx0SW52YWxpZFNoYXJlc0Ftb3VudAAAAZQAAABBQXR0ZW1wdGVkIHRvIGRlcG9zaXQgbW9yZSBhc3NldHMgdGhhbiB0aGUgbWF4IGFtb3VudCBmb3IgYWRkcmVzcy4AAAAAAAAXVmF1bHRFeGNlZWRlZE1heERlcG9zaXQAAAABlQAAAD5BdHRlbXB0ZWQgdG8gbWludCBtb3JlIHNoYXJlcyB0aGFuIHRoZSBtYXggYW1vdW50IGZvciBhZGRyZXNzLgAAAAAAFFZhdWx0RXhjZWVkZWRNYXhNaW50AAABlgAAAEJBdHRlbXB0ZWQgdG8gd2l0aGRyYXcgbW9yZSBhc3NldHMgdGhhbiB0aGUgbWF4IGFtb3VudCBmb3IgYWRkcmVzcy4AAAAAABhWYXVsdEV4Y2VlZGVkTWF4V2l0aGRyYXcAAAGXAAAAQEF0dGVtcHRlZCB0byByZWRlZW0gbW9yZSBzaGFyZXMgdGhhbiB0aGUgbWF4IGFtb3VudCBmb3IgYWRkcmVzcy4AAAAWVmF1bHRFeGNlZWRlZE1heFJlZGVlbQAAAAABmAAAACpNYXhpbXVtIG51bWJlciBvZiBkZWNpbWFscyBvZmZzZXQgZXhjZWVkZWQAAAAAAB5WYXVsdE1heERlY2ltYWxzT2Zmc2V0RXhjZWVkZWQAAAAAAZkAAAAxSW5kaWNhdGVzIG92ZXJmbG93IGR1ZSB0byBtYXRoZW1hdGljYWwgb3BlcmF0aW9ucwAAAAAAAAxNYXRoT3ZlcmZsb3cAAAGa",
        "AAAABQAAACxFdmVudCBlbWl0dGVkIHdoZW4gYW4gYWxsb3dhbmNlIGlzIGFwcHJvdmVkLgAAAAAAAAAHQXBwcm92ZQAAAAABAAAAB2FwcHJvdmUAAAAABAAAAAAAAAAFb3duZXIAAAAAAAATAAAAAQAAAAAAAAAHc3BlbmRlcgAAAAATAAAAAQAAAAAAAAAGYW1vdW50AAAAAAALAAAAAAAAAAAAAAARbGl2ZV91bnRpbF9sZWRnZXIAAAAAAAAEAAAAAAAAAAI=",
        "AAAABQAAASFFdmVudCBlbWl0dGVkIHdoZW4gdG9rZW5zIGFyZSB0cmFuc2ZlcnJlZCBiZXR3ZWVuIGFkZHJlc3NlcyB3aXRob3V0IGEKbXV4ZWQgZGVzdGluYXRpb24uCgpQZXIgU0VQLTQxLCB0aGUgZXZlbnQgZGF0YSBpcyBhIGJhcmUgYGkxMjhgIHdoZW4gbm8gbXV4ZWQgYWRkcmVzcyBpcwppbnZvbHZlZC4gVGhlIGBkYXRhX2Zvcm1hdCA9ICJzaW5nbGUtdmFsdWUiYCBhdHRyaWJ1dGUgZW5zdXJlcyB0aGUKYGFtb3VudGAgZmllbGQgaXMgc2VyaWFsaXplZCBhcyBhIGJhcmUgdmFsdWUgcmF0aGVyIHRoYW4gYSBtYXAuAAAAAAAAAAAAAAhUcmFuc2ZlcgAAAAEAAAAIdHJhbnNmZXIAAAADAAAAAAAAAARmcm9tAAAAEwAAAAEAAAAAAAAAAnRvAAAAAAATAAAAAQAAAAAAAAAGYW1vdW50AAAAAAALAAAAAAAAAAA=",
        "AAAABQAAAZdFdmVudCBlbWl0dGVkIHdoZW4gdG9rZW5zIGFyZSB0cmFuc2ZlcnJlZCB0byBhIG11eGVkIGFkZHJlc3MuCgpQZXIgU0VQLTQxLCB3aGVuIHRoZSBkZXN0aW5hdGlvbiBpcyBhIFtgTXV4ZWRBZGRyZXNzYF0gdGhlIGV2ZW50IGRhdGEKY2FycmllcyBib3RoIHRoZSBhbW91bnQgYW5kIHRoZSBtdXhlZCBpZGVudGlmaWVyIHNvIHRoYXQgb2ZmLWNoYWluCmNvbnN1bWVycyBjYW4gYXR0cmlidXRlIHRoZSB0cmFuc2ZlciB0byB0aGUgY29ycmVjdCBzdWItYWNjb3VudC4KClVzZXMgYHRvcGljcyA9IFsidHJhbnNmZXIiXWAgc28gdGhhdCBib3RoIFtgVHJhbnNmZXJgXSBhbmQKW2BNdXhlZFRyYW5zZmVyYF0gc2hhcmUgdGhlIHNhbWUgYCJ0cmFuc2ZlciJgIGV2ZW50IHN5bWJvbCwgYXMgcmVxdWlyZWQKYnkgU0VQLTQxLgAAAAAAAAAADU11eGVkVHJhbnNmZXIAAAAAAAABAAAACHRyYW5zZmVyAAAABAAAAAAAAAAEZnJvbQAAABMAAAABAAAAAAAAAAJ0bwAAAAAAEwAAAAEAAAAAAAAAC3RvX211eGVkX2lkAAAAA+gAAAAGAAAAAAAAAAAAAAAGYW1vdW50AAAAAAALAAAAAAAAAAI=",
        "AAAABAAAAAAAAAAAAAAAEkZ1bmdpYmxlVG9rZW5FcnJvcgAAAAAADwAAAG5JbmRpY2F0ZXMgYW4gZXJyb3IgcmVsYXRlZCB0byB0aGUgY3VycmVudCBiYWxhbmNlIG9mIGFjY291bnQgZnJvbSB3aGljaAp0b2tlbnMgYXJlIGV4cGVjdGVkIHRvIGJlIHRyYW5zZmVycmVkLgAAAAAAE0luc3VmZmljaWVudEJhbGFuY2UAAAAAZAAAAGRJbmRpY2F0ZXMgYSBmYWlsdXJlIHdpdGggdGhlIGFsbG93YW5jZSBtZWNoYW5pc20gd2hlbiBhIGdpdmVuIHNwZW5kZXIKZG9lc24ndCBoYXZlIGVub3VnaCBhbGxvd2FuY2UuAAAAFUluc3VmZmljaWVudEFsbG93YW5jZQAAAAAAAGUAAABNSW5kaWNhdGVzIGFuIGludmFsaWQgdmFsdWUgZm9yIGBsaXZlX3VudGlsX2xlZGdlcmAgd2hlbiBzZXR0aW5nIGFuCmFsbG93YW5jZS4AAAAAAAAWSW52YWxpZExpdmVVbnRpbExlZGdlcgAAAAAAZgAAADJJbmRpY2F0ZXMgYW4gZXJyb3Igd2hlbiBhbiBpbnB1dCB0aGF0IG11c3QgYmUgPj0gMAAAAAAADExlc3NUaGFuWmVybwAAAGcAAAApSW5kaWNhdGVzIG92ZXJmbG93IHdoZW4gYWRkaW5nIHR3byB2YWx1ZXMAAAAAAAAMTWF0aE92ZXJmbG93AAAAaAAAACpJbmRpY2F0ZXMgYWNjZXNzIHRvIHVuaW5pdGlhbGl6ZWQgbWV0YWRhdGEAAAAAAA1VbnNldE1ldGFkYXRhAAAAAAAAaQAAAFJJbmRpY2F0ZXMgdGhhdCB0aGUgb3BlcmF0aW9uIHdvdWxkIGhhdmUgY2F1c2VkIGB0b3RhbF9zdXBwbHlgIHRvIGV4Y2VlZAp0aGUgYGNhcGAuAAAAAAALRXhjZWVkZWRDYXAAAAAAagAAADZJbmRpY2F0ZXMgdGhlIHN1cHBsaWVkIGBjYXBgIGlzIG5vdCBhIHZhbGlkIGNhcCB2YWx1ZS4AAAAAAApJbnZhbGlkQ2FwAAAAAABrAAAAHkluZGljYXRlcyB0aGUgQ2FwIHdhcyBub3Qgc2V0LgAAAAAACUNhcE5vdFNldAAAAAAAAGwAAAAmSW5kaWNhdGVzIHRoZSBTQUMgYWRkcmVzcyB3YXMgbm90IHNldC4AAAAAAAlTQUNOb3RTZXQAAAAAAABtAAAAMEluZGljYXRlcyBhIFNBQyBhZGRyZXNzIGRpZmZlcmVudCB0aGFuIGV4cGVjdGVkLgAAABJTQUNBZGRyZXNzTWlzbWF0Y2gAAAAAAG4AAABDSW5kaWNhdGVzIGEgbWlzc2luZyBmdW5jdGlvbiBwYXJhbWV0ZXIgaW4gdGhlIFNBQyBjb250cmFjdCBjb250ZXh0LgAAAAARU0FDTWlzc2luZ0ZuUGFyYW0AAAAAAABvAAAAREluZGljYXRlcyBhbiBpbnZhbGlkIGZ1bmN0aW9uIHBhcmFtZXRlciBpbiB0aGUgU0FDIGNvbnRyYWN0IGNvbnRleHQuAAAAEVNBQ0ludmFsaWRGblBhcmFtAAAAAAAAcAAAADFUaGUgdXNlciBpcyBub3QgYWxsb3dlZCB0byBwZXJmb3JtIHRoaXMgb3BlcmF0aW9uAAAAAAAADlVzZXJOb3RBbGxvd2VkAAAAAABxAAAANVRoZSB1c2VyIGlzIGJsb2NrZWQgYW5kIGNhbm5vdCBwZXJmb3JtIHRoaXMgb3BlcmF0aW9uAAAAAAAAC1VzZXJCbG9ja2VkAAAAAHI=" ]),
      options
    )
  }
  public readonly fromJSON = {
    extend_ttl: this.txFromJSON<null>,
        set_oracle: this.txFromJSON<null>,
        set_controller: this.txFromJSON<null>,
        force_set_oracle: this.txFromJSON<null>,
        set_min_withdrawal_request: this.txFromJSON<null>,
        collect: this.txFromJSON<null>,
        cancel_deposit: this.txFromJSON<null>,
        request_deposit: this.txFromJSON<u64>,
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
        set_solvency_ratio: this.txFromJSON<null>,
        process_deposit_queue: this.txFromJSON<null>,
        record_premium_income: this.txFromJSON<null>,
        process_withdrawal_queue: this.txFromJSON<null>,
        get_oracle: this.txFromJSON<Option<string>>,
        get_controller: this.txFromJSON<string>,
        get_free_capital: this.txFromJSON<i128>,
        get_deposit_queue: this.txFromJSON<Array<DepositRequest>>,
        get_locked_capital: this.txFromJSON<i128>,
        get_solvency_ratio: this.txFromJSON<u32>,
        get_withdrawal_queue: this.txFromJSON<Array<WithdrawalRequest>>,
        get_claimable_balance: this.txFromJSON<i128>,
        get_deposit_queue_len: this.txFromJSON<u32>,
        get_total_managed_assets: this.txFromJSON<i128>,
        get_withdrawable_capital: this.txFromJSON<i128>,
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