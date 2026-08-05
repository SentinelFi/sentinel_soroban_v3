/**
 * `check` body — idempotent, catch-up-capable, safe to spam.
 *
 * Read side: chain events since cursor, oracle state for every insured
 * flight, vault + queues + stats, DB deltas. Write side: due actions
 * only, each guarded by progress markers + on-chain state:
 *   - seeding verification (unlocks buys)
 *   - buy tranches once free capital covers them (6h LP delay)
 *   - U2/U5/U6's concurrent withdrawal requests at mid-soak (FIFO probe)
 *   - U4 cancel_withdrawal round early in the soak
 *   - COLLECT when claimable; CLAIM when settled-won
 *   - N1's negative claim once one of our flights settles OnTime
 */
import type { Browser } from "playwright";
import type { LiveConfig } from "../config.js";
import { USDC_UNITS } from "../config.js";
import { Chain } from "../chain.js";
import type { Actor } from "../actors.js";
import type { Journal } from "../journal.js";
import { journalCheck, journalSkip } from "../checks.js";
import { fetchCatalog } from "../flights.js";
import { recentCronRuns, openInterventions, outcomesFor, dbAvailable } from "../db.js";
import { buyPass, negativePass } from "./buy.js";
import { newActorContext, snap } from "../browser/context.js";
import { requestWithdrawal, cancelWithdrawal, collect } from "../browser/pages/house.js";
import { claim, policyRows } from "../browser/pages/mybets.js";

interface Bought {
  flightId: string;
  dateISO: string;
  dateSecs: string;
  actor: string;
}

