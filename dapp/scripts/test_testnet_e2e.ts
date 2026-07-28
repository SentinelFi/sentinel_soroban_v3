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
 *     (on-time / delayed / cancelled) through the REAL contract state
 *     machine, including everything FakeSoroban cannot prove: purchase
 *     flow (sale-auth gate, premium transfer, vault lock), timestamp
 *     validation, batch keeper jobs, settlement money movement, claims.
 *
 * TWO PHASES, because the real oracle enforces date ≤ ETA ≤ date+3d and
 * date ≤ actual_arrival (a purchasable flight's date is always in the
 * future, so its landing physically cannot be attested until the flight
 * day arrives — FakeSoroban never modeled this; this suite caught it):
 *
 *   BUY DAY    — whitelist fresh routes, authorize sales, buy 3 policies,
 *                fetcher writes ETAs (pinned to 00:06 on the flight day);
 *                the CANCELLED flight settles + claims fully (set_cancelled
 *                has no timestamp), keeper jobs sweep.
 *   FLIGHT DAY — from ~01:08 UTC on the flight's date: fetcher attests
 *                both landings, targeted classify+settle, batch keeper
 *                jobs, delayed claim pays, on-time claim rejected.
 *
 * The suite auto-detects the phase from the cached pending-run state and
 * tells you when the flight-day phase becomes runnable. `--abandon`
 * drops a stuck pending run (safe — every run uses fresh idents).
 *
 * One-time setup:  npm run test:e2e:testnet:bootstrap  (+ ~6h deposit ripen)
 * Run:             npm run test:e2e:testnet             (each phase)
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
  type E2eDeployment,
} from "./e2e/testnet_bootstrap";
import { SorobanClient } from "../api/_lib/soroban_client";
import { parseFlightStatus } from "../api/_lib/status";
import { FlightStatus, type Config } from "../api/_lib/types";
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
// ETA pinned 6 min after the flight day's midnight: satisfies the oracle's
// date ≤ eta bound while making landings attestable from eta+1h ≈ 01:08.
const ETA_AFTER_MIDNIGHT_SECS = 360;
const RESUME_MARGIN_SECS = 120;

/** Variant name of a unit-enum ScVal in any scValToNative shape. */
function variantName(raw: any): string {
  if (typeof raw === "string") return raw;
  if (Array.isArray(raw)) return String(raw[0]);
  if (raw && typeof raw === "object") return Object.keys(raw)[0] ?? "";
  return String(raw);
}

interface Ctx {
  d: E2eDeployment;
  config: Config;
  client: SorobanClient;
  mock: MockHandle;
  buyerPub: string;
  ownerPub: string;
  premium: bigint;
  payoff: bigint;
}

function helpers(ctx: Ctx) {
  const { client, config, d } = ctx;
  const sym = (s: string) => client.symbolToScVal(s);
  const u64 = (v: bigint) => client.u64ToScVal(v);
  const addr = (a: string) => client.addressToScVal(a);
  return {
    sym,
    u64,
    addr,
    none: xdr.ScVal.scvVoid(),
    readOracle: (fn: string, args: xdr.ScVal[] = []) =>
      client.readContract(config.oracleAggregatorId, fn, args),
    flightData: (id: string, date: bigint) =>
      client.readContract(config.oracleAggregatorId, "get_flight_data", [sym(id), u64(date)]),
    oracleStatus: async (id: string, date: bigint) =>
      parseFlightStatus(
        (await client.readContract(config.oracleAggregatorId, "get_flight_data", [sym(id), u64(date)])).status
      ),
    poolConfig: (id: string, date: bigint) =>
      client.readContract(config.flightPoolManagerId, "get_flight_config", [sym(id), u64(date)]),
    usdcBalance: async (of: string): Promise<bigint> =>
      BigInt(await client.readContract(d.usdcId, "balance", [addr(of)])),
    claim: (id: string, date: bigint) =>
      client.invokeContract(
        config.flightPoolManagerId,
        "claim",
        [addr(ctx.buyerPub), sym(id), u64(date)],
        d.buyerSecret
      ),
  };
}

// ---------------------------------------------------------------------------
// Phase 1 — BUY DAY
// ---------------------------------------------------------------------------

