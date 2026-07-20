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
  601: {message:"ControllerAlreadySet"},
  602: {message:"InvalidTransition"},
  603: {message:"InvalidSettlementStatus"},
  604: {message:"NotAuthorizedOracle"},
  605: {message:"NotAuthorizedController"},
  606: {message:"ActiveFlightListFull"},
  607: {message:"InvalidTimestamp"},
  608: {message:"FlightDataStillPresent"},
  609: {message:"FlightNotInList"},
  610: {message:"StaleTimeoutNotReached"},
  611: {message:"ActiveTimeoutNotReached"}
}










/**
 * Per-flight oracle record, stored under a `(flight_id, date)` key.
 * 
 * The `date` key component is the flight's **UTC departure day** — midnight
 * UTC of the departure date, in unix seconds (a multiple of 86,400; the
 * purchase path enforces the alignment). Executors and frontends MUST
 * derive it from the departure timestamp **in UTC**, never in the airport's
 * local timezone: `set_estimated_arrival` / `set_landed` reject any arrival
 * timestamp below `date`, and a short flight departing early-morning local
 * time east of UTC (e.g. 01:00 JST = 16:00 UTC the previous day) can arrive
 * before midnight UTC of its *local* departure date. A component keying
 * instances by local date would therefore have legitimate outcome writes
 * rejected (`InvalidTimestamp`); the flight would strand in `Active` and be
 * voided as on-time by the active timeout, irreversibly denying genuinely
 * delayed or cancelled travelers. This invariant carries the same weight as
 * the `scheduled_in` rule below and must survive every executor backend
 * migration.
 */
export interface FlightData {
  actual_arrival_time: u64;
  /**
 * The flight's SCHEDULED arrival time (unix seconds) — the timetable
 * value, written once at `NotInitiated → Active`. Delay classification
 * computes `actual_arrival_time − estimated_arrival_time` against the
 * per-route `delay_hours` threshold, so this field is the baseline every
 * payout decision is measured from. Oracle executors MUST write the
 * published schedule (AeroAPI `scheduled_in`), NEVER a delay-adjusted
 * live estimate (`estimated_in`) — a live ETA absorbs announced delays
 * and would classify genuinely delayed flights as on-time, silently
 * denying valid claims.
 */
estimated_arrival_time: u64;
  settled_at: u64;
  status: FlightStatus;
}

export type FlightStatus = {tag: "NotInitiated", values: void} | {tag: "Active", values: void} | {tag: "Landed", values: void} | {tag: "Cancelled", values: void} | {tag: "ToBeSettledOnTime", values: void} | {tag: "ToBeSettledDelayed", values: void} | {tag: "ToBeSettledCancelled", values: void} | {tag: "Settled", values: void};


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

export interface Client {
  /**
   * Construct and simulate a extend_ttl transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Extend instance TTL. Called by cron as a safety net; instance-mutating
   * hot paths also renew it inline so the contract self-heals if the cron
   * lapses.
   */
  extend_ttl: (options?: MethodOptions) => Promise<AssembledTransaction<null>>

  /**
   * Construct and simulate a set_oracle transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Update the authorized oracle address (for backend migration).
   * 
   * Rotation does NOT invalidate outstanding sale authorizations: every
   * window the outgoing oracle opened lives in temporary storage (not
   * enumerable on-chain, so no bulk revoke exists) and keeps authorizing
   * purchases through the controller until it expires — up to
   * `SALE_AUTH_MAX_VALIDITY_SECS` — or is individually closed. For a
   * routine backend migration that is harmless: the windows are honest
   * attestations and the new backend re-attests on its own cadence.
   * 
   * **Rotation as a compromise response is a two-step operation.** The
   * departing key's parting attestations survive the swap, so flights the
   * honest pipeline never verified (including publicly cancelled ones)
   * stay purchasable until each window lapses. Immediately after the
   * swap, the new oracle must sweep `close_sale` over every window still
   * open — reconstructed off-chain from the `SaleOpened`/`SaleClosed`
   * event stream — or the controller must be paused for the full validity
   * horizon so nothing ca
   */
  set_oracle: ({new_oracle}: {new_oracle: string}, options?: MethodOptions) => Promise<AssembledTransaction<null>>

  /**
   * Construct and simulate a set_controller transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Set the authorized controller address. Can only be called once.
   */
  set_controller: ({controller}: {controller: string}, options?: MethodOptions) => Promise<AssembledTransaction<null>>

  /**
   * Construct and simulate a evict_missing_flight transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Remove an active-list entry whose `FlightData` has archived past its
   * TTL (owner-only). `prune_settled` deliberately retains such entries —
   * archived is not settled, and permissionless eviction would strip an
   * unresolved flight from keeper enumeration. Freeing the capped list
   * slot therefore requires the owner to first confirm, off-chain, that
   * the flight needs no further on-chain resolution. **Restoring the
   * archived entry and letting the normal settle pipeline finish is always
   * the preferred path** — eviction removes the flight from keeper
   * enumeration permanently (re-registration of an existing key does not
   * re-add it to the list).
   * 
   * `outcome_pending` must be `true` iff the flight's outcome was already
   * publicly recorded (it reached Landed / Cancelled / ToBeSettled*) and
   * therefore counted toward `PendingOutcomes`. The counter is only ever
   * released by settlement; evicting such a flight without releasing its
   * count would leave the vault's entry/exit barrier engaged forever, with
   * no remaining on-chain path to decreme
   */
  evict_missing_flight: ({flight_id, date, outcome_pending}: {flight_id: string, date: u64, outcome_pending: boolean}, options?: MethodOptions) => Promise<AssembledTransaction<null>>

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
   * Construct and simulate a unpause transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   */
  unpause: ({caller}: {caller: string}, options?: MethodOptions) => Promise<AssembledTransaction<null>>

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
   * Construct and simulate a is_sale_open transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Whether the sale window for `(flight_id, date)` is currently open:
   * a sale authorization exists and its expiry timestamp is still in the
   * future. The controller's purchase gate consumes this — no live
   * authorization means no sale. Fails closed on every degraded state:
   * never written, explicitly closed, lapsed past its expiry timestamp,
   * or archived out of temporary storage.
   */
  is_sale_open: ({flight_id, date}: {flight_id: string, date: u64}, options?: MethodOptions) => Promise<AssembledTransaction<boolean>>

  /**
   * Construct and simulate a get_sale_auth transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Expiry timestamp of the sale authorization for `(flight_id, date)`,
   * or None if none is live. Off-chain convenience (frontends show the
   * purchase deadline, the executor decides which authorizations need a
   * refresh); the on-chain gate is `is_sale_open`.
   */
  get_sale_auth: ({flight_id, date}: {flight_id: string, date: u64}, options?: MethodOptions) => Promise<AssembledTransaction<Option<u64>>>

  /**
   * Construct and simulate a get_flight_data transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Get flight data. Returns NotInitiated with zero timestamps for missing entries.
   */
  get_flight_data: ({flight_id, date}: {flight_id: string, date: u64}, options?: MethodOptions) => Promise<AssembledTransaction<FlightData>>

  /**
   * Construct and simulate a has_flight_data transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Whether a `FlightData` entry physically exists for this key. Lets
   * callers distinguish a genuinely unregistered flight from one whose
   * entry archived past its TTL — `get_flight_data` reports both as
   * `NotInitiated`, but an archived entry is restorable and may still
   * have unresolved settlement riding on it.
   */
  has_flight_data: ({flight_id, date}: {flight_id: string, date: u64}, options?: MethodOptions) => Promise<AssembledTransaction<boolean>>

  /**
   * Construct and simulate a is_flight_listed transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Whether `(flight_id, date)` is currently in the active set. Exact
   * even if the set's reverse index archived (falls back to a page scan);
   * the controller's evicted-flight reconciliation gate relies on that
   * exactness.
   */
  is_flight_listed: ({flight_id, date}: {flight_id: string, date: u64}, options?: MethodOptions) => Promise<AssembledTransaction<boolean>>

  /**
   * Construct and simulate a get_active_flights transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Get all registered flights (the whole paginated active set).
   * 
   * Footprint grows with the set's page count (one ledger entry per ~100
   * flights), so this is an off-chain / simulation convenience — bounded
   * on-chain callers (the controller keeper) use
   * `get_active_flights_page` instead.
   */
  get_active_flights: (options?: MethodOptions) => Promise<AssembledTransaction<Array<readonly [string, u64]>>>

  /**
   * Construct and simulate a get_pending_outcomes transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Number of flights whose outcome is publicly recorded but not yet settled.
   */
  get_pending_outcomes: (options?: MethodOptions) => Promise<AssembledTransaction<u64>>

  /**
   * Construct and simulate a has_pending_outcomes transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Whether any flight outcome is public but not yet financially settled.
   * The vault reads this to block entry/exit while pending PnL is
   * unrecognized, so LPs cannot transact at a stale share price.
   */
  has_pending_outcomes: (options?: MethodOptions) => Promise<AssembledTransaction<boolean>>

  /**
   * Construct and simulate a get_authorized_oracle transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Get the authorized oracle address. Panics if not set.
   */
  get_authorized_oracle: (options?: MethodOptions) => Promise<AssembledTransaction<string>>

  /**
   * Construct and simulate a get_flights_by_status transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Get flights filtered by status. Iterates active list and filters.
   * 
   * Unbounded: performs one persistent read per active-list entry, so its
   * footprint grows with the list. Intended for off-chain / read-only
   * simulation use (frontends, executor) — on-chain callers must not
   * invoke it; the keeper entry points iterate with bounded batches
   * instead.
   */
  get_flights_by_status: ({status}: {status: FlightStatus}, options?: MethodOptions) => Promise<AssembledTransaction<Array<readonly [string, u64]>>>

  /**
   * Construct and simulate a get_active_flight_count transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Number of entries in the active set — O(1) from the stored count.
   * Cheap saturation gauge for operators: the set is capped (a sanity
   * bound, no longer a storage-entry limit), so occupancy approaching the
   * cap means new-flight registration (and thus first purchases) is about
   * to be rejected — prune promptly or investigate before that happens.
   */
  get_active_flight_count: (options?: MethodOptions) => Promise<AssembledTransaction<u32>>

