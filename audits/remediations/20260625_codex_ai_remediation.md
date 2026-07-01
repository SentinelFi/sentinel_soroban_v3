# Codex AI Report (2026-06-25) — Remediation Summary

**Source report:** [`20260625_codex_ai_report.md`](../20260625_codex_ai_report.md)
**Remediation date:** 2026-07-01
**Scope:** 6 production contracts + `sentinel_types`, plus the two executor files
the report reviewed for exploitability
(`flight_data_fetcher.ts`, `aeroapi_client.ts`).
**Test status:** contract workspace suite green — **321 tests pass**
(`cd contracts && cargo test`); `cargo clippy --all-targets -- -D warnings`
clean; `cargo fmt --all --check` clean. The executor change is covered by a new
case in the `test_aeroapi.ts` mock-api harness (that harness is not part of the
Rust CI and was not run in this pass per request; the change is verified by
review).

Both findings in this report were previously identified against the same commit
by the Nemesis assessment. CAI-H01 is fixed (on-chain in the earlier pass, plus
the executor half here); CAI-H02 is an architectural deferral.

| ID | Severity | Verdict | Status |
|----|----------|---------|--------|
| CAI-H01 | High | Confirmed | ✅ Fixed (day-aligned identity + executor rejects ambiguous records) |
| CAI-H02 | High | Confirmed | 🟡 Deferred (architectural — settlement-epoch redesign) |

---

## Fixed

### CAI-H01 — Arbitrary timestamps create duplicate policies and payouts for one physical flight
**Confirmed (High).** `buy_insurance` accepted any `u64 date`, while the
executor resolves flights at calendar-day granularity. A caller could mint many
on-chain policies for one physical flight by varying the intraday timestamp, then
claim each independently against the same real outcome — draining the vault.

This has two halves, both now addressed:

**On-chain (identity) — fixed in the Nemesis pass (= NM-001),** see
[`20260625_nemesis_auditor_remediation.md`](20260625_nemesis_auditor_remediation.md).
`buy_insurance` now requires `date` to be **day-aligned** (a multiple of
`86_400` — midnight UTC), so the on-chain identity `(flight_id, date)` matches
the executor's day-level resolution. Combined with the per-traveler
single-policy guard in `add_buyer` and the governance `FlightRoute(flight_id)`
uniqueness index (one `(origin, dest)` per flight number), a physical flight maps
to exactly one `(flight_id, day)` and a traveler to at most one policy on it. The
duplication drain is closed. Covered by
`test_buy_insurance_panics_on_non_day_aligned_date`.

**Off-chain (executor) — fixed here.** The report also flagged that
`AeroApiClient.getFlightData` returned `flights[flights.length - 1]` — silently
taking the last record when AeroAPI returned several candidates for an ident on a
day, without matching the exact physical flight. `getFlightData` now **refuses to
guess**: if the response contains more than one candidate flight it logs a
warning and returns `null`, so the flight stays unresolved (and is retried /
surfaced for operator attention) rather than being settled against the wrong
physical flight. A single-candidate response is used as before; an empty response
still returns `null`.
*Files:* `executor/centralized_cron/src/aeroapi_client.ts`.
*Test:* new `DUP777` ambiguous scenario in `executor/mock-api/` (returns two
records for one ident/day) plus an assertion in `test_aeroapi.ts` that
`getFlightData` returns `null` for it.

**Documented residuals (recommended follow-ups, not drain vectors):**
- No canonical, oracle-attested flight-instance registry yet (carrier, exact
  scheduled departure, origin/destination, immutable provider id). Day-alignment
  plus the route-uniqueness index makes `(flight_id, day)` unambiguous for the
  common case; a full attested registry would additionally bind the exact
  physical flight and let the executor match origin/destination, not just the
  day.
- No expiry/refund path for a policy whose `(flight_id, day)` never receives
  oracle data — its collateral stays locked until manual owner action. This is a
  new contract feature (premium refund + collateral release after a deadline)
  and should be its own reviewed change.

---

## Deferred / architectural (with rationale)

### CAI-H02 — Public outcomes give LPs a free option before settlement — 🟡 Deferred
**= Nemesis NM-003.** Validated as real. Flight outcome publication
(oracle `Landed`/`Cancelled`), classification, and the vault's financial
settlement happen in separate, publicly observable transactions. An informed LP
can `redeem` at the pre-loss share price after an adverse outcome is visible but
before `execute_settlements` books the loss, shifting it onto passive LPs (and
the inverse — depositing after a favorable outcome is public but before premium
income is booked).

**Why deferred:** the only robust remedies are architectural — settlement-epoch
vault accounting (queue deposits/withdrawals and finalize against a
post-settlement price), immediate pending-loss reservation when the outcome is
first published, or a withdrawal cooldown longer than the maximum
oracle-to-settlement interval. Each is a significant redesign of vault entry/exit
timing and is entangled with the share-pricing accounting fix (NM-002 / Codex
"claimable liabilities" class), so the two should be designed and reviewed
together rather than bolted on independently. Tracked with full rationale in the
Nemesis remediation (NM-003).

---

## Files changed

Executor (4):
`executor/centralized_cron/src/{aeroapi_client,test_aeroapi}.ts`,
`executor/mock-api/src/server.ts`,
`executor/mock-api/scenarios.json`.

(The on-chain half of CAI-H01 was landed in the Nemesis pass — see
`controller/src/{constants,purchase,error}.rs` in
[`20260625_nemesis_auditor_remediation.md`](20260625_nemesis_auditor_remediation.md).)
