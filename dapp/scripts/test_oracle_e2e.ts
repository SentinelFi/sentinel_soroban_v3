/**
 * End-to-end tests for the oracle pipeline — NO real AeroAPI, NO real chain.
 *
 *   real fetcher/authorizer job logic
 *     → real AeroApiClient over HTTP
 *       → tools/mock-aeroapi (spawned on an ephemeral port; scripted
 *         on-time / delayed / cancelled / diverted / tracking-lost / ambiguous
 *         scenarios + /schedules + call counters)
 *     → FakeSoroban (in-memory OracleAggregator + Controller with the real
 *       forward-only state machine + classify/settle semantics)
 *
 * Run: npm run test:e2e   (from dapp/)
 *
 * Covers, per the pipeline:
 *  - full lifecycle NotInitiated → Active → Landed → Settled for on-time and
 *    delayed flights (delay measured vs the written scheduled_in);
 *  - corroborated cancellation → tombstone → targeted classify+settle;
 *  - tracking-lost (cancelled flag WITHOUT cancelled status) must NOT tombstone;
 *  - diverted flights must NOT be attested as landed;
 *  - ambiguous (duplicate) responses must not write anything;
 *  - CALL ECONOMY: flights outside AeroAPI visibility (T-2d) and Active
 *    flights before the watch window spend ZERO API calls;
 *  - sale authorizer: near-window (/flights) attestation + far-window
 *    (/schedules, chunked) attestation, schedule-gap day stays closed,
 *    ~2 /flights + 2 /schedules calls per flight for a 30-day horizon.
 */
import { spawn, type ChildProcess } from "child_process";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import type { SorobanClient } from "../api/_lib/soroban_client";
import { run as fetcherRun } from "../api/_lib/jobs/fetcher";
import { run as authorizerRun } from "../api/_lib/jobs/authorizer";
import { AeroApiClient } from "../api/_lib/aeroapi_client";
import {
  computeDesiredSignals,
  feedCodeToIata,
} from "../api/_lib/governance/signals_collector";
import type { Config, RunLogEntry } from "../api/_lib/types";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..", "..");
const MOCK_DIR = join(REPO_ROOT, "tools", "mock-aeroapi");
const PORT = 3111;
const BASE = `http://localhost:${PORT}`;

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

const results: { name: string; ok: boolean; detail?: string }[] = [];
function check(name: string, ok: boolean, detail?: string): void {
  results.push({ name, ok, detail });
  console.log(`${ok ? "  ✓" : "  ✗"} ${name}${!ok && detail ? ` — ${detail}` : ""}`);
}

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
    fetcherWatchSecs: 21_600, // 6h
    saleAuthHorizonDays: 30,
    saleAuthValiditySecs: 21_600,
    weatherBaseUrl: "http://fake-weather.invalid",
  };
}

async function mockStats(): Promise<{ flights: number; schedules: number; byIdent: Record<string, number> }> {
  const r = await fetch(`${BASE}/__stats`);
  return (await r.json()) as { flights: number; schedules: number; byIdent: Record<string, number> };
}

async function mockReset(): Promise<void> {
  await fetch(`${BASE}/__reset`, { method: "POST" });
}

async function waitForMock(timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`${BASE}/__stats`);
      if (r.ok) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error("mock-aeroapi did not come up in time");
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

