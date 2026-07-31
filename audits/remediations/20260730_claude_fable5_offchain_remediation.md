# Claude Fable 5 Off-Chain Report (2026-07-30) — Remediation Summary

**Source report:** [`20260730_claude_fable5_offchain_report.md`](../20260730_claude_fable5_offchain_report.md)
**Audited commit:** `839bf4c` (main, snapshot 2026-07-30)
**Remediation branch:** `offchain_audit_fixes` (one commit per finding)
**Remediation date:** 2026-07-30
**Test status:** all three mock e2e suites green after every fix —
**oracle 66/66, interventions 30/30 (+4 new OCA-H01 checks),
admin/gov 28/28 (+3 new OCA-M02 checks)** (`npm run test:e2e`,
`test:e2e:gov`, `test:e2e:admin` from `dapp/`); `tsc -b --noEmit` clean.

15 of 16 findings remediated in code (14 new fixes on this branch;
OCA-L02 was already fixed on main before this pass). One finding
(OCA-M06) is part-fixed / part-accepted-by-design, detailed below. No
fix required an architecture change; nothing was deferred.

| ID | Severity | Status |
|----|----------|--------|
| OCA-H01 | High | ✅ Fixed — atomic DB-backed hourly disable-slot budget (`0f1e58c`) |
| OCA-M01 | Medium | ✅ Fixed — unscoped liability surfaced as jobs-board error (`892256d`) |
| OCA-M02 | Medium | ✅ Fixed — 10 req/min/IP rate limit on sale-auth (`8c1903e`) |
| OCA-M03 | Medium | ✅ Fixed — tx_hash + do-not-resubmit warning on partial failure (`3d9edbb`) |
| OCA-M04 | Medium | ✅ Fixed — wall-clock deadlines on retries + sweep loops (`e72f38d`) |
| OCA-M05 | Medium | ✅ Fixed — opaque 500 bodies on the three public endpoints (`45a354c`) |
| OCA-M06 | Medium | ✅/📝 Part fixed — barrier coarsened to booleans; schedules public by design (`9cc9a62`) |
| OCA-M07 | Medium | ✅ Fixed — fail-closed `Unknown` parse sentinel (`221c0cb`) |
| OCA-M08 | Medium | ✅ Fixed — per-row isolation + surfaced failure in TTL pass (`ad34f37`) |
| OCA-L01 | Low | ✅ Fixed — `crypto.timingSafeEqual` (`a753052`) |
| OCA-L02 | Low | ✅ Already fixed on main pre-report (`b982d7d`) |
| OCA-L03 | Low | ✅ Fixed — ceiling division in exposure fractions (`c671cb5`) |
| OCA-L04 | Low | ✅ Fixed — origin==dest double-count guard (`3657b17`) |
| OCA-L05 | Low | ✅ Fixed — retention gap surfaced as PERMANENT MIRROR GAP error (`c128659`) |
| OCA-L06 | Low | ✅ Fixed — validation + URL-encoding inside AeroApiClient (`e2a9c95`) |
| OCA-L07 | Low | ✅ Fixed — first-write-wins outcome log (`150a0c0`) |

---

## High

### OCA-H01 — Exposure-brake disable cap is not race-safe across concurrent runs

**Fixed.** New automated disables in `gov_exposure` now claim a slot from
a shared hourly-window counter (`gov_disable_slots`, deny-all RLS) via an
atomic conditional upsert (`on conflict … do update … where count < cap
returning count`) — a single atomic statement, so it is correct over the
Supavisor transaction-mode pooler where session advisory locks are not.
Overlapping runs (scheduled tick vs admin "run now") draw from the same
budget; a refused claim logs the existing circuit-breaker flag line.
Slots whose pause did **not** end in an on-chain disable (idempotent
re-pause of an already-off route, or a thrown pause) are released, so a
persistent severe condition never starves the budget with no-ops. The
local per-run counter is retained as the no-DB fallback, matching the
ledger's DB-optional posture. Covered by 4 new checks in
`test_interventions_e2e.ts` (claims to cap, refusal past cap, cross-run
refusal, release/re-claim).

*Files:* `dapp/api/_lib/governance/interventions.ts`
(`claimDisableSlot`/`releaseDisableSlot`),
`dapp/api/_lib/governance/exposure_collector.ts` (claim/release around
`pauseRoute`), `dapp/tests/e2e_mock/test_interventions_e2e.ts`.

## Medium

### OCA-M01 — Exposure brake ignores liability on flights outside the static routes file

**Fixed (surfaced — the blind spot can no longer be silent).**
`readExposure` now reads every active flight's config (not just those in
the routes file), accumulates the liability it cannot scope to a
route/airport bucket, and returns `unknownLiabilityUnits` +
`unknownFlights`. `gov_exposure` logs a `BLIND SPOT` warning with the
percentage of vault capacity involved and pushes an **error** action onto
the admin jobs board. The liability still cannot be auto-paused — there
is no route entry to pause — which is precisely why it is escalated to a
human instead of dropped.

