/**
 * Per-actor Playwright contexts for the live-soak harness.
 *
 * Each actor gets an isolated BrowserContext whose init script seeds
 * `localStorage.e2eSecret` BEFORE any page script runs — src/util/e2eSigner.ts
 * picks it up (gated on PUBLIC_E2E_SIGNER=1, set by browser/server.ts) and
 * WalletProvider then presents the actor as a connected wallet.
 *
 * `wrongPassphrase` seeds `localStorage.e2eNetworkPassphrase` with the MAINNET
 * passphrase, deliberately tripping the network-mismatch banner (assertion F).
 */
import { chromium } from "playwright";
import type { Browser, BrowserContext, Page } from "playwright";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";

const MAINNET_PASSPHRASE = "Public Global Stellar Network ; September 2015";

export interface ActorContext {
  page: Page;
  context: BrowserContext;
  address: string;
  close(): Promise<void>;
}

export async function launchBrowser(headful?: boolean): Promise<Browser> {
  return chromium.launch({ headless: !headful });
}

export async function newActorContext(
  browser: Browser,
  uiUrl: string,
  actor: { secret: string; address: string },
  opts?: { wrongPassphrase?: boolean },
): Promise<ActorContext> {
  // ≥1024px (lg) viewport: the TopBar balance chip is display:none on
  // narrower breakpoints and the drivers read/watch it constantly.
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });

  await context.addInitScript(
    (cfg: { secret: string; passphrase: string | null }) => {
      window.localStorage.setItem("e2eSecret", cfg.secret);
      if (cfg.passphrase) {
        window.localStorage.setItem("e2eNetworkPassphrase", cfg.passphrase);
      }
    },
    {
      secret: actor.secret,
      passphrase: opts?.wrongPassphrase ? MAINNET_PASSPHRASE : null,
    },
  );

  const page = await context.newPage();
  await page.goto(uiUrl, { waitUntil: "load", timeout: 60_000 });
  // Best-effort settle: polling queries (refetchInterval) can keep the wire
  // warm, so a missed network-idle must not fail actor setup.
  await page.waitForLoadState("networkidle", { timeout: 20_000 }).catch(() => {});

  return {
    page,
    context,
    address: actor.address,
    close: () => context.close(),
  };
}

/** Screenshot to `${dir}/${name}.png` (mkdir -p), returning the path. */
export async function snap(page: Page, dir: string, name: string): Promise<string> {
  await mkdir(dir, { recursive: true });
  const path = join(dir, `${name}.png`);
  await page.screenshot({ path, fullPage: true });
  return path;
}
