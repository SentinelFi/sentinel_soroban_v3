import type { VercelRequest, VercelResponse } from "@vercel/node";
import { loadRoutesConfig, fileTerms, type RouteEntry } from "./_lib/routes_config.js";
import { airportTz } from "./_lib/airport_tz.js";
import { getDb } from "./_lib/governance/db.js";
import { loadGovConfig } from "./_lib/governance/config.js";
import { GovSubmitter } from "./_lib/governance/submitter.js";
// Node ESM (the deployed runtime) hard-requires the JSON import attribute.
import liveConfig from "../config/routes.live.json" with { type: "json" };
import whitelistConfig from "../config/route_whitelist.json" with { type: "json" };

/**
 * GET /api/routes — the full route catalog for the board.
 *
 * Replaces the browser-side per-route on-chain scan (1 RPC simulate per
 * listed route per visitor — the reason the board used to be capped at a
 * hand-curated list). One CDN-cached JSON blob serves every visitor.
 *
 * Sources, layered:
 *   1. bundled fleet file (config/routes.testnet.json) — the complete
 *      seeded catalog with per-route term overrides mirrored from chain
 *      at seed time; enabled=false entries are excluded;
 *   2. governance DB `routes` overlay — the interventions executor and
 *      revive cron write pauses/re-enables here INTRADAY, so a DB
 *      "disabled" wins over the file default (fresher than any cached
 *      chain read); DB unreachable → file-only (fail-open to display,
 *      fail-safe overall: sale-auth + the contract re-verify every buy);
 *   3. routes.live.json — demoted from "the only inventory" to the
 *      `featured` flag (board pins featured rows first);
 *   4. live `route_status` reads — the REAL price (see below);
 *   5. config/route_whitelist.json — the staged ML pricing run, joined
 *      back in for `p_covered` (the calibrated delay probability the base
 *      premium was derived from). Display-only; nothing prices off it.
 *
 * WHY the chain read (2026-08-04): the weather job writes storm
 * surcharges ON-CHAIN ONLY — the fleet file keeps the BASE. A surcharged
 * route therefore advertised $20 here and charged $30 in the BetSlip.
 * `premium_units` stays the file base VERBATIM (existing consumers,
 * including the live soak harness, key off it); `chain_premium_units` is
 * the resolved on-chain premium and is what a price display should use,
 * falling back to `premium_units` when null.
 *
 * The authoritative buyability check stays at buy time (sale-auth + the
 * on-chain purchase gate) — a stale row here surfaces a refusal, never a
 * bad policy.
 */
export const config = { maxDuration: 30 };

/**
 * Chain-read budget. 1,069 routes × 1 RPC simulate is NOT free, and this
 * endpoint has a 30s cap, so the sweep is bounded on both axes:
 *   - CHAIN_CHUNK parallel reads per round (the STATUS_CHUNK pattern from
 *     jobs/weather.ts, widened — measured ~14s for the whole fleet at 40,
 *     ~22s at 20; serial would be ~7 minutes);
 *   - a hard wall-clock deadline. Routes not reached before it get
 *     `chain_premium_units: null` — a missing price the UI falls back on
 *     is strictly better than blowing the function's budget and serving
 *     the board a 504.
 * Featured routes are swept FIRST so the rows the board pins are the ones
 * guaranteed to carry a real price when the RPC is having a bad day.
 * ROUTES_CHAIN_PREMIUM=off is the operator kill switch (every route then
 * reports null and the endpoint is as cheap as it was before).
 */
const CHAIN_CHUNK = 40;
// 15s of the 30s cap. Measured 2026-08-04: the WHOLE 1,069-route fleet
// resolves in ~10.5s against public testnet RPC, so this is ~40% headroom
// on a good day and a hard stop on a bad one — and it keeps the worst-case
// uncached response comfortably inside the 30s fetch timeout the live soak
// harness uses on this endpoint.
const CHAIN_BUDGET_MS = 15_000;

const routeKey = (r: { flight_id: string; origin: string; destination: string }): string =>
  `${r.flight_id}|${r.origin}|${r.destination}`;

/**
 * Delay probability by route, from the staged pricing run. Built once per
 * cold start — a 1,190-entry static import, same bundled-JSON convention as
 * routes_config.ts (readFileSync would depend on the function's cwd).
 *
 * We publish the SEASONAL PEAK (`p_covered_max`), not the priced date's
 * figure. The model swings hard across the calendar — one route reads 15%
 * in August and 1.6% in September — so a single date's number on a board
 * where the buyer picks their own date misleads in both directions. The
 * peak supports an honest "up to X%", and the board says so.
 *
 * Falls back to `p_covered` for staged files written before the peak was
 * computed, so an older whitelist still renders something true (just less
 * useful). Neither figure is ever used for pricing — premiums come from
 * the priced date, on-chain.
 */
const WL_ROWS = (whitelistConfig as {
  routes?: Array<{
    flight_id: string;
    origin: string;
    destination: string;
    p_covered?: number | null;
    p_covered_max?: number | null;
    dep_time_hhmm?: number | null;
  }>;
}).routes ?? [];

const P_COVERED: Map<string, { p: number; peak: boolean }> = new Map(
  WL_ROWS
    .map((r) => {
      // Peak when the staged file carries one; otherwise the priced date,
      // flagged so the UI does not claim "up to" about a single day.
      const peak = typeof r.p_covered_max === "number";
      const p = peak ? (r.p_covered_max as number) : r.p_covered;
      return [routeKey(r), { p, peak }] as const;
    })
    .filter((e): e is readonly [string, { p: number; peak: boolean }] =>
      typeof e[1].p === "number",
    )
    .map(([k, v]) => [k, v]),
);

