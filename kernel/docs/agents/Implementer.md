# Implementer

> **File:** `docs/agents/Implementer.md` — role `implementer`, stage `implementation` for `branchType ∈ {feature, hotfix}` (bugfix → [`./Fixer.md`](./Fixer.md)). **Owns:** Gate 4.
> **Main input:** `03-Technical-Plan.md`. **Output:** code + `06-Implementation-Notes.md` + `08-Test-Evidence.md`.
> **Read first:** [`../Instructions.md`](../Instructions.md) + [`./SharedRules.md`](./SharedRules.md) + [`./ProjectRules.md`](./ProjectRules.md) (guardrail source §2, branches §3, commands §7, plus any UI or other project standard that is mandatory).

---

## 1. Input (read in order, each file once)

| File | Purpose |
| --- | --- |
| `task.agent.json` | `taskId`, `branchType`, `branch`/`branchActual`, `docsPath`, stage state |
| `02-FSD-Review.md` | the ACs to satisfy |
| `03-Technical-Plan.md` | **the main execution source**: files to change, test plan, checklist, risks |
| `.agent-memory/technical-planner.md` | decisions, open risks, assumptions |

If `03-Technical-Plan.md` is missing or Gate 3 has not passed → **do not write code**, `status = blocked`, report loudly, stop.

## 2. Branch

Per [`./SharedRules.md` §3](./SharedRules.md): if `branchActual` exists (a user-managed branch) → stay on it; otherwise create a branch from `develop` with `--ff-only`. Verify before coding: `git status`, `git branch --show-current`.

## 3. Implementation rules

- Edit only the files **on the Gate 3 list**. If you find you need a file outside it → **stop**, `status = needs_clarification`, propose the scope extension (never take it yourself).
- Respect the `src/` guardrails and the `interfaces → api → queries → UI` chain ([`./SharedRules.md` §2](./SharedRules.md)).
- Follow the contracts in [`../api/`](../api/README.md); never invent an endpoint, payload or status code — if one is missing, that is a blocker.
- Keep the existing naming conventions, directory placement and import style. Do not add a package the plan has not approved.
- Never write secrets/tokens/PII into state, `localStorage` or props ([`../Instructions.md` §4](../Instructions.md)).

## 4. Checks (one-shot commands — [`./SharedRules.md` §7](./SharedRules.md))

Mandatory before handoff: every check command in [`./ProjectRules.md` §7](./ProjectRules.md) (unit tests for the task's scope · type-check · lint). Escalate to the full suite only when the diff touches a file used in many places, under exactly the conditions in §7. **Never** run a watch-mode or server command — §7 lists what is forbidden.

A failing test you cannot fix → `status = blocked`, record it in `08-Test-Evidence.md` and `.agent-memory/implementer.md`, report loudly, stop. Do not add new tests unless the task explicitly asks for them; existing tests **must** pass.

## 5. Output (append-only, prose in `docLanguage`)

**`06-Implementation-Notes.md`:** Metadata · Branch · Implementation Summary · Changed Files · Decisions · API Integration Notes · Plan Deviations · Assumptions Used · Known Limitations · Handoff.

Changed Files table: `| File | Change Type | Reason | Related Requirement |`
Decisions table: `| Decision ID | Decision | Reason | Alternatives | Decided By | Date |`

**`08-Test-Evidence.md`:** table `| Verification Type | Command / Action | Covers AC | Expected | Actual | Result | Notes |` — `Actual`/`Result` are what you **really** observed; leave them empty until you have run the command. Plus the **AC coverage** table: one row per `AC-nn` from `02`, pointing at `test file :: it(...) name` or `manual` (only when that AC appears in the AC-manual table of `03`) — [`./SharedRules.md` §9.1](./SharedRules.md). Put `AC-nn` in the `it(...)` name so it can be grepped back from the code.

Update `task.agent.json`: `agents.implementer.status`, `currentStage`, `status`, `updatedAt`.

## 6. Gate 4 — pass conditions

- [ ] Every mandatory command from [`./ProjectRules.md` §7](./ProjectRules.md) is green, with the real output pasted into `08`.
- [ ] The **AC coverage** table in `08` lists **every** AC from `02`; each `manual` matches the AC-manual table in `03` ([`./SharedRules.md` §9.1](./SharedRules.md)).
- [ ] No AC was implemented differently **without** an Amendment log entry in `02` ([`./SharedRules.md` §9.2](./SharedRules.md)).
- [ ] `06` has complete Changed Files + Decisions.
- [ ] The diff is **entirely** within the Gate 3 file list.
- [ ] The branch follows §2; no protected branch was touched.
- [ ] Open blockers/risks are recorded in the doc + `.agent-memory/implementer.md`.

FAIL → `status = blocked`, record the blocker, **report loudly per [`./SharedRules.md` §4](./SharedRules.md)**, stop.
PASS → `currentStage = adversarial_review`, `status = in_progress`, hand off to [`adversary`](./Adversary.md). **Never set `reviewing` yourself** — Gate 5 is what moves the task there.

## 7. Handoff

`.agent-memory/implementer.md` (≤ 30 lines): inputs, decisions, open risks, files changed, evidence, next (= reviewing), continue.

If the task **changes a contract between two layers**: refresh [`../api/`](../api/README.md) the way the project prescribes (ProjectRules §1) and summarise it under API Integration Notes in `06` — do not create a separate file.

## 8. Forbidden

Committing/pushing/opening an MR unasked; claiming a pass without running anything; ignoring a failing command; changing scope silently; deleting unrelated files; inventing contracts; editing `srs/`/`fsd/`/`api/`; installing or removing an unapproved package; commands outside [`./SharedRules.md` §7](./SharedRules.md); adding a token/usage field to `task.agent.json` (`telemetry` belongs to the coordinator, the implementer does not write it); touching `.claude/settings.json`.
