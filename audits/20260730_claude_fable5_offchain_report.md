# Claude Fable 5: Sentinel Off-Chain Findings Report

**Assessment date:** 30 July 2026

**Report version:** v1.0

**Assessment status:** Final

**Assessment type:** AI-Assisted Off-Chain Security Review

**Auditor:** Claude Fable 5

---

## Assessment Information

| | |
| --- | --- |
| Project | Sentinel Protocol |
| Component | Off-chain backend — `dapp/api/**` (Vercel serverless crons, governance backend, admin API) |
| Network | Stellar (Soroban testnet) |
| Language | TypeScript |
| Snapshot date | 2026-07-30 |

**Scope:** `dapp/api/**` — Vercel serverless cron jobs, the governance backend
(pause/revive ledger, exposure brake, on-chain submitter, admin API routes),
and their supporting client libraries (AeroAPI, weather, Soroban RPC,
Postgres). Frontend and on-chain contracts are out of scope.

**Explicitly out of scope:** centralized-admin/key-holder trust issues (the
oracle/keeper/ttl/gov-admin secret keys, and a human admin's ability to
override automated decisions, are an accepted design property of this
system and are not findings here).

---

## Findings Summary

| ID | Severity | Title |
| --- | --- | --- |
| OCA-H01 | High | Exposure-brake disable cap is not race-safe across concurrent runs |
| OCA-M01 | Medium | Exposure brake ignores liability on flights outside the static routes file |
| OCA-M02 | Medium | No rate limiting on the public, unauthenticated sale-auth endpoint |
| OCA-M03 | Medium | On-chain write precedes DB write with no reconciliation on partial failure |
| OCA-M04 | Medium | Unbounded AeroAPI retry/cooldown can exhaust function timeout mid-transaction |
| OCA-M05 | Medium | Raw internal error messages returned verbatim to callers (public + admin) |
| OCA-M06 | Medium | `/api/status/runs` leaks cron timing and live settlement-barrier state |
| OCA-M07 | Medium | `parseFlightStatus` fails open to the most permissive status on unknown shapes |
| OCA-M08 | Medium | Single malformed row silently aborts the entire TTL-extension pass |
| OCA-L01 | Low | Non-constant-time comparison of `CRON_SECRET` |
| OCA-L02 | Low | Cron auth falls back to trusting a bare header when `CRON_SECRET` is unset |
| OCA-L03 | Low | Fixed-point truncation bias in exposure concentration math |
| OCA-L04 | Low | Same-airport double counting if origin equals destination |
| OCA-L05 | Low | Silent, unrecoverable event-mirror data loss beyond RPC retention window |
| OCA-L06 | Low | AeroAPI client builds URLs without encoding; safety relies on caller discipline |
| OCA-L07 | Low | `flight_outcomes` upsert silently overwrites prior values on conflict |

### Severity Distribution

| High | Medium | Low |
| ---: | ---: | ---: |
| 1 | 8 | 7 |

---

## High

### OCA-H01 — Exposure-brake disable cap is not race-safe across concurrent runs
**File:** `dapp/api/_lib/governance/exposure_collector.ts:331-352`, cap defined in `dapp/api/_lib/governance/interventions.ts:84-86` (`computeDisableCap`)

