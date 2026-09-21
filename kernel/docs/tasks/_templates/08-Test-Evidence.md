# 08 — Test Evidence: {taskName}

> Written by the implementer (`implementer` / `fixer`), stage `implementation`, **Gate 4**. Paste the **real output** of each command; never claim a pass you have not run. Append-only; prose in `harness.config.json → docLanguage`.
> **The default evidence is a unit run scoped to this task's test files** (fast, low memory); the full suite only when §7 requires it. The list of valid one-shot commands: [`../../agents/ProjectRules.md` §7](../../agents/ProjectRules.md).

## Command output

| Verification Type | Command / Action | Covers AC | Expected | Actual | Result | Notes |
| --- | --- | --- | --- | --- | --- | --- |
| Unit (scope) | `<scoped unit command>` | AC-nn, AC-nn | …/… passed | | | the default Gate 4 evidence |
| Unit (full) | `<full-suite command>` | — | no regression | | | **only when** §7 requires it — leave blank otherwise |
| Type-check | `<type-check command>` | — | 0 errors from the diff | | | |
| Lint | `<lint command>` | — | 0 new errors in scoped files | | | |
| Build | `<build command>` | — | success | | | when the plan requires it |
| E2E (if applicable) | `<e2e command>` | AC-nn | …/… passed | | | |

### AC coverage

Every `AC-nn` in `02-FSD-Review.md` must have **exactly one** row here. `manual` is only valid when that AC is already in the **AC-manual** table of `03-Technical-Plan.md`.

| AC ID | Covered by (test file :: `it(...)` name) or `manual` | Result |
| --- | --- | --- |
| AC-nn | `src/test/…::<test name>` | PASS |

### Reproduction Before Fix *(`fixer` only)*

Output showing the repro test **failing** before the fix.

A red test here is **deliberate**, but Gate 4 blocks any failing output — so declare it by putting this line immediately above the block:

```
<!-- known-failure: AC-nn reproduction before the fix -->
```

Without the declaration the gate goes red; and if that pushes you to delete the red output, you have deleted exactly the reproduce-first evidence the gate wanted.

### Output / Log

Run through the wrapper so the block carries its own attestation (`exitCode`/`durationMs`/`gitRev`/`startedAt`):

```bash
node scripts/run-evidence.mjs --append <task-folder>/08-Test-Evidence.md -- <a ProjectRules §7 command>
```

```
# the real output + the attestation block get appended here
```

## Gate 4 — checklist

- [ ] Scoped unit tests pass — including new / regression tests
- [ ] Full suite — **only** when §7 requires it (otherwise mark N/A)
- [ ] Type-check clean (for the diff)
- [ ] Lint clean (0 new errors in scoped files)
- [ ] **The AC coverage table lists every AC from `02`; each `manual` matches the AC-manual table in `03`**
- [ ] **No AC was implemented differently** — if one was, an *Amendment* block was appended to `01`/`02` (SharedRules §9)
- [ ] The diff stays inside the plan's scope (nothing out of scope changed)

> Gate 4 fails → `status = blocked`, record the blocker + `.agent-memory/{role}.md`.
