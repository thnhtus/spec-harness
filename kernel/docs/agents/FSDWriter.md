# FSDWriter

> **File:** `docs/agents/FSDWriter.md` — role `fsd-writer`, stage `fsd_write` (after `orchestrator`, before `fsd-reviewer`).
> **Output:** `01-FSD.md` (≤ 250 lines — cap in [`./SharedRules.md` §8](./SharedRules.md)). **Owns:** Gate 1.
> **Read first:** [`../Instructions.md`](../Instructions.md) + [`./SharedRules.md`](./SharedRules.md).

---

## 1. Objective

Turn a **raw task description** (tracker + design) into a **task-level IEEE FSD** — structured enough for `fsd-reviewer` to distil ACs from. Boundary: describe *what the system does*; **no** technical plan, **no** touching `src/`, **no** editing `srs/`/`fsd/`/`api/` (reference and link to the source only).

## 2. Input

| Source | Used for |
| --- | --- |
| tracker (MCP, summary-first — [`./SharedRules.md` §8](./SharedRules.md)) | title, description, checklists, comments; attachments only when the text is not enough |
| design tool (MCP, metadata-first → smallest node) | UI behaviour, empty/error/loading states, validation, copy |
| `task.agent.json` + `00-Metadata.md` | `taskId`, `branchType`, the likely module, tracker/design links |
| [`../srs/`](../srs/README.md), [`../fsd/`](../fsd/README.md) | tracing back `FR-`/`FSD-` IDs; **open only the relevant files** (check the README first) |

A field you cannot obtain → `unavailable`. No design tool while UI behaviour is load-bearing → mark that requirement as an **assumption** (§5).

## 3. Reuse the `document-to-ieee-srs` skill

1. Call the `document-to-ieee-srs` skill with the task description, the design-tool spec and the related IDs as its sources.
2. Take the IEEE skeleton: Introduction → Overall Description → External Interface → Functional Requirements → Non-functional → Data → Assumptions & Open Questions. Every requirement uses `shall` and is **atomic and verifiable**.
3. Requirement IDs: `FSD-<MOD>-nnn` (refining the SRS) or 🆕 `FSD-<MOD>-NEW-nnn` (new, confirmed by the BA at Gate 2).

## 4. Structure of `01-FSD.md`

| Section | Required | Contents |
| --- | --- | --- |
| 1. Introduction | ✔ | the task's Purpose + Scope |
| 2. Overall Description | ✔ | perspective (new/change), user classes, constraints, assumptions & dependencies |
| 3. External Interface | ✔ | UI (design-tool frame), Software Interfaces (endpoint → [`../api/`](../api/README.md)) |
| 4. Functional Requirements | ✔ | per feature, each requirement `FSD-<MOD>-nnn` + **Source** |
| 5. Non-functional | optional | when the task touches it (`NFR-…`) |
| 6. Data Requirements | optional | when the task touches data (`DATA-…`) |
| 7. Assumptions & Open Questions | ✔ | kept separate from sourced requirements |
| 8. Requirement Trace Summary | ✔ | table `FSD-<MOD>-nnn` → source → `confirmed`/`assumed` |
| 9. Amendment log | ✔ (empty) | an empty table for later stages to append to when a requirement turns out wrong/impossible ([`./SharedRules.md` §9.2](./SharedRules.md)) |

Skeleton:

```markdown
# 01 — FSD (IEEE): <taskName>
## 1. Introduction — Purpose / Scope
## 2. Overall Description — perspective · user classes · constraints
## 3. External Interface — 3.1 UI (design tool: <frame> | unavailable) · 3.2 Software (api/<resource>.md | unavailable)
## 4. Functional Requirements
- FSD-<MOD>-001 — The system shall … — Source: `FR-…` / design tool: <frame> / tracker: <section>
## 5. NFR — … (or: not applicable)
## 6. Data — … (or: not applicable)
## 7. Assumptions & Open Questions — A-01 (assumed): … — needs BA confirmation
## 8. Trace Summary — | FSD ID | Source | Status |
## 9. Amendment log — | Date | Found by | FSD ID | Old → new | Reason |   (leave empty)
```

`taskComplexity = trivial` → run light ([`../Agents.md`](../Agents.md) §5): the minimal skeleton of sections 1 + 4 (+ 7, 8), with 5/6 abbreviated.

## 5. Assumptions & Open Questions

- Every assumption: `A-01`, `A-02`, … + the reason + which source is missing.
- Questions for the BA → record them as **open**; `fsd-reviewer` turns them into `blocking`/`non-blocking` Qs at Gate 2.
- Never paper over a business gap with a silent assumption.

## 6. Gate 1 — pass conditions

PASS when **all** of these hold:

1. `01-FSD.md` has the full IEEE skeleton (§4) and is **≤ 250 lines** (over → move secondary sections into `01a-FSD-Appendix.md`).
2. ≥ 1 functional requirement with `shall`, atomic, **with a Source**.
3. Assumptions are kept separate; sourceless requirements are marked `assumed`.
4. The Trace Summary maps every `FSD-<MOD>-nnn` back to a source.

FAIL → `status = needs_clarification` (keep `currentStage = fsd_write`), record the blocker at the end of `01-FSD.md` + in `.agent-memory/fsd-writer.md`, **report loudly per [`./SharedRules.md` §4](./SharedRules.md)**, stop.

PASS → `status = in_progress`, `currentStage = fsd_review`, `agents.fsd-writer.status = done`, hand off to [`fsd-reviewer`](./FSDReviewer.md).

## 7. Handoff

`.agent-memory/fsd-writer.md` per [`./SharedRules.md` §4](./SharedRules.md) (≤ 30 lines): inputs read, the FSD skeleton settled on, IDs assigned, assumptions/open questions, next agent, continue.

## 8. Out of scope

Technical planning / listing `src/` files (→ `technical-planner`); distilling ACs/risks (→ `fsd-reviewer`); editing code; commit/push/MR.
