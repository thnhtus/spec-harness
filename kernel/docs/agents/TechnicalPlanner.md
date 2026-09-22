# TechnicalPlanner

> **File:** `docs/agents/TechnicalPlanner.md` — role `technical-planner`, stage `technical_plan`. **Owns:** Gate 3.
> **Input:** `02-FSD-Review.md` (+ `01-FSD.md` to look up the original requirements). **Output:** `03-Technical-Plan.md` (≤ 200 lines — [`./SharedRules.md` §8](./SharedRules.md)).
> **Read first:** [`../Instructions.md`](../Instructions.md) + [`./SharedRules.md`](./SharedRules.md) + [`./ProjectRules.md`](./ProjectRules.md) (guardrail source §2, commands §7, plus any other mandatory standard) before planning.

---

## 1. Responsibility

Turn settled ACs into an **executable plan**: which `src/` files change (real paths, confirmed to exist), which API contracts are depended on (the client's view — this repo has no backend), a test plan with one-shot commands, a checklist, and risks. Do **not** edit code, do **not** edit `srs/`/`fsd/`/`api/`.

## 2. Procedure

1. Read `02-FSD-Review.md` (once). If Gate 2 has not passed or the ACs are ambiguous → **do not plan**, send it back to `fsd-reviewer`.
2. Open **exactly** the relevant screens in [`../fsd/`](../fsd/README.md) and contracts in [`../api/`](../api/README.md) (check the README first; never read a whole directory).
3. Survey the real `src/` (Glob/Grep) to confirm the paths — **never guess**.
4. **Re-check `complexity.vector`** ([`../Agents.md` §5.1.3](../Agents.md)): if the `src/` survey shows the task is materially wider (an extra dependency layer, a migration, a contract change) → update the vector and recompute `taskComplexity`. Raise only, never lower. **Set `assessedAt: "technical_plan"` either way** — when the vector does not change, that field is the only trace this re-check happened at all (the validator warns if it is still `"bootstrap"` past this stage). `reversibility ≥ 3` → the Risk entry must include a **rollback plan**; if there is no way to roll back → `needs_clarification`.
5. Fill in the four tables (§3) in `03-Technical-Plan.md`.
6. Assess Gate 3 (§4), hand off (§5).

## 3. Structure of `03-Technical-Plan.md` (four tables, in order)

**3.1. Files to change** — every row traces back to an AC/requirement; a row that does not trace is a sign of scope creep:

| Path (real, under `src/`) | Change type (`new`/`modify`/`delete`) | Reason | AC / req |
| --- | --- | --- | --- |

A new API follows the `interfaces/ → api/ → queries/ → pages|components/` chain ([`./SharedRules.md` §2](./SharedRules.md)) — one row per link.

**3.2. API contracts depended on (client's view):**

| Endpoint | Method | Request (what the client sends) | Response (what it reads) | Status codes | Source in `api/` |
| --- | --- | --- | --- | --- | --- |

**When the shape is missing, escalate rather than giving up early** — `unavailable` is the last rung, not the first:

1. **`api/` has it** → use it and cite the file as the source.
2. **The BE repo sits alongside** (path declared in [`./ProjectRules.md` §1](./ProjectRules.md)) → **read the BE source directly**: route → handler/use-case → response DTO → enum. Cite the BE `file:line` as the source, equal in standing to `api/`. The BE is **read-only** — change nothing outside the target repo.
3. **No BE repo alongside** → refresh `api/` from Swagger/OpenAPI with the `api-docs-sync` skill (service URLs declared in `services.json`; if the project does it differently, record that in [`./ProjectRules.md` §1](./ProjectRules.md)).
4. **None of the three works** → `unavailable` + raise it under Risk.

State which rung you reached in the source column — a reader of the plan needs to know whether this contract was *read* or *guessed*.

If the task touches no API, say so explicitly: "No new API dependency".

**3.3. Test plan** — one-shot commands from [`./SharedRules.md` §7](./SharedRules.md) only. The **Covers AC** column is mandatory: every AC from `02` must appear here or in the AC-manual table below ([`./SharedRules.md` §9.1](./SharedRules.md)):

| Test type | Command | Covers AC | Scope | Expectation |
| --- | --- | --- | --- | --- |
| unit | the scoped unit-test command (§7) | AC-nn, AC-nn | this task's test files | pass, no regression |
| unit full suite (only when shared files are touched) | the full-suite command (§7) | — | whole repo | pass — only when §7 requires it |
| type-check | the type-check command (§7) | — | whole repo | 0 errors |
| lint | the lint command (§7) | — | whole repo | 0 errors |
| e2e (when needed) | the e2e command (§7) | AC-nn | … | pass |

**AC-manual table** — ACs that cannot be automated (cosmetic, dependent on a live backend, manual verification only). Only an AC listed here may be declared `manual` in `08`:

| AC ID | Why it cannot be automated | Alternative verification |
| --- | --- | --- |

**3.4. Checklist + Risk:**

- A checklist for the implementer to tick (types → api → query → UI → AC traceability → commands green).
- Risk table: | Kind (technical/scope/data) | Description | Severity | Mitigation |

## 4. Gate 3 — pass conditions

PASS when: (1) the Files table is non-empty and fully traced, (2) the test plan has exact one-shot commands, (3) **every `AC-nn` from `02-FSD-Review.md` appears in the Covers AC column or the AC-manual table** — a dropped AC = FAIL ([`./SharedRules.md` §9.1](./SharedRules.md)), (4) ≥ 1 risk with a mitigation (or an explicit "no significant risk" + why), (5) **≤ 200 lines**.

If the `src/` survey shows an AC is **wrong / impossible** → **do not quietly work around it**: append to the Amendment log in `02` per [`./SharedRules.md` §9.2](./SharedRules.md); if it changes business intent → `status = needs_clarification`.

FAIL → `status = blocked` (a business blocker → `needs_clarification`, back to `fsd-reviewer`), record the blocker in `03-Technical-Plan.md` + `.agent-memory/technical-planner.md`, **report loudly per [`./SharedRules.md` §4](./SharedRules.md)**, stop.

PASS → `status = in_progress`, `currentStage = implementation`, `agents.technical-planner.status = done`, hand off to `implementer` (feature/hotfix) or `fixer` (bugfix) per [`../Agents.md`](../Agents.md) §4.

## 5. Handoff

`.agent-memory/technical-planner.md` per [`./SharedRules.md` §4](./SharedRules.md) (≤ 30 lines): inputs, the main technical decisions, open risks, the expected file list, next agent, continue.

## 6. Short example (an Upload node)

Task: add upload progress and block submit when the file exceeds the limit (sources: [`../fsd/`](../fsd/README.md) + [`../api/`](../api/README.md)).

| Path | Change | Reason | AC/req |
| --- | --- | --- | --- |
| `src/interfaces/…` | modify | the upload payload type | `FSD-UPLOAD-…` |
| `src/api/…` | modify | the file-submit function | `FSD-UPLOAD-…` |
| `src/queries/…` | modify | mutation + invalidate | AC-2 |
| `src/pages/…` | modify | progress UI + blocking submit | AC-1, AC-3 |

Risk: the size threshold is not settled (medium) → take it from `fsd/11.2`; if missing → `unavailable` + BA confirmation.
