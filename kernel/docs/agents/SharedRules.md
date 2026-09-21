# SharedRules — Shared rules for every agent (kernel, single source of truth)

> **Document:** `docs/agents/SharedRules.md` — the **normative home** for: handoff format (§4), task doc conventions (§5), `status` values (§6), context/artifact budget (§8), and AC traceability + spec amendments (§9). Other documents **link here**; they never copy the content.
> **The project-owned parts** — sources of truth/tracker, guardrail source, branch rules, check commands — are defined in [`ProjectRules.md`](./ProjectRules.md). The kernel does not know which stack the project uses.
> **Precedence on conflict:** [`../Instructions.md`](../Instructions.md) > SharedRules > ProjectRules > role file (unless the role file says "override" explicitly).
> **Language:** write prose in `harness.config.json → docLanguage`; technical tokens (ENUMs, IDs, commands, paths) stay as they are regardless of that value. The kernel does not choose for you — an English-speaking team sets `"English"`.

---

## 1–3, 7 — see `ProjectRules.md`

The four sections below are project-dependent and live in [`ProjectRules.md`](./ProjectRules.md):

| Section | Contents |
| --- | --- |
| §1 | Sources of truth via tracker/design MCP — never guess |
| §2 | Architecture guardrails for the source |
| §3 | Branch + worktree rules |
| §7 | Valid check commands (one-shot vs watch mode) |

Cross-references inside the kernel that say `SharedRules §1/§2/§3/§7` are still correct — read them in `ProjectRules.md`.

---

## 4. Handoff format — `.agent-memory/{role}.md`

Every role that finishes a stage must append a block (starting with `### YYYY-MM-DD — {role}`), **30 lines maximum**:

```markdown
## Next Handoff
- **Inputs**: sources used (tracker task URL, design node, FR-/FSD- IDs, files read)
- **Decisions**: decisions taken + short reason
- **Risks**: risks / assumptions / "unavailable"
- **Changed Files**: relative paths (empty if no code was touched)
- **Evidence**: evidence (test output, AC quotes, design nodes)
- **Next agent**: the next role (or "skipped: <reason>")
- **Continue automation**: yes | no (no ⇒ include the reason + status)
```

Rules:

- `Continue automation: no` when a gate fails or a BA/user is needed → set the matching `status` and write the blocker explicitly.
- **A stop must be loud:** when stopping for a failed gate or a blocker, the **final message to the user** must carry all four: (1) which gate failed, (2) why, (3) which file records the blocker, (4) what the user/BA must do to unblock. Stopping silently is a process failure.
- Append-only — never delete an older block.

---

## 5. Task doc conventions

Task docs live in `docs/tasks/sprint-{n}/{taskId}-{slug}/` (layout + templates: [`../tasks/README.md`](../tasks/README.md)).

| File | Written by | Contents |
| --- | --- | --- |
| `task.agent.json` | created by orchestrator; updated by every role | machine-readable metadata (§6) |
| `00-Metadata.md` | orchestrator | task summary, tracker/design links, sprint, branchType |
| `01-FSD.md` | fsd-writer | task-level IEEE FSD (skill `document-to-ieee-srs`) |
| `02-FSD-Review.md` | fsd-reviewer | ACs, BA questions, risks |
| `03-Technical-Plan.md` | technical-planner | files to change, test plan, checklist, risks |
| `06-Implementation-Notes.md` | implementer / fixer | decisions taken while coding, files changed |
| `08-Test-Evidence.md` | implementer / fixer | real output of the ProjectRules §7 commands |
| `09-Adversarial-Review.md` | adversary | adversarial check: re-run the commands, inspect diff + tests, findings (Gate 5) |
| `.agent-memory/{role}.md` | each role | handoff (§4) |

- **Append-only**, prose in `docLanguage`, technical IDs unchanged (`FR-…`, `FSD-<MOD>-nnn`, ENUMs, paths, commands).

**Prose has to be readable — use the `humanizer` skill.** Task docs have human readers: the BA reads `02`, another dev reads `06`, a reviewer reads `09`. Before closing a stage, run `humanizer` over **the prose you just wrote**:

| Apply to | Do not apply to |
| --- | --- |
| `02` §3.1 business intent · the reason column in tables | `01` requirements — `shall` is a **mandatory construct** of IEEE 29148, deliberately formulaic |
| `06` Decisions · Plan Deviations · Known Limitations | IDs, paths, commands, verbatim test output |
| `09` finding descriptions · the "what was inspected" section | pure data tables (AC coverage, Changed Files) |
| `.agent-memory/` handoff blocks · gate-failure messages | |

