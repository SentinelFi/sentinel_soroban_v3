/**
 * Shared plumbing for the page drivers: SPA navigation, and toast-based
 * transaction-outcome detection.
 *
 * Outcome model: every write flow in the dapp raises a toast on settle —
 * success/secondary on completion (useTxFlow success message, cancel
 * notifications) and a sticky ~10s "error" toast on failure (notifyError) —
 * EXCEPT the two House cancel actions, whose failures render an inline
 * error <p> instead. waitTxOutcome() therefore watches for the first NEW
 * toast after markToasts(), plus any caller-supplied inline error selectors.
 */
import type { Page } from "playwright";

export const TX_TIMEOUT_MS = 90_000;

export function origin(page: Page): string {
  return new URL(page.url()).origin;
}

/** What the dapp paints in a value slot while its chain read is still in flight. */
const LOADING = "…";

/**
 * Text of `testId` once it has SETTLED — i.e. is no longer the "…" placeholder.
 *
 * These elements mount with the placeholder ALREADY in the DOM, so waiting for
 * `attached` and reading immediately captures "…" rather than the value. That
 * is why every vault figure in the 2026-08-04 run journalled as "…", leaving
 * the UI-vs-chain reconcile with nothing to compare; and why a +MINT could be
 * scored a success on the chip merely finishing its first load.
 *
 * "—" is a FAILED read, not a pending one (House.tsx) — it is terminal, so
 * return it rather than burning the timeout. On timeout, return what is there.
 */
export async function readSettledText(page: Page, testId: string, timeoutMs = 20_000): Promise<string> {
  const el = page.getByTestId(testId).first();
  await el.waitFor({ state: "attached", timeout: 15_000 });
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const text = ((await el.textContent().catch(() => "")) ?? "").trim();
    if (text && text !== LOADING) return text;
    if (Date.now() >= deadline) return text;
    await page.waitForTimeout(250);
  }
}

/** Navigate to `route` unless an element with `testId` is already mounted. */
export async function gotoIfMissing(page: Page, route: string, testId: string): Promise<void> {
  if ((await page.getByTestId(testId).count()) > 0) return;
  await page.goto(origin(page) + route, { waitUntil: "load" });
  await page.getByTestId(testId).first().waitFor({ state: "attached", timeout: 20_000 });
}

/** Flag every currently-mounted toast so waitTxOutcome only sees new ones. */
export async function markToasts(page: Page): Promise<void> {
  await page.evaluate(() => {
    for (const el of document.querySelectorAll('[data-testid="toast-item"]')) {
      (el as HTMLElement).dataset.e2eSeen = "1";
    }
  });
}

export interface TxOutcome {
  ok: boolean;
  error?: string;
}

/**
 * Wait for the first transaction outcome after an action click:
 *   - a NEW toast-item: data-type "error" → failure (with its text);
 *     "success"/"secondary" → success; "primary"/"warning" → keep waiting.
 *   - any of `extraErrorSelectors` rendering non-empty text → failure.
 * Call markToasts() immediately before the click that starts the flow.
 */
export async function waitTxOutcome(
  page: Page,
  opts?: { timeoutMs?: number; extraErrorSelectors?: string[] },
): Promise<TxOutcome> {
  const timeoutMs = opts?.timeoutMs ?? TX_TIMEOUT_MS;
  const deadline = Date.now() + timeoutMs;
  // tiny post-click settle so a lingering pre-click inline error (cleared
  // synchronously by the handler) can't be misread as this flow's outcome
  await page.waitForTimeout(250);
  while (Date.now() < deadline) {
    try {
      for (const sel of opts?.extraErrorSelectors ?? []) {
        const el = page.locator(sel).first();
        if ((await el.count()) > 0) {
          const text = ((await el.textContent()) ?? "").trim();
          if (text) return { ok: false, error: text };
        }
      }
      const fresh = page.locator('[data-testid="toast-item"]:not([data-e2e-seen])');
      const n = await fresh.count();
      for (let i = 0; i < n; i++) {
        const item = fresh.nth(i);
        const type = await item.getAttribute("data-type");
        const text = ((await item.textContent()) ?? "").trim();
        // consume so later polls / calls never re-read this toast
        await item
          .evaluate((el) => {
            (el as HTMLElement).dataset.e2eSeen = "1";
          })
          .catch(() => {});
        if (type === "error") return { ok: false, error: text || "transaction failed" };
        if (type === "success" || type === "secondary") return { ok: true };
        // primary/warning are informational — keep waiting
      }
    } catch {
      /* a toast auto-dismissed mid-read — just poll again */
    }
    await page.waitForTimeout(300);
  }
  return { ok: false, error: `timed out after ${Math.round(timeoutMs / 1000)}s waiting for a transaction outcome` };
}
