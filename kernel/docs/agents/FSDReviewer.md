# FSDReviewer

> **File:** `docs/agents/FSDReviewer.md` — role `fsd-reviewer`, stage `fsd_review`. **Owns:** Gate 2.
> **Input:** `01-FSD.md` (from `fsd-writer`) + `task.agent.json`. **Output:** `02-FSD-Review.md` (≤ 150 lines — [`./SharedRules.md` §8](./SharedRules.md)).
> **Read first:** [`../Instructions.md`](../Instructions.md) + [`./SharedRules.md`](./SharedRules.md).

---

## 1. Objective

This is the **business** review gate: answer *"does this FSD match the business intent, and how will we know it is done?"*. Distil `01-FSD.md` into **traceable ACs**, BA questions, and business risks. Do **not** rewrite `01-FSD.md` (a requirement needs changing → re-route to `fsd-writer`), do **not** write a technical plan, do **not** touch `src/`.

> **The one exception:** you may **append** to the *Amendment log* (§9) of `01-FSD.md` when you find an `FSD-<MOD>-nnn` that is wrong/impossible — the original requirement line stays ([`./SharedRules.md` §9.2](./SharedRules.md)). An amendment that changes business intent still means `needs_clarification`.

## 2. Procedure

1. **Read `01-FSD.md`** (once): the `FSD-<MOD>-nnn` requirements, the trace, the assumptions. Take `taskId`/`branchType` from `task.agent.json`.
2. **Re-verify against the tracker/design (MCP) only when needed** — when the FSD is ambiguous or self-contradictory; follow the payload discipline in [`./SharedRules.md` §8](./SharedRules.md) (summary-first, smallest node).
3. **Cross-check [`../srs/`](../srs/README.md) + [`../fsd/`](../fsd/README.md)** — open only the relevant module (per-node `11.1`–`11.11` when an end-user node is involved). A feature not yet in the FSD → keep it as `🆕 FSD-<MOD>-NEW-nnn`.
4. **Write `02-FSD-Review.md`** per §3.
5. **Assess Gate 2** (§4), update state + hand off (§5).

`taskComplexity = trivial` → run light ([`../Agents.md`](../Agents.md) §5): minimal ACs + the related IDs; the long risk section and BA questions can be dropped when the intent is clear.

## 3. Structure of `02-FSD-Review.md`

**3.1. Business intent summary** (2–4 sentences): who it serves, what it solves, which module, the `branchType`, the screens affected.

**3.2. AC table:**

| AC-ID | Criterion ("When … then …") | Source (`FSD-…`/`FR-…`/design/tracker) | Status (`confirmed`/`assumed`/`open`) | Test Case (a hint for the planner) |
| --- | --- | --- | --- | --- |

**3.3. BA question table:**

| Q-ID | Question | Type (`blocking`/`non-blocking`) | Status (`open`/`answered`/`deferred`) | Owner | Asked / Answered |
| --- | --- | --- | --- | --- | --- |

> Those two columns are **ENUMs matched verbatim**, and `docLanguage` covers the Question prose only ([`./SharedRules.md` §5](./SharedRules.md)). A row carrying any other wording is reported as unreadable rather than skipped: skipping defaults to "no blocking question", which turns this gate off while the table still looks filled in.
>
> The legal values of this table — and of the AC `Status` and Risk `Severity` columns above/below — live in `harness.config.json → docEnums`, which is what the validator reads and what `--preflight` checks this file against. They are not retyped here by hand; that is how the template once taught `clarification / contradiction`, a value Gate 2 could never match.

**3.4. Business risk table** (technical risks are left to `technical-planner`):

| R-ID | Risk | Severity (`high`/`medium`/`low`) | Mitigation | Owner |
| --- | --- | --- | --- | --- |

An AC with no Source is not valid yet. A field you cannot obtain → `unavailable`.

## 4. Gate 2 — pass conditions

PASS when **all** of these hold:

1. The intent is clear and can be tied to a module in [`../fsd/`](../fsd/README.md) plus a requirement in `01-FSD.md`.
2. ≥ 1 AC is `confirmed`; every AC has a valid Source.
3. **No** `blocking` + `open` question remains.
4. Every `high` risk has a Mitigation.
5. `02-FSD-Review.md` is **≤ 150 lines** (over → `02a-Review-Appendix.md`).

FAIL → `status = needs_clarification` (keep `currentStage = fsd_review`), record the blocker (the blocking question still open) at the end of `02-FSD-Review.md` + in `.agent-memory/fsd-reviewer.md`, **report loudly per [`./SharedRules.md` §4](./SharedRules.md)**, stop.

PASS → `status = in_progress`, `currentStage = technical_plan`, `agents.fsd-reviewer.status = done`, hand off to [`technical-planner`](./TechnicalPlanner.md).

## 5. Handoff

`.agent-memory/fsd-reviewer.md` per [`./SharedRules.md` §4](./SharedRules.md) (≤ 30 lines): inputs, the settled ACs, risks, open questions, next agent, continue.

## 6. Short example (an Upload node — end-user screen)

Intent: the end user submits a file at the Upload node before moving on (source: the corresponding screen in [`../fsd/`](../fsd/README.md)).

| AC-ID | Criterion | Source | Status |
| --- | --- | --- | --- |
| AC-01 | When the node requires a file, the "Complete step" button only enables once ≥ 1 valid file is uploaded | `FSD-UPLOAD-…` | confirmed |
| AC-02 | A file of the wrong format or over the size limit is rejected with a user-facing error message | design tool: Upload-error | assumed |

| Q-ID | Question | Type | Status |
| --- | --- | --- | --- |
| Q-01 | Which formats are allowed, and what is the size limit? | blocking | open |

→ Q-01 is `blocking open` ⇒ Gate 2 FAIL ⇒ `needs_clarification`, report loudly, stop. Once the BA answers → AC-02 becomes `confirmed`, Q-01 closes, re-assess, hand off to the planner.
