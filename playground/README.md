# Sentinel Playground

A Next.js web app for interacting with the **Sentinel flight-delay insurance
protocol** deployed on **Stellar testnet**: call any contract function,
inspect global protocol state, and manage your own positions (policies,
vault shares, withdrawals).

Contract addresses come from [`deployments/testnet.json`](../deployments/testnet.json)
in this repository.

## Pages

| Page | What it does |
|---|---|
| **Global State** (`/`) | Protocol totals, pause switches, vault health (TMA / locked / free capital, share price, withdrawal queue), active flights with live status, route-terms checker, deployment reference. |
| **My Account** (`/account`) | Wallet balances, XLM Friendbot + USDC faucet, buy flight-delay insurance, your policies with one-click payout claims, your vault position (deposit, queued withdrawal requests, cancel, collect). |
| **Interact** (`/interact`) | Generic caller for every public entrypoint on all six contracts, with typed forms, authorization badges, free read queries and simulate-before-sign writes. |

## Stack

- [Next.js](https://nextjs.org) 16 (App Router, TypeScript) — scaffolded manually, no telemetry-emitting generator run
- [`@stellar/stellar-sdk`](https://www.npmjs.com/package/@stellar/stellar-sdk) 16.0.1 — RPC simulation, transaction building, XDR
- [`@creit.tech/stellar-wallets-kit`](https://github.com/Creit-Tech/Stellar-Wallets-Kit) 2.5.0 — multi-wallet connect + signing (Freighter, xBull, Albedo, Rabet, Lobstr, Hana, …)
- [`react-icons`](https://react-icons.github.io/react-icons/) — iconography

## Running it

Options:

- **StackBlitz / CodeSandbox**: import the repository, set the project root
  to `playground/`, and the online container installs and runs `npm run dev`.
- **Vercel**: import the repo, set *Root Directory* to `playground/`.
  Build command `next build`, Node.js ≥ 20.9.
- **Locally** (if you ever choose to): `npm install && npm run dev` inside
  `playground/`.

There is no `.env` to configure — the app is fully client-side and talks only
to public testnet endpoints.

## Security posture

- **No secrets anywhere.** The app never sees or stores a private key. Every
  transaction is built client-side, simulated via RPC, and signed inside the
  user's wallet extension. There are no API routes and no server state.
- **Pinned dependencies.** All runtime dependencies are pinned to exact,
  registry-verified versions to reduce supply-chain drift.
- **Strict security headers** (see `next.config.ts`): a Content-Security-Policy
  restricting `connect-src` to the Stellar testnet RPC, Horizon and Friendbot
  (`img-src` additionally allows `stellar.creit.tech`, where the Wallets Kit
  modal loads its wallet logos from); `frame-ancestors 'none'`, `nosniff`,
  `no-referrer`, a restrictive Permissions-Policy and HSTS.
- **Simulate before sign.** Writes are dry-run via `simulateTransaction`; the
  wallet prompt only appears for a call that would succeed, and the UI shows
  exactly which function and arguments are being signed.
- **Strict input validation.** Addresses, symbols, integer ranges and amounts
  are validated and encoded with BigInt math (no floats) before any XDR is
  produced.
- **Testnet only.** The network passphrase is hardcoded to testnet; signatures
  are requested with that passphrase, so a mainnet wallet signature can never
  be replayed.
- **Telemetry disabled.** [Next.js anonymous telemetry](https://nextjs.org/telemetry)
  is opted out in `next.config.ts` (`NEXT_TELEMETRY_DISABLED=1`), so builds
  and dev servers phone nothing home regardless of where they run.

If you enable additional wallet modules that use remote transports
(WalletConnect, Ledger, Trezor), extend the CSP `connect-src` in
`next.config.ts` accordingly — with the strict default policy their network
calls would be blocked.

## Notes on protocol interaction

- **Buying insurance** requires: a whitelisted, enabled route
  (`governance.route_status`), an **open sale window** for the exact flight
  and UTC date (`oracle.is_sale_open`), sufficient USDC for the premium, and
  vault solvency headroom. The account page pre-checks these and reports the
  precise blocker before asking for a signature.
- **Dates** are UTC-midnight-aligned unix timestamps; the UI converts
  `YYYY-MM-DD` date inputs automatically.
- **Amounts**: USDC has 7 decimals; vault shares (RVS) have 10. Forms accept
  human units and scale internally.
- **Withdrawals**: immediate `withdraw`/`redeem` only work while the queue is
  empty and capital is free; the reliable exit is `request_withdrawal` →
  keeper processing → `collect`, which the account page manages end to end.

## Disclaimer

Testnet software for protocol exploration. Mock USDC has no value. Nothing
here is financial advice.