The "storm can slow the fleet, only a human can stop it" safety cap
(`max(3, 20% of fleet)` new automated pauses per run) is enforced with a
local `let disables = 0` counter inside a single `run()` invocation — no
DB-backed atomic counter or advisory lock. `gov_exposure` is both
hourly-scheduled *and* `manualRunnable: true` from the admin job board.
Two overlapping invocations (a scheduled tick overlapping a manual "run
now" click, or a slow run overlapping the next tick) each independently
compute `cap = computeDisableCap(enabled.length)` and each allow up to
`cap` new disables — a single severe-exposure event could disable up to
2× the intended ceiling in one hour, silently defeating the one circuit
breaker designed to stop a mass fleet-disable. `pauseRoute`'s DB upsert
prevents duplicate *ledger rows* per (route, cause) but does nothing to
make the *cap itself* atomic across processes.

**Scenario:** an admin clicks "run now" on the gov_exposure tile while the
scheduled tick is also firing → both processes see the same
`enabled.length`, compute the same cap, and pause up to `cap` distinct
routes each → total disabled this hour exceeds the breaker's ceiling.

---

## Medium

### OCA-M01 — Exposure brake ignores liability on flights outside the static routes file
**File:** `dapp/api/_lib/governance/exposure_collector.ts:189-191`

```ts
const route = routeByFlight.get(flightId);
if (!route) continue; // unknown to the routes file — can't scope it
```

`totalManaged` (the denominator) is read correctly from live chain state,
but the liability numerator only sums flights present in
`config/routes.testnet.json`. Any active flight with real unsettled
liability that has since been removed from (or never added to) that
static file never contributes to any per-route/per-airport bucket, and
can therefore never trigger the ≥50% severe-pause threshold no matter how
large it grows — a fail-open gap in the vault's primary automated risk
control, with no log or alert surfacing it.

### OCA-M02 — No rate limiting on the public, unauthenticated sale-auth endpoint
**File:** `dapp/api/sale-auth/request.ts`, `dapp/api/_lib/sale_auth.ts`

Deliberately unauthenticated by design (the public buy-click gate), but
nothing throttles it. Each novel `(flight_id, date)` combination can
trigger a billed AeroAPI call plus an on-chain write (`open_sale` /
`set_cancelled`) signed by the oracle key, and a schedule-vanish or
cancellation can additionally fire the route-guard 5-day sweep (2 more
AeroAPI calls). Since the whitelisted fleet is public market data, an
attacker can walk the combinatorial flight × date space to force
repeated paid API calls and gas-costing chain transactions faster than
the system's own dedupe (live sale window / recorded outcome) can absorb
them.

### OCA-M03 — On-chain write precedes DB write with no reconciliation on partial failure
**File:** `dapp/api/admin/actions.ts:66-109`; general pattern in `GovSubmitter.submit` (`dapp/api/_lib/governance/submitter.ts:171-200`); related duplicate-submission risk in `dapp/api/_lib/soroban_client.ts:79-90` (badseq retry-once) and an overlapping-invocation race in `dapp/api/cron/settle.ts` (same keeper key/sequence)

For every admin op, the chain transaction is submitted and confirmed
first; only afterward does `setLifecycle()` update `routes.status` in
Postgres. If the on-chain call succeeds but the DB write throws (pool
exhaustion under the `max: 1` Supavisor config, transient blip), the
handler returns a bare 500 with no `tx_hash` in the body — the caller has
no way to know the on-chain state already changed, and a plausible retry
resubmits a real governance mutation (a second signed tx under the
gov-admin key, not a harmless no-op for ops like `remove`/`set_terms`).
The `invokeContract` badseq-retry-once logic makes an adjacent
assumption — that the earlier attempt never landed — which isn't
guaranteed either.

### OCA-M04 — Unbounded AeroAPI retry/cooldown can exhaust function timeout mid-transaction
**File:** `dapp/api/_lib/aeroapi_client.ts:78-83,264-339`, exercised from `dapp/api/_lib/jobs/fetcher.ts:110-263` and `dapp/api/_lib/jobs/revive.ts:100-135`

`requestJson` retries a 429 up to `MAX_RETRIES=3` with a 65s cooldown
each time — one flight's single call can block ~130-195s. The settle
sweep and the revive cron's cancellation batch (up to 20 rows) call this
sequentially per flight/route inside a loop with no per-run time budget.
During a real rate-limit burst, the first flight or two can consume most
of the function's `maxDuration`, risking a hard-kill mid-`invokeContract`
(a submitted tx whose result is never read/logged) while the rest of
that run's flights are silently never reached.

### OCA-M05 — Raw internal error messages returned verbatim to callers
**File:** `dapp/api/sale-auth/request.ts:56`, `dapp/api/status/stats.ts:72`, `dapp/api/status/runs.ts:72`, and consistently across `dapp/api/admin/*.ts` (`actions.ts:111`, `freeze.ts:57`, `jobs.ts:79`, `diagnostics.ts:107`, `interventions.ts:124`, `routes.ts:187`)

`err.message` / `String(err)` is returned in the JSON 500 body
throughout. On the two unauthenticated public surfaces
(`sale-auth/request`, `status/stats`, `status/runs`) this can leak raw
Soroban simulation strings, DB hostnames, and missing-env-var names to
anonymous callers during a transient DB/RPC outage — an infra
reconnaissance aid, not a secret leak. Present at lower severity across
all admin routes too (behind auth, but still crossing a trust boundary
into the browser network tab).

### OCA-M06 — `/api/status/runs` leaks cron timing and live settlement-barrier state
**File:** `dapp/api/status/runs.ts:18-47,57-70`

Intentionally public, but returns each job's `schedule` cron string
*and* `last_run_at`, making next-execution fully predictable, plus the
live settlement-barrier state (`engaged`, `since`, `age_secs`, `pending`,
`stalled`). Concrete scenario: watch `pending`/`engaged` to know exactly
when LP withdrawals are frozen, or time a purchase around the monthly
`reprice` job or the `weather` surcharge job to buy at a stale price
before it's corrected.

### OCA-M07 — `parseFlightStatus` fails open to the most permissive status on unknown shapes
**File:** `dapp/api/_lib/status.ts:21-37`

Any `raw` shape that doesn't match one of the four handled cases logs a
warning and defaults to `FlightStatus.NotInitiated` — the most
*permissive* value, not a fail-closed one. This gates money-relevant
logic directly: `sale_auth.ts:142-145` only refuses `open_sale` when
status is not `NotInitiated`/`Active`, and `jobs/fetcher.ts:117-121` only
skips flights that are not `NotInitiated`/`Active`. A mis-parsed
already-`Settled`/`Cancelled` flight (e.g. from a future SDK shape
change) would read as fresh at both call sites. No known trigger today —
the four handled shapes appear to cover current SDK behavior — but it's
inconsistent with the codebase's otherwise fail-closed posture on
financial state.

### OCA-M08 — Single malformed row silently aborts the entire TTL-extension pass
**File:** `dapp/api/_lib/jobs/ttl.ts:110-155`

`extendIdlePersistentKeys` builds `travelerKeys` via
`buyers.map(b => client.addressToScVal(b.buyer))` outside any per-item
try/catch; one corrupted/empty `buyer` value from
`select distinct buyer from policies` throws synchronously, caught only
by the function-wide try whose catch just logs a warning and returns.
This silently skips TTL extension for *every* route and buyer that run —
not just the bad row — and the failure isn't folded into the job's
`success`/`results` reporting, so an operator could believe TTL
maintenance is healthy while persistent entries drift toward the
~120-day extension target, eventually requiring a costly
`RestoreFootprintOp`.

---

## Low

### OCA-L01 — Non-constant-time comparison of `CRON_SECRET`
**File:** `dapp/api/_lib/handler.ts:18-24`

`req.headers.authorization === \`Bearer ${secret}\`` is a plain `===`
compare. This secret gates every keeper/oracle/gov-admin-signed
transaction in the system; a timing side-channel is a legitimate (if
hard to exploit remotely, given network jitter) hardening gap versus a
constant-time compare (e.g. `crypto.timingSafeEqual`).

### OCA-L02 — Cron auth falls back to trusting a bare header when `CRON_SECRET` is unset
**File:** `dapp/api/_lib/handler.ts:14-24`

Without `CRON_SECRET` configured, auth rests entirely on the platform
stripping the `x-vercel-cron` header from external requests — a single
point of failure on Vercel's guarantee holding across every deployment
context (including preview/local). Recommend always setting
`CRON_SECRET`, in every environment.

### OCA-L03 — Fixed-point truncation bias in exposure concentration math
**File:** `dapp/api/_lib/governance/exposure_collector.ts:99-100`

`Number((units * 1_000_000n) / totalManagedUnits) / 1_000_000` truncates
toward zero (~1e-6 granularity, consistent downward bias). At worst a
fraction within ~0.0001% of the 25%/50% threshold could land just under
instead of at/above it. Negligible in practice, not realistically
exploitable, but the rounding direction consistently favors *not*
pausing.

### OCA-L04 — Same-airport double counting if origin equals destination
**File:** `dapp/api/_lib/governance/exposure_collector.ts:96-97`

`airports.set(f.origin, ...)` and `airports.set(f.dest, ...)` both run
unconditionally; a flight whose origin equals its destination (bad data
/ future route type) would have its liability counted twice for that
airport. Not reachable with current route data; no guard exists.

### OCA-L05 — Silent, unrecoverable event-mirror data loss beyond RPC retention window
**File:** `dapp/api/_lib/governance/event_ingest.ts:26,57-58`

`RETENTION_LEDGERS = 118_000` (~6.8 days) bounds how far back
`fromLedger` can start. If the hourly ingest is down longer than that,
events beyond RPC's retention window are permanently skipped with only a
`console.log` on the next successful run — no error/alert. Only affects
the `policies`/`settlements` analytics mirror; live exposure decisions
read on-chain state directly and are unaffected.

### OCA-L06 — AeroAPI client builds URLs without encoding; safety relies on caller discipline
**File:** `dapp/api/_lib/aeroapi_client.ts:128,162,225`

`getFlightData`, `getFlightInstances`, and `getSchedules` concatenate
`ident`/date strings into request URLs with no `encodeURIComponent` and
no validation inside the client itself. Not currently exploitable — the
only externally-reachable path (`sale-auth/request.ts:37`) validates
`flight_id` against `/^[A-Z0-9]{2,10}$/` before it reaches this client,
and dates are always derived from `Date` objects. However, other callers
(`route_guard.ts`, `jobs/fetcher.ts`, and admin routes with unchecked
`flight_id`/`origin`/`dest` body fields such as `admin/interventions.ts`)
reach this client with unvalidated input; a future wiring change could
enable query/path injection into AeroAPI requests. Recommend validating
inside the client rather than relying solely on upstream callers.

### OCA-L07 — `flight_outcomes` upsert silently overwrites prior values on conflict
**File:** `dapp/api/_lib/outcome_log.ts:105-107`

`on conflict ... do update set outcome = excluded.outcome, delay_minutes
= excluded.delay_minutes` silently overwrites a previously logged
outcome if `logFlightOutcome` is called twice with different values
(e.g. a retry racing a correction). Analytics-only table, not consulted
for settlement — no fund-safety impact, just potential silent data drift
in the ML training log.

---

## Areas Checked, No Issues Found

- **SQL injection:** every DB call across all reviewed files uses the
  `postgres` package's parameterized tagged-template `sql`, including
  dynamic `on conflict` / `json` calls. No string-built queries or
  `sql.unsafe` found anywhere.
- **Secret handling:** no API keys or secret keys found leaked in any log
  line, URL, or error string. The AeroAPI key is sent via the `x-apikey`
  header only. `loadPublicConfig()` reports key *presence* as booleans
  only.
- **Money math:** all premium/payoff arithmetic in `route_rules.ts` stays
  in bigint/basis-points space with explicit rail clamping; the one
  float input (`p_covered` from the ML pricing service) is pre-validated
  finite/0–1 before use.
- **Unbounded loops:** all API pagination and prune/drain loops are
  explicitly capped (`MAX_CURSOR_FOLLOWS`, `MAX_DRAIN_PASSES`,
  `CANCELLATION_BATCH`, etc.).
- **Dynamic code execution:** no `eval`, dynamic `require`, or unsafe
  deserialization anywhere in the reviewed surface.
- **Auth ordering:** every admin route calls `verifyAdmin()` before any
  DB/RPC side effect; no route with a missing or reorderable auth check
  was found.

---

## Suggested Priority

`OCA-H01` (race-safe disable cap) and `OCA-M02` (rate limiting on
sale-auth) are the two most worth fixing first — both are live gaps in a
system already running with real signing keys and real vault funds.
`OCA-M03`/duplicate-submission risk and `OCA-M01` (exposure blind spot)
are next: both can silently produce wrong on-chain/DB state with no
alerting today.
