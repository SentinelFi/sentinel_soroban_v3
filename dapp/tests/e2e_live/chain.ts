/**
 * Read-only chain access — ground truth for every money assertion.
 *
 * Deliberately NOT api/_lib/soroban_client.ts: that client requires the
 * full secret-bearing Config, and this harness holds no protocol keys.
 * Simulation only needs an EXISTING source account, so reads simulate
 * from the contract owner's public address (no signature involved).
 */
import {
  Contract,
  TransactionBuilder,
  nativeToScVal,
  scValToNative,
  rpc,
  xdr,
} from "@stellar/stellar-sdk";
import type { LiveConfig } from "./config.js";
import { bigintSafe } from "./journal.js";

const SIM_SOURCE = "GCEODBNVUGJVYQKWY7NMU4U3EIYQOXA7LADMQOPNB5PBBKMYCQJ7E6KD"; // owner (public)

type ScArg = xdr.ScVal;
const sym = (s: string): ScArg => nativeToScVal(s, { type: "symbol" });
const u64 = (n: bigint | number): ScArg => nativeToScVal(BigInt(n), { type: "u64" });
const addr = (a: string): ScArg => nativeToScVal(a, { type: "address" });

/**
 * Flatten an unknown throw into something a journal reader can act on.
 * `String(err)` on a JSON-RPC rejection yields "[object Object]" and destroys
 * the only copy of the reason — pull message/code/response out explicitly.
 */
export function describeError(err: unknown): string {
  if (err instanceof Error) {
    const e = err as Error & { code?: unknown; response?: { data?: unknown } };
    const extra = [
      e.code !== undefined ? `code=${JSON.stringify(e.code, bigintSafe)}` : "",
      e.response?.data ? `response=${JSON.stringify(e.response.data, bigintSafe).slice(0, 300)}` : "",
    ].filter(Boolean).join(" ");
    return extra ? `${e.message} (${extra})` : e.message;
  }
  if (err && typeof err === "object") {
    try {
      return JSON.stringify(err, bigintSafe).slice(0, 400);
    } catch {
      /* circular — fall through */
    }
  }
  return String(err);
}

const chunk = <T>(xs: T[], size: number): T[][] =>
  Array.from({ length: Math.ceil(xs.length / size) }, (_, i) => xs.slice(i * size, i * size + size));

/**
 * Enum TAG out of whatever shape `scValToNative` produced for a contract enum.
 *
 * Soroban unit-variant enums come back as a one-element ARRAY (`["Settled"]`),
 * while payload variants render as `[tag, value]` or `{tag, values}`. Reading
 * `.tag` alone silently yields `undefined` on the array form — the failure
 * mode that made the N1 negative-claim check dead for a whole soak run: every
 * flight compared `"" !== "Settled"` and was skipped. Centralised here so a
 * call site cannot get it half-right.
 */
export function enumTag(v: unknown): string {
  if (typeof v === "string") return v;
  if (Array.isArray(v)) return String(v[0]);
  if (v && typeof v === "object") {
    const tagged = v as { tag?: unknown };
    if (typeof tagged.tag === "string") return tagged.tag;
    const keys = Object.keys(v as Record<string, unknown>);
    if (keys.length === 1) return keys[0]!;
  }
  return String(v);
}

export interface ChainEvent {
  id: string;
  ledger: number;
  contractId: string;
  topics: unknown[];
  value: unknown;
  txHash: string;
  ledgerClosedAt: string;
}

export class Chain {
  private server: rpc.Server;
  private cfg: LiveConfig;

  constructor(cfg: LiveConfig) {
    this.cfg = cfg;
    this.server = new rpc.Server(cfg.rpcUrl);
  }

  async read(contractId: string, method: string, args: ScArg[] = []): Promise<any> {
    const source = await this.server.getAccount(SIM_SOURCE);
    const tx = new TransactionBuilder(source, {
      fee: "100",
      networkPassphrase: this.cfg.networkPassphrase,
    })
      .addOperation(new Contract(contractId).call(method, ...args))
      .setTimeout(60)
      .build();
    const sim = await this.server.simulateTransaction(tx);
    if (rpc.Api.isSimulationError(sim)) throw new Error(`${method}: ${sim.error}`);
    if (!rpc.Api.isSimulationSuccess(sim) || !sim.result) return undefined;
    return scValToNative(sim.result.retval);
  }

