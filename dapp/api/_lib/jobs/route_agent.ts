import { SorobanClient } from "../soroban_client";
import { AgentClient } from "../agent_client";
import { WeatherClient } from "../weather_client";
import {
  classifyForecast,
  combineSeverity,
  decideRouteAction,
  clampPremium,
} from "../route_rules";
import {
  readRouteStatus,
  disableRoute,
  enableRoute,
  updateRoutePremium,
  type GovernanceCtx,
} from "../governance";
import {
  loadRoutesConfig,
  fileTerms,
  baseUnitsToUsdc,
} from "../routes_config";
import type { Config, RunLogEntry, FetcherAction } from "../types";

/**
 * Cron #5 — RouteAgent (daily)
 *
 * The sample governance agent: ML pricing + weather rules + 24h
 * re-evaluation in one pass. For each route in config/routes.testnet.json:
 *
 * 1. Read the on-chain RouteStatus from GovernanceModule.
 * 2. Baseline premium: POST the flight tuple to the Python pricing agent
 *    (agent/ on Render — XGBoost p_delay → expected-loss premium). Agent
 *    down/unset → fall back to the routes-file terms. Never blocks.
 * 3. Weather verdict: Open-Meteo forecasts for origin + destination over
 *    the sale horizon → ok / elevated / severe (worst of the two).
 * 4. Decide via the pure route_rules module:
 *      severe weather        → disable_route
 *      elevated weather      → premium × multiplier, clamped to rails
 *      disabled + clear + routes-file enabled:true → re-enable (24h
 *                              re-evaluation — this cron IS the re-evaluator)
 *      otherwise             → reprice within rails + daily step cap,
 *                              skipping sub-threshold drift
 * 5. Apply with the governance-admin key (4th identity, never owner).
 *    On-chain owner-set term limits are the final backstop.
 *
 * Whitelisting NEW routes stays manual (scripts/whitelist_routes.ts) —
 * the agent only manages routes a human already listed.
 */
