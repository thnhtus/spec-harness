# 02 — FSD Review: {taskName}

> Written by `fsd-reviewer` (stage `fsd_review`, **Gate 2**). Read `01-FSD.md` (from `fsd-writer`) + the tracker + the design via MCP; quote `FR-`/`NFR-`/`FSD-` IDs from `srs/` + `fsd/`. Append-only; prose in `harness.config.json → docLanguage`. A missing MCP field is recorded as "unavailable", never invented.

## Acceptance criteria (AC)

> Use real numbers (`AC-01`, `AC-02`, …). `AC-nn` is a **placeholder** — the validator skips it, so an unfilled row does not count as an AC.

| AC ID | Acceptance Criteria | Source | Status | Test Case |
| --- | --- | --- | --- | --- |
| AC-nn |  | FSD §… / FR-… | open | TC-… |

## BA questions

> `Type` and `Status` are ENUMs the validator matches verbatim, not prose: Gate 2
> only sees a row carrying `blocking`/`non-blocking` **and**
> `open`/`answered`/`deferred`. Any other wording (including a translation) is
> reported as unreadable — it does not quietly pass. `docLanguage` applies to the
> Question text, never to these two columns ([`../../agents/SharedRules.md` §5](../../agents/SharedRules.md)).

| Question ID | Question | Type | Status | Owner | Created At | Resolved At |
| --- | --- | --- | --- | --- | --- | --- |
| Q-01 |  | blocking \| non-blocking | open \| answered \| deferred |  |  |  |

## Risk

| Risk ID | Risk | Type | Severity | Mitigation | Owner | Status |
| --- | --- | --- | --- | --- | --- | --- |
| R-01 |  | tech / business | low/medium/high |  |  | open |

## Amendment log

> Append when a later stage (plan / implement) finds an AC or requirement that is **wrong / missing / impossible**. The spec is the source of truth — amend the spec rather than letting the code drift silently. Rules: [`../../agents/SharedRules.md` §9](../../agents/SharedRules.md).

| Date | Found by | AC / FSD ID | Old → new | Reason |
| --- | --- | --- | --- | --- |

## Gate 2 — checklist

- [ ] Business intent is clear
- [ ] ACs are complete, measurable, and sourced (`FR-`/`FSD-`, or an `FSD-<MOD>-nnn` in `01-FSD.md`)
- [ ] No blocking BA question left unresolved

> Gate 2 fails → `status = needs_clarification`, record the blocker here + in `.agent-memory/fsd-reviewer.md`, stop automation.
