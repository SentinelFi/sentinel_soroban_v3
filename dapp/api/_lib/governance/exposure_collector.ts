import { SorobanClient } from "../soroban_client";
import { ingestChainEvents } from "./event_ingest";
import { loadRoutesConfig } from "../routes_config";
import { parseFlightStatus } from "../status";
import { FlightStatus, type Config, type RunLogEntry, type FetcherAction } from "../types";
import type { GovConfig } from "./config";
import { getDb } from "./db";
import type { SignalRow } from "./model";

/**
 * gov_exposure — correlated-risk exposure collector (hourly, before the
 * reconciler alongside gov_signals).
 *
 * Correlated risk is the protocol's main tail: if one storm delays every
 * flight through a hub, the vault pays Σ payoffs at once. This job measures
 * how concentrated the vault's outstanding liability is — per route and per
 * airport — and projects `exposure` signals when a concentration crosses a
 * threshold, so the reconciler can slow accumulation (elevated → premium
 * multiplier) or stop it (severe → pause new sales on that scope).
 *
 * Zero AeroAPI dependency: exposure is read from AUTHORITATIVE on-chain
 * state, not reconstructed from an events mirror —
 *   per active flight:  liability = payoff × buyer_count   (FlightPoolManager)
 *   total capacity:     total_managed_assets               (RiskVault)
 * mapped flight_id → origin/dest via the routes file. (A durable per-policy
 * `policies` mirror from InsuranceBought events is a separate, later piece;
 * the exposure SIGNAL doesn't need it.)
 *
 * Signals are FACTS — this job never touches the chain. Same source-owned
 * lifecycle as gov_signals (refresh / severity-change / clear / 6h
 * self-expiry), and an on-chain read failure takes NO action (a transient
 * RPC blip must not clear real exposure pauses). GOV_DRY_RUN logs only.
 */

export const SIGNAL_SOURCE = "onchain:exposure";
const EXPIRY_SECS = 6 * 3600;

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

