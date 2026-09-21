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

No stage is skipped because a change "looks small" — `taskComplexity = trivial`
makes Gate 1–2 run **shorter**, it does not delete them.

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

1. Read `docs/Agents.md` **§2 (lifecycle) + §3 (gates) + §4 (routing)** — you do not need the role files, and §5 (complexity) only if step 0 has not already produced the vector.
2. Dispatch one subagent per stage, in order, passing a **small** prompt
   (paths + IDs, never pasted file contents).
3. After each subagent returns, read ONLY:
   - `task.agent.json` (`status`, `currentStage`)
   - the last `## Next Handoff` block of `.agent-memory/{role}.md`
4. Gate PASS (`Continue automation: yes`) → dispatch the next stage.
   Gate FAIL → **stop everything** and report loudly (see Gate-fail handling).
5. Never read `01-FSD.md` / `02-FSD-Review.md` / `03-Technical-Plan.md`
   contents into your own context — subagents read them; you route on
   handoffs only.

## Step 0a — Preflight (one command, before everything)

```bash
node scripts/validate-tasks.mjs --preflight || exit 1
```

Two failures only surface very late if you do not ask: the CLI opened in the
wrong directory (losing `settings.json` → losing the deny on `git push` /
`reset --hard`, **silently**), and a self-contradicting config (every gate a
no-op, found out a few dozen tasks later). Both are far cheaper than running a
task under a dead gate.

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
   rg -l '<main-symbol>' <src> | wc -l      # → counts.filesTouched  (1 ⇒ scope 0 · >5 ⇒ scope 2)
   rg -l '<main-symbol>' <src> -g '*test*'  # → counts.existingTests (0 ⇒ testing ≥ 1)
   ```

   Record `counts.symbol` = the symbol you grepped (the validator requires it):
   choosing the symbol is choosing the `scope`, so that choice has to be on
   paper. `0` files → write `complexity.note`: a new file or a missed grep —
   two very different things.

   The third dimension has no command: write out the list of *"cannot be done
   without knowing X"* → `questions[]`. Empty ⇒ `uncertainty 0`, any entry ⇒
   `≥ 1`. **You may not conclude "empty" before you went looking** — this is the
   most under-scored dimension, and it is exactly what makes `fsd_review` run
   again.

4. **Compute `taskComplexity`** with the §5.1.1 formula (`max(base, riskFloor)`).
   Do not pronounce the label yourself — fill in the vector, let the formula
   produce the label. The validator recomputes it.

   `effort ≥ 9`, or `scope 2` together with `uncertainty 2` → **stop and ask the
   user: can this be split into 2 separately shippable tasks?**
   ([§5.1.4](../../docs/Agents.md)). If it splits, re-run step 0 for each
   sub-task. If it does not, write the reason into `complexity.splitEvaluated` —
   the validator blocks if it is empty. Asking here is cheap; asking after
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

   The user wants the harness even though the verdict is an escape hatch → just
   run it, nothing else needed. The other direction (verdict `harness` but the
   user wants to skip) → `--force "<reason>"`. Skipping the harness is a valid
   decision; skipping it without leaving a trace is not.

   **Score honestly, do not score toward the answer you want.** Every triage
   goes into `_triage.log`, and the validator cross-checks it against the stored
   vector in **both directions**: scoring low here then high at bootstrap →
   warning (adjusting upward after the survey is normal, §5.1.3 — the warning
   only makes it explicit that the lower number is the one that decided whether
   this task needed the harness); the reverse, **lowering** a dimension below its
   triage value, is an **error** — that is the direction §5.1.3 forbids.

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

Stuck on an orphaned lease and unwilling to wait 30 minutes: deleting that task's `.agent-memory/.lease.d` directory outright is safe.

**Written in Node, not bash** — `mkdir -p`, `find -mmin`, `hostname`, `$$` do not exist on PowerShell/cmd, and step 0b runs **before** everything else: breaking it breaks the whole command. `node` is already mandatory anyway, because the validator needs it.

Three design points, written down so nobody "optimizes" them away:

- **`mkdir`, not check-then-write.** The gap between "check" and "write" is exactly the race the lease exists to prevent; `mkdir` fails-if-exists in **one** syscall. (`recursive: true` does **not** throw when it already exists → the whole effect is gone.)
- **A missing `owner` file defaults to *alive*.** Between `mkdir` and writing `owner` there is a few-ms window where the directory exists but `owner` does not. Reading "no owner yet" as "dead" means every session landing in that window steals a live session's lease — measured on the old bash version: 20 parallel sessions, 7 of them stole it. Only when the **directory** is also past 30 minutes is it a genuine orphan.
- **A lease older than 30 minutes = dead**, takeable (the previous session hung or was Ctrl-C'd).

Verify: `node scripts/lease.mjs --self-check` (asserts all four cases, including the two `mkdir`→write window cases). Real parallel measurement: 30 rounds × 20 sessions → exactly 30 winners.

This is an optimistic lease, not a distributed lock: it catches the common case (two sessions, one task) with one atomic `mkdir`, and does not handle NFS or clock skew between two machines. Enough at this scale.

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

### When there is a worktree

The worktree is always created **in the repo that will be modified**
(`repoName`), not the repo holding the config
([`docs/Agents.md` §0](../../docs/Agents.md)):

| `repos` | Worktree in | Task docs |
| --- | --- | --- |
| one entry `path: "."` | this repo | follows the worktree |
| several entries, `repoName` is `"."` | this repo | follows the worktree |
| `repoName` points at another repo | that repo | **stays in the harness repo** |

1. Create a worktree named `task-{taskId}-{slug}` (truncate `slug` so the whole
   name is ≤ 64 characters). If the CLI has its own worktree tool (Claude Code:
   `EnterWorktree`), use it; otherwise
   `git -C <repo-path> worktree add .claude/worktrees/task-{taskId}-{slug}`
   then `cd` into it.

2. **Fix the branch immediately** — the tool names it `worktree-{name}` branched
   off `origin/HEAD`, which usually does not match ProjectRules §3:

   ```bash
   git status --porcelain          # must be empty — the worktree was just created
   git fetch origin
   git switch -C <branch-formula ProjectRules §3> origin/<target-branch>
   git branch -D worktree-task-{taskId}-{slug}
   ```

   `switch -C` is safe here and **only** here: the tree is freshly created and
   empty. Any output from `git status --porcelain` → **stop, ask the user**.

3. **Set up what the worktree needs that is not in git** (installed
   dependencies, env files) — follow ProjectRules §7 for how. Two general rules:

   - **Do not symlink the dependency directory** if the toolchain writes
     incremental build state into it: two worktrees sharing state → phantom
     errors. A copy-on-write clone (`cp -c` on APFS, `cp --reflink=auto` on
     Linux) is just as cheap and shares no files.
   - **Env files**: symlinkable (static, already in `.gitignore`). **Security
     warning:** the env contents reach every process the agent starts.

   Static gates (type-check, lint, scoped unit tests) usually do **not** need the env.

4. Task done (`status = reviewing`) → leave the worktree but **keep** it
   (Claude Code: `ExitWorktree action: "keep"`; other CLIs: `cd` back, do not
   `worktree remove`), and tell the user the path. Code in the worktree, task
   docs in the harness repo (layout C) = **two commits, two repos**.

> **A test lock is per-machine, not per-worktree.** If the project blocks
> parallel runs with a machine-wide lock (to avoid OOM), a worktree does **not**
> lift that lock — a worktree isolates *files*, not CPU/RAM. That is correct
> behaviour, do not "fix" it.

## Stage dispatch table

Dispatch each stage through the CLI's subagent mechanism (Claude Code: the
`Agent` tool, `subagent_type` = the role name registered in `.claude/agents/`).
Other CLIs: read the matching role file and run it in a clean context. Every
subagent prompt **must** begin with this preamble:

> Read, in order: `docs/Instructions.md`, then `docs/agents/SharedRules.md`
> **§4 §5 §6 §8** (add **§9** unless you are `orchestrator` — it owns no AC),
> then your role file named below. Obey the artifact size caps and MCP payload
> discipline in SharedRules §8. Work only inside the task folder and the
> files your role owns. **If this is a re-run (`attempts[<stage>] > 1`), read
> only the newest `## Update` / `## Cập Nhật` block of `06`/`08`/`09` plus the last handoff —
> not the whole history; earlier rounds are already distilled there.** When done,
> append your `## Next Handoff` block (≤ 30 lines) to `.agent-memory/{role}.md`
> and update `task.agent.json`. End your final message with: gate verdict
> (PASS/FAIL), status set, and the one-line reason.

