/**
 * COMPREHENSIVE REAL-CHAIN E2E — real contracts on testnet, mock AeroAPI,
 * the DEPLOYED ML prediction service, and NO DATABASE.
 *
 *   real authorizer/fetcher/classifier/settler/queue/ttl job code
 *     → real AeroApiClient over HTTP → mock-aeroapi (runtime scenarios)
 *     → real SorobanClient / GovSubmitter → REAL contracts (throwaway
 *       deployment from e2e/testnet_bootstrap.ts — never the live one)
 *     → real https://flight-delay-predictions.onrender.com for pricing
 *
 * DELIBERATELY DB-LESS: proves the DB-optional invariant end to end.
 * Governance here is driven the way manual-mode governance actually works
 * (admin/owner calls through GovSubmitter — the same audited choke point
 * the reconciler uses); the signals/collectors/reconciler pipeline is the
 * WITH-DB suite, tested separately.
 *
 * Scenario list (also documented in spec/architecture.md, E2E section):
 *
 * A. Flight outcomes (delay threshold 3h, payoff $100):
 *   A1 lands 5min early            → SettledOnTime, claim REJECTED
 *   A2 lands 3h30 late (>3h)       → SettledDelayed, claim pays $100
 *   A3 lands 2h00 late (<3h)       → SettledOnTime, claim REJECTED
 *   A4 cancelled (corroborated)    → SettledCancelled same day, claim pays
 *   A5 diverted (corroborated)     → pays as cancellation, claim pays,
 *                                    never attested as landed
 *   A6 tracking-lost (bare flag)   → NO tombstone, zero settle txs; then
 *                                    tracking recovers → settles normally
 *
 * B. Sales/purchase coupling:
 *   B1 real authorizer opens windows (is_sale_open) before purchase
 *   B2 every purchase pays EXACTLY the current on-chain premium and locks
 *      exactly the payoff in the vault
 *   B3 purchase against a disabled route FAILS at the contract gate
 *
 * C. Governance (manual mode — owner via GovSubmitter, no DB):
 *   C1 storm: disable_route → buy fails → RECOVERY: enable_route → same
 *      buy succeeds (the storm-passed scenario)
 *   C2 elevated: premium ×1.25 on-chain → a purchase opening a FRESH
 *      flight bucket pays the higher premium, while a buyer joining an
 *      ALREADY-OPEN bucket still pays its snapshotted price (the pool
 *      snapshots terms at first purchase — every buyer of one flight-date
 *      pays the same premium; run #3 discovered this) → revert → base
 *
 * E. Pricing via the DEPLOYED ML API:
 *   E1 live /predict call → anchor = clampPremium(expectedLossPremiumUnits
 *      (p, $100), rails) computed with the REAL protocol functions →
 *      pushed on-chain → a purchase pays exactly the model-derived premium
 *   E2 degradation: dead AGENT_BASE_URL → predict() returns null, no throw
 *
 * G. Keeper sweeps + accounting:
 *   G1 classifier/settler/queue/ttl succeed; settler pre-flight skip;
 *      has_pending_outcomes false at the end
 *   G2 money conservation: buyer net Δ = payoffs − premiums exactly;
 *      vault locked returns to its pre-run level
 *
 * TWO PHASES (the real oracle enforces date ≤ ETA / date ≤ actual, so
 * landings can only be attested on the flight day):
 *   BUY DAY    — setup, sales, purchases, all governance scenarios, and
 *                the cancelled/diverted settlements + claims.
 *   FLIGHT DAY — from ~01:08 UTC on the flight date: the three landings,
 *                tracking-lost recovery, remaining claims, final ledger.
 *
 * One-time setup:  npm run test:e2e:testnet:bootstrap  (+ ~6h deposit ripen)
 * Run:             npm run test:e2e:testnet             (each phase)
 * Drop a stuck run: npm run test:e2e:testnet -- --abandon
 */

// The no-DB contract is the point of this suite — enforce it.
delete process.env.GOVERNANCE_DB_URL;
delete process.env.SALE_AUTH_DEMAND_MODE;
delete process.env.SALE_AUTH_HORIZON_DAYS;

import { writeFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
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
import { GovSubmitter } from "../api/_lib/governance/submitter";
import { AgentClient } from "../api/_lib/agent_client";
import { expectedLossPremiumUnits, clampPremium } from "../api/_lib/route_rules";
import type { RouteRails } from "../api/_lib/routes_config";
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
const ML_BASE = process.env.E2E_ML_BASE_URL ?? "https://flight-delay-predictions.onrender.com";

// Product terms for this suite: $15 base premium, $100 payoff, 3h delay
// threshold (matches the live product + the ML model's 180-min target).
const UNIT = 10_000_000n;
const BASE_PREMIUM = 15n * UNIT;
const PAYOFF = 100n * UNIT;
const DELAY_HOURS = 3;
const ELEVATED_PREMIUM = (BASE_PREMIUM * 125n) / 100n; // ×1.25 = $18.75
const RAILS: RouteRails = {
  premiumMin: 10n * UNIT,
  premiumMax: 30n * UNIT,
  payoffMin: 100n * UNIT,
  payoffMax: 1000n * UNIT,
  maxDailyPremiumChangePct: 50,
  elevatedWeatherMultiplier: 1.25,
};

// ETA pinned 6 min after the flight day's midnight: satisfies the oracle's
// date ≤ eta bound while making landings attestable from eta+1h ≈ 01:08.
const ETA_AFTER_MIDNIGHT_SECS = 360;
const RESUME_MARGIN_SECS = 120;

const ROLES = [
  "onTime", // A1
  "delayed210", // A2 (3h30 > 3h)
  "delayed120", // A3 (2h00 < 3h)
  "cancelled", // A4
  "diverted", // A5
  "lost", // A6
  "govStorm", // C1
  "govPrice", // C2 (bucket opened at base — snapshot keeps its price)
  "govPrice2", // C2 (bucket opened while elevated — pays ×1.25)
  "govMl", // E1
] as const;
type Role = (typeof ROLES)[number];

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
  submitter: GovSubmitter;
  mock: MockHandle;
  buyerPub: string;
  ownerPub: string;
}

function makeHelpers(ctx: Ctx) {
  const { client, config, d } = ctx;
  const sym = (s: string) => client.symbolToScVal(s);
  const u64 = (v: bigint) => client.u64ToScVal(v);
  const addr = (a: string) => client.addressToScVal(a);
  return {
    sym,
    u64,
    addr,
    readOracle: (fn: string, args: any[] = []) =>
      client.readContract(config.oracleAggregatorId, fn, args),
    oracleStatus: async (id: string, date: bigint) =>
      parseFlightStatus(
        (
          await client.readContract(config.oracleAggregatorId, "get_flight_data", [
            sym(id),
            u64(date),
          ])
        ).status
      ),
    flightData: (id: string, date: bigint) =>
      client.readContract(config.oracleAggregatorId, "get_flight_data", [sym(id), u64(date)]),
    poolConfig: (id: string, date: bigint) =>
      client.readContract(config.flightPoolManagerId, "get_flight_config", [sym(id), u64(date)]),
    usdcBalance: async (of: string): Promise<bigint> =>
      BigInt(await client.readContract(d.usdcId, "balance", [addr(of)])),
    lockedCapital: async (): Promise<bigint> =>
      BigInt(await client.readContract(config.riskVaultId, "get_locked_capital")),
    buy: (traveler: { pub: string; secret: string }, id: string, date: bigint) =>
      client.invokeContract(
        config.controllerId,
        "buy_insurance",
        [addr(traveler.pub), sym(id), sym("JFK"), sym("LAX"), u64(date)],
        traveler.secret
      ),
    claim: (id: string, date: bigint) =>
      client.invokeContract(
        config.flightPoolManagerId,
        "claim",
        [addr(ctx.buyerPub), sym(id), u64(date)],
        d.buyerSecret
      ),
  };
}

type Helpers = ReturnType<typeof makeHelpers>;

/** Assert a purchase moves exactly `premium` from the traveler. */
async function buyAndAssertPremium(
  h: Helpers,
  traveler: { pub: string; secret: string },
  id: string,
  date: bigint,
  premium: bigint,
  label: string
): Promise<void> {
  const before = await h.usdcBalance(traveler.pub);
  await h.buy(traveler, id, date);
  const after = await h.usdcBalance(traveler.pub);
  check(`${label}: purchase paid exactly ${Number(premium) / 1e7} USDC`, before - after === premium, `Δ=${before - after}`);
}