export async function run(config: Config): Promise<RunLogEntry> {
  const start = Date.now();
  const actions: FetcherAction[] = [];

  try {
    if (!config.governanceAdminSecretKey) {
      throw new Error("GOVERNANCE_ADMIN_SECRET_KEY is not set — route agent cannot sign governance txs");
    }

    const routesConfig = loadRoutesConfig();
    const client = new SorobanClient(config);
    const ctx: GovernanceCtx = {
      client,
      governanceId: config.governanceId,
      adminPublicKey: client.publicKeyFromSecret(config.governanceAdminSecretKey),
      adminSecretKey: config.governanceAdminSecretKey,
    };

    const agent = config.agentBaseUrl
      ? new AgentClient(config.agentBaseUrl, config.agentToken)
      : null;
    const weather = new WeatherClient(config.weatherBaseUrl, routesConfig.saleHorizonDays);

    // Model date features: tomorrow (the first insurable day — day 0 is
    // blocked by the controller's min-lead cutoff anyway).
    const tomorrow = new Date(Date.now() + 86_400_000);
    const month = tomorrow.getUTCMonth() + 1;
    const dayOfMonth = tomorrow.getUTCDate();
    const dayOfWeek = ((tomorrow.getUTCDay() + 6) % 7) + 1; // Mon=1 … Sun=7

    console.log(`[route-agent] Evaluating ${routesConfig.routes.length} route(s)...`);

    // Weather forecasts are cached per airport so shared hubs are fetched once.
    const forecastCache = new Map<string, Awaited<ReturnType<WeatherClient["getForecast"]>>>();
    const getForecast = async (iata: string) => {
      if (!forecastCache.has(iata)) {
        forecastCache.set(iata, await weather.getForecast(iata));
      }
      return forecastCache.get(iata) ?? null;
    };

    for (const route of routesConfig.routes) {
      const label = `${route.flight_id} ${route.origin}→${route.destination}`;
      try {
        // 1. On-chain state
        const onChain = await readRouteStatus(ctx, route.flight_id, route.origin, route.destination);

        // 2. ML baseline (fallback: file terms)
        const terms = fileTerms(routesConfig, route);
        let baseline = terms.premium;
        let baselineSource = "routes file";
        if (agent && route.enabled) {
          const priced = await agent.price({
            flight_id: route.flight_id,
            carrier: route.carrier,
            origin: route.origin,
            dest: route.destination,
            payoff_usdc: baseUnitsToUsdc(terms.payoff),
            month,
            day_of_month: dayOfMonth,
            day_of_week: dayOfWeek,
          });
          if (priced) {
            baseline = priced.premiumBaseUnits;
            baselineSource = `ML (p_delay=${priced.pDelay.toFixed(3)})`;
          }
        }
        // The baseline itself respects the rails before any weather math.
        baseline = clampPremium(baseline, null, routesConfig.rails);

        // 3. Weather (skipped for human-disabled routes — nothing to price)
        let severity: ReturnType<typeof classifyForecast> = "ok";
        if (route.enabled) {
          const [o, d] = await Promise.all([
            getForecast(route.origin),
            getForecast(route.destination),
          ]);
          severity = combineSeverity(classifyForecast(o), classifyForecast(d));
        }

        // 4. Decide
        const action = decideRouteAction(route, onChain, baseline, severity, routesConfig.rails);
        console.log(
          `[route-agent] ${label}: on-chain=${onChain.status} weather=${severity} baseline=${baselineSource} → ${action.kind} (${action.reason})`
        );

        // 5. Apply. GOV_DRY_RUN gates every mutation — the same kill switch
        // the reconciler honors (2026-07-27 audit: this job previously
        // ignored it, making it an ungoverned second actor). Full audit-trail
        // parity (actions_log via GovSubmitter) lands with the Phase 4
        // absorption into the reconciler.
        const dryRun = process.env.GOV_DRY_RUN === "true";
        switch (action.kind) {
          case "noop":
            actions.push({ flight: label, skipped: action.reason });
            break;
          case "disable":
            if (dryRun) {
              console.log(`[route-agent] [dry-run] ${label}: would disable (${action.reason})`);
              actions.push({ flight: label, skipped: `[dry-run] would disable (${action.reason})` });
              break;
            }
            await disableRoute(ctx, route.flight_id, route.origin, route.destination);
            actions.push({ flight: label, transition: `disabled (${action.reason})` });
            break;
          case "reenable_with_terms":
            if (dryRun) {
              console.log(`[route-agent] [dry-run] ${label}: would re-enable at $${baseUnitsToUsdc(action.newPremium)} (${action.reason})`);
              actions.push({ flight: label, skipped: `[dry-run] would re-enable (${action.reason})` });
              break;
            }
            await enableRoute(ctx, route.flight_id, route.origin, route.destination);
            await updateRoutePremium(ctx, route.flight_id, route.origin, route.destination, action.newPremium);
            actions.push({
              flight: label,
              transition: `re-enabled at $${baseUnitsToUsdc(action.newPremium)} (${action.reason})`,
            });
            break;
          case "update_premium":
            if (dryRun) {
              console.log(`[route-agent] [dry-run] ${label}: would set premium → $${baseUnitsToUsdc(action.newPremium)} (${action.reason})`);
              actions.push({ flight: label, skipped: `[dry-run] would set premium (${action.reason})` });
              break;
            }
            await updateRoutePremium(ctx, route.flight_id, route.origin, route.destination, action.newPremium);
            actions.push({
              flight: label,
              transition: `premium → $${baseUnitsToUsdc(action.newPremium)} (${action.reason})`,
            });
            break;
        }
      } catch (err) {
        console.error(`[route-agent] ${label}: Error — ${err}. Will retry next run.`);
        actions.push({ flight: label, error: String(err) });
      }
    }

    console.log(`[route-agent] Done. ${actions.length} route(s) evaluated.`);
    return {
      timestamp: new Date().toISOString(),
      job: "route_agent",
      duration_ms: Date.now() - start,
      success: true,
      actions,
    };
  } catch (err) {
    console.error(`[route-agent] Fatal error: ${err}`);
    return {
      timestamp: new Date().toISOString(),
      job: "route_agent",
      duration_ms: Date.now() - start,
      success: false,
      error: String(err),
      actions,
    };
  }
}
