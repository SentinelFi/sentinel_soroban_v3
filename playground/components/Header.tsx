"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { FaShieldHalved } from "react-icons/fa6";
import { WalletButton } from "@/components/WalletButton";

const LINKS = [
  { href: "/", label: "Global State" },
  { href: "/account", label: "My Account" },
  { href: "/interact", label: "Interact" },
];

export function Header() {
  const pathname = usePathname();
  return (
    <header className="site-header">
      <div className="container inner">
        <Link href="/" className="brand">
          <FaShieldHalved size={20} />
          <span>SENTINEL PLAYGROUND</span>
          <span className="net">testnet</span>
        </Link>
        <nav className="nav">
          {LINKS.map((l) => (
            <Link
              key={l.href}
              href={l.href}
              className={pathname === l.href ? "active" : ""}
            >
              {l.label}
            </Link>
          ))}
          <WalletButton />
        </nav>
      </div>
    </header>
  );
}
