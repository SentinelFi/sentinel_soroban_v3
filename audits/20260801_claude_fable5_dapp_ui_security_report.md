# Claude Fable 5: Dapp UI Security Review

**Assessment date:** 1 August 2026

**Report version:** v1.0

**Assessment status:** Final

**Assessment type:** AI-Assisted Frontend Security Review

**Auditor:** Claude Fable 5

---

## Assessment Information

| | |
| --- | --- |
| Project | Sentinel Protocol — FLIGHTS.FUN dapp |
| Component | Frontend UI — `dapp/src/**`, `dapp/index.html`, `dapp/vite.config.ts`, `dapp/vercel.json` |
| Network | Stellar (Soroban testnet) |
| Language | TypeScript / React 19 / Vite 7 |
| Snapshot date | 2026-08-01 |

**Scope:** browser-side security of the dapp SPA — XSS surface, external-link
hygiene, wallet/transaction-signing flow (`util/wallet.ts`,
`providers/WalletProvider.tsx`, `hooks/useContracts.ts`, `src/contracts/*`),
secret/bundle boundary (`envPrefix`, `import.meta.env` usage,
`lib/supabase.ts`), web storage, the `/admin` console's client side and its
authentication to `/api/admin/*`, deployed security headers, dependency
posture, and numeric handling of on-chain amounts.

**Out of scope:** off-chain backend business logic (`dapp/api/**` internals),
on-chain contracts, and the retired `frontend/` / `frontend2/` trees. Where
this report touches the admin API it only assesses what the browser sends and
trusts. This report complements — and where relevant confirms remediations
from — `20260730_claude_opus48_frontend_security_report.md` (FSA-* IDs).

**Finding IDs:** `SEC-<severity><n>` (H = high, M = medium, L = low, I = info).

---

## Summary

No high-severity issues. The XSS posture is clean (zero raw-HTML sinks), the
signing path cannot be redirected by API or chain responses (hardcoded
contract IDs, build-time-pinned passphrase, `allowHttp` restricted to LOCAL),
and the `PUBLIC_` env boundary is correctly enforced. The main gap is the
absence of a content Content-Security-Policy, which removes the browser-level
backstop a wallet dApp should have against supply-chain compromise or a
future XSS bug.

| ID | Severity | Title |
| --- | --- | --- |
| SEC-M1 | Medium | No content CSP — only `frame-ancestors` is set |
| SEC-L1 | Low | Admin JWT persisted in localStorage by supabase-js defaults |
| SEC-L2 | Low | Network mismatch is warn-only; signing not blocked |
| SEC-L3 | Low | `parseUsdc` goes through float math for amounts the user signs |
| SEC-L4 | Low | `TypedStorage.getItem` rethrows JSON.parse failures inside the wallet poll |
| SEC-L5 | Low | Google Fonts loaded cross-origin without fallback or SRI |
| SEC-I1 | Info | Explorer links hardcode testnet |
| SEC-I2 | Info | HSTS lacks `includeSubDomains; preload`; no `Permissions-Policy` |
| SEC-I3 | Info | Trusted-RPC residual risk (inherent) |
| SEC-I4 | Info | Testnet faucet mint button must be gated at mainnet |
| SEC-I5 | Info | `formatUsdc` truncates rather than rounds |
| SEC-I6 | Info | `Number()` on chain amounts in display-only paths |

---

## Findings

### SEC-M1 (Medium) — No content Content-Security-Policy; only `frame-ancestors` is set

- **Where:** `dapp/vercel.json:16` (`"Content-Security-Policy": "frame-ancestors 'none'"`); `index.html` has no CSP meta tag.
- **Issue:** there is no `script-src` / `connect-src` / `object-src` policy, so nothing constrains injected or compromised script.
- **Failure scenario:** a supply-chain compromise of any bundled dependency (e.g. a wallet-kit or UI package release) or a future XSS bug can silently exfiltrate the Supabase admin session token from localStorage or rewrite the transaction-building code path with no browser-level backstop.
- **Recommendation:** add a full CSP, e.g. `default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; connect-src 'self' https://soroban-testnet.stellar.org https://horizon-testnet.stellar.org https://murcgnleczppbooifkya.supabase.co; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data:; object-src 'none'; base-uri 'self'` (adjust origins at mainnet redeploy). Self-hosting fonts (SEC-L5) lets the Google origins be dropped.

### SEC-L1 (Low) — Admin JWT persisted in localStorage by supabase-js defaults

- **Where:** `dapp/src/lib/supabase.ts:13` — `createClient(url, key)` with default `persistSession: true` stores the session (access + refresh token) under `localStorage["sb-…-auth-token"]`.
- **Failure scenario:** combined with SEC-M1, any script injection reads the token and can call `/api/admin/*` as that admin until expiry. The server-side allowlist limits blast radius to allowlisted accounts, but the token is the whole credential.
- **Recommendation:** primarily mitigate via CSP (SEC-M1); optionally shorten the Supabase JWT TTL, or pass `auth: { storage: sessionStorage }` for the admin console.

