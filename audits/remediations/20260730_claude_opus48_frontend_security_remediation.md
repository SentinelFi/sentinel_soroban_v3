# Claude Opus 4.8 Frontend Security Audit (2026-07-30) — Remediation Summary

**Source report:** [`20260730_claude_opus48_frontend_security_report.md`](../20260730_claude_opus48_frontend_security_report.md)
**Audited commit:** `be01be5` (main, post-PR #93 merge)
**Remediation date:** 2026-07-30 (branch `frontend_audit_fixes`, merged to main via PR #94 `839bf4c`)
**Test status:** `tsc -b --noEmit` clean; production `vite build` green;
governance e2e `26/26` and admin-governance e2e `25/25` green against the
live governance DB; `resolveAdminEmail` unit matrix `8/8`; `isAuthorized`
unit matrix `9/9`; live HTTP auth check through the real handler; and the
RLS fix proven end-to-end against the live Supabase DB (anon read+insert
denied after fix, owner unaffected, migration idempotent across two runs).

**Headline result:** both High-severity issues closed — a **live
unauthenticated read+write data-exposure** (four governance tables world
read/write through the public anon key) and the **cron-auth fail-open**
(unauthenticated triggering of transaction-signing crons). Both Mediums
and both actionable Lows fixed; the remaining Lows/Infos are triaged as
non-production or ops-only with rationale.

| ID | Severity | Verdict | Status |
|----|----------|---------|--------|
| FSA-H01 | High | Confirmed (exploit reproduced live) | ✅ Fixed — RLS enabled at self-create + hardening migration; proven on live DB |
| OCA-L02† | High‡ | Confirmed | ✅ Fixed — `CRON_SECRET` required, handler fails closed; `x-vercel-cron` fallback removed |
| FSA-M01 | Medium | Confirmed | ✅ Fixed (clickjacking scope) — security headers on both Vercel configs; full CSP deferred |
| FSA-M02 | Medium | Confirmed | ✅ Fixed — `verifyAdmin` requires `email_confirmed_at`; gate unit-tested |
| FSA-L01 | Low | Confirmed | ✅ Fixed — non-blocking wallet↔app network-mismatch banner |
| FSA-L02 | Low | Confirmed | ✅ Fixed — `allowHttp` gated to `LOCAL`; TESTNET bundle builds `allowHttp:false` |
| FSA-L03 | Low | Confirmed, not exploitable | 📝 No code change — same-origin, display-only |
| FSA-L04 | Low | Confirmed | 📝 Ops action — rotate keys if `.env` was shared; not deployed-code |
| FSA-I01 | Info | Mitigated | 📝 No action — no XSS sink + server allowlist; accepted |
| FSA-I02 | Info | Confirmed | 📝 Ops verify — Supabase rate limits + redirect allowlist |

† Cross-referenced from the same-day off-chain report; fixed on this branch.
‡ Off-chain report rated it OCA-L02 (Low, on the Vercel-strips-the-header
assumption); the API-security audit rated it High-conditional. Fixed to
remove the assumption entirely.

---

## Fixed

### FSA-H01 — Four self-created tables never enabled RLS (world read/write via the anon key)

`interventions`, `flight_schedules`, `flight_outcomes`, and `pricing_runs`
self-create from application code on first write (a deliberate design,
documented in `20260801120000_drop_retired_governance_tables.sql`) and so
never passed through a migration that enables RLS. New Postgres tables
default to RLS-disabled, and Supabase grants the `anon`/`authenticated`
roles full privileges on the `public` schema — so through the PostgREST
Data API, with only the public publishable key, these tables were world
**read and write**.

**Reproduced live** before fixing: connecting as the `postgres` role, a
canary row inserted into `interventions` was readable under `set role
anon`, and an `anon` INSERT succeeded. Empty tables were the only reason
nothing had leaked yet.

Fix, respecting the self-create design:
- **App code** — each `create table if not exists` is now immediately
  followed by `alter table … enable row level security`, so a
  freshly-provisioned dev/prod DB is born deny-all with no exposure window
  (the table never exists without RLS). The owning `postgres` role
  bypasses RLS, so server-side access is unaffected — proven by the fact
  the other eight RLS-enabled tables already work.
- **Migration `20260801130000_enable_rls_selfcreated_tables.sql`** — a
  conditional `do` block that enables RLS in place on any DB where the
  tables already exist; no schema duplication (no drift), and a no-op on a
  fresh DB. Applied to the live DB and idempotent across two runs.

**Proven after fix:** `anon` read returns 0 rows and `anon` INSERT is
denied; owner still reads and writes (RLS bypass); all four tables report
`rls = t` via the real TypeScript paths (`ensureTable`,
`ensureOutcomesTable`, `logPricingRun`, `saveFlightSchedule`).

*Files:* `dapp/api/_lib/governance/interventions.ts`,
`dapp/api/_lib/outcome_log.ts`, `dapp/api/_lib/flight_schedules.ts`,
`dapp/api/_lib/governance/pricing_log.ts`,
`supabase/migrations/20260801130000_enable_rls_selfcreated_tables.sql`.
*Commit:* `7f6d130`.

### OCA-L02 — Cron auth fell open when `CRON_SECRET` was unset

`isAuthorized()` accepted any request carrying an `x-vercel-cron` header
when `CRON_SECRET` was unset. The `/api/cron/*` endpoints are publicly
deployed (`vercel.backend.json` schedules ten) and sign real
keeper/oracle/gov-admin transactions, so the whole boundary rested on
Vercel stripping a spoofed inbound header — not a documented guarantee,
and weaker on preview deployments and the frontend project that also
deploys these functions.

Now `CRON_SECRET` is **required**: unset → every request 401s (fail
closed); set → caller must present `Authorization: Bearer <CRON_SECRET>`,
which Vercel's scheduler injects automatically. The `x-vercel-cron`
fallback is removed (`cronTrigger` still reads it, but only to *label* a
run's origin — never to authorize).

**Production-safe:** current crons run as local bots
(`scripts/run_bot.ts`) that call each job's `run()` directly and never
pass through this check, so they are unaffected. Deploy requirement: set
`CRON_SECRET` in the Vercel project before enabling scheduled crons
(documented in `.env.example`).

**Tested:** unit matrix `9/9` (including unset-secret + spoofed header →
deny, and header-only → deny); live `dev:api` HTTP — no-auth / spoofed /
wrong-bearer all `401`, correct bearer passes auth (dry-run, nothing
submitted).

*Files:* `dapp/api/_lib/handler.ts`, `dapp/.env.example`.
*Commit:* `b982d7d`.

### FSA-M01 — No HTTP security headers (clickjacking)

A `headers` block was added to `dapp/vercel.json` and
`dapp/vercel.backend.json`: `Content-Security-Policy: frame-ancestors
'none'`, `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff`,
`Referrer-Policy: strict-origin-when-cross-origin`, and a conservative
`Strict-Transport-Security` (`max-age=63072000`, no `includeSubDomains`,
no preload). The `frame-ancestors`/`X-Frame-Options` pair fully addresses
the clickjacking finding without restricting anything the app loads.

**Scope decision:** a full `script-src`/`connect-src` CSP is deliberately
**deferred**. Its allowed origins (RPC, Horizon, Supabase) are
env-specific and differ between the testnet deployment and a future prod
project, and `vercel.json` headers are static and can't be validated
without a staging deploy — shipping a blind CSP would risk breaking
production (a fetch/connect the policy forgot to allow). Follow-up:
validate a full enforcing CSP on a preview deploy before tightening.

*Files:* `dapp/vercel.json`, `dapp/vercel.backend.json`.
*Commit:* `ff47fa3`.

### FSA-M02 — Admin auth trusted the email string without confirmation

`verifyAdmin` now requires `data.user.email_confirmed_at` before
consulting the `ADMIN_EMAILS` allowlist, closing a config-dependent bypass
(if the Supabase project ever allowed an unverified-email sign-in method,
an attacker could register an allowlisted address and pass). The decision
was extracted into a pure `resolveAdminEmail(user, adminEmailsCsv)` so it
is unit-testable without a live Supabase call.

**Non-breaking:** magic-link and OAuth — the flows in use — both set
`email_confirmed_at`, so no current admin is affected. Unit matrix `8/8`
(confirmed+allowlisted allow; unconfirmed → reject; not-allowlisted →
reject; case-insensitive; empty/undefined allowlist → reject).

*Files:* `dapp/api/_lib/governance/admin_auth.ts`.
*Commit:* `ff47fa3`.

### FSA-L01 — No wallet↔app network-mismatch guard

`WalletProvider` now exposes a `networkMismatch` flag (wallet's reported
passphrase vs the app's build-time `PUBLIC_STELLAR_NETWORK_PASSPHRASE`),
and `App` renders a non-blocking warning banner when it trips. The flag is
`true` **only** when the wallet's network is positively known to differ
(an empty/unknown passphrase — as non-Freighter wallets may leave it —
never trips it), so it raises no false alarms, and signing is never
hard-blocked, so a bad comparison can't lock a user out of a working app.

On the current testnet deployment this is UX confusion, not fund risk (a
mismatched wallet still signs a testnet-passphrase tx); the guard matters
most on a future mainnet deploy. Banner text confirmed present in the
production bundle.

*Files:* `dapp/src/providers/WalletProvider.tsx`, `dapp/src/App.tsx`.
*Commit:* `ff47fa3`.

### FSA-L02 — `allowHttp: true` hardcoded in all six contract clients

Changed to `allowHttp: stellarNetwork === "LOCAL"` across all six clients,
so a production https RPC keeps `allowHttp` false and a MITM cannot
downgrade to cleartext and feed forged simulation results into what the
wallet signs. Inert-but-durable: these are hand-maintained wrappers (not
regenerated by `rebuild-bindings.sh`, which only touches `packages/`).
Verified the TESTNET production build folds the six clients to
`allowHttp:false` in the bundle.

*Files:* `dapp/src/contracts/{controller,risk_vault,governance_module,
oracle_aggregator,mock_usdc,flight_pool_manager}.ts`.
*Commit:* `ff47fa3`.

---

## No code change (triaged)

### FSA-L03 — Non-Freighter wallet identity trusted from localStorage

Confirmed but **not a production security issue**: localStorage is
same-origin, and a poisoned address is display-only — it cannot move funds
because the wallet still auth-signs as the real key (a mismatched `caller`
just fails the contract's `require_auth`). Left unchanged to avoid
destabilizing the wallet reconnect flow for no security gain.

### FSA-L04 — Live secrets in the local `.env`

Not a deployed-code issue: the DB/AeroAPI/Render secrets live only in the
untracked local `.env`, and were verified absent from git history and the
built bundle. Remediation is an **operator action** — rotate the keys if
that file was ever shared — which cannot be done in code. Recommend moving
account-level keys out of the project `.env`.

### FSA-I01 — Admin session JWT persists in localStorage

Exploitable only via an XSS sink, and the audit found none; the
server-side `ADMIN_EMAILS` re-check backs it. `persistSession: false`
would regress admin-console UX (re-auth every load) for negligible gain.
Accepted.

### FSA-I02 — `.env.example` commits the real Supabase URL + anon key

The anon key is public-by-design (already inlined in the client bundle),
so committing it changes nothing about exposure. The residual risk is
OTP-spam / enumeration via the public Auth endpoints; the remediation is
an **ops verification** — confirm Supabase Auth rate limits and a
non-wildcard redirect-URL allowlist (`signInWithOtp` passes
`emailRedirectTo: window.location.href`).

---

## Operator follow-ups (outside code)

1. **Set `CRON_SECRET`** in the Vercel project(s) before enabling the
   scheduled crons — the handler now fails closed without it.
2. **Rotate** the DB / AeroAPI / Render keys if the local `.env` was ever
   shared (FSA-L04).
3. **Verify** Supabase Auth rate limits + redirect-URL allowlist (FSA-I02).
4. **Validate a full enforcing CSP** on a preview deploy, then tighten
   `script-src`/`connect-src` beyond the shipped `frame-ancestors`
   (FSA-M01).
5. Confirm the two currently-existing tables on the live DB (`interventions`,
   `flight_outcomes`) show `rls = t` — done during remediation; re-check
   after any manual DB rebuild.