async function buyDayPhase(ctx: Ctx): Promise<void> {
  const { d, config, client, mock, premium, payoff } = ctx;
  const h = helpers(ctx);

  // ── capital: mint the ripened vault deposit via the REAL queue job ──────
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

  // ── fresh idents + routes for this run ──────────────────────────────────
  const n = 100 + d.runCounter * 3;
  d.runCounter += 1;
  saveDeployment(d);
  const ON_TIME = `ZZ${n}`;
  const DELAYED = `ZZ${n + 1}`;
  const CANCELLED = `ZZ${n + 2}`;
  const idents = [ON_TIME, DELAYED, CANCELLED];
  const nowSecs = Math.floor(Date.now() / 1000);
  const date = BigInt((Math.floor(nowSecs / DAY) + 1) * DAY); // tomorrow UTC
  const schedEpoch = Number(date) + ETA_AFTER_MIDNIGHT_SECS;
  console.log(
    `\nRun #${d.runCounter}: ${idents.join(", ")} @ ${new Date(Number(date) * 1000).toISOString().slice(0, 10)}`
  );

  console.log("\n── governance: whitelist this run's routes ──────────────");
  for (const id of idents) {
    await client.invokeContract(
      config.governanceId,
      "whitelist_route",
      [h.addr(ctx.ownerPub), h.sym(id), h.sym("JFK"), h.sym("LAX"), h.none, h.none, h.none],
      d.ownerSecret
    );
  }
  const routeStatus = await client.readContract(config.governanceId, "route_status", [
    h.sym(ON_TIME), h.sym("JFK"), h.sym("LAX"),
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

  // ── sale authorization (real authorizer, healthy schedules) ─────────────
  console.log("\n── sale authorizer (near window, real open_sale) ────────");
  await mock.setScenarios(Object.fromEntries(idents.map((id) => [id, { outcome: "scheduled" }])));
  const authRes = await authorizerRun(config);
  check("authorizer run succeeds", authRes.success, authRes.error ?? "");
  for (const id of idents) {
    const open = await h.readOracle("is_sale_open", [h.sym(id), h.u64(date)]);
    check(`${id}: sale window open for the flight day`, open === true, String(open));
  }

  // ── purchases (the real money path FakeSoroban can't prove) ─────────────
  console.log("\n── buy_insurance ×3 (real premium transfer + vault lock) ─");
  const buyerBefore = await h.usdcBalance(ctx.buyerPub);
  const lockedBefore = BigInt(await client.readContract(config.riskVaultId, "get_locked_capital"));
  for (const id of idents) {
    await client.invokeContract(
      config.controllerId,
      "buy_insurance",
      [h.addr(ctx.buyerPub), h.sym(id), h.sym("JFK"), h.sym("LAX"), h.u64(date)],
      d.buyerSecret
    );
  }
  const buyerAfterBuy = await h.usdcBalance(ctx.buyerPub);
  check(
    "buyer paid exactly 3 premiums",
    buyerBefore - buyerAfterBuy === 3n * premium,
    `Δ=${buyerBefore - buyerAfterBuy}`
  );
  const lockedAfter = BigInt(await client.readContract(config.riskVaultId, "get_locked_capital"));
  check("vault locked 3 payoffs", lockedAfter - lockedBefore === 3n * payoff, `Δ=${lockedAfter - lockedBefore}`);
  for (const id of idents) {
    check(
      `${id}: registered in oracle active set (NotInitiated)`,
      (await h.readOracle("is_flight_listed", [h.sym(id), h.u64(date)])) === true &&
        (await h.oracleStatus(id, date)) === FlightStatus.NotInitiated
    );
  }

  // ── the world moves: outcomes become real ───────────────────────────────
  // ETAs pinned to 00:06 on the flight day — the real oracle enforces
  // date ≤ eta ≤ date+3d (this suite caught FakeSoroban not modeling it).
  await mock.setScenarios({
    [ON_TIME]: { outcome: "on_time", sched_in_epoch_secs: schedEpoch },
    [DELAYED]: { outcome: "delayed", delay_minutes: 180, sched_in_epoch_secs: schedEpoch },
    [CANCELLED]: { outcome: "cancelled" },
  });

  // ── fetcher: ETA writes + corroborated cancellation settles ─────────────
  console.log("\n── fetcher (ETA writes; cancellation settles same day) ──");
  const fetch1 = await fetcherRun(config);
  check("fetcher run succeeds", fetch1.success, fetch1.error ?? "");
  for (const id of [ON_TIME, DELAYED]) {
    const fd = await h.flightData(id, date);
    check(
      `${id}: NotInitiated → Active, ETA accepted by the real oracle (00:06 flight day)`,
      parseFlightStatus(fd.status) === FlightStatus.Active && BigInt(fd.estimated_arrival_time) === BigInt(schedEpoch),
      `status=${variantName(fd.status)} eta=${fd.estimated_arrival_time}`
    );
  }
  const cancelledStatus = await h.oracleStatus(CANCELLED, date);
  check(
    `${CANCELLED}: corroborated cancellation settled end-to-end (targeted)`,
    cancelledStatus === FlightStatus.Settled,
    cancelledStatus
  );
  const cancelledCfg = await h.poolConfig(CANCELLED, date);
  check(
    `${CANCELLED}: pool outcome SettledCancelled`,
    variantName(cancelledCfg?.status) === "SettledCancelled",
    variantName(cancelledCfg?.status)
  );

  // ── the cancelled claim pays TODAY (no timestamps involved) ─────────────
  console.log("\n── cancelled claim (payout money moves) ─────────────────");
  try {
    await h.claim(CANCELLED, date);
    const afterClaim = await h.usdcBalance(ctx.buyerPub);
    check("cancelled claim paid the full payoff", afterClaim - buyerAfterBuy === payoff, `Δ=${afterClaim - buyerAfterBuy}`);
  } catch (err) {
    check("cancelled claim paid the full payoff", false, String(err).slice(0, 140));
  }

  // ── keeper sweeps are clean with two flights still in-flight ────────────
  console.log("\n── batch keeper jobs (buy-day sweep) ────────────────────");
  const classRes = await classifierRun(config);
  check("classifier sweep succeeds (nothing classifiable yet)", classRes.success, classRes.error ?? "");
  const settleRes = await settlerRun(config);
  check("settler sweep succeeds", settleRes.success, settleRes.error ?? "");
  const pending = await h.readOracle("has_pending_outcomes");
  check("no pending outcomes (barrier clear)", pending === false, String(pending));

  // ── persist the pending run for the flight-day phase ────────────────────
  const resumeAt = schedEpoch + 3600 + RESUME_MARGIN_SECS;
  d.pending = {
    onTime: ON_TIME,
    delayed: DELAYED,
    cancelled: CANCELLED,
    date: date.toString(),
    schedEpoch,
    resumeAt,
  };
  saveDeployment(d);
  console.log(
    `\nBuy-day phase complete. Flight-day phase (landings + remaining claims) ` +
      `runnable from ${new Date(resumeAt * 1000).toISOString()} — rerun ` +
      `\`npm run test:e2e:testnet\` then (within ~10 days; the claim window ` +
      `is 24h from settlement).`
  );
}

// ---------------------------------------------------------------------------
// Phase 2 — FLIGHT DAY
// ---------------------------------------------------------------------------

async function flightDayPhase(ctx: Ctx): Promise<void> {
  const { d, config, client, mock, payoff } = ctx;
  const h = helpers(ctx);
  const p = d.pending!;
  const date = BigInt(p.date);
  console.log(
    `\nResuming run: ${p.onTime}/${p.delayed}/${p.cancelled} @ ${new Date(Number(date) * 1000)
      .toISOString()
      .slice(0, 10)}`
  );

  // Same pinned schedule as the buy day — the mock's actual_in derives from
  // it, consistent with the ETA already on-chain.
  await mock.setScenarios({
    [p.onTime]: { outcome: "on_time", sched_in_epoch_secs: p.schedEpoch },
    [p.delayed]: { outcome: "delayed", delay_minutes: 180, sched_in_epoch_secs: p.schedEpoch },
    [p.cancelled]: { outcome: "cancelled" },
  });

  // ── fetcher: landings through the real state machine ────────────────────
  console.log("\n── fetcher (landings; targeted classify+settle) ─────────");
  const fetch2 = await fetcherRun(config);
  check("fetcher run succeeds", fetch2.success, fetch2.error ?? "");
  check(`${p.onTime}: Settled on-chain`, (await h.oracleStatus(p.onTime, date)) === FlightStatus.Settled);
  check(`${p.delayed}: Settled on-chain`, (await h.oracleStatus(p.delayed, date)) === FlightStatus.Settled);
  const onTimeCfg = await h.poolConfig(p.onTime, date);
  const delayedCfg = await h.poolConfig(p.delayed, date);
  check(
    `${p.onTime}: pool outcome SettledOnTime (landed −5min < ${d.delayHours}h threshold)`,
    variantName(onTimeCfg?.status) === "SettledOnTime",
    variantName(onTimeCfg?.status)
  );
  check(
    `${p.delayed}: pool outcome SettledDelayed (180m ≥ ${d.delayHours}h threshold)`,
    variantName(delayedCfg?.status) === "SettledDelayed",
    variantName(delayedCfg?.status)
  );

  // ── batch keeper jobs on the real chain ─────────────────────────────────
  console.log("\n── batch keeper jobs (classifier / settler / queue / ttl) ");
  const classRes = await classifierRun(config);
  check("classifier sweep succeeds (post-settlement no-op)", classRes.success, classRes.error ?? "");
  const settleRes = await settlerRun(config);
  check("settler sweep succeeds (pre-flight skip, nothing pending)", settleRes.success, settleRes.error ?? "");
  const pendingOutcomes = await h.readOracle("has_pending_outcomes");
  check("no pending outcomes (settlement barrier lifted)", pendingOutcomes === false, String(pendingOutcomes));
  const queue2 = await queueRun(config);
  check("queue-maintenance succeeds post-settlement", queue2.success, queue2.error ?? "");
  const ttlRes = await ttlRun(config);
  check("ttl-extender succeeds (instance extends; DB-only sweeps skip)", ttlRes.success, ttlRes.error ?? "");

  // ── claims: the payout money actually moves ─────────────────────────────
  console.log("\n── claims ───────────────────────────────────────────────");
  const beforeClaims = await h.usdcBalance(ctx.buyerPub);
  try {
    await h.claim(p.delayed, date);
    const afterDelayed = await h.usdcBalance(ctx.buyerPub);
    check("delayed claim paid the full payoff", afterDelayed - beforeClaims === payoff, `Δ=${afterDelayed - beforeClaims}`);
  } catch (err) {
    check("delayed claim paid the full payoff", false, String(err).slice(0, 140));
  }
  let onTimeClaimRejected = false;
  let rejection = "";
  try {
    await h.claim(p.onTime, date);
  } catch (err) {
    onTimeClaimRejected = true;
    rejection = String(err);
  }
  check(
    "on-time claim rejected by the contract (premium stays as vault yield)",
    onTimeClaimRejected && rejection.includes("[simulation]"),
    rejection.slice(0, 120)
  );

  d.pending = null;
  saveDeployment(d);
}

// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const d = loadDeployment();
  if (!d || !d.depositReadyAt) {
    console.error(`No cached e2e deployment (${CACHE_PATH}).`);
    console.error("Run: npm run test:e2e:testnet:bootstrap");
    process.exit(2);
  }

  if (process.argv.includes("--abandon") && d.pending) {
    console.log(`Abandoning pending run ${d.pending.onTime}/${d.pending.delayed}/${d.pending.cancelled}.`);
    d.pending = null;
    saveDeployment(d);
    return;
  }

  const phase = d.pending ? "flight-day" : "buy-day";
  if (d.pending && Math.floor(Date.now() / 1000) < d.pending.resumeAt) {
    const left = d.pending.resumeAt - Math.floor(Date.now() / 1000);
    console.log(
      `Pending run ${d.pending.onTime}/${d.pending.delayed}/${d.pending.cancelled}: flight-day phase ` +
        `runnable in ~${Math.ceil(left / 60)} min (${new Date(d.pending.resumeAt * 1000).toISOString()}). ` +
        `Use --abandon to drop it.`
    );
    process.exit(2);
  }

  const mock = await startMock(PORT);
  console.log(`mock-aeroapi up on :${PORT} — ${phase} phase`);
  const config = deploymentConfig(d, mock.base);
  process.env.ROUTES_CONFIG_PATH = ROUTES_PATH;
  const client = new SorobanClient(config);
  const ctx: Ctx = {
    d,
    config,
    client,
    mock,
    buyerPub: client.publicKeyFromSecret(d.buyerSecret),
    ownerPub: client.publicKeyFromSecret(d.ownerSecret),
    premium: BigInt(d.premium),
    payoff: BigInt(d.payoff),
  };

  try {
    if (phase === "buy-day") await buyDayPhase(ctx);
    else await flightDayPhase(ctx);
  } finally {
    mock.stop();
  }

  process.exit(summarize());
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