The preamble names **sections**, not whole files: the floor of rules every subagent reads is multiplied by every stage of every task, so one surplus section is a cost paid six times. This is the cheapest place to cut — one line changed, the kernel untouched, "one normative home" preserved. The real number is modest: only `orchestrator` can drop §9 (~580 tok), the other six roles all use it. Do not cut deeper on instinct — §8 is the longest section but every role needs it.

**Pick the model from `taskComplexity`.** After orchestrator finishes, read
`taskComplexity` from `task.agent.json` and pass `model` when dispatching each
stage, per the table in [`docs/Agents.md` §5.3](../../docs/Agents.md). Cheap for
read-and-copy work, strong for judgement:

| Role | trivial | normal | high |
| --- | --- | --- | --- |
| `orchestrator` | cheap | cheap | mid |
| `fsd-writer` | cheap | mid | mid |
| `fsd-reviewer` | mid | mid | strong |
| `technical-planner` | mid | mid | strong |
| implementer | mid | mid | strong |
| `adversary` | mid | mid | strong |

Tier → real model name is looked up in `harness.config.json → models`
(`{ "cheap": …, "mid": …, "strong": … }`). The kernel does not know which CLI
you run, so it only speaks in tiers — switching Claude ↔ Codex ↔ Gemini means
editing those three lines, this table does not change.