/** Owner-only set_defaults on the e2e module (idempotent). */
async function ensureDefaults(ctx: Ctx): Promise<void> {
  const { client, config, d } = ctx;
  const cur = await client.readContract(config.governanceId, "get_defaults");
  const [p, po, dh] = [BigInt(cur[0]), BigInt(cur[1]), Number(cur[2])];
  if (p === BASE_PREMIUM && po === PAYOFF && dh === DELAY_HOURS) {
    check("module defaults already $15/$100/3h", true);
    return;
  }
  await client.invokeContract(
    config.governanceId,
    "set_defaults",
    [client.i128ToScVal(BASE_PREMIUM), client.i128ToScVal(PAYOFF), client.u32ToScVal(DELAY_HOURS)],
    d.ownerSecret
  );
  const now = await client.readContract(config.governanceId, "get_defaults");
  check(
    "module defaults set to $15/$100/3h (owner set_defaults)",
    BigInt(now[0]) === BASE_PREMIUM && BigInt(now[1]) === PAYOFF && Number(now[2]) === DELAY_HOURS,
    String(now)
  );
}

/** Warm the Render free-tier service (cold start ≈ 1 min > client timeout). */
async function warmMlService(): Promise<boolean> {
  for (let i = 0; i < 15; i++) {
    try {
      const r = await fetch(`${ML_BASE}/healthz`, { signal: AbortSignal.timeout(10_000) });
      if (r.ok) return true;
    } catch {
      /* cold-starting */
    }
    await new Promise((r) => setTimeout(r, 8_000));
  }
  return false;
}

// ---------------------------------------------------------------------------
// Phase 1 — BUY DAY
// ---------------------------------------------------------------------------