  /**
   * Construct and simulate a get_active_flights_page transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Up to `limit` active-set entries starting at slot `offset`. The
   * bounded enumeration for on-chain callers: a window touches at most
   * two page entries. The set is unordered and removal reshuffles slots,
   * so callers iterate with idempotent, re-callable rotating cursors.
   */
  get_active_flights_page: ({offset, limit}: {offset: u32, limit: u32}, options?: MethodOptions) => Promise<AssembledTransaction<Array<readonly [string, u64]>>>

  /**
   * Construct and simulate a get_authorized_controller transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Get the authorized controller address, or None if not yet set.
   */
  get_authorized_controller: (options?: MethodOptions) => Promise<AssembledTransaction<Option<string>>>

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
   * Construct and simulate a open_sale transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Open (or refresh) the sale window for a flight instance. The purchase
   * gate requires a live, unexpired authorization, so this write is the
   * oracle's AFFIRMATIVE attestation — made after verifying the flight
   * off-chain — that `(flight_id, date)` matches a scheduled,
   * not-cancelled physical flight. Absence of an on-chain outcome proves
   * nothing about the real flight (a publicly cancelled one looks
   * identical to a valid unreported one until the cancellation write
   * lands), so insurability must be attested, not inferred.
   * 
   * The attestation is only as fresh as its remaining validity:
   * `expires_at` must lie within `SALE_AUTH_MAX_VALIDITY_SECS` of now
   * (and never past the departure-day boundary, beyond which the
   * controller's lead-time gate blocks purchases anyway). Sales stay open
   * only while the oracle keeps re-attesting; if it stops — outage,
   * provider gap, unverifiable flight — the window lapses and purchases
   * fail closed.
   */
  open_sale: ({oracle, flight_id, date, expires_at}: {oracle: string, flight_id: string, date: u64, expires_at: u64}, options?: MethodOptions) => Promise<AssembledTransaction<null>>

  /**
   * Construct and simulate a close_sale transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Close the sale window for a flight instance ahead of its expiry —
   * used when the oracle observes a cancellation or loses confidence in
   * the flight's identity and cannot wait for the authorization to lapse.
   * Idempotent: closing an absent window is a silent no-op (no event).
   * `set_cancelled` also closes the window as a side effect.
   * 
   * Deliberately NOT pause-gated: this write only revokes authorization —
   * it grants nothing. Already-open windows live in temporary storage and
   * stay readable (and purchasable through the controller, which may not
   * be paused) for up to their 24 h validity regardless of this
   * contract's pause state, so pausing the oracle must not also disable
   * the one write that can kill insurability of a flight that goes
   * publicly cancelled mid-window — gating it would invert the protection
   * exactly when the pause switch is in use. Same convention as the
   * governance module's pause-exempt protective writes.
   */
  close_sale: ({oracle, flight_id, date}: {oracle: string, flight_id: string, date: u64}, options?: MethodOptions) => Promise<AssembledTransaction<null>>

  /**
   * Construct and simulate a set_landed transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Set actual arrival time. Transitions Active → Landed.
   */
  set_landed: ({oracle, flight_id, date, actual_arrival_time}: {oracle: string, flight_id: string, date: u64, actual_arrival_time: u64}, options?: MethodOptions) => Promise<AssembledTransaction<null>>

  /**
   * Construct and simulate a set_settled transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Mark flight as settled. Transitions ToBeSettled* → Settled.
   * Records `settled_at` so the delayed-prune window starts ticking.
   * Does NOT remove the flight from the active set — eviction is
   * delegated to the permissionless `prune_settled` entry, which only
   * removes entries older than `SETTLED_RETENTION_DAYS`. Does NOT renew
   * flight TTL — settled entries naturally expire.
   */
  set_settled: ({controller, flight_id, date}: {controller: string, flight_id: string, date: u64}, options?: MethodOptions) => Promise<AssembledTransaction<null>>

  /**
   * Construct and simulate a prune_settled transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Remove settled flights from the active set once they have been
   * settled for at least `SETTLED_RETENTION_DAYS`. Permissionless —
   * anyone may call (matches `flight_pool_manager::sweep_expired`
   * pattern). Idempotent: re-callable with no panic; no-op if nothing
   * has aged out.
   */
  prune_settled: (options?: MethodOptions) => Promise<AssembledTransaction<null>>

  /**
   * Construct and simulate a set_cancelled transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Mark flight as cancelled. Transitions NotInitiated/Active → Cancelled.
   * 
   * Unlike the other outcome writes, this also accepts a flight that has
   * never been registered. Registration normally happens as a side effect of
   * the first purchase, so without this path the oracle could not record a
   * publicly known cancellation until someone bought a policy — and the
   * purchase gate, seeing no oracle record, would admit buyers into a flight
   * whose payout is already certain. Writing the cancellation first creates
   * a purchase-blocking record.
   * 
   * A record created this way is deliberately kept OUT of the active flight
   * list and the pending-outcomes counter: absence of a record proves no
   * policy exists (every purchase registers the flight), so there is no
   * premium or collateral to settle and no unrecognized vault PnL. Entering
   * the classify/settle pipeline would strand the flight forever on a
   * missing pool config and jam the vault's settlement barrier. The record
   * is a tombstone: it exists only so the purchase gate sees `Cancelled`.
   */
  set_cancelled: ({oracle, flight_id, date}: {oracle: string, flight_id: string, date: u64}, options?: MethodOptions) => Promise<AssembledTransaction<null>>

  /**
   * Construct and simulate a register_flight transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Register a flight. Idempotent: re-registering the same
   * `(flight_id, date)` is a no-op — only the TTL is
   * extended, no event is re-emitted.
   */
  register_flight: ({controller, flight_id, date}: {controller: string, flight_id: string, date: u64}, options?: MethodOptions) => Promise<AssembledTransaction<null>>

  /**
   * Construct and simulate a set_to_be_settled transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Classify a flight for settlement. Transitions Landed/Cancelled → ToBeSettled*.
   */
  set_to_be_settled: ({controller, flight_id, date, status}: {controller: string, flight_id: string, date: u64, status: FlightStatus}, options?: MethodOptions) => Promise<AssembledTransaction<null>>

  /**
   * Construct and simulate a set_estimated_arrival transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Set estimated arrival time. Transitions NotInitiated → Active.
   */
  set_estimated_arrival: ({oracle, flight_id, date, estimated_arrival_time}: {oracle: string, flight_id: string, date: u64, estimated_arrival_time: u64}, options?: MethodOptions) => Promise<AssembledTransaction<null>>

}
export class Client extends ContractClient {
  static async deploy<T = Client>(
        /** Constructor/Initialization Args for the contract's `__constructor` method */
        {owner, authorized_oracle}: {owner: string, authorized_oracle: string},
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
    return ContractClient.deploy({owner, authorized_oracle}, options)
  }
  constructor(public readonly options: ContractClientOptions) {
    super(
      new ContractSpec([ "AAAAAAAAAJRFeHRlbmQgaW5zdGFuY2UgVFRMLiBDYWxsZWQgYnkgY3JvbiBhcyBhIHNhZmV0eSBuZXQ7IGluc3RhbmNlLW11dGF0aW5nCmhvdCBwYXRocyBhbHNvIHJlbmV3IGl0IGlubGluZSBzbyB0aGUgY29udHJhY3Qgc2VsZi1oZWFscyBpZiB0aGUgY3JvbgpsYXBzZXMuAAAACmV4dGVuZF90dGwAAAAAAAAAAAAA",
        "AAAAAAAABABVcGRhdGUgdGhlIGF1dGhvcml6ZWQgb3JhY2xlIGFkZHJlc3MgKGZvciBiYWNrZW5kIG1pZ3JhdGlvbikuCgpSb3RhdGlvbiBkb2VzIE5PVCBpbnZhbGlkYXRlIG91dHN0YW5kaW5nIHNhbGUgYXV0aG9yaXphdGlvbnM6IGV2ZXJ5CndpbmRvdyB0aGUgb3V0Z29pbmcgb3JhY2xlIG9wZW5lZCBsaXZlcyBpbiB0ZW1wb3Jhcnkgc3RvcmFnZSAobm90CmVudW1lcmFibGUgb24tY2hhaW4sIHNvIG5vIGJ1bGsgcmV2b2tlIGV4aXN0cykgYW5kIGtlZXBzIGF1dGhvcml6aW5nCnB1cmNoYXNlcyB0aHJvdWdoIHRoZSBjb250cm9sbGVyIHVudGlsIGl0IGV4cGlyZXMg4oCUIHVwIHRvCmBTQUxFX0FVVEhfTUFYX1ZBTElESVRZX1NFQ1NgIOKAlCBvciBpcyBpbmRpdmlkdWFsbHkgY2xvc2VkLiBGb3IgYQpyb3V0aW5lIGJhY2tlbmQgbWlncmF0aW9uIHRoYXQgaXMgaGFybWxlc3M6IHRoZSB3aW5kb3dzIGFyZSBob25lc3QKYXR0ZXN0YXRpb25zIGFuZCB0aGUgbmV3IGJhY2tlbmQgcmUtYXR0ZXN0cyBvbiBpdHMgb3duIGNhZGVuY2UuCgoqKlJvdGF0aW9uIGFzIGEgY29tcHJvbWlzZSByZXNwb25zZSBpcyBhIHR3by1zdGVwIG9wZXJhdGlvbi4qKiBUaGUKZGVwYXJ0aW5nIGtleSdzIHBhcnRpbmcgYXR0ZXN0YXRpb25zIHN1cnZpdmUgdGhlIHN3YXAsIHNvIGZsaWdodHMgdGhlCmhvbmVzdCBwaXBlbGluZSBuZXZlciB2ZXJpZmllZCAoaW5jbHVkaW5nIHB1YmxpY2x5IGNhbmNlbGxlZCBvbmVzKQpzdGF5IHB1cmNoYXNhYmxlIHVudGlsIGVhY2ggd2luZG93IGxhcHNlcy4gSW1tZWRpYXRlbHkgYWZ0ZXIgdGhlCnN3YXAsIHRoZSBuZXcgb3JhY2xlIG11c3Qgc3dlZXAgYGNsb3NlX3NhbGVgIG92ZXIgZXZlcnkgd2luZG93IHN0aWxsCm9wZW4g4oCUIHJlY29uc3RydWN0ZWQgb2ZmLWNoYWluIGZyb20gdGhlIGBTYWxlT3BlbmVkYC9gU2FsZUNsb3NlZGAKZXZlbnQgc3RyZWFtIOKAlCBvciB0aGUgY29udHJvbGxlciBtdXN0IGJlIHBhdXNlZCBmb3IgdGhlIGZ1bGwgdmFsaWRpdHkKaG9yaXpvbiBzbyBub3RoaW5nIGNhAAAACnNldF9vcmFjbGUAAAAAAAEAAAAAAAAACm5ld19vcmFjbGUAAAAAABMAAAAA",
        "AAAAAAAAAOBJbml0aWFsaXplIHRoZSBvcmFjbGUgYWdncmVnYXRvci4KCiMgQXJndW1lbnRzCiogYG93bmVyYCAtIEFkZHJlc3MgZ3JhbnRlZCBvd25lciByaWdodHMgKHNldCB0aGUgYXV0aG9yaXplZCBjb250cm9sbGVyLAptYW5hZ2UgY29uZmlndXJhdGlvbiwgdXBncmFkZSkuCiogYGF1dGhvcml6ZWRfb3JhY2xlYCAtIEFkZHJlc3MgcGVybWl0dGVkIHRvIHN1Ym1pdCBmbGlnaHQgb3V0Y29tZSBkYXRhLgAAAA1fX2NvbnN0cnVjdG9yAAAAAAAAAgAAAAAAAAAFb3duZXIAAAAAAAATAAAAAAAAABFhdXRob3JpemVkX29yYWNsZQAAAAAAABMAAAAA",
        "AAAAAAAAAD9TZXQgdGhlIGF1dGhvcml6ZWQgY29udHJvbGxlciBhZGRyZXNzLiBDYW4gb25seSBiZSBjYWxsZWQgb25jZS4AAAAADnNldF9jb250cm9sbGVyAAAAAAABAAAAAAAAAApjb250cm9sbGVyAAAAAAATAAAAAA==",
        "AAAAAAAABABSZW1vdmUgYW4gYWN0aXZlLWxpc3QgZW50cnkgd2hvc2UgYEZsaWdodERhdGFgIGhhcyBhcmNoaXZlZCBwYXN0IGl0cwpUVEwgKG93bmVyLW9ubHkpLiBgcHJ1bmVfc2V0dGxlZGAgZGVsaWJlcmF0ZWx5IHJldGFpbnMgc3VjaCBlbnRyaWVzIOKAlAphcmNoaXZlZCBpcyBub3Qgc2V0dGxlZCwgYW5kIHBlcm1pc3Npb25sZXNzIGV2aWN0aW9uIHdvdWxkIHN0cmlwIGFuCnVucmVzb2x2ZWQgZmxpZ2h0IGZyb20ga2VlcGVyIGVudW1lcmF0aW9uLiBGcmVlaW5nIHRoZSBjYXBwZWQgbGlzdApzbG90IHRoZXJlZm9yZSByZXF1aXJlcyB0aGUgb3duZXIgdG8gZmlyc3QgY29uZmlybSwgb2ZmLWNoYWluLCB0aGF0CnRoZSBmbGlnaHQgbmVlZHMgbm8gZnVydGhlciBvbi1jaGFpbiByZXNvbHV0aW9uLiAqKlJlc3RvcmluZyB0aGUKYXJjaGl2ZWQgZW50cnkgYW5kIGxldHRpbmcgdGhlIG5vcm1hbCBzZXR0bGUgcGlwZWxpbmUgZmluaXNoIGlzIGFsd2F5cwp0aGUgcHJlZmVycmVkIHBhdGgqKiDigJQgZXZpY3Rpb24gcmVtb3ZlcyB0aGUgZmxpZ2h0IGZyb20ga2VlcGVyCmVudW1lcmF0aW9uIHBlcm1hbmVudGx5IChyZS1yZWdpc3RyYXRpb24gb2YgYW4gZXhpc3Rpbmcga2V5IGRvZXMgbm90CnJlLWFkZCBpdCB0byB0aGUgbGlzdCkuCgpgb3V0Y29tZV9wZW5kaW5nYCBtdXN0IGJlIGB0cnVlYCBpZmYgdGhlIGZsaWdodCdzIG91dGNvbWUgd2FzIGFscmVhZHkKcHVibGljbHkgcmVjb3JkZWQgKGl0IHJlYWNoZWQgTGFuZGVkIC8gQ2FuY2VsbGVkIC8gVG9CZVNldHRsZWQqKSBhbmQKdGhlcmVmb3JlIGNvdW50ZWQgdG93YXJkIGBQZW5kaW5nT3V0Y29tZXNgLiBUaGUgY291bnRlciBpcyBvbmx5IGV2ZXIKcmVsZWFzZWQgYnkgc2V0dGxlbWVudDsgZXZpY3Rpbmcgc3VjaCBhIGZsaWdodCB3aXRob3V0IHJlbGVhc2luZyBpdHMKY291bnQgd291bGQgbGVhdmUgdGhlIHZhdWx0J3MgZW50cnkvZXhpdCBiYXJyaWVyIGVuZ2FnZWQgZm9yZXZlciwgd2l0aApubyByZW1haW5pbmcgb24tY2hhaW4gcGF0aCB0byBkZWNyZW1lAAAAFGV2aWN0X21pc3NpbmdfZmxpZ2h0AAAAAwAAAAAAAAAJZmxpZ2h0X2lkAAAAAAAAEQAAAAAAAAAEZGF0ZQAAAAYAAAAAAAAAD291dGNvbWVfcGVuZGluZwAAAAABAAAAAA==",
        "AAAABAAAAAAAAAAAAAAABUVycm9yAAAAAAAACwAAAAAAAAAUQ29udHJvbGxlckFscmVhZHlTZXQAAAJZAAAAAAAAABFJbnZhbGlkVHJhbnNpdGlvbgAAAAAAAloAAAAAAAAAF0ludmFsaWRTZXR0bGVtZW50U3RhdHVzAAAAAlsAAAAAAAAAE05vdEF1dGhvcml6ZWRPcmFjbGUAAAACXAAAAAAAAAAXTm90QXV0aG9yaXplZENvbnRyb2xsZXIAAAACXQAAAAAAAAAUQWN0aXZlRmxpZ2h0TGlzdEZ1bGwAAAJeAAAAAAAAABBJbnZhbGlkVGltZXN0YW1wAAACXwAAAAAAAAAWRmxpZ2h0RGF0YVN0aWxsUHJlc2VudAAAAAACYAAAAAAAAAAPRmxpZ2h0Tm90SW5MaXN0AAAAAmEAAAAAAAAAFlN0YWxlVGltZW91dE5vdFJlYWNoZWQAAAAAAmIAAAAAAAAAF0FjdGl2ZVRpbWVvdXROb3RSZWFjaGVkAAAAAmM=",
        "AAAABQAAAAAAAAAAAAAACU9yYWNsZVNldAAAAAAAAAIAAAAIc2VudGluZWwAAAAKb3JhY2xlX3NldAAAAAAAAQAAAAAAAAAGb3JhY2xlAAAAAAATAAAAAQAAAAA=",
        "AAAABQAAAAAAAAAAAAAAClNhbGVDbG9zZWQAAAAAAAIAAAAIc2VudGluZWwAAAAKc2FsZV9jbG9zZQAAAAAAAgAAAAAAAAAJZmxpZ2h0X2lkAAAAAAAAEQAAAAEAAAAAAAAABGRhdGUAAAAGAAAAAAAAAAI=",
        "AAAABQAAAAAAAAAAAAAAClNhbGVPcGVuZWQAAAAAAAIAAAAIc2VudGluZWwAAAAJc2FsZV9vcGVuAAAAAAAAAwAAAAAAAAAJZmxpZ2h0X2lkAAAAAAAAEQAAAAEAAAAAAAAABGRhdGUAAAAGAAAAAAAAAAAAAAAKZXhwaXJlc19hdAAAAAAABgAAAAAAAAAC",
        "AAAABQAAAAAAAAAAAAAADUNvbnRyb2xsZXJTZXQAAAAAAAACAAAACHNlbnRpbmVsAAAADmNvbnRyb2xsZXJfc2V0AAAAAAABAAAAAAAAAApjb250cm9sbGVyAAAAAAATAAAAAQAAAAA=",
        "AAAABQAAAAAAAAAAAAAADUZsaWdodEV2aWN0ZWQAAAAAAAACAAAACHNlbnRpbmVsAAAAB2V2aWN0ZWQAAAAAAwAAAAAAAAAJZmxpZ2h0X2lkAAAAAAAAEQAAAAEAAAAAAAAABGRhdGUAAAAGAAAAAAAAAAAAAAAPb3V0Y29tZV9wZW5kaW5nAAAAAAEAAAAAAAAAAg==",
        "AAAABQAAAAAAAAAAAAAAEU1pc3NpbmdGbGlnaHREYXRhAAAAAAAAAgAAAAhzZW50aW5lbAAAAAxkYXRhX21pc3NpbmcAAAACAAAAAAAAAAlmbGlnaHRfaWQAAAAAAAARAAAAAQAAAAAAAAAEZGF0ZQAAAAYAAAAAAAAAAg==",
        "AAAABQAAAAAAAAAAAAAAEkZsaWdodFN0YXR1c0NoYW5nZQAAAAAAAgAAAAhzZW50aW5lbAAAAAZmbGlnaHQAAAAAAAMAAAAAAAAACWZsaWdodF9pZAAAAAAAABEAAAABAAAAAAAAAARkYXRlAAAABgAAAAEAAAAAAAAACm5ld19zdGF0dXMAAAAAB9AAAAAMRmxpZ2h0U3RhdHVzAAAAAAAAAAA=",
        "AAAAAAAAAAAAAAAFcGF1c2UAAAAAAAABAAAAAAAAAAZjYWxsZXIAAAAAABMAAAAA",
        "AAAAAAAAAHFSZXR1cm5zIHRydWUgaWYgdGhlIGNvbnRyYWN0IGlzIHBhdXNlZCwgYW5kIGZhbHNlIG90aGVyd2lzZS4KCiMgQXJndW1lbnRzCgoqIGBlYCAtIEFjY2VzcyB0byBTb3JvYmFuIGVudmlyb25tZW50LgAAAAAAAAZwYXVzZWQAAAAAAAAAAAABAAAAAQ==",
        "AAAAAAAAAAAAAAAHdW5wYXVzZQAAAAABAAAAAAAAAAZjYWxsZXIAAAAAABMAAAAA",
        "AAAAAAAAAJBSZXR1cm5zIGBTb21lKEFkZHJlc3MpYCBpZiBvd25lcnNoaXAgaXMgc2V0LCBvciBgTm9uZWAgaWYgb3duZXJzaGlwIGhhcwpiZWVuIHJlbm91bmNlZC4KCiMgQXJndW1lbnRzCgoqIGBlYCAtIEFjY2VzcyB0byB0aGUgU29yb2JhbiBlbnZpcm9ubWVudC4AAAAJZ2V0X293bmVyAAAAAAAAAAAAAAEAAAPoAAAAEw==",
        "AAAAAAAAATBBY2NlcHRzIGEgcGVuZGluZyBvd25lcnNoaXAgdHJhbnNmZXIuCgojIEFyZ3VtZW50cwoKKiBgZWAgLSBBY2Nlc3MgdG8gdGhlIFNvcm9iYW4gZW52aXJvbm1lbnQuCgojIEVycm9ycwoKKiBbYGNyYXRlOjpyb2xlX3RyYW5zZmVyOjpSb2xlVHJhbnNmZXJFcnJvcjo6Tm9QZW5kaW5nVHJhbnNmZXJgXSAtIElmCnRoZXJlIGlzIG5vIHBlbmRpbmcgdHJhbnNmZXIgdG8gYWNjZXB0LgoKIyBFdmVudHMKCiogdG9waWNzIC0gYFsib3duZXJzaGlwX3RyYW5zZmVyX2NvbXBsZXRlZCJdYAoqIGRhdGEgLSBgW25ld19vd25lcjogQWRkcmVzc11gAAAAEGFjY2VwdF9vd25lcnNoaXAAAAAAAAAAAA==",
        "AAAAAAAAAYVSZW5vdW5jZXMgb3duZXJzaGlwIG9mIHRoZSBjb250cmFjdC4KClBlcm1hbmVudGx5IHJlbW92ZXMgdGhlIG93bmVyLCBkaXNhYmxpbmcgYWxsIGZ1bmN0aW9ucyBnYXRlZCBieQpgI1tvbmx5X293bmVyXWAuCgojIEFyZ3VtZW50cwoKKiBgZWAgLSBBY2Nlc3MgdG8gdGhlIFNvcm9iYW4gZW52aXJvbm1lbnQuCgojIEVycm9ycwoKKiBbYE93bmFibGVFcnJvcjo6VHJhbnNmZXJJblByb2dyZXNzYF0gLSBJZiB0aGVyZSBpcyBhIHBlbmRpbmcgb3duZXJzaGlwCnRyYW5zZmVyLgoqIFtgT3duYWJsZUVycm9yOjpPd25lck5vdFNldGBdIC0gSWYgdGhlIG93bmVyIGlzIG5vdCBzZXQuCgojIE5vdGVzCgoqIEF1dGhvcml6YXRpb24gZm9yIHRoZSBjdXJyZW50IG93bmVyIGlzIHJlcXVpcmVkLgAAAAAAABJyZW5vdW5jZV9vd25lcnNoaXAAAAAAAAAAAAAA",
        "AAAAAAAAA45Jbml0aWF0ZXMgYSAyLXN0ZXAgb3duZXJzaGlwIHRyYW5zZmVyIHRvIGEgbmV3IGFkZHJlc3MuCgpSZXF1aXJlcyBhdXRob3JpemF0aW9uIGZyb20gdGhlIGN1cnJlbnQgb3duZXIuIFRoZSBuZXcgb3duZXIgbXVzdCBsYXRlcgpjYWxsIGBhY2NlcHRfb3duZXJzaGlwKClgIHRvIGNvbXBsZXRlIHRoZSB0cmFuc2Zlci4KCiMgQXJndW1lbnRzCgoqIGBlYCAtIEFjY2VzcyB0byB0aGUgU29yb2JhbiBlbnZpcm9ubWVudC4KKiBgbmV3X293bmVyYCAtIFRoZSBwcm9wb3NlZCBuZXcgb3duZXIuCiogYGxpdmVfdW50aWxfbGVkZ2VyYCAtIExlZGdlciBudW1iZXIgdW50aWwgd2hpY2ggdGhlIG5ldyBvd25lciBjYW4KYWNjZXB0LiBBIHZhbHVlIG9mIGAwYCBjYW5jZWxzIGFueSBwZW5kaW5nIHRyYW5zZmVyLgoKIyBFcnJvcnMKCiogW2BPd25hYmxlRXJyb3I6Ok93bmVyTm90U2V0YF0gLSBJZiB0aGUgb3duZXIgaXMgbm90IHNldC4KKiBbYGNyYXRlOjpyb2xlX3RyYW5zZmVyOjpSb2xlVHJhbnNmZXJFcnJvcjo6Tm9QZW5kaW5nVHJhbnNmZXJgXSAtIElmCnRyeWluZyB0byBjYW5jZWwgYSB0cmFuc2ZlciB0aGF0IGRvZXNuJ3QgZXhpc3QuCiogW2BjcmF0ZTo6cm9sZV90cmFuc2Zlcjo6Um9sZVRyYW5zZmVyRXJyb3I6OkludmFsaWRMaXZlVW50aWxMZWRnZXJgXSAtCklmIHRoZSBzcGVjaWZpZWQgbGVkZ2VyIGlzIGluIHRoZSBwYXN0LgoqIFtgY3JhdGU6OnJvbGVfdHJhbnNmZXI6OlJvbGVUcmFuc2ZlckVycm9yOjpJbnZhbGlkUGVuZGluZ0FjY291bnRgXSAtCklmIHRoZSBzcGVjaWZpZWQgcGVuZGluZyBhY2NvdW50IGlzIG5vdCB0aGUgc2FtZSBhcyB0aGUgcHJvdmlkZWQgYG5ld2AKYWRkcmVzcy4KCiMgTm90ZXMKCiogQXV0aG9yaXphdGlvbiBmb3IgdGhlIGN1cnJlbnQgb3duZXIgaXMgcmVxdWlyZWQuAAAAAAASdHJhbnNmZXJfb3duZXJzaGlwAAAAAAACAAAAAAAAAAluZXdfb3duZXIAAAAAAAATAAAAAAAAABFsaXZlX3VudGlsX2xlZGdlcgAAAAAAAAQAAAAA",
        "AAAAAAAAAXVXaGV0aGVyIHRoZSBzYWxlIHdpbmRvdyBmb3IgYChmbGlnaHRfaWQsIGRhdGUpYCBpcyBjdXJyZW50bHkgb3BlbjoKYSBzYWxlIGF1dGhvcml6YXRpb24gZXhpc3RzIGFuZCBpdHMgZXhwaXJ5IHRpbWVzdGFtcCBpcyBzdGlsbCBpbiB0aGUKZnV0dXJlLiBUaGUgY29udHJvbGxlcidzIHB1cmNoYXNlIGdhdGUgY29uc3VtZXMgdGhpcyDigJQgbm8gbGl2ZQphdXRob3JpemF0aW9uIG1lYW5zIG5vIHNhbGUuIEZhaWxzIGNsb3NlZCBvbiBldmVyeSBkZWdyYWRlZCBzdGF0ZToKbmV2ZXIgd3JpdHRlbiwgZXhwbGljaXRseSBjbG9zZWQsIGxhcHNlZCBwYXN0IGl0cyBleHBpcnkgdGltZXN0YW1wLApvciBhcmNoaXZlZCBvdXQgb2YgdGVtcG9yYXJ5IHN0b3JhZ2UuAAAAAAAADGlzX3NhbGVfb3BlbgAAAAIAAAAAAAAACWZsaWdodF9pZAAAAAAAABEAAAAAAAAABGRhdGUAAAAGAAAAAQAAAAE=",
        "AAAAAAAAAPlFeHBpcnkgdGltZXN0YW1wIG9mIHRoZSBzYWxlIGF1dGhvcml6YXRpb24gZm9yIGAoZmxpZ2h0X2lkLCBkYXRlKWAsCm9yIE5vbmUgaWYgbm9uZSBpcyBsaXZlLiBPZmYtY2hhaW4gY29udmVuaWVuY2UgKGZyb250ZW5kcyBzaG93IHRoZQpwdXJjaGFzZSBkZWFkbGluZSwgdGhlIGV4ZWN1dG9yIGRlY2lkZXMgd2hpY2ggYXV0aG9yaXphdGlvbnMgbmVlZCBhCnJlZnJlc2gpOyB0aGUgb24tY2hhaW4gZ2F0ZSBpcyBgaXNfc2FsZV9vcGVuYC4AAAAAAAANZ2V0X3NhbGVfYXV0aAAAAAAAAAIAAAAAAAAACWZsaWdodF9pZAAAAAAAABEAAAAAAAAABGRhdGUAAAAGAAAAAQAAA+gAAAAG",
        "AAAAAAAAAE9HZXQgZmxpZ2h0IGRhdGEuIFJldHVybnMgTm90SW5pdGlhdGVkIHdpdGggemVybyB0aW1lc3RhbXBzIGZvciBtaXNzaW5nIGVudHJpZXMuAAAAAA9nZXRfZmxpZ2h0X2RhdGEAAAAAAgAAAAAAAAAJZmxpZ2h0X2lkAAAAAAAAEQAAAAAAAAAEZGF0ZQAAAAYAAAABAAAH0AAAAApGbGlnaHREYXRhAAA=",
        "AAAAAAAAATFXaGV0aGVyIGEgYEZsaWdodERhdGFgIGVudHJ5IHBoeXNpY2FsbHkgZXhpc3RzIGZvciB0aGlzIGtleS4gTGV0cwpjYWxsZXJzIGRpc3Rpbmd1aXNoIGEgZ2VudWluZWx5IHVucmVnaXN0ZXJlZCBmbGlnaHQgZnJvbSBvbmUgd2hvc2UKZW50cnkgYXJjaGl2ZWQgcGFzdCBpdHMgVFRMIOKAlCBgZ2V0X2ZsaWdodF9kYXRhYCByZXBvcnRzIGJvdGggYXMKYE5vdEluaXRpYXRlZGAsIGJ1dCBhbiBhcmNoaXZlZCBlbnRyeSBpcyByZXN0b3JhYmxlIGFuZCBtYXkgc3RpbGwKaGF2ZSB1bnJlc29sdmVkIHNldHRsZW1lbnQgcmlkaW5nIG9uIGl0LgAAAAAAAA9oYXNfZmxpZ2h0X2RhdGEAAAAAAgAAAAAAAAAJZmxpZ2h0X2lkAAAAAAAAEQAAAAAAAAAEZGF0ZQAAAAYAAAABAAAAAQ==",
        "AAAAAAAAANVXaGV0aGVyIGAoZmxpZ2h0X2lkLCBkYXRlKWAgaXMgY3VycmVudGx5IGluIHRoZSBhY3RpdmUgc2V0LiBFeGFjdApldmVuIGlmIHRoZSBzZXQncyByZXZlcnNlIGluZGV4IGFyY2hpdmVkIChmYWxscyBiYWNrIHRvIGEgcGFnZSBzY2FuKTsKdGhlIGNvbnRyb2xsZXIncyBldmljdGVkLWZsaWdodCByZWNvbmNpbGlhdGlvbiBnYXRlIHJlbGllcyBvbiB0aGF0CmV4YWN0bmVzcy4AAAAAAAAQaXNfZmxpZ2h0X2xpc3RlZAAAAAIAAAAAAAAACWZsaWdodF9pZAAAAAAAABEAAAAAAAAABGRhdGUAAAAGAAAAAQAAAAE=",
        "AAAAAAAAARlHZXQgYWxsIHJlZ2lzdGVyZWQgZmxpZ2h0cyAodGhlIHdob2xlIHBhZ2luYXRlZCBhY3RpdmUgc2V0KS4KCkZvb3RwcmludCBncm93cyB3aXRoIHRoZSBzZXQncyBwYWdlIGNvdW50IChvbmUgbGVkZ2VyIGVudHJ5IHBlciB+MTAwCmZsaWdodHMpLCBzbyB0aGlzIGlzIGFuIG9mZi1jaGFpbiAvIHNpbXVsYXRpb24gY29udmVuaWVuY2Ug4oCUIGJvdW5kZWQKb24tY2hhaW4gY2FsbGVycyAodGhlIGNvbnRyb2xsZXIga2VlcGVyKSB1c2UKYGdldF9hY3RpdmVfZmxpZ2h0c19wYWdlYCBpbnN0ZWFkLgAAAAAAABJnZXRfYWN0aXZlX2ZsaWdodHMAAAAAAAAAAAABAAAD6gAAA+0AAAACAAAAEQAAAAY=",
        "AAAAAAAAAElOdW1iZXIgb2YgZmxpZ2h0cyB3aG9zZSBvdXRjb21lIGlzIHB1YmxpY2x5IHJlY29yZGVkIGJ1dCBub3QgeWV0IHNldHRsZWQuAAAAAAAAFGdldF9wZW5kaW5nX291dGNvbWVzAAAAAAAAAAEAAAAG",
        "AAAAAAAAAMBXaGV0aGVyIGFueSBmbGlnaHQgb3V0Y29tZSBpcyBwdWJsaWMgYnV0IG5vdCB5ZXQgZmluYW5jaWFsbHkgc2V0dGxlZC4KVGhlIHZhdWx0IHJlYWRzIHRoaXMgdG8gYmxvY2sgZW50cnkvZXhpdCB3aGlsZSBwZW5kaW5nIFBuTCBpcwp1bnJlY29nbml6ZWQsIHNvIExQcyBjYW5ub3QgdHJhbnNhY3QgYXQgYSBzdGFsZSBzaGFyZSBwcmljZS4AAAAUaGFzX3BlbmRpbmdfb3V0Y29tZXMAAAAAAAAAAQAAAAE=",
        "AAAAAAAAADVHZXQgdGhlIGF1dGhvcml6ZWQgb3JhY2xlIGFkZHJlc3MuIFBhbmljcyBpZiBub3Qgc2V0LgAAAAAAABVnZXRfYXV0aG9yaXplZF9vcmFjbGUAAAAAAAAAAAAAAQAAABM=",
        "AAAAAAAAAVZHZXQgZmxpZ2h0cyBmaWx0ZXJlZCBieSBzdGF0dXMuIEl0ZXJhdGVzIGFjdGl2ZSBsaXN0IGFuZCBmaWx0ZXJzLgoKVW5ib3VuZGVkOiBwZXJmb3JtcyBvbmUgcGVyc2lzdGVudCByZWFkIHBlciBhY3RpdmUtbGlzdCBlbnRyeSwgc28gaXRzCmZvb3RwcmludCBncm93cyB3aXRoIHRoZSBsaXN0LiBJbnRlbmRlZCBmb3Igb2ZmLWNoYWluIC8gcmVhZC1vbmx5CnNpbXVsYXRpb24gdXNlIChmcm9udGVuZHMsIGV4ZWN1dG9yKSDigJQgb24tY2hhaW4gY2FsbGVycyBtdXN0IG5vdAppbnZva2UgaXQ7IHRoZSBrZWVwZXIgZW50cnkgcG9pbnRzIGl0ZXJhdGUgd2l0aCBib3VuZGVkIGJhdGNoZXMKaW5zdGVhZC4AAAAAABVnZXRfZmxpZ2h0c19ieV9zdGF0dXMAAAAAAAABAAAAAAAAAAZzdGF0dXMAAAAAB9AAAAAMRmxpZ2h0U3RhdHVzAAAAAQAAA+oAAAPtAAAAAgAAABEAAAAG",
        "AAAAAAAAAVdOdW1iZXIgb2YgZW50cmllcyBpbiB0aGUgYWN0aXZlIHNldCDigJQgTygxKSBmcm9tIHRoZSBzdG9yZWQgY291bnQuCkNoZWFwIHNhdHVyYXRpb24gZ2F1Z2UgZm9yIG9wZXJhdG9yczogdGhlIHNldCBpcyBjYXBwZWQgKGEgc2FuaXR5CmJvdW5kLCBubyBsb25nZXIgYSBzdG9yYWdlLWVudHJ5IGxpbWl0KSwgc28gb2NjdXBhbmN5IGFwcHJvYWNoaW5nIHRoZQpjYXAgbWVhbnMgbmV3LWZsaWdodCByZWdpc3RyYXRpb24gKGFuZCB0aHVzIGZpcnN0IHB1cmNoYXNlcykgaXMgYWJvdXQKdG8gYmUgcmVqZWN0ZWQg4oCUIHBydW5lIHByb21wdGx5IG9yIGludmVzdGlnYXRlIGJlZm9yZSB0aGF0IGhhcHBlbnMuAAAAABdnZXRfYWN0aXZlX2ZsaWdodF9jb3VudAAAAAAAAAAAAQAAAAQ=",
        "AAAAAAAAAQlVcCB0byBgbGltaXRgIGFjdGl2ZS1zZXQgZW50cmllcyBzdGFydGluZyBhdCBzbG90IGBvZmZzZXRgLiBUaGUKYm91bmRlZCBlbnVtZXJhdGlvbiBmb3Igb24tY2hhaW4gY2FsbGVyczogYSB3aW5kb3cgdG91Y2hlcyBhdCBtb3N0CnR3byBwYWdlIGVudHJpZXMuIFRoZSBzZXQgaXMgdW5vcmRlcmVkIGFuZCByZW1vdmFsIHJlc2h1ZmZsZXMgc2xvdHMsCnNvIGNhbGxlcnMgaXRlcmF0ZSB3aXRoIGlkZW1wb3RlbnQsIHJlLWNhbGxhYmxlIHJvdGF0aW5nIGN1cnNvcnMuAAAAAAAAF2dldF9hY3RpdmVfZmxpZ2h0c19wYWdlAAAAAAIAAAAAAAAABm9mZnNldAAAAAAABAAAAAAAAAAFbGltaXQAAAAAAAAEAAAAAQAAA+oAAAPtAAAAAgAAABEAAAAG",
        "AAAAAAAAAD5HZXQgdGhlIGF1dGhvcml6ZWQgY29udHJvbGxlciBhZGRyZXNzLCBvciBOb25lIGlmIG5vdCB5ZXQgc2V0LgAAAAAAGWdldF9hdXRob3JpemVkX2NvbnRyb2xsZXIAAAAAAAAAAAAAAQAAA+gAAAAT",
        "AAAAAAAAAG9Pd25lci1nYXRlZCBXYXNtIHVwZ3JhZGUuIERlbGVnYXRlcyB0byB0aGUgc2hhcmVkIGltcGxlbWVudGF0aW9uLCB3aGljaAphbHNvIGJ1bXBzIHRoZSBzdG9yZWQgb24tY2hhaW4gdmVyc2lvbi4AAAAAB3VwZ3JhZGUAAAAAAQAAAAAAAAAJd2FzbV9oYXNoAAAAAAAD7gAAACAAAAAA",
        "AAAAAAAAACJDdXJyZW50IG9uLWNoYWluIGNvbnRyYWN0IHZlcnNpb24uAAAAAAAHdmVyc2lvbgAAAAAAAAAAAQAAAAQ=",
        "AAAAAAAAA51PcGVuIChvciByZWZyZXNoKSB0aGUgc2FsZSB3aW5kb3cgZm9yIGEgZmxpZ2h0IGluc3RhbmNlLiBUaGUgcHVyY2hhc2UKZ2F0ZSByZXF1aXJlcyBhIGxpdmUsIHVuZXhwaXJlZCBhdXRob3JpemF0aW9uLCBzbyB0aGlzIHdyaXRlIGlzIHRoZQpvcmFjbGUncyBBRkZJUk1BVElWRSBhdHRlc3RhdGlvbiDigJQgbWFkZSBhZnRlciB2ZXJpZnlpbmcgdGhlIGZsaWdodApvZmYtY2hhaW4g4oCUIHRoYXQgYChmbGlnaHRfaWQsIGRhdGUpYCBtYXRjaGVzIGEgc2NoZWR1bGVkLApub3QtY2FuY2VsbGVkIHBoeXNpY2FsIGZsaWdodC4gQWJzZW5jZSBvZiBhbiBvbi1jaGFpbiBvdXRjb21lIHByb3Zlcwpub3RoaW5nIGFib3V0IHRoZSByZWFsIGZsaWdodCAoYSBwdWJsaWNseSBjYW5jZWxsZWQgb25lIGxvb2tzCmlkZW50aWNhbCB0byBhIHZhbGlkIHVucmVwb3J0ZWQgb25lIHVudGlsIHRoZSBjYW5jZWxsYXRpb24gd3JpdGUKbGFuZHMpLCBzbyBpbnN1cmFiaWxpdHkgbXVzdCBiZSBhdHRlc3RlZCwgbm90IGluZmVycmVkLgoKVGhlIGF0dGVzdGF0aW9uIGlzIG9ubHkgYXMgZnJlc2ggYXMgaXRzIHJlbWFpbmluZyB2YWxpZGl0eToKYGV4cGlyZXNfYXRgIG11c3QgbGllIHdpdGhpbiBgU0FMRV9BVVRIX01BWF9WQUxJRElUWV9TRUNTYCBvZiBub3cKKGFuZCBuZXZlciBwYXN0IHRoZSBkZXBhcnR1cmUtZGF5IGJvdW5kYXJ5LCBiZXlvbmQgd2hpY2ggdGhlCmNvbnRyb2xsZXIncyBsZWFkLXRpbWUgZ2F0ZSBibG9ja3MgcHVyY2hhc2VzIGFueXdheSkuIFNhbGVzIHN0YXkgb3Blbgpvbmx5IHdoaWxlIHRoZSBvcmFjbGUga2VlcHMgcmUtYXR0ZXN0aW5nOyBpZiBpdCBzdG9wcyDigJQgb3V0YWdlLApwcm92aWRlciBnYXAsIHVudmVyaWZpYWJsZSBmbGlnaHQg4oCUIHRoZSB3aW5kb3cgbGFwc2VzIGFuZCBwdXJjaGFzZXMKZmFpbCBjbG9zZWQuAAAAAAAACW9wZW5fc2FsZQAAAAAAAAQAAAAAAAAABm9yYWNsZQAAAAAAEwAAAAAAAAAJZmxpZ2h0X2lkAAAAAAAAEQAAAAAAAAAEZGF0ZQAAAAYAAAAAAAAACmV4cGlyZXNfYXQAAAAAAAYAAAAA",
        "AAAAAAAAA5hDbG9zZSB0aGUgc2FsZSB3aW5kb3cgZm9yIGEgZmxpZ2h0IGluc3RhbmNlIGFoZWFkIG9mIGl0cyBleHBpcnkg4oCUCnVzZWQgd2hlbiB0aGUgb3JhY2xlIG9ic2VydmVzIGEgY2FuY2VsbGF0aW9uIG9yIGxvc2VzIGNvbmZpZGVuY2UgaW4KdGhlIGZsaWdodCdzIGlkZW50aXR5IGFuZCBjYW5ub3Qgd2FpdCBmb3IgdGhlIGF1dGhvcml6YXRpb24gdG8gbGFwc2UuCklkZW1wb3RlbnQ6IGNsb3NpbmcgYW4gYWJzZW50IHdpbmRvdyBpcyBhIHNpbGVudCBuby1vcCAobm8gZXZlbnQpLgpgc2V0X2NhbmNlbGxlZGAgYWxzbyBjbG9zZXMgdGhlIHdpbmRvdyBhcyBhIHNpZGUgZWZmZWN0LgoKRGVsaWJlcmF0ZWx5IE5PVCBwYXVzZS1nYXRlZDogdGhpcyB3cml0ZSBvbmx5IHJldm9rZXMgYXV0aG9yaXphdGlvbiDigJQKaXQgZ3JhbnRzIG5vdGhpbmcuIEFscmVhZHktb3BlbiB3aW5kb3dzIGxpdmUgaW4gdGVtcG9yYXJ5IHN0b3JhZ2UgYW5kCnN0YXkgcmVhZGFibGUgKGFuZCBwdXJjaGFzYWJsZSB0aHJvdWdoIHRoZSBjb250cm9sbGVyLCB3aGljaCBtYXkgbm90CmJlIHBhdXNlZCkgZm9yIHVwIHRvIHRoZWlyIDI0IGggdmFsaWRpdHkgcmVnYXJkbGVzcyBvZiB0aGlzCmNvbnRyYWN0J3MgcGF1c2Ugc3RhdGUsIHNvIHBhdXNpbmcgdGhlIG9yYWNsZSBtdXN0IG5vdCBhbHNvIGRpc2FibGUKdGhlIG9uZSB3cml0ZSB0aGF0IGNhbiBraWxsIGluc3VyYWJpbGl0eSBvZiBhIGZsaWdodCB0aGF0IGdvZXMKcHVibGljbHkgY2FuY2VsbGVkIG1pZC13aW5kb3cg4oCUIGdhdGluZyBpdCB3b3VsZCBpbnZlcnQgdGhlIHByb3RlY3Rpb24KZXhhY3RseSB3aGVuIHRoZSBwYXVzZSBzd2l0Y2ggaXMgaW4gdXNlLiBTYW1lIGNvbnZlbnRpb24gYXMgdGhlCmdvdmVybmFuY2UgbW9kdWxlJ3MgcGF1c2UtZXhlbXB0IHByb3RlY3RpdmUgd3JpdGVzLgAAAApjbG9zZV9zYWxlAAAAAAADAAAAAAAAAAZvcmFjbGUAAAAAABMAAAAAAAAACWZsaWdodF9pZAAAAAAAABEAAAAAAAAABGRhdGUAAAAGAAAAAA==",
        "AAAAAAAAADdTZXQgYWN0dWFsIGFycml2YWwgdGltZS4gVHJhbnNpdGlvbnMgQWN0aXZlIOKGkiBMYW5kZWQuAAAAAApzZXRfbGFuZGVkAAAAAAAEAAAAAAAAAAZvcmFjbGUAAAAAABMAAAAAAAAACWZsaWdodF9pZAAAAAAAABEAAAAAAAAABGRhdGUAAAAGAAAAAAAAABNhY3R1YWxfYXJyaXZhbF90aW1lAAAAAAYAAAAA",
        "AAAAAAAAAXRNYXJrIGZsaWdodCBhcyBzZXR0bGVkLiBUcmFuc2l0aW9ucyBUb0JlU2V0dGxlZCog4oaSIFNldHRsZWQuClJlY29yZHMgYHNldHRsZWRfYXRgIHNvIHRoZSBkZWxheWVkLXBydW5lIHdpbmRvdyBzdGFydHMgdGlja2luZy4KRG9lcyBOT1QgcmVtb3ZlIHRoZSBmbGlnaHQgZnJvbSB0aGUgYWN0aXZlIHNldCDigJQgZXZpY3Rpb24gaXMKZGVsZWdhdGVkIHRvIHRoZSBwZXJtaXNzaW9ubGVzcyBgcHJ1bmVfc2V0dGxlZGAgZW50cnksIHdoaWNoIG9ubHkKcmVtb3ZlcyBlbnRyaWVzIG9sZGVyIHRoYW4gYFNFVFRMRURfUkVURU5USU9OX0RBWVNgLiBEb2VzIE5PVCByZW5ldwpmbGlnaHQgVFRMIOKAlCBzZXR0bGVkIGVudHJpZXMgbmF0dXJhbGx5IGV4cGlyZS4AAAALc2V0X3NldHRsZWQAAAAAAwAAAAAAAAAKY29udHJvbGxlcgAAAAAAEwAAAAAAAAAJZmxpZ2h0X2lkAAAAAAAAEQAAAAAAAAAEZGF0ZQAAAAYAAAAA",
        "AAAAAAAAAQ5SZW1vdmUgc2V0dGxlZCBmbGlnaHRzIGZyb20gdGhlIGFjdGl2ZSBzZXQgb25jZSB0aGV5IGhhdmUgYmVlbgpzZXR0bGVkIGZvciBhdCBsZWFzdCBgU0VUVExFRF9SRVRFTlRJT05fREFZU2AuIFBlcm1pc3Npb25sZXNzIOKAlAphbnlvbmUgbWF5IGNhbGwgKG1hdGNoZXMgYGZsaWdodF9wb29sX21hbmFnZXI6OnN3ZWVwX2V4cGlyZWRgCnBhdHRlcm4pLiBJZGVtcG90ZW50OiByZS1jYWxsYWJsZSB3aXRoIG5vIHBhbmljOyBuby1vcCBpZiBub3RoaW5nCmhhcyBhZ2VkIG91dC4AAAAAAA1wcnVuZV9zZXR0bGVkAAAAAAAAAAAAAAA=",
        "AAAAAAAAA/pNYXJrIGZsaWdodCBhcyBjYW5jZWxsZWQuIFRyYW5zaXRpb25zIE5vdEluaXRpYXRlZC9BY3RpdmUg4oaSIENhbmNlbGxlZC4KClVubGlrZSB0aGUgb3RoZXIgb3V0Y29tZSB3cml0ZXMsIHRoaXMgYWxzbyBhY2NlcHRzIGEgZmxpZ2h0IHRoYXQgaGFzCm5ldmVyIGJlZW4gcmVnaXN0ZXJlZC4gUmVnaXN0cmF0aW9uIG5vcm1hbGx5IGhhcHBlbnMgYXMgYSBzaWRlIGVmZmVjdCBvZgp0aGUgZmlyc3QgcHVyY2hhc2UsIHNvIHdpdGhvdXQgdGhpcyBwYXRoIHRoZSBvcmFjbGUgY291bGQgbm90IHJlY29yZCBhCnB1YmxpY2x5IGtub3duIGNhbmNlbGxhdGlvbiB1bnRpbCBzb21lb25lIGJvdWdodCBhIHBvbGljeSDigJQgYW5kIHRoZQpwdXJjaGFzZSBnYXRlLCBzZWVpbmcgbm8gb3JhY2xlIHJlY29yZCwgd291bGQgYWRtaXQgYnV5ZXJzIGludG8gYSBmbGlnaHQKd2hvc2UgcGF5b3V0IGlzIGFscmVhZHkgY2VydGFpbi4gV3JpdGluZyB0aGUgY2FuY2VsbGF0aW9uIGZpcnN0IGNyZWF0ZXMKYSBwdXJjaGFzZS1ibG9ja2luZyByZWNvcmQuCgpBIHJlY29yZCBjcmVhdGVkIHRoaXMgd2F5IGlzIGRlbGliZXJhdGVseSBrZXB0IE9VVCBvZiB0aGUgYWN0aXZlIGZsaWdodApsaXN0IGFuZCB0aGUgcGVuZGluZy1vdXRjb21lcyBjb3VudGVyOiBhYnNlbmNlIG9mIGEgcmVjb3JkIHByb3ZlcyBubwpwb2xpY3kgZXhpc3RzIChldmVyeSBwdXJjaGFzZSByZWdpc3RlcnMgdGhlIGZsaWdodCksIHNvIHRoZXJlIGlzIG5vCnByZW1pdW0gb3IgY29sbGF0ZXJhbCB0byBzZXR0bGUgYW5kIG5vIHVucmVjb2duaXplZCB2YXVsdCBQbkwuIEVudGVyaW5nCnRoZSBjbGFzc2lmeS9zZXR0bGUgcGlwZWxpbmUgd291bGQgc3RyYW5kIHRoZSBmbGlnaHQgZm9yZXZlciBvbiBhCm1pc3NpbmcgcG9vbCBjb25maWcgYW5kIGphbSB0aGUgdmF1bHQncyBzZXR0bGVtZW50IGJhcnJpZXIuIFRoZSByZWNvcmQKaXMgYSB0b21ic3RvbmU6IGl0IGV4aXN0cyBvbmx5IHNvIHRoZSBwdXJjaGFzZSBnYXRlIHNlZXMgYENhbmNlbGxlZGAuAAAAAAANc2V0X2NhbmNlbGxlZAAAAAAAAAMAAAAAAAAABm9yYWNsZQAAAAAAEwAAAAAAAAAJZmxpZ2h0X2lkAAAAAAAAEQAAAAAAAAAEZGF0ZQAAAAYAAAAA",
        "AAAAAAAAAItSZWdpc3RlciBhIGZsaWdodC4gSWRlbXBvdGVudDogcmUtcmVnaXN0ZXJpbmcgdGhlIHNhbWUKYChmbGlnaHRfaWQsIGRhdGUpYCBpcyBhIG5vLW9wIOKAlCBvbmx5IHRoZSBUVEwgaXMKZXh0ZW5kZWQsIG5vIGV2ZW50IGlzIHJlLWVtaXR0ZWQuAAAAAA9yZWdpc3Rlcl9mbGlnaHQAAAAAAwAAAAAAAAAKY29udHJvbGxlcgAAAAAAEwAAAAAAAAAJZmxpZ2h0X2lkAAAAAAAAEQAAAAAAAAAEZGF0ZQAAAAYAAAAA",
        "AAAAAAAAAFBDbGFzc2lmeSBhIGZsaWdodCBmb3Igc2V0dGxlbWVudC4gVHJhbnNpdGlvbnMgTGFuZGVkL0NhbmNlbGxlZCDihpIgVG9CZVNldHRsZWQqLgAAABFzZXRfdG9fYmVfc2V0dGxlZAAAAAAAAAQAAAAAAAAACmNvbnRyb2xsZXIAAAAAABMAAAAAAAAACWZsaWdodF9pZAAAAAAAABEAAAAAAAAABGRhdGUAAAAGAAAAAAAAAAZzdGF0dXMAAAAAB9AAAAAMRmxpZ2h0U3RhdHVzAAAAAA==",
        "AAAAAAAAAEBTZXQgZXN0aW1hdGVkIGFycml2YWwgdGltZS4gVHJhbnNpdGlvbnMgTm90SW5pdGlhdGVkIOKGkiBBY3RpdmUuAAAAFXNldF9lc3RpbWF0ZWRfYXJyaXZhbAAAAAAAAAQAAAAAAAAABm9yYWNsZQAAAAAAEwAAAAAAAAAJZmxpZ2h0X2lkAAAAAAAAEQAAAAAAAAAEZGF0ZQAAAAYAAAAAAAAAFmVzdGltYXRlZF9hcnJpdmFsX3RpbWUAAAAAAAYAAAAA",
        "AAAABQAAANJBIHBhZ2UgZXhwZWN0ZWQgdG8gZXhpc3QgKGl0cyBzbG90cyBhcmUgYmVsb3cgdGhlIGxpdmUgY291bnQpIGNvdWxkIG5vdApiZSByZWFkIOKAlCBpdCBhcmNoaXZlZCBwYXN0IGl0cyBUVEwuIEVudW1lcmF0aW9uIHNraXBwZWQgaXQ7IG9wZXJhdG9ycwptdXN0IHJlc3RvcmUgdGhlIGVudHJ5IHRvIGJyaW5nIGl0cyBmbGlnaHRzIGJhY2sgaW50byBrZWVwZXIgdmlldy4AAAAAAAAAAAARQWN0aXZlUGFnZU1pc3NpbmcAAAAAAAACAAAACHNlbnRpbmVsAAAACXBhZ2VfbWlzcwAAAAAAAAEAAAAAAAAABHBhZ2UAAAAEAAAAAQAAAAA=",
        "AAAAAQAAA/lQZXItZmxpZ2h0IG9yYWNsZSByZWNvcmQsIHN0b3JlZCB1bmRlciBhIGAoZmxpZ2h0X2lkLCBkYXRlKWAga2V5LgoKVGhlIGBkYXRlYCBrZXkgY29tcG9uZW50IGlzIHRoZSBmbGlnaHQncyAqKlVUQyBkZXBhcnR1cmUgZGF5Kiog4oCUIG1pZG5pZ2h0ClVUQyBvZiB0aGUgZGVwYXJ0dXJlIGRhdGUsIGluIHVuaXggc2Vjb25kcyAoYSBtdWx0aXBsZSBvZiA4Niw0MDA7IHRoZQpwdXJjaGFzZSBwYXRoIGVuZm9yY2VzIHRoZSBhbGlnbm1lbnQpLiBFeGVjdXRvcnMgYW5kIGZyb250ZW5kcyBNVVNUCmRlcml2ZSBpdCBmcm9tIHRoZSBkZXBhcnR1cmUgdGltZXN0YW1wICoqaW4gVVRDKiosIG5ldmVyIGluIHRoZSBhaXJwb3J0J3MKbG9jYWwgdGltZXpvbmU6IGBzZXRfZXN0aW1hdGVkX2Fycml2YWxgIC8gYHNldF9sYW5kZWRgIHJlamVjdCBhbnkgYXJyaXZhbAp0aW1lc3RhbXAgYmVsb3cgYGRhdGVgLCBhbmQgYSBzaG9ydCBmbGlnaHQgZGVwYXJ0aW5nIGVhcmx5LW1vcm5pbmcgbG9jYWwKdGltZSBlYXN0IG9mIFVUQyAoZS5nLiAwMTowMCBKU1QgPSAxNjowMCBVVEMgdGhlIHByZXZpb3VzIGRheSkgY2FuIGFycml2ZQpiZWZvcmUgbWlkbmlnaHQgVVRDIG9mIGl0cyAqbG9jYWwqIGRlcGFydHVyZSBkYXRlLiBBIGNvbXBvbmVudCBrZXlpbmcKaW5zdGFuY2VzIGJ5IGxvY2FsIGRhdGUgd291bGQgdGhlcmVmb3JlIGhhdmUgbGVnaXRpbWF0ZSBvdXRjb21lIHdyaXRlcwpyZWplY3RlZCAoYEludmFsaWRUaW1lc3RhbXBgKTsgdGhlIGZsaWdodCB3b3VsZCBzdHJhbmQgaW4gYEFjdGl2ZWAgYW5kIGJlCnZvaWRlZCBhcyBvbi10aW1lIGJ5IHRoZSBhY3RpdmUgdGltZW91dCwgaXJyZXZlcnNpYmx5IGRlbnlpbmcgZ2VudWluZWx5CmRlbGF5ZWQgb3IgY2FuY2VsbGVkIHRyYXZlbGVycy4gVGhpcyBpbnZhcmlhbnQgY2FycmllcyB0aGUgc2FtZSB3ZWlnaHQgYXMKdGhlIGBzY2hlZHVsZWRfaW5gIHJ1bGUgYmVsb3cgYW5kIG11c3Qgc3Vydml2ZSBldmVyeSBleGVjdXRvciBiYWNrZW5kCm1pZ3JhdGlvbi4AAAAAAAAAAAAACkZsaWdodERhdGEAAAAAAAQAAAAAAAAAE2FjdHVhbF9hcnJpdmFsX3RpbWUAAAAABgAAAj1UaGUgZmxpZ2h0J3MgU0NIRURVTEVEIGFycml2YWwgdGltZSAodW5peCBzZWNvbmRzKSDigJQgdGhlIHRpbWV0YWJsZQp2YWx1ZSwgd3JpdHRlbiBvbmNlIGF0IGBOb3RJbml0aWF0ZWQg4oaSIEFjdGl2ZWAuIERlbGF5IGNsYXNzaWZpY2F0aW9uCmNvbXB1dGVzIGBhY3R1YWxfYXJyaXZhbF90aW1lIOKIkiBlc3RpbWF0ZWRfYXJyaXZhbF90aW1lYCBhZ2FpbnN0IHRoZQpwZXItcm91dGUgYGRlbGF5X2hvdXJzYCB0aHJlc2hvbGQsIHNvIHRoaXMgZmllbGQgaXMgdGhlIGJhc2VsaW5lIGV2ZXJ5CnBheW91dCBkZWNpc2lvbiBpcyBtZWFzdXJlZCBmcm9tLiBPcmFjbGUgZXhlY3V0b3JzIE1VU1Qgd3JpdGUgdGhlCnB1Ymxpc2hlZCBzY2hlZHVsZSAoQWVyb0FQSSBgc2NoZWR1bGVkX2luYCksIE5FVkVSIGEgZGVsYXktYWRqdXN0ZWQKbGl2ZSBlc3RpbWF0ZSAoYGVzdGltYXRlZF9pbmApIOKAlCBhIGxpdmUgRVRBIGFic29yYnMgYW5ub3VuY2VkIGRlbGF5cwphbmQgd291bGQgY2xhc3NpZnkgZ2VudWluZWx5IGRlbGF5ZWQgZmxpZ2h0cyBhcyBvbi10aW1lLCBzaWxlbnRseQpkZW55aW5nIHZhbGlkIGNsYWltcy4AAAAAAAAWZXN0aW1hdGVkX2Fycml2YWxfdGltZQAAAAAABgAAAAAAAAAKc2V0dGxlZF9hdAAAAAAABgAAAAAAAAAGc3RhdHVzAAAAAAfQAAAADEZsaWdodFN0YXR1cw==",
        "AAAAAgAAAAAAAAAAAAAADEZsaWdodFN0YXR1cwAAAAgAAAAAAAAAAAAAAAxOb3RJbml0aWF0ZWQAAAAAAAAAAAAAAAZBY3RpdmUAAAAAAAAAAAAAAAAABkxhbmRlZAAAAAAAAAAAAAAAAAAJQ2FuY2VsbGVkAAAAAAAAAAAAAAAAAAARVG9CZVNldHRsZWRPblRpbWUAAAAAAAAAAAAAAAAAABJUb0JlU2V0dGxlZERlbGF5ZWQAAAAAAAAAAAAAAAAAFFRvQmVTZXR0bGVkQ2FuY2VsbGVkAAAAAAAAAAAAAAAHU2V0dGxlZAA=",
        "AAAABQAAATFBdWRpdC10cmFpbCBldmVudCBlbWl0dGVkIG9uIGV2ZXJ5IGNvbnRyYWN0IHVwZ3JhZGUuIERlZmluZWQgaGVyZSAocmF0aGVyCnRoYW4gcGVyLWNvbnRyYWN0KSBzbyBldmVyeSBjb250cmFjdCdzIHVwZ3JhZGUgbGVhdmVzIGFuIGlkZW50aWNhbCB0cmFpbC4KVGhlIGVtaXR0aW5nIGNvbnRyYWN0IGFkZHJlc3MgcmlkZXMgdGhlIGV2ZW50IGVudmVsb3BlLCBzbyBvZmYtY2hhaW4KaW5kZXhlcnMga25vdyAqd2hpY2gqIGNvbnRyYWN0IHdhcyB1cGdyYWRlZDsgYHdhc21faGFzaGAgYW5kIGB2ZXJzaW9uYApyZWNvcmQgKnRvIHdoYXQqLgAAAAAAAAAAAAAQQ29udHJhY3RVcGdyYWRlZAAAAAIAAAAIc2VudGluZWwAAAAHdXBncmFkZQAAAAACAAAAAAAAAAl3YXNtX2hhc2gAAAAAAAPuAAAAIAAAAAEAAAAAAAAAB3ZlcnNpb24AAAAABAAAAAAAAAAA",
        "AAAABAAAAAAAAAAAAAAAEVJvbGVUcmFuc2ZlckVycm9yAAAAAAAABAAAAAAAAAARTm9QZW5kaW5nVHJhbnNmZXIAAAAAAAiYAAAAAAAAABZJbnZhbGlkTGl2ZVVudGlsTGVkZ2VyAAAAAAiZAAAAAAAAABVJbnZhbGlkUGVuZGluZ0FjY291bnQAAAAAAAiaAAAAAAAAAA9UcmFuc2ZlckV4cGlyZWQAAAAImw==",
        "AAAABAAAAAAAAAAAAAAADE93bmFibGVFcnJvcgAAAAMAAAAAAAAAC093bmVyTm90U2V0AAAACDQAAAAAAAAAElRyYW5zZmVySW5Qcm9ncmVzcwAAAAAINQAAAAAAAAAPT3duZXJBbHJlYWR5U2V0AAAACDY=",
        "AAAABQAAADZFdmVudCBlbWl0dGVkIHdoZW4gYW4gb3duZXJzaGlwIHRyYW5zZmVyIGlzIGluaXRpYXRlZC4AAAAAAAAAAAART3duZXJzaGlwVHJhbnNmZXIAAAAAAAABAAAAEm93bmVyc2hpcF90cmFuc2ZlcgAAAAAAAwAAAAAAAAAJb2xkX293bmVyAAAAAAAAEwAAAAAAAAAAAAAACW5ld19vd25lcgAAAAAAABMAAAAAAAAAAAAAABFsaXZlX3VudGlsX2xlZGdlcgAAAAAAAAQAAAAAAAAAAg==",
        "AAAABQAAACpFdmVudCBlbWl0dGVkIHdoZW4gb3duZXJzaGlwIGlzIHJlbm91bmNlZC4AAAAAAAAAAAAST3duZXJzaGlwUmVub3VuY2VkAAAAAAABAAAAE293bmVyc2hpcF9yZW5vdW5jZWQAAAAAAQAAAAAAAAAJb2xkX293bmVyAAAAAAAAEwAAAAAAAAAC",
        "AAAABQAAADZFdmVudCBlbWl0dGVkIHdoZW4gYW4gb3duZXJzaGlwIHRyYW5zZmVyIGlzIGNvbXBsZXRlZC4AAAAAAAAAAAAaT3duZXJzaGlwVHJhbnNmZXJDb21wbGV0ZWQAAAAAAAEAAAAcb3duZXJzaGlwX3RyYW5zZmVyX2NvbXBsZXRlZAAAAAEAAAAAAAAACW5ld19vd25lcgAAAAAAABMAAAAAAAAAAg==",
        "AAAABQAAACpFdmVudCBlbWl0dGVkIHdoZW4gdGhlIGNvbnRyYWN0IGlzIHBhdXNlZC4AAAAAAAAAAAAGUGF1c2VkAAAAAAABAAAABnBhdXNlZAAAAAAAAAAAAAI=",
        "AAAABQAAACxFdmVudCBlbWl0dGVkIHdoZW4gdGhlIGNvbnRyYWN0IGlzIHVucGF1c2VkLgAAAAAAAAAIVW5wYXVzZWQAAAABAAAACHVucGF1c2VkAAAAAAAAAAI=",
        "AAAABAAAAAAAAAAAAAAADVBhdXNhYmxlRXJyb3IAAAAAAAACAAAANFRoZSBvcGVyYXRpb24gZmFpbGVkIGJlY2F1c2UgdGhlIGNvbnRyYWN0IGlzIHBhdXNlZC4AAAANRW5mb3JjZWRQYXVzZQAAAAAAA+gAAAA4VGhlIG9wZXJhdGlvbiBmYWlsZWQgYmVjYXVzZSB0aGUgY29udHJhY3QgaXMgbm90IHBhdXNlZC4AAAANRXhwZWN0ZWRQYXVzZQAAAAAAA+k=" ]),
      options
    )
  }
  public readonly fromJSON = {
    extend_ttl: this.txFromJSON<null>,
        set_oracle: this.txFromJSON<null>,
        set_controller: this.txFromJSON<null>,
        evict_missing_flight: this.txFromJSON<null>,
        pause: this.txFromJSON<null>,
        paused: this.txFromJSON<boolean>,
        unpause: this.txFromJSON<null>,
        get_owner: this.txFromJSON<Option<string>>,
        accept_ownership: this.txFromJSON<null>,
        renounce_ownership: this.txFromJSON<null>,
        transfer_ownership: this.txFromJSON<null>,
        is_sale_open: this.txFromJSON<boolean>,
        get_sale_auth: this.txFromJSON<Option<u64>>,
        get_flight_data: this.txFromJSON<FlightData>,
        has_flight_data: this.txFromJSON<boolean>,
        is_flight_listed: this.txFromJSON<boolean>,
        get_active_flights: this.txFromJSON<Array<readonly [string, u64]>>,
        get_pending_outcomes: this.txFromJSON<u64>,
        has_pending_outcomes: this.txFromJSON<boolean>,
        get_authorized_oracle: this.txFromJSON<string>,
        get_flights_by_status: this.txFromJSON<Array<readonly [string, u64]>>,
        get_active_flight_count: this.txFromJSON<u32>,
        get_active_flights_page: this.txFromJSON<Array<readonly [string, u64]>>,
        get_authorized_controller: this.txFromJSON<Option<string>>,
        upgrade: this.txFromJSON<null>,
        version: this.txFromJSON<u32>,
        open_sale: this.txFromJSON<null>,
        close_sale: this.txFromJSON<null>,
        set_landed: this.txFromJSON<null>,
        set_settled: this.txFromJSON<null>,
        prune_settled: this.txFromJSON<null>,
        set_cancelled: this.txFromJSON<null>,
        register_flight: this.txFromJSON<null>,
        set_to_be_settled: this.txFromJSON<null>,
        set_estimated_arrival: this.txFromJSON<null>
  }
}