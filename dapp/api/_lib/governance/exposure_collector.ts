import { SorobanClient } from "../soroban_client";
import { ingestChainEvents } from "./event_ingest";
import { loadRoutesConfig } from "../routes_config";
import { parseFlightStatus } from "../status";
import { FlightStatus, type Config, type RunLogEntry, type FetcherAction } from "../types";
import type { GovConfig } from "./config";
import {
  computeDisableCap,
  pauseRoute,
  type GovChainConfig,
  type InterventionRoute,
} from "./interventions";

/**
 * gov_exposure — the correlated-risk brake (hourly).
 *
 * Correlated risk is the protocol's main tail: if one storm delays every
 * flight through a hub, the vault pays Σ payoffs at once. This job
 * measures how concentrated the vault's outstanding liability is — per
 * route and per airport — and, since the 2026-08-01 unification, ACTS on
 * it directly through the interventions executor (the signals table +
 * reconciler middleman are gone):
 *
 *   ≥ SEVERE (50% of vault capacity promised to one route/airport)
 *     → open an `exposure` intervention on every affected route: sales
 *       pause, existing policies settle normally. The hourly revive cron
 *       lifts the pause once concentration stays eased for 2 consecutive
 *       checks (settlements free capacity naturally).
 *   ≥ ELEVATED (25%) → advisory only: a run-log note for the admin board.
 *
 * Zero AeroAPI dependency: exposure is read from AUTHORITATIVE on-chain
 * state —
 *   per active flight:  liability = payoff × buyer_count   (FlightPoolManager)
 *   total capacity:     total_managed_assets               (RiskVault)
 * mapped flight_id → origin/dest via the routes file. An on-chain read
 * failure takes NO action (a transient RPC blip must not mask or fake
 * real exposure). The executor enforces the shared guardrails: pins win,
 * `gov_frozen` freezes, and new on-chain disables are capped per run at
 * max(3, 20% of the fleet) — a storm can slow the fleet, only a human
 * can stop it. GOV_DRY_RUN logs decisions and touches nothing.
 *
 * Piggybacked side task (unchanged): before measuring, Controller events
 * (policies/settlements) are ingested into the durable DB mirror —
 * Stellar RPC only retains ~7 days of events.
 */

const ACTOR = "cron:gov_exposure";

// Concentration thresholds as a fraction of total managed assets. Defaults
// are conservative; override via env for tuning.
const ELEVATED_PCT = Number(process.env.EXPOSURE_ELEVATED_PCT ?? 0.25); // 25%
const SEVERE_PCT = Number(process.env.EXPOSURE_SEVERE_PCT ?? 0.5); // 50%

export interface FlightExposure {
  flightId: string;
  origin: string;
  dest: string;
  /** payoff × buyer_count, in asset base units. */
  liabilityUnits: bigint;
}

export interface ExposureSignalSpec {
  severity: "elevated" | "severe";
  scope_kind: "route" | "origin" | "dest";
  flightId?: string;
  origin?: string;
  dest?: string;
  payload: {
    liability_units: string;
    total_managed_units: string;
    fraction: number;
    kind: "route" | "airport";
  };
}

/** Per-route and per-airport liability fractions of vault capacity. */
export interface Concentrations {
  /** key: `${flightId}|${origin}|${dest}` */
  routes: Map<string, { origin: string; dest: string; fraction: number }>;
  /** key: IATA airport */
  airports: Map<string, number>;
}

/** PURE: aggregate per-flight liabilities into concentration fractions. */
export function computeConcentrations(
  flights: FlightExposure[],
  totalManagedUnits: bigint
): Concentrations {
  const routes = new Map<string, { origin: string; dest: string; units: bigint }>();
  const airports = new Map<string, bigint>();
  for (const f of flights) {
    const rkey = `${f.flightId}|${f.origin}|${f.dest}`;
    const r = routes.get(rkey) ?? { origin: f.origin, dest: f.dest, units: 0n };
    r.units += f.liabilityUnits;
    routes.set(rkey, r);
    airports.set(f.origin, (airports.get(f.origin) ?? 0n) + f.liabilityUnits);
    airports.set(f.dest, (airports.get(f.dest) ?? 0n) + f.liabilityUnits);
  }
  const fraction = (units: bigint): number =>
    totalManagedUnits <= 0n ? 0 : Number((units * 1_000_000n) / totalManagedUnits) / 1_000_000;
  return {
    routes: new Map(
      [...routes].map(([k, r]) => [k, { origin: r.origin, dest: r.dest, fraction: fraction(r.units) }])
    ),
    airports: new Map([...airports].map(([k, u]) => [k, fraction(u)])),
  };
}

/**
 * PURE projection: per-flight liabilities + total capacity → threshold
 * crossings (route + airport scopes). Exported for tests and kept as the
 * single place the elevated/severe cutoffs are applied.
 */
