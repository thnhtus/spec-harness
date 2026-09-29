---
description: Assess a tracker task, then run it through the repo's docs/ harness (assessment → task folder → worktree if needed → 7 roles, 5 gates), one subagent per stage
argument-hint: <task-url-or-id>
---

You are starting work on a tracker task: **$ARGUMENTS**

Run the task through the **repo `docs/` harness** (7 roles, 5 gates, defined
under `docs/`).

**Order:** preflight (step 0a) → assessment (step 0) → task folder (step 1) → worktree if needed
(step 2) → dispatch each stage. Complexity assessment goes **first** because it
decides the worktree, the model, and how heavy Gate 1/2 run.

No stage is skipped because a change "looks small" — `trivial` only makes
Gate 1–2 **shorter**.

## Architecture: you are the COORDINATOR, not the worker

**Every stage runs as its own subagent, fresh context.** You — the main loop —
do **not** write the FSD, the review, the plan, or the code yourself. Running
every stage in one context is a known failure of this harness (context runs
out → it hangs mid-way).

The CLI does **not** support subagents → run sequentially in the same session,
but between two stages you must **clear the previous stage's context**
(`/clear`, a new session, or the equivalent) and carry over exactly two things:
`task.agent.json` and the last handoff block. Artifacts on disk are the
interface between stages — not the conversation history.

Your responsibilities only:

1. Do **not** read `docs/Agents.md` or any role file: routing, gates and tiers are answered by `--advance` (below). Every file you read is paid again on every later turn.
2. Dispatch one subagent per stage, in order, passing a **small** prompt
   (paths + IDs, never pasted file contents).
3. After each subagent returns, read ONLY:
   - `task.agent.json` (`status`, `currentStage`)
   - the last `## Next Handoff` block of `$TASK/.agent-memory/{role}.md`
4. Gate PASS (`Continue automation: yes`) → dispatch the next stage.
   Gate FAIL → **stop everything** and report loudly (see Gate-fail handling).
5. Never read `01-FSD.md` / `02-FSD-Review.md` / `03-Technical-Plan.md`
   contents into your own context — subagents read them; you route on
   handoffs only.

## Step 0a — Preflight (one command, before everything)

```bash
node scripts/validate-tasks.mjs --preflight || exit 1
```

It catches the CLI opened in the wrong directory (the `git push` deny silently
gone) and a self-contradicting config (every gate a no-op).

Exit `1` → **stop, fix, do not run on**. Warnings (no git / no hook / no CI)
are runnable: tell the user in one line and move on.

## Step 0 — Assessment (before every other decision)

Until you know how heavy the task is, you cannot decide the worktree, the model,
or how heavy the flow runs. So this step goes first — **before the worktree**.

1. **Read the task from the tracker** (the task-read tool of the tracker server
   declared in ProjectRules §1 — find it yourself, do not hardcode the name;
   read the summary only). Take `taskId`, `taskName`, derive `slug` =
   kebab-case with no diacritics.

2. **Pick the repo** (`harness.config.json → repos`). One entry → use it.
   Several entries and the user did not say which → **ask, do not guess**. That
   is `repoName`, and it cannot be changed after bootstrap.

