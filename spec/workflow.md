# Development Workflow

This document describes how we manage the build process for this project — how phases are planned, executed, resumed, and closed. Update this file as the workflow evolves.

---

## Overview

Development is broken into phases (see `spec/development_list.md`). Each phase has its own lifecycle: it is planned before work starts, worked through incrementally, and explicitly closed by the user after validation.

The agent uses these files to resume work seamlessly across sessions without losing context.

---

## Files

| File | Purpose |
|---|---|
| `spec/progress.md` | High-level dashboard — one row per phase, shows status at a glance |
| `spec/phases/phase-{NN}-{slug}.md` | Per-phase living document — subtask checklist, pre-work notes, context manifest, work log, decisions |
| `spec/workflow.md` | This file — explains the workflow itself |
| `~/.claude/projects/.../memory/MEMORY.md` | Agent's persistent memory — loaded at start of every session |

## Claude Commands Structure

```
.claude/commands/
  skills/                       ← auto-triggered by the agent based on task context
    aero-api.md                 ← loads when working with FlightAware AeroAPI
    git.md                      ← loads when preparing a commit message
  prime.md                  ← /prime            — load project context at session start
  plan-phase.md             ← /plan-phase N     — generate phase plan file with context manifest
  start-phase.md            ← /start-phase N    — auto-clear context, load docs, begin implementation
  complete-phase.md         ← /complete-phase N — close a finished phase
  commit.md                 ← /commit           — draft, review, and execute a git commit
```

**Skills** live in `skills/` and are auto-triggered — the agent loads them when the task context matches their description. They use progressive disclosure: Layer 1 is always read, deeper layers are only consulted when the specific sub-task requires it.

**Commands** live in the root and are explicitly invoked by the user with `/command-name`.

---

## Phase Lifecycle

```
planned → in_progress → paused → complete
               ↑_______________|
```

- **planned** — phase file exists with Context Manifest and subtasks, user has reviewed and edited pre-work notes, work has not started
- **in_progress** — agent is actively working, subtasks being checked off, work log being written
- **paused** — session ended mid-phase, work log records where we stopped
- **complete** — user has validated and called /complete-phase, phase file is now read-only history

---

## Commands

### `/plan-phase N`

**When:** Before you're ready to start a phase.

**What it does:**
1. Generates `spec/phases/phase-{NN}-{slug}.md` pre-populated with the goal, all subtasks from `spec/development_list.md`, and empty sections for you to fill in
2. Builds a **Context Manifest** — lists the exact skills, external docs (with URLs), and project files the agent will need when `/start-phase` runs
3. Shows you the manifest summary so you know what the agent will load

**What you do next:** Open the file. Read the subtasks. Fill in the **Pre-work Notes** section. Optionally edit the **Context Manifest** if you want the agent to consult additional (or fewer) resources. When you're satisfied, run `/start-phase N`.

---

### `/start-phase N`

**When:** You've reviewed the phase file and are ready for the agent to begin implementation.

**What it does:**
1. **Auto-clears context** — treats the moment as a fresh session, disregards all prior conversation
2. **Runs a lite prime** — reads README, architecture overview, progress, recent git history
3. Reads the phase file and its **Context Manifest**
4. **Loads the manifest on top of lite prime:**
   - Reads full architecture.md + project files listed in the manifest
   - Loads skills listed in the manifest
   - WebFetches external docs listed in the manifest (Stellar docs, Acurast docs, etc.)
5. Reads your pre-work notes and treats them as hard requirements
6. Marks the phase `in_progress` in `progress.md`
7. Begins working through subtasks in order
8. Checks off subtasks in real time and writes to the Work Log as it goes

**No need to run `/clear` or `/prime` first.** The command handles both automatically.

**The work log** is the key to resuming. The agent writes it continuously — what was done, what decisions were made, what files were changed, and where to resume if interrupted. Do not edit the Work Log manually.

---

### `/prime [modules...]`

**When:** Start of any session (or resuming a paused phase).

**Lite by default** — reads README, architecture overview (first ~50 lines), progress, and recent git history. Just enough to know where the project stands.

**Optional deep-dive modules** — pass one or more to go deeper:

| Module | What it reads |
|---|---|
| `contracts` | All Soroban contract source in `contracts/*/src/`, full architecture contract sections, Cargo.toml files |
| `frontend` | `frontend/` source, `packages/` bindings, package.json, routing |
| `centralized_cron` | `executor/src/core/`, `executor/src/backends/cron/`, cron config |
| `acurast_oracle` | `executor/src/backends/acurast/`, migration docs, Acurast config |

```
/prime                          → lite only (10-15 lines)
/prime contracts                → lite + contracts deep-dive
/prime contracts frontend       → lite + two deep-dives
/prime contracts centralized_cron acurast_oracle  → lite + three
```

You just say "keep going" after priming and work continues from the last completed subtask.

---

### `/complete-phase N`

**When:** You've reviewed the agent's work and are satisfied the phase is done.

**What it does:**
1. Marks the phase `complete` with a timestamp
2. Writes a Completion Summary to the phase file (what was built, key decisions, files)
3. Updates `spec/progress.md` — advances the current phase pointer
4. Updates `MEMORY.md` with stable learnings from this phase

**This is always triggered by you.** The agent never auto-completes a phase. You validate, then close it.

---

## Standard Session Flow

### Starting a new phase