export async function checkPass(
  cfg: LiveConfig,
  j: Journal,
  browser: Browser,
  uiUrl: string,
  actors: Actor[],
): Promise<void> {
  const chain = new Chain(cfg);
  const state = j.state();
  const run = (state.progress._run ??= {});
  const now = Date.now();

  // ── 1. seeding verification (the buy gate) ────────────────────────────
  if (!run.seedingVerified) {
    let activeCount = 0;
    let verified = 0;
    let sampleSize = 0;
    try {
      const catalog = (await fetchCatalog(cfg.backendUrl)).filter((r) => r.status === "Active");
      activeCount = catalog.length;
      const sample = catalog.filter((_, i) => i % 97 === 0).slice(0, 10);
      sampleSize = sample.length;
      for (const r of sample) {
        try {
          if (String(await chain.routeStatus(r.flight_id, r.origin, r.destination)) === "Active") verified++;
        } catch {
          /* not on-chain */
        }
      }
    } catch {
      /* endpoint not deployed yet */
    }
    if (activeCount >= 800 && sampleSize > 0 && verified === sampleSize) {
      run.seedingVerified = true;
      j.append("note", "seeding verified — buys unlocked", { activeCount, verified });
      console.log(`  seeding verified (${activeCount} Active in catalog, ${verified}/${sampleSize} spot-checked) — buys unlocked`);
    } else {
      console.log(`  seeding: catalog Active=${activeCount}, spot-check ${verified}/${sampleSize} — buys still locked`);
    }
    j.saveState(state);
  }

  // ── 2. chain events since cursor ──────────────────────────────────────
  try {
    const { events, cursor } = await chain.eventsSince(state.eventCursor);
    if (events.length > 0) j.append("observation", "chain events", { count: events.length, sample: events.slice(0, 5) });
    state.eventCursor = cursor;
    j.saveState(state);
  } catch (err) {
    j.append("note", "event pull failed", { error: String(err) });
  }

  // ── 3. oracle + policy state per insured flight ───────────────────────
  const bought = ((run.bought ?? []) as Bought[]);
  const transitions: string[] = [];
  const seen = ((run.flightPhase ??= {}) as Record<string, string>);
  for (const b of bought) {
    const key = `${b.flightId}|${b.dateISO}`;
    try {
      const fd = await chain.flightData(b.flightId, BigInt(b.dateSecs));
      const tag = (fd.status as { tag?: string })?.tag ?? String(fd.status);
      if (seen[key] !== tag) {
        transitions.push(`${key}: ${seen[key] ?? "∅"} → ${tag}`);
        j.append("observation", "oracle transition", { flight: key, from: seen[key], to: tag });
        seen[key] = tag;
      }
    } catch {
      /* NotInitiated flights may have no entry yet — fine pre-gate */
    }
  }
  if (transitions.length) console.log("  transitions:\n    " + transitions.join("\n    "));
  j.saveState(state);

  // ── 4. vault/stats/DB snapshot ────────────────────────────────────────
  const [tvl, free, locked, stats, pending] = await Promise.all([
    chain.totalManagedAssets(),
    chain.freeCapital(),
    chain.lockedCapital(),
    chain.getStats(),
    chain.hasPendingOutcomes(),
  ]);
  const snapshot = {
    tvlUsdc: (tvl / USDC_UNITS).toString(),
    freeUsdc: (free / USDC_UNITS).toString(),
    lockedUsdc: (locked / USDC_UNITS).toString(),
    flightsInsured: stats[0].toString(),
    paidCount: stats[1].toString(),
    totalPaidOut: (stats[2] / USDC_UNITS).toString(),
    pendingOutcomes: pending,
  };
  j.append("observation", "protocol snapshot", snapshot);
  console.log(
    `  vault: TVL ${snapshot.tvlUsdc} (free ${snapshot.freeUsdc} / locked ${snapshot.lockedUsdc}) | insured ${snapshot.flightsInsured} paid ${snapshot.paidCount}`,
  );

  if (dbAvailable()) {
    const runs = await recentCronRuns(new Date(now - 2 * 3600_000).toISOString());
    const staleJobs: string[] = [];
    const cadenceMin: Record<string, number> = { settler: 5, queue_maintainer: 5, classifier: 60, fetcher: 120, revive: 60, gov_exposure: 60, weather: 120 };
    for (const [job, mins] of Object.entries(cadenceMin)) {
      const latest = runs?.find((r) => r.job === job);
      if (!latest || now - new Date(latest.started_at).getTime() > 2 * mins * 60_000) staleJobs.push(job);
    }
    if (staleJobs.length) {
      console.log(`  ⚠ stale crons (>2× cadence): ${staleJobs.join(", ")}`);
      j.append("observation", "stale crons", { staleJobs });
    }
    const open = await openInterventions();
    if (open && open.length > 0) j.append("observation", "open interventions", { count: open.length, open });
    const flightIds = [...new Set(bought.map((b) => b.flightId))];
    const outs = await outcomesFor(flightIds);
    if (outs) j.append("observation", "db outcomes for our flights", { count: outs.length });
  }

  // ── 5. due actions ────────────────────────────────────────────────────
  await buyPass(cfg, j, browser, uiUrl, actors);
  const n1 = actors.find((a) => a.name === "N1");
  if (n1) await negativePass(cfg, j, browser, uiUrl, n1);
  await vaultLifecycleActions(cfg, j, browser, uiUrl, actors);
  await claimsAndCollects(cfg, j, browser, uiUrl, actors);

  // Status table.
  const st = j.state();
  const elapsedH = ((now - Date.parse(st.startedAt)) / 3600_000).toFixed(1);
  console.log(`\n  run ${st.runId} | phase ${st.phase} | ${elapsedH}h elapsed | buys ${st.buysPlaced}/${st.buysPlanned}`);
}

