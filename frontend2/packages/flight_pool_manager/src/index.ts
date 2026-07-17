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
    contractId: "CCEOYQREEASJ3F2EMNDJDP35ZXTMRVO3LKH3TGEZ6O2UDBCFVQNGDLWJ",
  }
} as const









export interface FlightConfig {
  buyer_count: u32;
  claim_expiry: u64;
  claimed_count: u32;
  delay_hours: u32;
  payoff: i128;
  premium: i128;
  status: SettlementStatus;
}

export type SettlementStatus = {tag: "Active", values: void} | {tag: "SettledOnTime", values: void} | {tag: "SettledDelayed", values: void} | {tag: "SettledCancelled", values: void};







export interface Client {
  /**
   * Construct and simulate a extend_ttl transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Extend instance TTL. Called by cron as a safety net.
   */
  extend_ttl: (options?: MethodOptions) => Promise<AssembledTransaction<null>>

  /**
   * Construct and simulate a set_controller transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Set the authorized controller. One-time write — fails if already set.
   */
  set_controller: ({controller}: {controller: string}, options?: MethodOptions) => Promise<AssembledTransaction<null>>

  /**
   * Construct and simulate a withdraw_recovered transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Owner withdraws funds credited to RecoveredBalance via sweep_expired.
   * Transfers asset from the contract to the owner.
   * 
   * Deliberately pause-gated, unlike the vault's `recover_uncollected`
   * (which is pause-exempt): recovered funds are protocol revenue with no
   * third party waiting on them, so nothing is lost by deferring this
   * withdrawal until after an incident — whereas the vault path settles
   * user-owed credits that must stay recoverable during a pause.
   */
  withdraw_recovered: ({amount}: {amount: i128}, options?: MethodOptions) => Promise<AssembledTransaction<null>>

  /**
   * Construct and simulate a claim transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Buyer claims their payoff after delayed/cancelled settlement.
   * 
   * Intentionally NOT `#[when_not_paused]`. Claim windows run on
   * the ledger clock, which keeps advancing during a pause; gating claims
   * would let an emergency pause silently expire valid, already-funded
   * payouts that travelers could never recover after unpause. Claiming only
   * moves funds already earmarked to the rightful policy holder (full auth +
   * status + window + double-claim checks below), so it is safe to keep open.
   */
  claim: ({traveler, flight_id, date}: {traveler: string, flight_id: string, date: u64}, options?: MethodOptions) => Promise<AssembledTransaction<null>>

  /**
   * Construct and simulate a sweep_expired transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * After claim_expiry, credit unclaimed payouts to RecoveredBalance.
   * Idempotent: subsequent calls find unclaimed == 0 and return.
   */
  sweep_expired: ({flight_id, date}: {flight_id: string, date: u64}, options?: MethodOptions) => Promise<AssembledTransaction<null>>

  /**
   * Construct and simulate a settle_delayed transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Settle delayed: open the claim window. RiskVault top-up handled by
   * Controller separately (it calls vault.send_payout(self_addr, ...)).
   */
  settle_delayed: ({controller, flight_id, date, claim_expiry}: {controller: string, flight_id: string, date: u64, claim_expiry: u64}, options?: MethodOptions) => Promise<AssembledTransaction<null>>

  /**
   * Construct and simulate a settle_on_time transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Settle on time: transfer premium*buyer_count to RiskVault as yield and
   * return the transferred amount so the Controller can record it as vault
   * income.
   * 
   * The pool moves its own held premiums to the vault (a contract is
   * implicitly authorized to spend its own balance), but it does NOT call
   * the vault's controller-only `record_premium_income`. That accounting
   * call requires the Controller's address to authorize it; since the pool —
   * not the Controller — is the direct caller of the vault, the Controller's
   * auth does not propagate to a call the pool initiates, so the only correct
   * caller is the Controller itself. We therefore return the transferred
   * total and let the Controller credit vault income directly.
   */
  settle_on_time: ({controller, flight_id, date}: {controller: string, flight_id: string, date: u64}, options?: MethodOptions) => Promise<AssembledTransaction<i128>>

  /**
   * Construct and simulate a settle_cancelled transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Settle cancelled: identical state shape to settle_delayed.
   */
  settle_cancelled: ({controller, flight_id, date, claim_expiry}: {controller: string, flight_id: string, date: u64, claim_expiry: u64}, options?: MethodOptions) => Promise<AssembledTransaction<null>>

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
   * Construct and simulate a has_policy transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Returns true if the traveler holds a policy for the given flight.
   */
  has_policy: ({flight_id, date, traveler}: {flight_id: string, date: u64, traveler: string}, options?: MethodOptions) => Promise<AssembledTransaction<boolean>>

  /**
   * Construct and simulate a has_claimed transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Returns true if the traveler has already claimed their payout.
   */
  has_claimed: ({flight_id, date, traveler}: {flight_id: string, date: u64, traveler: string}, options?: MethodOptions) => Promise<AssembledTransaction<boolean>>

  /**
   * Construct and simulate a get_controller transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Returns the authorized controller address, or `None` if unset.
   */
  get_controller: (options?: MethodOptions) => Promise<AssembledTransaction<Option<string>>>

  /**
   * Construct and simulate a get_risk_vault transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Returns the RiskVault address that collected premiums are swept to.
   */
  get_risk_vault: (options?: MethodOptions) => Promise<AssembledTransaction<string>>

  /**
   * Construct and simulate a get_asset_token transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Returns the asset token address used for premiums and payouts.
   */
  get_asset_token: (options?: MethodOptions) => Promise<AssembledTransaction<string>>

