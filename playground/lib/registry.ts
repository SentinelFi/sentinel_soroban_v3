// Curated registry of every public entrypoint on the six deployed Sentinel
// contracts. Drives the generic "Interact" UI: forms are rendered from the
// arg specs, and auth badges tell the user who can successfully call what.
//
// Sources: the Sentinel contract crates (contracts/*/src) and
// deployments/testnet.json. Types mirror the on-chain ABI exactly.

import type { ArgType } from "@/lib/scval";
import { CONTRACTS, type ContractKey } from "@/lib/config";

export type AuthKind =
  | "public" // no authorization required
  | "wallet" // signed by the calling user's wallet
  | "owner" // protocol owner only
  | "admin" // owner or governance route-admin
  | "oracle" // authorized oracle executor only
  | "keeper" // authorized keeper executor only
  | "controller"; // cross-contract: only the Controller contract can call

export interface ArgSpec {
  name: string;
  type: ArgType;
  help?: string;
  /** Prefill with the connected wallet address. */
  autofillWallet?: boolean;
}

export interface FunctionSpec {
  name: string;
  summary: string;
  auth: AuthKind;
  readonly: boolean;
  args: ArgSpec[];
  returns?: string;
}

export interface ContractEntry {
  key: ContractKey;
  label: string;
  address: string;
  description: string;
  functions: FunctionSpec[];
}

const FLIGHT_STATUS = {
  enum: [
    "NotInitiated",
    "Active",
    "Landed",
    "Cancelled",
    "ToBeSettledOnTime",
    "ToBeSettledDelayed",
    "ToBeSettledCancelled",
    "Settled",
  ],
} as const;

// Recurring args
const a = (name: string, type: ArgType, help?: string, autofillWallet?: boolean): ArgSpec => ({
  name,
  type,
  help,
  autofillWallet,
});
const FLIGHT_ID = a("flight_id", "symbol", "Flight identifier, e.g. AA100");
const DATE = a("date", "date", "Flight date (midnight UTC)");
const ORIGIN = a("origin", "symbol", "Origin airport code, e.g. JFK");
const DEST = a("dest", "symbol", "Destination airport code, e.g. LAX");
const WASM_HASH = a("wasm_hash", "bytes32", "New wasm hash (64 hex chars)");

const fn = (
  name: string,
  auth: AuthKind,
  readonly: boolean,
  summary: string,
  args: ArgSpec[] = [],
  returns?: string,
): FunctionSpec => ({ name, auth, readonly, summary, args, returns });

const sharedOwnable: FunctionSpec[] = [
  fn("get_owner", "public", true, "Current protocol owner address", [], "Option<Address>"),
  fn("version", "public", true, "On-chain contract version", [], "u32"),
];

const pausable: FunctionSpec[] = [
  fn("paused", "public", true, "Whether the contract is paused", [], "bool"),
  fn("pause", "owner", false, "Pause the contract", [
    a("caller", "address", "Ignored — auth is enforced against the stored owner", true),
  ]),
  fn("unpause", "owner", false, "Unpause the contract", [
    a("caller", "address", "Ignored — auth is enforced against the stored owner", true),
  ]),
];

const upgrade: FunctionSpec = fn("upgrade", "owner", false, "Upgrade the contract wasm", [WASM_HASH]);