/** U2/U5/U6 mid-soak concurrent withdrawals; U4's cancel round (early). */
async function vaultLifecycleActions(
  cfg: LiveConfig,
  j: Journal,
  browser: Browser,
  uiUrl: string,
  actors: Actor[],
): Promise<void> {
  const chain = new Chain(cfg);
  const state = j.state();
  const now = Date.now();
  const started = Date.parse(state.startedAt);
  const soakEnd = state.soakEndsAt ? Date.parse(state.soakEndsAt) : started + 48 * 3600_000;
  const midSoak = started + (soakEnd - started) / 2;
  const byName = new Map(actors.map((a) => [a.name, a]));

  // U4 early round: request → cancel → re-request (runs once deposits shares exist).
  const u4 = byName.get("U4");
  if (u4) {
    const prog = (state.progress.U4 ??= {});
    if (prog.deposited && !prog.cancelWithdrawalTested) {
      const shares = await chain.shareBalance(u4.address).catch(() => 0n);
      if (shares > 0n) {
        const ctx = await newActorContext(browser, uiUrl, u4);
        try {
          const qBefore = (await chain.withdrawalQueue()).length;
          const r1 = await requestWithdrawal(ctx.page, Number(shares / USDC_UNITS) / 2);
          j.append("action", "request_withdrawal (to cancel)", { ok: r1.ok, ...(r1.error ? { error: r1.error } : {}) }, "U4");
          const c1 = await cancelWithdrawal(ctx.page);
          j.append("action", "cancel_withdrawal", { ok: c1.ok, ...(c1.error ? { error: c1.error } : {}) }, "U4");
          const qAfter = (await chain.withdrawalQueue()).length;
          journalCheck(j, "U4: cancel_withdrawal removes exactly one queue entry", c1.ok && qAfter === qBefore, `queue ${qBefore}→${qAfter}`);
          const r2 = await requestWithdrawal(ctx.page, Number(shares / USDC_UNITS) / 2);
          j.append("action", "request_withdrawal (kept)", { ok: r2.ok, ...(r2.error ? { error: r2.error } : {}) }, "U4");
          prog.cancelWithdrawalTested = true;
          j.saveState(state);
        } finally {
          await ctx.close();
        }
      }
    }
  }

  // Mid-soak FIFO probe: U2 partial + U5 full + U6 in the SAME check pass.
  if (now >= midSoak && !(state.progress._run as Record<string, unknown>).fifoProbeDone) {
    const trio: Array<[string, number]> = [["U2", 0.4], ["U5", 1.0], ["U6", 1.0]];
    let fired = 0;
    for (const [name, fraction] of trio) {
      const a = byName.get(name);
      if (!a) continue;
      const shares = await chain.shareBalance(a.address).catch(() => 0n);
      if (shares <= 0n) continue;
      const ctx = await newActorContext(browser, uiUrl, a);
      try {
        const amt = Math.max(1, Math.floor((Number(shares / USDC_UNITS) * fraction)));
        const r = await requestWithdrawal(ctx.page, amt);
        j.append("action", "request_withdrawal (FIFO probe)", { ok: r.ok, ...(r.error ? { error: r.error } : {}), shares: amt, fraction }, name);
        j.append("expectation", "queue processes in FIFO order as settlements free capital", { position: fired }, name);
        if (r.ok) fired++;
      } finally {
        await ctx.close();
      }
    }
    if (fired >= 2) {
      (state.progress._run as Record<string, unknown>).fifoProbeDone = true;
      journalCheck(j, "FIFO probe: concurrent withdrawal requests placed in one pass", true, `${fired} requests`);
    }
    j.saveState(state);
  }
}

