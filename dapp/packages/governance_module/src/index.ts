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
  501: {message:"PremiumMustBePositive"},
  502: {message:"PayoffMustBePositive"},
  503: {message:"PayoffMustExceedPremium"},
  504: {message:"DelayHoursMustBePositive"},
  505: {message:"FlightIdAlreadyMapped"},
  506: {message:"RouteAlreadyDisabled"},
  507: {message:"RouteAlreadyActive"},
  508: {message:"RouteMustBeDisabledBeforeRemoval"},
  509: {message:"NotOwnerOrAdmin"},
  510: {message:"FlightIdRetired"},
  511: {message:"RouteNotFound"},
  512: {message:"RouteAlreadyListed"},
  513: {message:"PayoffExceedsCap"},
  514: {message:"PayoffExceedsPremiumRatio"},
  515: {message:"InvalidTermLimits"}
}










export type PayoffUpdate = {tag: "Keep", values: void} | {tag: "Set", values: readonly [i128]} | {tag: "UseDefault", values: void};

export type PremiumUpdate = {tag: "Keep", values: void} | {tag: "Set", values: readonly [i128]} | {tag: "UseDefault", values: void};

export type DelayHoursUpdate = {tag: "Keep", values: void} | {tag: "Set", values: readonly [u32]} | {tag: "UseDefault", values: void};

export type RouteStatus = {tag: "Active", values: readonly [ResolvedTerms]} | {tag: "Disabled", values: void} | {tag: "Unknown", values: void};


export interface ResolvedTerms {
  delay_hours: u32;
  payoff: i128;
  premium: i128;
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
   * Construct and simulate a add_admin transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Grant admin rights to an address.
   */
  add_admin: ({admin}: {admin: string}, options?: MethodOptions) => Promise<AssembledTransaction<null>>

  /**
   * Construct and simulate a extend_ttl transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Extend instance TTL. Called by cron as a safety net.
   */
  extend_ttl: (options?: MethodOptions) => Promise<AssembledTransaction<null>>

  /**
   * Construct and simulate a remove_admin transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Revoke admin rights from an address.
   * 
   * Deliberately NOT pause-gated: this write only removes authority — it
   * grants nothing — and an incident response plausibly has the module
   * paused at exactly the moment a compromised admin key most needs
   * revoking; gating it would force an unpause first. Same convention as
   * the oracle's pause-exempt `close_sale` and the controller's
   * `remove_whitelisted_buyer`.
   */
  remove_admin: ({admin}: {admin: string}, options?: MethodOptions) => Promise<AssembledTransaction<null>>

  /**
   * Construct and simulate a set_defaults transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Update the global fallback premium, payoff, and delay-hours defaults.
   */
  set_defaults: ({premium, payoff, delay_hours}: {premium: i128, payoff: i128, delay_hours: u32}, options?: MethodOptions) => Promise<AssembledTransaction<null>>

  /**
   * Construct and simulate a set_term_limits transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Bound the economics any route write may carry (owner-only). Route
   * lifecycle calls are open to admins — a deliberately weaker role than
   * owner — so these limits cap the blast radius of a single compromised
   * admin key, in the same spirit as the controller's bounded owner
   * setters: without them, one signature could whitelist a dust-premium,
   * vault-sized-payoff route and any naturally delayed or cancelled
   * flight on it would hand the vault's free capital to the buyer.
   * 
   * `max_payoff` is an absolute per-policy payoff ceiling in asset units
   * (0 disables it — pick a deployment-appropriate value at wiring time).
   * `max_payoff_ratio` caps `payoff / premium`; it is unit-free, defaults
   * to a generous constant from genesis, and cannot be disabled (a ratio
   * below 2 would reject every valid route, since payoff must exceed
   * premium). Both are enforced on every route write and on
   * `set_defaults`, and `route_status` stops advertising a route that
   * exceeds the current limits — lowering them retroactively de-lists
   * oversized routes.
   */
  set_term_limits: ({max_payoff, max_payoff_ratio}: {max_payoff: i128, max_payoff_ratio: i128}, options?: MethodOptions) => Promise<AssembledTransaction<null>>

  /**
   * Construct and simulate a enable_route transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Re-enable a previously disabled route.
   */
  enable_route: ({caller, flight_id, origin, dest}: {caller: string, flight_id: string, origin: string, dest: string}, options?: MethodOptions) => Promise<AssembledTransaction<null>>

  /**
   * Construct and simulate a remove_route transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Hard-delete a route entry. Strict: requires the route to be disabled
   * first (approved == false). Prevents fat-finger removal of an
   * actively-purchasable route.
   */
  remove_route: ({caller, flight_id, origin, dest}: {caller: string, flight_id: string, origin: string, dest: string}, options?: MethodOptions) => Promise<AssembledTransaction<null>>

  /**
   * Construct and simulate a disable_route transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Mark a whitelisted route as disabled (not purchasable).
   * 
   * Deliberately pause-gated, unlike the revocation-only writes that stay
   * callable during a pause (`remove_admin`, the oracle's `close_sale`,
   * the controller's `remove_whitelisted_buyer`). Those exist because a
   * pause leaves no other lever against their hazard; a bad route has
   * two: pausing the controller halts every purchase outright, and the
   * oracle's pause-exempt `close_sale` kills insurability per flight. With
   * coverage already guaranteed mid-incident, keeping route lifecycle
   * writes uniformly gated is the simpler invariant.
   */
  disable_route: ({caller, flight_id, origin, dest}: {caller: string, flight_id: string, origin: string, dest: string}, options?: MethodOptions) => Promise<AssembledTransaction<null>>

