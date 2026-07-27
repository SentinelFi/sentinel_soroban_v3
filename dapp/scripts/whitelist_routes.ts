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
 * routes stays script/gov_onboard-driven; the route agent never lists.
 *
 * 2026-07-27: ported onto GovSubmitter (generated bindings + before/after
 * snapshots + best-effort actions_log) — the same audited choke point the
 * reconciler and admin console use. The legacy hand-rolled ScVal helpers
 * are gone.
 */
import { loadDotEnv } from "./env";
loadDotEnv();

import { GovSubmitter } from "../api/_lib/governance/submitter";
import {
  loadRoutesConfig,
  fileTerms,
  usdcToBaseUnits,
  baseUnitsToUsdc,
  type RouteEntry,
} from "../api/_lib/routes_config";

async function main(): Promise<void> {
  const syncTerms = process.argv.includes("--sync-terms");

  const adminSecretKey = process.env.GOVERNANCE_ADMIN_SECRET_KEY;
  if (!adminSecretKey) {
    throw new Error("GOVERNANCE_ADMIN_SECRET_KEY is not set");
  }

  const routesConfig = loadRoutesConfig();
  const submitter = new GovSubmitter({
    rpcUrl: process.env.STELLAR_RPC_URL ?? "https://soroban-testnet.stellar.org",
    networkPassphrase:
      process.env.STELLAR_NETWORK_PASSPHRASE ?? "Test SDF Network ; September 2015",
    governanceId:
      process.env.GOVERNANCE_ID ?? "CANSHOFUFZPLZPCVUQYL3LBO25FW5BP6AEVAMNN2QS2BINGDIVZVEWYZ",
    adminSecretKey,
    actor: "script:whitelist",
  });

  console.log(`Syncing ${routesConfig.routes.length} route(s)...`);
  let changed = 0;

  for (const route of routesConfig.routes) {
    const label = `${route.flight_id} ${route.origin}→${route.destination}`;
    const key = { flightId: route.flight_id, origin: route.origin, dest: route.destination };
    const onChain = await submitter.readStatus(key);
    const terms = fileTerms(routesConfig, route);

    if (route.enabled) {
      if (onChain.status === "Unknown") {
        console.log(`  ${label}: whitelisting (premium=$${baseUnitsToUsdc(terms.premium)}, payoff=$${baseUnitsToUsdc(terms.payoff)}, delay=${terms.delayHours}h)`);
        await submitter.whitelist(
          key,
          route.overrides?.premium_usdc != null ? usdcToBaseUnits(route.overrides.premium_usdc) : null,
          route.overrides?.payoff_usdc != null ? usdcToBaseUnits(route.overrides.payoff_usdc) : null,
          route.overrides?.delay_hours ?? null
        );
        changed++;
      } else if (onChain.status === "Disabled") {
        console.log(`  ${label}: re-enabling`);
        await submitter.enable(key);
        changed++;
        if (syncTerms) await pushTerms(submitter, route, terms, label);
      } else if (syncTerms) {
        await pushTerms(submitter, route, terms, label);
      } else {
        console.log(`  ${label}: active — noop (terms managed by governance; use --sync-terms to force)`);
      }
    } else {
      if (onChain.status === "Active") {
        console.log(`  ${label}: disabling (enabled=false in routes file)`);
        await submitter.disable(key);
        changed++;
      } else {
        console.log(`  ${label}: enabled=false — noop (${onChain.status} on-chain)`);
      }
    }
  }

  console.log(`Done. ${changed} on-chain change(s).`);
  process.exit(0); // GovSubmitter's DB pool would otherwise hold the process open
}

async function pushTerms(
  submitter: GovSubmitter,
  route: RouteEntry,
  terms: { premium: bigint; payoff: bigint; delayHours: number },
  label: string
): Promise<void> {
  // Full three-field sync: Set() for file overrides, UseDefault for null
  // (so the on-chain fallback tracks the protocol defaults, same as the file).
  console.log(`  ${label}: syncing terms → premium=$${baseUnitsToUsdc(terms.premium)}, payoff=$${baseUnitsToUsdc(terms.payoff)}, delay=${terms.delayHours}h`);
  await submitter.updateTerms(
    { flightId: route.flight_id, origin: route.origin, dest: route.destination },
    route.overrides?.premium_usdc != null ? usdcToBaseUnits(route.overrides.premium_usdc) : "use_default",
    route.overrides?.payoff_usdc != null ? usdcToBaseUnits(route.overrides.payoff_usdc) : "use_default",
    route.overrides?.delay_hours ?? "use_default"
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