`models` empty `{}`, or the CLI cannot pick a model per subagent → **skip this
step**, every stage runs the session's model. The harness is still correct, just
not cheaper. Do **not** drop the model for `fsd-reviewer` or
`adversary` below this table: one dropped AC or one escaped bug costs more than
the entire model bill for the task.

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

**After EVERY stage, run the validator on this exact task — before dispatching the next stage:**

```bash
node scripts/validate-tasks.mjs --quiet --task "$TASK"    # exit 1 = gate FAIL
```

Without this step, Gate 1–3 are **you reading the doc and judging it yourself** —
the same kind of self-report the harness does not trust in `attempts` and
`telemetry`. The real consequence: an AC dropped from `03` only surfaces at
step 7, that is **after the implementer already wrote the code** — exactly when
fixing is most expensive, and that is the main source of `attempts.implementation ≥ 2`.

The exit codes already distinguish: `0` pass · `1` gate FAIL (handle per Gate-fail
handling) · `2` bad `--task` argument (a mistyped path — fix the command, do not
treat it as a gate fail).

`--task` instead of scanning the whole repo is deliberate: a **different** task
sitting `blocked` waiting on the BA is a valid state, and must not turn this
task's gate red.

**Every time you dispatch a stage, increment `task.agent.json → attempts[<stage>]`**
(set `1` if absent). That is the only measurement of rework the harness has — at
`attempts` ≥ 3 the validator warns ([`docs/Agents.md` §5.5](../../docs/Agents.md)).

**And renew the lease — same place, same moment:**

```bash
node scripts/lease.mjs renew "$TASK"
```

The 30-minute lease TTL is designed to detect a *dead session*, but `acquire`
stamps it only once — so without a renew it applies to the **whole task
lifetime**. A `high` task running 6 stages on the `strong` model taking over 30
minutes is normal, and at that point a *live* lease is treated as an orphan: a
second session acquires it, two sessions write `.agent-memory/` — exactly the
race the lease exists to prevent.

Each dispatch is a natural heartbeat — no timer and no background process needed.

**And append one `telemetry` line** — you are the only actor that knows which
tier the stage just ran on:

```json
{ "stage": "implementation", "tier": "strong", "model": "opus", "attempt": 2,
  "startedAt": "2026-09-18T09:00:00Z", "endedAt": "2026-09-18T09:12:00Z",
  "inputTokens": 21400 }
```

`inputTokens` = the number the CLI reports after that dispatch (omit it if the CLI reports nothing). This is the only thing that shows **the weight of the harness itself**: the floor of rules every subagent must read is multiplied by every stage, every task — if the kernel bloats, it shows up here, or it shows up nowhere.

The CLI cannot pick a model per subagent → `"tier": "session-default"`, leave
`model` empty. Do **not** record token/usage (SharedRules §5 forbids it — that is
vendor data); the model name + wall-clock is enough for `--calibrate` to answer
"did tier `strong` buy anything", the question `outcome` alone cannot answer.

Step 7 (you, no subagent): `node scripts/lease.mjs release "$TASK"` (step 0b), confirm `task.agent.json` has `status = reviewing`,
run `node scripts/validate-tasks.mjs --quiet` and make sure this task folder reports no
errors (it enforces the AC traceability chain, SharedRules §9), then post the
final summary: what changed (from the implementer's handoff), test evidence
location (`08-Test-Evidence.md`), and the remaining user decisions (commit /
push / MR / ClickUp status). **Stop.** Do not commit or push — the user does
that themselves.

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

## Step 7 — clean up merged worktrees (after reporting to the user, before stopping)

Leaving a worktree but keeping it means nothing gets cleaned up, so they pile
up — one machine once accumulated **108 worktrees / 65 GB**, 79 of them on
already-merged branches (work done, keeping them pointless). Every new worktree
re-clones dependencies on top of that → slower and slower.

Run the dry-run and report the number to the user, **do not delete anything
yourself**. For each repo in `harness.config.json → repos`:

```bash
TARGET=origin/<target-branch ProjectRules §3>
git -C <repo-path> fetch origin -q
for w in $(git -C <repo-path> worktree list --porcelain | awk '/^worktree /{print $2}'); do
  b=$(git -C "$w" branch --show-current 2>/dev/null) || continue
  [ -z "$b" ] && continue
  # merged into the target + clean tree = safe to remove
  git -C <repo-path> merge-base --is-ancestor "$b" "$TARGET" 2>/dev/null \
    && [ -z "$(git -C "$w" status --porcelain)" ] \
    && echo "$w  [$b]"
done
```

The printed list is **candidates** — commits already in the target branch *and* a
clean tree. The user decides to delete:

```bash
git worktree remove <path> && git branch -d <branch>   # -d, NOT -D: -d refuses if not merged
```

**This** task's worktree is never in the list (not merged yet) — so step 7 never
touches what you just did.
