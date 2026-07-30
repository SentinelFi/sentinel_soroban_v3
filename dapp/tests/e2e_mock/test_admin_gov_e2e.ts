/**
 * End-to-end tests for the admin HTTP layer and the gov_exposure
 * orchestrator — REAL Postgres (dapp/.env's GOVERNANCE_DB_URL, the live
 * governance Supabase project), NO real chain.
 *
 * Closes the two gaps flagged after test_interventions_e2e.ts:
 *   - admin/interventions.ts + admin/freeze.ts: the HTTP handlers
 *     themselves (auth gate, pagination, validation, 404s) — previously
 *     only the DB functions they call were covered;
 *   - governance/exposure_collector.ts's run(): the full severity →
 *     affected-route fan-out (route-scope vs airport-scope, in-memory
 *     de-dup, elevated-advisory-only, dry-run) — previously only the
 *     pure computeExposureSignals/computeConcentrations math was covered.
 *
 * Both handlers and run() gained a small `deps` injection seam (matching
 * the existing FetcherDeps/sale_auth pattern) so tests can swap in a fake
 * verifyAdmin/loadGovConfig/chain-read-client without a live Supabase Auth
 * session or a real Soroban RPC call — production callers are unaffected
 * (the seam defaults to the real implementations).
 *
 * NOT covered here, and not safely coverable without further changes: the
 * mass-disable circuit breaker's cap-reached branch in exposure_collector
 * only increments its counter when pauseRoute reports disabledOnChain —
 * which requires a real GovSubmitter, i.e. a real signed testnet
 * transaction. Every config below deliberately carries an empty
 * governanceAdminSecretKey (submitter stays null, disabledOnChain always
 * false), so the breaker's threshold branch is provably unreachable in
 * this suite. Exercising it for real would mean submitting live disable
 * transactions against the governance contract — a materially different
 * risk category from anything else in this suite, and out of scope
 * without an explicit go-ahead to do that against testnet.
 *
 * Safety (same posture as test_interventions_e2e.ts):
 *   - synthetic flight idents (ZZE2E0x admin-handler route, ZZE2E1x
 *     exposure-fixture routes) that cannot collide with a real route;
 *   - every chain config here has NO governanceAdminSecretKey, so
 *     pauseRoute/reviveRoute's submitter is always null;
 *   - the one shared global row touched (ops_flags.gov_frozen, via the
 *     freeze handler) is read before and restored to its exact prior
 *     value in a `finally`.
 *
 * Run: npm run test:e2e:admin   (from dapp/)
 */
import { loadDotEnv } from "../../scripts/env";
loadDotEnv();

if (!process.env.GOVERNANCE_DB_URL) {
  console.error(
    "GOVERNANCE_DB_URL not set (check dapp/.env) — this suite needs the real governance DB."
  );
  process.exit(1);
}

import { join, dirname } from "path";
import { fileURLToPath } from "url";
import type { VercelRequest, VercelResponse } from "@vercel/node";
import { getDb } from "../../api/_lib/governance/db";
import { ensureTable, type InterventionRoute, type InterventionRow } from "../../api/_lib/governance/interventions";
import { handler as interventionsHandler } from "../../api/admin/interventions";
import { handler as freezeHandler } from "../../api/admin/freeze";
import { run as exposureRun, type ExposureDeps } from "../../api/_lib/governance/exposure_collector";
import type { GovConfig } from "../../api/_lib/governance/config";
import type { SorobanClient } from "../../api/_lib/soroban_client";
import { check, summarize } from "../../scripts/e2e/harness";

const __dirname = dirname(fileURLToPath(import.meta.url));
const sql = getDb();

const AUTHED_EMAIL = "e2e-test@local";
const authedDeps = {
  verifyAdmin: async () => ({ email: AUTHED_EMAIL }),
  loadGovConfig: (): GovConfig => ({
    stellarRpcUrl: "http://fake-rpc.invalid",
    networkPassphrase: "e2e",
    governanceId: "GOV_FAKE",
    govAdminSecretKey: "",
    dryRun: false,
  }),
};
const unauthedDeps = { verifyAdmin: async () => null };

