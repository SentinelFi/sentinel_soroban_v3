# Claude Opus 4.8: Sentinel Frontend Security Audit

**Assessment date:** 30 July 2026

**Report version:** v1.0

**Assessment status:** Final

**Assessment type:** AI-Assisted Frontend Security Review

**Auditor:** Claude Opus 4.8

---

## Assessment Information

| | |
| --- | --- |
| Project | Sentinel Protocol — FLIGHTS.FUN dapp |
| Component | Frontend — `dapp/src/**` (Vite + React SPA, generated Soroban bindings) + client-facing security configuration (Supabase data exposure, deploy headers, secret boundary, admin identity) |
| Network | Stellar (Soroban testnet) |
| Language | TypeScript / React 19 / Vite 7 |
| Snapshot date | 2026-07-30 |

**Scope:** the browser-side security posture of the `dapp/` SPA and the trust
boundary the browser sits behind — client-side XSS surface, the hidden
`/admin` gate, wallet/transaction-signing flows, what the public Supabase
anon key can reach (RLS / Data-API exposure), what the Vite build inlines
into the client bundle, deployed HTTP security headers, and local secret
hygiene. Assessed against the source tree, git history, and a production
`vite build` of `dist/`.

**Explicitly out of scope:** the off-chain backend business logic
(`dapp/api/**` — crons, governance backend, admin API internals) is covered
by the same-day **Off-Chain Findings Report** (`20260730_claude_fable5_offchain_report.md`).
Where a finding straddles both (public API endpoints the frontend calls),
this report cross-references that report's IDs rather than re-counting them.
On-chain contracts and the retired `frontend/` / `frontend2/` trees are out
of scope.

---

## Methodology

- Static analysis of `dapp/src/**`: grep sweeps for XSS sinks
  (`dangerouslySetInnerHTML`, `innerHTML`, `eval`, `new Function`,
  `document.write`, `insertAdjacentHTML`), `postMessage`, open-redirect and
  localStorage-trust patterns, and every transaction-signing call site.
- Trust-boundary review of the client↔server split: `src/lib/supabase.ts`,
  the `/admin` gate (`src/App.tsx`, `src/pages/Admin.tsx`), and the
  server-side `verifyAdmin` allowlist it depends on
  (`api/_lib/governance/admin_auth.ts`).
- Supabase data-exposure review: every `create table` across
  `supabase/migrations/**` **and** the serverless code paths, cross-checked
  against `enable row level security` and the `[api]` schema-exposure config
  in `supabase/config.toml`.
- Client-bundle secret scan: full-text grep of `dist/assets/*.js` for every
  non-`PUBLIC_` value in `.env` (DB password, AeroAPI key, Render key,
  `service_role`, Stellar seed format `S[A-Z2-7]{55}`), plus verification of
  Vite's `envPrefix` boundary.
- Git-history secret scan (`git log --all -S<value>`, `git check-ignore`) and
  `dependencies` version review of `package.json`.

**Baseline:** the browser holds only a publishable Supabase anon key and
public Stellar RPC/passphrase config; transaction signing is fully delegated
to the wallet kit (no seed in the frontend). The security model rests on two
load-bearing assumptions — *(a)* Supabase RLS is deny-all on every table so
the anon key can read nothing, and *(b)* every privileged action is
re-authorized server-side. Assumption (b) holds. Assumption (a) has a gap
(FSA-H01).

---

## Findings Summary

| ID | Severity | Title |
| --- | --- | --- |
| FSA-H01 | High | Four tables are created in application code with RLS never enabled — the browser-held anon key may read them |
| FSA-M01 | Medium | No HTTP security headers on the deployed site — clickjacking on a wallet-signing dapp |
| FSA-M02 | Medium | Admin auth trusts the email string without checking `email_confirmed_at` or provider |
| FSA-L01 | Low | Wallet↔app network-passphrase mismatch is not guarded before signing |
| FSA-L02 | Low | `allowHttp: true` hardcoded in all six generated contract clients |
| FSA-L03 | Low | Non-Freighter wallet identity trusted from localStorage without re-verification |
| FSA-L04 | Low | Live production secrets sit in plaintext local `.env` |
| FSA-I01 | Informational | Admin Supabase session JWT persists in localStorage |
| FSA-I02 | Informational | `.env.example` commits the real Supabase URL + publishable anon key |