  async health(): Promise<string> {
    return (await this.server.getHealth()).status;
  }

  // ── money ──────────────────────────────────────────────────────────────
  usdcBalance(address: string): Promise<bigint> {
    return this.read(this.cfg.contracts.mockUsdc, "balance", [addr(address)]);
  }
  shareBalance(address: string): Promise<bigint> {
    return this.read(this.cfg.contracts.riskVault, "balance", [addr(address)]);
  }

  // ── vault ──────────────────────────────────────────────────────────────
  totalManagedAssets(): Promise<bigint> {
    return this.read(this.cfg.contracts.riskVault, "get_total_managed_assets");
  }
  freeCapital(): Promise<bigint> {
    return this.read(this.cfg.contracts.riskVault, "get_free_capital");
  }
  lockedCapital(): Promise<bigint> {
    return this.read(this.cfg.contracts.riskVault, "get_locked_capital");
  }
  withdrawalQueue(): Promise<unknown[]> {
    return this.read(this.cfg.contracts.riskVault, "get_withdrawal_queue");
  }
  depositQueue(): Promise<unknown[]> {
    return this.read(this.cfg.contracts.riskVault, "get_deposit_queue");
  }
  snapshotPrice(day: bigint): Promise<bigint> {
    return this.read(this.cfg.contracts.riskVault, "get_snapshot_price", [u64(day)]);
  }
  claimableBalance(address: string): Promise<bigint> {
    return this.read(this.cfg.contracts.riskVault, "get_claimable_balance", [addr(address)]);
  }

  // ── controller / policies ──────────────────────────────────────────────
  /** (flights_insured, insurances_paid_count, total_paid_out) */
  getStats(): Promise<[bigint, bigint, bigint]> {
    return this.read(this.cfg.contracts.controller, "get_stats");
  }
  whitelistEnabled(): Promise<boolean> {
    return this.read(this.cfg.contracts.controller, "whitelist_enabled");
  }
  flightsForTraveler(address: string): Promise<Array<[string, bigint]>> {
    return this.read(this.cfg.contracts.controller, "get_flights_for_traveler", [addr(address)]);
  }
  hasPolicy(flightId: string, date: bigint, traveler: string): Promise<boolean> {
    return this.read(this.cfg.contracts.flightPoolManager, "has_policy", [
      sym(flightId),
      u64(date),
      addr(traveler),
    ]);
  }
  hasClaimed(flightId: string, date: bigint, traveler: string): Promise<boolean> {
    return this.read(this.cfg.contracts.flightPoolManager, "has_claimed", [
      sym(flightId),
      u64(date),
      addr(traveler),
    ]);
  }
  flightConfig(flightId: string, date: bigint): Promise<Record<string, unknown> | undefined> {
    return this.read(this.cfg.contracts.flightPoolManager, "get_flight_config", [
      sym(flightId),
      u64(date),
    ]);
  }

  // ── oracle ─────────────────────────────────────────────────────────────
  flightData(flightId: string, date: bigint): Promise<Record<string, unknown>> {
    return this.read(this.cfg.contracts.oracle, "get_flight_data", [sym(flightId), u64(date)]);
  }
  hasPendingOutcomes(): Promise<boolean> {
    return this.read(this.cfg.contracts.oracle, "has_pending_outcomes");
  }
  activeFlights(offset = 0, limit = 100): Promise<Array<[string, bigint]>> {
    return this.read(this.cfg.contracts.oracle, "get_active_flights_page", [
      nativeToScVal(offset, { type: "u32" }),
      nativeToScVal(limit, { type: "u32" }),
    ]);
  }

  // ── governance ─────────────────────────────────────────────────────────
  /**
   * The route's RESOLVED premium in whole USDC, straight from the chain —
   * base plus whatever weather surcharge the governance layer has written.
   *
   * The staged `route_whitelist.json` carries the BASE only, so asserting a
   * paid amount against the file reports a false mismatch the moment a
   * storm surcharges a route. This is the number the buyer actually pays.
   * Returns null when the route is not Active or the shape is unreadable —
   * callers fall back to the staged figure rather than failing the check.
   */
  async routePremiumUsdc(flightId: string, origin: string, dest: string): Promise<number | null> {
    const v = await this.read(this.cfg.contracts.governance, "route_status", [
      sym(flightId),
      sym(origin),
      sym(dest),
    ]).catch(() => null);
    // Active(ResolvedTerms) renders as ["Active", {...}] or {tag, values}.
    const payload = Array.isArray(v)
      ? v[1]
      : (v as { values?: unknown[] } | null)?.values?.[0];
    const premium = (payload as { premium?: unknown } | undefined)?.premium;
    if (premium === undefined || premium === null) return null;
    const units = typeof premium === "bigint" ? premium : BigInt(String(premium));
    return Number(units / 10_000_000n);
  }