function fakeReq(opts: {
  method: string;
  query?: Record<string, string>;
  body?: unknown;
}): VercelRequest {
  return {
    method: opts.method,
    query: opts.query ?? {},
    body: opts.body,
    headers: {},
    cookies: {},
  } as unknown as VercelRequest;
}

interface CapturedRes {
  status: number;
  body: unknown;
}
function fakeRes(): { res: VercelResponse; captured: () => CapturedRes } {
  const captured: CapturedRes = { status: 0, body: undefined };
  const res = {
    status(code: number) {
      captured.status = code;
      return res;
    },
    json(body: unknown) {
      captured.body = body;
      return res;
    },
  } as unknown as VercelResponse;
  return { res, captured: () => captured };
}

async function cleanupRoute(r: InterventionRoute): Promise<void> {
  await sql`delete from interventions where flight_id = ${r.flight_id} and origin = ${r.origin} and dest = ${r.destination}`;
  await sql`delete from routes where flight_id = ${r.flight_id} and origin = ${r.origin} and dest = ${r.destination}`;
}

async function openFor(r: InterventionRoute): Promise<InterventionRow[]> {
  return (await sql`
    select * from interventions
    where flight_id = ${r.flight_id} and origin = ${r.origin} and dest = ${r.destination}
      and revived_at is null
  `) as unknown as InterventionRow[];
}

// ---------------------------------------------------------------------------
// admin/interventions.ts
// ---------------------------------------------------------------------------

const HANDLER_ROUTE: InterventionRoute = { flight_id: "ZZE2E01", origin: "ZZZ", destination: "YYY" };

async function testInterventionsHandler(): Promise<void> {
  console.log("\n── admin/interventions.ts handler ───────────────────────");
  await cleanupRoute(HANDLER_ROUTE);

  {
    const { res, captured } = fakeRes();
    await interventionsHandler(fakeReq({ method: "GET" }), res, unauthedDeps);
    check("unauthorized: 401 when verifyAdmin rejects", captured().status === 401, JSON.stringify(captured()));
  }

  {
    const { res, captured } = fakeRes();
    await interventionsHandler(fakeReq({ method: "POST", body: {} }), res, authedDeps);
    check("POST validation: 400 on missing fields", captured().status === 400, JSON.stringify(captured()));
  }

  let openedId: string | undefined;
  {
    const { res, captured } = fakeRes();
    await interventionsHandler(
      fakeReq({
        method: "POST",
        body: {
          flight_id: HANDLER_ROUTE.flight_id,
          origin: HANDLER_ROUTE.origin,
          dest: HANDLER_ROUTE.destination,
          reason: "e2e via handler",
        },
      }),
      res,
      authedDeps
    );
    const c = captured();
    check(
      "POST pause: 200 ok, chain untouched (no gov key)",
      c.status === 200 && (c.body as any)?.ok === true && /no gov key/.test((c.body as any)?.outcome ?? ""),
      JSON.stringify(c)
    );
  }

  {
    const open = await openFor(HANDLER_ROUTE);
    check("ledger: exactly one open admin row after the POST", open.length === 1 && open[0].cause === "admin", JSON.stringify(open));
    openedId = open[0]?.id;
  }

  {
    const { res, captured } = fakeRes();
    await interventionsHandler(fakeReq({ method: "GET", query: { state: "open", cause: "admin" } }), res, authedDeps);
    const c = captured();
    const body = c.body as { rows: InterventionRow[]; total: number; open_count: number };
    const found = body?.rows?.some((r) => r.flight_id === HANDLER_ROUTE.flight_id);
    check(
      "GET ?state=open&cause=admin: finds the just-opened row, response shape intact",
      c.status === 200 && found === true && typeof body.total === "number" && typeof body.open_count === "number",
      JSON.stringify(c)
    );
  }

  {
    const { res, captured } = fakeRes();
    await interventionsHandler(fakeReq({ method: "PATCH", body: {} }), res, authedDeps);
    check("PATCH validation: 400 on missing id", captured().status === 400, JSON.stringify(captured()));
  }

  {
    const { res, captured } = fakeRes();
    await interventionsHandler(fakeReq({ method: "PATCH", body: { id: openedId } }), res, authedDeps);
    const c = captured();
    check(
      "PATCH revive: 200 ok",
      c.status === 200 && (c.body as any)?.ok === true,
      JSON.stringify(c)
    );
  }

  {
    const open = await openFor(HANDLER_ROUTE);
    check("ledger: no open rows remain after PATCH revive", open.length === 0, JSON.stringify(open));
  }

  {
    const { res, captured } = fakeRes();
    await interventionsHandler(fakeReq({ method: "PATCH", body: { id: openedId } }), res, authedDeps);
    check("PATCH revive again (already closed): 404", captured().status === 404, JSON.stringify(captured()));
  }

  {
    const { res, captured } = fakeRes();
    await interventionsHandler(fakeReq({ method: "DELETE" }), res, authedDeps);
    check("unsupported method: 405", captured().status === 405, JSON.stringify(captured()));
  }

  await cleanupRoute(HANDLER_ROUTE);
}