### SEC-L2 (Low) — Network mismatch is warn-only; signing not blocked

- **Where:** `dapp/src/providers/WalletProvider.tsx:44-53,197-199`; banner at `src/App.tsx:42-55` (in-code reference: FSA-L01).
- **Issue:** when the wallet reports a different network passphrase than the app's, only a banner is shown and the sign buttons stay live. Additionally the passphrase is only captured for `freighter` / `hot-wallet` (`src/util/wallet.ts:69-79`), so other wallets never trip the check at all.
- **Failure scenario:** a user on the wrong network clicks through; the wallet rejects or fails the tx, producing confusing errors. Funds-loss risk is low because the tx envelope carries the app's pinned passphrase, which honest wallets validate.
- **Recommendation:** disable `TransactionButton`s (or require an explicit override) while `networkMismatch` is true; consider a passive "network unverified" hint for wallets that don't report a network.

### SEC-L3 (Low) — `parseUsdc` goes through float math for amounts the user signs

- **Where:** `dapp/src/hooks/useContracts.ts:62-66` — `BigInt(Math.floor(parseFloat(amount) * 10_000_000))`.
- **Issue:** binary-float representation means e.g. `"0.29"` → `2899999.9999…` → `2899999` stroops (1 stroop short); `parseFloat` also accepts junk-suffixed input (`"12.3abc"`) and scientific notation (`"1e3"` silently means 1000).
- **Failure scenario:** the deposit/withdraw amount the user signs differs from what they typed by up to 1 stroop. Rounding is downward, i.e. user-favorable/benign in direction.
- **Recommendation:** parse the decimal string directly (split on `"."`, pad/truncate the fraction to 7 digits, assemble with BigInt). Fix before mainnet.
- **Positive counterpart:** the large amounts (premium/payoff) are never user-typed — `buy_insurance` takes no amount argument (`Markets.tsx:392-398`); the premium is enforced on-chain from governance terms.

### SEC-L4 (Low) — `TypedStorage.getItem` rethrows JSON.parse failures inside the 1-second wallet poll

- **Where:** `dapp/src/util/storage.ts:40-62` (default `retrievalMode: "fail"`), called without try/catch at `src/providers/WalletProvider.tsx:106-109`.
- **Failure scenario:** a legacy or hand-edited raw (non-JSON) value under `walletId` / `walletAddress` throws on every poll tick, producing an unhandled rejection per second and permanently breaking wallet session restore until the user clears storage.
- **Recommendation:** use `storage.getItem(key, "safe")` in `WalletProvider` (and `connectWallet`).

### SEC-L5 (Low) — Google Fonts loaded cross-origin without a fallback or SRI

- **Where:** `dapp/index.html:11-16`.
- **Failure scenario:** styles-only injection surface if `fonts.googleapis.com` were compromised (CSS cannot run script but can overlay/spoof UI, e.g. restyle the buy button area), plus a per-visit IP disclosure to Google.
- **Recommendation:** self-host the three font families; this also tightens the SEC-M1 policy.

### Informational

- **SEC-I1 — Explorer links hardcode testnet.** `src/providers/NotificationProvider.tsx:76-78`, `src/pages/Admin.tsx:1327`. Wrong explorer network at mainnet redeploy; derive from `stellarNetwork` in `contracts/util.ts`.
- **SEC-I2 — Header hardening gaps.** `vercel.json:20` — HSTS lacks `includeSubDomains; preload`; no `Permissions-Policy` header (recommend `camera=(), microphone=(), geolocation=()`).
- **SEC-I3 — Trusted-RPC residual risk (inherent; document it).** Displayed premiums/payoffs and the simulation that assembles the signed tx both come from the single `PUBLIC_STELLAR_RPC_URL` (`src/contracts/util.ts:19-21`). A compromised RPC could display one number and simulate another; the user's real verification point is the wallet's signing prompt. `allowHttp` is correctly restricted to LOCAL (all six `src/contracts/*.ts`, FSA-L02), so network MITM downgrade is prevented; only endpoint compromise remains.
- **SEC-I4 — Testnet faucet button in the header.** `src/components/TopBar.tsx:125-140` (`mockUsdcClient.faucet`). Fine now; must be removed/gated when pointing at mainnet USDC.
- **SEC-I5 — `formatUsdc` truncates (not rounds) to 2 decimals** and would render negative i128 oddly. `src/hooks/useContracts.ts:54-59`. Display-only.
- **SEC-I6 — `Number()` on chain amounts** in `src/pages/Admin.tsx:41-42` and `src/util/wallet.ts:114`. Display-only paths; precision loss only above 2^53 stroops.

