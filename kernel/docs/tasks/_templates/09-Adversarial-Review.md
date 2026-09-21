# 09 — Adversarial Review: {taskName}

> Written by `adversary` (stage `adversarial_review`, **Gate 5**). FAIL is the default — a PASS has to be earned with evidence this role gathered itself. Append-only; prose in `harness.config.json → docLanguage`.
> **The output here must be what this role ran ITSELF**, never copied from `08-Test-Evidence.md`.

**Result: PASS | FAIL | UNCERTAIN** · {date}

## Static layer — re-run it yourself

| Command (ProjectRules §7) | Result claimed in `08` | Result when you ran it | Match? |
| --- | --- | --- | --- |
| `<command>` |  |  | ✔ / ✘ |

## Scope — diff vs the Gate 3 list

```
# git diff --stat <base>...HEAD
```

| File in the diff | In `03`? | Declared under Plan Deviations in `06`? | Finding |
| --- | --- | --- | --- |

## AC — does the test actually assert it

| AC | Test claimed in `08` | Asserts the state after the action? | Change a constant → does the test go red? | Conclusion |
| --- | --- | --- | --- | --- |
| AC-nn |  | yes / no | yes / no / not tried | met / not met |

## Findings

| # | Severity | Description | Expected | Actual | Source (file:line / log / screenshot) |
| --- | --- | --- | --- | --- | --- |
| F-01 | BLOCKING / NON-BLOCKING / UNCERTAIN |  |  |  |  |

## What was inspected

> "Found nothing" only means something when you say where you looked. List the paths you walked.

- …

## Limits of this review

> What you could **not** check (no e2e, no account, depends on an external system) — state it plainly, do not leave it empty.

- …

## Gate 5 — checklist

- [ ] Every ProjectRules §7 command is green **when you run it**, with the real output pasted above
- [ ] Every AC in `02` has a row in `08` **and** its test genuinely asserts the AC
- [ ] The diff is within the Gate 3 scope; anything outside it is declared under Plan Deviations
- [ ] No BLOCKING finding
- [ ] No UNCERTAIN left unanswered by the user

> FAIL → `status = blocked`, record the findings here + in `.agent-memory/adversary.md`, report loudly, re-route to the implementer.
> PASS → `status = reviewing`, stop and wait for the user.