  /**
   * Construct and simulate a get_flight_config transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Returns `Some(cfg)` if the flight is registered, `None` otherwise.
   * Caller decides how to handle missing entries — controllers use this
   * for the "look up; if missing, register" pattern in `buy_insurance`
   * without forcing a panic + restart.
   */
  get_flight_config: ({flight_id, date}: {flight_id: string, date: u64}, options?: MethodOptions) => Promise<AssembledTransaction<Option<FlightConfig>>>

  /**
   * Construct and simulate a get_active_flights transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Returns the list of currently active (unsettled) flights.
   */
  get_active_flights: (options?: MethodOptions) => Promise<AssembledTransaction<Array<readonly [string, u64]>>>

  /**
   * Construct and simulate a get_recovered_balance transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Returns the balance of unclaimed funds available for owner recovery.
   */
  get_recovered_balance: (options?: MethodOptions) => Promise<AssembledTransaction<i128>>

  /**
   * Construct and simulate a get_active_flight_count transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Number of currently active (unsettled) flight buckets. Cheap
   * saturation gauge for operators: the active list is capped, so
   * occupancy approaching the cap means new-bucket registration (and thus
   * first purchases of new flights) is about to be rejected — investigate
   * settlement throughput before that happens.
   */
  get_active_flight_count: (options?: MethodOptions) => Promise<AssembledTransaction<u32>>

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
   * Construct and simulate a add_buyer transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Record a buyer for an active flight. Called by Controller during
   * buy_insurance. Premium asset is expected to have arrived separately
   * (Controller transfers from traveler before calling this).
   */
  add_buyer: ({controller, flight_id, date, buyer}: {controller: string, flight_id: string, date: u64, buyer: string}, options?: MethodOptions) => Promise<AssembledTransaction<null>>

