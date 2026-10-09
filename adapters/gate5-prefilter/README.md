# Gate 5 pre-filter (#108) — optional, off by default

Decision-model pre-read before the real `adversary` review. Only acts when it
is confident the change is broken, so it can skip a 54k–132k-token LLM review.
Everything else goes to the adversary exactly as before.

**Off unless `TYPESAFE_API_KEY` is set.** No key, no network, a bad response, a
context overflow — all exit 0, nothing blocks, nothing is required.

## Use

```bash
export TYPESAFE_API_KEY=...   # store outside the repo, e.g. macOS Keychain
node adapters/gate5-prefilter/prefilter.mjs <task-folder>
echo $?   # 1 = confident FAIL, route back to the implementer without dispatching adversary
          # 0 = run the real adversary (no key / unsure / PASS)
```

Wire it into `/start-task`'s Gate 4 → Gate 5 handoff as an optional early-exit
check; it is not part of the kernel and is never required.

## Why PASS never blocks

Measured through this script on 20 cases (8 from `kernel/eval/adversary` + 12
held-out, same `discount()` fixture): 5/14 buggy cases blocked (36%), 0/6 clean
cases flagged. A hand-built state reached 8/14; what the script collects is
leaner, and the number above is the one callers get. But two real bugs — an off-by-one threshold and
a rounding error — came back **PASS at confidence 0.78 and 0.98**, because this
model reads text and never runs the code. A PASS here means "no opinion", not
"approved": the adversary still owns Gate 5.

## Ceiling

- Model: `jev-1.13.0`, pinned on purpose — `jev-latest` moves and would drift
  the confidence threshold silently.
- Context ~32k tokens; state over ~24KB is skipped rather than truncated.
- Sample size is small (20 cases, one fixture). Re-measure before trusting this
  on a different kind of AC (non-numeric, multi-param).
- Same-OS-user can still read the key from wherever it is stored; this is an
  accelerator, not a secret boundary.
