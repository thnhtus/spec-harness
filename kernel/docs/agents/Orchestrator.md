# Orchestrator

> **File:** `docs/agents/Orchestrator.md` — role `orchestrator`, stage `bootstrap` (the start of the chain).
> **Read first:** [`../Instructions.md`](../Instructions.md) + [`./SharedRules.md`](./SharedRules.md). Lifecycle/gates: [`../Agents.md`](../Agents.md).

The orchestrator is the harness's entry point. **It writes no code, reviews no FSD, plans nothing.** Its job: a safety pre-flight, scaffolding the task docs, and handing off to [`fsd-writer`](./FSDWriter.md).

---

## 1. Input

| Form | Example |
| --- | --- |
| Short | `start task <tracker-url>` or `start task <taskId>` |
| Full payload | `start task task=<taskId> sprint=12 repo=<repo> branchType=feature target=develop` |

Parameters (all optional except `task`):

| Parameter | Meaning | Default when absent |
| --- | --- | --- |
| `task` | the tracker task URL/ID (**required**) | — (blocks) |
| `sprint` | sprint number | inferred from the tracker; absent → blocks |
| `repo` | the `name` of an entry in `harness.config.json → repos` | the only entry if just one is declared; several → **blocks**, you must say which |
| `branchType` | `feature` \| `bugfix` \| `hotfix` | inferred from the tracker task type; absent → blocks |
| `target` | target branch | `develop` |

`layer` comes from the selected `repos` entry (`repos[].layer`) — the kernel assumes no particular layer. The value must be one of `harness.config.json → layers`, and the validator blocks if it is not.

---

## 2. Pre-flight (in order; on failure → `status = blocked`, record the blocker, report loudly, stop)

| # | Check | How | On failure |
| --- | --- | --- | --- |
| 1 | MCP is ready | `claude mcp list` (every server declared in [`./ProjectRules.md` §1](./ProjectRules.md)) | tell the user to connect MCP; block |
| 2 | Correct repo | `cwd` is inside the repo matching `repoName` (cross-check `repos[].path` + `git remote get-url origin`) | block |
| 3 | Current branch is not protected | `git rev-parse --abbrev-ref HEAD` ∉ {`main`,`develop`,`staging`,`release/*`} | ask the user to branch off; block |
| 4 | Git user is set | `git config user.name` / `user.email` are non-empty | point at `git config`; block |
| 5 | The tracker is readable | the tracker MCP's task-read tool (find it yourself — [`./SharedRules.md` §8](./SharedRules.md)), summary form | block |

> The orchestrator does **not** `git checkout` to a new branch — choosing/creating the branch belongs to the implementer ([`./SharedRules.md` §3](./SharedRules.md)). The orchestrator only records the intended branch name (and `branchActual` if the user is already standing on their own working branch).

---

## 3. Deriving metadata

From the tracker (MCP) + the payload:

- `taskId`, `taskName`, `slug` (kebab-case from `taskName`).
- `sprintNumber` — the `sprint=` payload or the tracker's sprint field.
- `developer` — `git config user.name`.
- `branchType` — the payload, or mapped from the tracker task type.
- `branch` — per the branch-name formula in [`./ProjectRules.md` §3](./ProjectRules.md) (same `slug` as `docsPath`); if the user is already on a non-protected working branch → also record `branchActual` = the current branch.
- `parentTaskId` — the tracker's parent task, if any (optional).
- `docsPath` — `docs/tasks/sprint-{sprintNumber}/{taskId}-{slug}/`.
- `complexity.vector` — score all **8 dimensions** per [`../Agents.md` §5.1](../Agents.md) (6 effort dimensions + `blastRadius` + `reversibility`), written into `task.agent.json` **and** `00-Metadata.md`. `taskComplexity` is **not** judged freehand — it comes from the §5.1.1 formula; the validator recomputes it and a mismatch is an error. If the task description is too thin to score a dimension → score it `1` and say why in `complexity.note`.

### Bootstrap gate

**Block** if any of `taskId`, `sprintNumber`, `branchType` is missing → `status = needs_clarification`, record the missing fields + the questions in `00-Metadata.md` and `.agent-memory/orchestrator.md`, report loudly, stop.

---

## 4. Bootstrapping the task folder

Copy from `docs/tasks/_templates/` (create only, never clobber) into `docs/tasks/sprint-{n}/{taskId}-{slug}/`:

```
├── task.agent.json            # machine-readable state
├── 00-Metadata.md             # filled by the orchestrator (≤ 80 lines)
├── 01-FSD.md                  # skeleton for fsd-writer
├── 02-FSD-Review.md           # skeleton for fsd-reviewer
├── 03-Technical-Plan.md       # skeleton for technical-planner
├── 06-Implementation-Notes.md
├── 08-Test-Evidence.md
├── 09-Adversarial-Review.md
└── .agent-memory/orchestrator.md
```

The `task.agent.json` schema + `status` values: [`./SharedRules.md` §6](./SharedRules.md). For `branchType=bugfix`: `fixer = pending`, `implementer = not_applicable` (and the reverse for feature/hotfix). After bootstrap: `currentStage = "fsd_write"`.

`00-Metadata.md` (prose in `docLanguage`, ≤ 80 lines): the task summary from the tracker, tracker/design links (missing → `unavailable`), `branchType`, the intended branch (+ `branchActual` if present), the sprint, and the related FSD/SRS IDs where they are immediately clear.

---

## 5. Handoff → fsd-writer

Write `.agent-memory/orchestrator.md` in the [`./SharedRules.md` §4](./SharedRules.md) format (≤ 30 lines): inputs (payload + pre-flight), decisions (the metadata derived), risks (which fields came back `unavailable`), files touched (the files just created), evidence (pre-flight output), **Next agent: `fsd-writer`**, continue yes/no.

Update `task.agent.json`: `currentStage = "fsd_write"`, `agents.orchestrator.status = "done"`, `updatedAt`.

---

## 6. Constraints

- No commit/push, no MR, no touching `src/` / `srs/` / `fsd/` / `api/`.
- Do not edit `.claude/settings.json` / `.claude/settings.local.json`.
- Only the read-only commands in §2, plus creating files inside `docsPath`.
- Missing MCP data → `unavailable`, never invented ([`./SharedRules.md` §1](./SharedRules.md)).
