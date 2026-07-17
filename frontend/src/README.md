# Frontend

React + Vite dApp for Sentinel Protocol, scaffolded with
[Scaffold Stellar](https://scaffoldstellar.org).

## Design choices

| Decision             | Choice                                       | Why                                                                 |
| -------------------- | -------------------------------------------- | ------------------------------------------------------------------- |
| **Framework**        | Scaffold Stellar (React + Vite)              | Auto-generates TypeScript contract bindings, built-in env switching |
| **Styling**          | TailwindCSS with CSS variable theme          | Themeable colors, utility-first, consistent dark UI                 |
| **Wallet**           | `@creit.tech/stellar-wallets-kit`            | Abstraction layer — Freighter, Lobstr, xBull out of the box         |
| **Contract clients** | Auto-generated in `packages/`                | Type-safe, zero boilerplate                                         |
| **State management** | `@tanstack/react-query`                      | Polling contract reads with refetch intervals                       |
| **Env switching**    | `environments.toml` + `STELLAR_SCAFFOLD_ENV` | Testnet and mainnet configs in one file                             |

## Pages

| Path        | Page              | Description                                                       |
| ----------- | ----------------- | ----------------------------------------------------------------- |
| `/`         | Landing           | Animated SVG planes, protocol stats, premium flow diagram, CTAs   |
| `/buy`      | Buy Insurance     | Route picker, date selector, premium/payoff display, buy button   |
| `/policies` | My Policies       | Policy cards with flight arc SVGs, countdown timers, claim button |
| `/flights`  | Flight Markets    | Global flight list with status filters (Active/Settled/All)       |
| `/vault`    | Underwriter Vault | Deposit, stats/APY, health gauge, FIFO withdraw queue             |
| `/admin`    | Admin             | Governance forms, route management, executor status (footer link) |
| `/debug`    | Contract Explorer | Scaffold's built-in contract invoker (footer link)                |

## Visual enhancements

- **Animated flight arcs** — SVG origin→destination curves with plane icons on
  policy cards
- **Vault health gauge** — semicircular SVG solvency indicator
  (green/yellow/red)
- **Premium flow animation** — animated USDC flowing through the protocol on
  landing
- **Countdown timers** — ETA countdown on active policies
- **Animated planes** — SVG planes on curved flight paths in the landing hero

## Project structure

```
src/
├── components/         # Reusable UI (ConnectAccount, WalletButton, NetworkPill)
├── contracts/          # Auto-generated contract imports (do not edit)
├── hooks/              # React hooks (useWallet, useNotification, useSubscription)
├── pages/              # Route pages
│   ├── Landing.tsx     # Hero + stats + flow animation
│   ├── BuyInsurance.tsx
│   ├── MyPolicies.tsx
│   ├── FlightMarkets.tsx
│   ├── Vault.tsx
│   ├── Admin.tsx
│   └── Debug.tsx       # Scaffold contract explorer
├── providers/          # Context providers (WalletProvider, NotificationProvider)
├── util/               # Helpers (wallet, storage)
├── App.tsx             # Root layout + routing
├── main.tsx            # Entry point
└── index.css           # TailwindCSS + theme variables
```

## Running

```bash
cd frontend
npm install
npm run install:contracts
npm run dev     # Start Vite + scaffold watch (hot reload)
npm start       # Same as dev
```

## Contract bindings

Generated from deployed testnet contracts. When contracts change:

```bash
# Automatic: npm start watches contracts/ and regenerates bindings on change

# Manual: rebuild all bindings
npm run rebuild-bindings
```

## Theme

Colors are defined as CSS variables in `src/index.css` under `@theme`. Override
for custom branding:

```css
--color-sentinel-primary: #6366f1;
--color-sentinel-accent: #06b6d4;
--color-sentinel-bg: #0f172a;
```

## Contract integration status

All pages use placeholder/demo data with `// TODO` comments marking where real
contract reads/writes will be wired. Contract clients are available at
`src/contracts/`.