  /** Returns the enum TAG only ("Active" | "Disabled" | "Unknown") —
   *  scValToNative renders payload enums as [tag, value] / {tag} shapes. */
  async routeStatus(flightId: string, origin: string, dest: string): Promise<string> {
    const v = await this.read(this.cfg.contracts.governance, "route_status", [
      sym(flightId),
      sym(origin),
      sym(dest),
    ]);
    return enumTag(v);
  }

  /**
   * Settlement tag off the pool's FlightConfig ("SettledOnTime" |
   * "SettledDelayed" | "SettledCancelled" | "Active" | ...), or "" if the
   * entry is unreadable. This — NOT a `payable` boolean — is how the pool
   * expresses payability; FlightConfig has no such field, so the old
   * `Boolean(cfg.payable)` read was always false and could not tell an
   * on-time flight from a paying one.
   */
  async flightSettlementTag(flightId: string, date: bigint): Promise<string> {
    const cfg = await this.flightConfig(flightId, date).catch(() => undefined);
    if (!cfg) return "";
    return enumTag((cfg as { status?: unknown }).status);
  }

  /** True when a settled flight owes a payout (delayed past threshold, or cancelled). */
  async isPayable(flightId: string, date: bigint): Promise<boolean> {
    const tag = await this.flightSettlementTag(flightId, date);
    return tag.startsWith("Settled") && tag !== "SettledOnTime";
  }

  // ── events (persisted-cursor pull across all protocol contracts) ──────
  async eventsSince(
    cursor: string | undefined,
  ): Promise<{ events: ChainEvent[]; cursor: string | undefined }> {
    // Soroban RPC rejects any filter carrying more than 5 contract IDs
    // ("maximum 5 contract IDs per filter"). The protocol has 6 contracts, so
    // a single filter failed EVERY pull — silently, because the caller logged
    // `String(err)` on a structured JSON-RPC error object ("[object Object]").
    // Multiple filters in one request are allowed and share one cursor, so
    // chunking keeps the single-query, single-cursor shape intact.
    const filters = chunk(Object.values(this.cfg.contracts), 5).map((ids) => ({
      type: "contract" as const,
      contractIds: ids,
    }));
    const latest = await this.server.getLatestLedger();
    const fromWindow = (): rpc.Server.GetEventsRequest => ({
      filters,
      startLedger: Math.max(1, latest.sequence - 100),
      limit: 200,
    });
    const events: ChainEvent[] = [];
    // A cursor can be rejected transiently, or permanently once its ledger ages
    // out of RPC retention. Either way, losing the pull entirely is worse than
    // resuming from the recent-ledger window, so fall back instead of throwing.
    let page: Awaited<ReturnType<typeof this.server.getEvents>>;
    if (cursor) {
      try {
        page = await this.server.getEvents({ filters, cursor, limit: 200 } as never);
      } catch {
        page = await this.server.getEvents(fromWindow());
      }
    } else {
      page = await this.server.getEvents(fromWindow());
    }
    for (;;) {
      for (const e of page.events) {
        events.push({
          id: e.id,
          ledger: e.ledger,
          contractId: e.contractId?.contractId() ?? "",
          topics: e.topic.map((t) => {
            try {
              return scValToNative(t);
            } catch {
              return t.toXDR("base64");
            }
          }),
          value: (() => {
            try {
              return scValToNative(e.value);
            } catch {
              return e.value.toXDR("base64");
            }
          })(),
          txHash: e.txHash,
          ledgerClosedAt: e.ledgerClosedAt,
        });
      }
      if (page.events.length < 200) break;
      page = await this.server.getEvents({
        filters,
        cursor: page.cursor,
        limit: 200,
      } as never);
    }
    return { events, cursor: page.cursor ?? cursor };
  }
}