async function buyDayPhase(ctx: Ctx): Promise<void> {
  const { d, config, submitter, mock } = ctx;
  const h = makeHelpers(ctx);
  const buyer = { pub: ctx.buyerPub, secret: d.buyerSecret };
  const owner = { pub: ctx.ownerPub, secret: d.ownerSecret };

  // ── capital: mint any ripened vault deposit via the REAL queue job ──────
  console.log("\n── capital (queue-maintenance keeper job) ───────────────");
  const queueRes = await queueRun(config);
  check("queue-maintenance job succeeds", queueRes.success, queueRes.error ?? "");
  const tma = BigInt(await ctx.client.readContract(config.riskVaultId, "get_total_managed_assets"));
  const locked0 = await h.lockedCapital();
  if (tma - locked0 < 10n * PAYOFF) {
    console.error(`\nFree vault capital ${tma - locked0} < ${10n * PAYOFF} needed — top up or wait for deposit ripening.`);
    process.exit(2);
  }
  check(`vault capitalized (TMA=${tma}, locked=${locked0})`, true);

  // ── product terms on the e2e module ─────────────────────────────────────
  console.log("\n── governance defaults ($15/$100/3h) ────────────────────");
  await ensureDefaults(ctx);

  // ── fresh idents for this run ───────────────────────────────────────────
  const base = 1000 + d.runCounter * 10;
  d.runCounter += 1;
  saveDeployment(d);
  const F: Record<Role, string> = Object.fromEntries(
    ROLES.map((r, i) => [r, `ZZ${base + i}`])
  ) as Record<Role, string>;
  const nowSecs = Math.floor(Date.now() / 1000);
  const date = BigInt((Math.floor(nowSecs / DAY) + 1) * DAY); // tomorrow UTC
  const schedEpoch = Number(date) + ETA_AFTER_MIDNIGHT_SECS;
  console.log(`\nRun #${d.runCounter}: ${Object.values(F).join(", ")} @ ${new Date(Number(date) * 1000).toISOString().slice(0, 10)}`);

  // ── whitelist (UseDefault terms → $15/$100/3h) ──────────────────────────
  console.log("\n── whitelist 9 routes (terms from module defaults) ──────");
  for (const id of Object.values(F)) {
    await submitter.whitelist({ flightId: id, origin: "JFK", dest: "LAX" }, null, null, null);
  }
  const sample = await submitter.readStatus({ flightId: F.onTime, origin: "JFK", dest: "LAX" });
  check(
    "routes Active with resolved terms $15/$100/3h",
    sample.status === "Active" &&
      sample.terms?.premium === BASE_PREMIUM &&
      sample.terms?.payoff === PAYOFF &&
      sample.terms?.delayHours === DELAY_HOURS,
    JSON.stringify(sample, (_, v) => (typeof v === "bigint" ? String(v) : v))
  );

  // Routes file for the authorizer (file mode — the no-DB path).
  writeFileSync(
    ROUTES_PATH,
    JSON.stringify({
      network: "testnet-e2e",
      defaults: { premium_usdc: 15, payoff_usdc: 100, delay_hours: DELAY_HOURS },
      rails: {
        premium_usdc: { min: 10, max: 30 },
        payoff_usdc: { min: 100, max: 1000 },
        max_daily_premium_change_pct: 50,
        elevated_weather_multiplier: 1.25,
      },
      sale_horizon_days: 2,
      routes: Object.values(F).map((id) => ({
        flight_id: id, carrier: "ZZ", origin: "JFK", destination: "LAX",
        enabled: true, overrides: null,
      })),
    }, null, 2)
  );

  // ── B1: sale authorization (real authorizer, healthy schedules) ─────────
  console.log("\n── sale authorizer (near window, real open_sale) ────────");
  await mock.setScenarios(
    Object.fromEntries(
      Object.values(F).map((id) => [id, { outcome: "scheduled", sched_in_epoch_secs: schedEpoch }])
    )
  );
  const authRes = await authorizerRun(config);
  check("authorizer run succeeds", authRes.success, authRes.error ?? "");
  let allOpen = true;
  for (const id of Object.values(F)) {
    if ((await h.readOracle("is_sale_open", [h.sym(id), h.u64(date)])) !== true) allOpen = false;
  }
  check(`B1: sale windows open for all ${Object.values(F).length} flights`, allOpen);

  // ── B2: the six outcome purchases at base premium ───────────────────────
  console.log("\n── purchases (outcome flights, $15 each) ────────────────");
  const buyerStart = await h.usdcBalance(ctx.buyerPub);
  let buyerExpectedDelta = 0n;
  for (const role of ["onTime", "delayed210", "delayed120", "cancelled", "diverted", "lost"] as Role[]) {
    await buyAndAssertPremium(h, buyer, F[role], date, BASE_PREMIUM, `${F[role]} (${role})`);
    buyerExpectedDelta -= BASE_PREMIUM;
  }

  // ── C1: storm — disable, buy fails, recover, buy succeeds ───────────────
  console.log("\n── C1 storm: disable → buy fails → recover → buy ────────");
  await submitter.disable({ flightId: F.govStorm, origin: "JFK", dest: "LAX" });
  let stormRejected = false;
  let stormErr = "";
  try {
    await h.buy(buyer, F.govStorm, date);
  } catch (err) {
    stormRejected = true;
    stormErr = String(err);
  }
  check(
    "B3/C1: purchase on disabled route rejected by the contract",
    stormRejected && stormErr.includes("[simulation]"),
    stormErr.slice(0, 100)
  );
  await submitter.enable({ flightId: F.govStorm, origin: "JFK", dest: "LAX" });
  const recovered = await submitter.readStatus({ flightId: F.govStorm, origin: "JFK", dest: "LAX" });
  check("C1: route re-enabled after the storm passes", recovered.status === "Active", recovered.status);
  await buyAndAssertPremium(h, buyer, F.govStorm, date, BASE_PREMIUM, `${F.govStorm} (post-recovery)`);
  buyerExpectedDelta -= BASE_PREMIUM;

  // ── C2: elevated premium ×1.25 — snapshot vs fresh-bucket pricing ───────
  // The pool snapshots terms when a (flight, date) bucket is FIRST opened:
  // a later governance repricing changes what NEW buckets charge, never
  // what an already-open bucket's buyers pay (no mid-bucket price
  // discrimination — run #3 proved this on-chain).
  console.log("\n── C2 elevated: ×1.25 → fresh bucket pays it → revert ───");
  await buyAndAssertPremium(h, buyer, F.govPrice, date, BASE_PREMIUM, `${F.govPrice} (bucket opened @ base)`);
  buyerExpectedDelta -= BASE_PREMIUM;
  for (const id of [F.govPrice, F.govPrice2]) {
    await submitter.updateTerms({ flightId: id, origin: "JFK", dest: "LAX" }, ELEVATED_PREMIUM, "keep", "keep");
  }
  const elevated = await submitter.readStatus({ flightId: F.govPrice2, origin: "JFK", dest: "LAX" });
  check(
    "C2: on-chain premium elevated to $18.75 (×1.25)",
    elevated.terms?.premium === ELEVATED_PREMIUM,
    String(elevated.terms?.premium)
  );
  // Owner joins the ALREADY-OPEN govPrice bucket → pays its snapshot ($15).
  await buyAndAssertPremium(h, owner, F.govPrice, date, BASE_PREMIUM, `${F.govPrice} (owner joins open bucket — snapshot holds)`);
  // Buyer opens the FRESH govPrice2 bucket → pays the elevated $18.75.
  await buyAndAssertPremium(h, buyer, F.govPrice2, date, ELEVATED_PREMIUM, `${F.govPrice2} (fresh bucket @ elevated)`);
  buyerExpectedDelta -= ELEVATED_PREMIUM;
  for (const id of [F.govPrice, F.govPrice2]) {
    await submitter.revertTerms({ flightId: id, origin: "JFK", dest: "LAX" });
  }
  const reverted = await submitter.readStatus({ flightId: F.govPrice2, origin: "JFK", dest: "LAX" });
  check(
    "C2: premium reverted to base after conditions clear",
    reverted.terms?.premium === BASE_PREMIUM,
    String(reverted.terms?.premium)
  );

  // ── E1/E2: pricing via the DEPLOYED ML API ──────────────────────────────
  console.log("\n── E1 ML pricing (live flight-delay-predictions API) ────");
  const warmed = await warmMlService();
  check("live ML service reachable (/healthz, cold-start tolerated)", warmed);
  let mlPremium = BASE_PREMIUM; // fallback if service unreachable
  if (warmed) {
    const flightDay = new Date(Number(date) * 1000);
    const agent = new AgentClient(ML_BASE);
    const p = await agent.predict(
      {
        carrier: "ZZ",
        origin: "JFK",
        dest: "LAX",
        month: flightDay.getUTCMonth() + 1,
        day_of_month: flightDay.getUTCDate(),
        day_of_week: ((flightDay.getUTCDay() + 6) % 7) + 1,
        dep_time_hhmm: 2100,
        distance_mi: 2475,
      },
      F.govMl
    );
    check("E1: live /predict returned a probability", p !== null && p >= 0 && p <= 1, String(p));
    if (p !== null) {
      // The REAL protocol pricing functions — same code the cron runs.
      mlPremium = clampPremium(expectedLossPremiumUnits(p, PAYOFF), null, RAILS);
      console.log(`  p_covered=${p.toFixed(4)} → anchor=${Number(mlPremium) / 1e7} USDC`);
      await submitter.updateTerms({ flightId: F.govMl, origin: "JFK", dest: "LAX" }, mlPremium, "keep", "keep");
      const mlTerms = await submitter.readStatus({ flightId: F.govMl, origin: "JFK", dest: "LAX" });
      check("E1: model-derived premium on-chain", mlTerms.terms?.premium === mlPremium, String(mlTerms.terms?.premium));
    }
  }
  await buyAndAssertPremium(h, buyer, F.govMl, date, mlPremium, `${F.govMl} (ML-priced)`);
  buyerExpectedDelta -= mlPremium;

  const deadAgent = new AgentClient("http://127.0.0.1:9");
  const deadP = await deadAgent.predict(
    { carrier: "ZZ", origin: "JFK", dest: "LAX", month: 1, day_of_month: 1, day_of_week: 1 },
    "dead"
  );
  check("E2: dead ML endpoint degrades to null (no throw)", deadP === null, String(deadP));

  // ── B2: vault locked exactly 10 payoffs across the 10 policies ──────────
  const lockedAfterBuys = await h.lockedCapital();
  check(
    "B2: vault locked exactly 11 payoffs for 11 policies",
    lockedAfterBuys - locked0 === 11n * PAYOFF,
    `Δ=${lockedAfterBuys - locked0}`
  );

  // ── A4/A5/A6 setup: the world moves ─────────────────────────────────────
  await mock.setScenarios({
    [F.onTime]: { outcome: "on_time", sched_in_epoch_secs: schedEpoch },
    [F.delayed210]: { outcome: "delayed", delay_minutes: 210, sched_in_epoch_secs: schedEpoch },
    [F.delayed120]: { outcome: "delayed", delay_minutes: 120, sched_in_epoch_secs: schedEpoch },
    [F.cancelled]: { outcome: "cancelled" },
    [F.diverted]: { outcome: "diverted" },
    [F.lost]: { outcome: "tracking_lost" },
    [F.govStorm]: { outcome: "on_time", sched_in_epoch_secs: schedEpoch },
    [F.govPrice]: { outcome: "on_time", sched_in_epoch_secs: schedEpoch },
    [F.govPrice2]: { outcome: "on_time", sched_in_epoch_secs: schedEpoch },
    [F.govMl]: { outcome: "on_time", sched_in_epoch_secs: schedEpoch },
  });

  // ── fetcher: ETA writes; cancelled + diverted settle TODAY ──────────────
  console.log("\n── fetcher (ETAs; cancelled/diverted settle same day) ───");
  const cancelBefore = await h.readOracle("get_pending_outcomes").catch(() => null);
  const fetch1 = await fetcherRun(config);
  check("fetcher run succeeds", fetch1.success, fetch1.error ?? "");
  void cancelBefore;
  for (const role of ["onTime", "delayed210", "delayed120", "govStorm", "govPrice", "govPrice2", "govMl"] as Role[]) {
    const fd = await h.flightData(F[role], date);
    check(
      `${F[role]} (${role}): Active with pinned ETA accepted by the oracle`,
      parseFlightStatus(fd.status) === FlightStatus.Active && BigInt(fd.estimated_arrival_time) === BigInt(schedEpoch),
      `${variantName(fd.status)}/${fd.estimated_arrival_time}`
    );
  }
  check(
    `A4 ${F.cancelled}: corroborated cancellation → Settled`,
    (await h.oracleStatus(F.cancelled, date)) === FlightStatus.Settled
  );
  check(
    `A4 ${F.cancelled}: pool SettledCancelled`,
    variantName((await h.poolConfig(F.cancelled, date))?.status) === "SettledCancelled"
  );
  check(
    `A5 ${F.diverted}: diverted pays as cancellation → Settled/SettledCancelled`,
    (await h.oracleStatus(F.diverted, date)) === FlightStatus.Settled &&
      variantName((await h.poolConfig(F.diverted, date))?.status) === "SettledCancelled"
  );
  check(
    `A6 ${F.lost}: bare cancelled flag — NO tombstone (still NotInitiated)`,
    (await h.oracleStatus(F.lost, date)) === FlightStatus.NotInitiated
  );

  // ── A4/A5 claims pay today ──────────────────────────────────────────────
  console.log("\n── claims (cancelled + diverted) ────────────────────────");
  for (const role of ["cancelled", "diverted"] as Role[]) {
    try {
      const before = await h.usdcBalance(ctx.buyerPub);
      await h.claim(F[role], date);
      const after = await h.usdcBalance(ctx.buyerPub);
      check(`${F[role]} (${role}): claim paid the full $100 payoff`, after - before === PAYOFF, `Δ=${after - before}`);
      buyerExpectedDelta += PAYOFF;
    } catch (err) {
      check(`${F[role]} (${role}): claim paid the full $100 payoff`, false, String(err).slice(0, 120));
    }
  }

  // ── G1: keeper sweeps are clean mid-run ─────────────────────────────────
  console.log("\n── batch keeper jobs (buy-day sweep) ────────────────────");
  const classRes = await classifierRun(config);
  check("classifier sweep succeeds", classRes.success, classRes.error ?? "");
  const settleRes = await settlerRun(config);
  check("settler sweep succeeds (pre-flight skip)", settleRes.success, settleRes.error ?? "");
  check("no pending outcomes (barrier clear)", (await h.readOracle("has_pending_outcomes")) === false);

  // ── persist the pending run ─────────────────────────────────────────────
  const resumeAt = schedEpoch + 3600 + RESUME_MARGIN_SECS;
  d.pending = {
    flights: F,
    date: date.toString(),
    schedEpoch,
    resumeAt,
    buyerExpectedDelta: buyerExpectedDelta.toString(),
    buyerStartBalance: buyerStart.toString(),
    lockedAtStart: locked0.toString(),
  };
  saveDeployment(d);
  console.log(
    `\nBuy-day phase complete. Flight-day phase runnable from ` +
      `${new Date(resumeAt * 1000).toISOString()} — rerun \`npm run test:e2e:testnet\`.`
  );
}