### Severity Distribution

| High | Medium | Low | Info |
| ---: | ---: | ---: | ---: |
| 1 | 2 | 3 | 2 |

---

## High

### FSA-H01 — Four tables are created in application code with RLS never enabled — the browser-held anon key may read them

**Files:** `dapp/api/_lib/governance/interventions.ts:92`,
`dapp/api/_lib/flight_schedules.ts:32`, `dapp/api/_lib/outcome_log.ts:9`,
`dapp/api/_lib/governance/pricing_log.ts:45`; exposure config in
`supabase/config.toml` (`[api] schemas = ["public", …]`)

The security model documented throughout the codebase
(`src/lib/supabase.ts`, `api/_lib/governance/admin_auth.ts`) is *"the anon
key can read nothing — RLS is deny-all, zero policies."* All **8** tables
defined in `supabase/migrations/**` uphold this: each runs
`alter table … enable row level security`. But **4** tables — `interventions`,
`flight_schedules`, `flight_outcomes`, `pricing_runs` — are created lazily by
the serverless code at first write via `create table if not exists`, exist in
**no migration**, and **none** of the four code paths issue
`enable row level security` or `revoke … from anon`. Postgres defaults new
tables to RLS *disabled*.

The `[api]` block in `supabase/config.toml` exposes the `public` schema
through the PostgREST Data API, and the publishable anon key is inlined into
every visitor's browser bundle (verified in `dist/assets/Admin-*.js`). So the
deny-all guarantee that the rest of the system assumes simply does not exist
for these four tables — whether they are actually readable now hinges on the
implicit, unenforced condition of whether the `anon` role holds a SELECT
grant (Supabase's default-privileges behavior on the `public` schema makes
this plausible; `auto_expose_new_tables` is left at its commented-out
default).

**Scenario:** an unauthenticated
`GET https://<project>.supabase.co/rest/v1/interventions` (or
`flight_outcomes`, `flight_schedules`, `pricing_runs`) with the public anon
key returns the full table — operational pause/intervention history, flight
schedules, weather-outcome logs, and internal pricing-model runs — with no
admin JWT. This is exactly the fragile, silently-conditional gap RLS exists
to make explicit. It rates High rather than Critical only because
exploitability rests on the live grant posture, which cannot be confirmed
from the repo.

**Recommendation:** two parts. *(1)* Confirm or rule out live exposure
immediately with a single unauthenticated `curl` to
`/rest/v1/interventions` using the publishable anon key. *(2)* Enforce the
invariant in code: add `alter table <t> enable row level security;` **and**
`revoke all on <t> from anon, authenticated;` immediately after each
`create table if not exists` — or, better, move all four definitions into
proper `supabase/migrations/*.sql` files alongside the other eight, and stop
creating schema from application code so the deny-all convention is applied
uniformly and reviewably.

---

## Medium

### FSA-M01 — No HTTP security headers on the deployed site — clickjacking on a wallet-signing dapp

**Files:** `dapp/vercel.json`, `dapp/index.html`

`vercel.json` has no `headers` section and `index.html` sets no CSP meta, so
the deployed site ships with **no** `Content-Security-Policy`,
`X-Frame-Options` / `frame-ancestors`, `X-Content-Type-Options`, or
`Referrer-Policy`. For a wallet-connected financial dapp, the missing
frame-busting is the sharpest edge: an attacker can overlay a hidden iframe
of the app over decoy UI and trick a user into clicking through to a wallet
signing prompt (clickjacking). The absent CSP also means the codebase's
otherwise-clean XSS posture (no sinks — see Positive observations) is *not
structurally contained*: any future injected script would run unrestricted.

