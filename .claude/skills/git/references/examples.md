# Git — Commit Message Examples

## Single-type examples

```
feat: add RiskVault deposit and share issuance logic

- implements deposit() with 1:1 shares on first deposit, proportional thereafter
- totalManagedAssets counter updated on deposit, not balanceOf
```

```
fix: floor decreaseLocked at zero instead of reverting

- prevents underflow if settlement called twice on same pool
- matches architecture spec behaviour
```

```
test: add withdrawal queue FIFO ordering tests

- covers queue drain order across 5 concurrent underwriters
- verifies queueHead never regresses after 20 settlement cycles
```

## Multi-type examples

```
feat, test: add OracleAggregator with swap-and-pop deregistration

- feat: status transitions Unknown→OnTime/Delayed/Cancelled, append-only
- feat: getActiveFlights() for CRE workflow to read each tick
- test: 37 tests covering status lifecycle, access control, deregistration
```

```
feat, test, docs: complete phase 3 — GovernanceModule

- feat: route approval, disable, term updates, admin whitelist
- test: 33 tests covering access control, route lifecycle, validation
- docs: phase-03 marked complete, progress.md updated to phase 4
```

```
docs, workflow: add phase tracking system and workflow documentation

- workflow: progress.md dashboard, per-phase files, /plan-phase /start-phase /complete-phase commands
- docs: workflow.md explaining full development loop
```