// ---------------------------------------------------------------------------
// admin/freeze.ts
// ---------------------------------------------------------------------------

async function testFreezeHandler(): Promise<void> {
  console.log("\n── admin/freeze.ts handler ───────────────────────────────");
  const prior = (await sql`select value, note from ops_flags where key = 'gov_frozen'`) as unknown as Array<{
    value: boolean;
    note: string | null;
  }>;

  try {
    {
      const { res, captured } = fakeRes();
      await freezeHandler(fakeReq({ method: "GET" }), res, unauthedDeps);
      check("unauthorized: 401 when verifyAdmin rejects", captured().status === 401, JSON.stringify(captured()));
    }

    {
      const { res, captured } = fakeRes();
      await freezeHandler(fakeReq({ method: "POST", body: { frozen: true, note: "e2e-test" } }), res, authedDeps);
      const c = captured();
      check(
        "POST {frozen:true}: 200 ok, note stamped with admin email",
        c.status === 200 && (c.body as any)?.frozen === true && (c.body as any)?.note?.includes(AUTHED_EMAIL),
        JSON.stringify(c)
      );
    }

    {
      const { res, captured } = fakeRes();
      await freezeHandler(fakeReq({ method: "GET" }), res, authedDeps);
      const c = captured();
      check("GET reflects the just-set frozen=true", c.status === 200 && (c.body as any)?.frozen === true, JSON.stringify(c));
    }

    {
      const { res, captured } = fakeRes();
      await freezeHandler(fakeReq({ method: "POST", body: { frozen: false } }), res, authedDeps);
      check("POST {frozen:false}: 200 ok", captured().status === 200 && (captured().body as any)?.frozen === false, JSON.stringify(captured()));
    }

    {
      const { res, captured } = fakeRes();
      await freezeHandler(fakeReq({ method: "POST", body: {} }), res, authedDeps);
      check("POST validation: 400 when frozen is not boolean", captured().status === 400, JSON.stringify(captured()));
    }
  } finally {
    if (prior.length === 0) {
      await sql`delete from ops_flags where key = 'gov_frozen'`;
    } else {
      await sql`update ops_flags set value = ${prior[0].value}, note = ${prior[0].note}, updated_at = now() where key = 'gov_frozen'`;
    }
  }
}

// ---------------------------------------------------------------------------
// governance/exposure_collector.ts run() orchestration
// ---------------------------------------------------------------------------

const EXPOSURE_ROUTES: InterventionRoute[] = [
  { flight_id: "ZZE2E10", origin: "ZZA", destination: "ZZB" }, // route-scope severe (60%)
  { flight_id: "ZZE2E11", origin: "ZZC", destination: "ZZD" }, // 30% alone; airport ZZC severe combined
  { flight_id: "ZZE2E12", origin: "ZZC", destination: "ZZE" }, // 30% alone; airport ZZC severe combined
  { flight_id: "ZZE2E13", origin: "ZZF", destination: "ZZG" }, // 28% — elevated only, advisory
];

// payoff units chosen against a totalManaged of 1000: 600/300/300/280 → 0.6/0.3/0.3/0.28.
const EXPOSURE_LIABILITY: Record<string, number> = {
  ZZE2E10: 600,
  ZZE2E11: 300,
  ZZE2E12: 300,
  ZZE2E13: 280,
};

