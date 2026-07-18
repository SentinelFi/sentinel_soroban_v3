// ── Run log types ──────────────────────────────────────────────────
// Ported from executor/centralized_cron/src/types.ts — keep shapes in
// sync so ops tooling can read either executor's output.

export interface FetcherAction {
  flight: string;
  transition?: string;
  skipped?: string;
  error?: string;
}

export interface TTLResult {
  contract: string;
  success: boolean;
  error?: string;
}

// audit M-03 split queue maintenance out of settlement; queue_maintainer
// is a Phase 3 addition not present in the phase-2 executor.
export type JobName =
  | "fetcher"
  | "classifier"
  | "settler"
  | "queue_maintainer"
  | "ttl_extender";

export interface RunLogEntry {
  timestamp: string;
  job: JobName;
  duration_ms: number;
  success: boolean;
  error?: string | null;
  active_flights?: number;
  actions?: FetcherAction[];
  tx_hash?: string;
  results?: TTLResult[];
}

// ── On-chain types ─────────────────────────────────────────────────

// Mirrors the on-chain FlightStatus enum from OracleAggregator.
// Variant order is LOAD-BEARING — scValToNative on a #[contracttype] enum
// can return the variant as an index, and the order below must match the
// contract's `enum FlightStatus` declaration in sentinel_types/src/lib.rs.
//
// Note: the dapp tsconfig enforces `erasableSyntaxOnly`, so this is a
// const object + union type rather than the TS `enum` the executor uses.
// Values are identical strings; comparisons behave the same.
export const FlightStatus = {
  NotInitiated: "NotInitiated",
  Active: "Active",
  Landed: "Landed",
  Cancelled: "Cancelled",
  ToBeSettledOnTime: "ToBeSettledOnTime",
  ToBeSettledDelayed: "ToBeSettledDelayed",
  ToBeSettledCancelled: "ToBeSettledCancelled",
  Settled: "Settled",
} as const;

export type FlightStatus = (typeof FlightStatus)[keyof typeof FlightStatus];

export interface FlightData {
  status: FlightStatus;
  estimated_arrival_time: bigint;
  actual_arrival_time: bigint;
  // Phase 6 widened FlightData with settled_at. Fetcher doesn't read it,
  // but mirroring it here keeps the type honest for any future consumer.
  settled_at: bigint;
}

export interface ActiveFlight {
  flight_id: string;
  date: bigint;
}

export interface Config {
  stellarRpcUrl: string;
  networkPassphrase: string;
  // Contract IDs (Phase 3 set — recovery_pool replaced by flight_pool_manager).
  oracleAggregatorId: string;
  controllerId: string;
  riskVaultId: string;
  governanceId: string;
  flightPoolManagerId: string;
  // Keypairs.
  oracleSecretKey: string;
  keeperSecretKey: string;
  ttlExtenderSecretKey: string;
  // AeroAPI.
  aeroApiBaseUrl: string;
  aeroApiKey: string;
}
