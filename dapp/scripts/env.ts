import { existsSync, readFileSync } from "fs";
import { dirname, resolve } from "path";
import { fileURLToPath } from "url";

/**
 * Minimal dapp/.env loader for the CLI scripts (bots, discovery,
 * whitelist). The Vercel functions use real project env — this is for
 * local single-shot runs only. Real env vars always win (never
 * overwritten), so `AEROAPI_KEY=x npm run bot -- fetcher` still works.
 */
export function loadDotEnv(): void {
  const envPath = resolve(dirname(fileURLToPath(import.meta.url)), "../.env");
  if (!existsSync(envPath)) return;
  for (const line of readFileSync(envPath, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*"?([^"\n]*)"?\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2];
  }
}
