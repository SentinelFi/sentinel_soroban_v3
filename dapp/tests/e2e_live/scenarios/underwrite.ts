/**
 * Underwriting pass (start verb) — every underwriter's opening move via
 * the real UI, including the two cancel paths:
 *   U1 10,000   U2 5,000   U3 1,500→cancel→1,500   U4 1,200
 *   U5 1,000    U6 800     T7 500 (hybrid)
 * Later moves (withdrawal requests, collects) belong to the poll engine.
 * Idempotent via progress markers.
 */
import type { Browser } from "playwright";
import type { LiveConfig } from "../config.js";
import { USDC_UNITS } from "../config.js";
import { Chain } from "../chain.js";
import type { Actor } from "../actors.js";
import type { Journal } from "../journal.js";
import { journalCheck } from "../checks.js";
import { newActorContext, snap } from "../browser/context.js";
import { deposit, cancelDeposit, scrapeVault } from "../browser/pages/house.js";

export async function underwrite(
  cfg: LiveConfig,
  j: Journal,
  browser: Browser,
  uiUrl: string,
  actors: Actor[],
): Promise<void> {
  const chain = new Chain(cfg);
  const state = j.state();
  console.log("\n── underwriting (deposits incl. cancel paths) ───────────");

  for (const a of actors.filter((x) => x.depositUsdc > 0)) {
    const prog = (state.progress[a.name] ??= {});
    if (prog.deposited) continue;
    const ctx = await newActorContext(browser, uiUrl, a);
    try {
      // U3's designed detour: request → cancel (exact refund) → re-deposit.
      if (a.name === "U3" && !prog.cancelTested) {
        const balBefore = await chain.usdcBalance(a.address);
        const d1 = await deposit(ctx.page, a.depositUsdc);
        j.append("action", "deposit request (to cancel)", { ok: d1.ok, ...(d1.error ? { error: d1.error } : {}), usdc: a.depositUsdc }, a.name);
        const c1 = await cancelDeposit(ctx.page);
        j.append("action", "cancel_deposit", { ok: c1.ok, ...(c1.error ? { error: c1.error } : {}) }, a.name);
        const balAfter = await chain.usdcBalance(a.address);
        journalCheck(
          j,
          "U3: cancel_deposit refunds exactly",
          c1.ok && balAfter === balBefore,
          `Δ=${(balAfter - balBefore).toString()}`,
        );
        prog.cancelTested = true;
        j.saveState(state);
      }

      const before = await chain.usdcBalance(a.address);
      const res = await deposit(ctx.page, a.depositUsdc);
      const after = await chain.usdcBalance(a.address);
      const spent = (before - after) / USDC_UNITS;
      j.append(
        "action",
        "deposit",
        { ok: res.ok, usdc: a.depositUsdc, spentUsdc: spent.toString(), error: res.error },
        a.name,
      );
      j.append("expectation", "shares mint after 6h LP delay at snapshot price", { usdc: a.depositUsdc }, a.name);
      journalCheck(j, `${a.name}: deposit ${a.depositUsdc} USDC accepted via UI`, res.ok && spent === BigInt(a.depositUsdc), `spent=${spent}`);
      const shot = await snap(ctx.page, j.shotsDir, `deposit-${a.name}`);
      j.append("screenshot", shot, {}, a.name);
      prog.deposited = res.ok;
      j.saveState(state);
    } finally {
      await ctx.close();
    }
  }

  // One vault scrape for the record (UI truth baseline).
  const anyActor = actors[0]!;
  const ctx = await newActorContext(browser, uiUrl, anyActor);
  try {
    const ui = await scrapeVault(ctx.page);
    const tvl = await chain.totalManagedAssets();
    j.append("observation", "vault after underwriting", { ui, chainTvl: tvl.toString() });
  } finally {
    await ctx.close();
  }
}