**Recommendation:** add a `headers` block to `vercel.json` with at minimum
`frame-ancestors 'none'` (or `X-Frame-Options: DENY`),
`X-Content-Type-Options: nosniff`, `Referrer-Policy: strict-origin-when-cross-origin`,
and a `Content-Security-Policy` restricting `script-src 'self'` and
`connect-src` to the RPC / Horizon / Supabase / API origins the app actually
calls (fonts.googleapis / gstatic for the font CSS). This is the single
highest-value hardening step in the report: it converts "no XSS sinks found"
into "XSS is structurally contained." Self-hosting the two Google Fonts
(`index.html`) would drop the last third-party runtime origin and let the CSP
tighten further.

### FSA-M02 — Admin auth trusts the email string without checking `email_confirmed_at` or provider

**File:** `dapp/api/_lib/governance/admin_auth.ts:36-44`

`verifyAdmin` does a live `supabase.auth.getUser(token)` check (correct — not
just a signature verify) and then gates on the `ADMIN_EMAILS` allowlist. But
it matches on `data.user.email` alone, without asserting
`data.user.email_confirmed_at` or pinning `app_metadata.provider`. Today the
project uses magic-link / Google sign-in, where the email is verified, so the
gate holds. However, if the Supabase project ever enables password signup
with email confirmation turned off (or any provider that does not verify
email), an attacker could register an allowlisted admin's email address,
receive a valid JWT, and pass the allowlist — full admin API access. This is
a code-level control that should not depend on a dashboard toggle staying
correct.

**Recommendation:** in `verifyAdmin`, require `data.user.email_confirmed_at`
to be set (and optionally pin `app_metadata.provider` to `email` / `google`)
before consulting the allowlist. Fail closed otherwise.

---

## Low

### FSA-L01 — Wallet↔app network-passphrase mismatch is not guarded before signing

**File:** `dapp/src/providers/WalletProvider.tsx` (network state at :60, :99,
:132-137), app passphrase in `dapp/src/contracts/util.ts:14-16`

`WalletProvider` tracks the connected wallet's `networkPassphrase`, and the
app bakes its own `networkPassphrase` into every generated contract client at
build time (`PUBLIC_STELLAR_NETWORK_PASSPHRASE`). Nothing ever compares the
two before enabling writes. A Freighter user whose wallet is on PUBLIC would
see the app's testnet balances/routes (the Horizon/RPC host comes from the
app env, not the wallet) and receive signing prompts for a different network
than their wallet UI shows — confusing today, and the more dangerous
direction on a future mainnet deploy where the inverse misconfiguration would
let a user sign a testnet-intended action on mainnet.

**Recommendation:** when the wallet's passphrase is present and differs from
the app's, surface a "wrong network" banner and disable the
`signTransaction` / write buttons until it matches.

### FSA-L02 — `allowHttp: true` hardcoded in all six generated contract clients

**Files:** `dapp/src/contracts/{controller,risk_vault,governance_module,
oracle_aggregator,mock_usdc,flight_pool_manager}.ts:8`

Every generated binding client sets `allowHttp: true` unconditionally. It is
inert today because the production `PUBLIC_STELLAR_RPC_URL` is https, but it
silently permits a cleartext RPC connection if the env is ever misconfigured
— and Soroban simulation results (fees, footprints, auth entries) returned
from a MITM'd RPC feed directly into what the wallet is asked to sign.

**Recommendation:** gate it on the network, mirroring the pattern already
used for Horizon in `src/util/wallet.ts` — e.g.
`allowHttp: stellarNetwork === "LOCAL"`. Note these are generated files, so
apply the fix in the binding-generation step (or a post-generate patch) so a
regeneration does not silently reintroduce `allowHttp: true`.

### FSA-L03 — Non-Freighter wallet identity trusted from localStorage without re-verification

