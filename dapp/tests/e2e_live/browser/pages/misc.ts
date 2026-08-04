/**
 * Cross-page drivers: +MINT faucet, balance chip, SPA navigation, console
 * error collection, the network-mismatch banner, and the /admin auth gate.
 */
import type { Page } from "playwright";
import { markToasts, origin } from "./_helpers";

const MINT_TIMEOUT_MS = 60_000;

/** Text of the TopBar USDC balance chip (needs a connected actor + lg viewport). */
export async function readBalanceChip(page: Page): Promise<string> {
  const chip = page.getByTestId("topbar-balance");
  await chip.waitFor({ state: "attached", timeout: 15_000 });
  return ((await chip.textContent()) ?? "").trim();
}

/**
 * Click the +MINT faucet (10,000 mock USDC) and wait for the balance chip to
 * change. The button only exists for a connected actor on a non-PUBLIC
 * network, and is disabled mid-mint / during a network mismatch.
 */
export async function mint(page: Page): Promise<{ ok: boolean; error?: string }> {
  const btn = page.getByTestId("topbar-mint");
  if ((await btn.count()) === 0) {
    return { ok: false, error: "+MINT button not rendered (no connected address, or PUBLIC network)" };
  }
  const before = await readBalanceChip(page);
  if (await btn.isDisabled()) {
    return { ok: false, error: "+MINT button is disabled (mint already in flight, or network mismatch)" };
  }
  await markToasts(page);
  await btn.click();

  const deadline = Date.now() + MINT_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const now = await readBalanceChip(page);
    if (now !== before && now !== "…" && now !== "—" && now !== "") return { ok: true };
    const errToast = page.locator('[data-testid="toast-item"][data-type="error"]:not([data-e2e-seen])');
    if ((await errToast.count()) > 0) {
      const text = ((await errToast.first().textContent()) ?? "").trim();
      return { ok: false, error: text || "mint failed" };
    }
    await page.waitForTimeout(500);
  }
  return { ok: false, error: `balance chip did not change within ${MINT_TIMEOUT_MS / 1000}s of +MINT` };
}

/** SPA navigation via full page load (route e.g. "/house", "/status"). */
export async function gotoRoute(page: Page, route: string): Promise<void> {
  await page.goto(origin(page) + route, { waitUntil: "load" });
  await page.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => {});
}

/**
 * Attach console/pageerror listeners; the returned array fills up as the page
 * runs. Attach once per page, early. (Synchronous — an async signature can't
 * return the bare `{ errors }` shape.)
 */
export function consoleErrorCollector(page: Page): { errors: string[] } {
  const errors: string[] = [];
  page.on("console", (msg) => {
    if (msg.type() === "error") errors.push(msg.text());
  });
  page.on("pageerror", (err) => {
    errors.push(String(err));
  });
  return { errors };
}

/** Is the amber wrong-network banner up right now? (Point-in-time check.) */
export async function mismatchBannerVisible(page: Page): Promise<boolean> {
  try {
    return await page.getByTestId("network-mismatch-banner").first().isVisible();
  } catch {
    return false;
  }
}

/**
 * Navigate to /admin and confirm the Supabase magic-link auth gate rendered
 * (the "Tower access" sign-in panel) rather than a crash or a blank page.
 * Returns false on a missing-config message, a crash boundary, or a timeout.
 */
export async function adminGateRendered(page: Page): Promise<boolean> {
  if (new URL(page.url()).pathname !== "/admin") {
    await page.goto(origin(page) + "/admin", { waitUntil: "load" });
  }
  try {
    // lazy chunk + supabase getSession round-trip → allow generous time
    await page.getByTestId("admin-gate").first().waitFor({ state: "visible", timeout: 20_000 });
    return true;
  } catch {
    return false;
  }
}
