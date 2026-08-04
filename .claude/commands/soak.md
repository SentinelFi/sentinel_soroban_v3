---
description: Live soak-test driver — check status, generate the report, or babysit on a loop
argument-hint: [check | report | loop]
---

You are driving the live e2e soak harness specified in `spec/soak_test_plan.md` (package: `dapp/tests/e2e_live/`, run artifacts in `dapp/tests/e2e_live/runs/<runid>/`).

If the harness is not implemented yet (no `dapp/tests/e2e_live/` directory or no `e2e:live` scripts in `dapp/package.json`), stop and say so — point at `spec/soak_test_plan.md` and offer to start the implementation. Never scaffold pieces of it ad hoc from this command.

Mode = "$ARGUMENTS" (default: `check`).

## check (default)
1. From `dapp/`, run `npm run e2e:live:check`.
2. Read the latest run's `state.json` and the tail of `journal.jsonl`.
3. Summarize for the user in plain English:
   - Run phase and time elapsed / remaining in the soak window.
   - Per-flight lifecycle table: bought → landed/cancelled → classified → settled → claimed, with actual outcomes so far (how many on-time / delayed / cancelled).
   - Actor money snapshot: deposits, premiums paid, payouts received, anything collected.
   - Vault: TVL, free vs locked capital, share price now vs start (realized APY so far).
   - Cron freshness (any job stale beyond 2× its cadence) and any open interventions.
   - Any failed checks or anomalies, clearly flagged.
4. If something looks stuck (e.g. fetcher stale, pendingOutcomes not draining), diagnose read-only first; suggest `npm run bot -- <job>` as a manual nudge but DO NOT run it without the user's go-ahead.

## report
1. From `dapp/`, run `npm run e2e:live:report`.
2. Tell the user the report path (`dapp/tests/e2e_live/runs/<runid>/report.html`) and open it with `open <path>`.
3. Summarize the verdict: checks passed/failed, payouts that occurred, APY realized, mismatches found (if any), and the top 3 things worth looking at in the report.

## loop
Invoke the `/loop` skill to run this same check-and-summarize cycle every 60 minutes (self-paced). Each iteration: run the check, post a compact status delta (what changed since last iteration only). Remind the user once that the Mac must stay awake (`caffeinate -i`) and that stopping the loop loses nothing — checks are catch-up-capable.

Rules that always apply:
- Never run admin-gated steps (route seed/wipe/intake) or anything that writes on-chain outside the harness's own verbs.
- Checks are idempotent — running this command repeatedly is always safe.
