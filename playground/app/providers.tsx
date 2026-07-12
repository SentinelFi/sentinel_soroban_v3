"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react";

interface WalletState {
  address: string | null;
  connecting: boolean;
  connect: () => Promise<void>;
  disconnect: () => Promise<void>;
  openProfile: () => Promise<void>;
  signXdr: (unsignedXdr: string) => Promise<string>;
}

const WalletContext = createContext<WalletState>({
  address: null,
  connecting: false,
  connect: async () => {},
  disconnect: async () => {},
  openProfile: async () => {},
  signXdr: async () => {
    throw new Error("Wallet not connected");
  },
});

export function useWallet(): WalletState {
  return useContext(WalletContext);
}

export function Providers({ children }: { children: ReactNode }) {
  const [address, setAddress] = useState<string | null>(null);
  const [connecting, setConnecting] = useState(false);

  // Restore a previous session and track kit state changes.
  useEffect(() => {
    let unsub: (() => void) | undefined;
    let disposed = false;
    (async () => {
      const { restoreAddress, onWalletChange } = await import("@/lib/walletKit");
      const restored = await restoreAddress();
      if (!disposed && restored) setAddress(restored);
      const off = await onWalletChange((addr) => {
        if (!disposed) setAddress(addr);
      });
      if (disposed) off();
      else unsub = off;
    })().catch(() => {
      /* wallet kit unavailable — leave disconnected */
    });
    return () => {
      disposed = true;
      unsub?.();
    };
  }, []);

  const connect = useCallback(async () => {
    setConnecting(true);
    try {
      const { connectWallet } = await import("@/lib/walletKit");
      const addr = await connectWallet();
      setAddress(addr);
    } finally {
      setConnecting(false);
    }
  }, []);

  const disconnect = useCallback(async () => {
    const { disconnectWallet } = await import("@/lib/walletKit");
    await disconnectWallet();
    setAddress(null);
  }, []);

  const openProfile = useCallback(async () => {
    const { openProfileModal } = await import("@/lib/walletKit");
    await openProfileModal();
  }, []);

  const signXdr = useCallback(
    async (unsignedXdr: string) => {
      if (!address) throw new Error("Wallet not connected");
      const { signWithWallet } = await import("@/lib/walletKit");
      return signWithWallet(unsignedXdr, address);
    },
    [address],
  );

  return (
    <WalletContext.Provider
      value={{ address, connecting, connect, disconnect, openProfile, signXdr }}
    >
      {children}
    </WalletContext.Provider>
  );
}
