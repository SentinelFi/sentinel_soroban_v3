---
description: Mark a phase as in_progress and begin implementation
---

# Start Phase

## Objective

Clear all prior conversation context, run a **lite prime**, load the phase's Context Manifest on top, transition the phase to `in_progress`, and begin implementation. This command is self-contained — no separate `/clear` or `/prime` needed.

## Arguments

The user provides a phase number as the argument (e.g. `/start-phase 4`).

## CRITICAL: Context Reset

**Disregard all prior conversation messages.** This command starts a fresh working context. Do not carry forward any assumptions, file contents, or decisions from earlier in the conversation. The only context that matters is what you read in the steps below.

This is equivalent to `/clear` — treat this moment as the beginning of a new session.

## Process

### 1. Lite Prime (baseline context)

Run these in parallel to establish baseline project understanding:

**a) Core docs:**
- Read `README.md` — project overview, structure, tech stack
- Read `spec/architecture.md` — **first ~50 lines only** (System Overview + contract table)
- Read `CLAUDE.md` if it exists
- Read `spec/preferences.md` — user coding preferences (hard requirements)

**b) Progress state:**
- Read `spec/progress.md` — current phase status
- `git log --oneline -10` — recent commits
- `git status` — uncommitted work

This gives the agent just enough context to orient before diving into phase-specific work.

### 2. Read the phase file

- Determine the phase file path using the slug table:
  - 0 → `spec/phases/phase-00-foundry-init.md`
  - 1 → `spec/phases/phase-01-mockusdc.md`
  - 2 → `spec/phases/phase-02-recoverypool.md`
  - 3 → `spec/phases/phase-03-governancemodule.md`
  - 4 → `spec/phases/phase-04-riskvault.md`
  - 5 → `spec/phases/phase-05-oracleaggregator.md`
  - 6 → `spec/phases/phase-06-flightpool.md`
  - 7 → `spec/phases/phase-07-controller.md`
  - 8 → `spec/phases/phase-08-integration-tests.md`
  - 9 → `spec/phases/phase-09-mock-api-server.md`
  - 10 → `spec/phases/phase-10-cre-workflow-mock.md`
  - 11 → `spec/phases/phase-11-cre-workflow-aeroapi.md`
  - 12 → `spec/phases/phase-12-testnet.md`
  - 13 → `spec/phases/phase-13-frontend-init.md`
  - 14 → `spec/phases/phase-14-frontend.md`
  - 15 → `spec/phases/phase-15-mainnet.md`

- Read the full phase file — confirm Status is `planned`
- Read the **Pre-work Notes** — these are the user's constraints, treat as hard requirements
- Read all **Subtasks** — this is your implementation checklist
- Read the **Context Manifest** — this tells you what to load on top of lite prime

If the phase status is not `planned`, stop and tell the user. Do not begin work on a phase that is already `in_progress` or `complete`.

### 3. Load the Context Manifest (on top of lite prime)

Execute these in parallel:

**a) Read project files listed in the manifest:**
- Read `spec/architecture.md` — the **full file** this time (lite prime only read the top)
- Read every file/directory listed under "Project Files to Read" in the Context Manifest
- For directories, read the key source files within them

**b) Load skills listed in the manifest:**
- For each skill name listed (e.g. `soroban`, `oz-stellar`, `git`):
  - Read the main skill file: `.claude/commands/skills/{name}/SKILL.md`
  - Read any reference files listed in the Context Manifest from `.claude/commands/skills/{name}/references/`
- Do NOT use the `Skill` tool to load these — just read the files directly with the `Read` tool

**c) Fetch external docs listed in the manifest:**
- WebFetch each URL listed under "Docs to Fetch" in the Context Manifest
- These are reference docs — scan for patterns and APIs relevant to this phase's subtasks
- If a fetch fails, note it in the Work Log but do not block — proceed with architecture.md as primary reference

**d) Read development_list.md:**
- Read `spec/development_list.md` for the full test list and gate conditions for this phase

### 4. Update the phase file

- Change `Status: planned` to `Status: in_progress`
- Set `Started: {today's date}`
- Append the first Work Log entry:
  ```
  ### Session {date}
  Starting phase. Lite prime complete. Context manifest loaded.
  Docs fetched: {list URLs that were successfully fetched}
  Skills loaded: {list skills loaded}
  Project files read: {list key files read from manifest}
  ```

### 5. Update progress.md

- Change the phase row Status from `planned` to `in_progress`
- Set the Started date
- Update `Current Phase:` in the header

### 6. Implement the phase

Work through the subtasks in order. As each subtask is completed:
- Check it off in the phase file: `- [ ]` → `- [x]`
- Append a brief note to the Work Log under the current session header

After each logical group of subtasks (or at natural stopping points), append to the Work Log:
- What was completed
- Any decisions made (also add to Decisions Made section)
- Files created or modified (also add to Files Created/Modified section)
- Where to resume if interrupted

### 7. Handle the gate

After all subtasks are complete, check the gate condition. If the gate passes:
- Add a note to the Work Log: "All subtasks complete. Gate condition met. Ready for /complete-phase."
- Do NOT call /complete-phase automatically — the user validates and calls it themselves.

If blocked before completing all subtasks:
- Update the Work Log with what was done, what remains, and what the blocker is
- Update the phase file status to `paused`
- Update progress.md status to `paused`
- Tell the user what the blocker is
