/**
 * End-to-end tests for the governance interventions ledger — REAL Postgres
 * (dapp/.env's GOVERNANCE_DB_URL, the live governance Supabase project),
 * NO real chain.
 *
 * This is the "admin has to come save everything" suite: gov_frozen kill
 * switch, pinned-route override, multi-cause overlap/heal, idempotent
 * re-pause, the exposure clear-streak hysteresis, and the recordCheck/
 * checkedRecently call-economy dedupe. None of this is covered by
 * test_oracle_e2e.ts — that suite deliberately deletes GOVERNANCE_DB_URL
 * to pin the DB-LESS degrade path; this suite is its DB-ATTACHED
 * counterpart.
 *
 * Safety, since this runs against the live project (not a throwaway
 * branch/project):
 *   - every row this suite writes uses a synthetic flight_id (ZZE2E01)
 *     that cannot collide with a real seeded route, and is deleted in a
 *     `finally` after every test and again at the very end;
 *   - the GovChainConfig below carries NO governanceAdminSecretKey, so
 *     pauseRoute/reviveRoute's submitter is always null — this suite can
 *     record ledger rows but can never disable/enable anything on-chain;
 *   - the one shared, global row this suite touches — ops_flags.gov_frozen
 *     — is read before the gov_frozen test and restored to its exact
 *     prior value in a `finally`, so a real cron running concurrently
 *     sees at most a momentary freeze it would naturally retry anyway.
 *
 * Run: npm run test:e2e:gov   (from dapp/)
 */
import { loadDotEnv } from "../../scripts/env";
loadDotEnv();

if (!process.env.GOVERNANCE_DB_URL) {
  console.error(
    "GOVERNANCE_DB_URL not set (check dapp/.env) — this suite needs the real governance DB."
  );
  process.exit(1);
}

import { getDb } from "../../api/_lib/governance/db";
import {
  pauseRoute,
  reviveRoute,
  touchIntervention,
  recordClearCheck,
  recordCheck,
  checkedRecently,
  claimDisableSlot,
  releaseDisableSlot,
  ensureTable,
  type GovChainConfig,
  type InterventionRoute,
  type InterventionRow,
} from "../../api/_lib/governance/interventions";
import { check, summarize } from "../../scripts/e2e/harness";

const sql = getDb();

// Synthetic — guaranteed not to collide with any real seeded route.
const ROUTE: InterventionRoute = { flight_id: "ZZE2E01", origin: "ZZZ", destination: "YYY" };

// Deliberately no governanceAdminSecretKey: the executor's submitter must
// stay null for this whole suite, so every pause/revive here is DB-only.
const chainConfig: GovChainConfig = {
  stellarRpcUrl: "http://fake-rpc.invalid",
  networkPassphrase: "e2e",
  governanceId: "GOV_FAKE",
};

async function cleanupRoute(r: InterventionRoute): Promise<void> {
  await sql`delete from interventions where flight_id = ${r.flight_id} and origin = ${r.origin} and dest = ${r.destination}`;
  await sql`delete from routes where flight_id = ${r.flight_id} and origin = ${r.origin} and dest = ${r.destination}`;
}

