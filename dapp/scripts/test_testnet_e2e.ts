/**
 * REAL-CHAIN end-to-end tests — the same oracle/keeper pipeline as
 * test_oracle_e2e.ts, but against the REAL Rust contracts on Stellar
 * testnet (a dedicated throwaway deployment — never the live one) instead
 * of FakeSoroban. AeroAPI stays mocked (tools/mock-aeroapi): the flight
 * world is scripted; the chain is not.
 *
 *   real fetcher/authorizer/classifier/settler/queue/ttl job code
 *     → real AeroApiClient over HTTP → mock-aeroapi (runtime scenarios)
 *     → real SorobanClient → REAL contracts on testnet
 *
 * Division of labor with the hermetic suite (no duplicated coverage):
 *   - hermetic (fast gate): breadth — call economy, corroboration edge
 *     cases (tracking-lost, ambiguous, diverted), visibility gates,
 *     authorizer near/far windows + steady state, gov collectors.
 *   - THIS suite (slow, occasional): depth — the three OUTCOME paths
 *     (on-time / delayed / cancelled) driven through the REAL contract
 *     state machine including everything FakeSoroban cannot prove:
 *     purchase flow (sale-auth gate, premium transfer, vault lock),
 *     batch keeper jobs, settlement money movement, and claims.
 *
 * Per-run isolation: fresh flight idents each run (ZZ<n>..ZZ<n+2>) on
 * fresh whitelisted routes, flight date = tomorrow UTC. Scenario times are
 * pinned relative to NOW (sched_in_offset_secs) so watch/landed gates open
 * immediately.
 *
 * One-time setup:  npm run test:e2e:testnet:bootstrap   (then wait ~6h for
 * the vault deposit to ripen — the suite tells you how long is left)
 * Run:             npm run test:e2e:testnet
 */

// Same no-DB contract as the hermetic suite: a leaked GOVERNANCE_DB_URL
// would flip the authorizer to the LIVE routes table.
delete process.env.GOVERNANCE_DB_URL;
delete process.env.SALE_AUTH_DEMAND_MODE;
delete process.env.SALE_AUTH_HORIZON_DAYS;

import { writeFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { xdr } from "@stellar/stellar-sdk";
import { check, startMock, summarize, type MockHandle } from "./e2e/harness";
import {
  loadDeployment,
  saveDeployment,
  deploymentConfig,
  CACHE_PATH,
} from "./e2e/testnet_bootstrap";
import { SorobanClient } from "../api/_lib/soroban_client";
import { parseFlightStatus } from "../api/_lib/status";
import { FlightStatus } from "../api/_lib/types";
import { run as authorizerRun } from "../api/_lib/jobs/authorizer";
import { run as fetcherRun } from "../api/_lib/jobs/fetcher";
import { run as classifierRun } from "../api/_lib/jobs/classifier";
import { run as settlerRun } from "../api/_lib/jobs/settler";
import { run as queueRun } from "../api/_lib/jobs/queue";
import { run as ttlRun } from "../api/_lib/jobs/ttl";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = 3112; // distinct from the hermetic suite's 3111
const DAY = 86_400;
const ROUTES_PATH = join(__dirname, "e2e", ".routes.testnet-e2e.json");

/** Variant name of a unit-enum ScVal in any scValToNative shape. */
function variantName(raw: any): string {
  if (typeof raw === "string") return raw;
  if (Array.isArray(raw)) return String(raw[0]);
  if (raw && typeof raw === "object") return Object.keys(raw)[0] ?? "";
  return String(raw);
}

async function main(): Promise<void> {
  const d = loadDeployment();
  if (!d || !d.depositReadyAt) {
    console.error(`No cached e2e deployment (${CACHE_PATH}).`);
    console.error("Run: npm run test:e2e:testnet:bootstrap");
    process.exit(2);
  }

  const mock: MockHandle = await startMock(PORT);
  console.log(`mock-aeroapi up on :${PORT}`);
  const config = deploymentConfig(d, mock.base);
  const client = new SorobanClient(config);
  const sym = (s: string) => client.symbolToScVal(s);
  const addr = (a: string) => client.addressToScVal(a);
  const u64 = (v: bigint) => client.u64ToScVal(v);
  const none = xdr.ScVal.scvVoid(); // Option::None

  const readOracle = (fn: string, args: xdr.ScVal[] = []) =>
    client.readContract(config.oracleAggregatorId, fn, args);
  const flightData = async (id: string, date: bigint) =>
    readOracle("get_flight_data", [sym(id), u64(date)]);
  const oracleStatus = async (id: string, date: bigint) =>
    parseFlightStatus((await flightData(id, date)).status);
  const poolConfig = (id: string, date: bigint) =>
    client.readContract(config.flightPoolManagerId, "get_flight_config", [sym(id), u64(date)]);
  const usdcBalance = async (of: string): Promise<bigint> =>
    BigInt(await client.readContract(d.usdcId, "balance", [addr(of)]));

  const ownerPub = client.publicKeyFromSecret(d.ownerSecret);
  const buyerPub = client.publicKeyFromSecret(d.buyerSecret);
  const premium = BigInt(d.premium);
  const payoff = BigInt(d.payoff);

  try {
    // ── 0. Capital: mint the ripened vault deposit via the REAL queue job ──
    console.log("\n── capital (queue-maintenance keeper job) ───────────────");
    const queueRes = await queueRun(config);
    check("queue-maintenance job succeeds", queueRes.success, queueRes.error ?? "");
    const tma = BigInt(await client.readContract(config.riskVaultId, "get_total_managed_assets"));
    if (tma < 3n * payoff) {
      const left = d.depositReadyAt - Math.floor(Date.now() / 1000);
      console.error(
        `\nVault TMA=${tma} < ${3n * payoff} needed. The bootstrap deposit ` +
          (left > 0
            ? `ripens in ~${Math.ceil(left / 60)} min (LP pricing delay) — rerun after that.`
            : `should have ripened — investigate (deposit queue/barrier).`)
      );
      process.exit(2);
    }
    check(`vault capitalized (TMA=${tma})`, true);

    // ── 1. Fresh idents + routes for this run ─────────────────────────────
    const n = 100 + d.runCounter * 3;
    d.runCounter += 1;
    saveDeployment(d);
    const ON_TIME = `ZZ${n}`;
    const DELAYED = `ZZ${n + 1}`;
    const CANCELLED = `ZZ${n + 2}`;
    const idents = [ON_TIME, DELAYED, CANCELLED];
    const nowSecs = Math.floor(Date.now() / 1000);
    const date = BigInt((Math.floor(nowSecs / DAY) + 1) * DAY); // tomorrow UTC
    console.log(`\nRun #${d.runCounter}: ${idents.join(", ")} @ ${new Date(Number(date) * 1000).toISOString().slice(0, 10)}`);

    console.log("\n── governance: whitelist this run's routes ──────────────");
    for (const id of idents) {
      await client.invokeContract(
        config.governanceId,
        "whitelist_route",
        [addr(ownerPub), sym(id), sym("JFK"), sym("LAX"), none, none, none],
        d.ownerSecret
      );
    }
    const routeStatus = await client.readContract(config.governanceId, "route_status", [
      sym(ON_TIME), sym("JFK"), sym("LAX"),
    ]);
    check("routes whitelisted Active on-chain", variantName(routeStatus) === "Active", variantName(routeStatus));

    // Routes file for the authorizer (file mode — no DB in this suite).
    writeFileSync(
      ROUTES_PATH,
      JSON.stringify({
        network: "testnet-e2e",
        defaults: { premium_usdc: 45, payoff_usdc: 450, delay_hours: d.delayHours },
        rails: {
          premium_usdc: { min: 10, max: 100 },
          payoff_usdc: { min: 100, max: 1000 },
          max_daily_premium_change_pct: 50,
          elevated_weather_multiplier: 1.25,
        },
        sale_horizon_days: 2,
        routes: idents.map((id) => ({
          flight_id: id, carrier: "ZZ", origin: "JFK", destination: "LAX",
          enabled: true, overrides: null,
        })),
      }, null, 2)
    );
    process.env.ROUTES_CONFIG_PATH = ROUTES_PATH;

    // ── 2. Sale authorization (real authorizer, healthy schedules) ────────
    console.log("\n── sale authorizer (near window, real open_sale) ────────");
    await mock.setScenarios(Object.fromEntries(idents.map((id) => [id, { outcome: "scheduled" }])));
    const authRes = await authorizerRun(config);
    check("authorizer run succeeds", authRes.success, authRes.error ?? "");
    for (const id of idents) {
      const open = await readOracle("is_sale_open", [sym(id), u64(date)]);
      check(`${id}: sale window open for tomorrow`, open === true, String(open));
    }

    // ── 3. Purchases (the real money path FakeSoroban can't prove) ────────
    console.log("\n── buy_insurance ×3 (real premium transfer + vault lock) ─");
    const buyerBefore = await usdcBalance(buyerPub);
    const lockedBefore = BigInt(await client.readContract(config.riskVaultId, "get_locked_capital"));
    for (const id of idents) {
      await client.invokeContract(
        config.controllerId,
        "buy_insurance",
        [addr(buyerPub), sym(id), sym("JFK"), sym("LAX"), u64(date)],
        d.buyerSecret
      );
    }
    const buyerAfterBuy = await usdcBalance(buyerPub);
    check(
      "buyer paid exactly 3 premiums",
      buyerBefore - buyerAfterBuy === 3n * premium,
      `Δ=${buyerBefore - buyerAfterBuy}`
    );
    const lockedAfter = BigInt(await client.readContract(config.riskVaultId, "get_locked_capital"));
    check(
      "vault locked 3 payoffs",
      lockedAfter - lockedBefore === 3n * payoff,
      `Δ=${lockedAfter - lockedBefore}`
    );
    for (const id of idents) {
      check(
        `${id}: registered in oracle active set (NotInitiated)`,
        (await readOracle("is_flight_listed", [sym(id), u64(date)])) === true &&
          (await oracleStatus(id, date)) === FlightStatus.NotInitiated
      );
    }

    // ── 4. The world moves: outcomes become real ──────────────────────────
    // Schedules pinned 4h in the past so watch (ETA−6h) and landed (ETA+1h)
    // gates are already open; the cancellation needs no time pinning.
    await mock.setScenarios({
      [ON_TIME]: { outcome: "on_time", sched_in_offset_secs: -14_400 },
      [DELAYED]: { outcome: "delayed", delay_minutes: 180, sched_in_offset_secs: -14_400 },
      [CANCELLED]: { outcome: "cancelled" },
    });

    // ── 5. Fetcher run 1: ETA writes + corroborated cancellation ──────────
    console.log("\n── fetcher run 1 (ETA writes; cancellation settles) ─────");
    const fetch1 = await fetcherRun(config);
    check("fetcher run 1 succeeds", fetch1.success, fetch1.error ?? "");
    check(`${ON_TIME}: NotInitiated → Active`, (await oracleStatus(ON_TIME, date)) === FlightStatus.Active);
    check(`${DELAYED}: NotInitiated → Active`, (await oracleStatus(DELAYED, date)) === FlightStatus.Active);
    const cancelledStatus = await oracleStatus(CANCELLED, date);
    check(
      `${CANCELLED}: corroborated cancellation settled end-to-end (targeted)`,
      cancelledStatus === FlightStatus.Settled,
      cancelledStatus
    );
    const cancelledCfg = await poolConfig(CANCELLED, date);
    check(
      `${CANCELLED}: pool outcome SettledCancelled`,
      variantName(cancelledCfg?.status) === "SettledCancelled",
      variantName(cancelledCfg?.status)
    );

    // ── 6. Fetcher run 2: landings resolve through the real state machine ─
    console.log("\n── fetcher run 2 (landings; targeted classify+settle) ───");
    const fetch2 = await fetcherRun(config);
    check("fetcher run 2 succeeds", fetch2.success, fetch2.error ?? "");
    check(`${ON_TIME}: Settled on-chain`, (await oracleStatus(ON_TIME, date)) === FlightStatus.Settled);
    check(`${DELAYED}: Settled on-chain`, (await oracleStatus(DELAYED, date)) === FlightStatus.Settled);
    const onTimeCfg = await poolConfig(ON_TIME, date);
    const delayedCfg = await poolConfig(DELAYED, date);
    check(
      `${ON_TIME}: pool outcome SettledOnTime (landed −5min < ${d.delayHours}h threshold)`,
      variantName(onTimeCfg?.status) === "SettledOnTime",
      variantName(onTimeCfg?.status)
    );
    check(
      `${DELAYED}: pool outcome SettledDelayed (180m ≥ ${d.delayHours}h threshold)`,
      variantName(delayedCfg?.status) === "SettledDelayed",
      variantName(delayedCfg?.status)
    );

    // ── 7. Batch keeper jobs on the real chain (untested anywhere else) ───
    console.log("\n── batch keeper jobs (classifier / settler / queue) ─────");
    const classRes = await classifierRun(config);
    check("classifier sweep succeeds (post-settlement no-op)", classRes.success, classRes.error ?? "");
    const settleRes = await settlerRun(config);
    check("settler sweep succeeds (pre-flight skip, nothing pending)", settleRes.success, settleRes.error ?? "");
    const pending = await readOracle("has_pending_outcomes");
    check("no pending outcomes (settlement barrier lifted)", pending === false, String(pending));
    const queue2 = await queueRun(config);
    check("queue-maintenance succeeds post-settlement", queue2.success, queue2.error ?? "");
    const ttlRes = await ttlRun(config);
    check("ttl-extender succeeds (instance extends; DB-only sweeps skip)", ttlRes.success, ttlRes.error ?? "");

    // ── 8. Claims: the payout money actually moves ────────────────────────
    console.log("\n── claims ───────────────────────────────────────────────");
    for (const id of [DELAYED, CANCELLED]) {
      await client.invokeContract(
        config.flightPoolManagerId,
        "claim",
        [addr(buyerPub), sym(id), u64(date)],
        d.buyerSecret
      );
    }
    const buyerFinal = await usdcBalance(buyerPub);
    check(
      "delayed + cancelled claims each paid the full payoff",
      buyerFinal - buyerAfterBuy === 2n * payoff,
      `Δ=${buyerFinal - buyerAfterBuy}`
    );
    let onTimeClaimRejected = false;
    let rejection = "";
    try {
      await client.invokeContract(
        config.flightPoolManagerId,
        "claim",
        [addr(buyerPub), sym(ON_TIME), u64(date)],
        d.buyerSecret
      );
    } catch (err) {
      onTimeClaimRejected = true;
      rejection = String(err);
    }
    check(
      "on-time claim rejected by the contract (premium stays as vault yield)",
      onTimeClaimRejected && rejection.includes("[simulation]"),
      rejection.slice(0, 120)
    );
  } finally {
    mock.stop();
  }

  process.exit(summarize());
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
