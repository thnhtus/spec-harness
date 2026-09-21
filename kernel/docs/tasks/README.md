# Task docs — layout & how to use the templates

> The AI harness's **task docs** area. Each tracker task gets one directory `{tasksDir}/{groupPrefix}{n}/{taskId}-{slug}/` holding append-only artifacts produced by a gated workflow.
> This file only explains **layout & templates**. Lifecycle/gates: [`../Agents.md`](../Agents.md); shared rules + size caps: [`../agents/SharedRules.md`](../agents/SharedRules.md); resume: [`../HarnessSetup.md`](../HarnessSetup.md) §7.

---

## 1. Layout of one task

```
docs/tasks/
├── README.md              # this file
├── _templates/            # the templates, copied for each new task (§3)
└── sprint-{n}/
    └── {taskId}-{slug}/
        ├── task.agent.json                # machine-readable state
        ├── 00-Metadata.md                 # orchestrator (≤ 80 lines)
        ├── 01-FSD.md                      # fsd-writer — Gate 1 (≤ 250 lines)
        ├── 02-FSD-Review.md               # fsd-reviewer — Gate 2 (≤ 150 lines)
        ├── 03-Technical-Plan.md           # technical-planner — Gate 3 (≤ 200 lines)
        ├── 06-Implementation-Notes.md     # implementer | fixer — Gate 4
        ├── 08-Test-Evidence.md            # real evidence (ProjectRules §7 commands + results)
        ├── 09-Adversarial-Review.md       # adversary — Gate 5 (re-runs it, does not trust 08)
        ├── 01a-…/02a-…-Appendix.md        # (optional) overflow — later stages do NOT read it
        └── .agent-memory/{role}.md        # handoff (≤ 30 lines/block)
```

The size caps are gate conditions — defined in [`../agents/SharedRules.md` §8](../agents/SharedRules.md).

## 2. Which role writes which file

| File | Role | Gate |
| --- | --- | --- |
| `task.agent.json` | created by orchestrator, updated by every role | — |
| `00-Metadata.md` | orchestrator | — |
| `01-FSD.md` | fsd-writer | Gate 1 |
| `02-FSD-Review.md` | fsd-reviewer | Gate 2 |
| `03-Technical-Plan.md` | technical-planner | Gate 3 |
| `06-…` + `08-…` | implementer \| fixer | Gate 4 |
| `09-Adversarial-Review.md` | adversary | Gate 5 |
| `.agent-memory/{role}.md` | each role | — |

## 3. How to use the templates

The orchestrator **copies** `docs/tasks/_templates/` → the task directory and fills in the real values:

- `task.agent.json`: the schema, `status` values and optional fields (`branchActual`, `parentTaskId`) are defined in [`../agents/SharedRules.md` §6](../agents/SharedRules.md). `taskComplexity ∈ {trivial, normal, high}`.
- Files `00-…` → `08-…` are copied as-is; each role opens its own file and **appends**.
- Never edit a file inside `_templates/` while working on a task — change the template only when you intend to change the structure for **every** future task.

## 4. Conventions

- **Append-only**, prose in `harness.config.json → docLanguage`, technical IDs unchanged — details: [`../agents/SharedRules.md` §5](../agents/SharedRules.md).
- `task.agent.json` has **no** token/usage field; it does have `telemetry` (stage · tier · model · timestamps).
- Gate 4 evidence commands: the one-shot list lives in [`../agents/SharedRules.md` §7](../agents/SharedRules.md) — do not copy the command table here.

## 5. Branches & resume

Branch rules (including the `branchActual` exception): [`../agents/SharedRules.md` §3](../agents/SharedRules.md). Resuming an unfinished task: [`../HarnessSetup.md`](../HarnessSetup.md) §7.

## 6. Validating task docs (automatically)

Run `node scripts/validate-tasks.mjs` (no dependencies; it reads `harness.config.json` at the repo root) to check every task folder against the harness conventions:

