/**
 * End-to-end tests for the oracle pipeline — NO real AeroAPI, NO real chain.
 *
 *   real settle-sweep / JIT sale-auth / route-guard logic
 *     → real AeroApiClient over HTTP
 *       → tools/mock-aeroapi (spawned on an ephemeral port; scripted
 *         on-time / delayed / cancelled / diverted / tracking-lost / ambiguous
 *         scenarios + /schedules + call counters)
 *     → FakeSoroban (in-memory OracleAggregator + Controller with the real
 *       forward-only state machine + classify/settle semantics)
 *
 * Run: npm run test:e2e   (from dapp/)
 *
 * Covers, per the 2026-07-31 demand-driven rework:
 *  - SETTLE SWEEP: full lifecycle NotInitiated → Active → Landed → Settled
 *    resolved in ONE run one call once past scheduled arrival + 5h; delayed
 *    vs on-time classification; corroborated cancellation/diversion →
 *    tombstone → targeted settle; tracking-lost must NOT tombstone;
 *    ambiguous responses write nothing; CALL ECONOMY: zero API calls before
 *    the settle gate (future flights, pre-gate actives);
 *  - JIT SALE AUTH: near-window (/flights) verification + tombstone-on-
 *    cancellation + guard trigger; far-window (/schedules) presence check +
 *    guard on vanished days; the 24h departure cutoff; window reuse (second
 *    buyer = zero API calls); recorded outcomes refuse without a call;
 *  - ROUTE GUARD: the 2-call 5-day sweep verdict — dead vs alive vs unknown
 *    days, allDead only when every day is verifiably dead.
 */
// The suite's contract is "no database attached" — it doubles as the
// DB-optional invariant proof (sale-auth falls back to the routes file,
// the settle gate falls back to date+30h, guard dedupe/pauses degrade to
// logs). Enforce it.
delete process.env.GOVERNANCE_DB_URL;
delete process.env.SALE_AUTH_HORIZON_DAYS;

import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { check, startMock, summarize, type MockHandle } from "../../scripts/e2e/harness";
import type { SorobanClient } from "../../api/_lib/soroban_client";
import { run as fetcherRun } from "../../api/_lib/jobs/fetcher";
import { authorizeSale } from "../../api/_lib/sale_auth";
import { guardRoute, sweepVerdict } from "../../api/_lib/route_guard";
import { AeroApiClient } from "../../api/_lib/aeroapi_client";
import { computeConcentrations, computeExposureSignals } from "../../api/_lib/governance/exposure_collector";
import { computeDisableCap } from "../../api/_lib/governance/interventions";
import { distanceMiles } from "../../api/_lib/airports";
import { isExtremeForecast } from "../../api/_lib/route_rules";
import type { Config, RunLogEntry } from "../../api/_lib/types";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = 3111;
const BASE = `http://localhost:${PORT}`;

// Bound in main(); the thin aliases keep the call sites below unchanged.
let mock: MockHandle;
const mockReset = () => mock.reset();
const mockStats = () => mock.stats();

const DAY = 86_400;

// ---------------------------------------------------------------------------
// FakeSoroban — in-memory OracleAggregator + Controller
// ---------------------------------------------------------------------------

interface FakeFlight {
  status: string;
  eta: bigint; // estimated_arrival_time
  actual: bigint; // actual_arrival_time
  listed: boolean; // in the oracle active set (tombstones are not)
  outcome?: string; // recorded at settle_flight
}

class FakeSoroban {
  flights = new Map<string, FakeFlight>();
  sales = new Map<string, bigint>();
  invocations: { contract: string; fn: string; args: unknown[] }[] = [];
  // Mirrors the pool's per-flight delay threshold (fixture delay_hours = 2).
  delayThresholdSecs = 2n * 3600n;

  private k(id: unknown, date: unknown): string {
    return `${id}|${BigInt(date as string | number | bigint)}`;
  }

  seed(id: string, date: bigint, status: string, eta = 0n): void {
    this.flights.set(this.k(id, date), { status, eta, actual: 0n, listed: true });
  }

