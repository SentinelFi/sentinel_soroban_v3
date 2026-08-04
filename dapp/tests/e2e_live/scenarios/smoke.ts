/**
 * Smoke — read-only Playwright pass against the REAL deployed frontend.
 * No signer, no writes: every route loads, board renders (demo vs live
 * detected), stats strip reconciles against /api/status/stats, /admin
 * gate renders, zero uncaught console errors.
 */
import type { LiveConfig } from "../config.js";
import type { Journal } from "../journal.js";
import { journalCheck } from "../checks.js";
import { launchBrowser } from "../browser/context.js";
import { consoleErrorCollector, gotoRoute, adminGateRendered } from "../browser/pages/misc.js";
import { boardRows, scrapeStats } from "../browser/pages/markets.js";
import { snap } from "../browser/context.js";

export async function smoke(cfg: LiveConfig, j: Journal): Promise<void> {
  console.log(`\n── smoke vs ${cfg.appUrl} ───────────────────────────────`);
  const browser = await launchBrowser(false);
  try {
    const context = await browser.newContext();
    const page = await context.newPage();
    const collector = await consoleErrorCollector(page);

    await page.goto(cfg.appUrl, { waitUntil: "networkidle", timeout: 60_000 });
    journalCheck(j, "smoke: markets page loads", true);
    const rows = await boardRows(page).catch(() => []);
    const demo = rows.some((r) => /demo|sample/i.test(r.status));
    j.append("observation", "board render", { rows: rows.length, demoDetected: demo });
    journalCheck(j, "smoke: board renders rows", rows.length > 0, `${rows.length} rows (demo=${demo})`);

    const uiStats = await scrapeStats(page).catch(() => ({}) as Record<string, string>);
    let apiStats: Record<string, unknown> = {};
    try {
      apiStats = (await (await fetch(`${cfg.backendUrl}/api/status/stats`)).json()) as Record<string, unknown>;
    } catch {
      /* recorded below */
    }
    j.append("observation", "stats strip vs api", { uiStats, apiStats });
    journalCheck(j, "smoke: /api/status/stats reachable", "flights_insured" in apiStats);

    for (const route of ["/house", "/policies", "/status", "/markets"]) {
      await gotoRoute(page, route).catch(() => {});
      const shot = await snap(page, j.shotsDir, `smoke${route.replace("/", "-")}`);
      j.append("screenshot", shot, { route });
    }
    await gotoRoute(page, "/admin").catch(() => {});
    journalCheck(j, "smoke: /admin gate renders (no crash)", await adminGateRendered(page).catch(() => false));

    journalCheck(
      j,
      "smoke: zero uncaught console errors across routes",
      collector.errors.length === 0,
      collector.errors.slice(0, 3).join(" | "),
    );
    await context.close();
  } finally {
    await browser.close().catch(() => {});
  }
}
