/**
 * Standalone bot runner — every protocol job as a single-shot CLI.
 *
 * The Vercel crons are just OUR schedule for these bots. Three tiers:
 *
 * - GOVERNANCE (gov_signals, gov_reconcile, route_agent) — centralized,
 *   ours by design; gov-admin key + governance DB.
 * - ORACLE (fetcher, sale_authorizer) — centralized trust root, ours by
 *   design; AeroAPI + the authorized_oracle key.
 * - KEEPERS / liquidators (classifier, settler, queue_maintainer,
 *   ttl_extender) — the decentralization target: they execute what the
 *   oracle already attested, need no AeroAPI key and no DB.
 *   `ttl_extender` is permissionless on-chain today (any funded key);
 *   the others use the authorized_keeper key until the bounty upgrade
 *   opens them (spec/TODO.md §E).
 *
 *   npm run bot -- fetcher            # or: npx tsx scripts/run_bot.ts fetcher
 *   npm run bot -- settler
 *   npm run bot -- gov_signals
 *
 * Env: same variables as the crons (see README "Env vars").
 *
 * DB-optional invariant: the settlement-path bots never REQUIRE the
 * governance DB — run history is recorded only when GOVERNANCE_DB_URL is
 * set, and a DB outage never fails a bot that did its on-chain work.
 *
 * Exit code: 0 when the run succeeded, 1 otherwise. The RunLogEntry is
 * printed as JSON so external schedulers (systemd, GitHub Actions, TEE
 * harnesses) can ingest it.
 */
import { loadDotEnv } from "./env";
loadDotEnv(); // dapp/.env for local runs; real env vars always win
import { loadConfig } from "../api/_lib/config";
import { loadGovConfig } from "../api/_lib/governance/config";
import { recordRun } from "../api/_lib/governance/runs";
import type { JobName, RunLogEntry } from "../api/_lib/types";
import { run as runFetcher } from "../api/_lib/jobs/fetcher";
import { run as runAuthorizer } from "../api/_lib/jobs/authorizer";
import { run as runClassifier } from "../api/_lib/jobs/classifier";
import { run as runSettler } from "../api/_lib/jobs/settler";
import { run as runQueue } from "../api/_lib/jobs/queue";
import { run as runTtl } from "../api/_lib/jobs/ttl";
import { run as runRouteAgent } from "../api/_lib/jobs/route_agent";
import { run as runGovReconcile } from "../api/_lib/governance/reconciler";
import { run as runGovSignals } from "../api/_lib/governance/signals_collector";
import { run as runGovExposure } from "../api/_lib/governance/exposure_collector";
import { run as runGovOnboard } from "../api/_lib/governance/onboard";

const BOTS: Partial<Record<JobName, () => Promise<RunLogEntry>>> = {
  fetcher: () => runFetcher(loadConfig()),
  sale_authorizer: () => runAuthorizer(loadConfig()),
  classifier: () => runClassifier(loadConfig()),
  settler: () => runSettler(loadConfig()),
  queue_maintainer: () => runQueue(loadConfig()),
  ttl_extender: () => runTtl(loadConfig()),
  route_agent: () => runRouteAgent(loadGovConfig()),
  gov_reconcile: () => runGovReconcile(loadGovConfig()),
  gov_signals: () => runGovSignals(loadGovConfig()),
  gov_exposure: () => runGovExposure(loadGovConfig()),
  gov_onboard: () => runGovOnboard(loadGovConfig()),
};

async function main(): Promise<void> {
  const name = process.argv[2] as JobName | undefined;
  const bot = name && BOTS[name];
  if (!bot) {
    console.error(`Usage: npm run bot -- <name>\nAvailable: ${Object.keys(BOTS).join(", ")}`);
    process.exit(2);
  }

  const entry = await bot();
  // Best-effort history (no-op without GOVERNANCE_DB_URL).
  await recordRun(entry, "external");
  console.log(JSON.stringify(entry, null, 2));
  process.exit(entry.success ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