---

## Checked and clean

1. **XSS:** zero `dangerouslySetInnerHTML` / `innerHTML` / `eval` / `new Function` / `document.write` / `javascript:` hrefs anywhere in `src/` (verified by grep). All API/chain data renders through JSX text nodes (React-escaped), including admin evidence (`JSON.stringify` into a `<pre>`). The only dynamic URLs are `https://stellar.expert/...${tx_hash}` (path suffix — a hostile hash cannot change scheme/origin) and `flightradarUrl`, which `encodeURIComponent`s the flight id (`Markets.tsx:136-140`).
2. **External links:** every `target="_blank"` carries `rel="noopener noreferrer"` (12/12 occurrences verified).
3. **Wallet security:** passphrase pinned at build (`PUBLIC_STELLAR_NETWORK_PASSPHRASE`) and passed to `StellarWalletsKit.init` (`src/util/wallet.ts:41-48`) and every contract client; contract IDs are hardcoded constants in `src/contracts/*.ts` — no API response can change contract ID, destination, or amounts. Transactions are standard `AssembledTransaction`s from CLI-generated bindings (simulate → wallet-sign XDR); no arbitrary-payload signing, no `signMessage` / `signAuthEntry`. The `/api/sale-auth/request` response is trusted only as a yes/no gate (`Markets.tsx:374-389`); the contract independently enforces `SaleNotOpen`/whitelist (Errors 306–321 in `packages/controller/src/index.ts`).
4. **Secrets:** `envPrefix: "PUBLIC_"` (`vite.config.ts:33`) — only the four network vars + Supabase URL/anon key can reach the bundle; all six `import.meta.env` uses are those (verified by grep). `.env` (which locally holds oracle/keeper secrets) is gitignored via the repo-root rule and untracked (`git check-ignore` / `git ls-files` verified); `.vercel/` ignored too. RLS deny-all assumptions are documented in `.env.example` and `src/lib/supabase.ts`.
5. **Storage:** localStorage holds only wallet id/address/network/passphrase + theme keys — nothing sensitive except the supabase-managed admin session (SEC-L1). `ThemeProvider` wraps its reads in try/catch correctly.
6. **Admin page:** client gating is display-only; every `/api/admin/*` call sends `Authorization: Bearer <supabase access_token>` (`Admin.tsx:27-39`) and the server does a live `auth.getUser` check plus confirmed-email + `ADMIN_EMAILS` allowlist (`api/_lib/governance/admin_auth.ts`, includes the FSA-M02 email-confirmation gate). Privileged data lives only in React Query memory. `emailRedirectTo: window.location.href` is constrained by Supabase's dashboard redirect allowlist.
7. **Headers:** `X-Frame-Options: DENY` + `frame-ancestors 'none'`, `nosniff`, `Referrer-Policy: strict-origin-when-cross-origin`, HSTS all present (`vercel.json:12-22`). Gaps: SEC-M1, SEC-I2.
8. **Dependencies:** nothing unusual. `@creit.tech/stellar-wallets-kit` pinned exactly at `2.5.0`, `@stellar/stellar-sdk` exactly at `16.1.0` (no silent bumps of the signing path); `postgres` in package.json is used only by `api/` serverless code, never imported from `src/` (verified).
9. **Numerics:** SEC-L3 / SEC-I5 / SEC-I6 — no user-typed float ever becomes a signed premium/payoff; only deposit/withdraw amounts pass through `parseUsdc`, with downward (user-favorable) rounding.
10. **Open redirects / postMessage / window.opener:** none. The only URL-param input (`/markets?flight=`, `Markets.tsx:585-599`) is matched against the known route list, then consumed and deleted — never used for navigation or rendered raw.

---

## Done well

- Clean XSS posture: no raw-HTML sinks at all; consistent `rel="noopener noreferrer"`.
- Hardcoded contract IDs + build-time-pinned passphrase + `allowHttp` restricted to LOCAL — API/chain responses cannot redirect what the user signs.
- Strict `PUBLIC_` env prefixing with an explicitly documented server/browser split and the RLS deny-all assumption stated in three places.
- Server-side admin enforcement done right (live token check, confirmed-email gate, allowlist, audit log); the UI treats itself as untrusted.
- Prior audit remediations visibly landed in code (FSA-L01 mismatch banner, FSA-L02 allowHttp, FSA-M02 email confirmation).
- Exact-pinned wallet/SDK versions, `/admin` lazy-loaded, bounded RPC concurrency, sanitized public status endpoints.

## Priority order

1. Add the full CSP (SEC-M1) + header hardening (SEC-I2).
2. Block signing on network mismatch (SEC-L2).
3. Replace float parsing in `parseUsdc` (SEC-L3).
4. Switch `WalletProvider` storage reads to safe mode (SEC-L4).