function makeFakeExposureClient(): SorobanClient {
  const date = 1893456000n; // arbitrary fixed date bucket
  return {
    symbolToScVal: (v: unknown) => v,
    u64ToScVal: (v: unknown) => v,
    async readContract(_contractId: string, fn: string, args: unknown[] = []): Promise<any> {
      switch (fn) {
        case "get_total_managed_assets":
          return 1000;
        case "get_active_flights":
          return EXPOSURE_ROUTES.map((r) => [r.flight_id, date]);
        case "get_flight_config": {
          const flightId = args[0] as string;
          return { status: "Active", payoff: EXPOSURE_LIABILITY[flightId], buyer_count: 1 };
        }
        default:
          throw new Error(`fake exposure client: unhandled read ${fn}`);
      }
    },
  } as unknown as SorobanClient;
}

async function testExposureOrchestration(): Promise<void> {
  console.log("\n── gov_exposure run() orchestration ──────────────────────");
  process.env.ROUTES_CONFIG_PATH = join(__dirname, "..", "fixtures", "routes.exposure_e2e.json");
  for (const r of EXPOSURE_ROUTES) await cleanupRoute(r);

  const config: GovConfig = {
    stellarRpcUrl: "http://fake-rpc.invalid",
    networkPassphrase: "e2e",
    governanceId: "GOV_FAKE",
    govAdminSecretKey: "",
    dryRun: false,
  };
  const deps: ExposureDeps = { client: makeFakeExposureClient() };

  try {
    const result = await exposureRun(config, deps);
    check("run succeeds", result.success, result.error ?? "");

    const open10 = await openFor(EXPOSURE_ROUTES[0]);
    check(
      "route-scope severe (ZZE2E10, 60% alone): exactly one open exposure row",
      open10.length === 1 && open10[0].cause === "exposure",
      JSON.stringify(open10)
    );

    const open11 = await openFor(EXPOSURE_ROUTES[1]);
    const open12 = await openFor(EXPOSURE_ROUTES[2]);
    check(
      "airport-scope severe (ZZC aggregates ZZE2E11+ZZE2E12 to 60%): both routes paused",
      open11.length === 1 && open11[0].cause === "exposure" && open12.length === 1 && open12[0].cause === "exposure",
      `ZZE2E11=${JSON.stringify(open11)} ZZE2E12=${JSON.stringify(open12)}`
    );

    const open13 = await openFor(EXPOSURE_ROUTES[3]);
    check("elevated-only (ZZE2E13, 28%): no pause, advisory only", open13.length === 0, JSON.stringify(open13));
    check(
      "run log records the elevated advisory note",
      (result.actions ?? []).some((a) => /elevated exposure/.test(a.skipped ?? "")),
      JSON.stringify(result.actions)
    );
  } finally {
    for (const r of EXPOSURE_ROUTES) await cleanupRoute(r);
  }

  // ── dry-run: computes the same severities but writes nothing ──────────
  try {
    const dryConfig: GovConfig = { ...config, dryRun: true };
    const result = await exposureRun(dryConfig, deps);
    check("dry-run succeeds", result.success, result.error ?? "");
    check(
      "dry-run: run log records 'would pause' for the severe routes, no ledger writes",
      (result.actions ?? []).some((a) => /\[dry-run\] would pause/.test(a.skipped ?? "")),
      JSON.stringify(result.actions)
    );
    for (const r of [EXPOSURE_ROUTES[0], EXPOSURE_ROUTES[1], EXPOSURE_ROUTES[2]]) {
      const open = await openFor(r);
      check(`dry-run: ${r.flight_id} has no ledger row`, open.length === 0, JSON.stringify(open));
    }
  } finally {
    for (const r of EXPOSURE_ROUTES) await cleanupRoute(r);
    delete process.env.ROUTES_CONFIG_PATH;
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  console.log(
    "Connected to GOVERNANCE_DB_URL (live governance Supabase project). " +
      "Synthetic routes only (ZZE2E0x/ZZE2E1x); every chain config here carries no " +
      "governanceAdminSecretKey, so no on-chain writes will occur."
  );
  await ensureTable(sql);

  try {
    await testInterventionsHandler();
    await testFreezeHandler();
    await testExposureOrchestration();
  } finally {
    await cleanupRoute(HANDLER_ROUTE);
    for (const r of EXPOSURE_ROUTES) await cleanupRoute(r);
    await sql.end({ timeout: 5 });
  }

  process.exit(summarize());
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
