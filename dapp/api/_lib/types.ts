// ── Run log types ──────────────────────────────────────────────────
// Ported from the legacy centralized_cron executor (removed 2026-07-19;
// shapes preserved so historical run logs stay readable).

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
// 2026-07-31 demand-driven rework: sale authorization moved from a cron
// (sale_authorizer) to the JIT /api/sale-auth/request endpoint; the
// AeroAPI signal collectors (gov_signals, gov_schedule_check) retired
// with it. "fetcher" is now the settle sweep (name kept for run-log
// continuity); "revive" re-checks guard-paused routes daily.
export type JobName =
  | "fetcher"
  | "classifier"
  | "settler"
  | "queue_maintainer"
  | "ttl_extender"
  | "weather"
  | "reprice"
  | "revive"
  // Governance module (exposure signals + reconciler) — Phase 2+.
  | "gov_reconcile"
  | "gov_exposure"
  | "gov_onboard";

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
  // Governance agent key (4th identity) — a GovernanceModule ADMIN, never
  // the owner. Only the route guard's pause path and the whitelist script
  // need it, so it is optional here (guard degrades to log-only without it).
  governanceAdminSecretKey?: string;
  // AeroAPI.
  aeroApiBaseUrl: string;
  aeroApiKey: string;
  // Settle cron timing: how long after a flight's scheduled arrival the
  // settle sweep makes its first (usually only) AeroAPI call. Before that
  // moment an insured flight costs ZERO API calls.
  settleAfterEtaSecs: number;
  // JIT sale authorization. Horizon defaults come from
  // config/routes.testnet.json; env overrides win.
  saleAuthHorizonDays: number;
  saleAuthValiditySecs: number;
  // Purchase cutoff: no sale window ever authorizes a buy closer than
  // this to the scheduled departure (product rule: 24h).
  saleMinLeadSecs: number;
  // ML pricing agent (Render-hosted FastAPI). Optional — route_agent falls
  // back to the routes-file terms when unset or unreachable.
  agentBaseUrl?: string;
  agentToken?: string;
  // Weather (Open-Meteo, keyless).
  weatherBaseUrl: string;
}
