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
    contractId: "CD7KCPQJFYSEUPJ43VXC6RIYCF4WPTVUHH3ANWNPYXTYGE2NBRXGFTXB",
  }
} as const















export type FlightStatus = {tag: "NotInitiated", values: void} | {tag: "Active", values: void} | {tag: "Landed", values: void} | {tag: "Cancelled", values: void} | {tag: "ToBeSettledOnTime", values: void} | {tag: "ToBeSettledDelayed", values: void} | {tag: "ToBeSettledCancelled", values: void} | {tag: "Settled", values: void};







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
   * Sets the vault solvency ratio (validated against allowed bounds).
   */
  set_solvency_ratio: ({ratio}: {ratio: u32}, options?: MethodOptions) => Promise<AssembledTransaction<null>>

  /**
   * Construct and simulate a set_claim_expiry_window transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Sets the claim expiry window (in seconds) after settlement (validated against allowed bounds).
   */
  set_claim_expiry_window: ({seconds}: {seconds: u64}, options?: MethodOptions) => Promise<AssembledTransaction<null>>

  /**
   * Construct and simulate a classify_flights transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Iterate the oracle's active-flight list (the canonical source of
   * in-flight registrations plus a 30-day retention window of recently-
   * settled flights). For each Landed/Cancelled flight, compute the
   * settlement outcome from FlightPoolManager's locked terms and write
   * `ToBeSettled*` back to the oracle.
   */
  classify_flights: ({keeper}: {keeper: string}, options?: MethodOptions) => Promise<AssembledTransaction<null>>

  /**
   * Construct and simulate a execute_settlements transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Iterate the oracle's active-flight list and process every flight that's
   * in a `ToBeSettled*` status: move money between FlightPoolManager and
   * RiskVault, then mark the oracle entry as `Settled`.
   * 
   * Queue drain and share-price snapshot are NOT done here — see
   * `run_queue_maintenance`. Splitting them ensures
   * underwriter withdrawals can still be processed when the settlement
   * loop runs near the resource budget.
   */
  execute_settlements: ({keeper}: {keeper: string}, options?: MethodOptions) => Promise<AssembledTransaction<null>>

  /**
   * Construct and simulate a run_queue_maintenance transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Drain the underwriter withdrawal queue and refresh the share-price
   * snapshot. Keeper-only. Decoupled from `execute_settlements` so the
   * queue cannot be blocked by gas exhaustion in the settlement loop;
   * keeper can run this on its own cadence.
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
   * Construct and simulate a is_whitelisted transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Whether `addr` is on the whitelist. Returns `false` for any
   * address that has never been added (or has been removed / archived).
   */
  is_whitelisted: ({addr}: {addr: string}, options?: MethodOptions) => Promise<AssembledTransaction<boolean>>

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
   * Per-traveler index — returns every `(flight_id, date)` the address has
   * ever bought insurance for. Append-only; frontend filters by current
   * status (looked up in FlightPoolManager / oracle).
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
   * existing entry refreshes its TTL without panic. Intentionally NOT
   * gated by Pausable so admins can keep the list current during a pause.
   * 
   * Approval lifetime model (deliberate): an approval is a persistent
   * entry with a ~180-day TTL, refreshed on every purchase the buyer
   * makes. A buyer DORMANT for the full window lapses silently and must be
   * re-approved — the archived entry reads as not-whitelisted, and the
   * purchase gate rejects before any self-refresh could run. This is
   * treated as periodic re-attestation of inactive accounts rather than a
   * defect: it fails closed, and recovery is one admin call. Off-chain
   * tooling can watch `buyer_whitelisted` events to re-extend or alert
   * before dormant approvals age out.
   */
  add_whitelisted_buyer: ({caller, addr}: {caller: string, addr: string}, options?: MethodOptions) => Promise<AssembledTransaction<null>>

  /**
   * Construct and simulate a set_whitelist_enabled transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Owner-only kill-switch. When `false` (default), `buy_insurance` is
   * open to anyone. When `true`, only addresses with a `true` entry in
   * `BuyerWhitelisted` can call `buy_insurance`.
   */
  set_whitelist_enabled: ({enabled}: {enabled: boolean}, options?: MethodOptions) => Promise<AssembledTransaction<null>>

  /**
   * Construct and simulate a remove_whitelisted_buyer transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Remove `addr` from the whitelist. Same auth as `add_whitelisted_buyer`.
   * Removing an address that was never whitelisted is a no-op (writes
   * `false`, emits the event). The entry is overwritten rather than
   * deleted so a re-add later still refreshes a known key — keeps the
   * Persistent footprint stable for the off-chain TTL cron.
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
        "AAAAAAAAAEFTZXRzIHRoZSB2YXVsdCBzb2x2ZW5jeSByYXRpbyAodmFsaWRhdGVkIGFnYWluc3QgYWxsb3dlZCBib3VuZHMpLgAAAAAAABJzZXRfc29sdmVuY3lfcmF0aW8AAAAAAAEAAAAAAAAABXJhdGlvAAAAAAAABAAAAAA=",
        "AAAAAAAAAF5TZXRzIHRoZSBjbGFpbSBleHBpcnkgd2luZG93IChpbiBzZWNvbmRzKSBhZnRlciBzZXR0bGVtZW50ICh2YWxpZGF0ZWQgYWdhaW5zdCBhbGxvd2VkIGJvdW5kcykuAAAAAAAXc2V0X2NsYWltX2V4cGlyeV93aW5kb3cAAAAAAQAAAAAAAAAHc2Vjb25kcwAAAAAGAAAAAA==",
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
        "AAAABQAAAAAAAAAAAAAAFUJ1eWVyV2hpdGVsaXN0ZWRFdmVudAAAAAAAAAIAAAAIc2VudGluZWwAAAARYnV5ZXJfd2hpdGVsaXN0ZWQAAAAAAAABAAAAAAAAAARhZGRyAAAAEwAAAAEAAAAA",
        "AAAABQAAAAAAAAAAAAAAGkJ1eWVyV2hpdGVsaXN0UmVtb3ZlZEV2ZW50AAAAAAACAAAACHNlbnRpbmVsAAAADWJ1eWVyX3JlbW92ZWQAAAAAAAABAAAAAAAAAARhZGRyAAAAEwAAAAEAAAAA",
        "AAAAAAAAASpJdGVyYXRlIHRoZSBvcmFjbGUncyBhY3RpdmUtZmxpZ2h0IGxpc3QgKHRoZSBjYW5vbmljYWwgc291cmNlIG9mCmluLWZsaWdodCByZWdpc3RyYXRpb25zIHBsdXMgYSAzMC1kYXkgcmV0ZW50aW9uIHdpbmRvdyBvZiByZWNlbnRseS0Kc2V0dGxlZCBmbGlnaHRzKS4gRm9yIGVhY2ggTGFuZGVkL0NhbmNlbGxlZCBmbGlnaHQsIGNvbXB1dGUgdGhlCnNldHRsZW1lbnQgb3V0Y29tZSBmcm9tIEZsaWdodFBvb2xNYW5hZ2VyJ3MgbG9ja2VkIHRlcm1zIGFuZCB3cml0ZQpgVG9CZVNldHRsZWQqYCBiYWNrIHRvIHRoZSBvcmFjbGUuAAAAAAAQY2xhc3NpZnlfZmxpZ2h0cwAAAAEAAAAAAAAABmtlZXBlcgAAAAAAEwAAAAA=",
        "AAAAAAAAAZdJdGVyYXRlIHRoZSBvcmFjbGUncyBhY3RpdmUtZmxpZ2h0IGxpc3QgYW5kIHByb2Nlc3MgZXZlcnkgZmxpZ2h0IHRoYXQncwppbiBhIGBUb0JlU2V0dGxlZCpgIHN0YXR1czogbW92ZSBtb25leSBiZXR3ZWVuIEZsaWdodFBvb2xNYW5hZ2VyIGFuZApSaXNrVmF1bHQsIHRoZW4gbWFyayB0aGUgb3JhY2xlIGVudHJ5IGFzIGBTZXR0bGVkYC4KClF1ZXVlIGRyYWluIGFuZCBzaGFyZS1wcmljZSBzbmFwc2hvdCBhcmUgTk9UIGRvbmUgaGVyZSDigJQgc2VlCmBydW5fcXVldWVfbWFpbnRlbmFuY2VgLiBTcGxpdHRpbmcgdGhlbSBlbnN1cmVzCnVuZGVyd3JpdGVyIHdpdGhkcmF3YWxzIGNhbiBzdGlsbCBiZSBwcm9jZXNzZWQgd2hlbiB0aGUgc2V0dGxlbWVudApsb29wIHJ1bnMgbmVhciB0aGUgcmVzb3VyY2UgYnVkZ2V0LgAAAAATZXhlY3V0ZV9zZXR0bGVtZW50cwAAAAABAAAAAAAAAAZrZWVwZXIAAAAAABMAAAAA",
        "AAAAAAAAAO9EcmFpbiB0aGUgdW5kZXJ3cml0ZXIgd2l0aGRyYXdhbCBxdWV1ZSBhbmQgcmVmcmVzaCB0aGUgc2hhcmUtcHJpY2UKc25hcHNob3QuIEtlZXBlci1vbmx5LiBEZWNvdXBsZWQgZnJvbSBgZXhlY3V0ZV9zZXR0bGVtZW50c2Agc28gdGhlCnF1ZXVlIGNhbm5vdCBiZSBibG9ja2VkIGJ5IGdhcyBleGhhdXN0aW9uIGluIHRoZSBzZXR0bGVtZW50IGxvb3A7CmtlZXBlciBjYW4gcnVuIHRoaXMgb24gaXRzIG93biBjYWRlbmNlLgAAAAAVcnVuX3F1ZXVlX21haW50ZW5hbmNlAAAAAAAAAQAAAAAAAAAGa2VlcGVyAAAAAAATAAAAAA==",
        "AAAAAAAABABUZXJtaW5hbCByZWNvbmNpbGlhdGlvbiBmb3IgYSBmbGlnaHQgdGhlIG93bmVyIGV2aWN0ZWQgZnJvbSB0aGUKb3JhY2xlJ3MgYWN0aXZlIGxpc3QgKGBvcmFjbGUuZXZpY3RfbWlzc2luZ19mbGlnaHRgKS4gRXZpY3Rpb24gZnJlZXMKdGhlIG9yYWNsZS1zaWRlIGxpc3Qgc2xvdCBhbmQgcmVsZWFzZXMgdGhlIHNldHRsZW1lbnQgYmFycmllciwgYnV0IG9uCml0cyBvd24gaXQgd291bGQgbGVhdmUgdGhlIGZsaWdodCdzIHBvb2wgYnVja2V0IGBBY3RpdmVgIGZvcmV2ZXIgYW5kCml0cyB2YXVsdCBjb2xsYXRlcmFsIGxvY2tlZCBmb3JldmVyIOKAlCB0aGUgZmxpZ2h0IGlzIG91dHNpZGUga2VlcGVyCmVudW1lcmF0aW9uLCBzbyBubyBzZXR0bGVtZW50IHBhc3MgY2FuIGV2ZXIgcmVhY2ggaXQuIFRoaXMgZW50cnkgcG9pbnQKY29tcGxldGVzIHRoZSByZWxlYXNlOiB0aGUgYnVja2V0IHNldHRsZXMgbGlrZSBhIHZvaWRlZCBmbGlnaHQgKGhlbGQKcHJlbWl1bXMgZm9yd2FyZGVkIHRvIHRoZSB2YXVsdCBhcyBpbmNvbWUsIGNvbGxhdGVyYWwgdW5sb2NrZWQsIG5vCnBheW91dCDigJQgd2l0aCBubyBvcmFjbGUgZGF0YSB0aGVyZSBpcyBubyBvbi1jaGFpbiBvdXRjb21lIHRvIHBheQphZ2FpbnN0KSwgd2hpY2ggYWxzbyBmcmVlcyB0aGUgYnVja2V0J3MgcG9vbCBhY3RpdmUtbGlzdCBzbG90LgoKT3duZXItb25seSwgYW5kIHJlc3RyaWN0ZWQgdG8gZmxpZ2h0cyBwcm92YWJseSBvdXRzaWRlIHRoZSBub3JtYWwKcGlwZWxpbmU6Ci0gdGhlIG9yYWNsZSBtdXN0IGhhdmUgTk8gYEZsaWdodERhdGFgIHJvdyAodGhlIHNhbWUgZ2F0ZSBldmljdGlvbgppdHNlbGYgZW5mb3JjZXMg4oCUIGEgcHJlc2VudCByb3cgbWVhbnMgdGhlIGZsaWdodCBpcyByZXN0b3JhYmxlLCBhbmQKcmVzdG9yZS1hbmQtc2V0dGxlIGlzIHRoZSBjb3JyZWN0IHBhdGgpLiBBIHJvdyByZXN0b3JlZCBBRlRFUgpldmljdGlvbiBibG9ja3MgdGhpcyByZWNvbmNpbGlhdGlvbiwgYnV0IG9ubHkgdGVtcG9yYXJpbHk6IGFuCmV2aWN0ZWQgAAAAFXNldHRsZV9ldmljdGVkX2ZsaWdodAAAAAAAAAIAAAAAAAAACWZsaWdodF9pZAAAAAAAABEAAAAAAAAABGRhdGUAAAAGAAAAAA==",
        "AAAAAAAAAAAAAAAFcGF1c2UAAAAAAAABAAAAAAAAAAZjYWxsZXIAAAAAABMAAAAA",
        "AAAAAAAAAHFSZXR1cm5zIHRydWUgaWYgdGhlIGNvbnRyYWN0IGlzIHBhdXNlZCwgYW5kIGZhbHNlIG90aGVyd2lzZS4KCiMgQXJndW1lbnRzCgoqIGBlYCAtIEFjY2VzcyB0byBTb3JvYmFuIGVudmlyb25tZW50LgAAAAAAAAZwYXVzZWQAAAAAAAAAAAABAAAAAQ==",
        "AAAAAAAAAAAAAAAHdW5wYXVzZQAAAAABAAAAAAAAAAZjYWxsZXIAAAAAABMAAAAA",
        "AAAAAAAAAJBSZXR1cm5zIGBTb21lKEFkZHJlc3MpYCBpZiBvd25lcnNoaXAgaXMgc2V0LCBvciBgTm9uZWAgaWYgb3duZXJzaGlwIGhhcwpiZWVuIHJlbm91bmNlZC4KCiMgQXJndW1lbnRzCgoqIGBlYCAtIEFjY2VzcyB0byB0aGUgU29yb2JhbiBlbnZpcm9ubWVudC4AAAAJZ2V0X293bmVyAAAAAAAAAAAAAAEAAAPoAAAAEw==",
        "AAAAAAAAATBBY2NlcHRzIGEgcGVuZGluZyBvd25lcnNoaXAgdHJhbnNmZXIuCgojIEFyZ3VtZW50cwoKKiBgZWAgLSBBY2Nlc3MgdG8gdGhlIFNvcm9iYW4gZW52aXJvbm1lbnQuCgojIEVycm9ycwoKKiBbYGNyYXRlOjpyb2xlX3RyYW5zZmVyOjpSb2xlVHJhbnNmZXJFcnJvcjo6Tm9QZW5kaW5nVHJhbnNmZXJgXSAtIElmCnRoZXJlIGlzIG5vIHBlbmRpbmcgdHJhbnNmZXIgdG8gYWNjZXB0LgoKIyBFdmVudHMKCiogdG9waWNzIC0gYFsib3duZXJzaGlwX3RyYW5zZmVyX2NvbXBsZXRlZCJdYAoqIGRhdGEgLSBgW25ld19vd25lcjogQWRkcmVzc11gAAAAEGFjY2VwdF9vd25lcnNoaXAAAAAAAAAAAA==",
        "AAAAAAAAAYVSZW5vdW5jZXMgb3duZXJzaGlwIG9mIHRoZSBjb250cmFjdC4KClBlcm1hbmVudGx5IHJlbW92ZXMgdGhlIG93bmVyLCBkaXNhYmxpbmcgYWxsIGZ1bmN0aW9ucyBnYXRlZCBieQpgI1tvbmx5X293bmVyXWAuCgojIEFyZ3VtZW50cwoKKiBgZWAgLSBBY2Nlc3MgdG8gdGhlIFNvcm9iYW4gZW52aXJvbm1lbnQuCgojIEVycm9ycwoKKiBbYE93bmFibGVFcnJvcjo6VHJhbnNmZXJJblByb2dyZXNzYF0gLSBJZiB0aGVyZSBpcyBhIHBlbmRpbmcgb3duZXJzaGlwCnRyYW5zZmVyLgoqIFtgT3duYWJsZUVycm9yOjpPd25lck5vdFNldGBdIC0gSWYgdGhlIG93bmVyIGlzIG5vdCBzZXQuCgojIE5vdGVzCgoqIEF1dGhvcml6YXRpb24gZm9yIHRoZSBjdXJyZW50IG93bmVyIGlzIHJlcXVpcmVkLgAAAAAAABJyZW5vdW5jZV9vd25lcnNoaXAAAAAAAAAAAAAA",
        "AAAAAAAAA45Jbml0aWF0ZXMgYSAyLXN0ZXAgb3duZXJzaGlwIHRyYW5zZmVyIHRvIGEgbmV3IGFkZHJlc3MuCgpSZXF1aXJlcyBhdXRob3JpemF0aW9uIGZyb20gdGhlIGN1cnJlbnQgb3duZXIuIFRoZSBuZXcgb3duZXIgbXVzdCBsYXRlcgpjYWxsIGBhY2NlcHRfb3duZXJzaGlwKClgIHRvIGNvbXBsZXRlIHRoZSB0cmFuc2Zlci4KCiMgQXJndW1lbnRzCgoqIGBlYCAtIEFjY2VzcyB0byB0aGUgU29yb2JhbiBlbnZpcm9ubWVudC4KKiBgbmV3X293bmVyYCAtIFRoZSBwcm9wb3NlZCBuZXcgb3duZXIuCiogYGxpdmVfdW50aWxfbGVkZ2VyYCAtIExlZGdlciBudW1iZXIgdW50aWwgd2hpY2ggdGhlIG5ldyBvd25lciBjYW4KYWNjZXB0LiBBIHZhbHVlIG9mIGAwYCBjYW5jZWxzIGFueSBwZW5kaW5nIHRyYW5zZmVyLgoKIyBFcnJvcnMKCiogW2BPd25hYmxlRXJyb3I6Ok93bmVyTm90U2V0YF0gLSBJZiB0aGUgb3duZXIgaXMgbm90IHNldC4KKiBbYGNyYXRlOjpyb2xlX3RyYW5zZmVyOjpSb2xlVHJhbnNmZXJFcnJvcjo6Tm9QZW5kaW5nVHJhbnNmZXJgXSAtIElmCnRyeWluZyB0byBjYW5jZWwgYSB0cmFuc2ZlciB0aGF0IGRvZXNuJ3QgZXhpc3QuCiogW2BjcmF0ZTo6cm9sZV90cmFuc2Zlcjo6Um9sZVRyYW5zZmVyRXJyb3I6OkludmFsaWRMaXZlVW50aWxMZWRnZXJgXSAtCklmIHRoZSBzcGVjaWZpZWQgbGVkZ2VyIGlzIGluIHRoZSBwYXN0LgoqIFtgY3JhdGU6OnJvbGVfdHJhbnNmZXI6OlJvbGVUcmFuc2ZlckVycm9yOjpJbnZhbGlkUGVuZGluZ0FjY291bnRgXSAtCklmIHRoZSBzcGVjaWZpZWQgcGVuZGluZyBhY2NvdW50IGlzIG5vdCB0aGUgc2FtZSBhcyB0aGUgcHJvdmlkZWQgYG5ld2AKYWRkcmVzcy4KCiMgTm90ZXMKCiogQXV0aG9yaXphdGlvbiBmb3IgdGhlIGN1cnJlbnQgb3duZXIgaXMgcmVxdWlyZWQuAAAAAAASdHJhbnNmZXJfb3duZXJzaGlwAAAAAAACAAAAAAAAAAluZXdfb3duZXIAAAAAAAATAAAAAAAAABFsaXZlX3VudGlsX2xlZGdlcgAAAAAAAAQAAAAA",
        "AAAAAAAAASZSZXR1cm5zIGFnZ3JlZ2F0ZSBzdGF0czogdG90YWwgcG9saWNpZXMgc29sZCwgcHJlbWl1bXMgY29sbGVjdGVkLCBhbmQKcGF5b3V0cyBkaXN0cmlidXRlZC4gVGhlIHBheW91dHMgZmlndXJlIGlzIHRoZSBncm9zcyBjbGFpbWFibGUgdmFsdWUKb3BlbmVkIGJ5IGRlbGF5ZWQvY2FuY2VsbGVkIHNldHRsZW1lbnRzIChwYXlvZmYgw5cgYnV5ZXJfY291bnQpIOKAlCBpdAppbmNsdWRlcyB0aGUgcHJlbWl1bSBwb3J0aW9uIGFscmVhZHkgaGVsZCBieSB0aGUgcG9vbCwgbm90IGp1c3QgdGhlCnZhdWx0J3Mgb3V0Zmxvdy4AAAAAAAlnZXRfc3RhdHMAAAAAAAAAAAAAAQAAA+0AAAADAAAABgAAAAsAAAAL",
        "AAAAAAAAADBSZXR1cm5zIHRoZSBjdXJyZW50bHkgYXV0aG9yaXplZCBrZWVwZXIgYWRkcmVzcy4AAAAKZ2V0X2tlZXBlcgAAAAAAAAAAAAEAAAAT",
        "AAAAAAAAAH9XaGV0aGVyIGBhZGRyYCBpcyBvbiB0aGUgd2hpdGVsaXN0LiBSZXR1cm5zIGBmYWxzZWAgZm9yIGFueQphZGRyZXNzIHRoYXQgaGFzIG5ldmVyIGJlZW4gYWRkZWQgKG9yIGhhcyBiZWVuIHJlbW92ZWQgLyBhcmNoaXZlZCkuAAAAAA5pc193aGl0ZWxpc3RlZAAAAAAAAQAAAAAAAAAEYWRkcgAAABMAAAABAAAAAQ==",
        "AAAAAAAAADVXaGV0aGVyIHRoZSBidXllciB3aGl0ZWxpc3QgZ2F0ZSBpcyBjdXJyZW50bHkgYWN0aXZlLgAAAAAAABF3aGl0ZWxpc3RfZW5hYmxlZAAAAAAAAAAAAAABAAAAAQ==",
        "AAAAAAAAACxSZXR1cm5zIHRoZSBjb25maWd1cmVkIHZhdWx0IHNvbHZlbmN5IHJhdGlvLgAAABJnZXRfc29sdmVuY3lfcmF0aW8AAAAAAAAAAAABAAAABA==",
        "AAAAAAAAADpSZXR1cm5zIHRoZSBjb25maWd1cmVkIEZsaWdodFBvb2xNYW5hZ2VyIGNvbnRyYWN0IGFkZHJlc3MuAAAAAAAXZ2V0X2ZsaWdodF9wb29sX21hbmFnZXIAAAAAAAAAAAEAAAAT",
        "AAAAAAAAAL5QZXItdHJhdmVsZXIgaW5kZXgg4oCUIHJldHVybnMgZXZlcnkgYChmbGlnaHRfaWQsIGRhdGUpYCB0aGUgYWRkcmVzcyBoYXMKZXZlciBib3VnaHQgaW5zdXJhbmNlIGZvci4gQXBwZW5kLW9ubHk7IGZyb250ZW5kIGZpbHRlcnMgYnkgY3VycmVudApzdGF0dXMgKGxvb2tlZCB1cCBpbiBGbGlnaHRQb29sTWFuYWdlciAvIG9yYWNsZSkuAAAAAAAYZ2V0X2ZsaWdodHNfZm9yX3RyYXZlbGVyAAAAAQAAAAAAAAAHYWRkcmVzcwAAAAATAAAAAQAAA+oAAAPtAAAAAgAAABEAAAAG",
        "AAAAAAAAAG9Pd25lci1nYXRlZCBXYXNtIHVwZ3JhZGUuIERlbGVnYXRlcyB0byB0aGUgc2hhcmVkIGltcGxlbWVudGF0aW9uLCB3aGljaAphbHNvIGJ1bXBzIHRoZSBzdG9yZWQgb24tY2hhaW4gdmVyc2lvbi4AAAAAB3VwZ3JhZGUAAAAAAQAAAAAAAAAJd2FzbV9oYXNoAAAAAAAD7gAAACAAAAAA",
        "AAAAAAAAACJDdXJyZW50IG9uLWNoYWluIGNvbnRyYWN0IHZlcnNpb24uAAAAAAAHdmVyc2lvbgAAAAAAAAAAAQAAAAQ=",
        "AAAAAAAAAJxCdXlzIGZsaWdodC1kZWxheSBpbnN1cmFuY2UgZm9yIGEgdHJhdmVsZXI6IHZhbGlkYXRlcyB0aGUgcm91dGUgYW5kIHRpbWluZywgY2hlY2tzIHNvbHZlbmN5LCBjb2xsZWN0cyB0aGUgcHJlbWl1bSwgbG9ja3MgY29sbGF0ZXJhbCwgYW5kIHJlY29yZHMgdGhlIHBvbGljeS4AAAANYnV5X2luc3VyYW5jZQAAAAAAAAUAAAAAAAAACHRyYXZlbGVyAAAAEwAAAAAAAAAJZmxpZ2h0X2lkAAAAAAAAEQAAAAAAAAAGb3JpZ2luAAAAAAARAAAAAAAAAARkZXN0AAAAEQAAAAAAAAAEZGF0ZQAAAAYAAAAA",
        "AAAAAAAAA1JBZGQgYGFkZHJgIHRvIHRoZSBidXllciB3aGl0ZWxpc3QuIENhbGxhYmxlIGJ5IHRoZSBvd25lciBvciBhbnkgYWRkcmVzcwpmbGFnZ2VkIGFzIGFkbWluIG9uIGBHb3Zlcm5hbmNlTW9kdWxlYC4gSWRlbXBvdGVudCDigJQgcmUtYWRkaW5nIGFuCmV4aXN0aW5nIGVudHJ5IHJlZnJlc2hlcyBpdHMgVFRMIHdpdGhvdXQgcGFuaWMuIEludGVudGlvbmFsbHkgTk9UCmdhdGVkIGJ5IFBhdXNhYmxlIHNvIGFkbWlucyBjYW4ga2VlcCB0aGUgbGlzdCBjdXJyZW50IGR1cmluZyBhIHBhdXNlLgoKQXBwcm92YWwgbGlmZXRpbWUgbW9kZWwgKGRlbGliZXJhdGUpOiBhbiBhcHByb3ZhbCBpcyBhIHBlcnNpc3RlbnQKZW50cnkgd2l0aCBhIH4xODAtZGF5IFRUTCwgcmVmcmVzaGVkIG9uIGV2ZXJ5IHB1cmNoYXNlIHRoZSBidXllcgptYWtlcy4gQSBidXllciBET1JNQU5UIGZvciB0aGUgZnVsbCB3aW5kb3cgbGFwc2VzIHNpbGVudGx5IGFuZCBtdXN0IGJlCnJlLWFwcHJvdmVkIOKAlCB0aGUgYXJjaGl2ZWQgZW50cnkgcmVhZHMgYXMgbm90LXdoaXRlbGlzdGVkLCBhbmQgdGhlCnB1cmNoYXNlIGdhdGUgcmVqZWN0cyBiZWZvcmUgYW55IHNlbGYtcmVmcmVzaCBjb3VsZCBydW4uIFRoaXMgaXMKdHJlYXRlZCBhcyBwZXJpb2RpYyByZS1hdHRlc3RhdGlvbiBvZiBpbmFjdGl2ZSBhY2NvdW50cyByYXRoZXIgdGhhbiBhCmRlZmVjdDogaXQgZmFpbHMgY2xvc2VkLCBhbmQgcmVjb3ZlcnkgaXMgb25lIGFkbWluIGNhbGwuIE9mZi1jaGFpbgp0b29saW5nIGNhbiB3YXRjaCBgYnV5ZXJfd2hpdGVsaXN0ZWRgIGV2ZW50cyB0byByZS1leHRlbmQgb3IgYWxlcnQKYmVmb3JlIGRvcm1hbnQgYXBwcm92YWxzIGFnZSBvdXQuAAAAAAAVYWRkX3doaXRlbGlzdGVkX2J1eWVyAAAAAAAAAgAAAAAAAAAGY2FsbGVyAAAAAAATAAAAAAAAAARhZGRyAAAAEwAAAAA=",
        "AAAAAAAAALJPd25lci1vbmx5IGtpbGwtc3dpdGNoLiBXaGVuIGBmYWxzZWAgKGRlZmF1bHQpLCBgYnV5X2luc3VyYW5jZWAgaXMKb3BlbiB0byBhbnlvbmUuIFdoZW4gYHRydWVgLCBvbmx5IGFkZHJlc3NlcyB3aXRoIGEgYHRydWVgIGVudHJ5IGluCmBCdXllcldoaXRlbGlzdGVkYCBjYW4gY2FsbCBgYnV5X2luc3VyYW5jZWAuAAAAAAAVc2V0X3doaXRlbGlzdF9lbmFibGVkAAAAAAAAAQAAAAAAAAAHZW5hYmxlZAAAAAABAAAAAA==",
        "AAAAAAAAAUVSZW1vdmUgYGFkZHJgIGZyb20gdGhlIHdoaXRlbGlzdC4gU2FtZSBhdXRoIGFzIGBhZGRfd2hpdGVsaXN0ZWRfYnV5ZXJgLgpSZW1vdmluZyBhbiBhZGRyZXNzIHRoYXQgd2FzIG5ldmVyIHdoaXRlbGlzdGVkIGlzIGEgbm8tb3AgKHdyaXRlcwpgZmFsc2VgLCBlbWl0cyB0aGUgZXZlbnQpLiBUaGUgZW50cnkgaXMgb3ZlcndyaXR0ZW4gcmF0aGVyIHRoYW4KZGVsZXRlZCBzbyBhIHJlLWFkZCBsYXRlciBzdGlsbCByZWZyZXNoZXMgYSBrbm93biBrZXkg4oCUIGtlZXBzIHRoZQpQZXJzaXN0ZW50IGZvb3RwcmludCBzdGFibGUgZm9yIHRoZSBvZmYtY2hhaW4gVFRMIGNyb24uAAAAAAAAGHJlbW92ZV93aGl0ZWxpc3RlZF9idXllcgAAAAIAAAAAAAAABmNhbGxlcgAAAAAAEwAAAAAAAAAEYWRkcgAAABMAAAAA",
        "AAAAAgAAAAAAAAAAAAAADEZsaWdodFN0YXR1cwAAAAgAAAAAAAAAAAAAAAxOb3RJbml0aWF0ZWQAAAAAAAAAAAAAAAZBY3RpdmUAAAAAAAAAAAAAAAAABkxhbmRlZAAAAAAAAAAAAAAAAAAJQ2FuY2VsbGVkAAAAAAAAAAAAAAAAAAARVG9CZVNldHRsZWRPblRpbWUAAAAAAAAAAAAAAAAAABJUb0JlU2V0dGxlZERlbGF5ZWQAAAAAAAAAAAAAAAAAFFRvQmVTZXR0bGVkQ2FuY2VsbGVkAAAAAAAAAAAAAAAHU2V0dGxlZAA=",
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
        set_keeper: this.txFromJSON<null>,
        set_min_lead_time: this.txFromJSON<null>,
        set_solvency_ratio: this.txFromJSON<null>,
        set_claim_expiry_window: this.txFromJSON<null>,
        classify_flights: this.txFromJSON<null>,
        execute_settlements: this.txFromJSON<null>,
        run_queue_maintenance: this.txFromJSON<null>,
        settle_evicted_flight: this.txFromJSON<null>,
        pause: this.txFromJSON<null>,
        paused: this.txFromJSON<boolean>,
        unpause: this.txFromJSON<null>,
        get_owner: this.txFromJSON<Option<string>>,
        accept_ownership: this.txFromJSON<null>,
        renounce_ownership: this.txFromJSON<null>,
        transfer_ownership: this.txFromJSON<null>,
        get_stats: this.txFromJSON<readonly [u64, i128, i128]>,
        get_keeper: this.txFromJSON<string>,
        is_whitelisted: this.txFromJSON<boolean>,
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