async function openFor(r: InterventionRoute): Promise<InterventionRow[]> {
  return (await sql`
    select * from interventions
    where flight_id = ${r.flight_id} and origin = ${r.origin} and dest = ${r.destination}
      and revived_at is null
    order by opened_at
  `) as unknown as InterventionRow[];
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

async function testAdminPauseRevive(): Promise<void> {
  console.log("\n── admin manual pause / revive ──────────────────────────");
  await cleanupRoute(ROUTE);
  const actor = "admin:e2e-test@local";

  const res = await pauseRoute(chainConfig, ROUTE, "admin", { reason: "e2e test" }, actor);
  check(
    "admin pause: recorded in the ledger, chain untouched (no gov key)",
    res.outcome.includes("no gov key") && !res.disabledOnChain,
    res.outcome
  );
  let open = await openFor(ROUTE);
  check("admin pause: exactly one open row, cause=admin", open.length === 1 && open[0].cause === "admin", JSON.stringify(open));

  const revived = await reviveRoute(chainConfig, ROUTE, "admin", actor);
  check("admin revive: closes the row", /cleared/.test(revived), revived);
  open = await openFor(ROUTE);
  check("admin revive: no open rows remain", open.length === 0);

  await cleanupRoute(ROUTE);
}

async function testMultiCauseOverlap(): Promise<void> {
  console.log("\n── multi-cause overlap (each cause heals independently) ──");
  await cleanupRoute(ROUTE);

  await pauseRoute(chainConfig, ROUTE, "weather", { gust: 130 }, "cron:weather");
  await pauseRoute(chainConfig, ROUTE, "exposure", { frac: 0.6 }, "cron:gov_exposure");
  let open = await openFor(ROUTE);
  check("both weather + exposure open on the same route", open.length === 2, open.map((o) => o.cause).join(","));

  const r1 = await reviveRoute(chainConfig, ROUTE, "weather", "cron:revive");
  check(
    "reviving weather alone leaves the route paused (exposure still holds it)",
    /still paused/.test(r1) && /exposure/.test(r1),
    r1
  );
  open = await openFor(ROUTE);
  check("exposure row still open after weather clears", open.length === 1 && open[0].cause === "exposure");

  const r2 = await reviveRoute(chainConfig, ROUTE, "exposure", "cron:revive");
  check("reviving the last open cause fully clears the route", /cleared/.test(r2), r2);
  open = await openFor(ROUTE);
  check("no open rows after both causes clear", open.length === 0);

  await cleanupRoute(ROUTE);
}

async function testGovFrozen(): Promise<void> {
  console.log("\n── gov_frozen kill switch ────────────────────────────────");
  const prior = (await sql`select value, note from ops_flags where key = 'gov_frozen'`) as unknown as Array<{
    value: boolean;
    note: string | null;
  }>;

  try {
    await sql`
      insert into ops_flags (key, value, note, updated_at)
      values ('gov_frozen', true, 'e2e-test (temporary)', now())
      on conflict (key) do update set value = true, note = 'e2e-test (temporary)', updated_at = now()
    `;
    await cleanupRoute(ROUTE);

    const auto = await pauseRoute(chainConfig, ROUTE, "weather", { gust: 130 }, "cron:weather");
    check("frozen: automated pause is skipped", auto.outcome.includes("gov_frozen"), auto.outcome);
    let open = await openFor(ROUTE);
    check("frozen: no ledger row written for the blocked automated pause", open.length === 0);

    const admin = await pauseRoute(chainConfig, ROUTE, "admin", { reason: "override" }, "admin:e2e-test@local");
    check("frozen: admin pause is NOT blocked by the freeze", !admin.outcome.includes("gov_frozen"), admin.outcome);
    open = await openFor(ROUTE);
    check("frozen: admin row opened despite the freeze", open.length === 1 && open[0].cause === "admin");

    await cleanupRoute(ROUTE);
  } finally {
    if (prior.length === 0) {
      await sql`delete from ops_flags where key = 'gov_frozen'`;
    } else {
      await sql`update ops_flags set value = ${prior[0].value}, note = ${prior[0].note}, updated_at = now() where key = 'gov_frozen'`;
    }
  }
}

async function testPinnedRoute(): Promise<void> {
  console.log("\n── pinned route overrides automated causes, not admin ───");
  await cleanupRoute(ROUTE);
  const pinUntil = new Date(Date.now() + 3600_000).toISOString();
  await sql`
    insert into routes (flight_id, origin, dest, pinned, pin_until)
    values (${ROUTE.flight_id}, ${ROUTE.origin}, ${ROUTE.destination}, true, ${pinUntil})
  `;

  const auto = await pauseRoute(chainConfig, ROUTE, "exposure", { frac: 0.6 }, "cron:gov_exposure");
  check("pinned: automated pause is skipped", auto.outcome.includes("pinned"), auto.outcome);
  let open = await openFor(ROUTE);
  check("pinned: no ledger row written for the blocked automated pause", open.length === 0);

  const admin = await pauseRoute(chainConfig, ROUTE, "admin", { reason: "override pin" }, "admin:e2e-test@local");
  check("pinned: admin pause overrides the pin", !admin.outcome.includes("pinned"), admin.outcome);
  open = await openFor(ROUTE);
  check("pinned: admin row opened despite the pin", open.length === 1 && open[0].cause === "admin");

  await cleanupRoute(ROUTE);
}

async function testIdempotentRepause(): Promise<void> {
  console.log("\n── idempotent re-pause (same route+cause dedupes) ────────");
  await cleanupRoute(ROUTE);

  await pauseRoute(chainConfig, ROUTE, "cancellation", { day: "+1" }, "guard:sale-auth");
  await pauseRoute(chainConfig, ROUTE, "cancellation", { day: "+2" }, "guard:sale-auth");
  const open = await openFor(ROUTE);
  check("re-pausing the same (route, cause) leaves exactly one open row", open.length === 1, String(open.length));
  check(
    "the open row's evidence refreshes to the latest call",
    JSON.stringify(open[0]?.evidence) === JSON.stringify({ day: "+2" }),
    JSON.stringify(open[0]?.evidence)
  );

  await cleanupRoute(ROUTE);
}

async function testClearStreakHysteresis(): Promise<void> {
  console.log("\n── exposure clear-streak hysteresis primitives ──────────");
  await cleanupRoute(ROUTE);

  await pauseRoute(chainConfig, ROUTE, "exposure", { frac: 0.6 }, "cron:gov_exposure");
  const opened = await openFor(ROUTE);
  check("clear_streak starts at 0 when a cause opens", opened[0]?.clear_streak === 0, String(opened[0]?.clear_streak));

  const s1 = await recordClearCheck(opened[0].id);
  check("first consecutive clear check -> streak 1", s1 === 1, String(s1));
  const s2 = await recordClearCheck(opened[0].id);
  check("second consecutive clear check -> streak 2 (revive.ts's EXPOSURE_CLEAR_STREAK)", s2 === 2, String(s2));

  // A still-holding reading between clear checks (touchIntervention) must
  // reset the streak — a relapse restarts hysteresis from zero.
  await touchIntervention(opened[0].id, { frac: 0.6 });
  const row = (await sql`select clear_streak from interventions where id = ${opened[0].id}`) as unknown as Array<{
    clear_streak: number;
  }>;
  check(
    "a relapse (touchIntervention) resets clear_streak to 0",
    row[0]?.clear_streak === 0,
    String(row[0]?.clear_streak)
  );

  await cleanupRoute(ROUTE);
}

async function testRecordCheckDedupe(): Promise<void> {
  console.log("\n── recordCheck / checkedRecently call-economy dedupe ────");
  await cleanupRoute(ROUTE);

  const before = await checkedRecently(ROUTE, "cancellation", 24);
  check("checkedRecently: false before any check is recorded", before === false);

  await recordCheck(ROUTE, "cancellation", { days: ["dead", "dead"] }, "cron:revive");
  const after = await checkedRecently(ROUTE, "cancellation", 24);
  check("checkedRecently: true immediately after recordCheck", after === true);

  const open = await openFor(ROUTE);
  check("recordCheck with no prior open row writes a pre-closed row, not an open pause", open.length === 0);

  await cleanupRoute(ROUTE);
}

async function testDisableSlotBudget(): Promise<void> {
  console.log("\n── OCA-H01: cross-run hourly disable-slot budget ────────");
  // The budget table is shared accounting, not a ledger — wiping it only
  // resets this hour's automated-pause allowance, safe on testnet. The
  // first claim creates the table if this is a fresh database.
  await claimDisableSlot(1);
  await sql`delete from gov_disable_slots`;
  const cap = 3;

  const claims: boolean[] = [];
  for (let i = 0; i < cap; i++) claims.push(await claimDisableSlot(cap));
  check("claims 1..cap all succeed", claims.every(Boolean), JSON.stringify(claims));

  const over = await claimDisableSlot(cap);
  check("claim cap+1 refused — budget spent for the hour", over === false);

  // A "concurrent run" is just another process hitting the same window row:
  // it must see the spent budget rather than its own fresh counter.
  const concurrent = await claimDisableSlot(cap);
  check("second run's claim against the spent budget also refused", concurrent === false);

  await releaseDisableSlot();
  const reclaimed = await claimDisableSlot(cap);
  check("released slot (no on-chain disable happened) is re-claimable", reclaimed === true);

  await sql`delete from gov_disable_slots`;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  console.log(
    "Connected to GOVERNANCE_DB_URL (live governance Supabase project). " +
      `Using synthetic route ${ROUTE.flight_id} ${ROUTE.origin}->${ROUTE.destination}; ` +
      "no governanceAdminSecretKey configured, so no on-chain writes will occur."
  );
  await ensureTable(sql);

  try {
    await testAdminPauseRevive();
    await testMultiCauseOverlap();
    await testGovFrozen();
    await testPinnedRoute();
    await testIdempotentRepause();
    await testClearStreakHysteresis();
    await testRecordCheckDedupe();
    await testDisableSlotBudget();
  } finally {
    await cleanupRoute(ROUTE);
    await sql.end({ timeout: 5 });
  }

  process.exit(summarize());
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