/** COLLECT claimable withdrawals; CLAIM settled-won policies; N1's on-time claim. */
async function claimsAndCollects(
  cfg: LiveConfig,
  j: Journal,
  browser: Browser,
  uiUrl: string,
  actors: Actor[],
): Promise<void> {
  const chain = new Chain(cfg);
  const state = j.state();
  const run = state.progress._run as Record<string, unknown>;
  const bought = ((run.bought ?? []) as Bought[]);
  const byName = new Map(actors.map((a) => [a.name, a]));

  // Collects — any underwriter with claimable balance.
  for (const a of actors.filter((x) => x.depositUsdc > 0)) {
    const claimable = await chain.claimableBalance(a.address).catch(() => 0n);
    if (claimable <= 0n) continue;
    const ctx = await newActorContext(browser, uiUrl, a);
    try {
      const before = await chain.usdcBalance(a.address);
      const r = await collect(ctx.page);
      const after = await chain.usdcBalance(a.address);
      // Record r.error too: without it a failure is an opaque `ok:false`, and
      // the reason (button never rendered vs tx reverted vs timeout) is the
      // whole diagnosis — U4 on 2026-08-05 cost a live investigation for want
      // of this one field.
      j.append(
        "action",
        "collect",
        {
          ok: r.ok,
          ...(r.error ? { error: r.error } : {}),
          claimable: claimable.toString(),
          receivedUnits: (after - before).toString(),
        },
        a.name,
      );
      journalCheck(j, `${a.name}: COLLECT pays the claimable balance exactly`, r.ok && after - before === claimable, `Δ=${after - before} claimable=${claimable}`);
    } finally {
      await ctx.close();
    }
  }

  // Claims — policies whose flight settled payable.
  const claimedKey = ((run.claimed ??= []) as string[]);
  for (const b of bought) {
    const key = `${b.flightId}|${b.dateISO}|${b.actor}`;
    if (claimedKey.includes(key)) continue;
    const a = byName.get(b.actor);
    if (!a) continue;
    const cfgEntry = await chain.flightConfig(b.flightId, BigInt(b.dateSecs)).catch(() => undefined);
    const settled = (cfgEntry as { settled?: boolean; payable?: boolean } | undefined);
    const already = await chain.hasClaimed(b.flightId, BigInt(b.dateSecs), a.address).catch(() => false);
    if (already) {
      claimedKey.push(key);
      continue;
    }
    const ctx = await newActorContext(browser, uiUrl, a);
    try {
      const rows = await policyRows(ctx.page);
      const row = rows.find((r) => r.flightId === b.flightId && r.claimable);
      if (!row) continue; // not claimable yet — next pass
      const before = await chain.usdcBalance(a.address);
      const r = await claim(ctx.page, b.flightId);
      const after = await chain.usdcBalance(a.address);
      const paidUsdc = Number((after - before) / USDC_UNITS);
      j.append("action", "claim", { flight: key, ok: r.ok, ...(r.error ? { error: r.error } : {}), paidUsdc }, b.actor);
      journalCheck(j, `${b.actor}: claim on ${b.flightId}@${b.dateISO} pays exactly 100`, r.ok && paidUsdc === 100, `paid=${paidUsdc} settled=${JSON.stringify(settled)?.slice(0, 80)}`);
      const shot = await snap(ctx.page, j.shotsDir, `claim-${b.actor}-${b.flightId}`);
      j.append("screenshot", shot, {}, b.actor);
      if (r.ok) {
        claimedKey.push(key);
        j.saveState(state);
      }
    } finally {
      await ctx.close();
    }
  }

  // N1 negative claim: first of OUR flights that settled NOT payable.
  const n1 = byName.get("N1");
  if (n1 && !run.negClaimDone) {
    for (const b of bought) {
      const fd = await chain.flightData(b.flightId, BigInt(b.dateSecs)).catch(() => null);
      const tag = fd ? ((fd.status as { tag?: string })?.tag ?? "") : "";
      if (tag !== "Settled") continue;
      const payable = await chain
        .flightConfig(b.flightId, BigInt(b.dateSecs))
        .then((c) => Boolean((c as { payable?: boolean } | undefined)?.payable))
        .catch(() => false);
      if (payable) continue;
      const ctx = await newActorContext(browser, uiUrl, n1);
      try {
        const r = await claim(ctx.page, b.flightId);
        journalCheck(j, "N1: claim on an on-time flight fails (no policy / not payable)", !r.ok, r.error ?? "no error surfaced");
        run.negClaimDone = true;
        j.saveState(state);
      } finally {
        await ctx.close();
      }
      break;
    }
    if (!run.negClaimDone) journalSkip(j, "N1 on-time-claim negative", "no on-time settlement among our flights yet");
  }
}
