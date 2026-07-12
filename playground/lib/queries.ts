// Curated typed reads used by the dashboard and account pages.
// All are free simulateTransaction calls — no wallet needed.

import { Address, nativeToScVal, xdr } from "@stellar/stellar-sdk";
import { CONTRACTS } from "@/lib/config";
import { variantName, variantPayload } from "@/lib/format";
import { simulateRead } from "@/lib/soroban";

const addr = (a: string) => Address.fromString(a).toScVal();
const sym = (s: string) => xdr.ScVal.scvSymbol(s);
const u64 = (n: bigint) => nativeToScVal(n, { type: "u64" });
const i128 = (n: bigint) => nativeToScVal(n, { type: "i128" });

export interface ProtocolStats {
  policiesSold: bigint;
  premiumsCollected: bigint;
  payoutsDistributed: bigint;
  solvencyRatio: number;
  whitelistEnabled: boolean;
  keeper: string;
  pendingOutcomes: bigint;
  pausedStates: { label: string; paused: boolean }[];
}

export async function fetchProtocolStats(): Promise<ProtocolStats> {
  const c = CONTRACTS;
  const [stats, ratio, whitelist, keeper, pending] = await Promise.all([
    simulateRead(c.controller.address, "get_stats") as Promise<[bigint, bigint, bigint]>,
    simulateRead(c.controller.address, "get_solvency_ratio") as Promise<number>,
    simulateRead(c.controller.address, "whitelist_enabled") as Promise<boolean>,
    simulateRead(c.controller.address, "get_keeper") as Promise<string>,
    simulateRead(c.oracle_aggregator.address, "get_pending_outcomes") as Promise<bigint>,
  ]);
  const paused = await Promise.all(
    (
      [
        ["Controller", c.controller.address],
        ["Risk Vault", c.risk_vault.address],
        ["Flight Pool", c.flight_pool_manager.address],
        ["Oracle", c.oracle_aggregator.address],
        ["Governance", c.governance_module.address],
      ] as const
    ).map(async ([label, address]) => ({
      label,
      paused: (await simulateRead(address, "paused")) as boolean,
    })),
  );
  return {
    policiesSold: BigInt(stats[0]),
    premiumsCollected: BigInt(stats[1]),
    payoutsDistributed: BigInt(stats[2]),
    solvencyRatio: Number(ratio),
    whitelistEnabled: whitelist,
    keeper,
    pendingOutcomes: BigInt(pending),
    pausedStates: paused,
  };
}

export interface VaultStats {
  totalManagedAssets: bigint;
  lockedCapital: bigint;
  freeCapital: bigint;
  totalShares: bigint;
  queueLength: number;
  minWithdrawalRequest: bigint;
  sharePriceAssetsPerShareUnit: bigint; // assets for 1.0 share (1e10 units)
}

export async function fetchVaultStats(): Promise<VaultStats> {
  const v = CONTRACTS.risk_vault.address;
  const oneShare = 10n ** 10n;
  const [tma, locked, free, supply, queueLen, minReq, oneShareAssets] =
    await Promise.all([
      simulateRead(v, "get_total_managed_assets") as Promise<bigint>,
      simulateRead(v, "get_locked_capital") as Promise<bigint>,
      simulateRead(v, "get_free_capital") as Promise<bigint>,
      simulateRead(v, "total_supply") as Promise<bigint>,
      simulateRead(v, "get_withdrawal_queue_len") as Promise<number>,
      simulateRead(v, "get_min_withdrawal_request") as Promise<bigint>,
      simulateRead(v, "convert_to_assets", [i128(oneShare)]) as Promise<bigint>,
    ]);
  return {
    totalManagedAssets: BigInt(tma),
    lockedCapital: BigInt(locked),
    freeCapital: BigInt(free),
    totalShares: BigInt(supply),
    queueLength: Number(queueLen),
    minWithdrawalRequest: BigInt(minReq),
    sharePriceAssetsPerShareUnit: BigInt(oneShareAssets),
  };
}

export interface FlightSummary {
  flightId: string;
  date: bigint;
}

export async function fetchActiveFlights(): Promise<FlightSummary[]> {
  const raw = (await simulateRead(
    CONTRACTS.oracle_aggregator.address,
    "get_active_flights",
  )) as [string, bigint][];
  return raw.map(([flightId, date]) => ({ flightId, date: BigInt(date) }));
}

export interface FlightDetail {
  status: string;
  estimatedArrivalTime: bigint;
  actualArrivalTime: bigint;
  settledAt: bigint;
  saleOpen: boolean;
  config: {
    premium: bigint;
    payoff: bigint;
    delayHours: number;
    buyerCount: number;
    claimedCount: number;
    status: string;
    claimExpiry: bigint;
  } | null;
}

