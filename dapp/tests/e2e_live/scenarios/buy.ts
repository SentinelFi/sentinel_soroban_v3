/**
 * Buy pass — travelers purchase through the real UI board/BetSlip.
 *
 * HARD GATES, checked every pass:
 *  1. seeding verified (state.progress._run.seedingVerified — set by
 *     `check` when the board's routes read Active on-chain);
 *  2. vault free capital covers payoff × remaining planned buys' next
 *     tranche (deposits mint after the 6h LP delay);
 *  3. global cap maxPolicies (planned 50 + retry headroom).
 *
 * Candidates re-selected relative to NOW each pass (sale-auth refusals
 * expected — journaled, retried with the next candidate). N1's designed
 * negatives run once the happy-path buys have started.
 */
import type { Browser } from "playwright";
import type { LiveConfig } from "../config.js";
import { PAYOFF_UNITS, USDC_UNITS } from "../config.js";
import { Chain } from "../chain.js";
import type { Actor } from "../actors.js";
import type { Journal } from "../journal.js";
import { journalCheck, journalSkip } from "../checks.js";
import { selectCandidates, pickDiverse, type Candidate } from "../flights.js";
import { newActorContext, snap } from "../browser/context.js";
import { buyPolicy } from "../browser/pages/markets.js";

interface BoughtRecord {
  flightId: string;
  dateISO: string;
  dateSecs: string;
  origin: string;
  dest: string;
  premiumUsdc: number;
  actor: string;
}

export async function buyPass(
  cfg: LiveConfig,
  j: Journal,
  browser: Browser,
  uiUrl: string,
  actors: Actor[],
): Promise<void> {
  const chain = new Chain(cfg);
  const state = j.state();
  const run = (state.progress._run ??= {});
  console.log("\n── buy pass ─────────────────────────────────────────────");

  if (!run.seedingVerified) {
    journalSkip(j, "buy pass", "seeding not verified complete yet");
    return;
  }
  if (state.buysPlaced >= state.buysPlanned) return;

  const free = await chain.freeCapital();
  if (free < PAYOFF_UNITS) {
    journalSkip(j, "buy pass", `free capital ${free / USDC_UNITS} USDC < one payoff (LP delay pending?)`);
    return;
  }
  // How many buys this pass can lock: free capital minus a safety payoff.
  const capacity = Number((free - PAYOFF_UNITS) / PAYOFF_UNITS) + 1;

  const bought = ((run.bought ??= []) as BoughtRecord[]);
  const refusedKeys = new Set(((run.refusedKeys ??= []) as string[]));
  const excludeKeys = new Set<string>([
    ...bought.map((b) => `${b.flightId}|${b.dateISO}`),
    ...refusedKeys,
  ]);
  const soakEnd = state.soakEndsAt ? Math.floor(Date.parse(state.soakEndsAt) / 1000) : undefined;
  const pool = await selectCandidates(chain, { soakEndSecs: soakEnd, excludeKeys });
  j.append("note", "candidate pool", { size: pool.length, capacity });
  if (pool.length === 0) {
    journalSkip(j, "buy pass", "no viable candidates in window right now");
    return;
  }

  // Travelers still owing policies, round-robin small tranches for spread.
  const owing = actors.filter(
    (a) => a.policies > 0 && ((state.progress[a.name] ??= {}).buys as number ?? 0) < a.policies,
  );
  let budget = Math.min(capacity, state.buysPlanned - state.buysPlaced, 12); // per-pass tranche
  const picks = pickDiverse(pool, budget);
  let pickIdx = 0;

  outer: for (let roundRobin = 0; budget > 0; roundRobin++) {
    let anyOwed = false;
    for (const a of owing) {
      const prog = state.progress[a.name]!;
      const done = (prog.buys as number) ?? 0;
      if (done + roundRobin >= a.policies) continue;
      anyOwed = true;
      const c: Candidate | undefined = picks[pickIdx++];
      if (!c) break outer;
      const ctx = await newActorContext(browser, uiUrl, a);
      try {
        const before = await chain.usdcBalance(a.address);
        const res = await buyPolicy(ctx.page, c.flightId, c.dateISO);
        if (res.ok) {
          const after = await chain.usdcBalance(a.address);
          const paid = Number((before - after) / USDC_UNITS);
          const onChain = await chain.hasPolicy(c.flightId, c.dateSecs, a.address);
          bought.push({
            flightId: c.flightId,
            dateISO: c.dateISO,
            dateSecs: c.dateSecs.toString(),
            origin: c.origin,
            dest: c.dest,
            premiumUsdc: c.premiumUsdc,
            actor: a.name,
          });
          prog.buys = done + 1;
          state.buysPlaced += 1;
          budget -= 1;
          j.append(
            "action",
            "buy",
            { flight: `${c.flightId} ${c.origin}→${c.dest}`, date: c.dateISO, paidUsdc: paid },
            a.name,
          );
          j.append(
            "expectation",
            "policy settles within ETA+5h+2h+slack; pays 100 iff ≥3h late or cancelled",
            { flightId: c.flightId, dateISO: c.dateISO, pCovered: c.pCovered },
            a.name,
          );
          journalCheck(
            j,
            `${a.name}: buy ${c.flightId}@${c.dateISO} — premium exact + policy on-chain`,
            onChain && paid === c.premiumUsdc,
            `paid=${paid} expected=${c.premiumUsdc} onChain=${onChain}`,
          );
          const shot = await snap(ctx.page, j.shotsDir, `buy-${a.name}-${c.flightId}`);
          j.append("screenshot", shot, {}, a.name);
        } else {
          refusedKeys.add(`${c.flightId}|${c.dateISO}`);
          j.append("observation", "sale-auth refusal", { flight: c.flightId, date: c.dateISO, error: res.error }, a.name);
        }
        run.refusedKeys = [...refusedKeys];
        j.saveState(state);
      } finally {
        await ctx.close();
      }
    }
    if (!anyOwed) break;
  }
  console.log(`  placed so far: ${state.buysPlaced}/${state.buysPlanned}`);
}

/** N1's designed failures — run once, after first successful buys exist. */
export async function negativePass(
  cfg: LiveConfig,
  j: Journal,
  browser: Browser,
  uiUrl: string,
  n1: Actor,
): Promise<void> {
  const chain = new Chain(cfg);
  const state = j.state();
  const prog = (state.progress[n1.name] ??= {});
  if (prog.negBuyDone || state.buysPlaced === 0) return;
  console.log("\n── N1 negatives ─────────────────────────────────────────");

  const pool = await selectCandidates(chain, {});
  const c = pool[0];
  if (!c) return;
  const ctx = await newActorContext(browser, uiUrl, n1);
  try {
    // Zero-USDC buy: UI must surface the failure, chain must not record.
    const res = await buyPolicy(ctx.page, c.flightId, c.dateISO);
    const has = await chain.hasPolicy(c.flightId, c.dateSecs, n1.address);
    journalCheck(j, "N1: 0-USDC buy fails in UI, no policy on-chain", !res.ok && !has, res.error ?? "no error surfaced");

    // Inside-min-lead refusal: today's date is always < the 24h cutoff.
    const today = new Date().toISOString().slice(0, 10);
    const res2 = await buyPolicy(ctx.page, c.flightId, today);
    journalCheck(j, "N1: sale-auth refuses inside the departure cutoff", !res2.ok, res2.error ?? "no error surfaced");
    const shot = await snap(ctx.page, j.shotsDir, "n1-negatives");
    j.append("screenshot", shot, {}, n1.name);
    prog.negBuyDone = true;
    j.saveState(state);
  } finally {
    await ctx.close();
  }
}
