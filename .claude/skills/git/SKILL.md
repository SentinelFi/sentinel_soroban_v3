---
description: Git commit convention for this project. Trigger on ANY commit-related work — preparing commit messages, reviewing staged/unstaged changes, deciding commit types, running git commit, or when the /commit command is invoked. For examples or scoping rules, see reference files.
---

# Skill: Git Commit Conventions

## Format (always loaded)

```
type[, type, ...]: short imperative description (≤50 chars)

- bullet: what changed and why
- bullet: one per logical group of changes

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>
```

- Subject line: imperative mood, lowercase after colon, no period, ≤50 chars
- Body: bullet points, focus on **what and why**, not how
- Multi-type: list all that apply, ordered by significance

## Commit types

| Type | Use when |
|---|---|
| `feat` | New contract, new function, new feature |
| `fix` | Bug fix, incorrect logic corrected |
| `refactor` | Code restructured without behaviour change |
| `test` | Tests added or updated |
| `docs` | Spec files, architecture docs, README, phase files |
| `workflow` | Commands, skills, progress.md, phase tracking, workflow docs |
| `chore` | Config, deps, tooling, .gitignore, foundry.toml setup |
| `deploy` | Deployment scripts, network config, broadcast files |

## Rules

- **One commit per logical unit of work** — a phase completion, a contract, a bug fix. Not one commit per file.
- **Never commit secrets, .env files, or private keys.**
- **Never commit with --no-verify** unless explicitly instructed.
- **Always show the draft to the user before committing.** The user approves.
- If changes span many files, group bullets by type not by file.

---

## Progressive disclosure — reference files

| When you need… | Read |
|---|---|
| Single-type and multi-type commit message examples | `references/examples.md` |
| Project-specific scoping rules (phase commits, mid-phase, mixing) | `references/scope.md` |
