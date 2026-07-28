/**
 * Shared E2E harness — check/report plumbing + mock-aeroapi lifecycle.
 *
 * Used by BOTH suites:
 *   scripts/test_oracle_e2e.ts   — hermetic (FakeSoroban, no chain)
 *   scripts/test_testnet_e2e.ts  — real chain (dedicated testnet deployment)
 *
 * The mock server (tools/mock-aeroapi) is spawned on a caller-chosen port so
 * the two suites can never collide.
 */

import { execSync, spawn, type ChildProcess } from "child_process";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = join(__dirname, "..", "..", "..");
const MOCK_DIR = join(REPO_ROOT, "tools", "mock-aeroapi");

// ---------------------------------------------------------------------------
// Check/report plumbing
// ---------------------------------------------------------------------------

export interface CheckResult {
  name: string;
  ok: boolean;
  detail?: string;
}

export const results: CheckResult[] = [];

export function check(name: string, ok: boolean, detail?: string): void {
  results.push({ name, ok, detail });
  console.log(`${ok ? "  ✓" : "  ✗"} ${name}${!ok && detail ? ` — ${detail}` : ""}`);
}

/** Print the tally and return the process exit code. */
export function summarize(): number {
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed.`);
  if (failed.length > 0) {
    console.log("\nFailed:");
    for (const f of failed) console.log(`  ✗ ${f.name}${f.detail ? ` — ${f.detail}` : ""}`);
  }
  return failed.length === 0 ? 0 : 1;
}

// ---------------------------------------------------------------------------
// mock-aeroapi lifecycle
// ---------------------------------------------------------------------------

export interface MockHandle {
  base: string;
  stop: () => void;
  reset: () => Promise<void>;
  stats: () => Promise<{ flights: number; schedules: number; byIdent: Record<string, number> }>;
  /** Merge runtime scenario overrides (see server.ts POST /__scenarios). */
  setScenarios: (scenarios: Record<string, unknown>) => Promise<void>;
}

export async function startMock(port: number, timeoutMs = 15_000): Promise<MockHandle> {
  // A previous run's mock can survive its parent's kill (npx wrapper dies,
  // the tsx grandchild keeps the port) and then silently serve STALE code +
  // STALE scenario overrides while our fresh child dies on EADDRINUSE —
  // observed live. Defense in depth: clear the port first, spawn detached
  // (own process group, killable as a tree), and verify via an instance
  // token that the server answering is the one WE spawned.
  try {
    const stale = execSync(`lsof -ti tcp:${port}`, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] })
      .split("\n")
      .filter(Boolean);
    if (stale.length > 0) {
      console.warn(`[harness] killing stale process(es) on :${port}: ${stale.join(", ")}`);
      execSync(`kill ${stale.join(" ")}`, { stdio: "ignore" });
      await new Promise((r) => setTimeout(r, 500));
    }
  } catch {
    /* lsof exits 1 when the port is free — nothing to clear */
  }

  const instance = `mock-${process.pid}-${Date.now()}`;
  // Spawn from dapp/ (tsx is a devDependency there) with an absolute path.
  const child: ChildProcess = spawn("npx", ["tsx", join(MOCK_DIR, "src", "server.ts")], {
    cwd: join(REPO_ROOT, "dapp"),
    env: { ...process.env, PORT: String(port), MOCK_INSTANCE: instance },
    stdio: "ignore",
    detached: true,
  });
  const stop = () => {
    try {
      process.kill(-child.pid!, "SIGTERM"); // whole process group
    } catch {
      child.kill();
    }
  };
  const base = `http://localhost:${port}`;

  const deadline = Date.now() + timeoutMs;
  let up = false;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`${base}/__stats`);
      if (r.ok) {
        const body = (await r.json()) as { instance?: string | null };
        if (body.instance === instance) {
          up = true;
          break;
        }
        // Someone else is answering — a stale server we failed to clear.
        stop();
        throw new Error(`another mock-aeroapi is squatting on :${port} (instance=${body.instance}) — kill it and rerun`);
      }
    } catch (err) {
      if (String(err).includes("squatting")) throw err;
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  if (!up) {
    stop();
    throw new Error("mock-aeroapi did not come up in time");
  }

  return {
    base,
    stop,
    reset: async () => {
      await fetch(`${base}/__reset`, { method: "POST" });
    },
    stats: async () => {
      const r = await fetch(`${base}/__stats`);
      return (await r.json()) as {
        flights: number;
        schedules: number;
        byIdent: Record<string, number>;
      };
    },
    setScenarios: async (scenarios) => {
      const r = await fetch(`${base}/__scenarios`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(scenarios),
      });
      if (!r.ok) throw new Error(`mock /__scenarios failed: HTTP ${r.status}`);
    },
  };
}