- `task.agent.json` is valid against the `_templates/task.agent.schema.json` schema (the `status`, `branchType`, `currentStage` enums, the required roles…).
- The group number (`sprintNumber`) / `taskId` / `docsPath` match the folder location; tracker `taskId`s are **not duplicated**.
- The required artifacts exist for the `currentStage` reached (e.g. `01-FSD.md` must exist once `currentStage ≥ fsd_review`).
- Line caps [§8](../agents/SharedRules.md) (00≤80, 01≤250, 02≤150, 03≤200, 06≤250, handoff block ≤30). Once a doc has `## Update — …` / `## Cập Nhật — …` blocks (the task was bounced by a gate) the cap applies to the **newest block**, not the whole file — an append-only doc with a whole-file cap is a closed trap: over the cap, and §5 forbids deleting anything to get back under it.
- `08`/`09` have **no hard cap** (`lineWarn` 400 = a warning). They hold verbatim output; a cap there only forces evidence to be thinned, and `adversary` needs exactly that output to compare against. Passing 400 lines is a signal to split the task, not an error.
- `branchType` ↔ implementer (feature/hotfix → `implementer`; bugfix → `fixer`).
- When `status ∈ {reviewing, mr_created, done}`: `08-Test-Evidence.md` must hold real evidence — a command matching `evidenceCommandPattern` **and** a pass/exit result **inside a ```code fence```**. The word "passed" in the *Expected* column does not count: that is a plan, not a result ([Gate 4](../Agents.md) §3).
- `09-Adversarial-Review.md` must have a verdict (PASS/FAIL/UNCERTAIN), output the adversary **ran itself**, and a "Static layer" table whose *Result when you ran it* column is **not empty** — the file merely existing is not enough. A fence byte-identical to `08` raises a copy-paste warning.
- **Retry budget**: a role with ≥ `retryBudget` handoff blocks (4 by default) → error. Handoff blocks are append-only, so they measure rework independently of `attempts` (which the coordinator self-reports); a mismatch between the two → warning. When the budget runs out, set `status = split` + `splitInto` (≥2 taskIds) to downgrade it to a warning — see `Agents.md` §5.5.
- **AC traceability per stage** ([SharedRules §9.1](../agents/SharedRules.md)): every destination in `acTrace.reachedIn` is checked **as soon as its stage arrives** — an AC dropped from `03-Technical-Plan.md` fails at **Gate 3**, not later at review. Tasks with `updatedAt ≥ the cutoff` → **error**; older ones → **warning**.
- **Handoff** ([SharedRules §4](../agents/SharedRules.md)): any role at `status = done` must have a `### ` block in `.agent-memory/{role}.md` carrying `Next agent` + `Continue automation` — the coordinator routes on those.
- **Gate 2**: no `blocking` + `open` question remains after `fsd_review`.
- **Stage/status agree**: `reviewing` requires `currentStage = reviewing` and every role finished — no jumping a gate.
- **Complexity**: `taskComplexity` must match what `complexity.vector` implies ([Agents.md §5.1.1](../Agents.md)), and each dimension must sit inside its scale (`0–2`, except `blastRadius`/`reversibility` at `0–4`).
- **ACs must exist**: passing `fsd_review` with no AC declared in `02-FSD-Review.md` → error. With no AC the whole traceability chain is meaningless, and an empty task sails straight to `reviewing`.

Exit code `1` when there are errors → usable in a **pre-commit hook** or **CI**. Flags: `--json` (machine-readable), `--no-warn`, `--quiet`, `--self-check` (checks the script's own logic, reads no tasks), `--calibrate` ([Agents.md §5.6](../Agents.md)), `--staged`.

`--staged` checks only the task folders the current commit touches — the pre-commit hook uses it. A task sitting at `blocked` waiting for the BA is a legitimate state; letting it block every unrelated commit in the repo only teaches the team to type `--no-verify`, and a gate bypassed by reflex is a dead gate. **CI still scans the whole repo** — that is where the global view belongs.
