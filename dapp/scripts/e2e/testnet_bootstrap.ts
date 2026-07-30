/**
 * One-time bootstrap for the REAL-CHAIN E2E suite (test_testnet_e2e.ts).
 *
 * Deploys a dedicated, throwaway instance set of the Sentinel contracts on
 * Stellar testnet — NEVER the live deployment in deployments/testnet.json —
 * then wires and capitalizes it:
 *
 *   1. generate + friendbot-fund three keypairs:
 *        owner  — contract owner, gov admin, underwriter
 *        ops    — authorized oracle AND keeper AND ttl (one key, by design:
 *                 the contracts authorize by address, and the suite is the
 *                 only operator)
 *        buyer  — policy purchaser / claimant
 *   2. deploy mock_usdc, governance_module, oracle_aggregator, risk_vault,
 *      flight_pool_manager, controller from the committed build artifacts
 *      (contracts/target/wasm32v1-none/release — run `make -C contracts
 *      build` if missing; contract SOURCE is never touched)
 *   3. wire: set_controller ×3, set_min_withdrawal_request, set_term_limits
 *   4. mint USDC to buyer + owner; owner queues a vault deposit
 *
 * The deposit only mints into TMA after the vault's LP_PRICING_DELAY
 * (6h, an on-chain constant) — the suite runs the real queue-maintenance
 * keeper job to mint it and tells you how long is left if it hasn't
 * ripened. Bootstrap once; the deployment is cached in .testnet-e2e.json
 * (gitignored — testnet-only keys) and reused by every suite run.
 *
 * Run (from dapp/):  npm run test:e2e:testnet:bootstrap
 */

