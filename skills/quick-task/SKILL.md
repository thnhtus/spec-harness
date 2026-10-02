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
node scripts/validate-tasks.mjs --triage '{"vector":{…8 dims},"counts":{"symbol":"…","filesTouched":n,"existingTests":n},"questions":[…]}' --task-id <taskId>
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

Tasks often **already shipped on the base branch** (ProjectRules §3) — check
first, the deliverable may be just a regression test.

### 3. `src/` guardrails (mandatory, identical to the harness)
Normative source: `docs/agents/SharedRules.md` §2. Summary of the parts most often violated:

Normative source for this repo's architecture rules: **ProjectRules §2**. Read it
before the first edit; the one rule that holds everywhere: no new dependencies.

### 4. Branch
Already on the user's non-protected branch → **leave it**, no checkout, no new branch.
On a protected branch (ProjectRules §3) → stop, ask the user which branch they want.
No `git stash`, no `git reset --hard`, no `git checkout -- …`.

### 5. Verify — real output, not guesswork
Run **exactly the ProjectRules §7 command set** (scoped test · type-check · lint),
each one through the wrapper into the evidence file of step 6:

```bash
node scripts/run-evidence.mjs --append docs/tasks/fixes/<taskId>-<slug>.md -- <§7 command>
```
Non-trivial logic → leave **one** runnable test behind (add it to an existing test
file for the same feature if there is one; do not stand up a new suite).

The base branch already has failing tests → compare the **set of failing files**,
not the total count.

### 5b. Real-API E2E — mandatory when the task touches a UI/API flow

Unit tests mock the whole BE, so they cannot catch a contract drift. Any task
that touches a screen or an endpoint has to run one more round against the
**real API**.

**Step 1 — credentials.** The e2e login variables live in `.env` (their names:
ProjectRules §7). You cannot read it directly (`.env` is under
`permissions.deny` + `sandbox.filesystem.denyRead`) — check indirectly:

```bash
grep -c <E2E_USERNAME_VAR> .env   # 0 → stop, ask the user
```

No worktree/`.env` → see §2 of the `fix-bug` skill (symlink `.env`).

**Step 2 — your own dev server.** The default port may be running the
original repo (**without** your changes). Always bring up a free port yourself,
with the dev-server command from ProjectRules §7, in the background, output to a file.

**Step 3 — two tools, two phases, not substitutes for each other:**

| | answers which question | leaves behind what |
| --- | --- | --- |
| **BrowserOS neo** | "does it actually work?" — driving the real UI by hand, no code written | nothing |
| **e2e runner** (ProjectRules §7) | "will it still work next time?" | a test that stays in the repo + output in evidence |

Default: **neo first** to confirm the real behaviour; once it looks right,
**freeze it into an e2e test** if the flow is worth keeping. Do not run the
same check twice in two browsers — that is waste, not diligence.

neo only: flows whose state is hard to set up, or that you only need to look at once.
e2e runner only: neo is broken/absent, or the flow already has an e2e file.

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
host does **not** carry over to your local port — you still log in with the
`.env` credentials as usual.

**e2e runner:** the §7 e2e command, pointed at your port, run through
`run-evidence.mjs` like every other check.

### 6. Evidence file, gate, report
Evidence goes in `docs/tasks/fixes/{taskId}-{slug}.md` — same file shape as
`fix-bug` §6: a `## Evidence` section holding the `run-evidence.mjs` blocks of
step 5. Then the gate:

```bash
node scripts/validate-tasks.mjs --lite-check docs/tasks/fixes/{taskId}-{slug}.md   # exit 0 or you are not done
```

Summarize: what you changed, which files, the evidence file path, what is left undone.
`git commit` / `git push` / changing the tracker status: **only when the user asks**.

## Do not
- Do not create a task folder (`docs/tasks/<group>/…`) — only the one `docs/tasks/fixes/` file; no `task.agent.json`, no `.agent-memory/`.
- Do not touch `docs/srs/`, `docs/fsd/`, `docs/api/` (autogen).
- Do not dispatch subagents — quick means one context.
