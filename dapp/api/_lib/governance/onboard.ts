import { existsSync, readFileSync } from "fs";
import { resolve } from "path";
import {
  fileTerms,
  loadRoutesConfig,
  type RouteEntry,
  type RoutesConfig,
} from "../routes_config";
import { parseFlightIdent } from "../jobs/authorizer";
import type { RunLogEntry, FetcherAction } from "../types";
import type { GovConfig } from "./config";
import { getDb } from "./db";
import { GovSubmitter } from "./submitter";
import type { RouteRow } from "./model";

/**
 * gov_onboard — automated route onboarding + the file↔DB↔chain sync that
 * closes the reconciler's "invisibility gap".
 *
 * The 2026-07-27 audit found the DB `routes` table (the reconciler's world)
 * and `config/routes.testnet.json` + the on-chain whitelist (the authorizer/
 * script world) were never synced by code: a route whitelisted via the file
 * was invisible to the reconciler forever. This job is the missing bridge,
 * in three phases:
 *
 * 1. SYNC — every route in the routes file is upserted into the DB with its
 *    ACTUAL on-chain status (Active → 'active', Disabled → 'disabled',
 *    Unknown+enabled → 'candidate'). Base terms are written on first insert
 *    only (admin edits are never clobbered). After one run, the reconciler
 *    manages every route the protocol actually has.
 * 2. INGEST — if a discovery output file exists
 *    (config/routes.discovered.json, from `npm run discover:routes`), its
 *    entries are inserted as 'candidate' rows. Idempotent: existing
 *    (flight_id, origin, dest) rows are left untouched; idents that fail
 *    the airline+number shape (unattestable by the sale authorizer) are
 *    skipped.
 * 3. PROMOTE — candidates are whitelisted on-chain through the audited
 *    GovSubmitter (default terms; the on-chain term limits are the
 *    backstop) and flipped to 'active' in the DB. Gated:
 *      - GOV_ONBOARD_AUTO=true  → auto-promote (full automation)
 *      - unset/false            → propose-only: candidates wait for an
 *                                 admin (or the flag) — nothing on-chain
 *      - GOV_ONBOARD_MAX_PER_RUN (default 10) caps promotions per run
 *      - pinned rows are never touched (admin pin wins, as everywhere)
 *    GOV_DRY_RUN logs every decision and writes nothing (DB or chain).
 *
 * A future scoring hook (ML p_delay via the pricing agent, schedule
 * stability) slots between INGEST and PROMOTE; until then promotion order
 * is insertion order under the cap.
 */

const ACTOR = "cron:gov_onboard";

export interface OnboardCaps {
  autoPromote: boolean;
  maxPerRun: number;
}

export function loadCaps(): OnboardCaps {
  const n = Number(process.env.GOV_ONBOARD_MAX_PER_RUN);
  return {
    autoPromote: process.env.GOV_ONBOARD_AUTO === "true",
    maxPerRun: Number.isInteger(n) && n > 0 ? n : 10,
  };
}

/** Discovery output entries (RouteEntry shape) — [] when no file. */
export function loadDiscovered(): RouteEntry[] {
  const path =
    process.env.GOV_ONBOARD_DISCOVERED ??
    resolve(process.cwd(), "config/routes.discovered.json");
  if (!existsSync(path)) return [];
  try {
    const raw = JSON.parse(readFileSync(path, "utf8"));
    return Array.isArray(raw) ? (raw as RouteEntry[]) : [];
  } catch (err) {
    console.warn(`[gov-onboard] could not parse ${path}: ${err}`);
    return [];
  }
}

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
    const caps = loadCaps();
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
    const byIdent = new Map(existing.map((r) => [r.flight_id, r]));

    // ── Phase 1: SYNC file routes ↔ on-chain status → DB ────────────────
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
            : route.enabled
              ? "candidate"
              : null; // Unknown + disabled-in-file: nothing to manage
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

    // ── Phase 2: INGEST discovery output as candidates ──────────────────
    const discovered = loadDiscovered();
    for (const d of discovered) {
      const key = `${d.flight_id}|${d.origin}|${d.destination}`;
      const label = `${d.flight_id} ${d.origin}→${d.destination}`;
      if (byKey.has(key)) continue; // idempotent
      if (!parseFlightIdent(d.flight_id)) {
        actions.push({ flight: label, skipped: "unattestable ident" });
        continue;
      }
      const conflict = byIdent.get(d.flight_id);
      if (conflict) {
        // One (origin, dest) per flight_id on-chain — would be rejected.
        actions.push({ flight: label, skipped: `ident already mapped ${conflict.origin}→${conflict.dest}` });
        continue;
      }
      if (config.dryRun) {
        console.log(`[gov-onboard] [dry-run] ingest candidate ${label}`);
        actions.push({ flight: label, skipped: "[dry-run] would ingest candidate" });
        continue;
      }
      await sql`
        insert into routes (flight_id, origin, dest, carrier, status)
        values (${d.flight_id}, ${d.origin}, ${d.destination}, ${d.carrier ?? null}, 'candidate')
        on conflict (flight_id, origin, dest) do nothing
      `;
      byKey.set(key, { flight_id: d.flight_id, origin: d.origin, dest: d.destination } as RouteRow);
      byIdent.set(d.flight_id, { flight_id: d.flight_id, origin: d.origin, dest: d.destination } as RouteRow);
      actions.push({ flight: label, transition: "candidate ingested" });
    }

    // ── Phase 3: PROMOTE candidates (capped; propose-only by default) ───
    const candidates = (await sql`
      select * from routes where status = 'candidate' and pinned = false
      order by created_at asc
    `) as unknown as RouteRow[];

    if (!caps.autoPromote) {
      if (candidates.length > 0) {
        console.log(`[gov-onboard] ${candidates.length} candidate(s) awaiting approval (GOV_ONBOARD_AUTO not set — propose-only).`);
        actions.push({ flight: "-", skipped: `${candidates.length} candidate(s) awaiting approval (propose-only)` });
      }
      return done(true);
    }

    let promoted = 0;
    for (const c of candidates) {
      if (promoted >= caps.maxPerRun) {
        actions.push({ flight: "-", skipped: `promotion cap ${caps.maxPerRun} reached — ${candidates.length - promoted} deferred` });
        break;
      }
      const label = `${c.flight_id} ${c.origin}→${c.dest}`;
      if (config.dryRun) {
        console.log(`[gov-onboard] [dry-run] would whitelist ${label} (default terms)`);
        actions.push({ flight: label, skipped: "[dry-run] would whitelist" });
        promoted++;
        continue;
      }
      try {
        // Skip-if-already-on-chain (idempotent with manual whitelisting).
        const onChain = await submitter.readStatus({ flightId: c.flight_id, origin: c.origin, dest: c.dest });
        if (onChain.status === "Unknown") {
          // Default terms — on-chain defaults + term limits are the backstop.
          await submitter.whitelist({ flightId: c.flight_id, origin: c.origin, dest: c.dest }, null, null, null);
        }
        await sql`update routes set status = 'active', updated_at = now() where id = ${c.id}`;
        actions.push({ flight: label, transition: onChain.status === "Unknown" ? "whitelisted + active" : "already on-chain → active" });
        promoted++;
      } catch (err) {
        console.error(`[gov-onboard] ${label}: promotion failed: ${err}`);
        actions.push({ flight: label, error: String(err) });
      }
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
