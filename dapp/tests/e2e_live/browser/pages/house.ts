/**
 * House (vault) page driver — route "/house".
 *
 * Flow shapes encoded here, learned from src/pages/House.tsx:
 *   - deposit          → risk_vault.request_deposit (two-phase LP entry: assets
 *                        escrow NOW, shares mint via the queue-maintenance cron
 *                        after the 6h LP pricing delay; COLLECT completes it)
 *   - requestWithdrawal→ risk_vault.request_withdrawal (shares-denominated,
 *                        queued behind the same 6h delay)
 *   - cancelDeposit / cancelWithdrawal → cancel the FIRST of my pending queue
 *                        entries; success raises a "secondary" toast, failure
 *                        renders an inline error <p> (no toast) — both watched
 *   - collect          → risk_vault.collect; the button only exists while a
 *                        claimable balance is showing
 * All single-click single-tx flows (no confirm dialogs anywhere on the page).
 */
import type { Page } from "playwright";
import { gotoIfMissing, markToasts, waitTxOutcome } from "./_helpers";

export interface TxResult {
  ok: boolean;
  error?: string;
}

async function ensureHouse(page: Page): Promise<void> {
  await gotoIfMissing(page, "/house", "house-tvl");
}

/**
 * Wait for a CONDITIONALLY-RENDERED action button before deciding it is absent.
 *
 * `ensureHouse` only waits for `house-tvl`, which paints as soon as the page
 * mounts. COLLECT and the cancel buttons render only once a SEPARATE on-chain
 * read resolves (claimable balance, queue contents), so checking `count()`
 * immediately raced that read: on 2026-08-05 U4 reported "nothing to collect"
 * while holding 600 USDC claimable, with `collect` simulating clean on-chain.
 * It returned in ~4s — far short of the 90s tx timeout — which is what gave
 * the race away.
 *
 * Also tolerates a button that mounts DISABLED while a read settles. Only
 * after the window closes is absence treated as real.
 */
async function awaitActionButton(page: Page, testId: string, timeoutMs = 15_000) {
  const btn = page.getByTestId(testId).first();
  try {
    await btn.waitFor({ state: "attached", timeout: timeoutMs });
  } catch {
    return null;
  }
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline && (await btn.isDisabled().catch(() => false))) {
    await page.waitForTimeout(250);
  }
  return btn;
}

async function readTestId(page: Page, testId: string): Promise<string> {
  const el = page.getByTestId(testId).first();
  await el.waitFor({ state: "attached", timeout: 15_000 });
  return ((await el.textContent()) ?? "").trim();
}

/**
 * Vault figures as displayed. `sharePrice` is the connected actor's position
 * value (POOL SHARES → CURRENT VALUE via convert_to_assets) — the page shows
 * no bare share-price number; reconcile against shares × snapshot price.
 */
export async function scrapeVault(
  page: Page,
): Promise<{ tvl: string; free: string; locked: string; sharePrice?: string }> {
  await ensureHouse(page);
  const tvl = await readTestId(page, "house-tvl");
  const free = await readTestId(page, "house-free");
  const locked = await readTestId(page, "house-locked");
  const sp = page.getByTestId("house-share-price");
  const sharePrice = (await sp.count()) > 0 ? ((await sp.first().textContent()) ?? "").trim() : undefined;
  return sharePrice !== undefined ? { tvl, free, locked, sharePrice } : { tvl, free, locked };
}

async function runAmountAction(
  page: Page,
  amountFor: "deposit" | "withdraw",
  buttonTestId: string,
  errorTestId: string,
  amount: number,
): Promise<TxResult> {
  await ensureHouse(page);
  const input = page.locator(`[data-testid="house-amount"][data-amount-for="${amountFor}"]`);
  await input.fill(String(amount));
  const btn = (await awaitActionButton(page, buttonTestId)) ?? page.getByTestId(buttonTestId);
  if (await btn.isDisabled()) {
    return {
      ok: false,
      error: `${buttonTestId} is disabled (zero amount, insufficient balance/shares, or network mismatch)`,
    };
  }
  await markToasts(page);
  await btn.click();
  return waitTxOutcome(page, { extraErrorSelectors: [`[data-testid="${errorTestId}"]`] });
}

export async function deposit(page: Page, amountUsdc: number): Promise<TxResult> {
  return runAmountAction(page, "deposit", "house-deposit", "house-deposit-error", amountUsdc);
}

export async function requestWithdrawal(page: Page, amountShares: number): Promise<TxResult> {
  return runAmountAction(page, "withdraw", "house-request-withdrawal", "house-request-withdrawal-error", amountShares);
}

async function cancelFirst(page: Page, buttonTestId: string, errorTestId: string, what: string): Promise<TxResult> {
  await ensureHouse(page);
  const btn = await awaitActionButton(page, buttonTestId);
  if (!btn) {
    return { ok: false, error: `no cancellable ${what} entry is showing` };
  }
  if (await btn.isDisabled()) {
    return { ok: false, error: `${buttonTestId} is disabled (another cancel in flight, or network mismatch)` };
  }
  await markToasts(page);
  await btn.click();
  // success → "secondary" toast; failure → inline error <p>, no toast
  return waitTxOutcome(page, { extraErrorSelectors: [`[data-testid="${errorTestId}"]`] });
}

export async function cancelDeposit(page: Page): Promise<TxResult> {
  return cancelFirst(page, "house-cancel-deposit", "house-cancel-deposit-error", "deposit");
}

export async function cancelWithdrawal(page: Page): Promise<TxResult> {
  return cancelFirst(page, "house-cancel-withdrawal", "house-cancel-withdrawal-error", "withdrawal");
}

export async function collect(page: Page): Promise<TxResult> {
  await ensureHouse(page);
  const btn = await awaitActionButton(page, "house-collect");
  if (!btn) {
    return { ok: false, error: "nothing to collect (no claimable balance is showing)" };
  }
  if (await btn.isDisabled()) {
    return { ok: false, error: "collect button is disabled (not connected, or network mismatch)" };
  }
  await markToasts(page);
  await btn.click();
  return waitTxOutcome(page, { extraErrorSelectors: ['[data-testid="house-collect-error"]'] });
}
