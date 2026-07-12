"use client";

import { useState } from "react";
import { FaArrowUpRightFromSquare, FaCheck, FaCopy } from "react-icons/fa6";
import { shortAddress } from "@/lib/format";

export function AddressLine({
  address,
  explorerUrl,
  chars = 6,
}: {
  address: string;
  explorerUrl?: string;
  chars?: number;
}) {
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(address);
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    } catch {
      /* clipboard unavailable */
    }
  };

  return (
    <span className="addr-line" title={address}>
      {shortAddress(address, chars)}
      <button className="icon-btn" onClick={() => void copy()} aria-label="Copy address">
        {copied ? <FaCheck size={12} /> : <FaCopy size={12} />}
      </button>
      {explorerUrl && (
        <a
          href={explorerUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="icon-btn"
          aria-label="Open in explorer"
        >
          <FaArrowUpRightFromSquare size={12} />
        </a>
      )}
    </span>
  );
}
