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
  301: {message:"SolvencyRatioOutOfBounds"},
  303: {message:"ClaimExpiryWindowOutOfBounds"},
  304: {message:"NotAuthorizedKeeper"},
  305: {message:"NotOwnerOrGovernanceAdmin"},
  306: {message:"BuyerNotWhitelisted"},
  307: {message:"RouteDisabled"},
  308: {message:"RouteNotWhitelisted"},
  309: {message:"DepartureTooSoon"},
  310: {message:"DepartureTooFarInFuture"},
  311: {message:"FlightNotOpenForPurchase"},
  312: {message:"InsufficientVaultCapital"},
  313: {message:"DateNotDayAligned"},
  314: {message:"MinLeadTimeLeavesNoBookingWindow"},
  315: {message:"OracleDataUnavailable"},
  316: {message:"FlightDataStillPresent"},
  317: {message:"FlightStillListed"},
  318: {message:"FlightNotRegisteredInPool"},
  319: {message:"SaleNotOpen"},
  320: {message:"SnapshotTermsExceedLimits"},
  321: {message:"FlightNotListed"}
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
   * Extend instance TTL. Called by cron as a safety net, and reused
   * internally as the single instance-TTL entry point (other functions call
   * `Self::extend_ttl`).
   */
  extend_ttl: (options?: MethodOptions) => Promise<AssembledTransaction<null>>

  /**
   * Construct and simulate a set_keeper transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Sets the authorized keeper address.
   */
  set_keeper: ({keeper}: {keeper: string}, options?: MethodOptions) => Promise<AssembledTransaction<null>>

  /**
   * Construct and simulate a set_min_lead_time transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Sets the minimum lead time (in seconds) required between purchase and departure.
   */
  set_min_lead_time: ({seconds}: {seconds: u64}, options?: MethodOptions) => Promise<AssembledTransaction<null>>

  /**
   * Construct and simulate a set_solvency_ratio transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Sets the vault solvency ratio (validated against allowed bounds) and
   * mirrors it into the RiskVault in the same transaction. The controller
   * enforces the ratio when policies increase locked liabilities; the
   * vault enforces the identical value when assets leave through LP exits.
   * Pushing (rather than the vault reading it back) is required because
   * the vault cannot call the controller while the controller is invoking
   * it, and atomicity guarantees the two copies never diverge.
   */
  set_solvency_ratio: ({ratio}: {ratio: u32}, options?: MethodOptions) => Promise<AssembledTransaction<null>>

  /**
   * Construct and simulate a set_claim_expiry_window transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Sets the claim expiry window (in seconds) after settlement (validated against allowed bounds).
   * 
   * Note: this window is measured from SETTLEMENT time, but the pool
   * additionally caps each claim deadline at `flight_date +
   * MAX_CLAIM_DEADLINE_AFTER_DATE_SECS` (the buyer-proof-lifetime bound). So
   * when settlement runs late the EFFECTIVE window can be shorter than the
   * value set here — it never extends a claim deadline past that date-anchored
   * cap. Configure with that ceiling in mind.
   */
  set_claim_expiry_window: ({seconds}: {seconds: u64}, options?: MethodOptions) => Promise<AssembledTransaction<null>>

  /**
   * Construct and simulate a settle_flight transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Settle one exact classified flight without scanning the active list.
   * Companion to `classify_flight` (see there for the latency rationale):
   * the keeper settles the tuple it just classified instead of waiting
   * for the `execute_settlements` cursor to rotate to it, so the vault's
   * settlement barrier releases as soon as the outcome's PnL is
   * recognized rather than after a full-set rotation. The flight must be
   * in the oracle's active set. Idempotent on state: returns `true` when
   * the flight settled, `false` when it is not in a `ToBeSettled*` state
   * (or its pool config is missing, which is separately diagnosed).
   */
  settle_flight: ({keeper, flight_id, date}: {keeper: string, flight_id: string, date: u64}, options?: MethodOptions) => Promise<AssembledTransaction<boolean>>

  /**
   * Construct and simulate a classify_flight transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Classify one exact flight instance without scanning the active list.
   * The rotating `classify_flights` sweep guarantees eventual coverage,
   * but its worst-case latency grows with total active-set occupancy —
   * future bookings and recently-settled rows share the same enumeration
   * windows — and while a public outcome waits for the cursor, the
   * vault's settlement barrier stays engaged protocol-wide. The off-chain
   * keeper knows exactly which flight's outcome it just wrote, so it
   * classifies that tuple directly; the sweep remains the repair backstop
   * for anything the targeted path misses.
   * 
   * Restricted to flights currently in the oracle's active set — the same
   * population the sweep enumerates — so this entry point can never touch
   * cancellation tombstones or evicted flights. Idempotent on state:
   * returns `true` when a `ToBeSettled*` transition was written, `false`
   * when the flight needs no classification (yet).
   */
  classify_flight: ({keeper, flight_id, date}: {keeper: string, flight_id: string, date: u64}, options?: MethodOptions) => Promise<AssembledTransaction<boolean>>

  /**
   * Construct and simulate a classify_flights transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Iterate the oracle's active-flight list (the canonical source of
   * in-flight registrations plus a 7-day retention window of recently-
   * settled flights) and write `ToBeSettled*` classifications back to the
   * oracle: Landed flights are classified on-time/delayed against
   * FlightPoolManager's locked delay threshold, Cancelled maps directly to
   * `ToBeSettledCancelled`, and NotInitiated/Active flights stuck past
   * their lifecycle timeouts are voided (classified `ToBeSettledOnTime` —
   * premiums to the vault, no payout).
   */
  classify_flights: ({keeper}: {keeper: string}, options?: MethodOptions) => Promise<AssembledTransaction<null>>

  /**
   * Construct and simulate a execute_settlements transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Iterate the oracle's active-flight list and process every flight that's
   * in a `ToBeSettled*` status: move money between FlightPoolManager and
   * RiskVault, then mark the oracle entry as `Settled`. Processes at most
   * `MAX_SETTLE_BATCH` flights per call; the rotating cursor covers the
   * full list across repeated calls.
   * 
   * Queue drain and share-price snapshot are NOT done here — see
   * `run_queue_maintenance`. Splitting them ensures
   * underwriter withdrawals can still be processed when the settlement
   * loop runs near the resource budget.
   */
  execute_settlements: ({keeper}: {keeper: string}, options?: MethodOptions) => Promise<AssembledTransaction<null>>

  /**
   * Construct and simulate a run_queue_maintenance transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Drain both LP request queues and refresh the share-price snapshot.
   * Keeper-only. Decoupled from `execute_settlements` so the queues
   * cannot be blocked by gas exhaustion in the settlement loop; keeper
   * can run this on its own cadence. Deposits are processed first: freshly
   * minted entries add managed assets, which can fund matured exits in
   * the same pass.
   */
  run_queue_maintenance: ({keeper}: {keeper: string}, options?: MethodOptions) => Promise<AssembledTransaction<null>>

  /**
   * Construct and simulate a settle_evicted_flight transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Terminal reconciliation for a flight the owner evicted from the
   * oracle's active list (`oracle.evict_missing_flight`). Eviction frees
   * the oracle-side list slot and releases the settlement barrier, but on
   * its own it would leave the flight's pool bucket `Active` forever and
   * its vault collateral locked forever — the flight is outside keeper
   * enumeration, so no settlement pass can ever reach it. This entry point
   * completes the release: the bucket settles like a voided flight (held
   * premiums forwarded to the vault as income, collateral unlocked, no
   * payout — with no oracle data there is no on-chain outcome to pay
   * against), which also frees the bucket's pool active-list slot.
   * 
   * Owner-only, and restricted to flights provably outside the normal
   * pipeline:
   * - the oracle must have NO `FlightData` row (the same gate eviction
   * itself enforces — a present row means the flight is restorable, and
   * restore-and-settle is the correct path). A row restored AFTER
   * eviction blocks this reconciliation, but only temporarily: an
   * evicted 
   */
  settle_evicted_flight: ({flight_id, date}: {flight_id: string, date: u64}, options?: MethodOptions) => Promise<AssembledTransaction<null>>

  /**
   * Construct and simulate a execute_settlements_bounded transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * `execute_settlements` with a caller-chosen window size, clamped to
   * `[1, MAX_SETTLE_BATCH]`. Operational escape hatch: settlement failure
   * is atomic, so if a window ever exceeds the network's per-transaction
   * resource budgets (an unusually write-heavy mix, tightened network
   * limits, or accounting drift in the batch sizing), the keeper can
   * shrink the window — down to a single flight — and still make
   * progress, instead of every retry reverting identically at the fixed
   * default size.
   */
  execute_settlements_bounded: ({keeper, limit}: {keeper: string, limit: u32}, options?: MethodOptions) => Promise<AssembledTransaction<null>>

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
   * Construct and simulate a get_stats transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Returns aggregate stats: total policies sold, premiums collected, and
   * payouts distributed. The payouts figure is the gross claimable value
   * opened by delayed/cancelled settlements (payoff × buyer_count) — it
   * includes the premium portion already held by the pool, not just the
   * vault's outflow.
   */
  get_stats: (options?: MethodOptions) => Promise<AssembledTransaction<readonly [u64, i128, i128]>>

  /**
   * Construct and simulate a get_keeper transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Returns the currently authorized keeper address.
   */
  get_keeper: (options?: MethodOptions) => Promise<AssembledTransaction<string>>

  /**
   * Construct and simulate a get_oracle transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Returns the configured OracleAggregator address. The controller's oracle
   * pointer is immutable (set once at construction, no setter), and the
   * RiskVault's settlement barrier MUST consult this exact same oracle — the
   * barrier reads pending outcomes from the vault's oracle while outcomes are
   * recorded against this one, so a divergence silently defeats the barrier
   * for every policy (see `RiskVault::set_oracle`). Exposed so that
   * invariant — otherwise only a deployment-verification obligation — is
   * checkable on-chain: `controller.get_oracle() == vault.get_oracle()`.
   */
  get_oracle: (options?: MethodOptions) => Promise<AssembledTransaction<string>>

  /**
   * Construct and simulate a get_governance transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Returns the configured GovernanceModule contract address (immutable;
   * exposed for deployment verification alongside the other wiring
   * getters).
   */
  get_governance: (options?: MethodOptions) => Promise<AssembledTransaction<string>>

  /**
   * Construct and simulate a get_risk_vault transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Returns the configured RiskVault contract address. Immutable
   * (construction-time pointer, no setter). Exposed so the wiring
   * invariant `controller.get_risk_vault() == pool.get_risk_vault()` is
   * checkable on-chain, like the oracle-identity check above — a
   * mismatch would send settled premiums to a vault the controller
   * never credits, bricking settlement at the premium-receipt guard.
   */
  get_risk_vault: (options?: MethodOptions) => Promise<AssembledTransaction<string>>

  /**
   * Construct and simulate a is_whitelisted transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Whether `addr` holds a currently valid whitelist approval — added,
   * not removed, and not past its 180-day inactivity deadline (each
   * purchase slides the deadline forward). Returns `false` for any
   * address never added, removed, or dormant past the window.
   */
  is_whitelisted: ({addr}: {addr: string}, options?: MethodOptions) => Promise<AssembledTransaction<boolean>>

  /**
   * Construct and simulate a get_asset_token transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Returns the configured settlement-asset token address. Immutable.
   * Exposed so `controller.get_asset_token() == pool.get_asset_token()
   * == vault's underlying asset` is checkable on-chain: premiums are
   * transferred in this asset while the pool pays claims and the vault
   * prices shares in theirs, so a divergence surfaces only at settlement
   * time (as a failed transfer or receipt guard) — never at any earlier,
   * cheaper check.
   */
  get_asset_token: (options?: MethodOptions) => Promise<AssembledTransaction<string>>

  /**
   * Construct and simulate a whitelist_enabled transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Whether the buyer whitelist gate is currently active.
   */
  whitelist_enabled: (options?: MethodOptions) => Promise<AssembledTransaction<boolean>>

  /**
   * Construct and simulate a get_solvency_ratio transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Returns the configured vault solvency ratio.
   */
  get_solvency_ratio: (options?: MethodOptions) => Promise<AssembledTransaction<u32>>

  /**
   * Construct and simulate a get_flight_pool_manager transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Returns the configured FlightPoolManager contract address.
   */
  get_flight_pool_manager: (options?: MethodOptions) => Promise<AssembledTransaction<string>>

  /**
   * Construct and simulate a get_flights_for_traveler transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Per-traveler index — returns the address's most recent
   * `(flight_id, date)` purchases, bounded at `MAX_TRAVELER_FLIGHTS` (the
   * oldest entries are evicted once the cap is reached; full history is
   * reconstructable from events). Frontend filters by current status
   * (looked up in FlightPoolManager / oracle).
   */
  get_flights_for_traveler: ({address}: {address: string}, options?: MethodOptions) => Promise<AssembledTransaction<Array<readonly [string, u64]>>>

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
   * Construct and simulate a buy_insurance transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Buys flight-delay insurance for a traveler: validates the route and timing, checks solvency, collects the premium, locks collateral, and records the policy.
   */
  buy_insurance: ({traveler, flight_id, origin, dest, date}: {traveler: string, flight_id: string, origin: string, dest: string, date: u64}, options?: MethodOptions) => Promise<AssembledTransaction<null>>

  /**
   * Construct and simulate a add_whitelisted_buyer transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Add `addr` to the buyer whitelist. Callable by the owner or any address
   * flagged as admin on `GovernanceModule`. Idempotent — re-adding an
   * existing entry restarts its approval window without panic.
   * Intentionally NOT gated by Pausable so admins can keep the list
   * current during a pause.
   * 
   * Approval lifetime model (deliberate): an approval carries an explicit
   * on-chain deadline (`now + 180 days`), and every purchase the buyer
   * makes slides it forward. A buyer DORMANT for the full window lapses —
   * the purchase gate compares the ledger clock against the stored
   * deadline and rejects — and must be re-approved. This is periodic
   * re-attestation of inactive accounts: it fails closed, and recovery is
   * one admin call. The deadline is contract state, NOT the entry's
   * storage TTL: an archived Persistent entry is restored with its
   * original value on next access rather than read as absent, so a TTL
   * alone could never expire an authorization.
   * 
   * Off-chain monitoring note: deadline SLIDES emit no event, and a
   * slide is skipped while th
   */
  add_whitelisted_buyer: ({caller, addr}: {caller: string, addr: string}, options?: MethodOptions) => Promise<AssembledTransaction<null>>

  /**
   * Construct and simulate a set_whitelist_enabled transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Owner-only kill-switch. When `false` (default), `buy_insurance` is
   * open to anyone. When `true`, only addresses holding an unexpired
   * `BuyerApprovalExpiry` deadline (added via `add_whitelisted_buyer`,
   * not lapsed) can call `buy_insurance`.
   */
  set_whitelist_enabled: ({enabled}: {enabled: boolean}, options?: MethodOptions) => Promise<AssembledTransaction<null>>

  /**
   * Construct and simulate a remove_whitelisted_buyer transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Remove `addr` from the whitelist. Same auth as `add_whitelisted_buyer`.
   * Removing an address that was never whitelisted is a no-op (writes a
   * zero deadline, emits the event). The entry is overwritten rather than
   * deleted so a re-add later still refreshes a known key — keeps the
   * Persistent footprint stable for the off-chain TTL cron — and so a
   * later archival restore brings back the revocation, never an approval.
   */
  remove_whitelisted_buyer: ({caller, addr}: {caller: string, addr: string}, options?: MethodOptions) => Promise<AssembledTransaction<null>>

}
export class Client extends ContractClient {
  static async deploy<T = Client>(
        /** Constructor/Initialization Args for the contract's `__constructor` method */
        {owner, governance, risk_vault, oracle, flight_pool_manager, asset_token, authorized_keeper, min_lead_time_secs, claim_expiry_window_secs}: {owner: string, governance: string, risk_vault: string, oracle: string, flight_pool_manager: string, asset_token: string, authorized_keeper: string, min_lead_time_secs: u64, claim_expiry_window_secs: u64},
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
    return ContractClient.deploy({owner, governance, risk_vault, oracle, flight_pool_manager, asset_token, authorized_keeper, min_lead_time_secs, claim_expiry_window_secs}, options)
  }
  constructor(public readonly options: ContractClientOptions) {
    super(
      new ContractSpec([ "AAAAAAAAAJxFeHRlbmQgaW5zdGFuY2UgVFRMLiBDYWxsZWQgYnkgY3JvbiBhcyBhIHNhZmV0eSBuZXQsIGFuZCByZXVzZWQKaW50ZXJuYWxseSBhcyB0aGUgc2luZ2xlIGluc3RhbmNlLVRUTCBlbnRyeSBwb2ludCAob3RoZXIgZnVuY3Rpb25zIGNhbGwKYFNlbGY6OmV4dGVuZF90dGxgKS4AAAAKZXh0ZW5kX3R0bAAAAAAAAAAAAAA=",
        "AAAAAAAAACNTZXRzIHRoZSBhdXRob3JpemVkIGtlZXBlciBhZGRyZXNzLgAAAAAKc2V0X2tlZXBlcgAAAAAAAQAAAAAAAAAGa2VlcGVyAAAAAAATAAAAAA==",
        "AAAAAAAAA8xJbml0aWFsaXplIHRoZSBjb250cm9sbGVyIOKAlCB0aGUgb3JjaGVzdHJhdG9yIHdpcmluZyB0b2dldGhlciB0aGUKZ292ZXJuYW5jZSwgdmF1bHQsIG9yYWNsZSwgYW5kIHBvb2wgY29udHJhY3RzLgoKIyBBcmd1bWVudHMKKiBgb3duZXJgIC0gQWRkcmVzcyBncmFudGVkIG93bmVyIHJpZ2h0cyAocm90YXRlIHRoZSBrZWVwZXIsIHR1bmUKcGFyYW1ldGVycywgcGF1c2UsIHVwZ3JhZGUpLgoqIGBnb3Zlcm5hbmNlYCAtIEFkZHJlc3Mgb2YgdGhlIEdvdmVybmFuY2VNb2R1bGUgdGhhdCByZXNvbHZlcyByb3V0ZQp0ZXJtcyAocHJlbWl1bS9wYXlvZmYvZGVsYXkpLgoqIGByaXNrX3ZhdWx0YCAtIEFkZHJlc3Mgb2YgdGhlIFJpc2tWYXVsdCBob2xkaW5nIGNvbGxhdGVyYWwgYW5kIHBheWluZwpvdXQgY2xhaW1zLgoqIGBvcmFjbGVgIC0gQWRkcmVzcyBvZiB0aGUgT3JhY2xlQWdncmVnYXRvciBwcm92aWRpbmcgZmxpZ2h0IG91dGNvbWVzLgoqIGBmbGlnaHRfcG9vbF9tYW5hZ2VyYCAtIEFkZHJlc3Mgb2YgdGhlIEZsaWdodFBvb2xNYW5hZ2VyIHRyYWNraW5nCnBlci1mbGlnaHQgYnV5ZXJzIGFuZCBwcmVtaXVtcy4KKiBgYXNzZXRfdG9rZW5gIC0gU0FDIGFkZHJlc3Mgb2YgdGhlIHNldHRsZW1lbnQgYXNzZXQgcHJlbWl1bXMgYXJlCmNvbGxlY3RlZCBpbi4KKiBgYXV0aG9yaXplZF9rZWVwZXJgIC0gQWRkcmVzcyBwZXJtaXR0ZWQgdG8gdHJpZ2dlciBzZXR0bGVtZW50LgoqIGBtaW5fbGVhZF90aW1lX3NlY3NgIC0gTWluaW11bSBudW1iZXIgb2Ygc2Vjb25kcyBiZXR3ZWVuIHB1cmNoYXNlIGFuZApkZXBhcnR1cmU7IGJ1eXMgdG9vIGNsb3NlIHRvIGRlcGFydHVyZSBhcmUgcmVqZWN0ZWQuCiogYGNsYWltX2V4cGlyeV93aW5kb3dfc2Vjc2AgLSBOdW1iZXIgb2Ygc2Vjb25kcyBhZnRlciBzZXR0bGVtZW50IGR1cmluZwp3aGljaCBhIHBheW91dCByZW1haW5zIGNsYWltYWJsZSBiZWZvcmUgaXQgZXhwaXJlcy4AAAANX19jb25zdHJ1Y3RvcgAAAAAAAAkAAAAAAAAABW93bmVyAAAAAAAAEwAAAAAAAAAKZ292ZXJuYW5jZQAAAAAAEwAAAAAAAAAKcmlza192YXVsdAAAAAAAEwAAAAAAAAAGb3JhY2xlAAAAAAATAAAAAAAAABNmbGlnaHRfcG9vbF9tYW5hZ2VyAAAAABMAAAAAAAAAC2Fzc2V0X3Rva2VuAAAAABMAAAAAAAAAEWF1dGhvcml6ZWRfa2VlcGVyAAAAAAAAEwAAAAAAAAASbWluX2xlYWRfdGltZV9zZWNzAAAAAAAGAAAAAAAAABhjbGFpbV9leHBpcnlfd2luZG93X3NlY3MAAAAGAAAAAA==",
        "AAAAAAAAAFBTZXRzIHRoZSBtaW5pbXVtIGxlYWQgdGltZSAoaW4gc2Vjb25kcykgcmVxdWlyZWQgYmV0d2VlbiBwdXJjaGFzZSBhbmQgZGVwYXJ0dXJlLgAAABFzZXRfbWluX2xlYWRfdGltZQAAAAAAAAEAAAAAAAAAB3NlY29uZHMAAAAABgAAAAA=",
        "AAAAAAAAAdhTZXRzIHRoZSB2YXVsdCBzb2x2ZW5jeSByYXRpbyAodmFsaWRhdGVkIGFnYWluc3QgYWxsb3dlZCBib3VuZHMpIGFuZAptaXJyb3JzIGl0IGludG8gdGhlIFJpc2tWYXVsdCBpbiB0aGUgc2FtZSB0cmFuc2FjdGlvbi4gVGhlIGNvbnRyb2xsZXIKZW5mb3JjZXMgdGhlIHJhdGlvIHdoZW4gcG9saWNpZXMgaW5jcmVhc2UgbG9ja2VkIGxpYWJpbGl0aWVzOyB0aGUKdmF1bHQgZW5mb3JjZXMgdGhlIGlkZW50aWNhbCB2YWx1ZSB3aGVuIGFzc2V0cyBsZWF2ZSB0aHJvdWdoIExQIGV4aXRzLgpQdXNoaW5nIChyYXRoZXIgdGhhbiB0aGUgdmF1bHQgcmVhZGluZyBpdCBiYWNrKSBpcyByZXF1aXJlZCBiZWNhdXNlCnRoZSB2YXVsdCBjYW5ub3QgY2FsbCB0aGUgY29udHJvbGxlciB3aGlsZSB0aGUgY29udHJvbGxlciBpcyBpbnZva2luZwppdCwgYW5kIGF0b21pY2l0eSBndWFyYW50ZWVzIHRoZSB0d28gY29waWVzIG5ldmVyIGRpdmVyZ2UuAAAAEnNldF9zb2x2ZW5jeV9yYXRpbwAAAAAAAQAAAAAAAAAFcmF0aW8AAAAAAAAEAAAAAA==",
        "AAAAAAAAAd9TZXRzIHRoZSBjbGFpbSBleHBpcnkgd2luZG93IChpbiBzZWNvbmRzKSBhZnRlciBzZXR0bGVtZW50ICh2YWxpZGF0ZWQgYWdhaW5zdCBhbGxvd2VkIGJvdW5kcykuCgpOb3RlOiB0aGlzIHdpbmRvdyBpcyBtZWFzdXJlZCBmcm9tIFNFVFRMRU1FTlQgdGltZSwgYnV0IHRoZSBwb29sCmFkZGl0aW9uYWxseSBjYXBzIGVhY2ggY2xhaW0gZGVhZGxpbmUgYXQgYGZsaWdodF9kYXRlICsKTUFYX0NMQUlNX0RFQURMSU5FX0FGVEVSX0RBVEVfU0VDU2AgKHRoZSBidXllci1wcm9vZi1saWZldGltZSBib3VuZCkuIFNvCndoZW4gc2V0dGxlbWVudCBydW5zIGxhdGUgdGhlIEVGRkVDVElWRSB3aW5kb3cgY2FuIGJlIHNob3J0ZXIgdGhhbiB0aGUKdmFsdWUgc2V0IGhlcmUg4oCUIGl0IG5ldmVyIGV4dGVuZHMgYSBjbGFpbSBkZWFkbGluZSBwYXN0IHRoYXQgZGF0ZS1hbmNob3JlZApjYXAuIENvbmZpZ3VyZSB3aXRoIHRoYXQgY2VpbGluZyBpbiBtaW5kLgAAAAAXc2V0X2NsYWltX2V4cGlyeV93aW5kb3cAAAAAAQAAAAAAAAAHc2Vjb25kcwAAAAAGAAAAAA==",
        "AAAABAAAAAAAAAAAAAAABUVycm9yAAAAAAAAFAAAAAAAAAAYU29sdmVuY3lSYXRpb091dE9mQm91bmRzAAABLQAAAAAAAAAcQ2xhaW1FeHBpcnlXaW5kb3dPdXRPZkJvdW5kcwAAAS8AAAAAAAAAE05vdEF1dGhvcml6ZWRLZWVwZXIAAAABMAAAAAAAAAAZTm90T3duZXJPckdvdmVybmFuY2VBZG1pbgAAAAAAATEAAAAAAAAAE0J1eWVyTm90V2hpdGVsaXN0ZWQAAAABMgAAAAAAAAANUm91dGVEaXNhYmxlZAAAAAAAATMAAAAAAAAAE1JvdXRlTm90V2hpdGVsaXN0ZWQAAAABNAAAAAAAAAAQRGVwYXJ0dXJlVG9vU29vbgAAATUAAAAAAAAAF0RlcGFydHVyZVRvb0ZhckluRnV0dXJlAAAAATYAAAAAAAAAGEZsaWdodE5vdE9wZW5Gb3JQdXJjaGFzZQAAATcAAAAAAAAAGEluc3VmZmljaWVudFZhdWx0Q2FwaXRhbAAAATgAAAAAAAAAEURhdGVOb3REYXlBbGlnbmVkAAAAAAABOQAAAAAAAAAgTWluTGVhZFRpbWVMZWF2ZXNOb0Jvb2tpbmdXaW5kb3cAAAE6AAAAAAAAABVPcmFjbGVEYXRhVW5hdmFpbGFibGUAAAAAAAE7AAAAAAAAABZGbGlnaHREYXRhU3RpbGxQcmVzZW50AAAAAAE8AAAAAAAAABFGbGlnaHRTdGlsbExpc3RlZAAAAAAAAT0AAAAAAAAAGUZsaWdodE5vdFJlZ2lzdGVyZWRJblBvb2wAAAAAAAE+AAAAAAAAAAtTYWxlTm90T3BlbgAAAAE/AAAAAAAAABlTbmFwc2hvdFRlcm1zRXhjZWVkTGltaXRzAAAAAAABQAAAAAAAAAAPRmxpZ2h0Tm90TGlzdGVkAAAAAUE=",
        "AAAABQAAAAAAAAAAAAAAB1R0bE1pc3MAAAAAAgAAAAhzZW50aW5lbAAAAAh0dGxfbWlzcwAAAAIAAAAAAAAACWZsaWdodF9pZAAAAAAAABEAAAABAAAAAAAAAARkYXRlAAAABgAAAAAAAAAC",
        "AAAABQAAAAAAAAAAAAAACUtlZXBlclNldAAAAAAAAAIAAAAIc2VudGluZWwAAAAKa2VlcGVyX3NldAAAAAAAAQAAAAAAAAAGa2VlcGVyAAAAAAATAAAAAQAAAAA=",
        "AAAABQAAAAAAAAAAAAAADEZsaWdodFZvaWRlZAAAAAIAAAAIc2VudGluZWwAAAAGdm9pZGVkAAAAAAACAAAAAAAAAAlmbGlnaHRfaWQAAAAAAAARAAAAAQAAAAAAAAAEZGF0ZQAAAAYAAAAAAAAAAg==",
        "AAAABQAAAAAAAAAAAAAADk1pbkxlYWRUaW1lU2V0AAAAAAACAAAACHNlbnRpbmVsAAAAEW1pbl9sZWFkX3RpbWVfc2V0AAAAAAAAAQAAAAAAAAAHc2Vjb25kcwAAAAAGAAAAAAAAAAA=",
        "AAAABQAAAAAAAAAAAAAAD0luc3VyYW5jZUJvdWdodAAAAAACAAAACHNlbnRpbmVsAAAABmJvdWdodAAAAAAABAAAAAAAAAAIdHJhdmVsZXIAAAATAAAAAQAAAAAAAAAJZmxpZ2h0X2lkAAAAAAAAEQAAAAEAAAAAAAAABGRhdGUAAAAGAAAAAQAAAAAAAAAHcHJlbWl1bQAAAAALAAAAAAAAAAA=",
        "AAAABQAAAAAAAAAAAAAAEEZsaWdodENsYXNzaWZpZWQAAAACAAAACHNlbnRpbmVsAAAACmNsYXNzaWZpZWQAAAAAAAMAAAAAAAAACWZsaWdodF9pZAAAAAAAABEAAAABAAAAAAAAAARkYXRlAAAABgAAAAEAAAAAAAAABnN0YXR1cwAAAAAH0AAAAAxGbGlnaHRTdGF0dXMAAAAAAAAAAA==",
        "AAAABQAAAAAAAAAAAAAAEFNvbHZlbmN5UmF0aW9TZXQAAAACAAAACHNlbnRpbmVsAAAAEnNvbHZlbmN5X3JhdGlvX3NldAAAAAAAAQAAAAAAAAAFcmF0aW8AAAAAAAAEAAAAAAAAAAA=",
        "AAAABQAAAAAAAAAAAAAAEFdoaXRlbGlzdFRvZ2dsZWQAAAACAAAACHNlbnRpbmVsAAAAEXdoaXRlbGlzdF90b2dnbGVkAAAAAAAAAQAAAAAAAAAHZW5hYmxlZAAAAAABAAAAAAAAAAA=",
        "AAAABQAAAAAAAAAAAAAAEkZsaWdodFNldHRsZWRFdmVudAAAAAAAAgAAAAhzZW50aW5lbAAAAAdzZXR0bGVkAAAAAAMAAAAAAAAACWZsaWdodF9pZAAAAAAAABEAAAABAAAAAAAAAARkYXRlAAAABgAAAAEAAAAAAAAAB291dGNvbWUAAAAH0AAAAAxGbGlnaHRTdGF0dXMAAAAAAAAAAA==",
        "AAAABQAAAAAAAAAAAAAAE0ZsaWdodENvbmZpZ01pc3NpbmcAAAAAAgAAAAhzZW50aW5lbAAAAAtjZmdfbWlzc2luZwAAAAACAAAAAAAAAAlmbGlnaHRfaWQAAAAAAAARAAAAAQAAAAAAAAAEZGF0ZQAAAAYAAAAAAAAAAg==",
        "AAAABQAAAAAAAAAAAAAAFENsYWltRXhwaXJ5V2luZG93U2V0AAAAAgAAAAhzZW50aW5lbAAAABdjbGFpbV9leHBpcnlfd2luZG93X3NldAAAAAABAAAAAAAAAAdzZWNvbmRzAAAAAAYAAAAAAAAAAA==",
        "AAAABQAAAAAAAAAAAAAAFEV2aWN0ZWRGbGlnaHRTZXR0bGVkAAAAAgAAAAhzZW50aW5lbAAAAA1ldmljdF9zZXR0bGVkAAAAAAAABAAAAAAAAAAJZmxpZ2h0X2lkAAAAAAAAEQAAAAEAAAAAAAAABGRhdGUAAAAGAAAAAAAAAAAAAAAOcHJlbWl1bV9pbmNvbWUAAAAAAAsAAAAAAAAAAAAAABNjb2xsYXRlcmFsX3JlbGVhc2VkAAAAAAsAAAAAAAAAAg==",
        "AAAABQAAAAAAAAAAAAAAFEZsaWdodFRpbWVkT3V0QWN0aXZlAAAAAgAAAAhzZW50aW5lbAAAAAl0aW1lZF9vdXQAAAAAAAACAAAAAAAAAAlmbGlnaHRfaWQAAAAAAAARAAAAAQAAAAAAAAAEZGF0ZQAAAAYAAAAAAAAAAg==",
        "AAAABQAAAAAAAAAAAAAAFUJ1eWVyV2hpdGVsaXN0ZWRFdmVudAAAAAAAAAIAAAAIc2VudGluZWwAAAARYnV5ZXJfd2hpdGVsaXN0ZWQAAAAAAAABAAAAAAAAAARhZGRyAAAAEwAAAAEAAAAA",
        "AAAABQAAAAAAAAAAAAAAGkJ1eWVyV2hpdGVsaXN0UmVtb3ZlZEV2ZW50AAAAAAACAAAACHNlbnRpbmVsAAAADWJ1eWVyX3JlbW92ZWQAAAAAAAABAAAAAAAAAARhZGRyAAAAEwAAAAEAAAAA",
        "AAAAAAAAAl1TZXR0bGUgb25lIGV4YWN0IGNsYXNzaWZpZWQgZmxpZ2h0IHdpdGhvdXQgc2Nhbm5pbmcgdGhlIGFjdGl2ZSBsaXN0LgpDb21wYW5pb24gdG8gYGNsYXNzaWZ5X2ZsaWdodGAgKHNlZSB0aGVyZSBmb3IgdGhlIGxhdGVuY3kgcmF0aW9uYWxlKToKdGhlIGtlZXBlciBzZXR0bGVzIHRoZSB0dXBsZSBpdCBqdXN0IGNsYXNzaWZpZWQgaW5zdGVhZCBvZiB3YWl0aW5nCmZvciB0aGUgYGV4ZWN1dGVfc2V0dGxlbWVudHNgIGN1cnNvciB0byByb3RhdGUgdG8gaXQsIHNvIHRoZSB2YXVsdCdzCnNldHRsZW1lbnQgYmFycmllciByZWxlYXNlcyBhcyBzb29uIGFzIHRoZSBvdXRjb21lJ3MgUG5MIGlzCnJlY29nbml6ZWQgcmF0aGVyIHRoYW4gYWZ0ZXIgYSBmdWxsLXNldCByb3RhdGlvbi4gVGhlIGZsaWdodCBtdXN0IGJlCmluIHRoZSBvcmFjbGUncyBhY3RpdmUgc2V0LiBJZGVtcG90ZW50IG9uIHN0YXRlOiByZXR1cm5zIGB0cnVlYCB3aGVuCnRoZSBmbGlnaHQgc2V0dGxlZCwgYGZhbHNlYCB3aGVuIGl0IGlzIG5vdCBpbiBhIGBUb0JlU2V0dGxlZCpgIHN0YXRlCihvciBpdHMgcG9vbCBjb25maWcgaXMgbWlzc2luZywgd2hpY2ggaXMgc2VwYXJhdGVseSBkaWFnbm9zZWQpLgAAAAAAAA1zZXR0bGVfZmxpZ2h0AAAAAAAAAwAAAAAAAAAGa2VlcGVyAAAAAAATAAAAAAAAAAlmbGlnaHRfaWQAAAAAAAARAAAAAAAAAARkYXRlAAAABgAAAAEAAAAB",
        "AAAAAAAAA41DbGFzc2lmeSBvbmUgZXhhY3QgZmxpZ2h0IGluc3RhbmNlIHdpdGhvdXQgc2Nhbm5pbmcgdGhlIGFjdGl2ZSBsaXN0LgpUaGUgcm90YXRpbmcgYGNsYXNzaWZ5X2ZsaWdodHNgIHN3ZWVwIGd1YXJhbnRlZXMgZXZlbnR1YWwgY292ZXJhZ2UsCmJ1dCBpdHMgd29yc3QtY2FzZSBsYXRlbmN5IGdyb3dzIHdpdGggdG90YWwgYWN0aXZlLXNldCBvY2N1cGFuY3kg4oCUCmZ1dHVyZSBib29raW5ncyBhbmQgcmVjZW50bHktc2V0dGxlZCByb3dzIHNoYXJlIHRoZSBzYW1lIGVudW1lcmF0aW9uCndpbmRvd3Mg4oCUIGFuZCB3aGlsZSBhIHB1YmxpYyBvdXRjb21lIHdhaXRzIGZvciB0aGUgY3Vyc29yLCB0aGUKdmF1bHQncyBzZXR0bGVtZW50IGJhcnJpZXIgc3RheXMgZW5nYWdlZCBwcm90b2NvbC13aWRlLiBUaGUgb2ZmLWNoYWluCmtlZXBlciBrbm93cyBleGFjdGx5IHdoaWNoIGZsaWdodCdzIG91dGNvbWUgaXQganVzdCB3cm90ZSwgc28gaXQKY2xhc3NpZmllcyB0aGF0IHR1cGxlIGRpcmVjdGx5OyB0aGUgc3dlZXAgcmVtYWlucyB0aGUgcmVwYWlyIGJhY2tzdG9wCmZvciBhbnl0aGluZyB0aGUgdGFyZ2V0ZWQgcGF0aCBtaXNzZXMuCgpSZXN0cmljdGVkIHRvIGZsaWdodHMgY3VycmVudGx5IGluIHRoZSBvcmFjbGUncyBhY3RpdmUgc2V0IOKAlCB0aGUgc2FtZQpwb3B1bGF0aW9uIHRoZSBzd2VlcCBlbnVtZXJhdGVzIOKAlCBzbyB0aGlzIGVudHJ5IHBvaW50IGNhbiBuZXZlciB0b3VjaApjYW5jZWxsYXRpb24gdG9tYnN0b25lcyBvciBldmljdGVkIGZsaWdodHMuIElkZW1wb3RlbnQgb24gc3RhdGU6CnJldHVybnMgYHRydWVgIHdoZW4gYSBgVG9CZVNldHRsZWQqYCB0cmFuc2l0aW9uIHdhcyB3cml0dGVuLCBgZmFsc2VgCndoZW4gdGhlIGZsaWdodCBuZWVkcyBubyBjbGFzc2lmaWNhdGlvbiAoeWV0KS4AAAAAAAAPY2xhc3NpZnlfZmxpZ2h0AAAAAAMAAAAAAAAABmtlZXBlcgAAAAAAEwAAAAAAAAAJZmxpZ2h0X2lkAAAAAAAAEQAAAAAAAAAEZGF0ZQAAAAYAAAABAAAAAQ==",
        "AAAAAAAAAfxJdGVyYXRlIHRoZSBvcmFjbGUncyBhY3RpdmUtZmxpZ2h0IGxpc3QgKHRoZSBjYW5vbmljYWwgc291cmNlIG9mCmluLWZsaWdodCByZWdpc3RyYXRpb25zIHBsdXMgYSA3LWRheSByZXRlbnRpb24gd2luZG93IG9mIHJlY2VudGx5LQpzZXR0bGVkIGZsaWdodHMpIGFuZCB3cml0ZSBgVG9CZVNldHRsZWQqYCBjbGFzc2lmaWNhdGlvbnMgYmFjayB0byB0aGUKb3JhY2xlOiBMYW5kZWQgZmxpZ2h0cyBhcmUgY2xhc3NpZmllZCBvbi10aW1lL2RlbGF5ZWQgYWdhaW5zdApGbGlnaHRQb29sTWFuYWdlcidzIGxvY2tlZCBkZWxheSB0aHJlc2hvbGQsIENhbmNlbGxlZCBtYXBzIGRpcmVjdGx5IHRvCmBUb0JlU2V0dGxlZENhbmNlbGxlZGAsIGFuZCBOb3RJbml0aWF0ZWQvQWN0aXZlIGZsaWdodHMgc3R1Y2sgcGFzdAp0aGVpciBsaWZlY3ljbGUgdGltZW91dHMgYXJlIHZvaWRlZCAoY2xhc3NpZmllZCBgVG9CZVNldHRsZWRPblRpbWVgIOKAlApwcmVtaXVtcyB0byB0aGUgdmF1bHQsIG5vIHBheW91dCkuAAAAEGNsYXNzaWZ5X2ZsaWdodHMAAAABAAAAAAAAAAZrZWVwZXIAAAAAABMAAAAA",
        "AAAAAAAAAg5JdGVyYXRlIHRoZSBvcmFjbGUncyBhY3RpdmUtZmxpZ2h0IGxpc3QgYW5kIHByb2Nlc3MgZXZlcnkgZmxpZ2h0IHRoYXQncwppbiBhIGBUb0JlU2V0dGxlZCpgIHN0YXR1czogbW92ZSBtb25leSBiZXR3ZWVuIEZsaWdodFBvb2xNYW5hZ2VyIGFuZApSaXNrVmF1bHQsIHRoZW4gbWFyayB0aGUgb3JhY2xlIGVudHJ5IGFzIGBTZXR0bGVkYC4gUHJvY2Vzc2VzIGF0IG1vc3QKYE1BWF9TRVRUTEVfQkFUQ0hgIGZsaWdodHMgcGVyIGNhbGw7IHRoZSByb3RhdGluZyBjdXJzb3IgY292ZXJzIHRoZQpmdWxsIGxpc3QgYWNyb3NzIHJlcGVhdGVkIGNhbGxzLgoKUXVldWUgZHJhaW4gYW5kIHNoYXJlLXByaWNlIHNuYXBzaG90IGFyZSBOT1QgZG9uZSBoZXJlIOKAlCBzZWUKYHJ1bl9xdWV1ZV9tYWludGVuYW5jZWAuIFNwbGl0dGluZyB0aGVtIGVuc3VyZXMKdW5kZXJ3cml0ZXIgd2l0aGRyYXdhbHMgY2FuIHN0aWxsIGJlIHByb2Nlc3NlZCB3aGVuIHRoZSBzZXR0bGVtZW50Cmxvb3AgcnVucyBuZWFyIHRoZSByZXNvdXJjZSBidWRnZXQuAAAAAAATZXhlY3V0ZV9zZXR0bGVtZW50cwAAAAABAAAAAAAAAAZrZWVwZXIAAAAAABMAAAAA",
        "AAAAAAAAAV5EcmFpbiBib3RoIExQIHJlcXVlc3QgcXVldWVzIGFuZCByZWZyZXNoIHRoZSBzaGFyZS1wcmljZSBzbmFwc2hvdC4KS2VlcGVyLW9ubHkuIERlY291cGxlZCBmcm9tIGBleGVjdXRlX3NldHRsZW1lbnRzYCBzbyB0aGUgcXVldWVzCmNhbm5vdCBiZSBibG9ja2VkIGJ5IGdhcyBleGhhdXN0aW9uIGluIHRoZSBzZXR0bGVtZW50IGxvb3A7IGtlZXBlcgpjYW4gcnVuIHRoaXMgb24gaXRzIG93biBjYWRlbmNlLiBEZXBvc2l0cyBhcmUgcHJvY2Vzc2VkIGZpcnN0OiBmcmVzaGx5Cm1pbnRlZCBlbnRyaWVzIGFkZCBtYW5hZ2VkIGFzc2V0cywgd2hpY2ggY2FuIGZ1bmQgbWF0dXJlZCBleGl0cyBpbgp0aGUgc2FtZSBwYXNzLgAAAAAAFXJ1bl9xdWV1ZV9tYWludGVuYW5jZQAAAAAAAAEAAAAAAAAABmtlZXBlcgAAAAAAEwAAAAA=",
        "AAAAAAAABABUZXJtaW5hbCByZWNvbmNpbGlhdGlvbiBmb3IgYSBmbGlnaHQgdGhlIG93bmVyIGV2aWN0ZWQgZnJvbSB0aGUKb3JhY2xlJ3MgYWN0aXZlIGxpc3QgKGBvcmFjbGUuZXZpY3RfbWlzc2luZ19mbGlnaHRgKS4gRXZpY3Rpb24gZnJlZXMKdGhlIG9yYWNsZS1zaWRlIGxpc3Qgc2xvdCBhbmQgcmVsZWFzZXMgdGhlIHNldHRsZW1lbnQgYmFycmllciwgYnV0IG9uCml0cyBvd24gaXQgd291bGQgbGVhdmUgdGhlIGZsaWdodCdzIHBvb2wgYnVja2V0IGBBY3RpdmVgIGZvcmV2ZXIgYW5kCml0cyB2YXVsdCBjb2xsYXRlcmFsIGxvY2tlZCBmb3JldmVyIOKAlCB0aGUgZmxpZ2h0IGlzIG91dHNpZGUga2VlcGVyCmVudW1lcmF0aW9uLCBzbyBubyBzZXR0bGVtZW50IHBhc3MgY2FuIGV2ZXIgcmVhY2ggaXQuIFRoaXMgZW50cnkgcG9pbnQKY29tcGxldGVzIHRoZSByZWxlYXNlOiB0aGUgYnVja2V0IHNldHRsZXMgbGlrZSBhIHZvaWRlZCBmbGlnaHQgKGhlbGQKcHJlbWl1bXMgZm9yd2FyZGVkIHRvIHRoZSB2YXVsdCBhcyBpbmNvbWUsIGNvbGxhdGVyYWwgdW5sb2NrZWQsIG5vCnBheW91dCDigJQgd2l0aCBubyBvcmFjbGUgZGF0YSB0aGVyZSBpcyBubyBvbi1jaGFpbiBvdXRjb21lIHRvIHBheQphZ2FpbnN0KSwgd2hpY2ggYWxzbyBmcmVlcyB0aGUgYnVja2V0J3MgcG9vbCBhY3RpdmUtbGlzdCBzbG90LgoKT3duZXItb25seSwgYW5kIHJlc3RyaWN0ZWQgdG8gZmxpZ2h0cyBwcm92YWJseSBvdXRzaWRlIHRoZSBub3JtYWwKcGlwZWxpbmU6Ci0gdGhlIG9yYWNsZSBtdXN0IGhhdmUgTk8gYEZsaWdodERhdGFgIHJvdyAodGhlIHNhbWUgZ2F0ZSBldmljdGlvbgppdHNlbGYgZW5mb3JjZXMg4oCUIGEgcHJlc2VudCByb3cgbWVhbnMgdGhlIGZsaWdodCBpcyByZXN0b3JhYmxlLCBhbmQKcmVzdG9yZS1hbmQtc2V0dGxlIGlzIHRoZSBjb3JyZWN0IHBhdGgpLiBBIHJvdyByZXN0b3JlZCBBRlRFUgpldmljdGlvbiBibG9ja3MgdGhpcyByZWNvbmNpbGlhdGlvbiwgYnV0IG9ubHkgdGVtcG9yYXJpbHk6IGFuCmV2aWN0ZWQgAAAAFXNldHRsZV9ldmljdGVkX2ZsaWdodAAAAAAAAAIAAAAAAAAACWZsaWdodF9pZAAAAAAAABEAAAAAAAAABGRhdGUAAAAGAAAAAA==",
        "AAAAAAAAAeNgZXhlY3V0ZV9zZXR0bGVtZW50c2Agd2l0aCBhIGNhbGxlci1jaG9zZW4gd2luZG93IHNpemUsIGNsYW1wZWQgdG8KYFsxLCBNQVhfU0VUVExFX0JBVENIXWAuIE9wZXJhdGlvbmFsIGVzY2FwZSBoYXRjaDogc2V0dGxlbWVudCBmYWlsdXJlCmlzIGF0b21pYywgc28gaWYgYSB3aW5kb3cgZXZlciBleGNlZWRzIHRoZSBuZXR3b3JrJ3MgcGVyLXRyYW5zYWN0aW9uCnJlc291cmNlIGJ1ZGdldHMgKGFuIHVudXN1YWxseSB3cml0ZS1oZWF2eSBtaXgsIHRpZ2h0ZW5lZCBuZXR3b3JrCmxpbWl0cywgb3IgYWNjb3VudGluZyBkcmlmdCBpbiB0aGUgYmF0Y2ggc2l6aW5nKSwgdGhlIGtlZXBlciBjYW4Kc2hyaW5rIHRoZSB3aW5kb3cg4oCUIGRvd24gdG8gYSBzaW5nbGUgZmxpZ2h0IOKAlCBhbmQgc3RpbGwgbWFrZQpwcm9ncmVzcywgaW5zdGVhZCBvZiBldmVyeSByZXRyeSByZXZlcnRpbmcgaWRlbnRpY2FsbHkgYXQgdGhlIGZpeGVkCmRlZmF1bHQgc2l6ZS4AAAAAG2V4ZWN1dGVfc2V0dGxlbWVudHNfYm91bmRlZAAAAAACAAAAAAAAAAZrZWVwZXIAAAAAABMAAAAAAAAABWxpbWl0AAAAAAAABAAAAAA=",
        "AAAAAAAAAAAAAAAFcGF1c2UAAAAAAAABAAAAAAAAAAZjYWxsZXIAAAAAABMAAAAA",
        "AAAAAAAAAHFSZXR1cm5zIHRydWUgaWYgdGhlIGNvbnRyYWN0IGlzIHBhdXNlZCwgYW5kIGZhbHNlIG90aGVyd2lzZS4KCiMgQXJndW1lbnRzCgoqIGBlYCAtIEFjY2VzcyB0byBTb3JvYmFuIGVudmlyb25tZW50LgAAAAAAAAZwYXVzZWQAAAAAAAAAAAABAAAAAQ==",
        "AAAAAAAAAAAAAAAHdW5wYXVzZQAAAAABAAAAAAAAAAZjYWxsZXIAAAAAABMAAAAA",
        "AAAAAAAAAJBSZXR1cm5zIGBTb21lKEFkZHJlc3MpYCBpZiBvd25lcnNoaXAgaXMgc2V0LCBvciBgTm9uZWAgaWYgb3duZXJzaGlwIGhhcwpiZWVuIHJlbm91bmNlZC4KCiMgQXJndW1lbnRzCgoqIGBlYCAtIEFjY2VzcyB0byB0aGUgU29yb2JhbiBlbnZpcm9ubWVudC4AAAAJZ2V0X293bmVyAAAAAAAAAAAAAAEAAAPoAAAAEw==",
        "AAAAAAAAATBBY2NlcHRzIGEgcGVuZGluZyBvd25lcnNoaXAgdHJhbnNmZXIuCgojIEFyZ3VtZW50cwoKKiBgZWAgLSBBY2Nlc3MgdG8gdGhlIFNvcm9iYW4gZW52aXJvbm1lbnQuCgojIEVycm9ycwoKKiBbYGNyYXRlOjpyb2xlX3RyYW5zZmVyOjpSb2xlVHJhbnNmZXJFcnJvcjo6Tm9QZW5kaW5nVHJhbnNmZXJgXSAtIElmCnRoZXJlIGlzIG5vIHBlbmRpbmcgdHJhbnNmZXIgdG8gYWNjZXB0LgoKIyBFdmVudHMKCiogdG9waWNzIC0gYFsib3duZXJzaGlwX3RyYW5zZmVyX2NvbXBsZXRlZCJdYAoqIGRhdGEgLSBgW25ld19vd25lcjogQWRkcmVzc11gAAAAEGFjY2VwdF9vd25lcnNoaXAAAAAAAAAAAA==",
        "AAAAAAAAAYVSZW5vdW5jZXMgb3duZXJzaGlwIG9mIHRoZSBjb250cmFjdC4KClBlcm1hbmVudGx5IHJlbW92ZXMgdGhlIG93bmVyLCBkaXNhYmxpbmcgYWxsIGZ1bmN0aW9ucyBnYXRlZCBieQpgI1tvbmx5X293bmVyXWAuCgojIEFyZ3VtZW50cwoKKiBgZWAgLSBBY2Nlc3MgdG8gdGhlIFNvcm9iYW4gZW52aXJvbm1lbnQuCgojIEVycm9ycwoKKiBbYE93bmFibGVFcnJvcjo6VHJhbnNmZXJJblByb2dyZXNzYF0gLSBJZiB0aGVyZSBpcyBhIHBlbmRpbmcgb3duZXJzaGlwCnRyYW5zZmVyLgoqIFtgT3duYWJsZUVycm9yOjpPd25lck5vdFNldGBdIC0gSWYgdGhlIG93bmVyIGlzIG5vdCBzZXQuCgojIE5vdGVzCgoqIEF1dGhvcml6YXRpb24gZm9yIHRoZSBjdXJyZW50IG93bmVyIGlzIHJlcXVpcmVkLgAAAAAAABJyZW5vdW5jZV9vd25lcnNoaXAAAAAAAAAAAAAA",
        "AAAAAAAAA45Jbml0aWF0ZXMgYSAyLXN0ZXAgb3duZXJzaGlwIHRyYW5zZmVyIHRvIGEgbmV3IGFkZHJlc3MuCgpSZXF1aXJlcyBhdXRob3JpemF0aW9uIGZyb20gdGhlIGN1cnJlbnQgb3duZXIuIFRoZSBuZXcgb3duZXIgbXVzdCBsYXRlcgpjYWxsIGBhY2NlcHRfb3duZXJzaGlwKClgIHRvIGNvbXBsZXRlIHRoZSB0cmFuc2Zlci4KCiMgQXJndW1lbnRzCgoqIGBlYCAtIEFjY2VzcyB0byB0aGUgU29yb2JhbiBlbnZpcm9ubWVudC4KKiBgbmV3X293bmVyYCAtIFRoZSBwcm9wb3NlZCBuZXcgb3duZXIuCiogYGxpdmVfdW50aWxfbGVkZ2VyYCAtIExlZGdlciBudW1iZXIgdW50aWwgd2hpY2ggdGhlIG5ldyBvd25lciBjYW4KYWNjZXB0LiBBIHZhbHVlIG9mIGAwYCBjYW5jZWxzIGFueSBwZW5kaW5nIHRyYW5zZmVyLgoKIyBFcnJvcnMKCiogW2BPd25hYmxlRXJyb3I6Ok93bmVyTm90U2V0YF0gLSBJZiB0aGUgb3duZXIgaXMgbm90IHNldC4KKiBbYGNyYXRlOjpyb2xlX3RyYW5zZmVyOjpSb2xlVHJhbnNmZXJFcnJvcjo6Tm9QZW5kaW5nVHJhbnNmZXJgXSAtIElmCnRyeWluZyB0byBjYW5jZWwgYSB0cmFuc2ZlciB0aGF0IGRvZXNuJ3QgZXhpc3QuCiogW2BjcmF0ZTo6cm9sZV90cmFuc2Zlcjo6Um9sZVRyYW5zZmVyRXJyb3I6OkludmFsaWRMaXZlVW50aWxMZWRnZXJgXSAtCklmIHRoZSBzcGVjaWZpZWQgbGVkZ2VyIGlzIGluIHRoZSBwYXN0LgoqIFtgY3JhdGU6OnJvbGVfdHJhbnNmZXI6OlJvbGVUcmFuc2ZlckVycm9yOjpJbnZhbGlkUGVuZGluZ0FjY291bnRgXSAtCklmIHRoZSBzcGVjaWZpZWQgcGVuZGluZyBhY2NvdW50IGlzIG5vdCB0aGUgc2FtZSBhcyB0aGUgcHJvdmlkZWQgYG5ld2AKYWRkcmVzcy4KCiMgTm90ZXMKCiogQXV0aG9yaXphdGlvbiBmb3IgdGhlIGN1cnJlbnQgb3duZXIgaXMgcmVxdWlyZWQuAAAAAAASdHJhbnNmZXJfb3duZXJzaGlwAAAAAAACAAAAAAAAAAluZXdfb3duZXIAAAAAAAATAAAAAAAAABFsaXZlX3VudGlsX2xlZGdlcgAAAAAAAAQAAAAA",
        "AAAAAAAAASZSZXR1cm5zIGFnZ3JlZ2F0ZSBzdGF0czogdG90YWwgcG9saWNpZXMgc29sZCwgcHJlbWl1bXMgY29sbGVjdGVkLCBhbmQKcGF5b3V0cyBkaXN0cmlidXRlZC4gVGhlIHBheW91dHMgZmlndXJlIGlzIHRoZSBncm9zcyBjbGFpbWFibGUgdmFsdWUKb3BlbmVkIGJ5IGRlbGF5ZWQvY2FuY2VsbGVkIHNldHRsZW1lbnRzIChwYXlvZmYgw5cgYnV5ZXJfY291bnQpIOKAlCBpdAppbmNsdWRlcyB0aGUgcHJlbWl1bSBwb3J0aW9uIGFscmVhZHkgaGVsZCBieSB0aGUgcG9vbCwgbm90IGp1c3QgdGhlCnZhdWx0J3Mgb3V0Zmxvdy4AAAAAAAlnZXRfc3RhdHMAAAAAAAAAAAAAAQAAA+0AAAADAAAABgAAAAsAAAAL",
        "AAAAAAAAADBSZXR1cm5zIHRoZSBjdXJyZW50bHkgYXV0aG9yaXplZCBrZWVwZXIgYWRkcmVzcy4AAAAKZ2V0X2tlZXBlcgAAAAAAAAAAAAEAAAAT",
        "AAAAAAAAAjdSZXR1cm5zIHRoZSBjb25maWd1cmVkIE9yYWNsZUFnZ3JlZ2F0b3IgYWRkcmVzcy4gVGhlIGNvbnRyb2xsZXIncyBvcmFjbGUKcG9pbnRlciBpcyBpbW11dGFibGUgKHNldCBvbmNlIGF0IGNvbnN0cnVjdGlvbiwgbm8gc2V0dGVyKSwgYW5kIHRoZQpSaXNrVmF1bHQncyBzZXR0bGVtZW50IGJhcnJpZXIgTVVTVCBjb25zdWx0IHRoaXMgZXhhY3Qgc2FtZSBvcmFjbGUg4oCUIHRoZQpiYXJyaWVyIHJlYWRzIHBlbmRpbmcgb3V0Y29tZXMgZnJvbSB0aGUgdmF1bHQncyBvcmFjbGUgd2hpbGUgb3V0Y29tZXMgYXJlCnJlY29yZGVkIGFnYWluc3QgdGhpcyBvbmUsIHNvIGEgZGl2ZXJnZW5jZSBzaWxlbnRseSBkZWZlYXRzIHRoZSBiYXJyaWVyCmZvciBldmVyeSBwb2xpY3kgKHNlZSBgUmlza1ZhdWx0OjpzZXRfb3JhY2xlYCkuIEV4cG9zZWQgc28gdGhhdAppbnZhcmlhbnQg4oCUIG90aGVyd2lzZSBvbmx5IGEgZGVwbG95bWVudC12ZXJpZmljYXRpb24gb2JsaWdhdGlvbiDigJQgaXMKY2hlY2thYmxlIG9uLWNoYWluOiBgY29udHJvbGxlci5nZXRfb3JhY2xlKCkgPT0gdmF1bHQuZ2V0X29yYWNsZSgpYC4AAAAACmdldF9vcmFjbGUAAAAAAAAAAAABAAAAEw==",
        "AAAAAAAAAI1SZXR1cm5zIHRoZSBjb25maWd1cmVkIEdvdmVybmFuY2VNb2R1bGUgY29udHJhY3QgYWRkcmVzcyAoaW1tdXRhYmxlOwpleHBvc2VkIGZvciBkZXBsb3ltZW50IHZlcmlmaWNhdGlvbiBhbG9uZ3NpZGUgdGhlIG90aGVyIHdpcmluZwpnZXR0ZXJzKS4AAAAAAAAOZ2V0X2dvdmVybmFuY2UAAAAAAAAAAAABAAAAEw==",
        "AAAAAAAAAX1SZXR1cm5zIHRoZSBjb25maWd1cmVkIFJpc2tWYXVsdCBjb250cmFjdCBhZGRyZXNzLiBJbW11dGFibGUKKGNvbnN0cnVjdGlvbi10aW1lIHBvaW50ZXIsIG5vIHNldHRlcikuIEV4cG9zZWQgc28gdGhlIHdpcmluZwppbnZhcmlhbnQgYGNvbnRyb2xsZXIuZ2V0X3Jpc2tfdmF1bHQoKSA9PSBwb29sLmdldF9yaXNrX3ZhdWx0KClgIGlzCmNoZWNrYWJsZSBvbi1jaGFpbiwgbGlrZSB0aGUgb3JhY2xlLWlkZW50aXR5IGNoZWNrIGFib3ZlIOKAlCBhCm1pc21hdGNoIHdvdWxkIHNlbmQgc2V0dGxlZCBwcmVtaXVtcyB0byBhIHZhdWx0IHRoZSBjb250cm9sbGVyCm5ldmVyIGNyZWRpdHMsIGJyaWNraW5nIHNldHRsZW1lbnQgYXQgdGhlIHByZW1pdW0tcmVjZWlwdCBndWFyZC4AAAAAAAAOZ2V0X3Jpc2tfdmF1bHQAAAAAAAAAAAABAAAAEw==",
        "AAAAAAAAAP1XaGV0aGVyIGBhZGRyYCBob2xkcyBhIGN1cnJlbnRseSB2YWxpZCB3aGl0ZWxpc3QgYXBwcm92YWwg4oCUIGFkZGVkLApub3QgcmVtb3ZlZCwgYW5kIG5vdCBwYXN0IGl0cyAxODAtZGF5IGluYWN0aXZpdHkgZGVhZGxpbmUgKGVhY2gKcHVyY2hhc2Ugc2xpZGVzIHRoZSBkZWFkbGluZSBmb3J3YXJkKS4gUmV0dXJucyBgZmFsc2VgIGZvciBhbnkKYWRkcmVzcyBuZXZlciBhZGRlZCwgcmVtb3ZlZCwgb3IgZG9ybWFudCBwYXN0IHRoZSB3aW5kb3cuAAAAAAAADmlzX3doaXRlbGlzdGVkAAAAAAABAAAAAAAAAARhZGRyAAAAEwAAAAEAAAAB",
        "AAAAAAAAAaNSZXR1cm5zIHRoZSBjb25maWd1cmVkIHNldHRsZW1lbnQtYXNzZXQgdG9rZW4gYWRkcmVzcy4gSW1tdXRhYmxlLgpFeHBvc2VkIHNvIGBjb250cm9sbGVyLmdldF9hc3NldF90b2tlbigpID09IHBvb2wuZ2V0X2Fzc2V0X3Rva2VuKCkKPT0gdmF1bHQncyB1bmRlcmx5aW5nIGFzc2V0YCBpcyBjaGVja2FibGUgb24tY2hhaW46IHByZW1pdW1zIGFyZQp0cmFuc2ZlcnJlZCBpbiB0aGlzIGFzc2V0IHdoaWxlIHRoZSBwb29sIHBheXMgY2xhaW1zIGFuZCB0aGUgdmF1bHQKcHJpY2VzIHNoYXJlcyBpbiB0aGVpcnMsIHNvIGEgZGl2ZXJnZW5jZSBzdXJmYWNlcyBvbmx5IGF0IHNldHRsZW1lbnQKdGltZSAoYXMgYSBmYWlsZWQgdHJhbnNmZXIgb3IgcmVjZWlwdCBndWFyZCkg4oCUIG5ldmVyIGF0IGFueSBlYXJsaWVyLApjaGVhcGVyIGNoZWNrLgAAAAAPZ2V0X2Fzc2V0X3Rva2VuAAAAAAAAAAABAAAAEw==",
        "AAAAAAAAADVXaGV0aGVyIHRoZSBidXllciB3aGl0ZWxpc3QgZ2F0ZSBpcyBjdXJyZW50bHkgYWN0aXZlLgAAAAAAABF3aGl0ZWxpc3RfZW5hYmxlZAAAAAAAAAAAAAABAAAAAQ==",
        "AAAAAAAAACxSZXR1cm5zIHRoZSBjb25maWd1cmVkIHZhdWx0IHNvbHZlbmN5IHJhdGlvLgAAABJnZXRfc29sdmVuY3lfcmF0aW8AAAAAAAAAAAABAAAABA==",
        "AAAAAAAAADpSZXR1cm5zIHRoZSBjb25maWd1cmVkIEZsaWdodFBvb2xNYW5hZ2VyIGNvbnRyYWN0IGFkZHJlc3MuAAAAAAAXZ2V0X2ZsaWdodF9wb29sX21hbmFnZXIAAAAAAAAAAAEAAAAT",
        "AAAAAAAAAS5QZXItdHJhdmVsZXIgaW5kZXgg4oCUIHJldHVybnMgdGhlIGFkZHJlc3MncyBtb3N0IHJlY2VudApgKGZsaWdodF9pZCwgZGF0ZSlgIHB1cmNoYXNlcywgYm91bmRlZCBhdCBgTUFYX1RSQVZFTEVSX0ZMSUdIVFNgICh0aGUKb2xkZXN0IGVudHJpZXMgYXJlIGV2aWN0ZWQgb25jZSB0aGUgY2FwIGlzIHJlYWNoZWQ7IGZ1bGwgaGlzdG9yeSBpcwpyZWNvbnN0cnVjdGFibGUgZnJvbSBldmVudHMpLiBGcm9udGVuZCBmaWx0ZXJzIGJ5IGN1cnJlbnQgc3RhdHVzCihsb29rZWQgdXAgaW4gRmxpZ2h0UG9vbE1hbmFnZXIgLyBvcmFjbGUpLgAAAAAAGGdldF9mbGlnaHRzX2Zvcl90cmF2ZWxlcgAAAAEAAAAAAAAAB2FkZHJlc3MAAAAAEwAAAAEAAAPqAAAD7QAAAAIAAAARAAAABg==",
        "AAAAAAAAAG9Pd25lci1nYXRlZCBXYXNtIHVwZ3JhZGUuIERlbGVnYXRlcyB0byB0aGUgc2hhcmVkIGltcGxlbWVudGF0aW9uLCB3aGljaAphbHNvIGJ1bXBzIHRoZSBzdG9yZWQgb24tY2hhaW4gdmVyc2lvbi4AAAAAB3VwZ3JhZGUAAAAAAQAAAAAAAAAJd2FzbV9oYXNoAAAAAAAD7gAAACAAAAAA",
        "AAAAAAAAACJDdXJyZW50IG9uLWNoYWluIGNvbnRyYWN0IHZlcnNpb24uAAAAAAAHdmVyc2lvbgAAAAAAAAAAAQAAAAQ=",
        "AAAAAAAAAJxCdXlzIGZsaWdodC1kZWxheSBpbnN1cmFuY2UgZm9yIGEgdHJhdmVsZXI6IHZhbGlkYXRlcyB0aGUgcm91dGUgYW5kIHRpbWluZywgY2hlY2tzIHNvbHZlbmN5LCBjb2xsZWN0cyB0aGUgcHJlbWl1bSwgbG9ja3MgY29sbGF0ZXJhbCwgYW5kIHJlY29yZHMgdGhlIHBvbGljeS4AAAANYnV5X2luc3VyYW5jZQAAAAAAAAUAAAAAAAAACHRyYXZlbGVyAAAAEwAAAAAAAAAJZmxpZ2h0X2lkAAAAAAAAEQAAAAAAAAAGb3JpZ2luAAAAAAARAAAAAAAAAARkZXN0AAAAEQAAAAAAAAAEZGF0ZQAAAAYAAAAA",
        "AAAAAAAABABBZGQgYGFkZHJgIHRvIHRoZSBidXllciB3aGl0ZWxpc3QuIENhbGxhYmxlIGJ5IHRoZSBvd25lciBvciBhbnkgYWRkcmVzcwpmbGFnZ2VkIGFzIGFkbWluIG9uIGBHb3Zlcm5hbmNlTW9kdWxlYC4gSWRlbXBvdGVudCDigJQgcmUtYWRkaW5nIGFuCmV4aXN0aW5nIGVudHJ5IHJlc3RhcnRzIGl0cyBhcHByb3ZhbCB3aW5kb3cgd2l0aG91dCBwYW5pYy4KSW50ZW50aW9uYWxseSBOT1QgZ2F0ZWQgYnkgUGF1c2FibGUgc28gYWRtaW5zIGNhbiBrZWVwIHRoZSBsaXN0CmN1cnJlbnQgZHVyaW5nIGEgcGF1c2UuCgpBcHByb3ZhbCBsaWZldGltZSBtb2RlbCAoZGVsaWJlcmF0ZSk6IGFuIGFwcHJvdmFsIGNhcnJpZXMgYW4gZXhwbGljaXQKb24tY2hhaW4gZGVhZGxpbmUgKGBub3cgKyAxODAgZGF5c2ApLCBhbmQgZXZlcnkgcHVyY2hhc2UgdGhlIGJ1eWVyCm1ha2VzIHNsaWRlcyBpdCBmb3J3YXJkLiBBIGJ1eWVyIERPUk1BTlQgZm9yIHRoZSBmdWxsIHdpbmRvdyBsYXBzZXMg4oCUCnRoZSBwdXJjaGFzZSBnYXRlIGNvbXBhcmVzIHRoZSBsZWRnZXIgY2xvY2sgYWdhaW5zdCB0aGUgc3RvcmVkCmRlYWRsaW5lIGFuZCByZWplY3RzIOKAlCBhbmQgbXVzdCBiZSByZS1hcHByb3ZlZC4gVGhpcyBpcyBwZXJpb2RpYwpyZS1hdHRlc3RhdGlvbiBvZiBpbmFjdGl2ZSBhY2NvdW50czogaXQgZmFpbHMgY2xvc2VkLCBhbmQgcmVjb3ZlcnkgaXMKb25lIGFkbWluIGNhbGwuIFRoZSBkZWFkbGluZSBpcyBjb250cmFjdCBzdGF0ZSwgTk9UIHRoZSBlbnRyeSdzCnN0b3JhZ2UgVFRMOiBhbiBhcmNoaXZlZCBQZXJzaXN0ZW50IGVudHJ5IGlzIHJlc3RvcmVkIHdpdGggaXRzCm9yaWdpbmFsIHZhbHVlIG9uIG5leHQgYWNjZXNzIHJhdGhlciB0aGFuIHJlYWQgYXMgYWJzZW50LCBzbyBhIFRUTAphbG9uZSBjb3VsZCBuZXZlciBleHBpcmUgYW4gYXV0aG9yaXphdGlvbi4KCk9mZi1jaGFpbiBtb25pdG9yaW5nIG5vdGU6IGRlYWRsaW5lIFNMSURFUyBlbWl0IG5vIGV2ZW50LCBhbmQgYQpzbGlkZSBpcyBza2lwcGVkIHdoaWxlIHRoAAAAFWFkZF93aGl0ZWxpc3RlZF9idXllcgAAAAAAAAIAAAAAAAAABmNhbGxlcgAAAAAAEwAAAAAAAAAEYWRkcgAAABMAAAAA",
        "AAAAAAAAAOxPd25lci1vbmx5IGtpbGwtc3dpdGNoLiBXaGVuIGBmYWxzZWAgKGRlZmF1bHQpLCBgYnV5X2luc3VyYW5jZWAgaXMKb3BlbiB0byBhbnlvbmUuIFdoZW4gYHRydWVgLCBvbmx5IGFkZHJlc3NlcyBob2xkaW5nIGFuIHVuZXhwaXJlZApgQnV5ZXJBcHByb3ZhbEV4cGlyeWAgZGVhZGxpbmUgKGFkZGVkIHZpYSBgYWRkX3doaXRlbGlzdGVkX2J1eWVyYCwKbm90IGxhcHNlZCkgY2FuIGNhbGwgYGJ1eV9pbnN1cmFuY2VgLgAAABVzZXRfd2hpdGVsaXN0X2VuYWJsZWQAAAAAAAABAAAAAAAAAAdlbmFibGVkAAAAAAEAAAAA",
        "AAAAAAAAAZ9SZW1vdmUgYGFkZHJgIGZyb20gdGhlIHdoaXRlbGlzdC4gU2FtZSBhdXRoIGFzIGBhZGRfd2hpdGVsaXN0ZWRfYnV5ZXJgLgpSZW1vdmluZyBhbiBhZGRyZXNzIHRoYXQgd2FzIG5ldmVyIHdoaXRlbGlzdGVkIGlzIGEgbm8tb3AgKHdyaXRlcyBhCnplcm8gZGVhZGxpbmUsIGVtaXRzIHRoZSBldmVudCkuIFRoZSBlbnRyeSBpcyBvdmVyd3JpdHRlbiByYXRoZXIgdGhhbgpkZWxldGVkIHNvIGEgcmUtYWRkIGxhdGVyIHN0aWxsIHJlZnJlc2hlcyBhIGtub3duIGtleSDigJQga2VlcHMgdGhlClBlcnNpc3RlbnQgZm9vdHByaW50IHN0YWJsZSBmb3IgdGhlIG9mZi1jaGFpbiBUVEwgY3JvbiDigJQgYW5kIHNvIGEKbGF0ZXIgYXJjaGl2YWwgcmVzdG9yZSBicmluZ3MgYmFjayB0aGUgcmV2b2NhdGlvbiwgbmV2ZXIgYW4gYXBwcm92YWwuAAAAABhyZW1vdmVfd2hpdGVsaXN0ZWRfYnV5ZXIAAAACAAAAAAAAAAZjYWxsZXIAAAAAABMAAAAAAAAABGFkZHIAAAATAAAAAA==",
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
        set_keeper: this.txFromJSON<null>,
        set_min_lead_time: this.txFromJSON<null>,
        set_solvency_ratio: this.txFromJSON<null>,
        set_claim_expiry_window: this.txFromJSON<null>,
        settle_flight: this.txFromJSON<boolean>,
        classify_flight: this.txFromJSON<boolean>,
        classify_flights: this.txFromJSON<null>,
        execute_settlements: this.txFromJSON<null>,
        run_queue_maintenance: this.txFromJSON<null>,
        settle_evicted_flight: this.txFromJSON<null>,
        execute_settlements_bounded: this.txFromJSON<null>,
        pause: this.txFromJSON<null>,
        paused: this.txFromJSON<boolean>,
        unpause: this.txFromJSON<null>,
        get_owner: this.txFromJSON<Option<string>>,
        accept_ownership: this.txFromJSON<null>,
        renounce_ownership: this.txFromJSON<null>,
        transfer_ownership: this.txFromJSON<null>,
        get_stats: this.txFromJSON<readonly [u64, i128, i128]>,
        get_keeper: this.txFromJSON<string>,
        get_oracle: this.txFromJSON<string>,
        get_governance: this.txFromJSON<string>,
        get_risk_vault: this.txFromJSON<string>,
        is_whitelisted: this.txFromJSON<boolean>,
        get_asset_token: this.txFromJSON<string>,
        whitelist_enabled: this.txFromJSON<boolean>,
        get_solvency_ratio: this.txFromJSON<u32>,
        get_flight_pool_manager: this.txFromJSON<string>,
        get_flights_for_traveler: this.txFromJSON<Array<readonly [string, u64]>>,
        upgrade: this.txFromJSON<null>,
        version: this.txFromJSON<u32>,
        buy_insurance: this.txFromJSON<null>,
        add_whitelisted_buyer: this.txFromJSON<null>,
        set_whitelist_enabled: this.txFromJSON<null>,
        remove_whitelisted_buyer: this.txFromJSON<null>
  }
}