import { execFileSync } from "child_process";
import { existsSync, readFileSync, writeFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { Keypair } from "@stellar/stellar-sdk";
import { SorobanClient } from "../../api/_lib/soroban_client";
import type { Config } from "../../api/_lib/types";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..", "..", "..");
const WASM_DIR = join(REPO_ROOT, "contracts", "target", "wasm32v1-none", "release");
export const CACHE_PATH = join(__dirname, ".testnet-e2e.json");

const RPC_URL = "https://soroban-testnet.stellar.org";
const PASSPHRASE = "Test SDF Network ; September 2015";
const FRIENDBOT = "https://friendbot.stellar.org";

// 7-decimal token units. Terms deliberately small and fixed: premium 45,
// payoff 450, delay threshold 2h (the 180-min delayed scenario clears it).
const UNIT = 10_000_000n;
const PREMIUM = 45n * UNIT;
const PAYOFF = 450n * UNIT;
const DELAY_HOURS = 2;
const MINT = 100_000n * UNIT; // buyer + owner balance
const DEPOSIT = 10_000n * UNIT; // vault capital — covers many concurrent runs
const LP_PRICING_DELAY_SECS = 6 * 3600; // mirrors risk_vault constant

/** In-flight two-phase run state (see test_testnet_e2e.ts). */
export interface PendingRun {
  /** ident → scenario role (onTime/delayed210/delayed120/lost/govStorm/govPrice/govMl). */
  flights: Record<string, string>;
  date: string; // u64 secs as string
  schedEpoch: number; // unix secs — mock sched_in pinned here in BOTH phases
  resumeAt: number; // unix secs — flight-day phase runnable from here
  /** Running expected net USDC delta for the buyer across the whole run. */
  buyerExpectedDelta: string; // i128 base units as string
  buyerStartBalance: string; // i128 base units as string
  lockedAtStart: string; // vault locked capital before this run's purchases
}

export interface E2eDeployment {
  rpcUrl: string;
  passphrase: string;
  ownerSecret: string;
  opsSecret: string;
  buyerSecret: string;
  usdcId: string;
  governanceId: string;
  oracleId: string;
  vaultId: string;
  poolId: string;
  controllerId: string;
  premium: string;
  payoff: string;
  delayHours: number;
  depositReadyAt: number; // unix secs — vault deposit mintable after this
  runCounter: number; // consumed by the suite for unique per-run idents
  deployedAt: string;
  pending?: PendingRun | null;
}

export function loadDeployment(): E2eDeployment | null {
  if (!existsSync(CACHE_PATH)) return null;
  return JSON.parse(readFileSync(CACHE_PATH, "utf8")) as E2eDeployment;
}

export function saveDeployment(d: E2eDeployment): void {
  writeFileSync(CACHE_PATH, JSON.stringify(d, null, 2) + "\n");
}

export function deploymentConfig(d: E2eDeployment, aeroApiBaseUrl: string): Config {
  return {
    stellarRpcUrl: d.rpcUrl,
    networkPassphrase: d.passphrase,
    oracleAggregatorId: d.oracleId,
    controllerId: d.controllerId,
    riskVaultId: d.vaultId,
    governanceId: d.governanceId,
    flightPoolManagerId: d.poolId,
    oracleSecretKey: d.opsSecret,
    keeperSecretKey: d.opsSecret,
    ttlExtenderSecretKey: d.opsSecret,
    aeroApiBaseUrl,
    aeroApiKey: "e2e",
    // 1h settle delay: the suite's pinned ETA is 06:00Z on the flight day,
    // so the flight-day phase is runnable from ~07:00Z (vs 5h in prod).
    settleAfterEtaSecs: 3_600,
    saleAuthHorizonDays: 2, // near window only — no /schedules churn
    saleAuthValiditySecs: 21_600,
    // The throwaway deployment's contract min-lead is 60s; mirror it here
    // so the JIT check authorizes tomorrow's 03:00Z departures.
    saleMinLeadSecs: 60,
    weatherBaseUrl: "http://fake-weather.invalid",
  };
}

async function fundAccount(publicKey: string): Promise<void> {
  const r = await fetch(`${FRIENDBOT}?addr=${publicKey}`);
  // 400 = already funded — fine for re-runs.
  if (!r.ok && r.status !== 400) {
    throw new Error(`friendbot ${publicKey.slice(0, 6)}…: HTTP ${r.status}`);
  }
}

function deploy(wasm: string, sourceSecret: string, ctorArgs: string[]): string {
  const out = execFileSync(
    "stellar",
    [
      "contract",
      "deploy",
      "--wasm",
      join(WASM_DIR, `${wasm}.wasm`),
      "--source-account",
      sourceSecret,
      "--rpc-url",
      RPC_URL,
      "--network-passphrase",
      PASSPHRASE,
      "--",
      ...ctorArgs,
    ],
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }
  );
  const id = out
    .trim()
    .split("\n")
    .reverse()
    .find((l) => /^C[A-Z2-7]{55}$/.test(l.trim()));
  if (!id) throw new Error(`could not parse contract id from stellar CLI output:\n${out}`);
  return id.trim();
}

