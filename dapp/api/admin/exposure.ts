import type { VercelRequest, VercelResponse } from "@vercel/node";
import { verifyAdmin } from "../_lib/governance/admin_auth.js";
import { loadGovConfig } from "../_lib/governance/config.js";
import {
  exposureContractIds,
  exposureReadClient,
  readExposure,
} from "../_lib/governance/exposure_collector.js";

/**
 * Admin API — the exposure GAUGE behind the gov_exposure tripwire.
 *
 * The hourly cron only surfaces route/airport concentration when it
 * crosses the 25%/50% thresholds; this endpoint returns EVERY bucket's
 * current liability fraction of vault capacity, so the admin board can
 * show "34% of the way to the brake" instead of silence-then-alarm.
 *
 * Same inputs as the cron (readExposure: pool liabilities + vault TMA +
 * routes-file scoping), aggregated per route and per airport with the
 * liability figures kept alongside the fractions. Read-only; takes no
 * action. The unscoped-liability blind spot (flights missing from the
 * routes file) is returned, not dropped — same posture as the cron.
 *
 * GET → { total_managed_units, thresholds, routes, airports, unknown }
 */

export const config = { maxDuration: 60 };

// Mirrors the cron's env-tunable cutoffs (defaults 25% / 50%).
const ELEVATED_PCT = Number(process.env.EXPOSURE_ELEVATED_PCT ?? 0.25);
const SEVERE_PCT = Number(process.env.EXPOSURE_SEVERE_PCT ?? 0.5);
const MAX_ROWS = 50;

export default async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  const admin = await verifyAdmin(req);
  if (!admin) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  if (req.method !== "GET") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }
  // The read client signs its simulations with the gov-admin key.
  if (!process.env.GOVERNANCE_ADMIN_SECRET_KEY) {
    res.status(503).json({ error: "GOVERNANCE_ADMIN_SECRET_KEY not configured" });
    return;
  }

  try {
    const { poolId, vaultId } = exposureContractIds();
    const client = exposureReadClient(loadGovConfig());
    const { flights, totalManaged, unknownLiabilityUnits, unknownFlights } = await readExposure(
      client,
      { flightPoolManagerId: poolId, riskVaultId: vaultId }
    );

    // Aggregate with the units kept (computeConcentrations drops them —
    // the cron only needs fractions; the gauge wants both).
    const routeAgg = new Map<string, { origin: string; dest: string; units: bigint }>();
    const airportAgg = new Map<string, bigint>();
    for (const f of flights) {
      const key = `${f.flightId}|${f.origin}|${f.dest}`;
      const r = routeAgg.get(key) ?? { origin: f.origin, dest: f.dest, units: 0n };
      r.units += f.liabilityUnits;
      routeAgg.set(key, r);
      airportAgg.set(f.origin, (airportAgg.get(f.origin) ?? 0n) + f.liabilityUnits);
      if (f.dest !== f.origin) {
        airportAgg.set(f.dest, (airportAgg.get(f.dest) ?? 0n) + f.liabilityUnits);
      }
    }
    // Same ceiling division as the cron — ties round toward the brake.
    const fraction = (units: bigint): number =>
      totalManaged <= 0n
        ? 0
        : Number((units * 1_000_000n + totalManaged - 1n) / totalManaged) / 1_000_000;

    const routes = [...routeAgg]
      .map(([key, r]) => ({
        flight_id: key.split("|")[0] ?? key,
        origin: r.origin,
        dest: r.dest,
        liability_units: r.units.toString(),
        fraction: fraction(r.units),
      }))
      .sort((a, b) => b.fraction - a.fraction)
      .slice(0, MAX_ROWS);
    const airports = [...airportAgg]
      .map(([airport, units]) => ({
        airport,
        liability_units: units.toString(),
        fraction: fraction(units),
      }))
      .sort((a, b) => b.fraction - a.fraction)
      .slice(0, MAX_ROWS);

    res.status(200).json({
      total_managed_units: totalManaged.toString(),
      thresholds: { elevated: ELEVATED_PCT, severe: SEVERE_PCT },
      routes,
      airports,
      unknown: {
        liability_units: unknownLiabilityUnits.toString(),
        flights: unknownFlights,
      },
      as_of: new Date().toISOString(),
    });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
}