The most common tells in agent-written docs: a one-line closing sentence that restates what was just said, "not X but Y", forced tricolons, decorative bold on every heading, and a scene-setting intro before getting to the point. Cutting those shortens the doc — and shorter means less pressure on the §8 caps.
- **Never edit** the contents of `srs/`, `fsd/`, `api/` — reference them only. `docs/api/` is generated automatically if the project has its own pipeline (ProjectRules §1).
- **Never invent** test numbers (§7).
- `task.agent.json` has **no** token/usage field (vendor data). It does have `telemetry` (stage · tier · model · timestamps) — the coordinator writes it at dispatch and `--calibrate` reads it to weigh cost against outcome ([`../Agents.md` §5.6](../Agents.md)).

---

## 6. `status` values in `task.agent.json`

Main fields: `taskId, taskName, trackerUrl, repoName, sprintNumber, developer, branchType, layer, taskComplexity, currentStage, status, branch, docsPath, agents.{role}.status, createdAt, updatedAt`. **Optional** fields: `branchActual` (the real branch when it differs from the conventional `branch` — §3), `parentTaskId` (parent task on the tracker, if any), `complexity` (the vector + `counts`/`questions`/`splitEvaluated` — [`../Agents.md` §5.1](../Agents.md)), `attempts` (how many times each stage re-ran — §5.5), `outcome` (the result after shipping — §5.6, **filled in by a human when closing the task**).

`taskComplexity ∈ {trivial, normal, high}` is **derived** from `complexity.vector` by the formula in [`../Agents.md` §5.1.1](../Agents.md), never judged freehand; the validator recomputes it and blocks on a mismatch. It decides how heavy Gates 1/2 are (§5.2), which model each stage gets (§5.3), and where the workflow stops to ask a human (§5.4). A later role may only **raise** it, never lower it.

| `status` | When | Action |
| --- | --- | --- |
| `DRAFT` | bootstrap has incomplete metadata | complete it before continuing |
| `in_progress` | a stage is running normally | continue the workflow |
| `blocked` | a gate failed for a technical reason | record the blocker, stop, report loudly (§4) |
| `needs_clarification` | missing MCP data / ambiguous AC | record the question, wait for BA/user, report loudly (§4) |
| `reviewing` | every gate passed **including Gate 5**, diff is clean | wait for the user to approve commit/push + MR |
| `mr_created` | the user pushed, the MR exists | follow review/CI |
| `done` | MR merged | close the task |

Only the user moves `reviewing → mr_created` (a real push + MR).

**Write `task.agent.json` atomically** — write a `.tmp` **in the same directory** then `mv`; do not overwrite in place (a crash mid-write leaves broken JSON and resume goes blind):

```bash
printf '%s' "$NEW" > "$(dirname "$F")/.tmp.json" && mv "$(dirname "$F")/.tmp.json" "$F"
```

When moving to `done`: fill in `outcome` ([`../Agents.md` §5.6](../Agents.md)) — `escapedBugs`, `reworkAfterReview`, `closedAt`. Leave it empty and `--calibrate` has nothing to compare against, which leaves the §5.1.1 thresholds forever at their initial guess.

---

## 8. Context & artifact budget (keeping token use down)

> **Enforced automatically:** `node scripts/validate-tasks.mjs` enforces the caps below plus the `task.agent.json` schema, the per-stage required files, and Gate 4 evidence. Use it in pre-commit/CI; details: [`../tasks/README.md` §6](../tasks/README.md).