**File:** `dapp/src/providers/WalletProvider.tsx:122`, reconnect path in
`dapp/src/util/wallet.ts`

On reconnect, the stored address/network for **non-Freighter** wallets is
taken from localStorage and never re-derived from the wallet, and network is
only refetched for `freighter` / `hot-wallet`. localStorage is same-origin so
this is not remotely exploitable, and a poisoned address cannot steal funds
(the real wallet must still auth-sign as the actual key; a mismatched
`caller` argument just fails the contract's `require_auth`). Impact is limited
to displaying wrong balances/ownership.

**Recommendation:** re-derive the address via `wallet.getAddress()` on
reconnect for every wallet type whose module supports it, rather than trusting
the cached value.

### FSA-L04 — Live production secrets sit in plaintext local `.env`

**File:** `dapp/.env`

The untracked local `.env` holds what appear to be real, active credentials —
the `GOVERNANCE_DB_URL` Postgres connection string (including DB password),
`AEROAPI_KEY` (paid metered API), and `RENDER_API_KEY` (account-level Render
control) — in the same file as the browser-side `PUBLIC_*` build vars.

**Verified safe today:** `.env` is gitignored (`git check-ignore` matches the
root `.gitignore`), none of the three values appear in any tracked file or
anywhere in git history (`git log --all -S<value>` → nothing), and none appear
in the built `dist/` bundle (Vite's `envPrefix: "PUBLIC_"` keeps non-`PUBLIC_`
vars out). This is a hygiene finding, not a breach: the risk is exfiltration
via a shared dev machine / screen-share / stray `cat .env`, and a single
accidental `PUBLIC_` rename would ship the DB password to every visitor.

**Recommendation:** split server-only secrets into a separate file Vite never
loads (e.g. Vercel project env for deploy, a non-loaded `.env.server` for
local tooling), keep the account-level `RENDER_API_KEY` out of a project
`.env` entirely, and rotate all three if this file has ever been shared.

---

## Informational

### FSA-I01 — Admin Supabase session JWT persists in localStorage

**File:** `dapp/src/lib/supabase.ts:13`

`createClient(url, key)` uses defaults, so the `/admin` Supabase session JWT
is stored in localStorage. Any future XSS bug would let an attacker exfiltrate
a token that `api/admin/*` accepts. Fully mitigated today by the absence of
XSS sinks (see Positive observations) and the server-side `ADMIN_EMAILS`
re-check. Optional hardening: a shorter Supabase JWT expiry, or
`persistSession: false` for the admin console so the token is not durably
stored.

### FSA-I02 — `.env.example` commits the real Supabase URL + publishable anon key

**File:** `dapp/.env.example`

The tracked `.env.example` contains the real Supabase project URL and the real
publishable anon key. That key class is public-by-design (it is inlined into
the client bundle regardless), but publishing it in the repo lets anyone hit
the project's Auth endpoints — e.g. trigger magic-link / OTP emails to
arbitrary addresses via the `/admin` sign-in flow (email spam / user
enumeration). All other secret slots in the file are correctly empty
placeholders.

**Recommendation:** acceptable as-is *if* the deny-all RLS gap (FSA-H01) is
closed and Supabase Auth rate limits + a restricted redirect-URL allowlist are
configured (the `/admin` flow passes `emailRedirectTo: window.location.href`,
which is safe only while that allowlist has no wildcard). Verify both in the
Supabase dashboard.

---

## Cross-referenced — already tracked in the Off-Chain Findings Report

These frontend-adjacent items surfaced during this review but are public-API
concerns already documented in `20260730_claude_fable5_offchain_report.md`;
they are listed here for completeness and **not** re-counted in this report's
severity totals:

- **Rate limiting on the public `sale-auth` buy-click endpoint** the frontend
  calls before every purchase → **OCA-M02**.
- **Cron auth fails open when `CRON_SECRET` is unset** → **OCA-L02**
  (constant-time compare → OCA-L01).
- **Raw internal error messages returned to callers** (incl. the public
  endpoints the SPA reads) → **OCA-M05**.
- **AeroAPI client builds URLs without encoding** → **OCA-L06** (the only
  browser-reachable path validates `flight_id` against `/^[A-Z0-9]{2,10}$/`
  first, so no client-side injection exists today).

---

## Areas Checked, No Issues Found

- **XSS:** zero hits for `dangerouslySetInnerHTML`, `innerHTML` / `outerHTML`
  / `insertAdjacentHTML`, `document.write`, `eval`, `new Function`, or
  `srcdoc` anywhere in `src/` or `index.html`. All chain-, DB-, and
  user-supplied strings render through auto-escaping JSX text nodes; DB
  `evidence` JSON is shown via `JSON.stringify` inside a `<pre>` text node
  (`Admin.tsx`). Every dynamic `href` is built on a fixed `https://` prefix
  (tx explorer, stellar.expert), and `flightradarUrl` uses
  `encodeURIComponent`; all `target="_blank"` anchors carry
  `rel="noopener noreferrer"`. No `javascript:` sink.
- **Admin gate is not security-by-obscurity:** the hidden `/admin` route is
  identity + display only; **all 7** `api/admin/*` handlers call
  `verifyAdmin()` before any side effect, and no privileged action succeeds
  on client checks alone (subject to FSA-M02). There is no hardcoded admin
  address list or client-side `isAdmin` flag; `useIsAdmin` is an on-chain
  read used only for display.
- **Transaction signing:** no blind signing — no `fromXDR`, no
  user/URL-supplied XDR, no free-form `TransactionBuilder` in `src/`. Every
  signed tx is assembled locally by a generated binding from typed args.
  Contract addresses are hardcoded constants (never from URL / localStorage /
  API), and the network passphrase is pinned at build time (subject to
  FSA-L01/L02).
- **Supabase client usage:** the browser never queries tables
  (`.from(` has zero hits in `src/`); the anon key is used only for Auth
  identity. All data flows through `api/admin/*` over a server-side pooler
  connection. No `service_role` key or `sb_secret_` key exists anywhere in
  client or server code.
- **Client-side trust:** no security decision reads from localStorage or URL
  params. localStorage holds only `walletId/walletAddress/walletNetwork/
  networkPassphrase` + theme (typed schema); the only URL param consumed
  (`?flight=`) is matched against the in-memory route list and deleted — no
  open redirect, no `navigate(param)`. No `window.postMessage` senders or
  `message` listeners.
- **Secret boundary in the bundle:** full-bundle grep of `dist/assets/*.js`
  for the DB password, AeroAPI key, Render key, `service_role`, and Stellar
  seed format found nothing sensitive — only the publishable anon key +
  Supabase URL (expected). No sourcemaps shipped. No `Keypair` / `fromSecret`
  usage in `src/`.
- **Dependencies:** healthy as of 2026-07 — `@stellar/stellar-sdk` 16.1.0,
  `@creit.tech/stellar-wallets-kit` 2.5.0 (pinned exact — good for wallet
  code), `@supabase/supabase-js` ^2.110.7, React 19.2, Vite ^7.3.1. No legacy
  crypto libs. Minor: the API-only `postgres` package sits in the frontend
  app's `dependencies`; moving API-only deps out shrinks the SPA build's
  supply-chain surface.

---

## Suggested Priority

`FSA-H01` (RLS gap on the four runtime-created tables) is the one finding
worth acting on immediately: it is a potential unauthenticated data-exposure
path reachable with the public anon key, it directly contradicts an invariant
the rest of the system relies on, and its live status can be confirmed or
ruled out with a single `curl`. `FSA-M01` (security headers) is the
highest-value hardening step and a small, low-risk config change — it should
ship with the same deploy. `FSA-M02` (admin email confirmation) closes a
config-dependent auth bypass in code rather than trusting a dashboard setting.
The Low findings (`FSA-L01`–`L04`) are defense-in-depth and can be batched.
