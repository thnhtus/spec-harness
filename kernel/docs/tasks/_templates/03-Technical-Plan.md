# 03 — Technical Plan: {taskName}

> Written by `technical-planner` (stage `technical_plan`, **Gate 3**). Point at the screens in `fsd/` and the contracts in `api/`. Append-only; prose in `harness.config.json → docLanguage`.

## Files to change

| File (under `src/`) | Change Type | Reason | Related AC / Req |
| --- | --- | --- | --- |
| `src/pages/…` | new / edit | … | AC-nn |

## API contracts depended on (client's view)

> Contracts this repo **consumes**, not a server implementation. Sources follow the TechnicalPlanner §3.2 ladder: `docs/api/` → BE source in `repos` (read-only) → Swagger → `unavailable`.

| Endpoint | Method | Request | Response | Status Codes | Source (`docs/api/`) |
| --- | --- | --- | --- | --- | --- |
| /… | GET/POST/… | … | … | 200/400/401/… | `../../../api/….md` |

## Test plan

> Every test row must record **which AC it covers** — an AC with no test row = Gate 3 FAIL.

| Test Type | Command | Covers AC | Expected | Notes |
| --- | --- | --- | --- | --- |
| Unit (scope) | `<scoped unit command — ProjectRules §7>` | AC-nn, AC-nn | pass | the default Gate 4 evidence |
| Unit (full) | `<full-suite command>` | — | no regression | **only** when §7 requires it |
| Type-check | `<type-check command>` | — | 0 errors | |
| Lint | `<lint command>` | — | 0 errors | |
| E2E (if needed) | `<e2e command>` | AC-nn | pass | only for important UI flows |
| Build | `<build command>` | — | success | |

**ACs that cannot be covered by an automated test** (manual verification only / cosmetic) → list them here with the reason; this is the valid list from which `08` may mark something `manual`:

| AC ID | Why it cannot be automated | Alternative verification |
| --- | --- | --- |

## Implementation checklist

- [ ] …

## Risk

| Risk ID | Risk | Severity | Mitigation |
| --- | --- | --- | --- |
| R-01 |  | low/medium/high |  |

## Gate 3 — checklist

- [ ] The list of files to change is complete
- [ ] The test plan has concrete one-shot commands + expectations
- [ ] **Every AC in `02-FSD-Review.md` appears in the "Covers AC" column or in the AC-manual table** (no AC dropped)
- [ ] Risks stated + mitigations
