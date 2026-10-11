# Gate 2/3/5 pre-filter (#108, #113) — optional, off by default

Decision-model pre-read before the real role runs: `fsd-reviewer`'s output at Gate 2, `technical-planner`'s at Gate 3, the `adversary` at Gate 5. Only acts when it
is confident the change is broken, so it can skip a 54k–132k-token LLM review.
Everything else goes to the adversary exactly as before.

**Off unless `TYPESAFE_API_KEY` is set.** No key, no network, a bad response, a
context overflow — all exit 0, nothing blocks, nothing is required.

## Set the key (once per machine)

Get a key from your TypeSafe account. **Never put it in the repo, in
`harness.config.json`, or in a `.env` file** — the guard blocks reading `.env`
(so the agent can't see it) and anything committed leaks it.

**macOS — Keychain** (encrypted; `cat`/`grep` over the repo never finds it):

```bash
# 1. store it. `read -s` keeps it off the screen and out of shell history
read -s "k?TYPESAFE_API_KEY: " && security add-generic-password -a "$USER" -s TYPESAFE_API_KEY -w "$k" -U && unset k

# 2. load it into every new shell (this line holds the command, not the key)
echo 'export TYPESAFE_API_KEY="$(security find-generic-password -a "$USER" -s TYPESAFE_API_KEY -w 2>/dev/null)"' >> ~/.zshrc && source ~/.zshrc

# 3. check — prints the length only, never the key
echo ${#TYPESAFE_API_KEY}      # > 0 = set
```

First use may pop a "security wants to access the Keychain" dialog → **Always Allow**.
Rotate: re-run step 1 (`-U` overwrites). Remove: `security delete-generic-password -a "$USER" -s TYPESAFE_API_KEY`.

**Linux / other** — a file only you can read, loaded the same way:

```bash
read -s -p "TYPESAFE_API_KEY: " k && (umask 077; mkdir -p ~/.spec-harness && printf %s "$k" > ~/.spec-harness/typesafe.key) && unset k
echo 'export TYPESAFE_API_KEY="$(cat ~/.spec-harness/typesafe.key 2>/dev/null)"' >> ~/.bashrc && source ~/.bashrc
```

**CI** — a repository secret exposed as the `TYPESAFE_API_KEY` env var; nothing else to do.

**Not set / wrong key?** Nothing breaks: the script prints one `skipped` line to
stderr and the adversary runs as usual. To see whether it is armed:

```bash
node scripts/gate5-prefilter.mjs <task-folder> main   # "skipped — no TYPESAFE_API_KEY" = not loaded in this shell
```

An agent run from an already-open terminal needs a **new shell** (or
`source ~/.zshrc`) to see the key; a GUI-launched CLI may not inherit it.

## Use

Nothing to wire: `install` ships it as `scripts/gate5-prefilter.mjs`, and
`validate-tasks.mjs --advance <task> <stage>` runs it on its own (#109, #113).
It has an opinion at `technical_plan`, `implementation`, `adversarial_review`;
any other stage exits 0. A coordinator that skips prose still cannot skip `--advance`.

```bash
node scripts/gate5-prefilter.mjs <task-folder> [base-branch] [stage]   # manual run; stage defaults to adversarial_review
echo $?   # 78 = confident FAIL (never 1: node exits 1 on a crash)
          # anything else = run the real adversary
```

## Why PASS never blocks

Measured through this script on 20 cases (8 from `kernel/eval/adversary` + 12
held-out, same `discount()` fixture): 5/14 buggy cases blocked (36%), 0/6 clean
cases flagged. A hand-built state reached 8/14; what the script collects is
leaner, and the number above is the one callers get. But two real bugs — an off-by-one threshold and
a rounding error — came back **PASS at confidence 0.78 and 0.98**, because this
model reads text and never runs the code. A PASS here means "no opinion", not
"approved": the adversary still owns Gate 5.

## Gate 2 and 3 (#113)

Same one-way rule, but the state is only `02` (and `03`): two short tables,
~0.3–0.8k tokens, 0.2–1.8 s — cheaper than the dispatch it can save.
Measured on the real API, `jev-1.13.0`, 2026-10-11:

| Gate | Blocked | Wrongly blocked | Missed |
| --- | --- | --- | --- |
| 2 — AC are testable | 11/14 vague sets | 0/20 measurable sets | a vague AC next to concrete ones ("`total` is computed correctly", "reject large files") |
| 3 — plan covers AC | 2/6 thin plans (`TBD`, "verify manually") | 0/3 sound plans | a plan that tests the wrong value (150, not the boundary 100) — #107's lane |

Run on the shipped eval task it blocks a dropped AC (0.96–0.98) and a `TBD`
command (1.00), and passes the clean one (0.92–0.96). Kept for the zero false
blocks, not because it is strong at Gate 3.

## Ceiling

- Model: `jev-1.13.0`, pinned on purpose — `jev-latest` moves and would drift
  the confidence threshold silently.
- Context ~32k tokens; state over ~24KB is skipped rather than truncated.
- Sample size is small (Gate 5: 20 cases; Gate 2: 34; Gate 3: 9 + 5 on the eval task; one domain). Gate 2/3 numbers were not tuned against a held-out set.
- Gate 5 sample, one fixture. Re-measure before trusting this
  on a different kind of AC (non-numeric, multi-param).
- Same-OS-user can still read the key from wherever it is stored; this is an
  accelerator, not a secret boundary.