/**
 * PURE projection: per-flight liabilities + total capacity → exposure
 * signal specs. Aggregates by route (single flight_id) and by airport
 * (origin + dest). Exported for tests.
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

  const byRoute = new Map<string, { origin: string; dest: string; units: bigint }>();
  const byAirport = new Map<string, bigint>();

  for (const f of flights) {
    const rkey = `${f.flightId}|${f.origin}|${f.dest}`;
    const r = byRoute.get(rkey) ?? { origin: f.origin, dest: f.dest, units: 0n };
    r.units += f.liabilityUnits;
    byRoute.set(rkey, r);
    byAirport.set(f.origin, (byAirport.get(f.origin) ?? 0n) + f.liabilityUnits);
    byAirport.set(f.dest, (byAirport.get(f.dest) ?? 0n) + f.liabilityUnits);
  }

  const fraction = (units: bigint): number =>
    Number((units * 1_000_000n) / totalManagedUnits) / 1_000_000;
  const severityFor = (frac: number): "elevated" | "severe" | null =>
    frac >= severePct ? "severe" : frac >= elevatedPct ? "elevated" : null;

  const specs: ExposureSignalSpec[] = [];

  for (const [rkey, r] of byRoute) {
    const frac = fraction(r.units);
    const sev = severityFor(frac);
    if (!sev) continue;
    const flightId = rkey.split("|")[0];
    specs.push({
      severity: sev,
      scope_kind: "route",
      flightId,
      origin: r.origin,
      dest: r.dest,
      payload: {
        liability_units: r.units.toString(),
        total_managed_units: totalManagedUnits.toString(),
        fraction: frac,
        kind: "route",
      },
    });
  }

  for (const [airport, units] of byAirport) {
    const frac = fraction(units);
    const sev = severityFor(frac);
    if (!sev) continue;
    // Airport exposure emits both scope directions so the reconciler's
    // origin- and dest-scoped matching both fire.
    for (const scope_kind of ["origin", "dest"] as const) {
      specs.push({
        severity: sev,
        scope_kind,
        origin: scope_kind === "origin" ? airport : undefined,
        dest: scope_kind === "dest" ? airport : undefined,
        payload: {
          liability_units: units.toString(),
          total_managed_units: totalManagedUnits.toString(),
          fraction: frac,
          kind: "airport",
        },
      });
    }
  }

  return specs;
}

/** Read live per-flight liabilities from the pool + the vault's capacity. */
async function readExposure(
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

export async function run(config: GovConfig): Promise<RunLogEntry> {
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
    // GovConfig carries no pool/vault ids — read them from the shared env
    // (same defaults as _lib/config.ts).
    const poolId = process.env.FLIGHT_POOL_MANAGER_ID ?? "CAA7DVZKQEA7JENAMI7DEKPGAWJQMPY6MKDED2DG2ZCK2G535X5V2PI7";
    const vaultId = process.env.RISK_VAULT_ID ?? "CCJLBWEOPNUHIUNOGZMUDQ6EGO563SA3WSEX2NENEDCTJDZOKN3LLDKF";
    const client = new SorobanClient({
      stellarRpcUrl: config.stellarRpcUrl,
      networkPassphrase: config.networkPassphrase,
      // readContract signs its simulation source with oracleSecretKey; the
      // gov-admin key serves as the read source here (reads are free, no
      // oracle authority involved).
      oracleSecretKey: config.govAdminSecretKey,
    } as Config);

    // Chain-event mirror first (policies + settlements — the durable
    // copies the sweeper and analytics need beyond RPC's ~7-day
    // retention). Never blocks the exposure signals; skipped in dry-run.
    if (!config.dryRun) {
      try {
        const controllerId =
          process.env.CONTROLLER_ID ?? "CBDJIPZOC7KH3ICK57MAUZMUXBQ5XF56WJLRP2OY6FF5V2HOFDOFXVY3";
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
        console.warn(`[gov-exposure] event ingest failed (signals continue): ${err}`);
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
      console.error(`[gov-exposure] on-chain read failed — no signal changes this run: ${err}`);
      return done(false, `on-chain read failed: ${err}`);
    }

    const desired = computeExposureSignals(flights, totalManaged);
    console.log(
      `[gov-exposure] ${flights.length} active liability row(s), TMA=${totalManaged} → ` +
        `${desired.length} exposure signal(s).`
    );

    if (config.dryRun) {
      for (const s of desired) {
        const scope = s.scope_kind === "route" ? `${s.flightId}` : (s.origin ?? s.dest);
        console.log(`[gov-exposure] [dry-run] would ensure ${s.severity} ${s.scope_kind}:${scope} (${(s.payload.fraction * 100).toFixed(1)}%)`);
        actions.push({ flight: `${scope}/${s.scope_kind}`, skipped: `[dry-run] ${s.severity}` });
      }
      return done(true);
    }

    const sql = getDb();
    const expiresAt = new Date(Date.now() + EXPIRY_SECS * 1000).toISOString();
    const active = (await sql`
      select * from signals where source = ${SIGNAL_SOURCE} and cleared_at is null
    `) as unknown as SignalRow[];

    const keyOf = (s: { scope_kind: string; flightId?: string; origin?: string | null; dest?: string | null }) =>
      s.scope_kind === "route"
        ? `route|${s.flightId}|${s.origin}|${s.dest}`
        : `${s.scope_kind}|${s.scope_kind === "origin" ? s.origin : s.dest}`;

    const desiredByKey = new Map(desired.map((s) => [keyOf(s), s]));
    const activeByKey = new Map(active.map((r) => [keyOf({ scope_kind: r.scope_kind, flightId: r.flight_id ?? undefined, origin: r.origin, dest: r.dest }), r]));

    for (const [key, spec] of desiredByKey) {
      const existing = activeByKey.get(key);
      if (existing && existing.severity === spec.severity) {
        await sql`update signals set expires_at = ${expiresAt}, payload = ${sql.json(spec.payload as any)} where id = ${existing.id}`;
        continue;
      }
      const scopeLabel = spec.scope_kind === "route" ? spec.flightId! : (spec.origin ?? spec.dest)!;
      if (existing) {
        await sql`update signals set cleared_at = now() where id = ${existing.id}`;
        actions.push({ flight: `${scopeLabel}/${spec.scope_kind}`, transition: `exposure ${existing.severity} → ${spec.severity}` });
      } else {
        actions.push({ flight: `${scopeLabel}/${spec.scope_kind}`, transition: `exposure opened (${spec.severity}, ${(spec.payload.fraction * 100).toFixed(1)}%)` });
      }
      await sql`
        insert into signals (type, scope_kind, flight_id, origin, dest, severity, payload, source, expires_at)
        values ('exposure', ${spec.scope_kind}, ${spec.flightId ?? null},
                ${spec.origin ?? null}, ${spec.dest ?? null}, ${spec.severity},
                ${sql.json(spec.payload as any)}, ${SIGNAL_SOURCE}, ${expiresAt})
      `;
    }

    for (const [key, row] of activeByKey) {
      if (desiredByKey.has(key)) continue;
      await sql`update signals set cleared_at = now() where id = ${row.id}`;
      const scopeLabel = row.scope_kind === "route" ? row.flight_id : (row.origin ?? row.dest);
      actions.push({ flight: `${scopeLabel}/${row.scope_kind}`, transition: "exposure cleared (concentration eased)" });
    }

    console.log(`[gov-exposure] Done. ${actions.length} change(s).`);
    return done(true);
  } catch (err) {
    console.error(`[gov-exposure] Fatal error: ${err}`);
    return done(false, String(err));
  }
}