*Files:* `dapp/api/_lib/governance/exposure_collector.ts`.

### OCA-M02 — No rate limiting on the public sale-auth endpoint

**Fixed.** `/api/sale-auth/request` now enforces a fixed one-minute
window of 10 requests per IP (generous for a human buyer; starving for a
flight × date space walk). Two layers: a DB-backed atomic counter
(`api_rate_limits`, same pooler-safe conditional-upsert pattern as
OCA-H01, hourly-pruned, deny-all RLS) that holds across serverless
instances, plus an in-memory per-instance fallback so the endpoint stays
DB-optional. Deliberately fail-open on DB errors — a DB blip must not
close the public storefront. 429 + `Retry-After: 60` on refusal. Covered
by 3 new checks in `test_admin_gov_e2e.ts` (limit enforcement, per-caller
isolation, no-DB fallback).

*Files:* `dapp/api/_lib/rate_limit.ts` (new),
`dapp/api/sale-auth/request.ts`,
`dapp/tests/e2e_mock/test_admin_gov_e2e.ts`.

### OCA-M03 — On-chain write precedes DB write with no reconciliation on partial failure

**Fixed (the dangerous symptom — blind retry of a signed governance tx —
is closed).** In `admin/actions.ts` the `routes.status` mirror write is
now isolated: on failure the response is still 200 with the confirmed
`tx_hash`, `before`/`after` snapshots, and an explicit warning
("Do NOT resubmit the op — fix the DB status instead"), plus a
server-side error log. `GovSubmitter.submit` was re-audited and needed no
change: its post-chain writes were already best-effort (`safeLog`
swallows audit-log failures; the after-snapshot is try/caught). Full
two-phase reconciliation (outbox/journal) was considered and rejected as
an architecture change disproportionate to a single-admin testnet
surface; the badseq-retry-once note in `soroban_client.ts` is accepted
as-is for the same reason.

*Files:* `dapp/api/admin/actions.ts`.

### OCA-M04 — Unbounded AeroAPI retry/cooldown can exhaust function timeout mid-transaction

