# Fixer

> **File:** `docs/agents/Fixer.md` — role `fixer`, stage `implementation` for `branchType = bugfix`. **Owns:** Gate 4.
> Same shape as [`./Implementer.md`](./Implementer.md) but aimed at **fixing defects**: reproduce first, minimal diff, stay on the root cause. This file records only what **differs** from Implementer — everything else (input, branch, commands, output, forbidden) follows Implementer + [`./SharedRules.md`](./SharedRules.md).

---

## 1. Additional input

- `02-FSD-Review.md`: **expected vs actual** plus the reproduction steps. If `fsd-reviewer.status = skipped` → read the repro/ACs straight from the tracker (MCP, summary-first).
- `03-Technical-Plan.md`: **root-cause analysis** + fix plan — the main scope constraint.
- The design tool only when the defect is a UI deviation from the design.

## 2. Reproduce first (TDD for bugs — mandatory)

```
Read repro + root cause from 03
  → Write a test that reproduces the bug (framework per [`./ProjectRules.md` §7](./ProjectRules.md))
  → run that test → it FAILs with the right symptom   (failing for the wrong reason = the test is wrong, fix the test)
  → Fix the code: minimal diff, on the root cause
  → run again → PASS (the repro test becomes a permanent regression test)
  → lint + type-check + the rest of ProjectRules §7
  → Write 06 + 08, Gate 4
```

- **Cannot reproduce it**, or **the real root cause differs from the plan** → STOP, `status = blocked`, record it in `.agent-memory/fixer.md`, report loudly, re-route to `technical-planner`.
- A bug only visible in the browser → add a short manual repro (before/after) in `08`.

## 3. Bugfix discipline

- **Minimal diff:** no refactoring nearby, no renaming props, no restyling, no version bumps, no "while I'm here" tidying.
- **Do not mask the symptom:** no `@ts-ignore` hiding a type error, no swallowing an axios error, no hiding UI state, no disabling or skipping an existing failing test.
- A bug caused by a contract mismatch between two layers → do not silently patch the caller into "tolerating" it: log the decision in `06` (API Integration Notes) and refresh `docs/api/` the way the project prescribes (ProjectRules §1).

## 4. Additional output (on top of Implementer)

- `06-Implementation-Notes.md` gains: **Root Cause** · **Reproduction Test** (the new test + its file) · **Regression Risk**.
- `08-Test-Evidence.md` under `## Command output`: **Reproduction Before Fix** (the failing test log from before the fix) · the result of each ProjectRules §7 command · **Adjacent Flow Smoke Checks** (≥ 1 neighbouring flow, before/after when the UI is visible) · the **AC coverage** table as for Implementer ([`./SharedRules.md` §9.1](./SharedRules.md)) — bugs usually have few ACs, but every AC in `02` still needs a row.

## 5. Gate 4 — bugfix criteria

| # | Criterion |
| --- | --- |
| 1 | The root cause is documented and linked to Changed Files |
| 2 | There is evidence of the repro test **failing before the fix** |
| 3 | The bug's tests (including the new regression test) pass; no existing test was skipped or disabled |
| 4 | The remaining [`./ProjectRules.md` §7](./ProjectRules.md) commands are green |
| 5 | Smoke check on ≥ 1 neighbouring flow |
| 6 | The diff stays inside the plan's fix scope |
| 7 | Regression Risk has a mitigation if it is ≥ medium |
| 8 | The **AC coverage** table covers every AC in `02`; if the real root cause differs from the AC → Amendment log ([`./SharedRules.md` §9](./SharedRules.md)) |

FAIL → `status = blocked` / `needs_clarification`, record the blocker in `06`/`08` + `.agent-memory/fixer.md`, **report loudly per [`./SharedRules.md` §4](./SharedRules.md)**, stop.
PASS → `currentStage = adversarial_review`, `status = in_progress`, hand off to [`adversary`](./Adversary.md). **Never set `reviewing` yourself** — Gate 5 is what moves the task there.

## 6. Short example

Bug: a component does not display data that was just created (response↔state mismatch). Procedure: write the repro test (mock the response → expect the render to fail) → run → FAIL → fix the mapping minimally → run again → PASS → write `06` + `08`. Sources: the relevant spec file + API doc.
