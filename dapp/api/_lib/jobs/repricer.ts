import { readFileSync } from "fs";
import { AgentClient } from "../agent_client";
import { toIata } from "../airline_codes";
import { expectedLossPremiumUnits, mlBasePremiumUnits } from "../route_rules";
import { baseUnitsToUsdc, fileTerms, loadRoutesConfig } from "../routes_config";
import type { FetcherAction, RunLogEntry } from "../types";
import { logPricingRun } from "../governance/pricing_log";

/**
 * reprice (monthly, ADVISORY) — seasonal ML repricing PROPOSAL.
 *
 * Runs the same whole-dollar base pricing as scripts/price_routes.ts over
 * every enabled fleet route, for a date ~2 weeks out, and writes the
 * proposal to the pricing_runs DB table:
 *
 *   - proposed base premium per route where it differs from the current
 *     fleet-file base
 *   - routes whose honest price now exceeds the base cap (seasonal risk
 *     spike) — flagged for the admin to consider disabling
 *
 * DELIBERATELY NO CHAIN WRITES and no file writes. The single source of
 * truth for base premiums is the fleet file, and only the admin changes
 * it — by running the manual ritual (price_routes → review →
 * seed_routes --apply-terms) when this proposal convinces them. Two
 * reasons this stays advisory:
 *   1. The human gate: repricing live routes is a governance decision.
 *   2. One premium per route on-chain: an auto-writer here would fight
 *      the weather surcharge job over the same value.
 */

const ACTOR = "cron:reprice";
const WHITELIST_FILE = "config/route_whitelist.json";
const PAYOFF_UNITS = 1_000_000_000n; // $100, 7 decimals

interface StagedDetail {
  dep_time_hhmm?: number;
  distance_mi?: number;
}

/** dep-time/distance detail from the staged whitelist, keyed by route. */
function loadStagedDetails(): Map<string, StagedDetail> {
  try {
    const staged = JSON.parse(readFileSync(WHITELIST_FILE, "utf8")) as {
      routes?: Array<{ flight_id: string; origin: string; destination: string } & StagedDetail>;
    };
    return new Map(
      (staged.routes ?? []).map((r) => [`${r.flight_id}|${r.origin}|${r.destination}`, r])
    );
  } catch {
    return new Map(); // absent staging file → model defaults (noon / 1000mi)
  }
}

export async function run(): Promise<RunLogEntry> {
  const start = Date.now();
  const actions: FetcherAction[] = [];

  try {
    const routesConfig = loadRoutesConfig();
    const enabled = routesConfig.routes.filter((r) => r.enabled);
    const details = loadStagedDetails();

    const agentBase = process.env.AGENT_BASE_URL ?? "https://flight-delay-predictions.onrender.com";
    const agent = new AgentClient(agentBase, process.env.AGENT_TOKEN || undefined);

    let modelVersion = "unknown";
    try {
      const health = await fetch(`${agentBase}/healthz`, { signal: AbortSignal.timeout(15_000) });
      if (health.ok) modelVersion = ((await health.json()) as { model_version: string }).model_version;
    } catch {
      /* summary still useful without the version */
    }

    // Price for a representative date two weeks out — same convention as
    // the manual pipeline, so proposals and seeded terms are comparable.
    const forDate = new Date(Date.now() + 14 * 86_400_000);
    const month = forDate.getUTCMonth() + 1;
    const dayOfMonth = forDate.getUTCDate();
    const dayOfWeek = ((forDate.getUTCDay() + 6) % 7) + 1;

    console.log(`[reprice] ${enabled.length} enabled route(s); advisory pricing for ${forDate.toISOString().slice(0, 10)}`);

    const changes: Array<{ flight_id: string; origin: string; dest: string; current_usdc: number; proposed_usdc: number }> = [];
    const excluded: Array<{ flight_id: string; origin: string; dest: string; p_covered: number; honest_premium_usdc: number }> = [];
    let priced = 0;
    let failed = 0;

    for (const route of enabled) {
      const label = `${route.flight_id} ${route.origin}→${route.destination}`;
      const iata = toIata(route.carrier);
      if (!iata) {
        console.warn(`[reprice] ${label}: untracked carrier "${route.carrier}" — skipped`);
        failed++;
        continue;
      }
      const detail = details.get(`${route.flight_id}|${route.origin}|${route.destination}`) ?? {};
      const p = await agent.predict(
        {
          carrier: iata,
          origin: route.origin,
          dest: route.destination,
          month,
          day_of_month: dayOfMonth,
          day_of_week: dayOfWeek,
          ...(detail.dep_time_hhmm != null ? { dep_time_hhmm: detail.dep_time_hhmm } : {}),
          ...(detail.distance_mi != null ? { distance_mi: detail.distance_mi } : {}),
        },
        label
      );
      if (p === null) {
        failed++;
        continue;
      }
      priced++;

      const proposed = mlBasePremiumUnits(p, PAYOFF_UNITS, routesConfig.rails);
      if (proposed === null) {
        const honest = baseUnitsToUsdc(expectedLossPremiumUnits(p, PAYOFF_UNITS));
        excluded.push({
          flight_id: route.flight_id,
          origin: route.origin,
          dest: route.destination,
          p_covered: Number(p.toFixed(5)),
          honest_premium_usdc: Number(honest.toFixed(2)),
        });
        actions.push({ flight: label, skipped: `now above base cap (honest $${honest.toFixed(2)}) — admin should review` });
        continue;
      }

      const currentBase = fileTerms(routesConfig, route).premium;
      if (proposed !== currentBase) {
        changes.push({
          flight_id: route.flight_id,
          origin: route.origin,
          dest: route.destination,
          current_usdc: baseUnitsToUsdc(currentBase),
          proposed_usdc: baseUnitsToUsdc(proposed),
        });
        actions.push({
          flight: label,
          skipped: `proposes $${baseUnitsToUsdc(currentBase)} → $${baseUnitsToUsdc(proposed)} (advisory — apply via manual ritual)`,
        });
      }
    }

    console.log(
      `[reprice] done: ${priced} priced, ${changes.length} proposed change(s), ` +
        `${excluded.length} now over the base cap, ${failed} failed — ADVISORY ONLY, nothing applied`
    );

    await logPricingRun({
      context: ACTOR,
      model_version: modelVersion,
      priced_for_date: forDate.toISOString().slice(0, 10),
      total_candidates: enabled.length,
      priced,
      failed,
      excluded,
      summary: {
        proposed_changes: changes,
        base_premium_max_usdc: baseUnitsToUsdc(routesConfig.rails.basePremiumMax),
        apply_via: "price_routes → admin review → seed_routes --apply-terms",
      },
    });

    return {
      timestamp: new Date().toISOString(),
      job: "reprice",
      duration_ms: Date.now() - start,
      success: true,
      actions,
    };
  } catch (err) {
    console.error(`[reprice] Fatal error: ${err}`);
    return {
      timestamp: new Date().toISOString(),
      job: "reprice",
      duration_ms: Date.now() - start,
      success: false,
      error: String(err),
      actions,
    };
  }
}