export function computeExposureSignals(
  flights: FlightExposure[],
  totalManagedUnits: bigint,
  opts: { elevatedPct?: number; severePct?: number } = {}
): ExposureSignalSpec[] {
  const elevatedPct = opts.elevatedPct ?? ELEVATED_PCT;
  const severePct = opts.severePct ?? SEVERE_PCT;
  // No capacity → no meaningful fraction (avoid div-by-zero; a zero-TMA
  // vault sells nothing anyway).
  if (totalManagedUnits <= 0n) return [];

  const conc = computeConcentrations(flights, totalManagedUnits);
  const severityFor = (frac: number): "elevated" | "severe" | null =>
    frac >= severePct ? "severe" : frac >= elevatedPct ? "elevated" : null;

  const specs: ExposureSignalSpec[] = [];
  const total = totalManagedUnits.toString();

  for (const [rkey, r] of conc.routes) {
    const sev = severityFor(r.fraction);
    if (!sev) continue;
    specs.push({
      severity: sev,
      scope_kind: "route",
      flightId: rkey.split("|")[0],
      origin: r.origin,
      dest: r.dest,
      payload: {
        liability_units: "", // fractions are the decision input now
        total_managed_units: total,
        fraction: r.fraction,
        kind: "route",
      },
    });
  }
  for (const [airport, frac] of conc.airports) {
    const sev = severityFor(frac);
    if (!sev) continue;
    // Airport exposure emits both scope directions (kept for spec parity).
    for (const scope_kind of ["origin", "dest"] as const) {
      specs.push({
        severity: sev,
        scope_kind,
        origin: scope_kind === "origin" ? airport : undefined,
        dest: scope_kind === "dest" ? airport : undefined,
        payload: {
          liability_units: "",
          total_managed_units: total,
          fraction: frac,
          kind: "airport",
        },
      });
    }
  }
  return specs;
}

/** Read live per-flight liabilities from the pool + the vault's capacity. */
export async function readExposure(
  client: SorobanClient,
  config: Pick<Config, "flightPoolManagerId" | "riskVaultId">
): Promise<{ flights: FlightExposure[]; totalManaged: bigint }> {
  const routesConfig = loadRoutesConfig();
  const routeByFlight = new Map(
    routesConfig.routes.map((r) => [r.flight_id, { origin: r.origin, dest: r.destination }])
  );

  const totalManaged = BigInt(
    (await client.readContract(config.riskVaultId, "get_total_managed_assets")) ?? 0
  );

  const active =
    (await client.readContract(config.flightPoolManagerId, "get_active_flights")) ?? [];

  const flights: FlightExposure[] = [];
  for (const [flightId, date] of active as [string, bigint][]) {
    const route = routeByFlight.get(flightId);
    if (!route) continue; // unknown to the routes file — can't scope it
    const cfg = await client.readContract(config.flightPoolManagerId, "get_flight_config", [
      client.symbolToScVal(flightId),
      client.u64ToScVal(date),
    ]);
    if (!cfg) continue;
    // Only unsettled policies carry live liability.
    const status = parseFlightStatus(cfg.status);
    if (status !== FlightStatus.Active && status !== FlightStatus.NotInitiated) continue;
    const payoff = BigInt(cfg.payoff ?? 0);
    const buyers = BigInt(cfg.buyer_count ?? 0);
    if (buyers === 0n) continue;
    flights.push({
      flightId,
      origin: route.origin,
      dest: route.dest,
      liabilityUnits: payoff * buyers,
    });
  }
  return { flights, totalManaged };
}

/** Shared env-defaulted contract ids (GovConfig carries only governance). */
export function exposureContractIds(): { poolId: string; vaultId: string; controllerId: string } {
  return {
    poolId: process.env.FLIGHT_POOL_MANAGER_ID ?? "CAA7DVZKQEA7JENAMI7DEKPGAWJQMPY6MKDED2DG2ZCK2G535X5V2PI7",
    vaultId: process.env.RISK_VAULT_ID ?? "CCJLBWEOPNUHIUNOGZMUDQ6EGO563SA3WSEX2NENEDCTJDZOKN3LLDKF",
    controllerId: process.env.CONTROLLER_ID ?? "CBDJIPZOC7KH3ICK57MAUZMUXBQ5XF56WJLRP2OY6FF5V2HOFDOFXVY3",
  };
}

export function exposureReadClient(config: GovConfig): SorobanClient {
  return new SorobanClient({
    stellarRpcUrl: config.stellarRpcUrl,
    networkPassphrase: config.networkPassphrase,
    // readContract signs its simulation source with oracleSecretKey; the
    // gov-admin key serves as the read source here (reads are free, no
    // oracle authority involved).
    oracleSecretKey: config.govAdminSecretKey,
  } as Config);
}

/** Optional dependency injection seam — tests pass a fake read client, production omits. */
export interface ExposureDeps {
  client?: SorobanClient;
}

