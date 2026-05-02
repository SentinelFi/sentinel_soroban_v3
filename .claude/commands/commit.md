---
description: Generate and execute a structured git commit message
---

# Commit

## Objective

Analyse all staged and unstaged changes, draft a commit message following the project's commit convention, present it for user approval, then commit. Never commit without explicit user approval.

## Process

### 1. Read the convention

Read `.claude/commands/skills/git.md` Layer 1 — commit types, format rules, and examples.

### 2. Understand what changed

Run these in parallel:
- `git status` — see all staged, unstaged, and untracked files
- `git diff` — unstaged changes
- `git diff --cached` — staged changes
- `git log -5 --oneline` — recent commits for style reference

### 3. Stage files if needed

If the user passed specific files as arguments (e.g. `/commit src/ spec/`), stage those files.

If no arguments given and there are unstaged changes, list them and ask the user:
- "Stage all changes?" → `git add -A` if yes
- Or ask them to specify which files to include

Never stage `.env`, `*.key`, `*secret*`, `private*`, or any file that looks like it contains credentials. Warn the user if any such file appears in the diff.

### 4. Identify commit types

From the diff, identify which types apply:

| What you see in the diff | Type |
|---|---|
| New or modified `.rs` contract files in `contracts/` | `feat` or `fix` or `refactor` |
| New or modified test files in `contracts/*/src/test*` or `tests/` | `test` |
| New or modified files in `spec/` or `docs/` | `docs` |
| Changes to `.claude/commands/` or `spec/progress.md` or `spec/phases/` | `workflow` |
| Changes to `Cargo.toml`, `package.json`, `.gitignore`, config | `chore` |
| Changes to deploy scripts or network config | `deploy` |

List types in order of significance (feat/fix before test before docs before workflow before chore).

### 5. Draft the commit message

Follow the format exactly:

```
type[, type, ...]: short imperative description (≤50 chars)

- bullet: what changed and why
- bullet: one per logical group

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>
```

- Subject: imperative mood ("add", "fix", "update" — not "added", "fixed", "updates")
- Subject: lowercase after colon, no trailing period, ≤50 chars
- Body bullets: group by type if multi-type, focus on what and why
- Always include the Co-Authored-By trailer

### 6. Present the draft

Show the full commit message to the user in a code block. Then ask:

> "Commit with this message? You can say 'yes', edit the message, or say 'cancel'."

Do NOT commit yet.

### 7. Wait for approval

- **"yes" / "looks good" / "go ahead"** → commit with the drafted message
- **User provides edited message** → commit with their version
- **"cancel" / "no"** → stop, do not commit

### 8. Commit

Use a HEREDOC to preserve formatting:

```bash
git commit -m "$(cat <<'EOF'
type[, type, ...]: description

- bullet one
- bullet two

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>
EOF
)"
```

### 9. Confirm

Run `git status` and `git log -1 --oneline` after the commit and show the user the result.

### 10. Push

After a successful commit, run `git push` to push the branch to the remote.

If the branch has no upstream yet, run `git push -u origin <branch-name>` instead.

Show the push output to the user.

## Notes

- Never use `--no-verify`
- Never amend a published commit
- Never auto-commit — always wait for explicit approval
- If `git commit` fails due to a pre-commit hook, report the hook output and ask the user how to proceed
- If `git push` fails, report the error and ask the user how to proceed — do not force push
