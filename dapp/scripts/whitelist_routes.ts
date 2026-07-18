/**
 * scripts/whitelist_routes.ts — sync GovernanceModule with
 * config/routes.testnet.json (the single human source of truth).
 *
 * Run:  npm run whitelist:routes            (listing + enable/disable only)
 *       npm run whitelist:routes -- --sync-terms   (also push file terms
 *                                            onto already-active routes —
 *                                            overwrites agent repricing!)
 *
 * Per route:
 *   enabled:true  + Unknown on-chain   → whitelist_route(file overrides)
 *   enabled:true  + Disabled on-chain  → enable_route (+ terms sync)
 *   enabled:true  + Active on-chain    → noop (or terms sync with the flag)
 *   enabled:false + Active on-chain    → disable_route
 *   enabled:false + otherwise          → noop
 *
 * Signs with GOVERNANCE_ADMIN_SECRET_KEY — an address the owner has added
 * via GovernanceModule.add_admin (or the owner itself). Whitelisting NEW
 * routes is deliberately script-only: the daily route agent never lists
 * routes, it only manages ones a human already listed.
 */
import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { loadConfig } from "../api/_lib/config";
import { SorobanClient } from "../api/_lib/soroban_client";
import {
  readRouteStatus,
  whitelistRoute,
  enableRoute,
  disableRoute,
  i128Update,
  u32Update,
  type GovernanceCtx,
} from "../api/_lib/governance";
import {
  loadRoutesConfig,
  fileTerms,
  usdcToBaseUnits,
  baseUnitsToUsdc,
} from "../api/_lib/routes_config";

// ── minimal .env loader (script-only; the Vercel functions use real env) ──
function loadDotEnv(): void {
  const envPath = resolve(dirname(fileURLToPath(import.meta.url)), "../.env");
  if (!existsSync(envPath)) return;
  for (const line of readFileSync(envPath, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*"?([^"\n]*)"?\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2];
  }
}

async function main(): Promise<void> {
  loadDotEnv();
  const syncTerms = process.argv.includes("--sync-terms");

  const config = loadConfig();
  if (!config.governanceAdminSecretKey) {
    throw new Error("GOVERNANCE_ADMIN_SECRET_KEY is not set");
  }

  const routesConfig = loadRoutesConfig();
  const client = new SorobanClient(config);
  const ctx: GovernanceCtx = {
    client,
    governanceId: config.governanceId,
    adminPublicKey: client.publicKeyFromSecret(config.governanceAdminSecretKey),
    adminSecretKey: config.governanceAdminSecretKey,
  };

  console.log(`Syncing ${routesConfig.routes.length} route(s) as admin ${ctx.adminPublicKey.slice(0, 8)}...`);
  let changed = 0;

  for (const route of routesConfig.routes) {
    const label = `${route.flight_id} ${route.origin}→${route.destination}`;
    const onChain = await readRouteStatus(ctx, route.flight_id, route.origin, route.destination);
    const terms = fileTerms(routesConfig, route);

    if (route.enabled) {
      if (onChain.status === "Unknown") {
        console.log(`  ${label}: whitelisting (premium=$${baseUnitsToUsdc(terms.premium)}, payoff=$${baseUnitsToUsdc(terms.payoff)}, delay=${terms.delayHours}h)`);
        await whitelistRoute(
          ctx,
          route.flight_id,
          route.origin,
          route.destination,
          route.overrides?.premium_usdc != null ? usdcToBaseUnits(route.overrides.premium_usdc) : null,
          route.overrides?.payoff_usdc != null ? usdcToBaseUnits(route.overrides.payoff_usdc) : null,
          route.overrides?.delay_hours ?? null
        );
        changed++;
      } else if (onChain.status === "Disabled") {
        console.log(`  ${label}: re-enabling`);
        await enableRoute(ctx, route.flight_id, route.origin, route.destination);
        changed++;
        if (syncTerms) await pushTerms(ctx, route, terms, label);
      } else if (syncTerms) {
        await pushTerms(ctx, route, terms, label);
      } else {
        console.log(`  ${label}: active — noop (terms managed by the route agent; use --sync-terms to force)`);
      }
    } else {
      if (onChain.status === "Active") {
        console.log(`  ${label}: disabling (enabled=false in routes file)`);
        await disableRoute(ctx, route.flight_id, route.origin, route.destination);
        changed++;
      } else {
        console.log(`  ${label}: enabled=false — noop (${onChain.status} on-chain)`);
      }
    }
  }

  console.log(`Done. ${changed} on-chain change(s).`);
}

async function pushTerms(
  ctx: GovernanceCtx,
  route: { flight_id: string; origin: string; destination: string; overrides: { premium_usdc?: number | null; payoff_usdc?: number | null; delay_hours?: number | null } | null },
  terms: { premium: bigint; payoff: bigint; delayHours: number },
  label: string
): Promise<void> {
  // Full three-field sync: Set() for file overrides, UseDefault for null
  // (so the on-chain fallback tracks the protocol defaults, same as the file).
  console.log(`  ${label}: syncing terms → premium=$${baseUnitsToUsdc(terms.premium)}, payoff=$${baseUnitsToUsdc(terms.payoff)}, delay=${terms.delayHours}h`);
  await ctx.client.invokeContract(
    ctx.governanceId,
    "update_route_terms",
    [
      ctx.client.addressToScVal(ctx.adminPublicKey),
      ctx.client.symbolToScVal(route.flight_id),
      ctx.client.symbolToScVal(route.origin),
      ctx.client.symbolToScVal(route.destination),
      i128Update(route.overrides?.premium_usdc != null ? usdcToBaseUnits(route.overrides.premium_usdc) : "use_default"),
      i128Update(route.overrides?.payoff_usdc != null ? usdcToBaseUnits(route.overrides.payoff_usdc) : "use_default"),
      u32Update(route.overrides?.delay_hours ?? "use_default"),
    ],
    ctx.adminSecretKey
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
