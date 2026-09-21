# ProjectRules — project-dependent rules (ADAPTER — this project writes its own)

> **Document:** `docs/agents/ProjectRules.md` — normative home for the 4 sections the kernel does **not** know: §1 sources of truth, §2 architecture guardrails, §3 branch rules, §7 check commands.
> **Precedence:** [`../Instructions.md`](../Instructions.md) > [`SharedRules.md`](./SharedRules.md) (kernel) > this file > role file.
> **Section numbers stay 1/2/3/7** — the kernel cross-references by number (`SharedRules §2` = section 2 here). Do not renumber, do not insert a new section in between.
> **These four sections only.** Anything the kernel already defines (handoff, status, line caps, AC traceability) does not get copied down here.

<!-- NOT-FILLED-IN: delete this line once all 4 sections are really written. Run /init-project-rules to fill them in automatically. -->

---

## 1. Sources of truth via MCP — do not guess

| MCP server | Role | Used for |
| --- | --- | --- |
| `<server name in .mcp.json>` | Requirement source | taskId, description, the BA's AC, comments |
| `<…>` | Branch / MR source | checking branches, MRs, protected branches |
| `<…>` | Design source | node/screen, UI states |
| `<…>` | Running the real app | Gate 5 drives the UI per AC (`pre-qc-gate` §4a), before/after repro (`fix-bug`) — delete this row if the project has no UI |

- **Do not invent MCP data.** A field you cannot fetch → write the literal `unavailable`; if that field blocks a gate → `status = needs_clarification`.
- **Quote, do not paraphrase:** stating a requirement must come with its source (task URL, design node, requirement ID).
- **No implicit caching:** the BA edits the task mid-flight → re-read before the next gate.
- **MCP auth expired:** a call fails on auth → `status = blocked`, tell the user to run `/mcp` and log in again, **stop** — no retry loop, no invented data in its place.

**API contract source** (the ladder is in [`TechnicalPlanner.md` §3.2](./TechnicalPlanner.md) — `unavailable` is the last rung):

| Rung | Present in this project? | Declared here |
| --- | --- | --- |
| 2. BE repo declared in `harness.config.json → repos` | `<yes / no>` | read order: `<route → use-case → DTO → enum>` · **read-only** when it is not the task's `repoName` |
| 3. Swagger/OpenAPI | `<yes / no>` | the `api-docs-sync` skill, service URLs declared in `.claude/skills/api-docs-sync/services.json` |

---

## 2. Architecture guardrails

Stack: `<language + framework + main libraries>`.

| Directory | Rule for the agent |
| --- | --- |
| `<src/…>` | `<what must go through what; what may not be created ad hoc>` |

Cross-cutting constraints:

- `<e.g. every backend error goes through helper X, no inline per-case handling>`
- `<e.g. a new API follows the chain type → client → hook → UI>`
- No new library unless the plan approved it.

> This section is **the most expensive one to write in a hurry**. Most of its value only shows up after the project has hit a real incident — write down what you already know, then build it up after each time an agent gets it wrong.

---

## 3. Branch rules

- **Protected branches (never commit/push/rebase/delete directly):** `<main, develop, …>`
- **Branch name:** `<formula, e.g. {user}/t/{taskId}-{slug}>` — `slug` has the same value as the `docsPath` folder.
- **Base branch (cut new branches from here):** `<develop | main>`

  ```bash
  git fetch origin
  git switch <base-branch>
  git pull --ff-only origin <base-branch>
  git switch -c <branch-name-formula>
  ```

  Always `--ff-only` — a bare `git pull` can open the interactive merge editor and hang the session.
- **Exception — a branch the user manages:** the user is already standing on a non-protected branch → **leave it alone**, do not check out anything. Record `branch` = the conventional name, `branchActual` = the real branch.
- Creating/choosing the branch belongs to the **implementer**, not the orchestrator.
- **Never run a git command that changes working tree state:** `git stash` (including `push -u`), `git checkout -- …`, `git restore`, `git reset --hard`, `git clean`. Another task may be writing files at the same time. Need a clean tree → ask the user.
- **Requires an explicit user request in the session:** `git commit`, `git push`, creating/updating an MR, deleting a branch. Gate passes → `status = reviewing` and **stop, wait for the user**.

---

## 7. Check commands (use only these)

**One-shot commands — what the agent uses (they terminate on their own, return an exit code):**

| Command | Purpose |
| --- | --- |
| `<path-scoped unit test command>` | **default Gate 4 evidence** — runs only the task's test files |
| `<whole-repo unit test command>` | only when the diff touches a file shared in many places |
| `<type-check command>` | 0 errors |
| `<lint command>` | 0 errors |
| `<build command>` | success |

> The commands above must match `evidenceCommandPattern` in `harness.config.json` — get that wrong and Gate 4 will not accept the evidence. Check with `node scripts/validate-tasks.mjs --self-check`.

**Run them through the wrapper, do not paste output by hand:**

```bash
node scripts/run-evidence.mjs --append <task-folder>/08-Test-Evidence.md -- <command>
```

The wrapper runs the real command, then stamps `exitCode`, `durationMs`, `gitRev`, `startedAt`, `outputHash` at the end of the block. `outputHash` binds the attestation to **exactly the output sitting next to it**: copying the block from another task, or running it for real and then prettying up the output, both make the hash disagree and the validator blocks it. That is the difference between *"this text looks like test output"* and *"this process ran and exited 0"* — an agent that ran nothing can still write the first sentence, not the second.

The case it catches that every check-by-prose loses: a command that **prints `Tests: 12 passed` but exits 1**. Read the text and it is green; read the exit code and it is red.

A fresh install ships `"evidenceMode": "attested"` — **keep it**. Drop it to `"legacy"` and hand-pasted evidence gets through again, which means Gate 4/5 only check the shape of the prose; it exists for repos already mid-flight, not for new projects. This field **must be declared explicitly**: `--self-check` goes red if it is missing, because inheriting it from an implicit value is how the harness's whole argument collapses in silence.

**Watch/server commands — ONLY the user runs these by hand, the agent NEVER does** (they do not terminate → they hang the session): `<dev server, test watch, preview…>`

**The real layer to exercise when verifying** (skill `pre-qc-gate` §4): `<browser | api | cli | none>`. A repo with no UI means that layer is a real HTTP/CLI/public-function call, **not** skipping it. Integration tests the harness already has: `<path, e.g. e2e/ or test/integration/>` — if there are none, write "none", do not stand one up at verify time.

Honesty rule: never claim "pass" without having run the real command in this session; paste the real output (command, pass/fail counts, exit code) into `08-Test-Evidence.md`; a failing test → `status = blocked`, do not disable/skip a test to "make it green".

<!-- Test idioms this project keeps tripping over (e.g. how to open the UI library's dropdown under jsdom) go here, along with the shared helper — do not make every implementer rediscover it. -->
