/**
 * Policies page driver ("MY POLICIES", route "/policies").
 *
 * Rows come in three sections — READY TO CLAIM (claim cards), ACTIVE, and
 * HISTORY — all tagged policy-row + data-flight-id; the status text is the
 * row's badge (TRACKING / CLAIMABLE / PAID / ON TIME / EXPIRED per theme
 * copy). Only claim cards carry a policy-claim button.
 */
import type { Page } from "playwright";
import { markToasts, origin, waitTxOutcome } from "./_helpers";

async function ensurePolicies(page: Page): Promise<void> {
  if (new URL(page.url()).pathname !== "/policies") {
    await page.goto(origin(page) + "/policies", { waitUntil: "load" });
  }
  // rows render only once the chain reads land; a wallet with no policies
  // (or the connect prompt) legitimately renders none — don't throw
  await page
    .locator('[data-testid="policy-row"]')
    .first()
    .waitFor({ state: "attached", timeout: 30_000 })
    .catch(() => {});
}

export async function policyRows(
  page: Page,
): Promise<Array<{ flightId: string; status: string; claimable: boolean }>> {
  await ensurePolicies(page);
  return page.locator('[data-testid="policy-row"]').evaluateAll((rows) =>
    rows.map((row) => ({
      flightId: row.getAttribute("data-flight-id") ?? "",
      status: (row.querySelector('[data-testid="policy-status"]')?.textContent ?? "").trim(),
      claimable: row.querySelector('[data-testid="policy-claim"]') !== null,
    })),
  );
}

/** Claim the (first) claimable policy for a flight. Single click, single tx. */
export async function claim(page: Page, flightId: string): Promise<{ ok: boolean; error?: string }> {
  await ensurePolicies(page);
  const row = page
    .locator(`[data-testid="policy-row"][data-flight-id="${flightId}"]:has([data-testid="policy-claim"])`)
    .first();
  if ((await row.count()) === 0) {
    return { ok: false, error: `no claimable policy row for ${flightId}` };
  }
  const btn = row.getByTestId("policy-claim");
  if (await btn.isDisabled()) {
    return { ok: false, error: "claim button is disabled (another claim in flight, or network mismatch)" };
  }
  await markToasts(page);
  await btn.click();
  // success → success toast (t.notify.claimed); failure → sticky error toast
  return waitTxOutcome(page);
}