```
1. /plan-phase N       → agent generates phase file + context manifest
2. You edit the file   → fill in Pre-work Notes, review/edit Context Manifest
3. /start-phase N      → auto-clears context, loads manifest docs, begins work
4. Agent works         → checks off subtasks, writes work log
5. You review          → inspect output, run tests, give feedback
6. /complete-phase N   → phase closed, memory updated
```

### Resuming a paused phase

```
1. /prime              → agent reads progress + phase file + work log
2. "keep going"        → agent resumes from last completed subtask
3. Agent works         → continues checking subtasks, appends to work log
4. You review          → validate when done
5. /complete-phase N   → phase closed
```

### Session ends mid-phase

No action required. The Work Log records where we stopped. Next session just run `/prime`.

---

## Context Manifest

Each phase file includes a **Context Manifest** section that specifies exactly what the agent needs to load. This is generated by `/plan-phase` and can be edited by the user before `/start-phase`.

The manifest includes:
- **Skills** — which `.claude/commands/skills/*.md` files to load (e.g. `git`, `aero-api`)
- **Docs to Fetch** — external URLs to WebFetch (Stellar docs, Acurast docs, etc.)
- **Project Files to Read** — specific files/directories the agent must read before starting

### External Doc Sources

| Domain | What | Phases |
|---|---|---|
| `developers.stellar.org` | Soroban smart contracts, SDK, network config | 0–8, 12–15 |
| `docs.acurast.com` | TEE executor documentation | 9–11 |
| FlightAware AeroAPI (via `aero-api` skill) | Flight status API reference | 9–11 |

---

## Per-Phase File Structure

```markdown
# Phase {N} — {Name}

Status: planned | in_progress | paused | complete
Started: {date or —}
Completed: {date or —}

## Goal
One paragraph: what this phase builds and why it matters.

## Dependencies
What must exist before this phase starts.

## Context Manifest              ← Generated by /plan-phase, editable by user
### Skills
### Docs to Fetch
### Project Files to Read

## Pre-work Notes                ← YOU FILL THIS IN before /start-phase
Constraints, decisions already made, questions, patterns to follow.

## Subtasks                      ← Agent checks these off during work
- [x] 1. Done subtask
- [ ] 2. Pending subtask
...

### Gate
The condition that must be met for this phase to be complete.

## Work Log                      ← Agent writes this during work, do not edit
### Session {date}
...

## Files Created / Modified      ← Agent maintains this
## Decisions Made                ← Agent maintains this
## Completion Summary            ← Written by /complete-phase
```

---

## Rules

- **You fill in Pre-work Notes. The agent fills in everything else** in the phase file during work.
- **The agent never auto-completes a phase.** You validate, then call `/complete-phase`.
- **The Work Log is append-only.** The agent adds to it; neither you nor the agent edits past entries.
- **Completed phase files are read-only history.** After `/complete-phase`, nothing in the file changes.
- **MEMORY.md captures stable facts only.** Not session details, not in-progress state — only things that will still be true in future sessions.
- **Context Manifest is the source of truth** for what `/start-phase` loads. Edit it to control what the agent sees.

---

## Git Workflow

### Commit format

```
type[, type, ...]: short imperative description (≤50 chars)

- bullet: what changed and why
- bullet: one per logical group
```

### Types

| Type | When |
|---|---|
| `feat` | New contract, function, or feature |
| `fix` | Bug fix |
| `refactor` | Restructure without behaviour change |
| `test` | Tests added or updated |
| `docs` | Spec files, architecture docs, phase files |
| `workflow` | Commands, skills, progress tracking |
| `chore` | Config, deps, tooling |
| `deploy` | Deployment scripts, network config |

### When to commit

- After completing a logical unit of work (a contract, a test suite, a phase)
- After any workflow/tooling changes (commands, skills, progress files)
- Before pushing to GitHub — run `/commit` to generate and review the message

### `/commit` flow

```
/commit         → agent reads all changes, drafts message, shows you for approval
                  you say "yes" / edit it / "cancel"
                  agent commits only after explicit approval
```

**The agent never auto-commits.** You always see and approve the message first.

---

## Workflow Changelog

> Record significant changes to the workflow itself here.

| Date | Change |
|---|---|
| 2026-03-08 | Initial workflow established — progress.md, per-phase files, /plan-phase, /start-phase, /complete-phase commands created |
| 2026-03-08 | Added skills (aero-api, git) with progressive disclosure. Moved to `.claude/commands/skills/` subfolder to separate auto-triggered skills from explicit commands |
| 2026-03-08 | Added git commit conventions (skills/git.md) and /commit command — types: feat, fix, refactor, test, docs, workflow, chore, deploy. Multi-type commits supported. Always requires user approval before committing. |
| 2026-03-08 | Updated /prime to actively read and interpret git log — last 30 commits, files added per commit, cross-validation against progress.md. Git history is now treated as ground truth for build progress. |
| 2026-03-10 | Removed Avalanche, Chainlink CRE, and Reown skill references — project is Stellar-based. Fixed paths throughout all commands. |
| 2026-03-11 | **Workflow v2:** `/plan-phase` now generates a Context Manifest (skills, docs URLs, project files). `/start-phase` auto-clears context and loads the manifest — no more manual `/clear` step. Added Stellar doc URLs (developers.stellar.org, docs.acurast.com) as fetchable references per phase. |
| 2026-03-11 | **Modular `/prime`:** lite by default (README, arch overview, progress, git). Optional deep-dive modules: `contracts`, `frontend`, `centralized_cron`, `acurast_oracle`. `/start-phase` now runs lite prime automatically before loading the Context Manifest. |