**Artifact size caps** (counted in lines; exceeding a cap FAILs that stage's gate).

> **When a gate sends a task back:** docs are append-only (§5) and resuming must append a `## Update — …` heading (the validator splits on `## Update` or `## Cập Nhật`; the marker does not follow `docLanguage`) ([`../HarnessSetup.md` §7](../HarnessSetup.md)) — so after two rounds a whole-file cap becomes a closed trap: over the cap, and not allowed to cut. Therefore, once a doc has `## Update` blocks, the cap applies to the **newest block** (what the current role wrote, and the only part it may shorten); the whole-file total over the cap becomes a **warning** suggesting an appendix split.

**`08`/`09` have no hard cap — deliberately.** They hold **verbatim machine output**, not prose a role wrote: when `01`/`02`/`03` hit a cap you cut explanation and the substance survives; when `08` hits a cap the only thing left to cut is evidence. And [`../Instructions.md` §5](../Instructions.md) is non-negotiable: paste it verbatim. Moving output to an appendix does not work either — an appendix is by definition the part later stages *do not read*, yet `adversary` **must** compare the output it ran itself against what `08` claims ([`./Adversary.md` §3.2](./Adversary.md)), and the validator only counts evidence inside a code fence in that same file. A cap here buys a shorter file by thinning the evidence, which is exactly backwards from what Gates 4/5 are for.

Instead `08`/`09` get a **warning threshold** (`lineWarn`, 400 lines by default): no blocking, just a notice. `08` reaching 400 lines usually means the task is carrying too many ACs — that is a signal to **split the task**, not to write less.

**On a re-run, read the newest block, not the whole history.** A stage sent back by a gate (`attempts > 1`) needs only the newest `## Update` block of `06`/`08`/`09` plus the last handoff; the previous round was already distilled into it. Re-reading everything means paying for the same history repeatedly — the file stays long (it is evidence, it has to be), but nobody has to read all of it again.

| Artifact | Cap | When over |
| --- | --- | --- |
| `00-Metadata.md` | ≤ 80 lines | trim — metadata is not a spec |
| `01-FSD.md` | ≤ 250 lines | move secondary detail to `01a-FSD-Appendix.md` (later stages do **not** read appendices) |
| `02-FSD-Review.md` | ≤ 150 lines | same → `02a-Review-Appendix.md` |

> **Never move to an appendix:** the **AC** table and the **Amendment log** (§9). An appendix is the part later stages *do not read* — an AC or amendment living there is invisible to the planner, the implementer and the validator. Over the cap → cut the survey/explanation, keep these two tables intact.
| `03-Technical-Plan.md` | ≤ 200 lines | move the long survey section to an appendix |
| `.agent-memory/` handoff block | ≤ 30 lines / block | write it more tightly |

**MCP payload discipline:**

> **Never hardcode a tool name.** The kernel does not know which MCP servers the project plugs in — ClickUp or Jira, Figma or Penpot, GitLab or GitHub. The agent **finds a suitable tool itself** from the session's tool list, using the roles declared in [`ProjectRules.md` §1](./ProjectRules.md). Tool names are prefixed per server (`mcp__<server>__<tool>`), so writing one name in stone locks the harness to exactly one tracker.
>
> How to find one: match **role → verb** in the tool name. Need to read a task from the tracker → a tool on the tracker server with `get`/`read`/`task` in its name. Need to find something → `search`. Need to comment → `comment`. Unsure which tool is right, or no tool matches the role → **stop and ask the user**; never guess, never invent substitute data.

This applies to every server, whatever it is called:

- **Tracker:** call the **summary/reduced** form first (tools usually have a `detail_level` or `fields` parameter, or a separate lightweight `get`); fetch the full form only when the summary is missing something that blocks the work. Open attachments/images only when the text description is **not enough** to write the requirement (images are very expensive in tokens).
- **Design tool:** fetch **metadata first** to identify the **smallest** relevant node, then fetch design context for exactly that node. Never fetch context for a whole page/file. Screenshots only when UI behaviour is load-bearing and text cannot describe it.
- **Git host:** query only the branch/MR for this task.

**Internal document reading discipline:**

- Read only the **exact** `fsd/` / `api/` / `srs/` files the task touches (check the index in each directory's README first). Reading a whole directory is **forbidden**.
- A later stage reads the previous stage's artifacts **once**, and does not re-read them absent an update.
- When quoting an artifact into a prompt/handoff: quote the **ID + one line**, never paste the whole passage.

---

## 9. AC traceability & spec amendments (the loop back)

> **Enforced automatically:** `node scripts/validate-tasks.mjs` enforces §9.1 when `status ∈ {reviewing, mr_created, done}`.

### 9.1. Every AC must reach evidence

An `AC-nn` that appears in `02-FSD-Review.md` **must** travel the whole chain:

```
02 (AC-nn)  →  03 "Covers AC" column  or  the AC-manual table
            →  08 "AC coverage" table: test file :: it(...) name   or   manual
```

- **Automated tests** are the default. The `it(...)` name should contain `AC-nn` so you can grep back from the code.
- **`manual`** is only valid when that AC is listed in the **AC-manual** table of `03-Technical-Plan.md` with a reason — you may not declare `manual` in `08` to dodge writing a test.
- A dropped AC (absent from `03`) → **Gate 3 FAIL**. An AC with no row in the `08` AC coverage table → **Gate 4 FAIL**.

### 9.2. If the spec is wrong, fix the spec — do not drift silently

When the technical-planner or implementer finds an AC/requirement that is **wrong, missing, or impossible**:

1. Append a line to the **Amendment log** in `02-FSD-Review.md` (and `01-FSD.md` if it touches an `FSD-<MOD>-nnn`): date, who found it, the ID, old → new, reason.
2. If the amendment **changes scope or business intent** → `status = needs_clarification`, stop and wait for the BA. A purely technical amendment (bad wording, an ID pointing at the wrong thing) → log it and continue.
3. Append-only: do **not** overwrite the original AC line — it stays, and the amendment goes underneath.

Shipping code that diverges from an AC with no amendment is a process failure: the FSD degrades into a historical record and stops being the source of truth.