  /**
   * Construct and simulate a register_flight transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Register a flight. Idempotent: re-registering the same
   * `(flight_id, date)` is a no-op when the new terms match the existing
   * entry, and panics when they would diverge. This lets two travelers
   * race to the first purchase of a new route in the same ledger without
   * the second tx reverting.
   */
  register_flight: ({controller, flight_id, date, premium, payoff, delay_hours}: {controller: string, flight_id: string, date: u64, premium: i128, payoff: i128, delay_hours: u32}, options?: MethodOptions) => Promise<AssembledTransaction<null>>

}
export class Client extends ContractClient {
  static async deploy<T = Client>(
        /** Constructor/Initialization Args for the contract's `__constructor` method */
        {owner, asset_token, risk_vault}: {owner: string, asset_token: string, risk_vault: string},
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
    return ContractClient.deploy({owner, asset_token, risk_vault}, options)
  }
  constructor(public readonly options: ContractClientOptions) {
    super(
      new ContractSpec([ "AAAAAAAAADRFeHRlbmQgaW5zdGFuY2UgVFRMLiBDYWxsZWQgYnkgY3JvbiBhcyBhIHNhZmV0eSBuZXQuAAAACmV4dGVuZF90dGwAAAAAAAAAAAAA",
        "AAAAAAAAAVdJbml0aWFsaXplIHRoZSBmbGlnaHQgcG9vbCBtYW5hZ2VyLgoKIyBBcmd1bWVudHMKKiBgb3duZXJgIC0gQWRkcmVzcyBncmFudGVkIG93bmVyIHJpZ2h0cyAoc2V0IHRoZSBjb250cm9sbGVyLCByZWNvdmVyCnN0cmFuZGVkIGJhbGFuY2VzLCB1cGdyYWRlKS4KKiBgYXNzZXRfdG9rZW5gIC0gU0FDIGFkZHJlc3Mgb2YgdGhlIGFzc2V0IGluIHdoaWNoIHByZW1pdW1zIGFyZSBoZWxkCmFuZCBwYXlvdXRzIGFyZSBtYWRlIHRvIGJ1eWVycy4KKiBgcmlza192YXVsdGAgLSBBZGRyZXNzIG9mIHRoZSBSaXNrVmF1bHQgdGhhdCBjb2xsZWN0ZWQgcHJlbWl1bXMgYXJlCnN3ZXB0IHRvIG9uIHNldHRsZW1lbnQuAAAAAA1fX2NvbnN0cnVjdG9yAAAAAAAAAwAAAAAAAAAFb3duZXIAAAAAAAATAAAAAAAAAAthc3NldF90b2tlbgAAAAATAAAAAAAAAApyaXNrX3ZhdWx0AAAAAAATAAAAAA==",
        "AAAAAAAAAEdTZXQgdGhlIGF1dGhvcml6ZWQgY29udHJvbGxlci4gT25lLXRpbWUgd3JpdGUg4oCUIGZhaWxzIGlmIGFscmVhZHkgc2V0LgAAAAAOc2V0X2NvbnRyb2xsZXIAAAAAAAEAAAAAAAAACmNvbnRyb2xsZXIAAAAAABMAAAAA",
        "AAAAAAAAAcRPd25lciB3aXRoZHJhd3MgZnVuZHMgY3JlZGl0ZWQgdG8gUmVjb3ZlcmVkQmFsYW5jZSB2aWEgc3dlZXBfZXhwaXJlZC4KVHJhbnNmZXJzIGFzc2V0IGZyb20gdGhlIGNvbnRyYWN0IHRvIHRoZSBvd25lci4KCkRlbGliZXJhdGVseSBwYXVzZS1nYXRlZCwgdW5saWtlIHRoZSB2YXVsdCdzIGByZWNvdmVyX3VuY29sbGVjdGVkYAood2hpY2ggaXMgcGF1c2UtZXhlbXB0KTogcmVjb3ZlcmVkIGZ1bmRzIGFyZSBwcm90b2NvbCByZXZlbnVlIHdpdGggbm8KdGhpcmQgcGFydHkgd2FpdGluZyBvbiB0aGVtLCBzbyBub3RoaW5nIGlzIGxvc3QgYnkgZGVmZXJyaW5nIHRoaXMKd2l0aGRyYXdhbCB1bnRpbCBhZnRlciBhbiBpbmNpZGVudCDigJQgd2hlcmVhcyB0aGUgdmF1bHQgcGF0aCBzZXR0bGVzCnVzZXItb3dlZCBjcmVkaXRzIHRoYXQgbXVzdCBzdGF5IHJlY292ZXJhYmxlIGR1cmluZyBhIHBhdXNlLgAAABJ3aXRoZHJhd19yZWNvdmVyZWQAAAAAAAEAAAAAAAAABmFtb3VudAAAAAAACwAAAAA=",
        "AAAAAAAAAd9CdXllciBjbGFpbXMgdGhlaXIgcGF5b2ZmIGFmdGVyIGRlbGF5ZWQvY2FuY2VsbGVkIHNldHRsZW1lbnQuCgpJbnRlbnRpb25hbGx5IE5PVCBgI1t3aGVuX25vdF9wYXVzZWRdYC4gQ2xhaW0gd2luZG93cyBydW4gb24KdGhlIGxlZGdlciBjbG9jaywgd2hpY2gga2VlcHMgYWR2YW5jaW5nIGR1cmluZyBhIHBhdXNlOyBnYXRpbmcgY2xhaW1zCndvdWxkIGxldCBhbiBlbWVyZ2VuY3kgcGF1c2Ugc2lsZW50bHkgZXhwaXJlIHZhbGlkLCBhbHJlYWR5LWZ1bmRlZApwYXlvdXRzIHRoYXQgdHJhdmVsZXJzIGNvdWxkIG5ldmVyIHJlY292ZXIgYWZ0ZXIgdW5wYXVzZS4gQ2xhaW1pbmcgb25seQptb3ZlcyBmdW5kcyBhbHJlYWR5IGVhcm1hcmtlZCB0byB0aGUgcmlnaHRmdWwgcG9saWN5IGhvbGRlciAoZnVsbCBhdXRoICsKc3RhdHVzICsgd2luZG93ICsgZG91YmxlLWNsYWltIGNoZWNrcyBiZWxvdyksIHNvIGl0IGlzIHNhZmUgdG8ga2VlcCBvcGVuLgAAAAAFY2xhaW0AAAAAAAADAAAAAAAAAAh0cmF2ZWxlcgAAABMAAAAAAAAACWZsaWdodF9pZAAAAAAAABEAAAAAAAAABGRhdGUAAAAGAAAAAA==",
        "AAAAAAAAAH5BZnRlciBjbGFpbV9leHBpcnksIGNyZWRpdCB1bmNsYWltZWQgcGF5b3V0cyB0byBSZWNvdmVyZWRCYWxhbmNlLgpJZGVtcG90ZW50OiBzdWJzZXF1ZW50IGNhbGxzIGZpbmQgdW5jbGFpbWVkID09IDAgYW5kIHJldHVybi4AAAAAAA1zd2VlcF9leHBpcmVkAAAAAAAAAgAAAAAAAAAJZmxpZ2h0X2lkAAAAAAAAEQAAAAAAAAAEZGF0ZQAAAAYAAAAA",
        "AAAABQAAAAAAAAAAAAAACkJ1eWVyQWRkZWQAAAAAAAIAAAAIc2VudGluZWwAAAAFYnV5ZXIAAAAAAAADAAAAAAAAAAlmbGlnaHRfaWQAAAAAAAARAAAAAQAAAAAAAAAEZGF0ZQAAAAYAAAABAAAAAAAAAAVidXllcgAAAAAAABMAAAAAAAAAAA==",
        "AAAABQAAAAAAAAAAAAAADEV4cGlyZWRTd2VwdAAAAAIAAAAIc2VudGluZWwAAAAFc3dlZXAAAAAAAAADAAAAAAAAAAlmbGlnaHRfaWQAAAAAAAARAAAAAQAAAAAAAAAEZGF0ZQAAAAYAAAABAAAAAAAAAAl1bmNsYWltZWQAAAAAAAALAAAAAAAAAAA=",
        "AAAABQAAAAAAAAAAAAAADUNvbnRyb2xsZXJTZXQAAAAAAAACAAAACHNlbnRpbmVsAAAADmNvbnRyb2xsZXJfc2V0AAAAAAABAAAAAAAAAApjb250cm9sbGVyAAAAAAATAAAAAQAAAAA=",
        "AAAABQAAAAAAAAAAAAAADUZsaWdodFNldHRsZWQAAAAAAAACAAAACHNlbnRpbmVsAAAABnNldHRsZQAAAAAABAAAAAAAAAAJZmxpZ2h0X2lkAAAAAAAAEQAAAAEAAAAAAAAABGRhdGUAAAAGAAAAAQAAAAAAAAAGc3RhdHVzAAAAAAfQAAAAEFNldHRsZW1lbnRTdGF0dXMAAAAAAAAAAAAAAAxjbGFpbV9leHBpcnkAAAAGAAAAAAAAAAI=",
        "AAAABQAAAAAAAAAAAAAADVBheW91dENsYWltZWQAAAAAAAACAAAACHNlbnRpbmVsAAAABWNsYWltAAAAAAAABAAAAAAAAAAJZmxpZ2h0X2lkAAAAAAAAEQAAAAEAAAAAAAAABGRhdGUAAAAGAAAAAQAAAAAAAAAIdHJhdmVsZXIAAAATAAAAAAAAAAAAAAAGYW1vdW50AAAAAAALAAAAAAAAAAI=",
        "AAAABQAAAAAAAAAAAAAAEEZsaWdodFJlZ2lzdGVyZWQAAAACAAAACHNlbnRpbmVsAAAACHJlZ2lzdGVyAAAABQAAAAAAAAAJZmxpZ2h0X2lkAAAAAAAAEQAAAAEAAAAAAAAABGRhdGUAAAAGAAAAAQAAAAAAAAAHcHJlbWl1bQAAAAALAAAAAAAAAAAAAAAGcGF5b2ZmAAAAAAALAAAAAAAAAAAAAAALZGVsYXlfaG91cnMAAAAABAAAAAAAAAAC",
        "AAAABQAAAAAAAAAAAAAAElJlY292ZXJlZFdpdGhkcmF3bgAAAAAAAgAAAAhzZW50aW5lbAAAAAh3aXRoZHJhdwAAAAIAAAAAAAAABW93bmVyAAAAAAAAEwAAAAEAAAAAAAAABmFtb3VudAAAAAAACwAAAAAAAAAA",
        "AAAAAAAAAIZTZXR0bGUgZGVsYXllZDogb3BlbiB0aGUgY2xhaW0gd2luZG93LiBSaXNrVmF1bHQgdG9wLXVwIGhhbmRsZWQgYnkKQ29udHJvbGxlciBzZXBhcmF0ZWx5IChpdCBjYWxscyB2YXVsdC5zZW5kX3BheW91dChzZWxmX2FkZHIsIC4uLikpLgAAAAAADnNldHRsZV9kZWxheWVkAAAAAAAEAAAAAAAAAApjb250cm9sbGVyAAAAAAATAAAAAAAAAAlmbGlnaHRfaWQAAAAAAAARAAAAAAAAAARkYXRlAAAABgAAAAAAAAAMY2xhaW1fZXhwaXJ5AAAABgAAAAA=",
        "AAAAAAAAAsJTZXR0bGUgb24gdGltZTogdHJhbnNmZXIgcHJlbWl1bSpidXllcl9jb3VudCB0byBSaXNrVmF1bHQgYXMgeWllbGQgYW5kCnJldHVybiB0aGUgdHJhbnNmZXJyZWQgYW1vdW50IHNvIHRoZSBDb250cm9sbGVyIGNhbiByZWNvcmQgaXQgYXMgdmF1bHQKaW5jb21lLgoKVGhlIHBvb2wgbW92ZXMgaXRzIG93biBoZWxkIHByZW1pdW1zIHRvIHRoZSB2YXVsdCAoYSBjb250cmFjdCBpcwppbXBsaWNpdGx5IGF1dGhvcml6ZWQgdG8gc3BlbmQgaXRzIG93biBiYWxhbmNlKSwgYnV0IGl0IGRvZXMgTk9UIGNhbGwKdGhlIHZhdWx0J3MgY29udHJvbGxlci1vbmx5IGByZWNvcmRfcHJlbWl1bV9pbmNvbWVgLiBUaGF0IGFjY291bnRpbmcKY2FsbCByZXF1aXJlcyB0aGUgQ29udHJvbGxlcidzIGFkZHJlc3MgdG8gYXV0aG9yaXplIGl0OyBzaW5jZSB0aGUgcG9vbCDigJQKbm90IHRoZSBDb250cm9sbGVyIOKAlCBpcyB0aGUgZGlyZWN0IGNhbGxlciBvZiB0aGUgdmF1bHQsIHRoZSBDb250cm9sbGVyJ3MKYXV0aCBkb2VzIG5vdCBwcm9wYWdhdGUgdG8gYSBjYWxsIHRoZSBwb29sIGluaXRpYXRlcywgc28gdGhlIG9ubHkgY29ycmVjdApjYWxsZXIgaXMgdGhlIENvbnRyb2xsZXIgaXRzZWxmLiBXZSB0aGVyZWZvcmUgcmV0dXJuIHRoZSB0cmFuc2ZlcnJlZAp0b3RhbCBhbmQgbGV0IHRoZSBDb250cm9sbGVyIGNyZWRpdCB2YXVsdCBpbmNvbWUgZGlyZWN0bHkuAAAAAAAOc2V0dGxlX29uX3RpbWUAAAAAAAMAAAAAAAAACmNvbnRyb2xsZXIAAAAAABMAAAAAAAAACWZsaWdodF9pZAAAAAAAABEAAAAAAAAABGRhdGUAAAAGAAAAAQAAAAs=",
        "AAAAAAAAADpTZXR0bGUgY2FuY2VsbGVkOiBpZGVudGljYWwgc3RhdGUgc2hhcGUgdG8gc2V0dGxlX2RlbGF5ZWQuAAAAAAAQc2V0dGxlX2NhbmNlbGxlZAAAAAQAAAAAAAAACmNvbnRyb2xsZXIAAAAAABMAAAAAAAAACWZsaWdodF9pZAAAAAAAABEAAAAAAAAABGRhdGUAAAAGAAAAAAAAAAxjbGFpbV9leHBpcnkAAAAGAAAAAA==",
        "AAAAAAAAAAAAAAAFcGF1c2UAAAAAAAABAAAAAAAAAAZjYWxsZXIAAAAAABMAAAAA",
        "AAAAAAAAAHFSZXR1cm5zIHRydWUgaWYgdGhlIGNvbnRyYWN0IGlzIHBhdXNlZCwgYW5kIGZhbHNlIG90aGVyd2lzZS4KCiMgQXJndW1lbnRzCgoqIGBlYCAtIEFjY2VzcyB0byBTb3JvYmFuIGVudmlyb25tZW50LgAAAAAAAAZwYXVzZWQAAAAAAAAAAAABAAAAAQ==",
        "AAAAAAAAAAAAAAAHdW5wYXVzZQAAAAABAAAAAAAAAAZjYWxsZXIAAAAAABMAAAAA",
        "AAAAAAAAAJBSZXR1cm5zIGBTb21lKEFkZHJlc3MpYCBpZiBvd25lcnNoaXAgaXMgc2V0LCBvciBgTm9uZWAgaWYgb3duZXJzaGlwIGhhcwpiZWVuIHJlbm91bmNlZC4KCiMgQXJndW1lbnRzCgoqIGBlYCAtIEFjY2VzcyB0byB0aGUgU29yb2JhbiBlbnZpcm9ubWVudC4AAAAJZ2V0X293bmVyAAAAAAAAAAAAAAEAAAPoAAAAEw==",
        "AAAAAAAAATBBY2NlcHRzIGEgcGVuZGluZyBvd25lcnNoaXAgdHJhbnNmZXIuCgojIEFyZ3VtZW50cwoKKiBgZWAgLSBBY2Nlc3MgdG8gdGhlIFNvcm9iYW4gZW52aXJvbm1lbnQuCgojIEVycm9ycwoKKiBbYGNyYXRlOjpyb2xlX3RyYW5zZmVyOjpSb2xlVHJhbnNmZXJFcnJvcjo6Tm9QZW5kaW5nVHJhbnNmZXJgXSAtIElmCnRoZXJlIGlzIG5vIHBlbmRpbmcgdHJhbnNmZXIgdG8gYWNjZXB0LgoKIyBFdmVudHMKCiogdG9waWNzIC0gYFsib3duZXJzaGlwX3RyYW5zZmVyX2NvbXBsZXRlZCJdYAoqIGRhdGEgLSBgW25ld19vd25lcjogQWRkcmVzc11gAAAAEGFjY2VwdF9vd25lcnNoaXAAAAAAAAAAAA==",
        "AAAAAAAAAYVSZW5vdW5jZXMgb3duZXJzaGlwIG9mIHRoZSBjb250cmFjdC4KClBlcm1hbmVudGx5IHJlbW92ZXMgdGhlIG93bmVyLCBkaXNhYmxpbmcgYWxsIGZ1bmN0aW9ucyBnYXRlZCBieQpgI1tvbmx5X293bmVyXWAuCgojIEFyZ3VtZW50cwoKKiBgZWAgLSBBY2Nlc3MgdG8gdGhlIFNvcm9iYW4gZW52aXJvbm1lbnQuCgojIEVycm9ycwoKKiBbYE93bmFibGVFcnJvcjo6VHJhbnNmZXJJblByb2dyZXNzYF0gLSBJZiB0aGVyZSBpcyBhIHBlbmRpbmcgb3duZXJzaGlwCnRyYW5zZmVyLgoqIFtgT3duYWJsZUVycm9yOjpPd25lck5vdFNldGBdIC0gSWYgdGhlIG93bmVyIGlzIG5vdCBzZXQuCgojIE5vdGVzCgoqIEF1dGhvcml6YXRpb24gZm9yIHRoZSBjdXJyZW50IG93bmVyIGlzIHJlcXVpcmVkLgAAAAAAABJyZW5vdW5jZV9vd25lcnNoaXAAAAAAAAAAAAAA",
        "AAAAAAAAA45Jbml0aWF0ZXMgYSAyLXN0ZXAgb3duZXJzaGlwIHRyYW5zZmVyIHRvIGEgbmV3IGFkZHJlc3MuCgpSZXF1aXJlcyBhdXRob3JpemF0aW9uIGZyb20gdGhlIGN1cnJlbnQgb3duZXIuIFRoZSBuZXcgb3duZXIgbXVzdCBsYXRlcgpjYWxsIGBhY2NlcHRfb3duZXJzaGlwKClgIHRvIGNvbXBsZXRlIHRoZSB0cmFuc2Zlci4KCiMgQXJndW1lbnRzCgoqIGBlYCAtIEFjY2VzcyB0byB0aGUgU29yb2JhbiBlbnZpcm9ubWVudC4KKiBgbmV3X293bmVyYCAtIFRoZSBwcm9wb3NlZCBuZXcgb3duZXIuCiogYGxpdmVfdW50aWxfbGVkZ2VyYCAtIExlZGdlciBudW1iZXIgdW50aWwgd2hpY2ggdGhlIG5ldyBvd25lciBjYW4KYWNjZXB0LiBBIHZhbHVlIG9mIGAwYCBjYW5jZWxzIGFueSBwZW5kaW5nIHRyYW5zZmVyLgoKIyBFcnJvcnMKCiogW2BPd25hYmxlRXJyb3I6Ok93bmVyTm90U2V0YF0gLSBJZiB0aGUgb3duZXIgaXMgbm90IHNldC4KKiBbYGNyYXRlOjpyb2xlX3RyYW5zZmVyOjpSb2xlVHJhbnNmZXJFcnJvcjo6Tm9QZW5kaW5nVHJhbnNmZXJgXSAtIElmCnRyeWluZyB0byBjYW5jZWwgYSB0cmFuc2ZlciB0aGF0IGRvZXNuJ3QgZXhpc3QuCiogW2BjcmF0ZTo6cm9sZV90cmFuc2Zlcjo6Um9sZVRyYW5zZmVyRXJyb3I6OkludmFsaWRMaXZlVW50aWxMZWRnZXJgXSAtCklmIHRoZSBzcGVjaWZpZWQgbGVkZ2VyIGlzIGluIHRoZSBwYXN0LgoqIFtgY3JhdGU6OnJvbGVfdHJhbnNmZXI6OlJvbGVUcmFuc2ZlckVycm9yOjpJbnZhbGlkUGVuZGluZ0FjY291bnRgXSAtCklmIHRoZSBzcGVjaWZpZWQgcGVuZGluZyBhY2NvdW50IGlzIG5vdCB0aGUgc2FtZSBhcyB0aGUgcHJvdmlkZWQgYG5ld2AKYWRkcmVzcy4KCiMgTm90ZXMKCiogQXV0aG9yaXphdGlvbiBmb3IgdGhlIGN1cnJlbnQgb3duZXIgaXMgcmVxdWlyZWQuAAAAAAASdHJhbnNmZXJfb3duZXJzaGlwAAAAAAACAAAAAAAAAAluZXdfb3duZXIAAAAAAAATAAAAAAAAABFsaXZlX3VudGlsX2xlZGdlcgAAAAAAAAQAAAAA",
        "AAAAAAAAAEFSZXR1cm5zIHRydWUgaWYgdGhlIHRyYXZlbGVyIGhvbGRzIGEgcG9saWN5IGZvciB0aGUgZ2l2ZW4gZmxpZ2h0LgAAAAAAAApoYXNfcG9saWN5AAAAAAADAAAAAAAAAAlmbGlnaHRfaWQAAAAAAAARAAAAAAAAAARkYXRlAAAABgAAAAAAAAAIdHJhdmVsZXIAAAATAAAAAQAAAAE=",
        "AAAAAAAAAD5SZXR1cm5zIHRydWUgaWYgdGhlIHRyYXZlbGVyIGhhcyBhbHJlYWR5IGNsYWltZWQgdGhlaXIgcGF5b3V0LgAAAAAAC2hhc19jbGFpbWVkAAAAAAMAAAAAAAAACWZsaWdodF9pZAAAAAAAABEAAAAAAAAABGRhdGUAAAAGAAAAAAAAAAh0cmF2ZWxlcgAAABMAAAABAAAAAQ==",
        "AAAAAAAAAD5SZXR1cm5zIHRoZSBhdXRob3JpemVkIGNvbnRyb2xsZXIgYWRkcmVzcywgb3IgYE5vbmVgIGlmIHVuc2V0LgAAAAAADmdldF9jb250cm9sbGVyAAAAAAAAAAAAAQAAA+gAAAAT",
        "AAAAAAAAAENSZXR1cm5zIHRoZSBSaXNrVmF1bHQgYWRkcmVzcyB0aGF0IGNvbGxlY3RlZCBwcmVtaXVtcyBhcmUgc3dlcHQgdG8uAAAAAA5nZXRfcmlza192YXVsdAAAAAAAAAAAAAEAAAAT",
        "AAAAAAAAAD5SZXR1cm5zIHRoZSBhc3NldCB0b2tlbiBhZGRyZXNzIHVzZWQgZm9yIHByZW1pdW1zIGFuZCBwYXlvdXRzLgAAAAAAD2dldF9hc3NldF90b2tlbgAAAAAAAAAAAQAAABM=",
        "AAAAAAAAAO5SZXR1cm5zIGBTb21lKGNmZylgIGlmIHRoZSBmbGlnaHQgaXMgcmVnaXN0ZXJlZCwgYE5vbmVgIG90aGVyd2lzZS4KQ2FsbGVyIGRlY2lkZXMgaG93IHRvIGhhbmRsZSBtaXNzaW5nIGVudHJpZXMg4oCUIGNvbnRyb2xsZXJzIHVzZSB0aGlzCmZvciB0aGUgImxvb2sgdXA7IGlmIG1pc3NpbmcsIHJlZ2lzdGVyIiBwYXR0ZXJuIGluIGBidXlfaW5zdXJhbmNlYAp3aXRob3V0IGZvcmNpbmcgYSBwYW5pYyArIHJlc3RhcnQuAAAAAAARZ2V0X2ZsaWdodF9jb25maWcAAAAAAAACAAAAAAAAAAlmbGlnaHRfaWQAAAAAAAARAAAAAAAAAARkYXRlAAAABgAAAAEAAAPoAAAH0AAAAAxGbGlnaHRDb25maWc=",
        "AAAAAAAAADlSZXR1cm5zIHRoZSBsaXN0IG9mIGN1cnJlbnRseSBhY3RpdmUgKHVuc2V0dGxlZCkgZmxpZ2h0cy4AAAAAAAASZ2V0X2FjdGl2ZV9mbGlnaHRzAAAAAAAAAAAAAQAAA+oAAAPtAAAAAgAAABEAAAAG",
        "AAAAAAAAAERSZXR1cm5zIHRoZSBiYWxhbmNlIG9mIHVuY2xhaW1lZCBmdW5kcyBhdmFpbGFibGUgZm9yIG93bmVyIHJlY292ZXJ5LgAAABVnZXRfcmVjb3ZlcmVkX2JhbGFuY2UAAAAAAAAAAAAAAQAAAAs=",
        "AAAAAAAAATNOdW1iZXIgb2YgY3VycmVudGx5IGFjdGl2ZSAodW5zZXR0bGVkKSBmbGlnaHQgYnVja2V0cy4gQ2hlYXAKc2F0dXJhdGlvbiBnYXVnZSBmb3Igb3BlcmF0b3JzOiB0aGUgYWN0aXZlIGxpc3QgaXMgY2FwcGVkLCBzbwpvY2N1cGFuY3kgYXBwcm9hY2hpbmcgdGhlIGNhcCBtZWFucyBuZXctYnVja2V0IHJlZ2lzdHJhdGlvbiAoYW5kIHRodXMKZmlyc3QgcHVyY2hhc2VzIG9mIG5ldyBmbGlnaHRzKSBpcyBhYm91dCB0byBiZSByZWplY3RlZCDigJQgaW52ZXN0aWdhdGUKc2V0dGxlbWVudCB0aHJvdWdocHV0IGJlZm9yZSB0aGF0IGhhcHBlbnMuAAAAABdnZXRfYWN0aXZlX2ZsaWdodF9jb3VudAAAAAAAAAAAAQAAAAQ=",
        "AAAAAAAAAG9Pd25lci1nYXRlZCBXYXNtIHVwZ3JhZGUuIERlbGVnYXRlcyB0byB0aGUgc2hhcmVkIGltcGxlbWVudGF0aW9uLCB3aGljaAphbHNvIGJ1bXBzIHRoZSBzdG9yZWQgb24tY2hhaW4gdmVyc2lvbi4AAAAAB3VwZ3JhZGUAAAAAAQAAAAAAAAAJd2FzbV9oYXNoAAAAAAAD7gAAACAAAAAA",
        "AAAAAAAAACJDdXJyZW50IG9uLWNoYWluIGNvbnRyYWN0IHZlcnNpb24uAAAAAAAHdmVyc2lvbgAAAAAAAAAAAQAAAAQ=",
        "AAAAAAAAAL5SZWNvcmQgYSBidXllciBmb3IgYW4gYWN0aXZlIGZsaWdodC4gQ2FsbGVkIGJ5IENvbnRyb2xsZXIgZHVyaW5nCmJ1eV9pbnN1cmFuY2UuIFByZW1pdW0gYXNzZXQgaXMgZXhwZWN0ZWQgdG8gaGF2ZSBhcnJpdmVkIHNlcGFyYXRlbHkKKENvbnRyb2xsZXIgdHJhbnNmZXJzIGZyb20gdHJhdmVsZXIgYmVmb3JlIGNhbGxpbmcgdGhpcykuAAAAAAAJYWRkX2J1eWVyAAAAAAAABAAAAAAAAAAKY29udHJvbGxlcgAAAAAAEwAAAAAAAAAJZmxpZ2h0X2lkAAAAAAAAEQAAAAAAAAAEZGF0ZQAAAAYAAAAAAAAABWJ1eWVyAAAAAAAAEwAAAAA=",
        "AAAAAAAAARxSZWdpc3RlciBhIGZsaWdodC4gSWRlbXBvdGVudDogcmUtcmVnaXN0ZXJpbmcgdGhlIHNhbWUKYChmbGlnaHRfaWQsIGRhdGUpYCBpcyBhIG5vLW9wIHdoZW4gdGhlIG5ldyB0ZXJtcyBtYXRjaCB0aGUgZXhpc3RpbmcKZW50cnksIGFuZCBwYW5pY3Mgd2hlbiB0aGV5IHdvdWxkIGRpdmVyZ2UuIFRoaXMgbGV0cyB0d28gdHJhdmVsZXJzCnJhY2UgdG8gdGhlIGZpcnN0IHB1cmNoYXNlIG9mIGEgbmV3IHJvdXRlIGluIHRoZSBzYW1lIGxlZGdlciB3aXRob3V0CnRoZSBzZWNvbmQgdHggcmV2ZXJ0aW5nLgAAAA9yZWdpc3Rlcl9mbGlnaHQAAAAABgAAAAAAAAAKY29udHJvbGxlcgAAAAAAEwAAAAAAAAAJZmxpZ2h0X2lkAAAAAAAAEQAAAAAAAAAEZGF0ZQAAAAYAAAAAAAAAB3ByZW1pdW0AAAAACwAAAAAAAAAGcGF5b2ZmAAAAAAALAAAAAAAAAAtkZWxheV9ob3VycwAAAAAEAAAAAA==",
        "AAAAAQAAAAAAAAAAAAAADEZsaWdodENvbmZpZwAAAAcAAAAAAAAAC2J1eWVyX2NvdW50AAAAAAQAAAAAAAAADGNsYWltX2V4cGlyeQAAAAYAAAAAAAAADWNsYWltZWRfY291bnQAAAAAAAAEAAAAAAAAAAtkZWxheV9ob3VycwAAAAAEAAAAAAAAAAZwYXlvZmYAAAAAAAsAAAAAAAAAB3ByZW1pdW0AAAAACwAAAAAAAAAGc3RhdHVzAAAAAAfQAAAAEFNldHRsZW1lbnRTdGF0dXM=",
        "AAAAAgAAAAAAAAAAAAAAEFNldHRsZW1lbnRTdGF0dXMAAAAEAAAAAAAAAAAAAAAGQWN0aXZlAAAAAAAAAAAAAAAAAA1TZXR0bGVkT25UaW1lAAAAAAAAAAAAAAAAAAAOU2V0dGxlZERlbGF5ZWQAAAAAAAAAAAAAAAAAEFNldHRsZWRDYW5jZWxsZWQ=",
        "AAAABQAAATFBdWRpdC10cmFpbCBldmVudCBlbWl0dGVkIG9uIGV2ZXJ5IGNvbnRyYWN0IHVwZ3JhZGUuIERlZmluZWQgaGVyZSAocmF0aGVyCnRoYW4gcGVyLWNvbnRyYWN0KSBzbyBldmVyeSBjb250cmFjdCdzIHVwZ3JhZGUgbGVhdmVzIGFuIGlkZW50aWNhbCB0cmFpbC4KVGhlIGVtaXR0aW5nIGNvbnRyYWN0IGFkZHJlc3MgcmlkZXMgdGhlIGV2ZW50IGVudmVsb3BlLCBzbyBvZmYtY2hhaW4KaW5kZXhlcnMga25vdyAqd2hpY2gqIGNvbnRyYWN0IHdhcyB1cGdyYWRlZDsgYHdhc21faGFzaGAgYW5kIGB2ZXJzaW9uYApyZWNvcmQgKnRvIHdoYXQqLgAAAAAAAAAAAAAQQ29udHJhY3RVcGdyYWRlZAAAAAIAAAAIc2VudGluZWwAAAAHdXBncmFkZQAAAAACAAAAAAAAAAl3YXNtX2hhc2gAAAAAAAPuAAAAIAAAAAEAAAAAAAAAB3ZlcnNpb24AAAAABAAAAAAAAAAA",
        "AAAABQAAADZFdmVudCBlbWl0dGVkIHdoZW4gYW4gb3duZXJzaGlwIHRyYW5zZmVyIGlzIGluaXRpYXRlZC4AAAAAAAAAAAART3duZXJzaGlwVHJhbnNmZXIAAAAAAAABAAAAEm93bmVyc2hpcF90cmFuc2ZlcgAAAAAAAwAAAAAAAAAJb2xkX293bmVyAAAAAAAAEwAAAAAAAAAAAAAACW5ld19vd25lcgAAAAAAABMAAAAAAAAAAAAAABFsaXZlX3VudGlsX2xlZGdlcgAAAAAAAAQAAAAAAAAAAg==",
        "AAAABQAAACpFdmVudCBlbWl0dGVkIHdoZW4gb3duZXJzaGlwIGlzIHJlbm91bmNlZC4AAAAAAAAAAAAST3duZXJzaGlwUmVub3VuY2VkAAAAAAABAAAAE293bmVyc2hpcF9yZW5vdW5jZWQAAAAAAQAAAAAAAAAJb2xkX293bmVyAAAAAAAAEwAAAAAAAAAC",
        "AAAABQAAADZFdmVudCBlbWl0dGVkIHdoZW4gYW4gb3duZXJzaGlwIHRyYW5zZmVyIGlzIGNvbXBsZXRlZC4AAAAAAAAAAAAaT3duZXJzaGlwVHJhbnNmZXJDb21wbGV0ZWQAAAAAAAEAAAAcb3duZXJzaGlwX3RyYW5zZmVyX2NvbXBsZXRlZAAAAAEAAAAAAAAACW5ld19vd25lcgAAAAAAABMAAAAAAAAAAg==",
        "AAAABQAAACpFdmVudCBlbWl0dGVkIHdoZW4gdGhlIGNvbnRyYWN0IGlzIHBhdXNlZC4AAAAAAAAAAAAGUGF1c2VkAAAAAAABAAAABnBhdXNlZAAAAAAAAAAAAAI=",
        "AAAABQAAACxFdmVudCBlbWl0dGVkIHdoZW4gdGhlIGNvbnRyYWN0IGlzIHVucGF1c2VkLgAAAAAAAAAIVW5wYXVzZWQAAAABAAAACHVucGF1c2VkAAAAAAAAAAI=" ]),
      options
    )
  }
  public readonly fromJSON = {
    extend_ttl: this.txFromJSON<null>,
        set_controller: this.txFromJSON<null>,
        withdraw_recovered: this.txFromJSON<null>,
        claim: this.txFromJSON<null>,
        sweep_expired: this.txFromJSON<null>,
        settle_delayed: this.txFromJSON<null>,
        settle_on_time: this.txFromJSON<i128>,
        settle_cancelled: this.txFromJSON<null>,
        pause: this.txFromJSON<null>,
        paused: this.txFromJSON<boolean>,
        unpause: this.txFromJSON<null>,
        get_owner: this.txFromJSON<Option<string>>,
        accept_ownership: this.txFromJSON<null>,
        renounce_ownership: this.txFromJSON<null>,
        transfer_ownership: this.txFromJSON<null>,
        has_policy: this.txFromJSON<boolean>,
        has_claimed: this.txFromJSON<boolean>,
        get_controller: this.txFromJSON<Option<string>>,
        get_risk_vault: this.txFromJSON<string>,
        get_asset_token: this.txFromJSON<string>,
        get_flight_config: this.txFromJSON<Option<FlightConfig>>,
        get_active_flights: this.txFromJSON<Array<readonly [string, u64]>>,
        get_recovered_balance: this.txFromJSON<i128>,
        get_active_flight_count: this.txFromJSON<u32>,
        upgrade: this.txFromJSON<null>,
        version: this.txFromJSON<u32>,
        add_buyer: this.txFromJSON<null>,
        register_flight: this.txFromJSON<null>
  }
}