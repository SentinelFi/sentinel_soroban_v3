/**
 * Markets page driver — departures board, stats ticker, and BetSlip buys.
 *
 * Route: "/" (Markets is also the catch-all route).
 */
import type { Page } from "playwright";
import { gotoIfMissing, markToasts, TX_TIMEOUT_MS } from "./_helpers";

async function ensureMarkets(page: Page): Promise<void> {
  await gotoIfMissing(page, "/", "markets-board");
}

/**
 * Scrape the stats ticker: testid markets-stat-<key> → text.
 * The single-copy values live in the ticker's visually-hidden static list
 * (the visible marquee is an aria-hidden 4× loop), so this reads textContent
 * without waiting for visibility.
 */
export async function scrapeStats(page: Page): Promise<Record<string, string>> {
  await gotoIfMissing(page, "/", "markets-stats");
  const entries = await page
    .locator('[data-testid^="markets-stat-"]')
    .evaluateAll((els) => els.map((el) => [el.getAttribute("data-testid") ?? "", (el.textContent ?? "").trim()]));
  const out: Record<string, string> = {};
  for (const [id, text] of entries) {
    if (id) out[id.replace(/^markets-stat-/, "")] = text ?? "";
  }
  return out;
}

/**
 * Rows currently rendered on the board (the board pages at 12 rows by
 * default — use the search box / openBetSlip for rows beyond page 1).
 * Status text is DEMO / SCANNING… (demo fallback) or BOARDING (live rows).
 */
export async function boardRows(page: Page): Promise<Array<{ flightId: string; status: string }>> {
  await ensureMarkets(page);
  await page
    .locator('[data-testid="board-row"]')
    .first()
    .waitFor({ state: "attached", timeout: 20_000 })
    .catch(() => {
      /* an empty board (filtered to nothing) is a valid answer */
    });
  return page.locator('[data-testid="board-row"]').evaluateAll((rows) =>
    rows.map((row) => ({
      flightId: row.getAttribute("data-flight-id") ?? "",
      status: (row.querySelector('[data-testid="board-row-status"]')?.textContent ?? "").trim(),
    })),
  );
}

/** Filter the board to the flight (search resets pagination) and open its slip. */
export async function openBetSlip(page: Page, flightId: string): Promise<void> {
  await ensureMarkets(page);
  await page.getByTestId("board-search").fill(flightId);
  const row = page.locator(`[data-testid="board-row"][data-flight-id="${flightId}"]`).first();
  await row.waitFor({ state: "visible", timeout: 20_000 });
  await row.getByTestId("board-row-buy").click();
  await page.getByTestId("betslip").waitFor({ state: "visible", timeout: 10_000 });
}

export interface BuyResult {
  ok: boolean;
  error?: string;
  /**
   * The UI refused BEFORE submitting anything — a client-side precheck
   * (vault free capital, buyer balance) disabled the BUY button.
   *
   * Distinct from a sale-auth refusal on purpose: a refusal is a property
   * of the FLIGHT (cancelled, vanished, inside the lead cutoff) and is
   * permanent, so the candidate is retired. A block is a property of the
   * VAULT at this instant and clears as soon as capital frees up, so the
   * candidate must stay eligible and be retried on the next check.
   */
  blocked?: boolean;
}

/**
 * How long BUY may sit disabled before we call it blocked rather than
 * loading. A precheck that reads free capital over RPC leaves the button
 * disabled for a beat on first paint; concluding "blocked" during that
 * window would strand every candidate for no reason.
 */
const BUY_ENABLE_GRACE_MS = 15_000;

/** Why is BUY disabled? Best available explanation, never throws. */
async function blockedReason(page: Page): Promise<string> {
  for (const id of ["betslip-blocked", "betslip-error"]) {
    const el = page.getByTestId(id);
    if ((await el.count().catch(() => 0)) > 0) {
      const text = ((await el.first().textContent().catch(() => "")) ?? "").trim();
      if (text) return text;
    }
  }
  const btn = page.getByTestId("betslip-buy");
  for (const attr of ["title", "aria-label", "data-blocked-reason"]) {
    const v = (await btn.getAttribute(attr).catch(() => null))?.trim();
    if (v) return v;
  }
  const label = ((await btn.textContent().catch(() => "")) ?? "").trim();
  return label ? `BUY disabled (button reads "${label}")` : "BUY disabled, no reason surfaced in the UI";
}