async function testFetcher(): Promise<void> {
  console.log("\n── fetcher E2E ──────────────────────────────────────────");
  await mockReset();

  const config = makeConfig();
  const fake = new FakeSoroban();
  const nowSec = Math.floor(Date.now() / 1000);
  const todayIdx = Math.floor(nowSec / DAY);
  const yesterday = BigInt((todayIdx - 1) * DAY);
  const tomorrow = BigInt((todayIdx + 1) * DAY);
  const farFuture = BigInt((todayIdx + 30) * DAY);
  // Mock flight times are built on the requested date: sched 11:00Z.
  const etaOf = (date: bigint) => date + 11n * 3600n;

  // Lifecycle flights (start NotInitiated, resolve over two runs)
  fake.seed("AA100", yesterday, "NotInitiated"); // on_time
  fake.seed("UAL456", yesterday, "NotInitiated"); // delayed 180m
  fake.seed("DL789", tomorrow, "NotInitiated"); // cancelled (corroborated)
  fake.seed("DUP777", yesterday, "NotInitiated"); // ambiguous duplicate
  fake.seed("FUT111", farFuture, "NotInitiated"); // outside visibility — 0 calls
  // Pre-seeded Active flights
  fake.seed("LOST666", yesterday, "Active", etaOf(yesterday)); // tracking-lost
  fake.seed("DIV555", yesterday, "Active", etaOf(yesterday)); // diverted
  fake.seed("SW333", yesterday, "Active", etaOf(yesterday)); // still en route
  fake.seed("HOLD222", tomorrow, "Active", BigInt(nowSec + 10 * 3600)); // pre-watch — 0 calls

  const deps = { soroban: fake as unknown as SorobanClient };

  const run1: RunLogEntry = await fetcherRun(config, deps);
  check("run 1 succeeds", run1.success, run1.error ?? "");

  check("AA100 run1: NotInitiated → Active", fake.get("AA100", yesterday)?.status === "Active");
  check(
    "AA100 ETA = mock scheduled_in (11:00Z)",
    fake.get("AA100", yesterday)?.eta === etaOf(yesterday),
    String(fake.get("AA100", yesterday)?.eta)
  );
  check("UAL456 run1: NotInitiated → Active", fake.get("UAL456", yesterday)?.status === "Active");
  check(
    "DL789: corroborated cancellation settled end-to-end (targeted)",
    fake.get("DL789", tomorrow)?.status === "Settled" && fake.get("DL789", tomorrow)?.outcome === "Cancelled",
    `${fake.get("DL789", tomorrow)?.status}/${fake.get("DL789", tomorrow)?.outcome}`
  );
  check("DUP777: ambiguous response writes nothing", fake.get("DUP777", yesterday)?.status === "NotInitiated");
  check("FUT111: outside visibility stays NotInitiated", fake.get("FUT111", farFuture)?.status === "NotInitiated");
  check(
    "LOST666: tracking-lost does NOT tombstone (stays Active)",
    fake.get("LOST666", yesterday)?.status === "Active"
  );
  const div = fake.get("DIV555", yesterday);
  check(
    "DIV555: diverted pays as cancellation (policy) — Settled/Cancelled",
    div?.status === "Settled" && div?.outcome === "Cancelled",
    `${div?.status}/${div?.outcome}`
  );
  check("DIV555: never attested as landed", fake.calls("set_landed") === 0 || !fake.invocations.some((i) => i.fn === "set_landed" && i.args[1] === "DIV555"));
  check("SW333: en-route stays Active", fake.get("SW333", yesterday)?.status === "Active");

  const run2: RunLogEntry = await fetcherRun(config, deps);
  check("run 2 succeeds", run2.success, run2.error ?? "");

  const aa = fake.get("AA100", yesterday);
  check(
    "AA100 run2: landed on time → Settled/OnTime via targeted settle",
    aa?.status === "Settled" && aa?.outcome === "OnTime",
    `${aa?.status}/${aa?.outcome}`
  );
  check(
    "AA100 actual_in written (10:55Z, -5min)",
    aa?.actual === etaOf(yesterday) - 300n,
    String(aa?.actual)
  );
  const ual = fake.get("UAL456", yesterday);
  check(
    "UAL456 run2: landed 180m late → Settled/Delayed via targeted settle",
    ual?.status === "Settled" && ual?.outcome === "Delayed",
    `${ual?.status}/${ual?.outcome}`
  );
  check(
    "UAL456 delay vs written schedule = 180m",
    ual !== undefined && ual.actual - ual.eta === 10_800n,
    String(ual && ual.actual - ual.eta)
  );
  check("LOST666 still not tombstoned after run 2", fake.get("LOST666", yesterday)?.status === "Active");
  check("DIV555 stays Settled after run 2", fake.get("DIV555", yesterday)?.status === "Settled");

  // Call economy — exact per-ident API spend across both runs.
  const stats = await mockStats();
  const expectCalls: Record<string, number> = {
    AA100: 2, // ETA fetch + landing fetch
    UAL456: 2,
    DL789: 1, // cancelled + settled in run 1; run 2 skips (Settled)
    DUP777: 2, // ambiguous both runs (no write, keeps retrying)
    LOST666: 2, // uncorroborated flag both runs (deliberate retry)
    DIV555: 1, // diverted → paid as cancellation in run 1; run 2 skips
    SW333: 2, // en-route both runs
  };
  for (const [ident, expected] of Object.entries(expectCalls)) {
    check(
      `call economy: ${ident} = ${expected} AeroAPI call(s)`,
      (stats.byIdent[ident] ?? 0) === expected,
      String(stats.byIdent[ident] ?? 0)
    );
  }
  check("call economy: FUT111 (T-30d) = 0 calls", (stats.byIdent["FUT111"] ?? 0) === 0, String(stats.byIdent["FUT111"]));
  check("call economy: HOLD222 (pre-watch) = 0 calls", (stats.byIdent["HOLD222"] ?? 0) === 0, String(stats.byIdent["HOLD222"]));
  check(
    "set_cancelled written only for DL789 + DIV555 (not LOST666/DUP777)",
    fake.calls("set_cancelled") === 2,
    `set_cancelled × ${fake.calls("set_cancelled")}`
  );
}

