# /start-task — appendix

> Read **only** the section `commands/start-task.md` links you to. This is the rationale and the conditional branches, split out so the coordinator does not pay for them on every task (#55). The commands and the conditions stay in `start-task.md`.

## A. Escape-hatch outcome — why it matters

`escaped` is not an admission of fault — it is the only evidence that
`riskFloor` is too loose, and `--calibrate` needs several before it says so.
Recording `clean` for a task that later bit someone is the one entry that
cannot be taken back (a later `escaped` wins, a later `clean` does not).

The user wants the harness even though the verdict is an escape hatch → just
run it, nothing else needed. The other direction (verdict `harness` but the
user wants to skip) → `--force "<reason>"`. Skipping the harness is a valid
decision; skipping it without leaving a trace is not.

## B. Triage vs bootstrap vector — both directions

**Score honestly, do not score toward the answer you want.** Every triage
goes into `_triage.log`, and the validator cross-checks the **lowest** value
ever logged per dimension (re-running `--triage` does not overwrite a low
score, and a task with no entry at all is a warning) against the stored
vector in **both directions**: scoring low here then high at bootstrap →
warning (adjusting upward after the survey is normal, §5.1.3 — the warning
only makes it explicit that the lower number is the one that decided whether
this task needed the harness); the reverse, **lowering** a dimension below its
triage value, is an **error** — that is the direction §5.1.3 forbids.

## C. Lease — orphan, design points, limits

Stuck on an orphaned lease and unwilling to wait 30 minutes: deleting that task's `.agent-memory/.lease.d` directory outright is safe.

**Written in Node, not bash** — `mkdir -p`, `find -mmin`, `hostname`, `$$` do not exist on PowerShell/cmd, and step 0b runs **before** everything else: breaking it breaks the whole command. `node` is already mandatory anyway, because the validator needs it.

Three design points, written down so nobody "optimizes" them away:

- **`mkdir`, not check-then-write.** The gap between "check" and "write" is exactly the race the lease exists to prevent; `mkdir` fails-if-exists in **one** syscall. (`recursive: true` does **not** throw when it already exists → the whole effect is gone.)
- **A missing `owner` file defaults to *alive*.** Between `mkdir` and writing `owner` there is a few-ms window where the directory exists but `owner` does not. Reading "no owner yet" as "dead" means every session landing in that window steals a live session's lease — measured on the old bash version: 20 parallel sessions, 7 of them stole it. Only when the **directory** is also past 30 minutes is it a genuine orphan.
- **A lease older than 30 minutes = dead**, takeable (the previous session hung or was Ctrl-C'd).

Verify: `node scripts/lease.mjs --self-check` (asserts all four cases, including the two `mkdir`→write window cases). Real parallel measurement: 30 rounds × 20 sessions → exactly 30 winners.

This is an optimistic lease, not a distributed lock: it catches the common case (two sessions, one task) with one atomic `mkdir`, and does not handle NFS or clock skew between two machines. Enough at this scale.

## D. Creating the worktree

The worktree is always created **in the repo that will be modified**
(`repoName`), not the repo holding the config
([`docs/Agents.md` §0](../Agents.md)):

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

## E. Why the preamble names sections

The preamble names **sections**, not whole files: the floor of rules every subagent reads is multiplied by every stage of every task, so one surplus section is a cost paid six times. This is the cheapest place to cut — one line changed, the kernel untouched, "one normative home" preserved. The real number is modest: only `orchestrator` can drop §9 (~580 tok), the other six roles all use it. Do not cut deeper on instinct — §8 is the longest section but every role needs it.

## F. Tier names are CLI-agnostic

Tier → real model name is looked up in `harness.config.json → models.<cli>`
(`{ "<cli>": { "cheap": { "model": … }, … } }`). The kernel does not know which CLI
you run, so it only speaks in tiers — adding Codex or Gemini means adding its key,
this table does not change.

## F2. Retry tier rationale

Re-dispatching on the tier that just failed is the same mistake §5.3 forbids for
`adversary`: the same tier has the same blind spots. Going *down* on a retry is
an **error** the validator blocks — it does not save money, it buys another
bounce. `retryBudget` still caps the climb: at 4 blocks the task is out of budget.

No `models.<cli>`, or the CLI cannot pick a model per subagent → **skip this
step**, every stage runs the session's model. The harness is still correct, just
not cheaper. Do **not** drop the model for `fsd-reviewer` or
`adversary` below this table: one dropped AC or one escaped bug costs more than
the entire model bill for the task.

## G. Why validate after every stage

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

## H. Why renew the lease per dispatch

The 30-minute lease TTL is designed to detect a *dead session*, but `acquire`
stamps it only once — so without a renew it applies to the **whole task
lifetime**. A `high` task running 6 stages on the `strong` model taking over 30
minutes is normal, and at that point a *live* lease is treated as an orphan: a
second session acquires it, two sessions write `.agent-memory/` — exactly the
race the lease exists to prevent.

Each dispatch is a natural heartbeat — no timer and no background process needed.
`--advance` renews it, and exits `1` when the lease is not held: a renew that creates one would be an acquire that skipped the check.

## I. Telemetry fields — what to record and why

`attempt` is not optional once a stage runs twice: it is what makes the cascade
rule (§5.3.1) checkable at all, and without it the validator can only warn that
it cannot tell an escalation from a downgrade.

**`--advance` writes `startedAt`/`endedAt`; leave `inputTokens` out.** A real run showed
hand-typed windows invented (round minutes that matched no clock), and the validator
could not tell — so the script that dispatches now stamps them with the machine's clock. You do not know the token
count, and a guessed one is worse than none because `--cost` will print it as
fact. `scripts/collect-telemetry.mjs` fills it in at step 7 by reading the CLI's
own session log, matched on cwd + branch + that window. That is the only thing
that shows **the weight of the harness itself**: the floor of rules every
subagent must read is multiplied by every stage, every task — if the kernel
bloats, it shows up here, or it shows up nowhere.

The CLI cannot pick a model per subagent → `"tier": "session-default"`, leave
`model` empty. Do **not** record token/usage (SharedRules §5 forbids it — that is
vendor data); the model name + wall-clock is enough for `--calibrate` to answer
"did tier `strong` buy anything", the question `outcome` alone cannot answer.

## J. Step 7 — clean up merged worktrees

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
