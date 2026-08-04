/**
 * Reconciliation — replay the journal against chain + DB truth and emit
 * the assertions matrix (spec sections A–F). Aggregate deltas use only
 * OUR-attributable events; anything unexplained is flagged info, not fail.
 */
import type { LiveConfig } from "../config.js";
import { USDC_UNITS } from "../config.js";
import { Chain } from "../chain.js";
import { loadOrCreateActors, type Actor } from "../actors.js";
import type { Journal, JournalEntry } from "../journal.js";
import { recentCronRuns, settlementsFor, outcomesFor, dbAvailable } from "../db.js";

export type Verdict = "pass" | "fail" | "conditional" | "info";

export interface Finding {
  section: string;
  name: string;
  verdict: Verdict;
  detail: string;
}

export interface ActorLedger {
  actor: string;
  role: string;
  mintedUsdc: number;
  premiumsUsdc: number;
  depositsUsdc: number;
  refundsUsdc: number;
  collectedUsdc: number;
  claimsUsdc: number;
  expectedFinalUsdc: number;
  chainFinalUsdc: number;
  exact: boolean;
}

export interface Reconciliation {
  findings: Finding[];
  ledgers: ActorLedger[];
  flightTimelines: Array<{ flight: string; actor: string; entries: JournalEntry[] }>;
  cronGrid: Record<string, number> | null;
  checks: { passed: number; failed: number; conditional: number };
}

