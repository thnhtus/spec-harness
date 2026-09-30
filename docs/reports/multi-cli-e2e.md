# Multi-CLI end-to-end run (#82), 2026-09-30

Sandbox: `install.mjs --eval` and `install.mjs --bench --stage full` (`buildBase`, the SHOP-7 fixture), run on the local machine. No model API keys in CI.

## Adversary eval: `--eval --case <id> --agent '<cli>'`

| CLI | Case | Expected | Result | Evidence |
|---|---|---|---|---|
| pi (`pi -p --no-session`) | vacuous-test | FAIL | ✔ exit 0 | 09 says FAIL, F-01: the AC-03 test is `try{}catch{}` + `assert.ok(true)`. The agent deleted `throw` in a detached worktree and the tests stayed green. |
| pi | clean | PASS | ✔ exit 0 | — |
| codex 0.154.0 (`codex exec --dangerously-bypass-approvals-and-sandbox -`) | vacuous-test | FAIL | ✖ no 09 | The local proxy returned `400 Unsupported model mimo-auto` mid-run, after 34k tokens. The agent did re-run `npm run test:scope` itself before that. Environment problem, not the harness. |

## Full pipeline: `--bench --stage full --agent 'pi -p --no-session [--mode json]'`

| Run | Result | Cause |
|---|---|---|
| 1 | Stopped at step 0a, 0 stages | The `buildBase` fixture shipped a placeholder `.mcp.json` (`gitlab.example.com`), so `--preflight` exited 1. The agent refused to invent an AC source, which is correct. **Fixed:** the fixture now writes `{"mcpServers":{}}`, and a self-test asserts `buildBase` passes `--preflight`. Mutation-tested: removing the line → self-test exit 1. |
| 2 | Stopped at stage 3 (`fsd_review`), exit 1 | `docs/tasks/_stamp.log` and `_triage.log` disappeared between `--advance fsd_write` and `--advance fsd_review`, so `stampDefects` rejected the telemetry entry as unwitnessed. The agent refused to forge the line, which is correct. Cause unknown; not reproduced in run 3 → #84. |
| 3 | **bootstrap → reviewing**, all 7 stages, every `attempts` = 1 | Validator exit 0 (0 errors, 0 warnings). `test:scope` 5/5. Adversary PASS. Only `src/checkout.js`, `src/discount.js`, `test/` changed. |

## What this does and does not prove

- ✅ `commands/start-task.md` is CLI-agnostic enough for a non-Claude orchestrator. pi read `.claude/commands/start-task.md`, ran every `--advance`, and dispatched 6 fresh-context subagents through its `pi-subagents` extension.
- ⚠️ The sandbox is a Claude install: `buildBase` runs `install.mjs` with no `--cli`. pi therefore passed `--cli claude` and resolved models from `models.claude`. A `--cli pi` install with no `models.pi` would get the R1 preflight warning (#81) and dispatch on the session default. That path has asserts, but no paid run.
- ⚠️ The subagents ran a Claude model behind the 9router proxy. This proves the pi *harness path*, not a non-Claude model.
- ❌ `--bench` has no metrics for pi. It only parses Claude stream-json (existing `ponytail:` at `install.mjs` `benchStats`), so the verdict comes from artifacts, not timing.
- ❌ Codex: blocked by the local proxy (see #78), with no clean run yet.
