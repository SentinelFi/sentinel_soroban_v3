// Thin wrapper around @creit.tech/stellar-wallets-kit v2.
//
// The kit renders Preact web components and must only ever be evaluated in
// the browser, so every export here lazily dynamic-imports it. Import this
// module freely from client components; never from server components.

import type { SwkAppTheme } from "@creit.tech/stellar-wallets-kit/types";
import { NETWORK } from "@/lib/config";

type Kit = typeof import("@creit.tech/stellar-wallets-kit/sdk").StellarWalletsKit;

// Kit modal theme matching the app's design language. The font-family
// resolves through the --font-lora variable set by next/font on <html>.
const SENTINEL_THEME: SwkAppTheme = {
  background: "#000003",
  "background-secondary": "#0b0b10",
  "foreground-strong": "#ffffff",
  foreground: "rgba(255, 255, 255, 0.92)",
  "foreground-secondary": "rgba(255, 255, 255, 0.62)",
  primary: "#ffca00",
  "primary-foreground": "#000003",
  transparent: "transparent",
  lighter: "rgba(255, 255, 255, 0.06)",
  light: "rgba(255, 255, 255, 0.12)",
  "light-gray": "rgba(255, 255, 255, 0.32)",
  gray: "rgba(255, 255, 255, 0.62)",
  danger: "#ff5c5c",
  border: "rgba(255, 255, 255, 0.16)",
  shadow: "0 16px 48px rgba(0, 0, 0, 0.85)",
  "border-radius": "0",
  "font-family": "var(--font-lora), Georgia, serif",
};

let kitPromise: Promise<Kit> | null = null;

async function kit(): Promise<Kit> {
  if (typeof window === "undefined") {
    throw new Error("The wallet kit is browser-only");
  }
  if (!kitPromise) {
    kitPromise = (async () => {
      const [{ StellarWalletsKit }, { defaultModules }, types] = await Promise.all([
        import("@creit.tech/stellar-wallets-kit/sdk"),
        import("@creit.tech/stellar-wallets-kit/modules/utils"),
        import("@creit.tech/stellar-wallets-kit/types"),
      ]);
      StellarWalletsKit.init({
        modules: defaultModules(),
        network: types.Networks.TESTNET,
        theme: SENTINEL_THEME,
      });
      return StellarWalletsKit;
    })();
  }
  return kitPromise;
}

/** Open the wallet-selection modal; resolves with the connected address. */
export async function connectWallet(): Promise<string> {
  const k = await kit();
  const { address } = await k.authModal();
  return address;
}

/** Previously-connected address from kit storage, or null. */
export async function restoreAddress(): Promise<string | null> {
  try {
    const k = await kit();
    const { address } = await k.getAddress();
    return address || null;
  } catch {
    return null;
  }
}

/** Open the kit's profile modal (shows the address; offers disconnect). */
export async function openProfileModal(): Promise<void> {
  const k = await kit();
  await k.profileModal();
}

export async function disconnectWallet(): Promise<void> {
  const k = await kit();
  await k.disconnect();
}

/** Sign a transaction XDR with the connected wallet on testnet. */
export async function signWithWallet(
  unsignedXdr: string,
  address: string,
): Promise<string> {
  const k = await kit();
  const { signedTxXdr } = await k.signTransaction(unsignedXdr, {
    networkPassphrase: NETWORK.passphrase,
    address,
  });
  return signedTxXdr;
}

/**
 * Subscribe to kit state changes. Returns an unsubscribe function.
 * Fires with the current address (or null) whenever it changes.
 */
export async function onWalletChange(
  handler: (address: string | null) => void,
): Promise<() => void> {
  const k = await kit();
  const { KitEventType } = await import("@creit.tech/stellar-wallets-kit/types");
  const subs = [
    k.on(KitEventType.STATE_UPDATED, (event: { payload?: { address?: string } }) => {
      handler(event?.payload?.address || null);
    }),
    k.on(KitEventType.DISCONNECT, () => handler(null)),
  ];
  return () => subs.forEach((unsub) => unsub());
}