export async function fetchFlightDetail(
  flightId: string,
  date: bigint,
): Promise<FlightDetail> {
  const [data, saleOpen, config] = await Promise.all([
    simulateRead(CONTRACTS.oracle_aggregator.address, "get_flight_data", [
      sym(flightId),
      u64(date),
    ]) as Promise<{
      status: unknown;
      estimated_arrival_time: bigint;
      actual_arrival_time: bigint;
      settled_at: bigint;
    }>,
    simulateRead(CONTRACTS.oracle_aggregator.address, "is_sale_open", [
      sym(flightId),
      u64(date),
    ]) as Promise<boolean>,
    simulateRead(CONTRACTS.flight_pool_manager.address, "get_flight_config", [
      sym(flightId),
      u64(date),
    ]) as Promise<{
      premium: bigint;
      payoff: bigint;
      delay_hours: number;
      buyer_count: number;
      claimed_count: number;
      status: unknown;
      claim_expiry: bigint;
    } | null>,
  ]);
  return {
    status: variantName(data.status),
    estimatedArrivalTime: BigInt(data.estimated_arrival_time),
    actualArrivalTime: BigInt(data.actual_arrival_time),
    settledAt: BigInt(data.settled_at),
    saleOpen,
    config: config
      ? {
          premium: BigInt(config.premium),
          payoff: BigInt(config.payoff),
          delayHours: Number(config.delay_hours),
          buyerCount: Number(config.buyer_count),
          claimedCount: Number(config.claimed_count),
          status: variantName(config.status),
          claimExpiry: BigInt(config.claim_expiry),
        }
      : null,
  };
}

export interface RouteInfo {
  status: "Active" | "Disabled" | "Unknown";
  terms: { premium: bigint; payoff: bigint; delayHours: number } | null;
}

export async function fetchRouteStatus(
  flightId: string,
  origin: string,
  dest: string,
): Promise<RouteInfo> {
  const raw = await simulateRead(CONTRACTS.governance_module.address, "route_status", [
    sym(flightId),
    sym(origin),
    sym(dest),
  ]);
  const name = variantName(raw) as RouteInfo["status"];
  const payload = variantPayload<{
    premium: bigint;
    payoff: bigint;
    delay_hours: number;
  }>(raw);
  return {
    status: name,
    terms: payload
      ? {
          premium: BigInt(payload.premium),
          payoff: BigInt(payload.payoff),
          delayHours: Number(payload.delay_hours),
        }
      : null,
  };
}

export async function fetchGovernanceDefaults(): Promise<{
  premium: bigint;
  payoff: bigint;
  delayHours: number;
}> {
  const [premium, payoff, delayHours] = (await simulateRead(
    CONTRACTS.governance_module.address,
    "get_defaults",
  )) as [bigint, bigint, number];
  return { premium: BigInt(premium), payoff: BigInt(payoff), delayHours: Number(delayHours) };
}

// ---------- account-scoped ----------

export async function fetchUsdcBalance(address: string): Promise<bigint> {
  return BigInt(
    (await simulateRead(CONTRACTS.mock_usdc.address, "balance", [addr(address)])) as bigint,
  );
}

export interface VaultPosition {
  shares: bigint;
  shareValueAssets: bigint;
  claimable: bigint;
  queued: { requestId: bigint; shares: bigint }[];
}

export async function fetchVaultPosition(address: string): Promise<VaultPosition> {
  const v = CONTRACTS.risk_vault.address;
  const shares = BigInt(
    (await simulateRead(v, "balance", [addr(address)])) as bigint,
  );
  const [value, claimable, queue] = await Promise.all([
    shares > 0n
      ? (simulateRead(v, "convert_to_assets", [i128(shares)]) as Promise<bigint>)
      : Promise.resolve(0n),
    simulateRead(v, "get_claimable_balance", [addr(address)]) as Promise<bigint>,
    simulateRead(v, "get_withdrawal_queue") as Promise<
      { request_id: bigint; owner: string; shares: bigint }[]
    >,
  ]);
  return {
    shares,
    shareValueAssets: BigInt(value),
    claimable: BigInt(claimable),
    queued: queue
      .filter((q) => q.owner === address)
      .map((q) => ({ requestId: BigInt(q.request_id), shares: BigInt(q.shares) })),
  };
}

export interface PolicyRow {
  flightId: string;
  date: bigint;
  detail: FlightDetail;
  hasClaimed: boolean;
}

export async function fetchMyPolicies(address: string): Promise<PolicyRow[]> {
  const flights = (await simulateRead(
    CONTRACTS.controller.address,
    "get_flights_for_traveler",
    [addr(address)],
  )) as [string, bigint][];

  return Promise.all(
    flights.map(async ([flightId, date]) => {
      const d = BigInt(date);
      const [detail, hasClaimed] = await Promise.all([
        fetchFlightDetail(flightId, d),
        simulateRead(CONTRACTS.flight_pool_manager.address, "has_claimed", [
          sym(flightId),
          u64(d),
          addr(address),
        ]) as Promise<boolean>,
      ]);
      return { flightId, date: d, detail, hasClaimed };
    }),
  );
}
