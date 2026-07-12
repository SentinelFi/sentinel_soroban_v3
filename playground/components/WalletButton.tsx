"use client";

import { FaWallet } from "react-icons/fa6";
import { useWallet } from "@/app/providers";
import { shortAddress } from "@/lib/format";

export function WalletButton() {
  const { address, connecting, connect, openProfile } = useWallet();

  if (address) {
    return (
      <button
        className="btn btn-outline btn-sm"
        onClick={() => void openProfile()}
        title={address}
      >
        <FaWallet size={13} />
        <span className="mono">{shortAddress(address)}</span>
      </button>
    );
  }

  return (
    <button
      className="btn btn-sm"
      onClick={() => void connect().catch(() => {})}
      disabled={connecting}
    >
      <FaWallet size={13} />
      {connecting ? "Connecting…" : "Connect Wallet"}
    </button>
  );
}
