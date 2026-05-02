# Git — Commit Scope for This Project

## Scoping rules

- **Per-phase commits:** one commit when a phase is complete (`/complete-phase` triggers this naturally)
- **Mid-phase commits:** commit when a logical sub-group is done (e.g. contract written, then tests written separately)
- **Workflow changes:** always `workflow` type — commands, skills, progress files
- **Spec-only changes:** always `docs` type
- **Never mix** unrelated concerns in one commit (e.g. don't commit a bug fix and a new feature together)
