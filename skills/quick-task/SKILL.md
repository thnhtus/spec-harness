---
name: quick-task
description: Use when the user wants to do a ClickUp task directly, without the docs/ FE harness — e.g. "do task <id> but don't run the harness", "quick task <url>", "fix this task, skip the docs flow", "no harness". Reads the task from ClickUp, implements it in the current tree, and verifies with the repo's one-shot commands. No task folder, no FSD, no gates, no subagents.
---

# quick-task — do the task, skip the harness

The opposite of `/start-task`: same source of truth (ClickUp), same `src/`
guardrails, same verification commands — but it does **not** create
`docs/tasks/**`, no FSD/review/plan, no gates, no subagent dispatch. You do the
work yourself, in this context.

Use it when the user explicitly says "no harness" / "quick" / "skip docs flow".
The user has **not** said that and just hands you a ClickUp link → use `/start-task`.

**"Small enough" has a definition, it is not a feeling.** Score the 8-dimension
vector (`docs/Agents.md` §5.1), then ask:

```bash
node scripts/validate-tasks.mjs --triage '<vector JSON>' --task-id <taskId>
```

Verdict `harness` (exit 10) → **tell the user**, do not silently keep going. A
one-file task with `blastRadius ≥ 2` is the classic case that looks like a
quick-task and is not. The user still wants to skip → `--force "<reason>"` so it
leaves a trace.

## Flow

### 1. Read the task (do not guess)
The tracker MCP's read-task tool (find it among the session's tools — ProjectRules §1) with the id (strip the `#`, `CU-`, URL prefixes). Read the description,
comments, parent. Missing the information you need to decide → **ask the user**, do not invent ACs.

Note down: what the ACs are, which screen, which files you are likely to touch.

### 2. Locate before you change anything
Grep/read the real flow end-to-end before writing the first line. Fix where every
caller passes through, do not patch only the path the ticket happens to name.

Many E-TICKET tasks **already shipped on `develop`** — check first, the
deliverable may be just a regression test.

### 3. `src/` guardrails (mandatory, identical to the harness)
Normative source: `docs/agents/SharedRules.md` §2. Summary of the parts most often violated:

- Requests → `src/api/apiClient.ts`. No separate axios instance, no hardcoded base URL.
- Server state → `@tanstack/react-query` in `queries/`. No hand-rolled `useState`+`useEffect`.
- A new API follows the chain: `interfaces/` → `api/` → `queries/` → `pages/`|`components/`.
- `try/catch` on BE errors → `normalizeErrorHelper(error)` (`src/helpers/normalize_errors.helper.ts`).
- List tables / popups / filters → read `docs/DESIGN_RULES.md` first.
- No new dependencies.

### 4. Branch
Already on the user's non-protected branch → **leave it**, no checkout, no new branch.
On `main`/`develop`/`staging`/`release/*` → stop, ask the user which branch they want.
No `git stash`, no `git reset --hard`, no `git checkout -- …`.

### 5. Verify — real output, not guesswork
```bash
npm run test:scope -- <related test file>
npx tsc -b            # root --noEmit is a no-op, you must use this one
npm run lint
```
Non-trivial logic → leave **one** runnable test behind (add it to an existing test
file for the same feature if there is one; do not stand up a new suite).

The repo baseline already has ~164 failing tests on `develop` — compare the **set
of failing files**, not the total count.

### 5b. Real-API E2E — mandatory when the task touches a UI/API flow

Unit tests mock the whole BE, so they cannot catch a contract drift. Any task
that touches a screen or an endpoint has to run one more round against the
**real API**.

**Step 1 — credentials.** `.env` must have `VITE_E2E_CREDENTIAL_USERNAME` +
`VITE_E2E_CREDENTIAL_PASSWORD` (a real login; `helpers/auth.ts` defaults to
`admin` when they are missing). You cannot read it directly (`.env` is under
`permissions.deny` + `sandbox.filesystem.denyRead`) — check indirectly:

```bash
grep -c VITE_E2E_CREDENTIAL_USERNAME .env   # 0 → stop, ask the user
```

No worktree/`.env` → see §2 of the `fix-bug` skill (symlink `.env`).

**Step 2 — your own dev server.** The default port `3004` may be running the
original repo (**without** your changes). Always bring up an empty port yourself:

```bash
npx vite --port 3010 --strictPort > /tmp/dev.log 2>&1   # in the background
```

**Step 3 — two tools, two phases, not substitutes for each other:**

| | answers which question | leaves behind what |
| --- | --- | --- |
| **BrowserOS neo** | "does it actually work?" — driving the real UI by hand, no code written | nothing |
| **Playwright** (`test:e2e:run`) | "will it still work next time?" | a test that stays in the repo + output pasted into evidence |

Default: **neo first** to confirm the real behaviour; once it looks right,
**freeze it into a Playwright test** if the flow is worth keeping. Do not run the
same check twice in two browsers — that is waste, not diligence.

neo only: flows whose state is hard to set up, or that you only need to look at once.
Playwright only: neo is broken/absent, or the flow already has an e2e file.

**neo:**

```
<browser-mcp>__name_session   → a 2-3 word label + category (if the server has one)
<browser-mcp>__run            → open a tab, navigate, fill, read, assert
```

`run` wraps the whole loop (`browser.pages.newPage` → `observe().snapshot()` →
`input().click/fill` → `read`) in a single call; the individual tools (`tabs`,
`snapshot`, `act`, `read`) are only for stepping through a debug session. Another
agent's tabs / the user's tabs are **off limits** — `tabs action="list"` tells you
which tabs are yours.

⚠️ **Cookies are per origin.** A neo profile already logged in on the deployed
host does **not** carry over to `localhost:3010` — you still log in with the
`.env` credentials as usual. neo's existing session only helps when you are
poking at a deployed environment.

**Playwright:**

```bash
set -a; . ./.env; set +a          # vitest does not load .env by itself
E2E_BASE_URL=http://localhost:3010 npm run test:e2e:run -- src/test/e2e/<file>.test.ts
```

There is a live-test template: `src/test/e2e/account-permissions-live.test.ts` (it
reads the credentials from `.env` inside the file, no shell export needed).

e2e pitfalls in detail (mangled output, node-save validator, form stubs…):
the `verify` skill.

### 6. Report, then stop
Summarize: what you changed, which files, the real test/tsc/lint output, what is left undone.
`git commit` / `git push` / changing ClickUp status: **only when the user asks**.

## Do not
- Do not create `docs/tasks/sprint-*/…`, no `task.agent.json`, no `.agent-memory/`.
- Do not touch `docs/srs/`, `docs/fsd/`, `docs/api/` (autogen).
- Do not dispatch subagents — quick means one context.