  /**
   * Construct and simulate a whitelist_route transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Whitelist a NEW route with optional per-route term overrides.
   * Re-listing an existing entry is rejected unless it is byte-identical
   * and still approved (idempotent refresh) — term changes must go through
   * `update_route_terms`, re-activation through `enable_route`.
   */
  whitelist_route: ({caller, flight_id, origin, dest, premium, payoff, delay_hours}: {caller: string, flight_id: string, origin: string, dest: string, premium: Option<i128>, payoff: Option<i128>, delay_hours: Option<u32>}, options?: MethodOptions) => Promise<AssembledTransaction<null>>

  /**
   * Construct and simulate a update_route_terms transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Partially update a route's premium, payoff, and/or delay-hours terms.
   */
  update_route_terms: ({caller, flight_id, origin, dest, premium, payoff, delay_hours}: {caller: string, flight_id: string, origin: string, dest: string, premium: PremiumUpdate, payoff: PayoffUpdate, delay_hours: DelayHoursUpdate}, options?: MethodOptions) => Promise<AssembledTransaction<null>>

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
   * Construct and simulate a is_admin transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Return whether the given address has admin rights.
   */
  is_admin: ({addr}: {addr: string}, options?: MethodOptions) => Promise<AssembledTransaction<boolean>>

  /**
   * Construct and simulate a terms_valid transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Return whether already-resolved terms are admissible for NEW exposure
   * under the current defaults-independent validity rules and owner-set
   * term limits. `route_status` applies these checks to a route's CURRENT
   * terms, but the controller may replace those with a pool bucket's
   * snapshot taken when the bucket was first registered — terms this
   * module never sees again. Without re-checking the terms actually
   * charged and locked, lowering the limits could not stop further sales
   * on a pre-existing oversized bucket. Existing policies keep their
   * snapshotted terms for settlement; only admission of new buyers is
   * judged here.
   */
  terms_valid: ({terms}: {terms: ResolvedTerms}, options?: MethodOptions) => Promise<AssembledTransaction<boolean>>

  /**
   * Construct and simulate a get_defaults transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Return the global default premium, payoff, and delay hours.
   */
  get_defaults: (options?: MethodOptions) => Promise<AssembledTransaction<readonly [i128, i128, u32]>>

  /**
   * Construct and simulate a route_status transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Typed status reader. Returns `Active(ResolvedTerms)` (defaults folded)
   * if the entry exists, is approved, owns its flight_id per the uniqueness
   * index, and its resolved terms pass the current validity rules and term
   * limits; `Disabled` if the entry exists but is not approved, or is
   * approved but its resolved terms fail those checks (e.g. after a
   * defaults or term-limits change); `Unknown` if the entry is missing
   * (never whitelisted, removed, or storage archived) or the flight_id is
   * mapped to a different route.
   */
  route_status: ({flight_id, origin, dest}: {flight_id: string, origin: string, dest: string}, options?: MethodOptions) => Promise<AssembledTransaction<RouteStatus>>

