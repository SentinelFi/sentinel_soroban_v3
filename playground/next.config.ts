import type { NextConfig } from "next";

// Opt out of Next.js anonymous telemetry (https://nextjs.org/telemetry).
// The config file is loaded by the CLI before any telemetry event is
// recorded, so setting the env var here disables it for build, dev and
// start on any machine or CI without extra setup.
process.env.NEXT_TELEMETRY_DISABLED = "1";

const isDev = process.env.NODE_ENV === "development";

// Strict Content-Security-Policy.
//
// - script-src 'unsafe-inline' is required by Next.js bootstrap scripts;
//   'unsafe-eval' is only added for the dev server (React refresh).
// - style-src 'unsafe-inline' is required by the Stellar Wallets Kit modal
//   (it injects its styles at runtime).
// - img-src allows stellar.creit.tech: the Wallets Kit modal loads its
//   wallet logos (e.g. /wallet-icons/albedo.png) from there. Images only —
//   this grants no script or connection ability.
// - connect-src is limited to the Stellar testnet endpoints this app talks
//   to. If you enable extra wallet modules (WalletConnect, Ledger, Trezor)
//   you must extend this list with their endpoints.
const csp = [
  "default-src 'self'",
  `script-src 'self' 'unsafe-inline'${isDev ? " 'unsafe-eval'" : ""}`,
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: https://stellar.creit.tech",
  "font-src 'self'",
  "connect-src 'self' https://soroban-testnet.stellar.org https://horizon-testnet.stellar.org https://friendbot.stellar.org",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
  ...(isDev ? [] : ["upgrade-insecure-requests"]),
].join("; ");

const securityHeaders = [
  { key: "Content-Security-Policy", value: csp },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Referrer-Policy", value: "no-referrer" },
  {
    key: "Permissions-Policy",
    value: "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
  },
  {
    key: "Strict-Transport-Security",
    value: "max-age=63072000; includeSubDomains",
  },
];

const nextConfig: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  async headers() {
    return [
      {
        source: "/(.*)",
        headers: securityHeaders,
      },
    ];
  },
};

export default nextConfig;