// ---------------------------------------------------------------------------
// Phase 2 — FLIGHT DAY
// ---------------------------------------------------------------------------

async function flightDayPhase(ctx: Ctx): Promise<void> {
  const { d, config, mock } = ctx;
  const h = makeHelpers(ctx);
  const p = d.pending!;
  const F = p.flights as Record<Role, string>;
  const date = BigInt(p.date);
  console.log(`\nResuming run @ ${new Date(Number(date) * 1000).toISOString().slice(0, 10)}`);

  // Same pinned schedule as the buy day; tracking has RECOVERED for A6.
  // Built only from idents present in the pending run (older runs may
  // predate a role).
  const flightDayOutcome = (role: Role) =>
    role === "delayed210"
      ? { outcome: "delayed", delay_minutes: 210, sched_in_epoch_secs: p.schedEpoch }
      : role === "delayed120"
        ? { outcome: "delayed", delay_minutes: 120, sched_in_epoch_secs: p.schedEpoch }
        : { outcome: "on_time", sched_in_epoch_secs: p.schedEpoch };
  await mock.setScenarios(
    Object.fromEntries(
      (["onTime", "delayed210", "delayed120", "lost", "govStorm", "govPrice", "govPrice2", "govMl"] as Role[])
        .filter((r) => F[r] !== undefined)
        .map((r) => [F[r], flightDayOutcome(r)])
    )
  );

  // ── fetcher pass 1: landings settle; A6 gets its late ETA ───────────────
  console.log("\n── fetcher pass 1 (landings; A6 tracking recovers) ──────");
  const fetch1 = await fetcherRun(config);
  check("fetcher pass 1 succeeds", fetch1.success, fetch1.error ?? "");
  const expectPool: Array<[Role, string, string]> = (
    [
      ["onTime", "SettledOnTime", "A1 lands −5min"],
      ["delayed210", "SettledDelayed", "A2 lands 3h30 late (>3h)"],
      ["delayed120", "SettledOnTime", "A3 lands 2h00 late (<3h — boundary)"],
      ["govStorm", "SettledOnTime", "gov flight settles"],
      ["govPrice", "SettledOnTime", "gov flight settles"],
      ["govPrice2", "SettledOnTime", "gov flight settles"],
      ["govMl", "SettledOnTime", "gov flight settles"],
    ] as Array<[Role, string, string]>
  ).filter(([role]) => F[role] !== undefined);
  for (const [role, want, label] of expectPool) {
    const got = variantName((await h.poolConfig(F[role], date))?.status);
    check(`${label}: ${F[role]} → ${want}`, got === want, got);
  }
  check(
    `A6 ${F.lost}: tracking recovered → ETA written (Active)`,
    (await h.oracleStatus(F.lost, date)) === FlightStatus.Active
  );

  // ── fetcher pass 2: the recovered flight lands + settles ────────────────
  console.log("\n── fetcher pass 2 (A6 lands) ────────────────────────────");
  const fetch2 = await fetcherRun(config);
  check("fetcher pass 2 succeeds", fetch2.success, fetch2.error ?? "");
  check(
    `A6 ${F.lost}: settles normally after tracking gap → SettledOnTime`,
    variantName((await h.poolConfig(F.lost, date))?.status) === "SettledOnTime"
  );

  // ── G1: batch keeper jobs on the real chain ─────────────────────────────
  console.log("\n── batch keeper jobs (classifier/settler/queue/ttl) ─────");
  check("classifier sweep succeeds", (await classifierRun(config)).success);
  const settleRes = await settlerRun(config);
  check("settler sweep succeeds (pre-flight skip, nothing pending)", settleRes.success, settleRes.error ?? "");
  check("no pending outcomes (settlement barrier lifted)", (await h.readOracle("has_pending_outcomes")) === false);
  check("queue-maintenance succeeds", (await queueRun(config)).success);
  check("ttl-extender succeeds (DB-only sweeps skip)", (await ttlRun(config)).success);

  // ── remaining claims ────────────────────────────────────────────────────
  console.log("\n── claims (A2 pays; A1 and A3 rejected) ─────────────────");
  let buyerExpectedDelta = BigInt(p.buyerExpectedDelta);
  try {
    const before = await h.usdcBalance(ctx.buyerPub);
    await h.claim(F.delayed210, date);
    const after = await h.usdcBalance(ctx.buyerPub);
    check("A2: >3h delay claim paid the full $100 payoff", after - before === PAYOFF, `Δ=${after - before}`);
    buyerExpectedDelta += PAYOFF;
  } catch (err) {
    check("A2: >3h delay claim paid the full $100 payoff", false, String(err).slice(0, 120));
  }
  for (const [role, label] of [
    ["onTime", "A1 on-time"],
    ["delayed120", "A3 2h-late (below 3h threshold)"],
  ] as Array<[Role, string]>) {
    let rejected = false;
    let msg = "";
    try {
      await h.claim(F[role], date);
    } catch (err) {
      rejected = true;
      msg = String(err);
    }
    check(`${label}: claim REJECTED by the contract`, rejected && msg.includes("[simulation]"), msg.slice(0, 100));
  }

  // ── G2: final ledger ────────────────────────────────────────────────────
  console.log("\n── G2 money conservation ────────────────────────────────");
  const buyerFinal = await h.usdcBalance(ctx.buyerPub);
  check(
    "G2: buyer net Δ = payoffs − premiums exactly",
    buyerFinal - BigInt(p.buyerStartBalance) === buyerExpectedDelta,
    `Δ=${buyerFinal - BigInt(p.buyerStartBalance)} expected=${buyerExpectedDelta}`
  );
  const lockedFinal = await h.lockedCapital();
  check(
    "G2: vault locked returned to its pre-run level",
    lockedFinal === BigInt(p.lockedAtStart),
    `locked=${lockedFinal} vs start=${p.lockedAtStart}`
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
    console.log(`Abandoning pending run (${Object.values(d.pending.flights).join(", ")}).`);
    d.pending = null;
    saveDeployment(d);
    return;
  }

  const phase = d.pending ? "flight-day" : "buy-day";
  if (d.pending && Math.floor(Date.now() / 1000) < d.pending.resumeAt) {
    const left = d.pending.resumeAt - Math.floor(Date.now() / 1000);
    console.log(
      `Pending run: flight-day phase runnable in ~${Math.ceil(left / 60)} min ` +
        `(${new Date(d.pending.resumeAt * 1000).toISOString()}). Use --abandon to drop it.`
    );
    process.exit(2);
  }

  const mock = await startMock(PORT);
  console.log(`mock-aeroapi up on :${PORT} — ${phase} phase (NO database)`);
  const config = deploymentConfig(d, mock.base);
  process.env.ROUTES_CONFIG_PATH = ROUTES_PATH;
  const client = new SorobanClient(config);
  const submitter = new GovSubmitter({
    rpcUrl: d.rpcUrl,
    networkPassphrase: d.passphrase,
    governanceId: d.governanceId,
    // On the throwaway module the owner doubles as gov admin.
    adminSecretKey: d.ownerSecret,
    actor: "e2e:testnet-suite",
  });
  const ctx: Ctx = {
    d,
    config,
    client,
    submitter,
    mock,
    buyerPub: client.publicKeyFromSecret(d.buyerSecret),
    ownerPub: client.publicKeyFromSecret(d.ownerSecret),
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