/**
 * The slip's date field is not a raw <input> — FlightCalendar renders a
 * popover month grid whose day cells carry data-day="YYYY-MM-DD". Open it,
 * page forward to the right month if needed, click the day.
 * Returns an error string instead of throwing (drivers stay resilient).
 */
async function pickDate(page: Page, dateISO: string): Promise<string | null> {
  await page.getByTestId("betslip-date").click();
  const pop = page.locator(".w3-cal-pop");
  try {
    await pop.waitFor({ state: "visible", timeout: 5_000 });
  } catch {
    return "flight-date calendar did not open";
  }
  for (let hop = 0; hop < 4; hop++) {
    const day = pop.locator(`[data-day="${dateISO}"]`);
    if ((await day.count()) > 0) {
      if (await day.isDisabled()) {
        return `date ${dateISO} is not selectable (before the lead-time minimum)`;
      }
      await day.click();
      await pop.waitFor({ state: "hidden", timeout: 5_000 }).catch(() => {});
      return null;
    }
    // month on screen doesn't hold the date — page forward (navs: [prev, next])
    await pop.locator(".w3-cal-nav").nth(1).click();
    await page.waitForTimeout(100);
  }
  return `date ${dateISO} not reachable within 4 months of paging the calendar`;
}

/**
 * Full buy flow: open slip → pick date → click BUY → wait (≤90s) for either
 * success (the slip closes itself via the flow's onSettled) or a surfaced
 * failure (betslip-error stepper text, or the sticky error toast).
 */
export async function buyPolicy(page: Page, flightId: string, dateISO: string): Promise<BuyResult> {
  await openBetSlip(page, flightId);

  const dateErr = await pickDate(page, dateISO);
  if (dateErr) {
    await page.getByTestId("betslip-close").click().catch(() => {});
    return { ok: false, error: dateErr };
  }

  await markToasts(page);

  // A client-side precheck may disable BUY before anything is submitted.
  // Give it a grace window (the free-capital read is async on first paint),
  // then report WHY rather than hanging on an un-clickable button — an
  // un-guarded .click() would burn the default timeout and the run would
  // look like a mysterious stall instead of "the vault is empty".
  const buyBtn = page.getByTestId("betslip-buy");
  const enabledBy = Date.now() + BUY_ENABLE_GRACE_MS;
  while (Date.now() < enabledBy && (await buyBtn.isDisabled().catch(() => false))) {
    await page.waitForTimeout(200);
  }
  if (await buyBtn.isDisabled().catch(() => false)) {
    const reason = await blockedReason(page);
    await page.getByTestId("betslip-close").click().catch(() => {});
    return { ok: false, blocked: true, error: reason };
  }

  try {
    await buyBtn.click({ timeout: 10_000 });
  } catch (err) {
    await page.getByTestId("betslip-close").click().catch(() => {});
    return { ok: false, blocked: true, error: `BUY not clickable: ${String(err).slice(0, 160)}` };
  }

  const slip = page.getByTestId("betslip");
  const deadline = Date.now() + TX_TIMEOUT_MS;
  while (Date.now() < deadline) {
    // success path: onSettled("success") closes the slip (~1.5s after confirm)
    if ((await slip.count()) === 0) return { ok: true };

    // failure path 1: the inline stepper error (resets after ~4s — poll fast)
    const err = page.getByTestId("betslip-error");
    if ((await err.count()) > 0) {
      const text = ((await err.first().textContent()) ?? "").trim();
      if (text) {
        await page.getByTestId("betslip-close").click().catch(() => {});
        return { ok: false, error: text };
      }
    }

    // failure path 2: the sticky (~10s) error toast — catches a missed stepper
    const toastErr = page.locator('[data-testid="toast-item"][data-type="error"]:not([data-e2e-seen])');
    if ((await toastErr.count()) > 0) {
      const text = ((await toastErr.first().textContent()) ?? "").trim();
      await page.getByTestId("betslip-close").click().catch(() => {});
      return { ok: false, error: text || "buy failed" };
    }

    await page.waitForTimeout(250);
  }

  await page.getByTestId("betslip-close").click().catch(() => {});
  return {
    ok: false,
    error: `buy of ${flightId} ${dateISO} did not resolve within ${TX_TIMEOUT_MS / 1000}s`,
  };
}
