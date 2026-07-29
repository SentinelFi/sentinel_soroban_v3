import {
  fileTerms,
  loadRoutesConfig,
  type RoutesConfig,
} from "../routes_config";
import type { RunLogEntry, FetcherAction } from "../types";
import type { GovConfig } from "./config";
import { getDb } from "./db";
import { GovSubmitter } from "./submitter";
import type { RouteRow } from "./model";

/**
 * gov_onboard — the file↔chain↔DB STATUS SYNC that closes the
 * reconciler's "invisibility gap".
 *
 * The 2026-07-27 audit found the DB `routes` table (the reconciler's
 * world) and `config/routes.testnet.json` + the on-chain whitelist (the
 * authorizer/script world) were never synced by code: a route whitelisted
 * via the file was invisible to the reconciler forever. This job is that
 * bridge: every route in the fleet file is upserted into the DB with its
 * ACTUAL on-chain status (Active → 'active', Disabled → 'disabled').
 * Base terms are written on first insert only (admin edits are never
 * clobbered); pinned rows are never touched. GOV_DRY_RUN logs every
 * decision and writes nothing.
 *
 * DELIBERATELY NOT HERE: route intake/whitelisting. Onboarding new routes
 * is a MANUAL, admin-gated pipeline (scripts/discover_routes →
 * scripts/price_routes → admin review → scripts/seed_routes) — this job
 * never whitelists anything and never reads discovery output. The old
 * candidate-ingest + auto-promote phases (GOV_ONBOARD_AUTO /
 * GOV_ONBOARD_MAX_PER_RUN) were removed 2026-07-29 by that decision.
 */

const ACTOR = "cron:gov_onboard";

export async function run(config: GovConfig): Promise<RunLogEntry> {
  const start = Date.now();
  const actions: FetcherAction[] = [];
  const done = (success: boolean, error?: string): RunLogEntry => ({
    timestamp: new Date().toISOString(),
    job: "gov_onboard",
    duration_ms: Date.now() - start,
    success,
    ...(error ? { error } : {}),
    actions,
  });

  try {
    const routesConfig = loadRoutesConfig();
    const submitter = new GovSubmitter({
      rpcUrl: config.stellarRpcUrl,
      networkPassphrase: config.networkPassphrase,
      governanceId: config.governanceId,
      adminSecretKey: config.govAdminSecretKey,
      actor: ACTOR,
    });
    const sql = getDb();

    const existing = (await sql`select * from routes`) as unknown as RouteRow[];
    const byKey = new Map(existing.map((r) => [`${r.flight_id}|${r.origin}|${r.dest}`, r]));

    // SYNC: file routes ↔ on-chain status → DB.
    for (const route of routesConfig.routes) {
      const key = `${route.flight_id}|${route.origin}|${route.destination}`;
      const label = `${route.flight_id} ${route.origin}→${route.destination}`;
      const onChain = await submitter.readStatus({
        flightId: route.flight_id,
        origin: route.origin,
        dest: route.destination,
      });
      const dbStatus =
        onChain.status === "Active"
          ? "active"
          : onChain.status === "Disabled"
            ? "disabled"
            : null; // Unknown: not on-chain — intake is the manual pipeline's job
      if (!dbStatus) continue;

      const row = byKey.get(key);
      if (row?.pinned) continue; // admin pin wins
      if (row && row.status === dbStatus) continue; // already in sync

      if (config.dryRun) {
        console.log(`[gov-onboard] [dry-run] sync ${label}: ${row?.status ?? "(new)"} → ${dbStatus}`);
        actions.push({ flight: label, skipped: `[dry-run] sync → ${dbStatus}` });
        continue;
      }
      const terms = fileTerms(routesConfig, route);
      await sql`
        insert into routes (flight_id, origin, dest, carrier, status,
                            base_premium_units, base_payoff_units, base_delay_hours)
        values (${route.flight_id}, ${route.origin}, ${route.destination},
                ${route.carrier ?? null}, ${dbStatus},
                ${terms.premium.toString()}, ${terms.payoff.toString()}, ${terms.delayHours})
        on conflict (flight_id, origin, dest) do update
          set status = ${dbStatus}, updated_at = now()
      `;
      actions.push({ flight: label, transition: `db sync → ${dbStatus}` });
    }

    console.log(`[gov-onboard] Done. ${actions.length} action(s).`);
    return done(true);
  } catch (err) {
    console.error(`[gov-onboard] Fatal error: ${err}`);
    return done(false, String(err));
  }
}

// Re-export for tests.
export type { RoutesConfig };
