/**
 * Preflight — every dependency of the soak, read-only, fail-fast.
 * Safe to run any time; writes nothing anywhere.
 */
import type { LiveConfig } from "../config.js";
import { Chain } from "../chain.js";
import { recentCronRuns, dbAvailable } from "../db.js";
import { loadLiveBoard, fetchCatalog } from "../flights.js";
import type { Journal } from "../journal.js";
import { journalCheck, journalSkip } from "../checks.js";

export async function preflight(cfg: LiveConfig, j: Journal): Promise<boolean> {
  const chain = new Chain(cfg);
  console.log("\n── preflight ────────────────────────────────────────────");

  // Deployed backend
  let health: Record<string, unknown> | null = null;
  try {
    const r = await fetch(`${cfg.backendUrl}/api/cron/health`, { signal: AbortSignal.timeout(30_000) });
    health = r.ok ? ((await r.json()) as Record<string, unknown>) : null;
  } catch {
    /* fallthrough */
  }
  journalCheck(j, "deployed /api/cron/health responds ok:true", health?.ok === true, JSON.stringify(health)?.slice(0, 200));
  const hasKeys = (health?.hasKeys ?? {}) as Record<string, boolean>;
  journalCheck(j, "backend has oracle+keeper+ttl keys", Boolean(hasKeys.oracle && hasKeys.keeper && hasKeys.ttl));
  const contractIds = (health?.contractIds ?? {}) as Record<string, string>;
  journalCheck(
    j,
    "backend contract IDs match harness config",
    contractIds.controller === cfg.contracts.controller && contractIds.oracleAggregator === cfg.contracts.oracle,
    `backend ctrl=${contractIds.controller?.slice(0, 8)}…`,
  );

  // ML service (no /health route — the docs page is the liveness probe)
  let mlUp = false;
  try {
    mlUp = (await fetch(cfg.renderHealthUrl, { signal: AbortSignal.timeout(30_000) })).ok;
  } catch {
    /* down */
  }
  journalCheck(j, "ML prediction service reachable", mlUp, cfg.renderHealthUrl);

  // RPC
  let rpcStatus = "unreachable";
  try {
    rpcStatus = await chain.health();
  } catch {
    /* down */
  }
  journalCheck(j, "soroban RPC healthy", rpcStatus === "healthy", rpcStatus);

  // DB + cron recency (2× cadence for the 5-min settle job)
  if (dbAvailable()) {
    const runs = await recentCronRuns(new Date(Date.now() - 30 * 60_000).toISOString());
    journalCheck(j, "governance DB reachable (cron_runs readable)", runs !== null);
    const settleFresh = runs?.some((r) => r.job === "settler") ?? false;
    journalCheck(j, "settle cron ran within the last 30min", settleFresh, `${runs?.length ?? 0} runs seen`);
  } else {
    journalSkip(j, "governance DB checks", "GOVERNANCE_DB_URL not set");
  }

  // Routes: full catalog served + spot-verified seeded on-chain
  let catalog: Awaited<ReturnType<typeof fetchCatalog>> = [];
  try {
    catalog = await fetchCatalog(cfg.backendUrl);
  } catch (err) {
    j.append("note", "catalog fetch failed", { error: String(err) });
  }
  const activeCatalog = catalog.filter((r) => r.status === "Active");
  journalCheck(
    j,
    "/api/routes serves the seeded catalog (≥800 Active)",
    activeCatalog.length >= 800,
    `${activeCatalog.length} Active of ${catalog.length}`,
  );
  // Spot-verify a deterministic sample against the chain (the catalog is
  // cached; the chain is truth) — every 97th row + the first/last.
  const sample = activeCatalog.filter((_, i) => i % 97 === 0 || i === activeCatalog.length - 1).slice(0, 12);
  let verified = 0;
  for (const r of sample) {
    try {
      if (String(await chain.routeStatus(r.flight_id, r.origin, r.destination)) === "Active") verified++;
    } catch {
      /* not on-chain */
    }
  }
  journalCheck(
    j,
    "catalog spot-check: sampled routes are Active on-chain",
    sample.length > 0 && verified === sample.length,
    `${verified}/${sample.length} verified`,
  );
  const featured = loadLiveBoard();
  journalCheck(j, "featured list (routes.live.json) present", featured.length >= 12, `${featured.length} featured`);

  // Whitelist posture (this run's locked decision: OFF)
  const wlOn = await chain.whitelistEnabled();
  journalCheck(j, "buyer whitelist DISABLED for this run", wlOn === false);

  const ok = j
    .entries()
    .filter((e) => e.kind === "check")
    .every((e) => e.data?.ok === true);
  j.append("note", "preflight complete", { ok });
  return ok;
}
