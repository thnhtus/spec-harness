---
name: fix-bug
description: Use when the user wants a ClickUp bug fixed fast, without the docs/ FE harness — e.g. "fix bug <id>", "fix bug <url>, skip the harness", "debug this ticket then fix it". Reads the ticket, isolates a worktree, reproduces the bug with a failing test, fixes the root cause, verifies, and writes ONE evidence file. No FSD, no SRS, no task folder, no gates, no subagents.
---

# fix-bug — ticket → worktree → repro → fix → evidence

Keeps the 3 things about the harness that are actually worth it: **isolated
worktree**, **reproduce-first**, **real evidence**. Drops all the paperwork: no
FSD, no FSD-Review, no technical plan, no `task.agent.json`, no `.agent-memory/`,
no gates, no subagents. One context, one evidence file.

A general feature/task (not a bug) → use `quick-task` or `/start-task`.

**A "small" bug has a definition, it is not a feeling.** After step 1 (read the
ticket), score the 8-dimension vector (`docs/Agents.md` §5.1) and then ask:

```bash
node scripts/validate-tasks.mjs --triage '<vector JSON>' --branch-type bugfix --task-id <taskId>
```

Verdict `harness` (exit 10) → **tell the user**, do not silently carry on. This
is exactly why `riskFloor` exists: a race condition bug that touches one file but
spreads across a whole service is not a small bug. The user still wants to skip
it → `--force "<reason>"`.

## 1. Ticket

The tracker MCP's read-task tool (find it among the session's tools — ProjectRules §1) with the id (strip the `#`, `CU-`, URL prefixes). Read the description +
comments: **expected vs actual** and **the steps to reproduce**. No repro → ask
the user, do not guess the symptom.

Derive: `slug` = kebab-case, diacritics stripped, of the task name.

## 2. Worktree

Follow Step 0 of [`.claude/commands/start-task.md`](../../commands/start-task.md)
exactly — read that file, do not duplicate it here. In short:

```bash
# EnterWorktree name: task-{taskId}-{slug}   → .claude/worktrees/task-{taskId}-{slug}/
git status --porcelain                        # must be empty, otherwise STOP and ask the user
git fetch origin
git switch -C {branch-formula} origin/{target-branch}   # ProjectRules §3; EnterWorktree branches off origin/HEAD, so this has to be corrected
git branch -D worktree-task-{taskId}-{slug}
cp -c -R <main-repo>/node_modules node_modules # CoW ~6s; do NOT symlink (shared tsBuildInfo → phantom type errors)
```

**Link `.env` right away — this is what unlocks the real e2e API in §5.** Without
`.env` the worktree has an empty `VITE_API`, requests go nowhere, and the e2e
credentials are missing too:

```bash
ln -sfn <main-repo>/.env .env   # symlink; do NOT cp — cp has to *read* .env, so it is denied
```

`ln -s` only *creates* a link, so it runs; `cp` does not. `.env` is a static
read-only file, so two worktrees sharing it is harmless (unlike `node_modules`),
and it is already in `.gitignore` so it can never be committed. With the symlink
in place, `npx vite` inside the worktree picks up `VITE_API` on its own.

Quick check, without reading the contents:

```bash
test -e .env && grep -c VITE_E2E_CREDENTIAL_USERNAME .env   # 1 → real e2e login works
```

The user says "just do it on the current tree" → skip this whole section.

## 3. Reproduce-first — mandatory, this is the part you do not get to skip

```
Write a Vitest that reproduces the bug
  → npm run test:scope -- <file>   → FAIL with the right symptom
     (failing for the wrong reason = the test is wrong → fix the test, do not touch src/ yet)
  → fix the code
  → npm run test:scope -- <file>   → PASS
```

That test stays forever as a regression test. Add it to an existing test file for
the same feature if there is one; do not stand up a new suite.

**Cannot reproduce it** → stop, tell the user, do not "fix by guesswork" off the
description.

Bug only visible in the browser → use the `verify` skill, and record the manual
before/after repro in the evidence.

## 4. Fix — root cause, minimal diff

- Grep **every caller** of the function you are about to change, before changing
  it. One guard in the shared function is smaller than a guard at each caller —
  and patching only the path the ticket names leaves the sibling callers broken.
- No refactoring nearby, no renaming props, no restyling, no "tidying while I am
  here".
- Do not hide the symptom: no `@ts-ignore`, no swallowing axios errors, no
  skipping/disabling an existing failing test.
- The `src/` guardrails still apply — `docs/agents/SharedRules.md` §2. Most
  commonly violated: requests go through `src/api/apiClient.ts`, server state
  through `queries/` + react-query, BE errors through `normalizeErrorHelper()`,
  no new dependencies.

## 5. Verify

```bash
npm run test:scope -- <the bug's test file>
npx tsc -b            # --noEmit at the root is a no-op
npm run lint
```

`npm run test:run` (full suite) **only if** you touched a shared barrel. The
`develop` baseline already has ~164 failing tests — compare the **set of failing
files**, not the total count.

**Real e2e API — same setup as §5b of the `quick-task` skill**, not duplicated
here: a dedicated dev server on a free port, then a browser-driving MCP if the
session has one (e.g. BrowserOS neo, Playwright) and **Playwright**
(`test:e2e:run`), with the same split of responsibilities described there. `.env`
was symlinked back in §2, so the credentials are already there.

For a bug, both have work to do, and in this order:

1. **neo** — run the ticket's exact repro against the real UI, confirm the bug is
   real and observe the symptom. This is the before.
2. after the fix → **neo** again: the after.
3. **Playwright** — if the symptom can be locked down with an e2e test, write one
   to keep; if not, the regression test from §3 (unit) is enough.

Smoke ≥ 1 neighbouring flow (test or browser) — bugs tend to breed bugs.

## 6. Evidence — ONE file

`docs/tasks/fixes/{taskId}-{slug}.md`, prose in `harness.config.json → docLanguage`, short:

```markdown
# {taskId} — {task name}

**Ticket:** {tracker-url} · **Branch:** {branch formula — ProjectRules §3}

## Symptom
Expected vs actual, the steps to reproduce.

## Root cause
Why it broke, at which `file:line`.

## Fix
Files changed + one line of reasoning per file.

## Evidence
- Repro FAIL before the fix: <real output, trimmed>
- Test PASS after the fix: <real output>
- `npx tsc -b`: <output>
- `npm run lint`: <output>
- Real e2e API (BrowserOS neo / Playwright): <before/after repro on the real UI>
- Neighbouring flow smoke: <description + result>

## Regression risk
What risk is left + how it is reduced (leave empty if none).
```

**Do not invent test numbers** — paste the real output, or state plainly that you
did not run it.

## 7. Stop

Report to the user: root cause, files changed, worktree path, evidence file path.
`ExitWorktree action: "keep"`.

`git commit` / `git push` / MR / changing the ClickUp status: **only if the user
asks**.