export async function run(config: GovConfig, deps: ExposureDeps = {}): Promise<RunLogEntry> {
  const start = Date.now();
  const actions: FetcherAction[] = [];
  const done = (success: boolean, error?: string): RunLogEntry => ({
    timestamp: new Date().toISOString(),
    job: "gov_exposure",
    duration_ms: Date.now() - start,
    success,
    ...(error ? { error } : {}),
    actions,
  });

  try {
    const { poolId, vaultId, controllerId } = exposureContractIds();
    const client = deps.client ?? exposureReadClient(config);

    // Chain-event mirror first (policies + settlements — the durable
    // copies the sweeper and analytics need beyond RPC's ~7-day
    // retention). Never blocks the exposure check; skipped in dry-run.
    if (!config.dryRun) {
      try {
        const ingested = await ingestChainEvents(config.stellarRpcUrl, controllerId);
        if (ingested.policies + ingested.settlements > 0) {
          actions.push({
            flight: "-",
            transition: `ingested ${ingested.policies} policy / ${ingested.settlements} settlement event(s)`,
          });
        }
        console.log(
          `[gov-exposure] event mirror: +${ingested.policies} policies, +${ingested.settlements} settlements ` +
            `(ledgers ${ingested.fromLedger}..${ingested.toLedger})`
        );
      } catch (err) {
        console.warn(`[gov-exposure] event ingest failed (exposure check continues): ${err}`);
      }
    }

    let flights: FlightExposure[];
    let totalManaged: bigint;
    try {
      ({ flights, totalManaged } = await readExposure(client, {
        flightPoolManagerId: poolId,
        riskVaultId: vaultId,
      }));
    } catch (err) {
      console.error(`[gov-exposure] on-chain read failed — no actions this run: ${err}`);
      return done(false, `on-chain read failed: ${err}`);
    }

    const specs = computeExposureSignals(flights, totalManaged);
    const severe = specs.filter((s) => s.severity === "severe");
    const elevated = specs.filter((s) => s.severity === "elevated");
    console.log(
      `[gov-exposure] ${flights.length} liability row(s), TMA=${totalManaged} → ` +
        `${severe.length} severe, ${elevated.length} elevated.`
    );

    // Elevated = advisory only: visible on the JOBS board via the run log.
    for (const s of elevated) {
      const scope = s.scope_kind === "route" ? s.flightId! : (s.origin ?? s.dest)!;
      actions.push({ flight: `${scope}/${s.payload.kind}`, skipped: `elevated exposure ${(s.payload.fraction * 100).toFixed(1)}% (advisory)` });
    }

    if (severe.length === 0) return done(true);

    // ── Severe → pause every affected route through the executor ──────
    const routesConfig = loadRoutesConfig();
    const enabled = routesConfig.routes.filter((r) => r.enabled);
    const affected = new Map<string, { route: InterventionRoute; why: string; fraction: number }>();
    for (const s of severe) {
      if (s.scope_kind === "route") {
        const key = `${s.flightId}|${s.origin}|${s.dest}`;
        affected.set(key, {
          route: { flight_id: s.flightId!, origin: s.origin!, destination: s.dest! },
          why: `route concentration ${(s.payload.fraction * 100).toFixed(1)}%`,
          fraction: s.payload.fraction,
        });
      } else {
        const airport = (s.origin ?? s.dest)!;
        for (const r of enabled) {
          if (r.origin !== airport && r.destination !== airport) continue;
          const key = `${r.flight_id}|${r.origin}|${r.destination}`;
          if (affected.has(key)) continue;
          affected.set(key, {
            route: { flight_id: r.flight_id, origin: r.origin, destination: r.destination },
            why: `${airport} airport concentration ${(s.payload.fraction * 100).toFixed(1)}%`,
            fraction: s.payload.fraction,
          });
        }
      }
    }

    const chainConfig: GovChainConfig = {
      stellarRpcUrl: config.stellarRpcUrl,
      networkPassphrase: config.networkPassphrase,
      governanceId: config.governanceId,
      governanceAdminSecretKey: config.govAdminSecretKey,
    };
    const cap = computeDisableCap(enabled.length);
    let disables = 0;
    for (const { route, why, fraction } of affected.values()) {
      const label = `${route.flight_id} ${route.origin}→${route.destination}`;
      if (config.dryRun) {
        actions.push({ flight: label, skipped: `[dry-run] would pause (${why})` });
        continue;
      }
      if (disables >= cap) {
        console.warn(`[gov-exposure] CIRCUIT BREAKER: disable cap ${cap} reached — flagging ${label}.`);
        actions.push({ flight: label, skipped: `circuit breaker: would pause (${why}) — cap ${cap} reached` });
        continue;
      }
      try {
        const result = await pauseRoute(chainConfig, route, "exposure", { why, fraction }, ACTOR);
        if (result.disabledOnChain) disables++;
        actions.push({ flight: label, transition: result.outcome });
      } catch (err) {
        console.error(`[gov-exposure] ${label}: pause failed — ${err}. Next run retries.`);
        actions.push({ flight: label, error: String(err) });
      }
    }

    return done(true);
  } catch (err) {
    console.error(`[gov-exposure] Fatal error: ${err}`);
    return done(false, String(err));
  }
}