async function testAuthorizer(): Promise<void> {
  console.log("\n── sale authorizer E2E ──────────────────────────────────");
  await mockReset();

  process.env.ROUTES_CONFIG_PATH = join(__dirname, "fixtures", "routes.e2e.json");
  const config = makeConfig(); // horizon 30
  const fake = new FakeSoroban();
  const deps = { soroban: fake as unknown as SorobanClient };

  const nowSec = Math.floor(Date.now() / 1000);
  const todayIdx = Math.floor(nowSec / DAY);
  const dateOf = (offset: number) => BigInt((todayIdx + offset) * DAY);

  const run1: RunLogEntry = await authorizerRun(config, deps);
  check("authorizer run succeeds", run1.success, run1.error ?? "");

  // Near window (days 1-2): live-data attestation opens AA100 windows.
  check("AA100 day+1 sale window open", fake.sales.has(`AA100|${dateOf(1)}`));
  check("AA100 day+2 sale window open", fake.sales.has(`AA100|${dateOf(2)}`));

  // Far window (days 3..30): schedules-based attestation.
  check("AA100 day+3 open via /schedules", fake.sales.has(`AA100|${dateOf(3)}`));
  check("AA100 day+30 open via /schedules", fake.sales.has(`AA100|${dateOf(30)}`));
  const aaWindows = [...fake.sales.keys()].filter((k) => k.startsWith("AA100|")).length;
  check("AA100 has 30 windows (days 1..30)", aaWindows === 30, String(aaWindows));

  // DL789 near window: corroborated cancellation → tombstone, no window.
  check("DL789 day+1 tombstoned", fake.get("DL789", dateOf(1))?.status === "Cancelled");
  check("DL789 day+1 tombstone is NOT active-listed", fake.get("DL789", dateOf(1))?.listed === false);
  check("DL789 day+1 has no sale window", !fake.sales.has(`DL789|${dateOf(1)}`));

  // DL789 far window: published schedule exists (cancellation is a live-data
  // concept — /schedules still lists it), so windows open for future days...
  check("DL789 day+4 open via /schedules", fake.sales.has(`DL789|${dateOf(4)}`));
  // ...EXCEPT the day the airline does not publish (+5, per scenarios.json).
  check("DL789 day+5 (schedule gap) stays closed", !fake.sales.has(`DL789|${dateOf(5)}`));

  // Call economy: per flight = 2 near /flights calls + ceil(28/20)=2
  // /schedules chunks. Two flights → 4 + 4.
  const stats = await mockStats();
  check("call economy: 2 /flights calls per flight", stats.byIdent["AA100"] === 2 && stats.byIdent["DL789"] === 2,
    JSON.stringify(stats.byIdent));
  check("call economy: 4 /schedules calls total (2 chunks × 2 flights)", stats.schedules === 4, String(stats.schedules));
  check(
    "old sweep would have been 60 /flights calls; now 4 + 4",
    stats.flights === 4,
    String(stats.flights)
  );

  // Run 2 immediately after: every AA100 near window is still fresh (the
  // live window is the cached attestation) and DL789's near days are
  // tombstoned (outcome recorded — never re-verified). The authorizer must
  // spend ZERO new /flights calls in steady state.
  const run2: RunLogEntry = await authorizerRun(config, deps);
  check("authorizer run 2 succeeds", run2.success, run2.error ?? "");
  const stats2 = await mockStats();
  check(
    "steady state: 0 new /flights calls (fresh windows + tombstones)",
    stats2.flights === stats.flights,
    `${stats.flights} → ${stats2.flights}`
  );
  check(
    "/schedules still refresh each run (uncached for now)",
    stats2.schedules === stats.schedules + 4,
    String(stats2.schedules)
  );

  delete process.env.ROUTES_CONFIG_PATH;
}