/**
 * Origin-LOCAL scheduled departure (HHMM) per route, from the same staged
 * pricing run. Display-only disclosure: the board is keyed by the UTC
 * departure date while boarding passes carry the local one, and ~19% of
 * the fleet departs late enough local that the two differ — the UI uses
 * this (with `origin_tz`) to show the boarding-pass date next to the
 * picked one. Approximate by nature (the priced instance's time, and
 * schedules retime); the BetSlip renders it with a "≈" and upgrades to
 * the sale-auth answer mid-buy. Nothing prices or settles off it.
 */
const DEP_HHMM: Map<string, number> = new Map(
  WL_ROWS.filter((r) => typeof r.dep_time_hhmm === "number").map((r) => [
    routeKey(r),
    r.dep_time_hhmm as number,
  ]),
);

/**
 * Resolved on-chain premium per route key, for as much of the fleet as
 * fits CHAIN_BUDGET_MS. Absent key → caller reports null. Never throws:
 * a missing gov key, an unreachable RPC or a per-route revert all degrade
 * to "unresolved", because the catalog must render regardless.
 */
async function resolveChainPremiums(
  routes: RouteEntry[],
  featured: Set<string>,
  deadline: number,
): Promise<Map<string, bigint>> {
  const resolved = new Map<string, bigint>();
  if (process.env.ROUTES_CHAIN_PREMIUM === "off") return resolved;

  // The gov-admin key is only ever the SIMULATION source here — this
  // endpoint reads, it never builds a signed tx.
  let submitter: GovSubmitter;
  try {
    const gov = loadGovConfig();
    submitter = new GovSubmitter({
      rpcUrl: gov.stellarRpcUrl,
      networkPassphrase: gov.networkPassphrase,
      governanceId: gov.governanceId,
      adminSecretKey: gov.govAdminSecretKey,
      actor: "api:routes",
    });
  } catch (err) {
    console.warn(`[routes] chain premium unavailable (${err}) — serving file terms only.`);
    return resolved;
  }

  // Stable sort → featured first, file order within each group.
  const ordered = [...routes].sort(
    (a, b) => Number(featured.has(routeKey(b))) - Number(featured.has(routeKey(a))),
  );

  for (let i = 0; i < ordered.length; i += CHAIN_CHUNK) {
    if (Date.now() > deadline) break;
    await Promise.all(
      ordered.slice(i, i + CHAIN_CHUNK).map(async (r) => {
        try {
          const onChain = await submitter.readStatus({
            flightId: r.flight_id,
            origin: r.origin,
            dest: r.destination,
          });
          // Disabled/Unknown carry no resolved terms — stays null.
          if (onChain.terms) resolved.set(routeKey(r), onChain.terms.premium);
        } catch {
          /* unresolved — the row falls back to premium_units */
        }
      }),
    );
  }
  return resolved;
}

export default async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  if (req.method !== "GET") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  const start = Date.now();
  const routesConfig = loadRoutesConfig();
  const featured = new Set(
    ((liveConfig as { routes?: Array<{ flight_id: string; origin: string; destination: string }> })
      .routes ?? []).map((r) => `${r.flight_id}|${r.origin}|${r.destination}`),
  );

  // DB overlay — best effort, never blocks the catalog.
  const dbStatus = new Map<string, string>();
  let dbOverlay = false;
  if (process.env.GOVERNANCE_DB_URL) {
    try {
      const sql = getDb();
      const rows = (await sql`select flight_id, origin, dest, status from routes`) as unknown as Array<{
        flight_id: string;
        origin: string;
        dest: string;
        status: string;
      }>;
      for (const r of rows) dbStatus.set(`${r.flight_id}|${r.origin}|${r.dest}`, r.status);
      dbOverlay = true;
    } catch {
      /* file-only */
    }
  }

  const enabled = routesConfig.routes.filter((r) => r.enabled !== false);

  // Live premiums — bounded sweep, unresolved routes fall back to null.
  const chainPremium = await resolveChainPremiums(enabled, featured, start + CHAIN_BUDGET_MS);

  const routes = enabled.map((r) => {
    const key = routeKey(r);
    const overlay = dbStatus.get(key);
    const terms = fileTerms(routesConfig, r);
    const chain = chainPremium.get(key);
    return {
      flight_id: r.flight_id,
      origin: r.origin,
      destination: r.destination,
      carrier: r.carrier ?? null,
      status: overlay === "disabled" ? "Disabled" : "Active",
      premium_units: terms.premium.toString(),
      // The real price: file base + any on-chain weather surcharge.
      // null = not resolved this pass; consumers fall back to premium_units.
      chain_premium_units: chain !== undefined ? chain.toString() : null,
      payoff_units: terms.payoff.toString(),
      delay_hours: terms.delayHours,
      // Calibrated ML delay probability for the route (staged pricing run).
      p_covered: P_COVERED.get(key)?.p ?? null,
      /** true when p_covered is the seasonal peak, not a single priced date. */
      p_covered_is_peak: P_COVERED.get(key)?.peak ?? false,
      // Origin-local departure disclosure (see DEP_HHMM above). Either can
      // be null independently; the UI needs both to render the hint.
      dep_time_local_hhmm: DEP_HHMM.get(key) ?? null,
      origin_tz: airportTz(r.origin),
      featured: featured.has(key),
    };
  });

  // One origin fetch per 5min globally; browsers keep it 1min.
  res.setHeader("Cache-Control", "public, max-age=60, s-maxage=300, stale-while-revalidate=600");
  res.status(200).json({
    as_of: new Date().toISOString(),
    db_overlay: dbOverlay,
    // How many rows carry a live chain price — the rest are null (budget
    // reached, RPC trouble, or the kill switch). Observability only.
    chain_resolved: chainPremium.size,
    count: routes.length,
    routes,
  });
}
