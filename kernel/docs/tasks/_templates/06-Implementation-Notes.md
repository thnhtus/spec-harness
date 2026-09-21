# 06 — Implementation Notes: {taskName}

> Written by `implementer` (feature/hotfix) or `fixer` (bugfix), stage `implementation`, **Gate 4**. Append-only; prose in `harness.config.json → docLanguage`.
> **≤ 250 lines** ([`../../agents/SharedRules.md` §8](../../agents/SharedRules.md)) — this is prose (Decisions, Deviations, Known Limitations) and can be cut. Command output goes in `08`, which has no cap.

## Metadata

- Branch: `<per ProjectRules §3>` (`branchActual` when on a user-managed branch)
- Implementer: `implementer` | `fixer`

## Root Cause *(`fixer` only)*

…

## Changed files

| File (under `src/`) | Change Type | Reason | Related AC / Req |
| --- | --- | --- | --- |
| `src/…` | added / modified | … | AC-… |

## Decisions

| Decision ID | Decision | Reason | Alternatives | Decided By | Date |
| --- | --- | --- | --- | --- | --- |
| D-01 |  |  |  |  |  |

## API Integration Notes

The endpoints this task touches plus the corresponding client/handler files (exact paths per ProjectRules §2). If a contract between two layers changed → refresh `docs/api/` the way the project prescribes (ProjectRules §1) and summarise the contract this task depends on right here.

## Routing / State / UI Notes

- Routing: …
- Data fetching / caching: …
- Component library / styling: …

## Plan Deviations / Assumptions / Known Limitations

…

## Regression Risk *(`fixer` only)*

…

## Handoff

→ When Gate 4 passes → `status = reviewing` (the user approves push + MR). This is the last implementation stage — there is no `api_docs` stage.