**Fixed.** `AeroApiClient` gains `setDeadline(epochMs)`: any retry sleep
(429's 65 s cooldown, 5xx/network backoff) that would cross the deadline
gives up cleanly — returns null (every caller already fails safe on
null) and does **not** trip the permanent quota breaker, since a
deadline-abandoned 429 is not evidence of billing-period exhaustion.
Consumers set budgets: the settle sweep and revive's cancellation batch
stop starting new flights at 240 s (maxDuration 300) and log each
unreached flight as "run time budget exhausted — deferred", so skipped
work is visible instead of silent; sale-auth caps API time at 45 s
(maxDuration 60 — previously a single cooldown could exceed the whole
function budget). A platform hard-kill mid-`invokeContract` is no longer
reachable via stacked cooldowns.

*Files:* `dapp/api/_lib/aeroapi_client.ts`,
`dapp/api/_lib/jobs/fetcher.ts`, `dapp/api/_lib/jobs/revive.ts`,
`dapp/api/_lib/sale_auth.ts`.

### OCA-M05 — Raw internal error messages returned verbatim to callers

**Fixed on every public surface.** New `publicError()` helper logs the
full error (with stack) server-side and returns an opaque message;
applied to the three unauthenticated endpoints (`sale-auth/request`,
`status/stats`, `status/runs`). Admin routes deliberately keep verbatim
errors: they sit behind `verifyAdmin()`, and the detail is what makes the
ops board debuggable for the (single, trusted) admin — recorded here as
an accepted team decision, not an oversight.

*Files:* `dapp/api/_lib/public_error.ts` (new),
`dapp/api/sale-auth/request.ts`, `dapp/api/status/stats.ts`,
`dapp/api/status/runs.ts`.

### OCA-M06 — `/api/status/runs` leaks cron timing and live settlement-barrier state

**Part fixed, part accepted by design.** The settlement-barrier gauge is
coarsened to two booleans — `engaged` (LP flows frozen; observable
on-chain anyway) and `stalled` (the ops alert condition) — with
`since`/`age_secs`/`pending` no longer echoed; they are still read
internally to compute `stalled`, and the precise values remain available
behind admin auth. The purchase-timing scenario (buying at a stale price
just before `reprice`/`weather` runs) is closed to the extent the feed
enabled it. **Accepted:** job `schedule` cron strings and `last_run_at`
stay in the feed — the repo is open source (`vercel.json` and
`runs.ts`'s registry publish the same schedules) and the public `/status`
page renders the schedule column as a product feature, so removing them
from the API would break the page while hiding nothing.

*Files:* `dapp/api/status/runs.ts`.

### OCA-M07 — `parseFlightStatus` fails open to the most permissive status on unknown shapes

**Fixed.** Unrecognized shapes and out-of-range enum indexes now return
`FlightStatus.Unknown` — a client-side-only sentinel (documented as never
sent on-chain) instead of `NotInitiated`. Unknown fails closed at every
money gate: sale-auth refuses the sale, the settle sweep skips the
flight, TTL's `Settled*` prefix check misses. One deliberate inversion:
`readExposure` **counts** Unknown-status flights as live liability,
because for the risk brake the conservative direction is assuming the
liability exists, not that it is gone. String inputs still pass through
unvalidated by design — the parser is also used on the pool's
`SettlementStatus` enum (`SettledDelayed`/`SettledCancelled`), whose
variants are not in `STATUS_BY_INDEX`.

*Files:* `dapp/api/_lib/status.ts`, `dapp/api/_lib/types.ts`,
`dapp/api/_lib/governance/exposure_collector.ts`.

### OCA-M08 — Single malformed row silently aborts the entire TTL-extension pass

**Fixed.** ScVal key construction in `extendIdlePersistentKeys` is now
per-row try/caught: a corrupted route or buyer value skips that row with
a warning and a `success: false` results entry, while every healthy key
is still extended. A whole-pass failure (DB unreachable) is also folded
into `results`, and since the job computes `success` as
`results.every(r => r.success)`, TTL-maintenance ill-health now shows as
a failed run on the ops board instead of a green tick over a silent skip.

*Files:* `dapp/api/_lib/jobs/ttl.ts`.

## Low

### OCA-L01 — Non-constant-time comparison of `CRON_SECRET`

**Fixed.** `isAuthorized` compares the presented `Authorization` header
against the expected value with `crypto.timingSafeEqual` behind a length
guard (length is the only remaining signal, which is standard and
acceptable).

*Files:* `dapp/api/_lib/handler.ts`.

### OCA-L02 — Cron auth falls back to trusting a bare header when `CRON_SECRET` is unset

**Already fixed before this report was filed** — commit `b982d7d`
("require CRON_SECRET for cron endpoints, fail closed") is on `main`:
with no `CRON_SECRET` configured every request is rejected, and
`x-vercel-cron` is used only to label a run's trigger, never to
authorize. No further change needed; the report was generated against
the fixed code and the finding text matches the previous behaviour.

*Files:* `dapp/api/_lib/handler.ts` (pre-existing fix).

### OCA-L03 — Fixed-point truncation bias in exposure concentration math

**Fixed.** The fraction now uses ceiling division
(`(units·10⁶ + TMA − 1) / TMA`), so the ~1e-6 rounding step biases
toward crossing the elevated/severe thresholds — for a risk brake, ties
round toward action, not inaction.

*Files:* `dapp/api/_lib/governance/exposure_collector.ts`.

### OCA-L04 — Same-airport double counting if origin equals destination

**Fixed.** The destination-side aggregation is guarded with
`f.dest !== f.origin`; a same-airport flight's liability now counts once
for that airport. Not reachable with current route data — closed as
future-proofing, as the report suggested.

*Files:* `dapp/api/_lib/governance/exposure_collector.ts`.

### OCA-L05 — Silent, unrecoverable event-mirror data loss beyond RPC retention window

**Fixed (surfaced).** `ingestChainEvents` computes `gapLedgers` — the
span between the stored cursor and the retention floor — and when
non-zero logs a `PERMANENT MIRROR GAP` **error** naming the lost ledger
range; `gov_exposure` additionally pushes the gap onto the admin jobs
board as an error action. The loss itself is inherent to RPC retention
(only a >6.8-day total outage triggers it) and live exposure decisions
read chain state directly, so surfacing — not prevention — is the
correct remediation tier.

*Files:* `dapp/api/_lib/governance/event_ingest.ts`,
`dapp/api/_lib/governance/exposure_collector.ts`.

### OCA-L06 — AeroAPI client builds URLs without encoding

**Fixed.** Validation and encoding now live inside the client, as the
report recommended: idents are regex-checked (`/^[A-Z0-9]{2,10}$/i`),
date arguments are checked against `YYYY-MM-DD` (or `Date.parse` for ISO
bounds), and all path/query segments are URL-encoded. Bad input returns
null with a warning — the same fail-soft contract as every other client
error — so no caller behavior changes, and future wiring changes
(admin-supplied `flight_id`/`origin`/`dest`) can no longer reach AeroAPI
as raw URL fragments.

*Files:* `dapp/api/_lib/aeroapi_client.ts`.

### OCA-L07 — `flight_outcomes` upsert silently overwrites prior values on conflict

**Fixed.** The upsert is now `on conflict … do nothing` (first write
wins — the on-chain outcome is forward-only and written once, so the
first row is the settled truth). A re-log with identical values is a
silent idempotent no-op; a **divergent** re-log keeps the stored row and
logs a warning showing both values, so drift in the ML training log is
visible instead of silent.

*Files:* `dapp/api/_lib/outcome_log.ts`.