3. **A quick survey to extract the vector** — Glob/Grep, just enough to answer
   the 8 dimensions of [`docs/Agents.md` §5.1](../../docs/Agents.md), do **not**
   read code deeply, do not change anything. The goal is to know what the task
   touches, not to understand all of it.

   Three dimensions must come from a **measurement**, not from the task
   description — write them down so you can fill `complexity.counts` /
   `complexity.questions` in step 1 (the validator cross-checks them against
   the vector and blocks on a contradiction):

   ```bash
   rg -l '<main-symbol>' <src> | wc -l      # → counts.filesTouched  (1 ⇒ scope 0 · 2–5 ⇒ scope ≥ 1 · >5 ⇒ scope 2)
   rg -l '<main-symbol>' <src> -g '*test*'  # → counts.existingTests (0 ⇒ testing ≥ 1)
   ```

   Record `counts.symbol` = the symbol you grepped (the validator requires it,
   ≥3 chars and no spaces so a reviewer can re-run the same `rg`): choosing the
   symbol is choosing the `scope`, so that choice has to be on paper. `0` files
   → write `complexity.note`: a new file or a missed grep — two very different
   things.

   The third dimension has no command: write out the list of *"cannot be done
   without knowing X"* → `questions[]`. Empty ⇒ `uncertainty 0`, any entry ⇒
   `≥ 1`. **You may not conclude "empty" before you went looking** — this is the
   most under-scored dimension, and it is exactly what makes `fsd_review` run
   again. Each entry must be a real question (≥10 chars); `[""]` is rejected.

   `blastRadius` / `reversibility` have no count, but they may not contradict
   what you just scored: `dataImpact 2` ⇒ `reversibility ≥ 2`, `integration 2`
   ⇒ `blastRadius ≥ 1`.

4. **Compute `taskComplexity`** with the §5.1.1 formula (`max(base, riskFloor)`).
   Do not pronounce the label yourself — fill in the vector, let the formula
   produce the label. The validator recomputes it.

   `effort ≥ 9`, or `scope 2` together with `uncertainty 2` → **stop and ask the
   user: can this be split into 2 separately shippable tasks?**
   ([§5.1.4](../../docs/Agents.md)). If it splits, re-run step 0 for each
   sub-task. If it does not, write the reason into `complexity.splitEvaluated` —
   the validator blocks if it is empty, and also if it is a dismissal (`n/a`,
   `no`, anything under 20 characters). Asking here is cheap; asking after
   `retryBudget` is spent means the money is already burned.