  get(id: string, date: bigint): FakeFlight | undefined {
    return this.flights.get(this.k(id, date));
  }

  calls(fn: string): number {
    return this.invocations.filter((i) => i.fn === fn).length;
  }

  publicKeyFromSecret(_secret: string): string {
    return "GFAKEPUBLICKEYFAKEPUBLICKEYFAKEPUBLICKEYFAKEPUBLICKEYFA";
  }
  symbolToScVal(v: unknown): unknown {
    return v;
  }
  u64ToScVal(v: unknown): unknown {
    return v;
  }
  i128ToScVal(v: unknown): unknown {
    return v;
  }
  addressToScVal(v: unknown): unknown {
    return v;
  }

  async readContract(_contractId: string, fn: string, args: unknown[] = []): Promise<any> {
    switch (fn) {
      case "get_active_flights":
        return [...this.flights.entries()]
          .filter(([, f]) => f.listed)
          .map(([key]) => {
            const [id, date] = key.split("|");
            return [id, BigInt(date)];
          });
      case "get_flight_data": {
        const f = this.flights.get(this.k(args[0], args[1]));
        return f
          ? { status: f.status, estimated_arrival_time: f.eta, actual_arrival_time: f.actual, settled_at: 0n }
          : { status: "NotInitiated", estimated_arrival_time: 0n, actual_arrival_time: 0n, settled_at: 0n };
      }
      case "get_sale_auth":
        return this.sales.get(this.k(args[0], args[1])) ?? null;
      case "is_flight_listed": {
        const f = this.flights.get(this.k(args[0], args[1]));
        return Boolean(f?.listed);
      }
      default:
        throw new Error(`FakeSoroban: unhandled read ${fn}`);
    }
  }

