import express from "express";
import { createHash, timingSafeEqual } from "node:crypto";
import { Keypair } from "@stellar/stellar-sdk";
import type { Config, JobName, RunLogEntry } from "./types.js";
import { getLogs, getHealth, logRun } from "./run_log.js";
import { SorobanClient } from "./soroban_client.js";
import { tryRunExclusive } from "./job_lock.js";
import { runSaleAuthorizer } from "./sale_authorizer.js";
import { runFlightDataFetcher } from "./flight_data_fetcher.js";
import { runFlightClassifier } from "./flight_classifier.js";
import { runSettlementExecutor } from "./settlement_executor.js";
import { runQueueMaintainer } from "./queue_maintainer.js";
import { runTTLExtender } from "./ttl_extender.js";

// Sliding-window cap on manual trigger requests (all clients combined).
// The triggers run signer-backed jobs that spend fees and AeroAPI quota, so
// even authenticated callers get a modest ceiling; legitimate operations
// never need more than a few per minute.
const TRIGGER_WINDOW_MS = 60_000;
const TRIGGER_MAX_PER_WINDOW = 30;

export function startServer(config: Config): void {
  const app = express();
  const port = parseInt(process.env.PORT || "3002", 10);
  // Bind loopback unless the operator explicitly opts into another
  // interface. Node's default (no host argument) listens on ALL interfaces,
  // which silently exposed every signer-backed trigger to whatever network
  // could reach the port; reachability is now an intentional deployment
  // decision, with the firewall/container layer as defense-in-depth.
  const host = process.env.HOST || "127.0.0.1";
  // Operator credential for the manual trigger endpoints. No token means the
  // triggers are disabled (fail closed) — the cron scheduler keeps running
  // either way, so a missing token degrades ops convenience, never safety.
  const apiToken = process.env.EXECUTOR_API_TOKEN || "";
  // Browser-console origin, if one is actually used. Unset means no CORS
  // headers at all: non-browser clients are unaffected, and no third-party
  // web page can fire simple cross-origin POSTs at the trigger routes.
  const corsOrigin = process.env.CORS_ALLOWED_ORIGIN || "";
  const ttlExtenderAddress = Keypair.fromSecret(config.ttlExtenderSecretKey).publicKey();
  const sorobanClient = new SorobanClient(config);

  if (corsOrigin) {
    app.use((req, res, next) => {
      res.header("Access-Control-Allow-Origin", corsOrigin);
      res.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
      res.header("Access-Control-Allow-Headers", "Content-Type, Authorization");
      if (req.method === "OPTIONS") {
        res.sendStatus(204);
        return;
      }
      next();
    });
  }

  app.get("/api/health", async (_req, res) => {
    const health = getHealth();
    health.ttl_extender_address = ttlExtenderAddress;

    // Phase 11 — surface protocol state in the health round-trip. Best-effort;
    // failures don't break /api/health (network glitches shouldn't make the
    // executor look unhealthy).
    try {
      health.whitelist_enabled = await sorobanClient.readContract(
        config.controllerId,
        "whitelist_enabled",
      );
    } catch (err) {
      console.warn(`[server] whitelist_enabled read failed: ${err}`);
    }
    try {
      health.paused = await sorobanClient.readContract(
        config.controllerId,
        "paused",
      );
    } catch {
      // paused() may not be exposed depending on Pausable trait surface;
      // swallow silently rather than spamming logs.
    }

    res.json(health);
  });

  app.get("/api/logs", (_req, res) => {
    res.json(getLogs());
  });

  // ── Manual trigger endpoints ─────────────────────────────────────────
  // Every trigger runs a job that signs with a configured role key, so each
  // request must present the operator token, fit the rate window, and not
  // overlap an in-flight run of the same job.

  const triggerTimestamps: number[] = [];

  function underRateLimit(): boolean {
    const now = Date.now();
    while (triggerTimestamps.length > 0 && now - triggerTimestamps[0] > TRIGGER_WINDOW_MS) {
      triggerTimestamps.shift();
    }
    if (triggerTimestamps.length >= TRIGGER_MAX_PER_WINDOW) {
      return false;
    }
    triggerTimestamps.push(now);
    return true;
  }

  function authorized(req: express.Request): boolean {
    if (!apiToken) return false;
    const header = req.header("authorization") || "";
    const presented = header.startsWith("Bearer ") ? header.slice(7) : "";
    // Compare digests so length differences don't short-circuit the check.
    const a = createHash("sha256").update(presented).digest();
    const b = createHash("sha256").update(apiToken).digest();
    return timingSafeEqual(a, b);
  }

  function trigger(job: JobName, run: () => Promise<RunLogEntry>) {
    app.post(`/api/trigger/${job}`, async (req, res) => {
      if (!apiToken) {
        res.status(503).json({
          error: "manual triggers disabled: EXECUTOR_API_TOKEN is not configured",
        });
        return;
      }
      if (!authorized(req)) {
        res.status(401).json({ error: "missing or invalid bearer token" });
        return;
      }
      if (!underRateLimit()) {
        res.status(429).json({ error: "trigger rate limit exceeded" });
        return;
      }
      try {
        const entry = await tryRunExclusive(job, run);
        if (entry === null) {
          res.status(409).json({ error: `${job} is already running` });
          return;
        }
        logRun(entry);
        res.json(entry);
      } catch (err) {
        res.status(500).json({ error: String(err) });
      }
    });
  }

  trigger("sale_authorizer", () => runSaleAuthorizer(config));
  trigger("fetcher", () => runFlightDataFetcher(config));
  trigger("classifier", () => runFlightClassifier(config));
  trigger("settler", () => runSettlementExecutor(config));
  trigger("queue_maintainer", () => runQueueMaintainer(config));
  trigger("ttl_extender", () => runTTLExtender(config));

  app.listen(port, host, () => {
    console.log(`[server] API listening on http://${host}:${port}`);
    console.log(`[server]   GET  /api/health`);
    console.log(`[server]   GET  /api/logs`);
    console.log(`[server]   POST /api/trigger/{sale_authorizer,fetcher,classifier,settler,queue_maintainer,ttl_extender}`);
    if (!apiToken) {
      console.log(`[server]   (manual triggers disabled — set EXECUTOR_API_TOKEN to enable)`);
    }
  });
}
