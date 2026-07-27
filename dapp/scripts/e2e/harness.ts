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

import { spawn, type ChildProcess } from "child_process";
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
  // Spawn from dapp/ (tsx is a devDependency there) with an absolute path.
  const child: ChildProcess = spawn("npx", ["tsx", join(MOCK_DIR, "src", "server.ts")], {
    cwd: join(REPO_ROOT, "dapp"),
    env: { ...process.env, PORT: String(port) },
    stdio: "ignore",
  });
  const base = `http://localhost:${port}`;

  const deadline = Date.now() + timeoutMs;
  let up = false;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`${base}/__stats`);
      if (r.ok) {
        up = true;
        break;
      }
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  if (!up) {
    child.kill();
    throw new Error("mock-aeroapi did not come up in time");
  }

  return {
    base,
    stop: () => child.kill(),
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
