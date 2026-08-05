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

const SIM_SOURCE = "GCEODBNVUGJVYQKWY7NMU4U3EIYQOXA7LADMQOPNB5PBBKMYCQJ7E6KD"; // owner (public)

type ScArg = xdr.ScVal;
const sym = (s: string): ScArg => nativeToScVal(s, { type: "symbol" });
const u64 = (n: bigint | number): ScArg => nativeToScVal(BigInt(n), { type: "u64" });
const addr = (a: string): ScArg => nativeToScVal(a, { type: "address" });

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

  // ── events (persisted-cursor pull across all protocol contracts) ──────
  async eventsSince(
    cursor: string | undefined,
  ): Promise<{ events: ChainEvent[]; cursor: string | undefined }> {
    const contractIds = Object.values(this.cfg.contracts);
    const latest = await this.server.getLatestLedger();
    const req: rpc.Server.GetEventsRequest = cursor
      ? ({ filters: [{ type: "contract", contractIds }], cursor, limit: 200 } as never)
      : {
          filters: [{ type: "contract", contractIds }],
          startLedger: Math.max(1, latest.sequence - 100),
          limit: 200,
        };
    const events: ChainEvent[] = [];
    let page = await this.server.getEvents(req);
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
        filters: [{ type: "contract", contractIds }],
        cursor: page.cursor,
        limit: 200,
      } as never);
    }
    return { events, cursor: page.cursor ?? cursor };
  }
}
