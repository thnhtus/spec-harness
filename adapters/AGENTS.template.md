# AGENTS.md

This repo runs **spec-harness**: every tracker task goes through 7 roles and 5 gates, and the gates are enforced by exit code (pre-commit + CI), not by this file.

- Starting a task (the user pastes a task link or id): use the **`start-task`** skill. Do not edit code for a task that has no task folder.
- First run after install: use the **`init-project-rules`** skill.
- Global rules: [`docs/Instructions.md`](docs/Instructions.md). Roles: [`docs/Agents.md`](docs/Agents.md).
- Before any commit: `node scripts/validate-tasks.mjs` must exit 0.
- Never `git reset --hard`, `git stash`, `git clean`, never read `.env`. Where your CLI supports hooks, a hook blocks these (`.agents/spec-harness-guards.json` lists which); where it does not, nothing stops you but this line. Do not work around either.
- `git push` is not banned, but it is the last step: only after the final gate has passed (`status = reviewing`), stop and ask the user, and push only on their yes. Before that, never push. If a hook blocks the push after the yes, tell the user; do not route it through another channel (MCP, API).
