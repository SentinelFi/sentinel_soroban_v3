# Progress

> Phase dashboard for the Phase 3 contract improvements.
> Source of truth for subtasks: `spec/dev_steps.md`. Per-phase living docs: `spec/phases/phase-{NN}-{slug}.md` (created by `/plan-phase`).

**Current Phase:** — (none in_progress; next up: Phase 1)

---

## Phase Files

| #  | Name                                                              | Status       | Started | Completed |
|----|-------------------------------------------------------------------|--------------|---------|-----------|
| 1  | Delete `flight_pool/`                                             | planned      | —       | —         |
| 2  | Delete `recovery_pool/`                                           | planned      | —       | —         |
| 3  | Add `flight_pool_manager/`                                        | planned      | —       | —         |
| 4  | Governance routes — Persistent → Instance                         | planned      | —       | —         |
| 5  | RiskVault `WithdrawalQueue` — Persistent → Instance               | planned      | —       | —         |
| 6  | RiskVault `ClaimableBalance` — 60-day TTL + `recover_uncollected` | planned      | —       | —         |
| 7  | RiskVault `SnapshotPrice` — Persistent → Temporary                | planned      | —       | —         |
| 8  | Oracle `ActiveFlightList` prune + `ttl_miss` event                | planned      | —       | —         |
| 9  | Controller — wire `FlightPoolManager` + `TravelerFlights`         | planned      | —       | —         |
| 10 | Integration tests — rewrite for new topology                      | planned      | —       | —         |

Status legend: `planned` → `in_progress` → `paused` (optional) → `complete`.

---

## Notes

- `mock_usdc/` is unchanged in this phase; no row.
- The workspace will not build green between Phases 1–2 and Phase 3 (controller / integration_tests still reference deleted crates). Land Phases 1–3 on a single branch, or reorder if needed — call this out in Pre-work Notes when planning Phase 1.
