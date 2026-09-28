# AGENTS.md

This repo runs **spec-harness**: every tracker task goes through 7 roles and 5 gates, and the gates are enforced by exit code (pre-commit + CI), not by this file.

- Starting a task (the user pastes a task link or id): use the **`start-task`** skill. Do not edit code for a task that has no task folder.
- First run after install: use the **`init-project-rules`** skill.
- Global rules: [`docs/Instructions.md`](docs/Instructions.md). Roles: [`docs/Agents.md`](docs/Agents.md).
- Before any commit: `node scripts/validate-tasks.mjs` must exit 0.
- Never `git push`, `git reset --hard`, `git stash`, `git clean`, never read `.env`. A hook blocks these; do not work around it.