export const REGISTRY: ContractEntry[] = [
  {
    key: "controller",
    ...CONTRACTS.controller,
    functions: [
      fn(
        "buy_insurance",
        "wallet",
        false,
        "Buy flight-delay insurance: pulls the premium from you, locks the payoff in the vault, records your policy",
        [
          a("traveler", "address", "You — must match the connected wallet", true),
          FLIGHT_ID,
          ORIGIN,
          DEST,
          DATE,
        ],
      ),
      fn("get_flights_for_traveler", "public", true, "All (flight, date) policies ever bought by an address", [
        a("address", "address", undefined, true),
      ], "Vec<(Symbol, u64)>"),
      fn("get_stats", "public", true, "Protocol totals", [], "(policies_sold, premiums_collected, payouts_distributed)"),
      fn("get_keeper", "public", true, "Authorized keeper executor", [], "Address"),
      fn("get_solvency_ratio", "public", true, "Solvency ratio in percent", [], "u32"),
      fn("get_flight_pool_manager", "public", true, "Wired Flight Pool Manager address", [], "Address"),
      fn("whitelist_enabled", "public", true, "Whether the buyer whitelist gate is active", [], "bool"),
      fn("is_whitelisted", "public", true, "Whether an address is on the buyer whitelist", [
        a("addr", "address", undefined, true),
      ], "bool"),
      fn("classify_flights", "keeper", false, "Batch-classify landed/cancelled/timed-out flights for settlement", [
        a("keeper", "address"),
      ]),
      fn("execute_settlements", "keeper", false, "Batch-execute pending settlements (moves funds pool ↔ vault)", [
        a("keeper", "address"),
      ]),
      fn("run_queue_maintenance", "keeper", false, "Drain the vault withdrawal queue and snapshot the share price", [
        a("keeper", "address"),
      ]),
      fn("settle_evicted_flight", "owner", false, "Terminal reconciliation for an owner-evicted flight", [FLIGHT_ID, DATE]),
      fn("set_keeper", "owner", false, "Rotate the keeper executor", [a("keeper", "address")]),
      fn("set_solvency_ratio", "owner", false, "Tune the solvency ratio (percent)", [a("ratio", "u32")]),
      fn("set_min_lead_time", "owner", false, "Minimum purchase → departure lead time", [a("seconds", "u64")]),
      fn("set_claim_expiry_window", "owner", false, "Post-settlement claim window length", [a("seconds", "u64")]),
      fn("add_whitelisted_buyer", "admin", false, "Add an address to the buyer whitelist", [
        a("caller", "address", "Owner or governance admin", true),
        a("addr", "address"),
      ]),
      fn("remove_whitelisted_buyer", "admin", false, "Remove an address from the buyer whitelist", [
        a("caller", "address", "Owner or governance admin", true),
        a("addr", "address"),
      ]),
      fn("set_whitelist_enabled", "owner", false, "Toggle the whitelist purchase gate", [a("enabled", "bool")]),
      fn("extend_ttl", "public", false, "Extend the contract instance TTL (anyone may call)"),
      ...pausable,
      upgrade,
      ...sharedOwnable,
    ],
  },
  {
    key: "risk_vault",
    ...CONTRACTS.risk_vault,
    functions: [
      fn("deposit", "wallet", false, "Deposit USDC, mint RVS shares to the receiver", [
        a("assets", "amount7", "USDC amount"),
        a("receiver", "address", undefined, true),
        a("from", "address", "Account the USDC is pulled from", true),
        a("operator", "address", "Signer — usually the same as from", true),
      ], "i128 shares minted"),
      fn("mint", "wallet", false, "Mint an exact number of shares, pulling the required USDC", [
        a("shares", "amount10", "RVS shares"),
        a("receiver", "address", undefined, true),
        a("from", "address", undefined, true),
        a("operator", "address", undefined, true),
      ], "i128 assets pulled"),
      fn("withdraw", "wallet", false, "Immediate withdrawal (only when the queue is empty and capital is free)", [
        a("assets", "amount7", "USDC amount"),
        a("receiver", "address", undefined, true),
        a("owner", "address", "Share owner", true),
        a("operator", "address", undefined, true),
      ], "i128 shares burned"),
      fn("redeem", "wallet", false, "Immediate redemption of shares (same gating as withdraw)", [
        a("shares", "amount10"),
        a("receiver", "address", undefined, true),
        a("owner", "address", undefined, true),
        a("operator", "address", undefined, true),
      ], "i128 assets returned"),
      fn("request_withdrawal", "wallet", false, "Queue a withdrawal: escrows shares FIFO, returns a request id", [
        a("caller", "address", undefined, true),
        a("shares", "amount10"),
      ], "u64 request_id"),
      fn("cancel_withdrawal", "wallet", false, "Cancel a queued withdrawal request and get the shares back", [
        a("caller", "address", undefined, true),
        a("request_id", "u64"),
      ]),
      fn("collect", "wallet", false, "Collect your processed (claimable) withdrawal balance", [
        a("caller", "address", undefined, true),
      ]),
      fn("get_total_managed_assets", "public", true, "Net backing assets (TMA)", [], "i128"),
      fn("get_locked_capital", "public", true, "Collateral locked against live policies", [], "i128"),
      fn("get_free_capital", "public", true, "TMA minus locked collateral", [], "i128"),
      fn("get_withdrawal_queue", "public", true, "Full pending withdrawal queue", [], "Vec<WithdrawalRequest>"),
      fn("get_withdrawal_queue_len", "public", true, "Number of queued withdrawal requests", [], "u32"),
      fn("get_min_withdrawal_request", "public", true, "Minimum asset value per queued request", [], "i128"),
      fn("get_claimable_balance", "public", true, "Processed withdrawal balance awaiting collect()", [
        a("address", "address", undefined, true),
      ], "i128"),
      fn("get_snapshot_price", "public", true, "Recorded share price for a day (unix seconds, midnight UTC)", [
        a("day", "date"),
      ], "i128"),
      fn("get_controller", "public", true, "Wired controller", [], "Address"),
      fn("get_oracle", "public", true, "Settlement-barrier oracle", [], "Option<Address>"),
      fn("total_assets", "public", true, "Vault-standard total assets view", [], "i128"),
      fn("query_asset", "public", true, "Underlying asset token address", [], "Address"),
      fn("convert_to_shares", "public", true, "Assets → shares at the current price", [a("assets", "amount7")], "i128"),
      fn("convert_to_assets", "public", true, "Shares → assets at the current price", [a("shares", "amount10")], "i128"),
      fn("preview_deposit", "public", true, "Shares you would get for a deposit", [a("assets", "amount7")], "i128"),
      fn("preview_mint", "public", true, "Assets required to mint shares", [a("shares", "amount10")], "i128"),
      fn("preview_withdraw", "public", true, "Shares burned for an immediate withdrawal", [a("assets", "amount7")], "i128"),
      fn("preview_redeem", "public", true, "Assets returned for an immediate redemption", [a("shares", "amount10")], "i128"),
      fn("max_deposit", "public", true, "Max deposit currently allowed (0 while paused/blocked)", [
        a("address", "address", undefined, true),
      ], "i128"),
      fn("max_withdraw", "public", true, "Max immediate withdrawal for an owner", [
        a("owner", "address", undefined, true),
      ], "i128"),
      fn("max_redeem", "public", true, "Max immediate redemption for an owner", [
        a("owner", "address", undefined, true),
      ], "i128"),
      fn("balance", "public", true, "RVS share balance of an account", [
        a("account", "address", undefined, true),
      ], "i128"),
      fn("total_supply", "public", true, "Total RVS share supply", [], "i128"),
      fn("allowance", "public", true, "Share allowance owner → spender", [
        a("owner", "address", undefined, true),
        a("spender", "address"),
      ], "i128"),
      fn("transfer", "wallet", false, "Transfer RVS shares", [
        a("from", "address", undefined, true),
        a("to", "address"),
        a("amount", "amount10"),
      ]),
      fn("approve", "wallet", false, "Approve a spender for RVS shares", [
        a("owner", "address", undefined, true),
        a("spender", "address"),
        a("amount", "amount10"),
        a("live_until_ledger", "u32", "Ledger number the allowance expires at"),
      ]),
      fn("name", "public", true, "Share token name", [], "String"),
      fn("symbol", "public", true, "Share token symbol", [], "String"),
      fn("decimals", "public", true, "Share token decimals (10)", [], "u32"),
      fn("snapshot", "public", false, "Record today's share price snapshot (anyone may call)"),
      fn("increase_locked", "controller", false, "Lock collateral against a new policy", [
        a("controller", "address"),
        a("amount", "amount7"),
      ]),
      fn("decrease_locked", "controller", false, "Release locked collateral at settlement", [
        a("controller", "address"),
        a("amount", "amount7"),
      ]),
      fn("record_premium_income", "controller", false, "Credit forwarded premiums into TMA", [
        a("controller", "address"),
        a("amount", "amount7"),
      ]),
      fn("send_payout", "controller", false, "Pay a claim out of TMA", [
        a("controller", "address"),
        a("to", "address"),
        a("amount", "amount7"),
      ]),
      fn("process_withdrawal_queue", "controller", false, "Batch-drain the FIFO withdrawal queue", [
        a("controller", "address"),
      ]),
      fn("set_controller", "owner", false, "Wire the controller (one-time)", [a("controller", "address")]),
      fn("set_oracle", "owner", false, "Rotate the settlement-barrier oracle", [a("oracle", "address")]),
      fn("set_min_withdrawal_request", "owner", false, "Minimum asset value per queued request (0 disables)", [
        a("min_assets", "amount7"),
      ]),
      fn("recover_uncollected", "owner", false, "Recover an archived claimable balance", [
        a("user", "address"),
        a("amount", "amount7"),
        a("mode", { variant: [{ name: "Recredit" }, { name: "Transfer" }] }),
      ]),
      fn("extend_ttl", "public", false, "Extend the contract instance TTL (anyone may call)"),
      ...pausable,
      upgrade,
      ...sharedOwnable,
    ],
  },
  {
    key: "flight_pool_manager",
    ...CONTRACTS.flight_pool_manager,
    functions: [
      fn("claim", "wallet", false, "Collect your payoff for a settled delayed/cancelled flight (once, before expiry)", [
        a("traveler", "address", "You — must match the connected wallet", true),
        FLIGHT_ID,
        DATE,
      ]),
      fn("get_flight_config", "public", true, "Per-flight terms, buyer/claimed counts, status, claim expiry", [
        FLIGHT_ID,
        DATE,
      ], "Option<FlightConfig>"),
      fn("has_policy", "public", true, "Whether a traveler holds a policy on a flight", [
        FLIGHT_ID,
        DATE,
        a("traveler", "address", undefined, true),
      ], "bool"),
      fn("has_claimed", "public", true, "Whether a traveler already claimed on a flight", [
        FLIGHT_ID,
        DATE,
        a("traveler", "address", undefined, true),
      ], "bool"),
      fn("get_active_flights", "public", true, "Unsettled flights tracked by the pool", [], "Vec<(Symbol, u64)>"),
      fn("get_active_flight_count", "public", true, "Number of unsettled flights", [], "u32"),
      fn("get_recovered_balance", "public", true, "Swept unclaimed funds recoverable by the owner", [], "i128"),
      fn("get_controller", "public", true, "Wired controller", [], "Option<Address>"),
      fn("get_asset_token", "public", true, "Premium/payout asset token", [], "Address"),
      fn("get_risk_vault", "public", true, "Wired risk vault", [], "Address"),
      fn("sweep_expired", "public", false, "Sweep unclaimed funds after a claim window closes (anyone may call)", [
        FLIGHT_ID,
        DATE,
      ]),
      fn("register_flight", "controller", false, "Register a flight on first purchase", [
        a("controller", "address"),
        FLIGHT_ID,
        DATE,
        a("premium", "amount7"),
        a("payoff", "amount7"),
        a("delay_hours", "u32"),
      ]),
      fn("add_buyer", "controller", false, "Record a policy holder", [
        a("controller", "address"),
        FLIGHT_ID,
        DATE,
        a("buyer", "address"),
      ]),
      fn("settle_on_time", "controller", false, "Settle on-time: premiums forwarded to the vault", [
        a("controller", "address"),
        FLIGHT_ID,
        DATE,
      ], "i128 premium forwarded"),
      fn("settle_delayed", "controller", false, "Settle delayed: opens the claim window", [
        a("controller", "address"),
        FLIGHT_ID,
        DATE,
        a("claim_expiry", "timestamp"),
      ]),
      fn("settle_cancelled", "controller", false, "Settle cancelled: opens the claim window", [
        a("controller", "address"),
        FLIGHT_ID,
        DATE,
        a("claim_expiry", "timestamp"),
      ]),
      fn("set_controller", "owner", false, "Wire the controller (one-time)", [a("controller", "address")]),
      fn("withdraw_recovered", "owner", false, "Owner withdraws swept unclaimed funds", [a("amount", "amount7")]),
      fn("extend_ttl", "public", false, "Extend the contract instance TTL (anyone may call)"),
      ...pausable,
      upgrade,
      ...sharedOwnable,
    ],
  },
  {
    key: "oracle_aggregator",
    ...CONTRACTS.oracle_aggregator,
    functions: [
      fn("get_flight_data", "public", true, "Flight status record (NotInitiated + zeros if missing)", [
        FLIGHT_ID,
        DATE,
      ], "FlightData"),
      fn("get_active_flights", "public", true, "All flights on the active list", [], "Vec<(Symbol, u64)>"),
      fn("get_active_flight_count", "public", true, "Active-list occupancy", [], "u32"),
      fn("get_flights_by_status", "public", true, "Active flights filtered by status", [
        a("status", FLIGHT_STATUS),
      ], "Vec<(Symbol, u64)>"),
      fn("has_flight_data", "public", true, "Whether a flight record exists", [FLIGHT_ID, DATE], "bool"),
      fn("is_sale_open", "public", true, "Whether a live sale authorization exists (purchase gate)", [
        FLIGHT_ID,
        DATE,
      ], "bool"),
      fn("get_sale_auth", "public", true, "Sale-authorization expiry timestamp", [FLIGHT_ID, DATE], "Option<u64>"),
      fn("get_pending_outcomes", "public", true, "Flights with a public outcome not yet settled", [], "u64"),
      fn("has_pending_outcomes", "public", true, "Vault settlement barrier flag", [], "bool"),
      fn("get_authorized_oracle", "public", true, "Oracle executor address", [], "Address"),
      fn("get_authorized_controller", "public", true, "Wired controller", [], "Option<Address>"),
      fn("prune_settled", "public", false, "Evict aged-out settled flights from the active list (anyone may call)"),
      fn("open_sale", "oracle", false, "Open/refresh the sale window for a flight", [
        a("oracle", "address"),
        FLIGHT_ID,
        DATE,
        a("expires_at", "timestamp"),
      ]),
      fn("close_sale", "oracle", false, "Close a sale window early", [a("oracle", "address"), FLIGHT_ID, DATE]),
      fn("set_estimated_arrival", "oracle", false, "Record the scheduled arrival (NotInitiated → Active)", [
        a("oracle", "address"),
        FLIGHT_ID,
        DATE,
        a("estimated_arrival_time", "timestamp"),
      ]),
      fn("set_landed", "oracle", false, "Record actual arrival (Active → Landed)", [
        a("oracle", "address"),
        FLIGHT_ID,
        DATE,
        a("actual_arrival_time", "timestamp"),
      ]),
      fn("set_cancelled", "oracle", false, "Mark a flight cancelled", [a("oracle", "address"), FLIGHT_ID, DATE]),
      fn("register_flight", "controller", false, "Register a flight (idempotent)", [
        a("controller", "address"),
        FLIGHT_ID,
        DATE,
      ]),
      fn("set_to_be_settled", "controller", false, "Classify a flight for settlement", [
        a("controller", "address"),
        FLIGHT_ID,
        DATE,
        a("status", FLIGHT_STATUS),
      ]),
      fn("set_settled", "controller", false, "Mark a flight settled", [a("controller", "address"), FLIGHT_ID, DATE]),
      fn("set_controller", "owner", false, "Wire the controller (one-time)", [a("controller", "address")]),
      fn("set_oracle", "owner", false, "Rotate the oracle executor", [a("new_oracle", "address")]),
      fn("evict_missing_flight", "owner", false, "Evict an archived flight from the active list", [
        FLIGHT_ID,
        DATE,
        a("outcome_pending", "bool"),
      ]),
      fn("extend_ttl", "public", false, "Extend the contract instance TTL (anyone may call)"),
      ...pausable,
      upgrade,
      ...sharedOwnable,
    ],
  },
  {
    key: "governance_module",
    ...CONTRACTS.governance_module,
    functions: [
      fn("route_status", "public", true, "Route status with fully-resolved terms", [
        FLIGHT_ID,
        ORIGIN,
        DEST,
      ], "Active(ResolvedTerms) | Disabled | Unknown"),
      fn("get_defaults", "public", true, "Global default terms", [], "(premium, payoff, delay_hours)"),
      fn("is_admin", "public", true, "Whether an address has route-admin rights", [
        a("addr", "address", undefined, true),
      ], "bool"),
      fn("whitelist_route", "admin", false, "Create an insurable route (empty optional fields = use defaults)", [
        a("caller", "address", "Owner or route admin", true),
        FLIGHT_ID,
        ORIGIN,
        DEST,
        a("premium", { option: "amount7" }, "Optional per-route premium override"),
        a("payoff", { option: "amount7" }, "Optional per-route payoff override"),
        a("delay_hours", { option: "u32" }, "Optional per-route delay threshold override"),
      ]),
      fn("disable_route", "admin", false, "Disable a route (stops purchases)", [
        a("caller", "address", undefined, true),
        FLIGHT_ID,
        ORIGIN,
        DEST,
      ]),
      fn("enable_route", "admin", false, "Re-enable a disabled route", [
        a("caller", "address", undefined, true),
        FLIGHT_ID,
        ORIGIN,
        DEST,
      ]),
      fn("remove_route", "admin", false, "Hard-delete a route (must be disabled first)", [
        a("caller", "address", undefined, true),
        FLIGHT_ID,
        ORIGIN,
        DEST,
      ]),
      fn("update_route_terms", "admin", false, "Per-field keep / set / revert-to-default", [
        a("caller", "address", undefined, true),
        FLIGHT_ID,
        ORIGIN,
        DEST,
        a("premium", {
          variant: [{ name: "Keep" }, { name: "Set", payload: "amount7" }, { name: "UseDefault" }],
        }),
        a("payoff", {
          variant: [{ name: "Keep" }, { name: "Set", payload: "amount7" }, { name: "UseDefault" }],
        }),
        a("delay_hours", {
          variant: [{ name: "Keep" }, { name: "Set", payload: "u32" }, { name: "UseDefault" }],
        }),
      ]),
      fn("set_defaults", "owner", false, "Update global fallback terms", [
        a("premium", "amount7"),
        a("payoff", "amount7"),
        a("delay_hours", "u32"),
      ]),
      fn("add_admin", "owner", false, "Grant route-admin rights", [a("admin", "address")]),
      fn("remove_admin", "owner", false, "Revoke route-admin rights", [a("admin", "address")]),
      fn("extend_ttl", "public", false, "Extend the contract instance TTL (anyone may call)"),
      ...pausable,
      upgrade,
      ...sharedOwnable,
    ],
  },
  {
    key: "mock_usdc",
    ...CONTRACTS.mock_usdc,
    functions: [
      fn("faucet", "public", false, "Mint 10,000 test USDC to any address (permissionless)", [
        a("to", "address", undefined, true),
      ]),
      fn("mint", "public", false, "Mint an arbitrary amount of test USDC (permissionless on testnet)", [
        a("to", "address", undefined, true),
        a("amount", "amount7"),
      ]),
      fn("balance", "public", true, "USDC balance of an account", [
        a("account", "address", undefined, true),
      ], "i128"),
      fn("total_supply", "public", true, "Total USDC supply", [], "i128"),
      fn("allowance", "public", true, "Allowance owner → spender", [
        a("owner", "address", undefined, true),
        a("spender", "address"),
      ], "i128"),
      fn("transfer", "wallet", false, "Transfer USDC", [
        a("from", "address", undefined, true),
        a("to", "address"),
        a("amount", "amount7"),
      ]),
      fn("approve", "wallet", false, "Approve a spender", [
        a("owner", "address", undefined, true),
        a("spender", "address"),
        a("amount", "amount7"),
        a("live_until_ledger", "u32", "Ledger number the allowance expires at"),
      ]),
      fn("transfer_from", "wallet", false, "Transfer using an allowance", [
        a("spender", "address", undefined, true),
        a("from", "address"),
        a("to", "address"),
        a("amount", "amount7"),
      ]),
      fn("burn", "wallet", false, "Burn your USDC", [
        a("from", "address", undefined, true),
        a("amount", "amount7"),
      ]),
      fn("name", "public", true, "Token name", [], "String"),
      fn("symbol", "public", true, "Token symbol", [], "String"),
      fn("decimals", "public", true, "Token decimals (7)", [], "u32"),
      upgrade,
      ...sharedOwnable,
    ],
  },
];

export const AUTH_LABEL: Record<AuthKind, string> = {
  public: "Public",
  wallet: "Your wallet",
  owner: "Owner only",
  admin: "Owner / admin",
  oracle: "Oracle only",
  keeper: "Keeper only",
  controller: "Controller contract only",
};

export const AUTH_HINT: Record<AuthKind, string | null> = {
  public: null,
  wallet: "Signed with your connected wallet.",
  owner: "Only the protocol owner account can execute this.",
  admin: "Only the owner or a governance admin can execute this.",
  oracle: "Only the authorized oracle executor can execute this.",
  keeper: "Only the authorized keeper executor can execute this.",
  controller:
    "Cross-contract entrypoint — only the Controller contract itself can call this; a direct call will fail.",
};
