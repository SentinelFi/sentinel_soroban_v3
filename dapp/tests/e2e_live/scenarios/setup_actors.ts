/**
 * Actor setup — friendbot XLM for all 17, then per-actor +MINT clicks
 * through the real UI (doubles as faucet-button coverage). Idempotent:
 * skips funded accounts and actors whose USDC already covers their plan.
 */
import type { Browser } from "playwright";
import type { LiveConfig } from "../config.js";
import { USDC_UNITS } from "../config.js";
import { Chain } from "../chain.js";
import { loadOrCreateActors, fundActor, isFunded, type Actor } from "../actors.js";
import type { Journal } from "../journal.js";
import { journalCheck } from "../checks.js";
import { newActorContext, snap } from "../browser/context.js";
import { mint, readBalanceChip } from "../browser/pages/misc.js";

export async function setupActors(
  cfg: LiveConfig,
  j: Journal,
  browser: Browser,
  uiUrl: string,
): Promise<Actor[]> {
  const chain = new Chain(cfg);
  const actors = loadOrCreateActors();
  console.log("\n── actor setup (fund + mint) ────────────────────────────");

  for (const a of actors) {
    if (await isFunded(cfg.horizonUrl, a.address)) {
      j.append("note", "already funded", { address: a.address }, a.name);
    } else {
      await fundActor(cfg.horizonUrl, a.address);
      j.append("action", "friendbot funded", { address: a.address }, a.name);
      await new Promise((r) => setTimeout(r, 1500)); // friendbot spacing
    }
  }
  journalCheck(j, "all 17 actors XLM-funded", true);

  for (const a of actors) {
    if (a.mintClicks === 0) continue;
    const have = await chain.usdcBalance(a.address).catch(() => 0n);
    const target = BigInt(a.mintClicks) * 10_000n * USDC_UNITS;
    if (have >= target) {
      j.append("note", "mint already done", { have: have.toString() }, a.name);
      continue;
    }
    const ctx = await newActorContext(browser, uiUrl, a);
    try {
      const clicksNeeded = Number((target - have) / (10_000n * USDC_UNITS));
      for (let i = 0; i < clicksNeeded; i++) {
        const res = await mint(ctx.page);
        j.append("action", "ui mint click", { ok: res.ok, error: res.error }, a.name);
        if (!res.ok) break;
      }
      const chip = await readBalanceChip(ctx.page);
      const after = await chain.usdcBalance(a.address).catch(() => 0n);
      journalCheck(
        j,
        `${a.name}: minted to plan (${a.mintClicks}×10k USDC)`,
        after >= target,
        `chain=${after / USDC_UNITS} chip="${chip}"`,
      );
      const shot = await snap(ctx.page, j.shotsDir, `setup-${a.name}`);
      j.append("screenshot", shot, {}, a.name);
    } finally {
      await ctx.close();
    }
  }
  j.append("note", "actor setup complete");
  return actors;
}