  async invokeContract(contractId: string, fn: string, args: unknown[], _secret: string): Promise<string> {
    this.invocations.push({ contract: contractId, fn, args });
    // Write entry points all carry (signer, flight_id, date, ...) — key on 1/2.
    const key = this.k(args[1], args[2]);
    const f = this.flights.get(key);
    switch (fn) {
      case "set_estimated_arrival": {
        if (!f || f.status !== "NotInitiated") throw new Error(`bad transition: set_estimated_arrival on ${f?.status}`);
        f.status = "Active";
        f.eta = BigInt(args[3] as string | number | bigint);
        return "txfake";
      }
      case "set_landed": {
        if (!f || f.status !== "Active") throw new Error(`bad transition: set_landed on ${f?.status}`);
        f.status = "Landed";
        f.actual = BigInt(args[3] as string | number | bigint);
        return "txfake";
      }
      case "set_cancelled": {
        // Real oracle: also a pre-registration tombstone (not active-listed).
        if (!f) {
          this.flights.set(key, { status: "Cancelled", eta: 0n, actual: 0n, listed: false });
          return "txfake";
        }
        if (f.status !== "NotInitiated" && f.status !== "Active") {
          throw new Error(`bad transition: set_cancelled on ${f.status}`);
        }
        f.status = "Cancelled";
        return "txfake";
      }
      case "open_sale": {
        this.sales.set(key, BigInt(args[3] as string | number | bigint));
        return "txfake";
      }
      case "close_sale": {
        this.sales.delete(key);
        return "txfake";
      }
      case "classify_flight": {
        if (!f?.listed) throw new Error("classify_flight: not listed");
        if (f.status === "Landed") {
          const delay = f.actual - f.eta;
          f.status = delay >= this.delayThresholdSecs ? "ToBeSettledDelayed" : "ToBeSettledOnTime";
        } else if (f.status === "Cancelled") {
          f.status = "ToBeSettledCancelled";
        }
        return "txfake";
      }
      case "settle_flight": {
        if (!f?.listed) throw new Error("settle_flight: not listed");
        if (f.status.startsWith("ToBeSettled")) {
          f.outcome = f.status.slice("ToBeSettled".length);
          f.status = "Settled";
        }
        return "txfake";
      }
      default:
        throw new Error(`FakeSoroban: unhandled invoke ${fn}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

function makeConfig(): Config {
  return {
    stellarRpcUrl: "http://fake-rpc.invalid",
    networkPassphrase: "e2e",
    oracleAggregatorId: "ORACLE_FAKE",
    controllerId: "CONTROLLER_FAKE",
    riskVaultId: "VAULT_FAKE",
    governanceId: "GOV_FAKE",
    flightPoolManagerId: "POOL_FAKE",
    oracleSecretKey: "SFAKEORACLE",
    keeperSecretKey: "SFAKEKEEPER",
    ttlExtenderSecretKey: "SFAKETTL",
    aeroApiBaseUrl: BASE,
    aeroApiKey: "",
    settleAfterEtaSecs: 18_000, // 5h
    saleAuthHorizonDays: 30,
    saleAuthValiditySecs: 21_600,
    saleMinLeadSecs: 86_400,
    weatherBaseUrl: "http://fake-weather.invalid",
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

async function testSettleSweep(): Promise<void> {
  console.log("\n── settle sweep E2E ─────────────────────────────────────");
  await mockReset();

  const config = makeConfig();
  const fake = new FakeSoroban();
  const nowSec = Math.floor(Date.now() / 1000);
  const todayIdx = Math.floor(nowSec / DAY);
  // Two days back: every settle gate (on-chain ETA + 5h, or the no-hint
  // date + 30h fallback) is deterministically past, whatever the wall clock.
  const twoDaysAgo = BigInt((todayIdx - 2) * DAY);
  const tomorrow = BigInt((todayIdx + 1) * DAY);
  const farFuture = BigInt((todayIdx + 30) * DAY);
  // Mock flight times are built on the requested date: sched 11:00Z.
  const etaOf = (date: bigint) => date + 11n * 3600n;

  // Lifecycle flights — all NotInitiated: the sweep must write the schedule
  // (set_estimated_arrival) AND the outcome from ONE API response.
  fake.seed("AA100", twoDaysAgo, "NotInitiated"); // on_time
  fake.seed("UAL456", twoDaysAgo, "NotInitiated"); // delayed 180m
  fake.seed("DL789", twoDaysAgo, "NotInitiated"); // cancelled (corroborated)
  fake.seed("DUP777", twoDaysAgo, "NotInitiated"); // ambiguous duplicate
  fake.seed("FUT111", farFuture, "NotInitiated"); // future — 0 calls
  // Pre-seeded Active flights (a prior run wrote their ETA).
  fake.seed("LOST666", twoDaysAgo, "Active", etaOf(twoDaysAgo)); // tracking-lost
  fake.seed("DIV555", twoDaysAgo, "Active", etaOf(twoDaysAgo)); // diverted
  fake.seed("SW333", twoDaysAgo, "Active", etaOf(twoDaysAgo)); // still en route
  fake.seed("HOLD222", tomorrow, "Active", BigInt(nowSec + 10 * 3600)); // pre-gate — 0 calls

  const deps = { soroban: fake as unknown as SorobanClient };

  const run1: RunLogEntry = await fetcherRun(config, deps);
  check("run 1 succeeds", run1.success, run1.error ?? "");

  const aa = fake.get("AA100", twoDaysAgo);
  check(
    "AA100: NotInitiated → Settled/OnTime in ONE run (schedule + landing from one response)",
    aa?.status === "Settled" && aa?.outcome === "OnTime",
    `${aa?.status}/${aa?.outcome}`
  );
  check(
    "AA100 schedule written = mock scheduled_in (11:00Z)",
    aa?.eta === etaOf(twoDaysAgo),
    String(aa?.eta)
  );
  check(
    "AA100 actual_in written (10:55Z, -5min)",
    aa?.actual === etaOf(twoDaysAgo) - 300n,
    String(aa?.actual)
  );
  const ual = fake.get("UAL456", twoDaysAgo);
  check(
    "UAL456: landed 180m late → Settled/Delayed in one run",
    ual?.status === "Settled" && ual?.outcome === "Delayed",
    `${ual?.status}/${ual?.outcome}`
  );
  check(
    "UAL456 delay vs written schedule = 180m",
    ual !== undefined && ual.actual - ual.eta === 10_800n,
    String(ual && ual.actual - ual.eta)
  );
  check(
    "DL789: corroborated cancellation settled end-to-end (targeted)",
    fake.get("DL789", twoDaysAgo)?.status === "Settled" && fake.get("DL789", twoDaysAgo)?.outcome === "Cancelled",
    `${fake.get("DL789", twoDaysAgo)?.status}/${fake.get("DL789", twoDaysAgo)?.outcome}`
  );
  check("DUP777: ambiguous response writes nothing", fake.get("DUP777", twoDaysAgo)?.status === "NotInitiated");
  check("FUT111: future flight stays NotInitiated", fake.get("FUT111", farFuture)?.status === "NotInitiated");
  check(
    "LOST666: tracking-lost does NOT tombstone (stays Active)",
    fake.get("LOST666", twoDaysAgo)?.status === "Active"
  );
  const div = fake.get("DIV555", twoDaysAgo);
  check(
    "DIV555: diverted pays as cancellation (policy) — Settled/Cancelled",
    div?.status === "Settled" && div?.outcome === "Cancelled",
    `${div?.status}/${div?.outcome}`
  );
  check(
    "DIV555: never attested as landed",
    !fake.invocations.some((i) => i.fn === "set_landed" && i.args[1] === "DIV555")
  );
  check("SW333: en-route stays Active (retry next tick)", fake.get("SW333", twoDaysAgo)?.status === "Active");
  check("HOLD222: pre-gate Active untouched", fake.get("HOLD222", tomorrow)?.status === "Active");

  const run2: RunLogEntry = await fetcherRun(config, deps);
  check("run 2 succeeds", run2.success, run2.error ?? "");
  check("LOST666 still not tombstoned after run 2", fake.get("LOST666", twoDaysAgo)?.status === "Active");
  check("DIV555 stays Settled after run 2", fake.get("DIV555", twoDaysAgo)?.status === "Settled");

  // Call economy — exact per-ident API spend across both runs.
  const stats = await mockStats();
  const expectCalls: Record<string, number> = {
    AA100: 1, // one call resolved everything; run 2 skips (Settled)
    UAL456: 1,
    DL789: 1,
    DIV555: 1,
    DUP777: 2, // ambiguous both runs (no write, keeps retrying)
    LOST666: 2, // uncorroborated flag both runs (deliberate retry)
    SW333: 2, // en-route both runs
  };
  for (const [ident, expected] of Object.entries(expectCalls)) {
    check(
      `call economy: ${ident} = ${expected} AeroAPI call(s)`,
      (stats.byIdent[ident] ?? 0) === expected,
      String(stats.byIdent[ident] ?? 0)
    );
  }
  check("call economy: FUT111 (T+30d) = 0 calls", (stats.byIdent["FUT111"] ?? 0) === 0, String(stats.byIdent["FUT111"]));
  check("call economy: HOLD222 (pre-gate) = 0 calls", (stats.byIdent["HOLD222"] ?? 0) === 0, String(stats.byIdent["HOLD222"]));
  check(
    "set_cancelled written only for DL789 + DIV555 (not LOST666/DUP777)",
    fake.calls("set_cancelled") === 2,
    `set_cancelled × ${fake.calls("set_cancelled")}`
  );
}

async function testSaleAuth(): Promise<void> {
  console.log("\n── JIT sale authorization E2E ───────────────────────────");
  await mockReset();

  process.env.ROUTES_CONFIG_PATH = join(__dirname, "..", "fixtures", "routes.e2e.json");
  const config = makeConfig(); // horizon 30, validity 6h, min lead 24h
  const fake = new FakeSoroban();
  const guardCalls: string[] = [];
  const deps = {
    soroban: fake as unknown as SorobanClient,
    guard: async (r: { flight_id: string }) => {
      guardCalls.push(r.flight_id);
    },
  };

  const nowSec = Math.floor(Date.now() / 1000);
  const todayIdx = Math.floor(nowSec / DAY);
  const dateOf = (offset: number) => BigInt((todayIdx + offset) * DAY);

  // ── Free refusals (no API call) ────────────────────────────────────
  let r = await authorizeSale(config, "ZZ999", dateOf(2), deps);
  check("unknown flight refused (not whitelisted)", !r.authorized && /whitelist/.test(r.reason), r.reason);

  r = await authorizeSale(config, "AA100", dateOf(0), deps);
  check("same-day purchase refused", !r.authorized, r.reason);

  r = await authorizeSale(config, "AA100", dateOf(31), deps);
  check("beyond the sale horizon refused", !r.authorized && /horizon/.test(r.reason), r.reason);

  let stats = await mockStats();
  check("free refusals spent 0 API calls", stats.flights === 0 && stats.schedules === 0,
    `${stats.flights}/${stats.schedules}`);

  // ── Near window (day +2): live verification ────────────────────────
  r = await authorizeSale(config, "AA100", dateOf(2), deps);
  check("AA100 +2d authorized (live data clean)", r.authorized, r.reason);
  const expiry = fake.sales.get(`AA100|${dateOf(2)}`);
  check("window expiry = now + validity (dep − 24h is further out)",
    expiry !== undefined && Number(expiry) > nowSec + 21_000 && Number(expiry) <= nowSec + 21_700,
    String(expiry));
  check("scheduled dep/arr returned to the frontend",
    Boolean(r.scheduledOut && r.scheduledIn), `${r.scheduledOut}/${r.scheduledIn}`);

  // Second buyer inside the window: free ride.
  stats = await mockStats();
  const flightsBefore = stats.flights;
  r = await authorizeSale(config, "AA100", dateOf(2), deps);
  stats = await mockStats();
  check("second buyer rides the live window (authorized, 0 new API calls)",
    r.authorized && /existing/.test(r.reason) && stats.flights === flightsBefore,
    `${r.reason}, calls ${flightsBefore}→${stats.flights}`);

  // The 24h cutoff, against a pinned real departure time: repoint AA100's
  // day +1 schedule so it departs ~17h from now (epoch pin beats the
  // wall-clock ambiguity of "tomorrow 08:00Z").
  await mock.setScenarios({
    AA100: { outcome: "scheduled", origin: "KJFK", destination: "KLAX",
             sched_in_epoch_secs: nowSec + 20 * 3600 },
  });
  r = await authorizeSale(config, "AA100", dateOf(1), deps);
  check("departure <24h out refused (real dep time, not the day bucket)",
    !r.authorized && /less than 24h/.test(r.reason), r.reason);
  await mockReset(); // clear overrides (also resets counters)

  // ── Near window: corroborated cancellation ─────────────────────────
  r = await authorizeSale(config, "DL789", dateOf(2), deps);
  check("cancelled flight refused", !r.authorized && /cancelled/.test(r.reason), r.reason);
  check("purchase-blocking tombstone written (not active-listed)",
    fake.get("DL789", dateOf(2))?.status === "Cancelled" && fake.get("DL789", dateOf(2))?.listed === false);
  check("no sale window for the cancelled day", !fake.sales.has(`DL789|${dateOf(2)}`));
  check("route guard fired on the cancellation", guardCalls.includes("DL789"), guardCalls.join(","));

  // Probe the same (flight, day) again: the tombstone answers for free.
  stats = await mockStats();
  const before2 = stats.flights;
  r = await authorizeSale(config, "DL789", dateOf(2), deps);
  stats = await mockStats();
  check("tombstoned day refused with 0 API calls",
    !r.authorized && /recorded outcome/.test(r.reason) && stats.flights === before2,
    `${r.reason}, calls ${before2}→${stats.flights}`);

  // ── Near window: tracking-lost (bare flag) ─────────────────────────
  const guardsBefore = guardCalls.length;
  r = await authorizeSale(config, "LOST666", dateOf(2), deps);
  check("bare cancelled flag refused WITHOUT tombstone",
    !r.authorized && /unconfirmed/.test(r.reason) && fake.get("LOST666", dateOf(2)) === undefined,
    r.reason);
  check("bare flag does not fire the guard", guardCalls.length === guardsBefore);

  // ── Far window (day +10): published-schedule presence ──────────────
  r = await authorizeSale(config, "FUT111", dateOf(10), deps);
  check("FUT111 +10d authorized via /schedules presence", r.authorized, r.reason);
  check("far window opened on-chain", fake.sales.has(`FUT111|${dateOf(10)}`));

  // DL789 is unscheduled on day +5 (fixture): vanished → refuse + guard.
  const guardsBefore2 = guardCalls.length;
  r = await authorizeSale(config, "DL789", dateOf(5), deps);
  check("schedule-vanished day refused",
    !r.authorized && /not in the published schedule/.test(r.reason), r.reason);
  check("route guard fired on the vanished day", guardCalls.length === guardsBefore2 + 1);

  // Far ambiguity: two published instances on one day → fail closed.
  await mock.setScenarios({
    DUP777: { outcome: "on_time", origin: "KSEA", destination: "KORD", schedules_duplicate: true },
  });
  r = await authorizeSale(config, "DUP777", dateOf(10), deps);
  check("ambiguous published schedule refused", !r.authorized && /ambiguous/.test(r.reason), r.reason);

  delete process.env.ROUTES_CONFIG_PATH;
}

async function testRouteGuard(): Promise<void> {
  console.log("\n── route guard (cancellation sweep) ─────────────────────");
  await mockReset();

  const aero = new AeroApiClient({ aeroApiBaseUrl: BASE, aeroApiKey: "" });

  // DL789: cancelled on live days (+1, +2), published on +3/+4, gone on +5
  // → NOT allDead (the schedule says the route still operates).
  const v1 = await sweepVerdict(aero, { flight_id: "DL789", origin: "ATL", destination: "BOS" });
  check("sweep: live days read as dead (corroborated cancellation)",
    v1.days[0].state === "dead" && v1.days[1].state === "dead",
    v1.days.map((d) => d.state).join(","));
  check("sweep: published days +3/+4 read as alive",
    v1.days[2].state === "alive" && v1.days[3].state === "alive",
    v1.days.map((d) => d.state).join(","));
  check("sweep: unpublished day +5 reads as dead", v1.days[4].state === "dead");
  check("sweep: NOT allDead — disruption, not a dead route", !v1.allDead);

  // A fully dead route: cancelled near, unpublished far → allDead.
  await mock.setScenarios({
    DEAD000: { outcome: "cancelled", origin: "KBWI", destination: "KSLC",
               unscheduled_days: ["+3", "+4", "+5"] },
  });
  const v2 = await sweepVerdict(aero, { flight_id: "DEAD000", origin: "BWI", destination: "SLC" });
  check("sweep: all 5 days dead → allDead", v2.allDead,
    v2.days.map((d) => `${d.state}(${d.detail})`).join(","));

  // Exactly 2 API calls per sweep (one /flights range + one /schedules).
  await mockReset();
  await mock.setScenarios({
    DEAD000: { outcome: "cancelled", origin: "KBWI", destination: "KSLC",
               unscheduled_days: ["+3", "+4", "+5"] },
  });
  await sweepVerdict(aero, { flight_id: "DEAD000", origin: "BWI", destination: "SLC" });
  const stats = await mockStats();
  check("sweep costs exactly 2 API calls", stats.flights === 1 && stats.schedules === 1,
    `flights=${stats.flights} schedules=${stats.schedules}`);

  // Tracking-lost near days are UNKNOWN (never dead) — no pause off a bare flag.
  const v3 = await sweepVerdict(aero, { flight_id: "LOST666", origin: "PHX", destination: "DFW" });
  check("sweep: bare cancelled flag reads as unknown, not dead",
    v3.days[0].state === "unknown" && !v3.allDead,
    v3.days.map((d) => d.state).join(","));

  // guardRoute end-to-end in the DB-less suite: verdict runs, the pause
  // degrades to log-only (no interventions ledger without a DB).
  const res = await guardRoute(
    makeConfig(),
    { flight_id: "DEAD000", origin: "BWI", destination: "SLC" },
    aero
  );
  check("guardRoute: allDead without a DB → verdict logged, pause skipped",
    res.swept && res.verdict?.allDead === true && /no DB/.test(res.outcome),
    res.outcome);
}

async function testGovernanceMath(): Promise<void> {
  console.log("\n── governance math (exposure / breaker / geo) ───────────");

  // Exposure projection (pure): route + airport concentration vs capacity.
  const flights = [
    { flightId: "AA100", origin: "JFK", dest: "LAX", liabilityUnits: 300n },
    { flightId: "DL200", origin: "JFK", dest: "SEA", liabilityUnits: 250n },
  ];
  const exp = computeExposureSignals(flights, 1000n, { elevatedPct: 0.25, severePct: 0.5 });
  check("exposure: 2 route specs + 6 airport specs", exp.length === 8, String(exp.length));
  check(
    "exposure: AA100 route at 30% → elevated",
    exp.some((s) => s.scope_kind === "route" && s.flightId === "AA100" && s.severity === "elevated")
  );
  check(
    "exposure: JFK airport at 55% → severe (both scopes)",
    exp.filter((s) => (s.origin === "JFK" || s.dest === "JFK") && s.scope_kind !== "route" && s.severity === "severe").length === 2
  );
  check(
    "exposure: LAX at 30% → elevated, not severe",
    exp.some((s) => (s.origin === "LAX" || s.dest === "LAX") && s.severity === "elevated") &&
      !exp.some((s) => (s.origin === "LAX" || s.dest === "LAX") && s.severity === "severe")
  );
  check("exposure: zero capacity → no signals", computeExposureSignals(flights, 0n).length === 0);

  // Concentration fractions (the revive predicate's input).
  const conc = computeConcentrations(flights, 1000n);
  check(
    "concentrations: JFK airport fraction = 55% (both flights aggregate)",
    Math.abs((conc.airports.get("JFK") ?? 0) - 0.55) < 1e-6,
    String(conc.airports.get("JFK"))
  );
  check(
    "concentrations: AA100 route fraction = 30%",
    Math.abs((conc.routes.get("AA100|JFK|LAX")?.fraction ?? 0) - 0.3) < 1e-6
  );

  // Mass-disable circuit breaker: max(3, 20% of fleet).
  check(
    "breaker cap: small fleets floor at 3, large scale at 20%",
    computeDisableCap(2) === 3 && computeDisableCap(15) === 3 && computeDisableCap(200) === 40,
    `${computeDisableCap(2)}/${computeDisableCap(15)}/${computeDisableCap(200)}`
  );

  // Extreme-weather pause tier sits above the +$10 severe surcharge tier.
  const forecast = (gust: number, snow: number) => ({
    maxWindGustKmh: gust,
    totalSnowfallCm: snow,
    maxPrecipProbPct: 0,
    weatherCodes: [],
  });
  check(
    "extreme forecast: hurricane gusts / blizzard snow pause; severe does not",
    isExtremeForecast(forecast(125, 0)) &&
      isExtremeForecast(forecast(0, 45)) &&
      !isExtremeForecast(forecast(95, 25)) &&
      !isExtremeForecast(null)
  );

  // Great-circle helper (feeds the ML distance feature).
  check(
    "JFK-LAX great-circle ≈ 2475 mi",
    Math.abs(distanceMiles({ lat: 40.64, lon: -73.78 }, { lat: 33.94, lon: -118.41 }) - 2475) < 30,
    String(distanceMiles({ lat: 40.64, lon: -73.78 }, { lat: 33.94, lon: -118.41 }))
  );
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  console.log("Starting mock-aeroapi...");
  mock = await startMock(PORT);
  console.log(`mock-aeroapi up on :${PORT}`);

  try {
    await testSettleSweep();
    await testSaleAuth();
    await testRouteGuard();
    await testGovernanceMath();
  } finally {
    mock.stop();
  }

  process.exit(summarize());
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
