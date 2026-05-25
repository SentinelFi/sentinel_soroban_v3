# Progress

> Phase dashboard for the Phase 3 contract improvements.
> Source of truth for subtasks: `spec/dev_steps.md`. Per-phase living docs: `spec/phases/phase-{NN}-{slug}.md` (created by `/plan-phase`).

**Current Phase:** Phase 12 complete (2026-05-25). Phase 11 still `in_progress` (user-side validation pending, per phase-bundling convention). Phase 13 (deploy / Acurast / frontend) ready to plan.

---

## Phase Files

| #  | Name                                                                  | Status   | Started | Completed |
|----|-----------------------------------------------------------------------|----------|---------|-----------|
| 1  | Delete `flight_pool/`                                                 | complete | 2026-05-02 | 2026-05-02 |
| 2  | Delete `recovery_pool/`                                               | complete | 2026-05-02 | 2026-05-02 |
| 3  | Add `flight_pool_manager/`                                            | complete | 2026-05-02 | 2026-05-02 |
| 4  | Governance routes — API redesign + events + TTL                       | complete | 2026-05-03 | 2026-05-03 |
| 5  | RiskVault `WithdrawalQueue` — Persistent → Instance                   | complete | 2026-05-03 | 2026-05-03 |
| 6  | Oracle `ActiveFlightList` — Persistent → Instance + prune             | complete | 2026-05-03 | 2026-05-03 |
| 7  | Controller — wire `FlightPoolManager` + `TravelerFlights`             | complete | 2026-05-03 | 2026-05-03 |
| 8  | RiskVault TTL — `ClaimableBalance` 60d + recovery, `SnapshotPrice` 30d temp | complete | 2026-05-03 | 2026-05-03 |
| 9  | Oracle `FlightData` — `ttl_miss` diagnostic event                     | complete | 2026-05-03 | 2026-05-03 |
| 10 | Integration tests — rewrite for new topology                          | complete | 2026-05-03 | 2026-05-03 |
| 11 | Buyer whitelist — admin-toggled gate on Controller                    | in_progress | 2026-05-23 | — |
| 12 | Executor (centralized cron) — port from phase-2                       | complete | 2026-05-25 | 2026-05-25 |

Status legend: `planned` → `in_progress` → `paused` (optional) → `complete`.

---

## Notes

- `mock_usdc/` is unchanged in this phase; no row.
- The workspace will not build green between Phases 1–2 and Phase 3 (controller / integration_tests still reference deleted crates). Land Phases 1–3 on a single branch, or reorder if needed — call this out in Pre-work Notes when planning Phase 1.
- Phases 8 and 9 are the TTL-grouped tail. They are intentionally last so the workspace reaches a clean storage-tier baseline before TTL tuning lands.