  /**
   * Construct and simulate a get_term_limits transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Return `(max_payoff, max_payoff_ratio)` — the owner-configured bounds
   * every route's resolved terms must satisfy. `max_payoff == 0` means the
   * absolute cap is disabled; the ratio bound is always active.
   */
  get_term_limits: (options?: MethodOptions) => Promise<AssembledTransaction<readonly [i128, i128]>>

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

}
export class Client extends ContractClient {
  static async deploy<T = Client>(
        /** Constructor/Initialization Args for the contract's `__constructor` method */
        {owner, default_premium, default_payoff, default_delay_hours}: {owner: string, default_premium: i128, default_payoff: i128, default_delay_hours: u32},
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
    return ContractClient.deploy({owner, default_premium, default_payoff, default_delay_hours}, options)
  }
  constructor(public readonly options: ContractClientOptions) {
    super(
      new ContractSpec([ "AAAAAAAAACFHcmFudCBhZG1pbiByaWdodHMgdG8gYW4gYWRkcmVzcy4AAAAAAAAJYWRkX2FkbWluAAAAAAAAAQAAAAAAAAAFYWRtaW4AAAAAAAATAAAAAA==",
        "AAAAAAAAADRFeHRlbmQgaW5zdGFuY2UgVFRMLiBDYWxsZWQgYnkgY3JvbiBhcyBhIHNhZmV0eSBuZXQuAAAACmV4dGVuZF90dGwAAAAAAAAAAAAA",
        "AAAAAAAAAY5SZXZva2UgYWRtaW4gcmlnaHRzIGZyb20gYW4gYWRkcmVzcy4KCkRlbGliZXJhdGVseSBOT1QgcGF1c2UtZ2F0ZWQ6IHRoaXMgd3JpdGUgb25seSByZW1vdmVzIGF1dGhvcml0eSDigJQgaXQKZ3JhbnRzIG5vdGhpbmcg4oCUIGFuZCBhbiBpbmNpZGVudCByZXNwb25zZSBwbGF1c2libHkgaGFzIHRoZSBtb2R1bGUKcGF1c2VkIGF0IGV4YWN0bHkgdGhlIG1vbWVudCBhIGNvbXByb21pc2VkIGFkbWluIGtleSBtb3N0IG5lZWRzCnJldm9raW5nOyBnYXRpbmcgaXQgd291bGQgZm9yY2UgYW4gdW5wYXVzZSBmaXJzdC4gU2FtZSBjb252ZW50aW9uIGFzCnRoZSBvcmFjbGUncyBwYXVzZS1leGVtcHQgYGNsb3NlX3NhbGVgIGFuZCB0aGUgY29udHJvbGxlcidzCmByZW1vdmVfd2hpdGVsaXN0ZWRfYnV5ZXJgLgAAAAAADHJlbW92ZV9hZG1pbgAAAAEAAAAAAAAABWFkbWluAAAAAAAAEwAAAAA=",
        "AAAAAAAAAEVVcGRhdGUgdGhlIGdsb2JhbCBmYWxsYmFjayBwcmVtaXVtLCBwYXlvZmYsIGFuZCBkZWxheS1ob3VycyBkZWZhdWx0cy4AAAAAAAAMc2V0X2RlZmF1bHRzAAAAAwAAAAAAAAAHcHJlbWl1bQAAAAALAAAAAAAAAAZwYXlvZmYAAAAAAAsAAAAAAAAAC2RlbGF5X2hvdXJzAAAAAAQAAAAA",
        "AAAAAAAAAadJbml0aWFsaXplIHRoZSBnb3Zlcm5hbmNlIG1vZHVsZS4KCiMgQXJndW1lbnRzCiogYG93bmVyYCAtIEFkZHJlc3MgZ3JhbnRlZCBvd25lciByaWdodHMgKG1hbmFnZSBhZG1pbnMsIHVwZGF0ZQpkZWZhdWx0cywgdXBncmFkZSkuCiogYGRlZmF1bHRfcHJlbWl1bWAgLSBGYWxsYmFjayBwcmVtaXVtIChhc3NldCB1bml0cykgYXBwbGllZCB0byByb3V0ZXMKdGhhdCBkb24ndCBvdmVycmlkZSBpdC4KKiBgZGVmYXVsdF9wYXlvZmZgIC0gRmFsbGJhY2sgcGF5b2ZmIChhc3NldCB1bml0cykgcGFpZCBvbiBhIHZhbGlkCmNsYWltOyBtdXN0IGV4Y2VlZCB0aGUgcHJlbWl1bS4KKiBgZGVmYXVsdF9kZWxheV9ob3Vyc2AgLSBGYWxsYmFjayBkZWxheSB0aHJlc2hvbGQgKGhvdXJzKSBhZnRlciB3aGljaCBhCmZsaWdodCBjb3VudHMgYXMgZGVsYXllZC4AAAAADV9fY29uc3RydWN0b3IAAAAAAAAEAAAAAAAAAAVvd25lcgAAAAAAABMAAAAAAAAAD2RlZmF1bHRfcHJlbWl1bQAAAAALAAAAAAAAAA5kZWZhdWx0X3BheW9mZgAAAAAACwAAAAAAAAATZGVmYXVsdF9kZWxheV9ob3VycwAAAAAEAAAAAA==",
        "AAAAAAAAA/1Cb3VuZCB0aGUgZWNvbm9taWNzIGFueSByb3V0ZSB3cml0ZSBtYXkgY2FycnkgKG93bmVyLW9ubHkpLiBSb3V0ZQpsaWZlY3ljbGUgY2FsbHMgYXJlIG9wZW4gdG8gYWRtaW5zIOKAlCBhIGRlbGliZXJhdGVseSB3ZWFrZXIgcm9sZSB0aGFuCm93bmVyIOKAlCBzbyB0aGVzZSBsaW1pdHMgY2FwIHRoZSBibGFzdCByYWRpdXMgb2YgYSBzaW5nbGUgY29tcHJvbWlzZWQKYWRtaW4ga2V5LCBpbiB0aGUgc2FtZSBzcGlyaXQgYXMgdGhlIGNvbnRyb2xsZXIncyBib3VuZGVkIG93bmVyCnNldHRlcnM6IHdpdGhvdXQgdGhlbSwgb25lIHNpZ25hdHVyZSBjb3VsZCB3aGl0ZWxpc3QgYSBkdXN0LXByZW1pdW0sCnZhdWx0LXNpemVkLXBheW9mZiByb3V0ZSBhbmQgYW55IG5hdHVyYWxseSBkZWxheWVkIG9yIGNhbmNlbGxlZApmbGlnaHQgb24gaXQgd291bGQgaGFuZCB0aGUgdmF1bHQncyBmcmVlIGNhcGl0YWwgdG8gdGhlIGJ1eWVyLgoKYG1heF9wYXlvZmZgIGlzIGFuIGFic29sdXRlIHBlci1wb2xpY3kgcGF5b2ZmIGNlaWxpbmcgaW4gYXNzZXQgdW5pdHMKKDAgZGlzYWJsZXMgaXQg4oCUIHBpY2sgYSBkZXBsb3ltZW50LWFwcHJvcHJpYXRlIHZhbHVlIGF0IHdpcmluZyB0aW1lKS4KYG1heF9wYXlvZmZfcmF0aW9gIGNhcHMgYHBheW9mZiAvIHByZW1pdW1gOyBpdCBpcyB1bml0LWZyZWUsIGRlZmF1bHRzCnRvIGEgZ2VuZXJvdXMgY29uc3RhbnQgZnJvbSBnZW5lc2lzLCBhbmQgY2Fubm90IGJlIGRpc2FibGVkIChhIHJhdGlvCmJlbG93IDIgd291bGQgcmVqZWN0IGV2ZXJ5IHZhbGlkIHJvdXRlLCBzaW5jZSBwYXlvZmYgbXVzdCBleGNlZWQKcHJlbWl1bSkuIEJvdGggYXJlIGVuZm9yY2VkIG9uIGV2ZXJ5IHJvdXRlIHdyaXRlIGFuZCBvbgpgc2V0X2RlZmF1bHRzYCwgYW5kIGByb3V0ZV9zdGF0dXNgIHN0b3BzIGFkdmVydGlzaW5nIGEgcm91dGUgdGhhdApleGNlZWRzIHRoZSBjdXJyZW50IGxpbWl0cyDigJQgbG93ZXJpbmcgdGhlbSByZXRyb2FjdGl2ZWx5IGRlLWxpc3RzCm92ZXJzaXplZCByb3V0ZXMuAAAAAAAAD3NldF90ZXJtX2xpbWl0cwAAAAACAAAAAAAAAAptYXhfcGF5b2ZmAAAAAAALAAAAAAAAABBtYXhfcGF5b2ZmX3JhdGlvAAAACwAAAAA=",
        "AAAABAAAAAAAAAAAAAAABUVycm9yAAAAAAAADwAAAAAAAAAVUHJlbWl1bU11c3RCZVBvc2l0aXZlAAAAAAAB9QAAAAAAAAAUUGF5b2ZmTXVzdEJlUG9zaXRpdmUAAAH2AAAAAAAAABdQYXlvZmZNdXN0RXhjZWVkUHJlbWl1bQAAAAH3AAAAAAAAABhEZWxheUhvdXJzTXVzdEJlUG9zaXRpdmUAAAH4AAAAAAAAABVGbGlnaHRJZEFscmVhZHlNYXBwZWQAAAAAAAH5AAAAAAAAABRSb3V0ZUFscmVhZHlEaXNhYmxlZAAAAfoAAAAAAAAAElJvdXRlQWxyZWFkeUFjdGl2ZQAAAAAB+wAAAAAAAAAgUm91dGVNdXN0QmVEaXNhYmxlZEJlZm9yZVJlbW92YWwAAAH8AAAAAAAAAA9Ob3RPd25lck9yQWRtaW4AAAAB/QAAAAAAAAAPRmxpZ2h0SWRSZXRpcmVkAAAAAf4AAAAAAAAADVJvdXRlTm90Rm91bmQAAAAAAAH/AAAAAAAAABJSb3V0ZUFscmVhZHlMaXN0ZWQAAAAAAgAAAAAAAAAAEFBheW9mZkV4Y2VlZHNDYXAAAAIBAAAAAAAAABlQYXlvZmZFeGNlZWRzUHJlbWl1bVJhdGlvAAAAAAACAgAAAAAAAAARSW52YWxpZFRlcm1MaW1pdHMAAAAAAAID",
        "AAAABQAAAAAAAAAAAAAAC0dvdkRlZmF1bHRzAAAAAAIAAAAIc2VudGluZWwAAAAMZ292X2RlZmF1bHRzAAAAAwAAAAAAAAAHcHJlbWl1bQAAAAALAAAAAAAAAAAAAAAGcGF5b2ZmAAAAAAALAAAAAAAAAAAAAAALZGVsYXlfaG91cnMAAAAABAAAAAAAAAAC",
        "AAAABQAAAAAAAAAAAAAAC1JvdXRlTGlzdGVkAAAAAAIAAAAIc2VudGluZWwAAAAMcm91dGVfbGlzdGVkAAAABgAAAAAAAAAJZmxpZ2h0X2lkAAAAAAAAEQAAAAEAAAAAAAAABm9yaWdpbgAAAAAAEQAAAAAAAAAAAAAABGRlc3QAAAARAAAAAAAAAAAAAAAHcHJlbWl1bQAAAAPoAAAACwAAAAAAAAAAAAAABnBheW9mZgAAAAAD6AAAAAsAAAAAAAAAAAAAAAtkZWxheV9ob3VycwAAAAPoAAAABAAAAAAAAAAC",
        "AAAABQAAAAAAAAAAAAAADFJvdXRlRW5hYmxlZAAAAAIAAAAIc2VudGluZWwAAAANcm91dGVfZW5hYmxlZAAAAAAAAAMAAAAAAAAACWZsaWdodF9pZAAAAAAAABEAAAABAAAAAAAAAAZvcmlnaW4AAAAAABEAAAAAAAAAAAAAAARkZXN0AAAAEQAAAAAAAAAC",
        "AAAABQAAAAAAAAAAAAAADFJvdXRlUmVtb3ZlZAAAAAIAAAAIc2VudGluZWwAAAANcm91dGVfcmVtb3ZlZAAAAAAAAAMAAAAAAAAACWZsaWdodF9pZAAAAAAAABEAAAABAAAAAAAAAAZvcmlnaW4AAAAAABEAAAAAAAAAAAAAAARkZXN0AAAAEQAAAAAAAAAC",
        "AAAABQAAAAAAAAAAAAAADFJvdXRlVXBkYXRlZAAAAAIAAAAIc2VudGluZWwAAAANcm91dGVfdXBkYXRlZAAAAAAAAAYAAAAAAAAACWZsaWdodF9pZAAAAAAAABEAAAABAAAAAAAAAAZvcmlnaW4AAAAAABEAAAAAAAAAAAAAAARkZXN0AAAAEQAAAAAAAAAAAAAAB3ByZW1pdW0AAAAD6AAAAAsAAAAAAAAAAAAAAAZwYXlvZmYAAAAAA+gAAAALAAAAAAAAAAAAAAALZGVsYXlfaG91cnMAAAAD6AAAAAQAAAAAAAAAAg==",
        "AAAABQAAAAAAAAAAAAAADUdvdkFkbWluQWRkZWQAAAAAAAACAAAACHNlbnRpbmVsAAAAD2dvdl9hZG1pbl9hZGRlZAAAAAABAAAAAAAAAAVhZG1pbgAAAAAAABMAAAABAAAAAA==",
        "AAAABQAAAAAAAAAAAAAADUdvdlRlcm1MaW1pdHMAAAAAAAACAAAACHNlbnRpbmVsAAAAD2dvdl90ZXJtX2xpbWl0cwAAAAACAAAAAAAAAAptYXhfcGF5b2ZmAAAAAAALAAAAAAAAAAAAAAAQbWF4X3BheW9mZl9yYXRpbwAAAAsAAAAAAAAAAg==",
        "AAAABQAAAAAAAAAAAAAADVJvdXRlRGlzYWJsZWQAAAAAAAACAAAACHNlbnRpbmVsAAAADnJvdXRlX2Rpc2FibGVkAAAAAAADAAAAAAAAAAlmbGlnaHRfaWQAAAAAAAARAAAAAQAAAAAAAAAGb3JpZ2luAAAAAAARAAAAAAAAAAAAAAAEZGVzdAAAABEAAAAAAAAAAg==",
        "AAAABQAAAAAAAAAAAAAAD0dvdkFkbWluUmVtb3ZlZAAAAAACAAAACHNlbnRpbmVsAAAAEWdvdl9hZG1pbl9yZW1vdmVkAAAAAAAAAQAAAAAAAAAFYWRtaW4AAAAAAAATAAAAAQAAAAA=",
        "AAAAAAAAACZSZS1lbmFibGUgYSBwcmV2aW91c2x5IGRpc2FibGVkIHJvdXRlLgAAAAAADGVuYWJsZV9yb3V0ZQAAAAQAAAAAAAAABmNhbGxlcgAAAAAAEwAAAAAAAAAJZmxpZ2h0X2lkAAAAAAAAEQAAAAAAAAAGb3JpZ2luAAAAAAARAAAAAAAAAARkZXN0AAAAEQAAAAA=",
        "AAAAAAAAAJ1IYXJkLWRlbGV0ZSBhIHJvdXRlIGVudHJ5LiBTdHJpY3Q6IHJlcXVpcmVzIHRoZSByb3V0ZSB0byBiZSBkaXNhYmxlZApmaXJzdCAoYXBwcm92ZWQgPT0gZmFsc2UpLiBQcmV2ZW50cyBmYXQtZmluZ2VyIHJlbW92YWwgb2YgYW4KYWN0aXZlbHktcHVyY2hhc2FibGUgcm91dGUuAAAAAAAADHJlbW92ZV9yb3V0ZQAAAAQAAAAAAAAABmNhbGxlcgAAAAAAEwAAAAAAAAAJZmxpZ2h0X2lkAAAAAAAAEQAAAAAAAAAGb3JpZ2luAAAAAAARAAAAAAAAAARkZXN0AAAAEQAAAAA=",
        "AAAAAAAAAkVNYXJrIGEgd2hpdGVsaXN0ZWQgcm91dGUgYXMgZGlzYWJsZWQgKG5vdCBwdXJjaGFzYWJsZSkuCgpEZWxpYmVyYXRlbHkgcGF1c2UtZ2F0ZWQsIHVubGlrZSB0aGUgcmV2b2NhdGlvbi1vbmx5IHdyaXRlcyB0aGF0IHN0YXkKY2FsbGFibGUgZHVyaW5nIGEgcGF1c2UgKGByZW1vdmVfYWRtaW5gLCB0aGUgb3JhY2xlJ3MgYGNsb3NlX3NhbGVgLAp0aGUgY29udHJvbGxlcidzIGByZW1vdmVfd2hpdGVsaXN0ZWRfYnV5ZXJgKS4gVGhvc2UgZXhpc3QgYmVjYXVzZSBhCnBhdXNlIGxlYXZlcyBubyBvdGhlciBsZXZlciBhZ2FpbnN0IHRoZWlyIGhhemFyZDsgYSBiYWQgcm91dGUgaGFzCnR3bzogcGF1c2luZyB0aGUgY29udHJvbGxlciBoYWx0cyBldmVyeSBwdXJjaGFzZSBvdXRyaWdodCwgYW5kIHRoZQpvcmFjbGUncyBwYXVzZS1leGVtcHQgYGNsb3NlX3NhbGVgIGtpbGxzIGluc3VyYWJpbGl0eSBwZXIgZmxpZ2h0LiBXaXRoCmNvdmVyYWdlIGFscmVhZHkgZ3VhcmFudGVlZCBtaWQtaW5jaWRlbnQsIGtlZXBpbmcgcm91dGUgbGlmZWN5Y2xlCndyaXRlcyB1bmlmb3JtbHkgZ2F0ZWQgaXMgdGhlIHNpbXBsZXIgaW52YXJpYW50LgAAAAAAAA1kaXNhYmxlX3JvdXRlAAAAAAAABAAAAAAAAAAGY2FsbGVyAAAAAAATAAAAAAAAAAlmbGlnaHRfaWQAAAAAAAARAAAAAAAAAAZvcmlnaW4AAAAAABEAAAAAAAAABGRlc3QAAAARAAAAAA==",
        "AAAAAAAAAQdXaGl0ZWxpc3QgYSBORVcgcm91dGUgd2l0aCBvcHRpb25hbCBwZXItcm91dGUgdGVybSBvdmVycmlkZXMuClJlLWxpc3RpbmcgYW4gZXhpc3RpbmcgZW50cnkgaXMgcmVqZWN0ZWQgdW5sZXNzIGl0IGlzIGJ5dGUtaWRlbnRpY2FsCmFuZCBzdGlsbCBhcHByb3ZlZCAoaWRlbXBvdGVudCByZWZyZXNoKSDigJQgdGVybSBjaGFuZ2VzIG11c3QgZ28gdGhyb3VnaApgdXBkYXRlX3JvdXRlX3Rlcm1zYCwgcmUtYWN0aXZhdGlvbiB0aHJvdWdoIGBlbmFibGVfcm91dGVgLgAAAAAPd2hpdGVsaXN0X3JvdXRlAAAAAAcAAAAAAAAABmNhbGxlcgAAAAAAEwAAAAAAAAAJZmxpZ2h0X2lkAAAAAAAAEQAAAAAAAAAGb3JpZ2luAAAAAAARAAAAAAAAAARkZXN0AAAAEQAAAAAAAAAHcHJlbWl1bQAAAAPoAAAACwAAAAAAAAAGcGF5b2ZmAAAAAAPoAAAACwAAAAAAAAALZGVsYXlfaG91cnMAAAAD6AAAAAQAAAAA",
        "AAAAAAAAAEVQYXJ0aWFsbHkgdXBkYXRlIGEgcm91dGUncyBwcmVtaXVtLCBwYXlvZmYsIGFuZC9vciBkZWxheS1ob3VycyB0ZXJtcy4AAAAAAAASdXBkYXRlX3JvdXRlX3Rlcm1zAAAAAAAHAAAAAAAAAAZjYWxsZXIAAAAAABMAAAAAAAAACWZsaWdodF9pZAAAAAAAABEAAAAAAAAABm9yaWdpbgAAAAAAEQAAAAAAAAAEZGVzdAAAABEAAAAAAAAAB3ByZW1pdW0AAAAH0AAAAA1QcmVtaXVtVXBkYXRlAAAAAAAAAAAAAAZwYXlvZmYAAAAAB9AAAAAMUGF5b2ZmVXBkYXRlAAAAAAAAAAtkZWxheV9ob3VycwAAAAfQAAAAEERlbGF5SG91cnNVcGRhdGUAAAAA",
        "AAAAAAAAAAAAAAAFcGF1c2UAAAAAAAABAAAAAAAAAAZjYWxsZXIAAAAAABMAAAAA",
        "AAAAAAAAAHFSZXR1cm5zIHRydWUgaWYgdGhlIGNvbnRyYWN0IGlzIHBhdXNlZCwgYW5kIGZhbHNlIG90aGVyd2lzZS4KCiMgQXJndW1lbnRzCgoqIGBlYCAtIEFjY2VzcyB0byBTb3JvYmFuIGVudmlyb25tZW50LgAAAAAAAAZwYXVzZWQAAAAAAAAAAAABAAAAAQ==",
        "AAAAAAAAAAAAAAAHdW5wYXVzZQAAAAABAAAAAAAAAAZjYWxsZXIAAAAAABMAAAAA",
        "AAAAAAAAAJBSZXR1cm5zIGBTb21lKEFkZHJlc3MpYCBpZiBvd25lcnNoaXAgaXMgc2V0LCBvciBgTm9uZWAgaWYgb3duZXJzaGlwIGhhcwpiZWVuIHJlbm91bmNlZC4KCiMgQXJndW1lbnRzCgoqIGBlYCAtIEFjY2VzcyB0byB0aGUgU29yb2JhbiBlbnZpcm9ubWVudC4AAAAJZ2V0X293bmVyAAAAAAAAAAAAAAEAAAPoAAAAEw==",
        "AAAAAAAAATBBY2NlcHRzIGEgcGVuZGluZyBvd25lcnNoaXAgdHJhbnNmZXIuCgojIEFyZ3VtZW50cwoKKiBgZWAgLSBBY2Nlc3MgdG8gdGhlIFNvcm9iYW4gZW52aXJvbm1lbnQuCgojIEVycm9ycwoKKiBbYGNyYXRlOjpyb2xlX3RyYW5zZmVyOjpSb2xlVHJhbnNmZXJFcnJvcjo6Tm9QZW5kaW5nVHJhbnNmZXJgXSAtIElmCnRoZXJlIGlzIG5vIHBlbmRpbmcgdHJhbnNmZXIgdG8gYWNjZXB0LgoKIyBFdmVudHMKCiogdG9waWNzIC0gYFsib3duZXJzaGlwX3RyYW5zZmVyX2NvbXBsZXRlZCJdYAoqIGRhdGEgLSBgW25ld19vd25lcjogQWRkcmVzc11gAAAAEGFjY2VwdF9vd25lcnNoaXAAAAAAAAAAAA==",
        "AAAAAAAAAYVSZW5vdW5jZXMgb3duZXJzaGlwIG9mIHRoZSBjb250cmFjdC4KClBlcm1hbmVudGx5IHJlbW92ZXMgdGhlIG93bmVyLCBkaXNhYmxpbmcgYWxsIGZ1bmN0aW9ucyBnYXRlZCBieQpgI1tvbmx5X293bmVyXWAuCgojIEFyZ3VtZW50cwoKKiBgZWAgLSBBY2Nlc3MgdG8gdGhlIFNvcm9iYW4gZW52aXJvbm1lbnQuCgojIEVycm9ycwoKKiBbYE93bmFibGVFcnJvcjo6VHJhbnNmZXJJblByb2dyZXNzYF0gLSBJZiB0aGVyZSBpcyBhIHBlbmRpbmcgb3duZXJzaGlwCnRyYW5zZmVyLgoqIFtgT3duYWJsZUVycm9yOjpPd25lck5vdFNldGBdIC0gSWYgdGhlIG93bmVyIGlzIG5vdCBzZXQuCgojIE5vdGVzCgoqIEF1dGhvcml6YXRpb24gZm9yIHRoZSBjdXJyZW50IG93bmVyIGlzIHJlcXVpcmVkLgAAAAAAABJyZW5vdW5jZV9vd25lcnNoaXAAAAAAAAAAAAAA",
        "AAAAAAAAA45Jbml0aWF0ZXMgYSAyLXN0ZXAgb3duZXJzaGlwIHRyYW5zZmVyIHRvIGEgbmV3IGFkZHJlc3MuCgpSZXF1aXJlcyBhdXRob3JpemF0aW9uIGZyb20gdGhlIGN1cnJlbnQgb3duZXIuIFRoZSBuZXcgb3duZXIgbXVzdCBsYXRlcgpjYWxsIGBhY2NlcHRfb3duZXJzaGlwKClgIHRvIGNvbXBsZXRlIHRoZSB0cmFuc2Zlci4KCiMgQXJndW1lbnRzCgoqIGBlYCAtIEFjY2VzcyB0byB0aGUgU29yb2JhbiBlbnZpcm9ubWVudC4KKiBgbmV3X293bmVyYCAtIFRoZSBwcm9wb3NlZCBuZXcgb3duZXIuCiogYGxpdmVfdW50aWxfbGVkZ2VyYCAtIExlZGdlciBudW1iZXIgdW50aWwgd2hpY2ggdGhlIG5ldyBvd25lciBjYW4KYWNjZXB0LiBBIHZhbHVlIG9mIGAwYCBjYW5jZWxzIGFueSBwZW5kaW5nIHRyYW5zZmVyLgoKIyBFcnJvcnMKCiogW2BPd25hYmxlRXJyb3I6Ok93bmVyTm90U2V0YF0gLSBJZiB0aGUgb3duZXIgaXMgbm90IHNldC4KKiBbYGNyYXRlOjpyb2xlX3RyYW5zZmVyOjpSb2xlVHJhbnNmZXJFcnJvcjo6Tm9QZW5kaW5nVHJhbnNmZXJgXSAtIElmCnRyeWluZyB0byBjYW5jZWwgYSB0cmFuc2ZlciB0aGF0IGRvZXNuJ3QgZXhpc3QuCiogW2BjcmF0ZTo6cm9sZV90cmFuc2Zlcjo6Um9sZVRyYW5zZmVyRXJyb3I6OkludmFsaWRMaXZlVW50aWxMZWRnZXJgXSAtCklmIHRoZSBzcGVjaWZpZWQgbGVkZ2VyIGlzIGluIHRoZSBwYXN0LgoqIFtgY3JhdGU6OnJvbGVfdHJhbnNmZXI6OlJvbGVUcmFuc2ZlckVycm9yOjpJbnZhbGlkUGVuZGluZ0FjY291bnRgXSAtCklmIHRoZSBzcGVjaWZpZWQgcGVuZGluZyBhY2NvdW50IGlzIG5vdCB0aGUgc2FtZSBhcyB0aGUgcHJvdmlkZWQgYG5ld2AKYWRkcmVzcy4KCiMgTm90ZXMKCiogQXV0aG9yaXphdGlvbiBmb3IgdGhlIGN1cnJlbnQgb3duZXIgaXMgcmVxdWlyZWQuAAAAAAASdHJhbnNmZXJfb3duZXJzaGlwAAAAAAACAAAAAAAAAAluZXdfb3duZXIAAAAAAAATAAAAAAAAABFsaXZlX3VudGlsX2xlZGdlcgAAAAAAAAQAAAAA",
        "AAAAAAAAADJSZXR1cm4gd2hldGhlciB0aGUgZ2l2ZW4gYWRkcmVzcyBoYXMgYWRtaW4gcmlnaHRzLgAAAAAACGlzX2FkbWluAAAAAQAAAAAAAAAEYWRkcgAAABMAAAABAAAAAQ==",
        "AAAAAAAAAmhSZXR1cm4gd2hldGhlciBhbHJlYWR5LXJlc29sdmVkIHRlcm1zIGFyZSBhZG1pc3NpYmxlIGZvciBORVcgZXhwb3N1cmUKdW5kZXIgdGhlIGN1cnJlbnQgZGVmYXVsdHMtaW5kZXBlbmRlbnQgdmFsaWRpdHkgcnVsZXMgYW5kIG93bmVyLXNldAp0ZXJtIGxpbWl0cy4gYHJvdXRlX3N0YXR1c2AgYXBwbGllcyB0aGVzZSBjaGVja3MgdG8gYSByb3V0ZSdzIENVUlJFTlQKdGVybXMsIGJ1dCB0aGUgY29udHJvbGxlciBtYXkgcmVwbGFjZSB0aG9zZSB3aXRoIGEgcG9vbCBidWNrZXQncwpzbmFwc2hvdCB0YWtlbiB3aGVuIHRoZSBidWNrZXQgd2FzIGZpcnN0IHJlZ2lzdGVyZWQg4oCUIHRlcm1zIHRoaXMKbW9kdWxlIG5ldmVyIHNlZXMgYWdhaW4uIFdpdGhvdXQgcmUtY2hlY2tpbmcgdGhlIHRlcm1zIGFjdHVhbGx5CmNoYXJnZWQgYW5kIGxvY2tlZCwgbG93ZXJpbmcgdGhlIGxpbWl0cyBjb3VsZCBub3Qgc3RvcCBmdXJ0aGVyIHNhbGVzCm9uIGEgcHJlLWV4aXN0aW5nIG92ZXJzaXplZCBidWNrZXQuIEV4aXN0aW5nIHBvbGljaWVzIGtlZXAgdGhlaXIKc25hcHNob3R0ZWQgdGVybXMgZm9yIHNldHRsZW1lbnQ7IG9ubHkgYWRtaXNzaW9uIG9mIG5ldyBidXllcnMgaXMKanVkZ2VkIGhlcmUuAAAAC3Rlcm1zX3ZhbGlkAAAAAAEAAAAAAAAABXRlcm1zAAAAAAAH0AAAAA1SZXNvbHZlZFRlcm1zAAAAAAAAAQAAAAE=",
        "AAAAAAAAADtSZXR1cm4gdGhlIGdsb2JhbCBkZWZhdWx0IHByZW1pdW0sIHBheW9mZiwgYW5kIGRlbGF5IGhvdXJzLgAAAAAMZ2V0X2RlZmF1bHRzAAAAAAAAAAEAAAPtAAAAAwAAAAsAAAALAAAABA==",
        "AAAAAAAAAf1UeXBlZCBzdGF0dXMgcmVhZGVyLiBSZXR1cm5zIGBBY3RpdmUoUmVzb2x2ZWRUZXJtcylgIChkZWZhdWx0cyBmb2xkZWQpCmlmIHRoZSBlbnRyeSBleGlzdHMsIGlzIGFwcHJvdmVkLCBvd25zIGl0cyBmbGlnaHRfaWQgcGVyIHRoZSB1bmlxdWVuZXNzCmluZGV4LCBhbmQgaXRzIHJlc29sdmVkIHRlcm1zIHBhc3MgdGhlIGN1cnJlbnQgdmFsaWRpdHkgcnVsZXMgYW5kIHRlcm0KbGltaXRzOyBgRGlzYWJsZWRgIGlmIHRoZSBlbnRyeSBleGlzdHMgYnV0IGlzIG5vdCBhcHByb3ZlZCwgb3IgaXMKYXBwcm92ZWQgYnV0IGl0cyByZXNvbHZlZCB0ZXJtcyBmYWlsIHRob3NlIGNoZWNrcyAoZS5nLiBhZnRlciBhCmRlZmF1bHRzIG9yIHRlcm0tbGltaXRzIGNoYW5nZSk7IGBVbmtub3duYCBpZiB0aGUgZW50cnkgaXMgbWlzc2luZwoobmV2ZXIgd2hpdGVsaXN0ZWQsIHJlbW92ZWQsIG9yIHN0b3JhZ2UgYXJjaGl2ZWQpIG9yIHRoZSBmbGlnaHRfaWQgaXMKbWFwcGVkIHRvIGEgZGlmZmVyZW50IHJvdXRlLgAAAAAAAAxyb3V0ZV9zdGF0dXMAAAADAAAAAAAAAAlmbGlnaHRfaWQAAAAAAAARAAAAAAAAAAZvcmlnaW4AAAAAABEAAAAAAAAABGRlc3QAAAARAAAAAQAAB9AAAAALUm91dGVTdGF0dXMA",
        "AAAAAAAAAMpSZXR1cm4gYChtYXhfcGF5b2ZmLCBtYXhfcGF5b2ZmX3JhdGlvKWAg4oCUIHRoZSBvd25lci1jb25maWd1cmVkIGJvdW5kcwpldmVyeSByb3V0ZSdzIHJlc29sdmVkIHRlcm1zIG11c3Qgc2F0aXNmeS4gYG1heF9wYXlvZmYgPT0gMGAgbWVhbnMgdGhlCmFic29sdXRlIGNhcCBpcyBkaXNhYmxlZDsgdGhlIHJhdGlvIGJvdW5kIGlzIGFsd2F5cyBhY3RpdmUuAAAAAAAPZ2V0X3Rlcm1fbGltaXRzAAAAAAAAAAABAAAD7QAAAAIAAAALAAAACw==",
        "AAAAAgAAAAAAAAAAAAAADFBheW9mZlVwZGF0ZQAAAAMAAAAAAAAAAAAAAARLZWVwAAAAAQAAAAAAAAADU2V0AAAAAAEAAAALAAAAAAAAAAAAAAAKVXNlRGVmYXVsdAAA",
        "AAAAAgAAAAAAAAAAAAAADVByZW1pdW1VcGRhdGUAAAAAAAADAAAAAAAAAAAAAAAES2VlcAAAAAEAAAAAAAAAA1NldAAAAAABAAAACwAAAAAAAAAAAAAAClVzZURlZmF1bHQAAA==",
        "AAAAAgAAAAAAAAAAAAAAEERlbGF5SG91cnNVcGRhdGUAAAADAAAAAAAAAAAAAAAES2VlcAAAAAEAAAAAAAAAA1NldAAAAAABAAAABAAAAAAAAAAAAAAAClVzZURlZmF1bHQAAA==",
        "AAAAAAAAAG9Pd25lci1nYXRlZCBXYXNtIHVwZ3JhZGUuIERlbGVnYXRlcyB0byB0aGUgc2hhcmVkIGltcGxlbWVudGF0aW9uLCB3aGljaAphbHNvIGJ1bXBzIHRoZSBzdG9yZWQgb24tY2hhaW4gdmVyc2lvbi4AAAAAB3VwZ3JhZGUAAAAAAQAAAAAAAAAJd2FzbV9oYXNoAAAAAAAD7gAAACAAAAAA",
        "AAAAAAAAACJDdXJyZW50IG9uLWNoYWluIGNvbnRyYWN0IHZlcnNpb24uAAAAAAAHdmVyc2lvbgAAAAAAAAAAAQAAAAQ=",
        "AAAAAgAAAAAAAAAAAAAAC1JvdXRlU3RhdHVzAAAAAAMAAAABAAAAAAAAAAZBY3RpdmUAAAAAAAEAAAfQAAAADVJlc29sdmVkVGVybXMAAAAAAAAAAAAAAAAAAAhEaXNhYmxlZAAAAAAAAAAAAAAAB1Vua25vd24A",
        "AAAAAQAAAAAAAAAAAAAADVJlc29sdmVkVGVybXMAAAAAAAADAAAAAAAAAAtkZWxheV9ob3VycwAAAAAEAAAAAAAAAAZwYXlvZmYAAAAAAAsAAAAAAAAAB3ByZW1pdW0AAAAACw==",
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
    add_admin: this.txFromJSON<null>,
        extend_ttl: this.txFromJSON<null>,
        remove_admin: this.txFromJSON<null>,
        set_defaults: this.txFromJSON<null>,
        set_term_limits: this.txFromJSON<null>,
        enable_route: this.txFromJSON<null>,
        remove_route: this.txFromJSON<null>,
        disable_route: this.txFromJSON<null>,
        whitelist_route: this.txFromJSON<null>,
        update_route_terms: this.txFromJSON<null>,
        pause: this.txFromJSON<null>,
        paused: this.txFromJSON<boolean>,
        unpause: this.txFromJSON<null>,
        get_owner: this.txFromJSON<Option<string>>,
        accept_ownership: this.txFromJSON<null>,
        renounce_ownership: this.txFromJSON<null>,
        transfer_ownership: this.txFromJSON<null>,
        is_admin: this.txFromJSON<boolean>,
        terms_valid: this.txFromJSON<boolean>,
        get_defaults: this.txFromJSON<readonly [i128, i128, u32]>,
        route_status: this.txFromJSON<RouteStatus>,
        get_term_limits: this.txFromJSON<readonly [i128, i128]>,
        upgrade: this.txFromJSON<null>,
        version: this.txFromJSON<u32>
  }
}