/**
 * Local vite dev-server driver for the live-soak browser layer.
 *
 * Spawns the dapp's own vite (from the dapp root) with the two env knobs the
 * harness relies on:
 *   - PUBLIC_E2E_SIGNER=1  → enables src/util/e2eSigner.ts (localStorage-seeded
 *     keypair signer; statically dead-code-eliminated in prod builds)
 *   - E2E_PROXY_TARGET     → vite.config.ts proxies "/api" at this backend
 *
 * Same process-tree hygiene as scripts/e2e/harness.ts startMock: clear stale
 * squatters on the port first, spawn detached (own process group), kill the
 * whole group on stop().
 */
import { execSync, spawn, type ChildProcess } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// tests/e2e_live/browser/server.ts → dapp/
const DAPP_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

const DEFAULT_PORT = 5199;
const STARTUP_TIMEOUT_MS = 30_000;

export interface UiServer {
  url: string;
  stop(): Promise<void>;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export async function startUiServer(opts: { backendUrl: string; port?: number }): Promise<UiServer> {
  const port = opts.port ?? DEFAULT_PORT;

  // A previous run's vite can survive its parent's kill (the npx wrapper dies,
  // the vite grandchild keeps the port) and then serve STALE code while our
  // fresh child dies on --strictPort. Clear the port before spawning.
  try {
    const stale = execSync(`lsof -ti tcp:${port}`, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] })
      .split("\n")
      .filter(Boolean);
    if (stale.length > 0) {
      console.warn(`[ui-server] killing stale process(es) on :${port}: ${stale.join(", ")}`);
      execSync(`kill ${stale.join(" ")}`, { stdio: "ignore" });
      await sleep(500);
    }
  } catch {
    /* lsof exits 1 when the port is free — nothing to clear */
  }

  const child: ChildProcess = spawn("npx", ["vite", "--port", String(port), "--strictPort"], {
    cwd: DAPP_ROOT,
    env: {
      ...process.env,
      PUBLIC_E2E_SIGNER: "1",
      E2E_PROXY_TARGET: opts.backendUrl,
    },
    stdio: "ignore",
    detached: true,
  });

  let exited = false;
  child.on("exit", () => {
    exited = true;
  });

  const url = `http://localhost:${port}`;

  const stop = async (): Promise<void> => {
    try {
      process.kill(-child.pid!, "SIGTERM"); // whole process group
    } catch {
      try {
        child.kill();
      } catch {
        /* already gone */
      }
    }
    const deadline = Date.now() + 5_000;
    while (!exited && Date.now() < deadline) await sleep(100);
    if (!exited) {
      try {
        process.kill(-child.pid!, "SIGKILL");
      } catch {
        /* already gone */
      }
    }
  };

  const deadline = Date.now() + STARTUP_TIMEOUT_MS;
  let up = false;
  while (Date.now() < deadline) {
    if (exited) break;
    try {
      const res = await fetch(url);
      // drain so the connection is released
      await res.text().catch(() => {});
      if (res.status === 200) {
        up = true;
        break;
      }
    } catch {
      /* not up yet */
    }
    await sleep(300);
  }
  if (!up) {
    await stop();
    throw new Error(
      exited
        ? `vite exited before serving on :${port} (port taken, or vite missing from node_modules?)`
        : `vite did not answer HTTP 200 on ${url} within ${STARTUP_TIMEOUT_MS / 1000}s`,
    );
  }

  return { url, stop };
}
