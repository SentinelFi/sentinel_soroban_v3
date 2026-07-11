import express from "express";
import { Keypair } from "@stellar/stellar-sdk";
import type { Config } from "./types.js";
import { getLogs, getHealth, logRun } from "./run_log.js";
import { SorobanClient } from "./soroban_client.js";
import { runSaleAuthorizer } from "./sale_authorizer.js";
import { runFlightDataFetcher } from "./flight_data_fetcher.js";
import { runFlightClassifier } from "./flight_classifier.js";
import { runSettlementExecutor } from "./settlement_executor.js";
import { runQueueMaintainer } from "./queue_maintainer.js";
import { runTTLExtender } from "./ttl_extender.js";

export function startServer(config: Config): void {
  const app = express();
  const port = parseInt(process.env.PORT || "3002", 10);
  const ttlExtenderAddress = Keypair.fromSecret(config.ttlExtenderSecretKey).publicKey();
  const sorobanClient = new SorobanClient(config);

  // CORS
  app.use((_req, res, next) => {
    res.header("Access-Control-Allow-Origin", "*");
    res.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.header("Access-Control-Allow-Headers", "Content-Type");
    if (_req.method === "OPTIONS") {
      res.sendStatus(204);
      return;
    }
    next();
  });

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

  // Manual trigger endpoints
  app.post("/api/trigger/sale_authorizer", async (_req, res) => {
    try {
      const entry = await runSaleAuthorizer(config);
      logRun(entry);
      res.json(entry);
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  app.post("/api/trigger/fetcher", async (_req, res) => {
    try {
      const entry = await runFlightDataFetcher(config);
      logRun(entry);
      res.json(entry);
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  app.post("/api/trigger/classifier", async (_req, res) => {
    try {
      const entry = await runFlightClassifier(config);
      logRun(entry);
      res.json(entry);
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  app.post("/api/trigger/settler", async (_req, res) => {
    try {
      const entry = await runSettlementExecutor(config);
      logRun(entry);
      res.json(entry);
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  app.post("/api/trigger/queue_maintainer", async (_req, res) => {
    try {
      const entry = await runQueueMaintainer(config);
      logRun(entry);
      res.json(entry);
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  app.post("/api/trigger/ttl_extender", async (_req, res) => {
    try {
      const entry = await runTTLExtender(config);
      logRun(entry);
      res.json(entry);
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  app.listen(port, () => {
    console.log(`[server] API listening on http://localhost:${port}`);
    console.log(`[server]   GET  /api/health`);
    console.log(`[server]   GET  /api/logs`);
    console.log(`[server]   POST /api/trigger/{sale_authorizer,fetcher,classifier,settler,queue_maintainer,ttl_extender}`);
  });
}