5. **Triage** — does this task need the harness at all:

   ```bash
   node scripts/validate-tasks.mjs --triage '<vector JSON>' --branch-type <feature|bugfix|hotfix> --task-id <taskId>
   ```

   `--task-id` is required (exit `2` if missing): without it nothing is written
   to `_triage.log`, and the vector scored here cannot be cross-checked against
   the bootstrap vector. The vector must also be complete — **8 dimensions,
   integer, in range** — `{}` or `{"scope":"2"}` is rejected (exit `2`), not
   treated as `trivial`.

   | Exit | Verdict | What to do |
   | --- | --- | --- |
   | `10` | `harness` | on to step 0b |
   | `0` | `quick-task` / `fix-bug` | **ask the user first**: use that skill, or still run all 7 stages? |

   It reuses the exact vector + `riskFloor` from above, it does not invent a
   second threshold: a task that is not `trivial`, or any risk dimension ≥ 2,
   goes to the harness — however small the diff looks.

   **Taking an escape hatch does not end the task — report back when it ships.**
   A `quick-task` / `fix-bug` run creates no task folder, so `--calibrate` cannot
   see it at all: the thresholds that waved it through are the one part of §5.1.1
   nothing could ever prove wrong. One command closes that loop, at the point the
   work is actually done:

   ```bash
   node scripts/validate-tasks.mjs --escape-outcome <taskId> clean     # no bug came back
   node scripts/validate-tasks.mjs --escape-outcome <taskId> escaped   # a bug from it reached someone else
   ```

   Why `escaped` / `--force` matter: [appendix §A](../../docs/agents/StartTask-Appendix.md#a-escape-hatch-outcome--why-it-matters).

   **Score honestly** — `_triage.log` keeps the lowest score per dimension; lowering one at bootstrap is an error ([appendix §B](../../docs/agents/StartTask-Appendix.md#b-triage-vs-bootstrap-vector--both-directions)).

The result of step 0 decides three things in steps 1–2 below.

## Step 0b — Lease: is anyone else running this task?

A worktree isolates **the code repo's files**. It does not isolate `docs/tasks/` — in layout C every task shares one harness repo. Two `/start-task` runs on the same task (or two machines on the same harness repo) will overwrite each other's handoffs without anyone noticing.

Before bootstrap, put a lease on the task folder:

```bash
TASK={tasksDir}/{groupPrefix}{n}/{taskId}-{slug}
node scripts/lease.mjs acquire "$TASK" || exit 1    # ← the exit 1 is mandatory
```

Exit `1` = another session holds it (it prints the owner to stderr). **Running on is stealing the lease**, and you get two sessions both believing they hold the slot — worse than having no lease at all. Task done (`reviewing`) or gate fail:

```bash
node scripts/lease.mjs release "$TASK"
```

Orphaned lease, design points, limits: [appendix §C](../../docs/agents/StartTask-Appendix.md#c-lease--orphan-design-points-limits).

## Step 1 — Task folder (ALWAYS created, independent of complexity)

The task folder is where evidence is written. A `trivial` task still needs it:
it is the only place that can answer "what was checked" after the session ends.

The folder lives at `{tasksDir}/{groupPrefix}{n}/{taskId}-{slug}/` **in the
harness repo** (the repo holding `harness.config.json`) — even when the code
lives in another repo. `orchestrator` creates it at the bootstrap stage; you
only have to make sure it exists before any stage writes a file.

There is no "small task, no folder needed" exception. With no evidence written,
Gate 4/5 have nothing to check, and the validator blocks at `reviewing`.

## Step 2 — Worktree (CONDITIONAL)

A worktree solves exactly one problem: two sessions writing the same tree. (One
complete stage was lost once because another session's `git stash push -u` swept
away the uncommitted task folder.) A task that does not touch code does not have
that problem.

| Condition | Worktree? |
| --- | --- |
| `taskComplexity = trivial` **and** `blastRadius ≤ 1` **and** no other session running on that repo | **no** — work directly on the current branch |
| Everything else (`normal`/`high`, or a wide blast, or a parallel session) | **yes** |
| User explicitly says "work on the current tree" | **no** |
| User explicitly says "create a worktree" | **yes** |

Not sure whether another session exists → **create the worktree**. Being wrong
in that direction costs a few seconds; being wrong in the other one costs a stage.

Skipping the worktree means `git status --porcelain` **must** be clean before you
start — unsaved user changes → stop and ask. Write `"worktree": false` into
`.agent-memory/orchestrator.md` so a later reader knows why there is none.

Worktree needed → follow [appendix §D](../../docs/agents/StartTask-Appendix.md#d-creating-the-worktree) (create in `repoName`, fix the branch, deps/env, keep it at the end).

## Stage dispatch table

Dispatch each stage through the CLI's subagent mechanism (Claude Code: the
`Agent` tool, `subagent_type` = the role name registered in `.claude/agents/`;
Codex: spawn the custom agent of that name from `.codex/agents/`; Cursor: the
subagent of that name from `.claude/agents/`; Gemini / Qwen / Droid: the
same-named agent from `.gemini/agents/`, `.qwen/agents/`, `.factory/droids/`).
Other CLIs: read the matching role file and run it in a clean context. Every
subagent prompt **must** begin with this preamble:

> Read, in order: `docs/Instructions.md`, then `docs/agents/SharedRules.md`
> **§4 §5 §6 §8** (add **§9** unless you are `orchestrator` — it owns no AC),
> then your role file named below. Run `node scripts/validate-tasks.mjs --contract <stage>`:
> it prints every check your output must pass (files, caps, row formats, handoff).
> Do not read `scripts/validate-tasks.mjs` — the contract is generated from it. Obey the MCP payload
> discipline in SharedRules §8. Work only inside the task folder and the
> files your role owns. **If this is a re-run (`attempts[<stage>] > 1`), read
> only the newest `## Update` / `## Cập Nhật` block of `06`/`08`/`09` plus the last handoff —
> not the whole history; earlier rounds are already distilled there.** When done,
> append your `## Next Handoff` block (≤ 30 lines) to `$TASK/.agent-memory/{role}.md`
> and update `$TASK/task.agent.json`. End your final message with: gate verdict
> (PASS/FAIL), status set, and the one-line reason.

Why sections, not files: [appendix §E](../../docs/agents/StartTask-Appendix.md#e-why-the-preamble-names-sections).

**The model comes from `--advance`** (below): it resolves `taskComplexity` × role ×
attempt through `harness.config.json → baseTier` and `models.<cli>`, lifting one tier per
retry (§5.3.1). Pass the model it prints when dispatching; it prints none → dispatch
without one. Stage 1 (bootstrap) runs before the task exists: its model is
`--tier orchestrator "$COMPLEXITY" --cli "$CLI"`, then set `attempts.bootstrap = 1`. `$CLI` = your CLI (`claude`, `codex`…). The table is for humans; `--preflight`
checks it against the config ([appendix §F](../../docs/agents/StartTask-Appendix.md#f-tier-names-are-cli-agnostic), [§F2](../../docs/agents/StartTask-Appendix.md#f2-retry-tier-rationale)):

| Role | trivial | normal | high |
| --- | --- | --- | --- |
| `orchestrator` | cheap | cheap | mid |
| `fsd-writer` | cheap | mid | mid |
| `fsd-reviewer` | mid | mid | strong |
| `technical-planner` | mid | mid | strong |
| implementer | mid | mid | strong |
| `adversary` | mid | mid | strong |

| # | Stage | subagent_type | Role file | Prompt adds |
| --- | --- | --- | --- | --- |
| 1 | bootstrap | `orchestrator` | `docs/agents/Orchestrator.md` | task URL/id; `repoName` + current branch; **vector + `taskComplexity` from step 0** (it writes them into `task.agent.json` + `00-Metadata.md`, it does not re-score from scratch) |
| 2 | fsd_write → Gate 1 | `fsd-writer` | `docs/agents/FSDWriter.md` | `docsPath` from step 1 |
| 3 | fsd_review → Gate 2 | `fsd-reviewer` | `docs/agents/FSDReviewer.md` | `docsPath` |
| 4 | technical_plan → Gate 3 | `technical-planner` | `docs/agents/TechnicalPlanner.md` | `docsPath` |
| 5 | implementation → Gate 4 | `implementer` (branchType feature/hotfix) or `fixer` (bugfix) | `docs/agents/Implementer.md` / `docs/agents/Fixer.md` | `docsPath`; remind: only files in the Gate-3 list; one-shot commands only |
| 6 | adversarial_review → Gate 5 | `adversary` | `docs/agents/Adversary.md` | `docsPath`; remind: default FAIL, **re-run** the ProjectRules §7 commands yourself instead of trusting `08`, do not touch `src/` |
| 7 | reviewing | — (you) | — | see below |

Gate 5 FAIL → re-dispatch implementer (step 5) **once** with the findings from
`09`; still FAIL the second time → stop, report to the user (Gate-fail handling).
No infinite loop.

**Before EVERY dispatch, one command — it is all the bookkeeping:**

```bash
node scripts/validate-tasks.mjs --advance "$TASK" <stage> --cli "$CLI"   # exit 1 = STOP
```

It runs the validator on this task (Gate FAIL → exit `1`), refuses a skipped stage or a
handoff that says `Continue automation: no` (exit `1`), renews the lease, bumps
`attempts[<stage>]`, closes the previous telemetry entry and opens this one with the
machine's clock and the tier/model it resolved, then prints the role to dispatch, the
model, and the last handoff block. Exit `2` = bad arguments. Do not edit `attempts`,
`telemetry` or the lease yourself. Before step 7: `--advance "$TASK" reviewing` — it closes
the last telemetry entry and dispatches nothing. Why: [appendix §G](../../docs/agents/StartTask-Appendix.md#g-why-validate-after-every-stage), [§H](../../docs/agents/StartTask-Appendix.md#h-why-renew-the-lease-per-dispatch), [§I](../../docs/agents/StartTask-Appendix.md#i-telemetry-fields--what-to-record-and-why).

Step 7 (you, no subagent): `node scripts/lease.mjs release "$TASK"` (step 0b), confirm `task.agent.json` has `status = reviewing`,
run `node scripts/validate-tasks.mjs --quiet` and make sure this task folder reports no
errors (it enforces the AC traceability chain, SharedRules §9).

**Then collect token counts** (Claude Code only; a no-op elsewhere):

```bash
node scripts/collect-telemetry.mjs "$TASK" --write
```

It never overwrites a count that is already there, and it writes nothing when
nothing matches — report what it says rather than filling the gap by hand.

**Then write back to the tracker** — read `harness.config.json` → `tracker.writeBack`:

| value | what you do |
|---|---|
| `off` (default) | nothing; the summary below is the only report |
| `comment` | via the `tracker` MCP server, post **one** comment on the ticket: task doc path, branch, and where the evidence is (`08-Test-Evidence.md`) |
| `status` | the comment **and** move the ticket to `tracker.statusOnReview` |

Then record what you actually did, so the claim is checkable:

```json
"trackerWriteBack": { "at": "2026-09-18T09:20:00Z", "action": "status", "status": "Ready for QC" }
```

Write it **after** the MCP call returns, never before. MCP call failed → leave
the field out and say so in the summary.

Finally, post the summary: what changed (from the implementer's handoff), test
evidence location (`08-Test-Evidence.md`), and the remaining user decisions
(commit / push / MR). **Stop.** Do not commit or push — the user does that
themselves.

## Hard rules for subagent prompts

- Pass **paths and IDs**, never file contents — the subagent reads its own
  inputs from disk/MCP. A bloated dispatch prompt recreates the token problem
  this architecture exists to solve.
- One stage = one subagent call. Do not merge stages "to save time".
- If a subagent returns without having written its handoff block, re-dispatch
  it once with the instruction to complete the handoff; if it fails again,
  treat it as a gate FAIL.

## Gate-fail handling

When any gate fails (`status = blocked` or `needs_clarification`,
`Continue automation: no`):

- Do NOT dispatch the next stage. Do NOT retry in a loop.
- Report to the user, loudly and immediately, all four of:
  1. which gate failed,
  2. why (from the handoff block),
  3. which file holds the blocker details,
  4. exactly what the user/BA must do to unblock.
- `node scripts/lease.mjs release "$TASK"` (step 0b) — the task stopped, so stop holding the slot.
- Stop. Resume later via `docs/HarnessSetup.md` §7 (re-dispatch the stage
  recorded in `currentStage`).

## Constraints (inherited — do not restate to subagents, they read the docs)

- No commit / push / MR unless the user explicitly asks (user commits
  themselves).
- MCP is the source of truth; missing fields are `unavailable`, never
  invented. If an MCP call fails with an auth error: stop and tell the user
  to re-login via `/mcp`.
- Never modify `docs/srs/`, `docs/fsd/`, `docs/api/` content, the
  `docs/tasks/_templates/` originals, or the CLI's config files.
- Watch-mode commands (dev server, test watch, preview — listed in
  ProjectRules §7) are never run by you or any subagent.
- No working-tree-destroying git command, ever — no `git stash` (incl.
  `push -u`), `git checkout -- …`, `git restore`, `git reset --hard`,
  `git clean`. That is the exact command that lost a stage. Need a clean tree
  for a baseline? You already have one: step 0 gave you a fresh worktree.

## Step 7 — clean up merged worktrees

After reporting, run the dry-run in [appendix §J](../../docs/agents/StartTask-Appendix.md#j-step-7--clean-up-merged-worktrees) and report the candidate count. **Delete nothing yourself.**