async function main(): Promise<void> {
  const existing = loadDeployment();
  if (existing && !process.argv.includes("--fresh")) {
    console.log(`Deployment already cached at ${CACHE_PATH} (controller ${existing.controllerId.slice(0, 8)}…).`);
    console.log("Pass --fresh to deploy a new instance set (e.g. after a testnet reset).");
    return;
  }

  for (const w of ["mock_usdc", "governance_module", "oracle_aggregator", "risk_vault", "flight_pool_manager", "controller"]) {
    if (!existsSync(join(WASM_DIR, `${w}.wasm`))) {
      throw new Error(`${w}.wasm missing from ${WASM_DIR} — run: make -C contracts build`);
    }
  }

  console.log("Generating + funding e2e keypairs (owner, ops, buyer)...");
  const owner = Keypair.random();
  const ops = Keypair.random();
  const buyer = Keypair.random();
  await Promise.all([fundAccount(owner.publicKey()), fundAccount(ops.publicKey()), fundAccount(buyer.publicKey())]);
  console.log(`  owner ${owner.publicKey()}\n  ops   ${ops.publicKey()}\n  buyer ${buyer.publicKey()}`);

  console.log("Deploying contracts (fresh instance set — the live deployment is untouched)...");
  const usdcId = deploy("mock_usdc", owner.secret(), ["--admin", owner.publicKey()]);
  console.log(`  mock_usdc            ${usdcId}`);
  const governanceId = deploy("governance_module", owner.secret(), [
    "--owner", owner.publicKey(),
    "--default_premium", PREMIUM.toString(),
    "--default_payoff", PAYOFF.toString(),
    "--default_delay_hours", String(DELAY_HOURS),
  ]);
  console.log(`  governance_module    ${governanceId}`);
  const oracleId = deploy("oracle_aggregator", owner.secret(), [
    "--owner", owner.publicKey(),
    "--authorized_oracle", ops.publicKey(),
  ]);
  console.log(`  oracle_aggregator    ${oracleId}`);
  const vaultId = deploy("risk_vault", owner.secret(), [
    "--owner", owner.publicKey(),
    "--asset_token", usdcId,
    "--oracle", oracleId,
  ]);
  console.log(`  risk_vault           ${vaultId}`);
  const poolId = deploy("flight_pool_manager", owner.secret(), [
    "--owner", owner.publicKey(),
    "--asset_token", usdcId,
    "--risk_vault", vaultId,
  ]);
  console.log(`  flight_pool_manager  ${poolId}`);
  const controllerId = deploy("controller", owner.secret(), [
    "--owner", owner.publicKey(),
    "--governance", governanceId,
    "--risk_vault", vaultId,
    "--oracle", oracleId,
    "--flight_pool_manager", poolId,
    "--asset_token", usdcId,
    "--authorized_keeper", ops.publicKey(),
    "--min_lead_time_secs", "60",
    "--claim_expiry_window_secs", "86400",
  ]);
  console.log(`  controller           ${controllerId}`);

  const d: E2eDeployment = {
    rpcUrl: RPC_URL,
    passphrase: PASSPHRASE,
    ownerSecret: owner.secret(),
    opsSecret: ops.secret(),
    buyerSecret: buyer.secret(),
    usdcId,
    governanceId,
    oracleId,
    vaultId,
    poolId,
    controllerId,
    premium: PREMIUM.toString(),
    payoff: PAYOFF.toString(),
    delayHours: DELAY_HOURS,
    depositReadyAt: 0,
    runCounter: 0,
    deployedAt: new Date().toISOString(),
  };
  saveDeployment(d); // persist before wiring so a wiring crash is resumable by hand

  const client = new SorobanClient(deploymentConfig(d, "http://unused.invalid"));
  const addr = (a: string) => client.addressToScVal(a);
  const i128 = (v: bigint) => client.i128ToScVal(v);

  console.log("Wiring (set_controller ×3, withdrawal floor, term limits)...");
  await client.invokeContract(oracleId, "set_controller", [addr(controllerId)], owner.secret());
  await client.invokeContract(vaultId, "set_controller", [addr(controllerId)], owner.secret());
  await client.invokeContract(poolId, "set_controller", [addr(controllerId)], owner.secret());
  await client.invokeContract(vaultId, "set_min_withdrawal_request", [i128(10n)], owner.secret());
  await client.invokeContract(
    governanceId,
    "set_term_limits",
    [i128(1_000n * UNIT), i128(20n)],
    owner.secret()
  );

  console.log("Minting USDC + queuing the vault deposit...");
  await client.invokeContract(usdcId, "mint", [addr(buyer.publicKey()), i128(MINT)], owner.secret());
  await client.invokeContract(usdcId, "mint", [addr(owner.publicKey()), i128(MINT)], owner.secret());
  await client.invokeContract(
    vaultId,
    "request_deposit",
    [addr(owner.publicKey()), i128(DEPOSIT)],
    owner.secret()
  );

  d.depositReadyAt = Math.floor(Date.now() / 1000) + LP_PRICING_DELAY_SECS + 120; // +2min margin
  saveDeployment(d);

  console.log(`\nBootstrap complete. Cached → ${CACHE_PATH}`);
  console.log(
    `Vault deposit ripens at ${new Date(d.depositReadyAt * 1000).toISOString()} ` +
      `(LP pricing delay, ~6h). Run \`npm run test:e2e:testnet\` after that; ` +
      `the suite mints it via the real queue-maintenance job.`
  );
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
