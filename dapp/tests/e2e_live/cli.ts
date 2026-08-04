/**
 * e2e_live CLI — verbs: start | check | watch | report | smoke
 *   npx tsx tests/e2e_live/cli.ts <verb> [--run <id>] [--interval <min>]
 *
 * start  preflight → actors → underwriting → first check pass
 * check  idempotent catch-up pass (read + due actions) — safe to spam
 * watch  check every N minutes (default 20)
 * report reconcile evidence → runs/<id>/report.html
 * smoke  read-only pass against the DEPLOYED frontend (no signer)
 */
import { loadLiveConfig } from "./config.js";
import { Journal } from "./journal.js";
import { summarize } from "./checks.js";
import { TOTAL_PLANNED_BUYS, loadOrCreateActors } from "./actors.js";
import { preflight } from "./scenarios/preflight.js";
import { setupActors } from "./scenarios/setup_actors.js";
import { underwrite } from "./scenarios/underwrite.js";
import { checkPass } from "./scenarios/poll.js";
import { smoke } from "./scenarios/smoke.js";
import { buildReport } from "./report/html.js";
import { closeDb } from "./db.js";
import { startUiServer, type UiServer } from "./browser/server.js";
import { launchBrowser } from "./browser/context.js";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function withUi<T>(fn: (browser: Awaited<ReturnType<typeof launchBrowser>>, uiUrl: string) => Promise<T>): Promise<T> {
  const cfg = loadLiveConfig();
  let server: UiServer | null = null;
  const browser = await launchBrowser(cfg.headful);
  try {
    server = await startUiServer({ backendUrl: cfg.backendUrl });
    return await fn(browser, server.url);
  } finally {
    await browser.close().catch(() => {});
    await server?.stop().catch(() => {});
  }
}

async function main(): Promise<number> {
  const verb = process.argv[2] ?? "check";
  const cfg = loadLiveConfig();

  switch (verb) {
    case "start": {
      const j = Journal.create(TOTAL_PLANNED_BUYS, cfg.soakHours);
      console.log(`run ${j.runId} created (${TOTAL_PLANNED_BUYS} buys planned, ${cfg.soakHours}h window)`);
      const ok = await preflight(cfg, j);
      if (!ok) {
        console.error("\npreflight FAILED — fix the environment and rerun start (a new run id is fine).");
        return summarize();
      }
      const st = j.state();
      st.phase = "preflight_ok";
      j.saveState(st);
      return withUi(async (browser, uiUrl) => {
        const actors = await setupActors(cfg, j, browser, uiUrl);
        const st2 = j.state();
        st2.phase = "actors_ready";
        j.saveState(st2);
        await underwrite(cfg, j, browser, uiUrl, actors);
        const st3 = j.state();
        st3.phase = "underwriting";
        j.saveState(st3);
        await checkPass(cfg, j, browser, uiUrl, actors);
        const st4 = j.state();
        st4.phase = "soaking";
        j.saveState(st4);
        console.log("\nstart complete — buys unlock once seeding is verified AND the 6h LP delay mints shares.");
        return summarize();
      });
    }

    case "check": {
      const j = Journal.open(arg("run"));
      return withUi(async (browser, uiUrl) => {
        const actors = loadOrCreateActors();
        await checkPass(cfg, j, browser, uiUrl, actors);
        return summarize();
      });
    }

    case "watch": {
      const j = Journal.open(arg("run"));
      const intervalMin = Number(arg("interval") ?? 20);
      // Sequential loop — a pass must finish before the next starts.
      for (;;) {
        await withUi(async (browser, uiUrl) => {
          const actors = loadOrCreateActors();
          await checkPass(cfg, j, browser, uiUrl, actors);
        });
        console.log(`\n(watch) next pass in ${intervalMin}min — ctrl-c to stop, nothing is lost.`);
        await new Promise((r) => setTimeout(r, intervalMin * 60_000));
      }
    }

    case "report": {
      const j = Journal.open(arg("run"));
      const path = await buildReport(cfg, j);
      console.log(`report: ${path}`);
      return summarize();
    }

    case "smoke": {
      let j: Journal;
      try {
        j = Journal.open(arg("run"));
      } catch {
        j = Journal.create(0, 0);
      }
      await smoke(cfg, j);
      return summarize();
    }

    default:
      console.error(`unknown verb "${verb}" — use start|check|watch|report|smoke`);
      return 2;
  }
}

main()
  .then(async (code) => {
    await closeDb();
    process.exit(code);
  })
  .catch(async (err) => {
    console.error(err);
    await closeDb();
    process.exit(1);
  });
