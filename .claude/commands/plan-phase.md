---
description: Generate a detailed phase plan file for a given phase number
---

# Plan Phase

## Objective

Generate a pre-work plan file for a specific phase so the user can review and edit it before work begins. Includes a **Context Manifest** — the exact skills, docs, and files the agent will need when `/start-phase` runs. Do not start any implementation — this command only produces the plan document.

## Arguments

The user provides a phase number as the argument (e.g. `/plan-phase 4`).

## Process

### 1. Read context

- Read `spec/development_list.md` — extract all subtasks for the requested phase number
- Read `spec/progress.md` — check the phase's current status (must be `planned` to generate a plan)
- Read `spec/architecture.md` — understand what this phase's contracts/components depend on

### 2. Determine the phase file path

Phase file naming convention:
```
spec/phases/phase-{NN}-{slug}.md
```
where `{NN}` is zero-padded phase number and `{slug}` is a short kebab-case name.

Phase slugs:
- 0  → phase-00-foundry-init
- 1  → phase-01-mockusdc
- 2  → phase-02-recoverypool
- 3  → phase-03-governancemodule
- 4  → phase-04-riskvault
- 5  → phase-05-oracleaggregator
- 6  → phase-06-flightpool
- 7  → phase-07-controller
- 8  → phase-08-integration-tests
- 9  → phase-09-mock-api-server
- 10 → phase-10-cre-workflow-mock
- 11 → phase-11-cre-workflow-aeroapi
- 12 → phase-12-testnet
- 13 → phase-13-frontend-init
- 14 → phase-14-frontend
- 15 → phase-15-mainnet

### 3. Build the Context Manifest

Determine which skills, external docs, and project files the agent will need to load when `/start-phase` runs. Use the mapping below as a baseline, then adjust based on the phase's specific subtasks and dependencies.

#### Phase → Context Mapping

**Phases 0 (project init):**
- Skills: `git`
- Docs to fetch:
  - https://developers.stellar.org/docs/build/smart-contracts — Soroban smart contract overview
  - https://developers.stellar.org/docs/tools/sdks/library — Stellar SDK reference
- Files: `spec/architecture.md`, `Cargo.toml` (root), any existing contract `Cargo.toml` files

**Phases 1–7 (Soroban contracts):**
- Skills: `git`
- Docs to fetch:
  - https://developers.stellar.org/docs/build/smart-contracts — Soroban smart contract patterns
  - https://developers.stellar.org/docs/build/smart-contracts/example-contracts — example contracts for reference patterns
- Files: `spec/architecture.md`, any contracts this phase depends on (read from Dependencies section), test files for dependent contracts

**Phase 8 (integration tests):**
- Skills: `git`
- Docs to fetch:
  - https://developers.stellar.org/docs/build/smart-contracts — contract interaction patterns
- Files: `spec/architecture.md`, ALL contract source files in `contracts/`, existing test infrastructure

**Phases 9–11 (executor / API):**
- Skills: `git`, `aero-api`
- Docs to fetch:
  - https://docs.acurast.com — Acurast TEE executor documentation
- Files: `spec/architecture.md`, `executor/` directory, any existing API client code, contract ABIs/bindings the executor calls

**Phase 12 (testnet deploy):**
- Skills: `git`
- Docs to fetch:
  - https://developers.stellar.org/docs/networks — Stellar network configuration
- Files: `spec/architecture.md`, all contracts, deploy scripts, `.env.example`

**Phases 13–14 (frontend):**
- Skills: `git`
- Docs to fetch:
  - https://developers.stellar.org/docs/tools/sdks/library — Stellar JS SDK for frontend integration
- Files: `spec/architecture.md`, `frontend/` directory, contract bindings/ABIs, `package.json`

**Phase 15 (mainnet):**
- Skills: `git`
- Docs to fetch:
  - https://developers.stellar.org/docs/networks — mainnet configuration
- Files: `spec/architecture.md`, deploy scripts, testnet deploy artifacts, all contracts

### 4. Ask the user clarifying questions

Before writing the file, review the subtasks and architecture context for this phase. Identify anything that is ambiguous, has multiple valid design choices, or depends on decisions not already recorded in architecture.md or memory. Ask the user these questions directly — wait for answers before proceeding to write the file.

Examples of things worth asking about:
- Design choices that affect the contract interface (e.g. naming, parameter types, error style)
- Whether to follow an existing Soroban pattern or implement from scratch
- Edge cases where the architecture doc is silent
- Any constraints the user may want to enforce (storage rent, access control style, upgrade patterns)

Do not ask about things that are already clearly specified in architecture.md, development_list.md, or memory. Keep questions concise — one to three questions is typical. If nothing is genuinely ambiguous, skip this step and proceed directly to writing the file.

### 5. Generate the phase file

Write the file at the path from step 2 with the following structure:

```markdown
# Phase {N} — {Name}

Status: planned
Started: —
Completed: —

---

## Goal

{One paragraph describing what this phase builds and why it matters to the system.}

## Dependencies

{List contracts/components that must exist before this phase can begin. Reference which prior phase produces each dependency.}

## Context Manifest

> These are the skills, docs, and files `/start-phase` will load automatically.
> Edit this section if you want the agent to consult additional resources.

### Skills
{List of skills to auto-load, e.g. `git`, `aero-api`}

### Docs to Fetch
{List of URLs the agent will WebFetch at start, with one-line descriptions}

### Project Files to Read
{List of specific files/directories the agent must read before starting work}

## Pre-work Notes

> This section is for you to fill in before work begins.
> Add constraints, decisions already made, questions to resolve, patterns to follow, or anything the agent should know before touching code.

---

## Subtasks

{All numbered subtasks from development_list.md for this phase, as unchecked boxes}

- [ ] 1. ...
- [ ] 2. ...
...

### Gate

{The gate condition from development_list.md — what must be true before this phase is considered done.}

---

## Work Log

> Populated by the agent during work. Do not edit manually.

---

## Files Created / Modified

> Populated by the agent during work.

---

## Decisions Made

> Key architectural or implementation decisions locked in during this phase. Populated during work.

---

## Completion Summary

> Populated by /complete-phase. Do not edit manually.
```

### 6. Update progress.md

In the Phase Files table, change the phase row's Status column from `not generated` to `planned`.

### 7. Tell the user what to do next

Output a short message:
- Confirm the file was created at its path
- Show the **Context Manifest** summary — list the skills, docs, and key files that will be loaded
- Tell the user to open the file, read the subtasks, fill in the Pre-work Notes, and optionally edit the Context Manifest
- Tell them to run `/start-phase {N}` when they are ready — it will automatically clear context and begin work
