---
description: Mark a phase as complete after user validation
---

# Complete Phase

## Objective

Close out a phase that the user has validated as done. Updates the phase file, progress tracker, and persistent memory. This command is always triggered by the user — never called automatically by the agent.

## Arguments

The user provides a phase number as the argument (e.g. `/complete-phase 4`).

## Process

### 1. Read current state

- Read `spec/progress.md` — confirm phase status is `in_progress` or `paused`
- Read the phase file at `spec/phases/phase-{NN}-{slug}.md`
  - Check which subtasks are still unchecked — note any that were intentionally skipped
- Read `spec/architecture.md` to identify any stable patterns or decisions worth persisting to memory

If the phase status is already `complete`, tell the user and stop.

### 2. Update the phase file

- Change `Status: in_progress` (or `paused`) to `Status: complete`
- Set `Completed: {today's date}`
- Mark any remaining unchecked subtasks that the user confirmed are done as `[x]`
- Append a final Work Log entry:
  ```
  ### Session {date} — Completed
  Phase validated by user. All gate conditions met.
  ```
- Write the **Completion Summary** section:
  - What was built
  - Key decisions that were locked in
  - Files created or modified (final list)
  - Anything the next phase should be aware of
  - Any known limitations or deferred items

### 3. Update progress.md

- Change the phase row Status to `complete`
- Set the Completed date
- Update the Phase Files table status to `complete`
- Update `Current Phase:` in the header to the next phase (or `— (all complete)` if phase 14)
- Update `Last Updated:` to today

### 4. Update MEMORY.md

Add or update entries in `~/.claude/projects/.../memory/MEMORY.md` with stable learnings from this phase:
- Any contracts deployed and their design patterns confirmed
- Any decisions that affect future phases
- Any gotchas or constraints discovered during implementation
- Update the "Current Phase" note in MEMORY.md

Do not write session-specific or temporary information to MEMORY.md — only facts that will still be true in future sessions.

### 5. Confirm to the user

Output a short message:
- Confirm phase {N} is marked complete
- State what the next phase is and suggest running `/plan-phase {N+1}` when ready