async function testGovSignals(): Promise<void> {
  console.log("\n── gov_signals collector ────────────────────────────────");

  // Pure projection: feed → desired signals for the airports in play.
  check("feedCodeToIata strips US K-prefix", feedCodeToIata("KJFK") === "JFK");
  check("feedCodeToIata leaves non-K codes alone", feedCodeToIata("EGLL") === "EGLL");

  const sampleFeed = [
    { airport: "KJFK", category: "weather", color: "yellow", delay_secs: 2700 },
    { airport: "KATL", category: "weather", color: "red", delay_secs: 5400 },
    { airport: "KORD", category: "traffic", color: "yellow", delay_secs: 1800 }, // not a route airport
    { airport: "KLAX", category: "weather", color: "green", delay_secs: 300 }, // non-actionable color
  ];
  const specs = computeDesiredSignals(sampleFeed, new Set(["JFK", "ATL", "LAX"]));
  check("2 airports matched → 4 specs (origin+dest each)", specs.length === 4, String(specs.length));
  check(
    "JFK yellow → elevated (both scopes)",
    specs.filter((s) => s.airport === "JFK" && s.severity === "elevated").length === 2
  );
  check(
    "ATL red → severe (both scopes)",
    specs.filter((s) => s.airport === "ATL" && s.severity === "severe").length === 2
  );
  check("ORD (not a route airport) ignored", !specs.some((s) => s.airport === "ORD"));
  check("green color ignored", !specs.some((s) => s.airport === "LAX"));
  check(
    "payload carries the true category",
    specs.find((s) => s.airport === "ATL")?.payload.category === "weather" &&
      specs.every((s) => typeof s.payload.delay_secs === "number")
  );

  // Live client against the mock's /airports/delays endpoint.
  const aero = new AeroApiClient({ aeroApiBaseUrl: BASE, aeroApiKey: "" });
  const feed = await aero.getAirportDelays();
  check("mock /airports/delays serves the fixture", (feed?.delays?.length ?? 0) === 3, String(feed?.delays?.length));
  check(
    "fixture red airport parses",
    feed?.delays?.some((d) => d.airport === "KATL" && d.color === "red") === true
  );
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  console.log("Starting mock-aeroapi...");
  const mock: ChildProcess = spawn("npx", ["tsx", join(MOCK_DIR, "src", "server.ts")], {
    cwd: join(REPO_ROOT, "dapp"),
    env: { ...process.env, PORT: String(PORT) },
    stdio: "ignore",
  });

  try {
    await waitForMock(15_000);
    console.log(`mock-aeroapi up on :${PORT}`);

    await testFetcher();
    await testAuthorizer();
    await testGovSignals();
  } finally {
    mock.kill();
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed.`);
  if (failed.length > 0) {
    console.error("FAILED:");
    for (const f of failed) console.error(`  ✗ ${f.name}${f.detail ? ` — ${f.detail}` : ""}`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
