# 00 — Metadata: {taskName}

> Written by `orchestrator` at the bootstrap stage. Append-only; prose in `harness.config.json → docLanguage`.

## Task information

| Field | Value |
| --- | --- |
| Task ID | `{taskId}` |
| Task URL | {trackerUrl} |
| Task name | {taskName} |
| Sprint | {sprintNumber} |
| Repo | <repo> |
| Developer | {developer} |
| branchType | {branchType} (`feature` / `bugfix` / `hotfix`) |
| layer | {layer} (from `repos[].layer` of the selected repo) |
| taskComplexity | {taskComplexity} (`trivial` / `normal` / `high`) |
| Branch | `<per ProjectRules §3>` |
| Target branch | develop |

## Source links (MCP)

| Source | Link / ID | Note |
| --- | --- | --- |
| Tracker task | {trackerUrl} | the requirement source |
| Design tool | unavailable | fill in if a design exists |
| Related SRS | `../../../srs/…` | the relevant module |
| Related FSD | `../../../fsd/…` | the relevant screen / node |

## Pre-flight (orchestrator)

- [ ] MCP ready — every server declared in ProjectRules §1 (`claude mcp list`)
- [ ] `cwd` is the repo named by `repoName` (config `repos`), current branch is not protected
- [ ] git user configured
- [ ] Enough metadata derived (taskId, sprint, branchType)
- [ ] Complexity scored (table below)

## Complexity (Agents.md §5.1)

> Fill in the **vector**; do not judge the score freehand. `taskComplexity` comes from the §5.1.1 formula — the validator recomputes it, and a mismatch is an error.

| Dimension | 0 | 1 | 2 | Score |
| --- | --- | --- | --- | --- |
| scope | 1 file | a few files, 1 module | several modules/layers | |
| uncertainty | fully clear | derivable | must ask the BA | |
| dependency | none | an existing module | another service/repo | |
| dataImpact | untouched | read/write via an existing API | schema · migration · shared shape | |
| integration | none | an existing API | new/changed contract · external system | |
| testing | covered by existing tests | ordinary new tests | hard to reproduce · e2e/manual | |

**effort = total (0–12):** {n}

**The measurements behind that score** (the validator cross-checks them; missing is an error): `counts.symbol` = `{the symbol you grepped — ≥3 chars, no spaces, so a reviewer can re-run the same rg}` · `counts.filesTouched` = {n — `1` ⇒ scope 0 · `2–5` ⇒ scope ≥ 1 · `>5` ⇒ scope 2} · `counts.existingTests` = {n} · `questions[]` = {the list of "cannot proceed without knowing X"; each entry a real question (≥10 chars), empty only if you actually went looking}

| Risk dimension | Scale | Score |
| --- | --- | --- |
| blastRadius | 0 one spot · 1 module · 2 feature · 3 service · 4 whole system | |
| reversibility | 0 just edit again · 1 revert · 2 redeploy · 3 data repair · 4 irreversible | |

> These two have no measurement to check them against, and on their own they can drag a task from `trivial` to `high`. This is the one place still resting mostly on judgement — do not score it to get it over with. Two coherence rules are enforced anyway, because they are arithmetic on what you already wrote: `dataImpact = 2` ⇒ `reversibility ≥ 2`, and `integration = 2` ⇒ `blastRadius ≥ 1`.

**→ `taskComplexity` = {trivial\|normal\|high}** · write the vector into `task.agent.json → complexity`
