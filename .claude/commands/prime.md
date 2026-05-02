---
description: Prime agent with codebase understanding
---

# Prime: Load Project Context

## Objective

Build project understanding at the level requested. **Lite by default** — just enough to know where the project stands. Optionally deep-dive into specific areas.

## Arguments

```
/prime                                    → lite only
/prime contracts                          → lite + contracts deep-dive
/prime frontend                           → lite + frontend deep-dive
/prime centralized_cron                   → lite + executor/cron deep-dive
/prime acurast_oracle                     → lite + acurast executor deep-dive
/prime contracts frontend                 → lite + both deep-dives
/prime contracts centralized_cron acurast_oracle  → lite + three deep-dives
```

Zero or more modules can be passed. Order doesn't matter.

---

## Part 1 — Lite Prime (always runs)

### 1a. Read core docs (in parallel)

- Read `README.md` — project overview, structure, tech stack
- Read `spec/architecture.md` — **only the first ~50 lines** (System Overview + contract table). Do NOT read the full file unless a deep-dive module needs it.
- Read `CLAUDE.md` if it exists
- Read `spec/preferences.md` — user coding preferences (hard requirements)

### 1b. Read progress and current state (in parallel)

- Read `spec/progress.md` — identify current phase and its status
- If a phase is `in_progress` or `paused`, read its phase file from `spec/phases/` — read the subtask checklist, Context Manifest, and Work Log to understand where work stopped
- `git log --oneline -15` — last 15 commits
- `git status` — any uncommitted work

### 1c. Extract from git

- Which phases have completion commits — treat as ground truth
- What the most recent commit was
- Cross-check against `progress.md`: if git shows phase N complete but progress.md disagrees, trust git and note the discrepancy

### 1d. Output lite summary

```
## Project: Sentinel Protocol
- Stellar / Soroban flight delay insurance
- Current phase: {N} — {name} ({status})
- Last commit: {hash} {message}
- Uncommitted changes: {yes/no}
- Next action: {suggestion}

Workflow: /plan-phase N · /start-phase N · /complete-phase N · /commit
```

Keep it short — 10-15 lines max. This is the whole output if no modules are passed.

---

## Part 2 — Deep-Dive Modules (only if requested)

Run requested modules in parallel. Each module appends its section to the lite summary.

### Module: `contracts`

**What it reads:**
- `spec/architecture.md` — full Contracts section (storage layouts, access control, interfaces)
- All `.rs` source files in `contracts/*/src/`
- `Cargo.toml` at workspace root and each contract's `Cargo.toml`
- Any existing test files in `contracts/*/src/test*`

**What it reports:**
- List each contract: name, what it does, key entry points
- How contracts connect (Controller → GovernanceModule, Controller → RiskVault, etc.)
- Which contracts exist vs. which are still to be built
- Any test coverage observations

### Module: `frontend`

**What it reads:**
- `frontend/` directory structure
- `frontend/package.json` — dependencies and scripts
- Key source files: `frontend/src/App.*`, route definitions, component index
- `packages/` directory — auto-generated TypeScript contract bindings
- Any `.env.example` or environment config

**What it reports:**
- Framework and key dependencies (Scaffold Stellar, React, Vite)
- Which contract bindings exist in `packages/`
- Current state of the UI (scaffolded? pages built? connected to contracts?)
- Entry points and routing structure

### Module: `centralized_cron`

**What it reads:**
- `executor/` directory structure
- `executor/src/core/` — shared oracle and settler logic
- `executor/src/backends/cron/` — centralized cron backend
- `executor/package.json` and `executor/tsconfig.json`
- Any `.env.example` for API keys / Stellar keypairs

**What it reports:**
- Executor architecture (core logic vs. backend adapters)
- Oracle job: what it does, how it calls AeroAPI, how it writes to OracleAggregator
- Settler job: what it does, how it calls Controller.settle()
- Cron schedule and configuration
- Which pieces exist vs. still to be built

### Module: `acurast_oracle`

**What it reads:**
- `executor/src/backends/acurast/` — Acurast TEE backend
- Any Acurast deployment config or manifest files
- `spec/architecture.md` — Executor migration section
- Acurast-specific README or docs if present

**What it reports:**
- Current state of Acurast integration (scaffolded? configured? deployed?)
- How it wraps the same core logic as cron backend
- Deployment and migration notes
- Any Acurast-specific constraints (runtime limits, environment)

---

## Output Format

Always lead with the lite summary. If modules were requested, append each module's section with a clear header:

```
## Project: Sentinel Protocol
{lite summary}

## Contracts Deep-Dive
{only if /prime contracts}

## Frontend Deep-Dive
{only if /prime frontend}

## Centralized Cron Deep-Dive
{only if /prime centralized_cron}

## Acurast Oracle Deep-Dive
{only if /prime acurast_oracle}
```

**Make it scannable — bullet points, short lines, no walls of text.**