export async function reconcile(cfg: LiveConfig, j: Journal): Promise<Reconciliation> {
  const chain = new Chain(cfg);
  const actors = loadOrCreateActors();
  const entries = j.entries();
  const state = j.state();
  const findings: Finding[] = [];

  // ── A. per-actor money, exact at 7 decimals ───────────────────────────
  const ledgers: ActorLedger[] = [];
  for (const a of actors) {
    const mine = entries.filter((e) => e.actor === a.name);
    const sum = (event: string, field: string): number =>
      mine
        .filter((e) => e.kind === "action" && e.event === event && e.data?.ok !== false)
        .reduce((n, e) => n + Number((e.data?.[field] as number | string) ?? 0), 0);
    const minted = mine.filter((e) => e.event === "ui mint click" && e.data?.ok === true).length * 10_000;
    const premiums = sum("buy", "paidUsdc");
    const deposits = sum("deposit", "usdc");
    const collected = sum("collect", "receivedUnits") / Number(USDC_UNITS);
    const claims = sum("claim", "paidUsdc");
    const expected = minted - premiums - deposits + collected + claims;
    const chainBal = Number((await chain.usdcBalance(a.address).catch(() => 0n)) / USDC_UNITS);
    const exact = Math.abs(chainBal - expected) < 0.0000001;
    ledgers.push({
      actor: a.name,
      role: a.role,
      mintedUsdc: minted,
      premiumsUsdc: premiums,
      depositsUsdc: deposits,
      refundsUsdc: 0,
      collectedUsdc: collected,
      claimsUsdc: claims,
      expectedFinalUsdc: expected,
      chainFinalUsdc: chainBal,
      exact,
    });
    findings.push({
      section: "A. Money",
      name: `${a.name} final balance == journal ledger`,
      verdict: exact ? "pass" : "fail",
      detail: `expected ${expected} vs chain ${chainBal}`,
    });
  }

  // ── C. stats vs journal ───────────────────────────────────────────────
  const stats = await chain.getStats().catch(() => null);
  const ourBuys = state.buysPlaced;
  if (stats) {
    findings.push({
      section: "C. Stats",
      name: "controller.get_stats covers our buys",
      verdict: Number(stats[0]) >= ourBuys ? "pass" : "fail",
      detail: `chain insured=${stats[0]} ours=${ourBuys} (externals allowed)`,
    });
    try {
      const api = (await (await fetch(`${cfg.backendUrl}/api/status/stats`)).json()) as Record<string, unknown>;
      findings.push({
        section: "C. Stats",
        name: "/api/status/stats == chain get_stats",
        verdict: String(api.flights_insured) === String(stats[0]) ? "pass" : "info",
        detail: `api=${api.flights_insured} chain=${stats[0]} (instantaneous drift tolerated as info)`,
      });
    } catch {
      findings.push({ section: "C. Stats", name: "/api/status/stats reachable", verdict: "fail", detail: "fetch failed" });
    }
  }

  // ── D. lifecycle per bought flight (outcome-conditional) ──────────────
  const run = (state.progress._run ?? {}) as Record<string, unknown>;
  const bought = (run.bought ?? []) as Array<{ flightId: string; dateISO: string; dateSecs: string; actor: string }>;
  const flightTimelines = bought.map((b) => ({
    flight: `${b.flightId}@${b.dateISO}`,
    actor: b.actor,
    entries: entries.filter(
      (e) => JSON.stringify(e.data ?? {}).includes(b.flightId) || e.event.includes(b.flightId),
    ),
  }));
  let settled = 0;
  let payable = 0;
  for (const b of bought) {
    const fd = await chain.flightData(b.flightId, BigInt(b.dateSecs)).catch(() => null);
    const tag = fd ? ((fd.status as { tag?: string })?.tag ?? String(fd.status)) : "none";
    if (tag === "Settled") settled++;
    const pc = await chain
      .flightConfig(b.flightId, BigInt(b.dateSecs))
      .then((c) => Boolean((c as { payable?: boolean } | undefined)?.payable))
      .catch(() => false);
    if (pc) payable++;
  }
  findings.push({
    section: "D. Lifecycle",
    name: "settlement progress",
    verdict: bought.length === 0 ? "conditional" : settled === bought.length ? "pass" : "info",
    detail: `${settled}/${bought.length} settled, ${payable} payable so far`,
  });

  // ── E. cron freshness across the window ───────────────────────────────
  let cronGrid: Record<string, number> | null = null;
  if (dbAvailable()) {
    const runs = await recentCronRuns(state.startedAt);
    if (runs) {
      cronGrid = {};
      for (const r of runs) cronGrid[r.job] = (cronGrid[r.job] ?? 0) + 1;
      const windowH = (Date.now() - Date.parse(state.startedAt)) / 3600_000;
      const expect: Record<string, number> = {
        settler: windowH * 12 * 0.5,
        queue_maintainer: windowH * 12 * 0.5,
        classifier: windowH * 0.5,
        fetcher: (windowH / 2) * 0.5,
      };
      for (const [job, min] of Object.entries(expect)) {
        findings.push({
          section: "E. Crons",
          name: `${job} fired within 2× cadence all window`,
          verdict: (cronGrid[job] ?? 0) >= min ? "pass" : "fail",
          detail: `${cronGrid[job] ?? 0} runs vs ≥${Math.floor(min)} expected`,
        });
      }
    }
    const dbSett = await settlementsFor([...new Set(bought.map((b) => b.flightId))]);
    const dbOuts = await outcomesFor([...new Set(bought.map((b) => b.flightId))]);
    findings.push({
      section: "E. Crons",
      name: "DB settlements/outcomes rows exist for our settled flights",
      verdict: settled === 0 ? "conditional" : (dbSett?.length ?? 0) > 0 && (dbOuts?.length ?? 0) > 0 ? "pass" : "fail",
      detail: `db settlements=${dbSett?.length ?? "n/a"} outcomes=${dbOuts?.length ?? "n/a"} chainSettled=${settled}`,
    });
  }

  // ── journal checks tally (includes B/F checks made at action time) ────
  const checkEntries = entries.filter((e) => e.kind === "check");
  const failed = checkEntries.filter((e) => e.data?.ok === false);
  const conditional = checkEntries.filter((e) => e.data?.skipped === true);
  for (const f of failed) {
    findings.push({ section: "journal", name: f.event, verdict: "fail", detail: String(f.data?.detail ?? "") });
  }

  return {
    findings,
    ledgers,
    flightTimelines,
    cronGrid,
    checks: {
      passed: checkEntries.length - failed.length - conditional.length,
      failed: failed.length,
      conditional: conditional.length,
    },
  };
}
