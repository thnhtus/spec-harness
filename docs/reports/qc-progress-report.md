# QC Progress Report: multi-CLI deny guard (#44, v0.6.0 → unreleased fix)

## 1. Executive summary

- Overall status: **Partial**. Four defects were found by running the real CLIs; all four are fixed in the working tree. That fix is not released yet (npm is still 0.6.0).
- Scope: `npx spec-harness --cli <x>`. Covers 13 CLIs with a project hook, plus Hermes (manual snippet).
- Testcases: 16 CLIs × 3 cases (deny shell, deny read, allow shell), plus install/preflight rules M1–M8.
- Real e2e, both deny and allow verified: 11 CLIs (claude, codex, pi, goose, hermes, antigravity, opencode, qwen, copilot, gemini¹, droid²).
- Real e2e, deny only: cline (allow shell pass; deny stops the whole task, see BUG-004).
- Blocked (login/install needs a human): devin, kiro, cursor, windsurf-IDE.
- Mutation: 34/34 red.

¹ Gemini: the CLI is real, but the model is a local scripted Gemini API (the proxy's Gemini models were out of credits or rejected the model format).
² Droid: the verdict is read from the hook log in `~/.factory/logs`. `droid exec` hangs after the tool call with the proxy model, so there is no final text.

## 2. Scope tested

- Repo: `spec-harness` at master `8e57b13` (v0.6.0), plus working-tree fixes.
- Env: macOS arm64, Node 22.
- Temporary CLIs were installed into `/tmp/clis`; no global install.
  - LLM: local OpenAI/Gemini-compatible proxy `127.0.0.1:20128` (model `cx/gpt-5.6-luna`), or each CLI's own account (claude, codex, pi, goose, agy, copilot via `gh auth token`).
- Fixture: repo in `/tmp/e2e` / `/tmp/e3`, `npx spec-harness@0.6.0 --yes --cli …`.
  - Probe deny rules `Bash(echo spec-probe:*)` and `Read(probe.txt)` were added, because models refuse `git push` just from reading AGENTS.md, so the hook never gets exercised.
- Isolation: each CLI got a temporary HOME/config (`/tmp/qhome`, `/tmp/ghome`, `/tmp/cphome`, `/tmp/dhome`, `/tmp/clh`, HERMES_HOME=`/tmp/hhome`). The user's real `~/.hermes`, `~/.copilot`, `~/.gemini` were not touched.

## 3. Requirement coverage

| TC | CLI (version) | Deny shell | Deny read | Allow shell | Status | Evidence |
|---|---|---|---|---|---|---|
| TC-01 | claude 2.1.283 | ✅ | ✅ | ✅ | pass | "Permission to use Bash with command echo spec-probe ok has been denied" |
| TC-02 | codex-cli 0.154.0 | ✅ | n/a (no read tool) | ✅ | pass | `hook: PreToolUse Blocked`; `allowed-ok` (requires `--dangerously-bypass-hook-trust` or `/hooks` trust) |
| TC-03 | pi 0.87.1 | ✅ | ✅ | ✅ | pass | "blocked by spec-harness deny rule Read(probe.txt)" |
| TC-04 | goose 1.45.0 | ✅ | n/a (no read tool) | ✅ | pass | "Tool call denied by policy hook `spec-harness`" |
| TC-05 | hermes v0.21.1 | ✅ | ✅ | ✅ | pass | `{"error": "blocked by spec-harness deny rule Read(probe.txt)…"}` |
| TC-06 | antigravity agy 1.2.12 | ✅ | ✅ | ✅ | pass (after BUG-001) | "tool call denied by pre-tool hook: blocked by…" |
| TC-07 | opencode 1.18.33 | ✅ | ✅ | ✅ | pass | `Error: blocked by spec-harness deny rule Read(probe.txt)` |
| TC-08 | qwen-code 0.24.6 | ✅ | ✅ | ✅ | pass | `Tool "read_file" was not run: blocked by…` |
| TC-09 | copilot 1.0.88 | ✅ | ✅ | ✅ | pass (needs trustedFolders, BUG-003) | "Denied by preToolUse hook: hook exited with code 2" |
| TC-10 | gemini-cli 0.61.0 | ✅ | ✅ | ✅ | pass (scripted model) | functionResponse `"Tool execution blocked: blocked by…"` |
| TC-11 | droid 0.228.0 | ✅ | ✅ | ✅ | pass (verdict via hook log) | `[Hooks] Command completed {"exitCode":2,"stderr":"blocked by … Read(probe.txt)"}` |
| TC-12 | cline 3.0.65 | ✅ | ✅ | ✅ | pass with caveat (BUG-002, BUG-004) | `ControlledStopError: blocked by…` |
| TC-13 | devin 3000.10.27 | — | — | — | blocked (not logged in) | self-test only; format taken from `devin migrate hooks` |
| TC-14 | kiro | — | — | — | blocked (.app + AWS login) | self-test only |
| TC-15 | cursor | — | — | — | blocked (not installed) | self-test only |
| TC-16 | codewhale 0.8.53 | ❌ | ❌ | — | by design (tier B) | hook is observer-only (#455) |
| TC-17 | M1–M8 install/preflight | | | | pass | `npm test`; preflight 0 guard errors on a fresh install |

## 4. Generated or modified tests

| File | Purpose | Linked TC |
|---|---|---|
| `install.mjs` (`--self-test`, #44 block) | runs every generated hook as written, with the CLI's real payload shape; matcher↔tool check; merge; preflight mutation per adapter; reinstall refresh | TC-02…15, M1–M8 |
| `kernel/scripts/validate-tasks.mjs` (`--self-check`) | walker asserts: Cline `commands[]`, exec form `{command,args}`, `read_files` JSON-string | TC-12 |
| `/tmp/mut.mjs` (not committed) | 34 mutations, baseline must be green first | all |
| `/tmp/fakegem.mjs` (not committed) | scripted Gemini API used to drive the real Gemini CLI | TC-10 |

## 5. Defects found

| ID | Severity | TC | Actual | Expected | Repro | Fix |
|---|---|---|---|---|---|---|
| BUG-001 | **Critical** | TC-06 | Antigravity runs the hook with cwd=`.agents/` → `Cannot find module …/.agents/scripts/validate-tasks.mjs` → **the deny-list does not run** | guard runs | `agy -p` in a repo installed with 0.6.0 | command `node ../scripts/…`; self-test now runs it from cwd `.agents/` |
| BUG-002 | **Critical** | TC-12 | Cline 3.x batches commands as `run_commands {commands:[…]}` and reads files as `read_files {files:"<JSON string>"}`. The walker did not know these keys → `git push` **passed through** | deny | cline 3.0.65 + "echo spec-probe ok" | walker handles `commands[]`, `{command,args}`, and `files` JSON-string; self-test uses the real payload |
| BUG-003 | High | TC-09 | Copilot ignores the repo hook until the folder is in `trustedFolders` → silently no guard | user is told | copilot -p in a new folder | trust note in the post-install output |
| BUG-004 | Medium | TC-12 | Cline `cancel:true` stops **the whole task** (ControlledStopError), not just one tool | block only that tool | same as BUG-002 | no per-tool deny exists in Cline 3.x → documented in the trust note (safe side) |
| BUG-005 | High | TC-13 | Devin CLI (Windsurf's successor) does **not read** `.windsurf/hooks.json` | guard applies | `strings devin`, `devin migrate hooks` | new `devin` adapter → `.devin/hooks.v1.json` (format emitted by `devin migrate`) |

## 6. Blockers and risks

| Item | Type | Impact | Required action |
|---|---|---|---|
| Devin CLI not logged in | environment-blocker | TC-13 only has self-test | user runs `devin auth login` (browser) |
| Kiro CLI | environment-blocker | TC-14 | installs a macOS .app + AWS Builder ID |
| Cursor not installed | environment-blocker | TC-15; `permission:"allow"` may skip Cursor's approval | install Cursor |
| Guard only prefix-matches | known ceiling | `head .env.local`, `less src/.env`, `bash -c "git push"` get through (goose read probe.txt via `cat`) | accepted ceiling, documented in README |
| Droid/Gemini e2e not "pure" | test-limitation | proxy model: verdict read from log / scripted model | re-run with a real account |

## 7. Commands executed

```bash
npm test                                        # ✅ self-check + install self-test
node /tmp/mut.mjs                               # 34/34 red, baseline green
npx -y spec-harness@0.6.0 --yes --cli <all>     # fixture /tmp/e2e
codex exec --dangerously-bypass-hook-trust …    # TC-02
pi -p --no-session --approve …                  # TC-03
goose run --no-session -t …                     # TC-04
HERMES_HOME=/tmp/hhome hermes chat --accept-hooks --yolo -Q -q …   # TC-05
agy --dangerously-skip-permissions -p …         # TC-06 (BUG-001 found, fixed, re-run green)
OPENCODE_CONFIG=/tmp/oc.json opencode run …     # TC-07
qwen --auth-type openai --yolo -p …             # TC-08
COPILOT_HOME=/tmp/cphome copilot --allow-all-tools -p …            # TC-09 (BUG-003)
GOOGLE_GEMINI_BASE_URL=http://127.0.0.1:18765 gemini --yolo -p go  # TC-10
droid exec -m custom:cx/gpt-5.6-luna --auto medium …               # TC-11
cline --config /tmp/clh -c /tmp/e2e …           # TC-12 (BUG-002/004)
devin migrate hooks                             # BUG-005 format source
bash /tmp/regress.sh                            # regression of 7 CLIs on the fixed installer: all green
```

## 8. Recommendation and next actions

- Release 0.6.1 immediately: BUG-001/002 are critical (the guard is fake on Antigravity and Cline 3.x under 0.6.0).
- After release: re-install from npm and re-run `regress.sh`.
- User: `devin auth login` so TC-13 can run; decide whether Cursor `allow` → `ask`.

## 9. Follow-up round (0.7.0): issues #45–#51

| Issue | Change | Verification | Level |
|---|---|---|---|
| #45 Cursor allow | allow → `{}` (no decision). `ask` is invalid for `beforeReadFile` in cursor-agent 2026.09.26 and would block every read | self-test + 2 mutations red | source-verified, no login |
| #46 Cline cancel | `clineDeny`: `overrideInput` turns denied entries into `exit 1` / a `/dev/null/<why>` path; anything unrecognised still falls back to `cancel` | cline 3.0.65: blocked cmd fails with the reason, `allowed-ok` and `after-block-ok` run, the AGENTS.md read in the same batch succeeds | e2e |
| #47 Devin Desktop | windsurf adapter merges into `.devin/hooks.json` **and** legacy `.windsurf/hooks.json`, and keeps the user's own hooks | self-test with a pre-seeded user hook + 2 mutations | simulated (no IDE) |
| #48 AGENTS.md | claim made conditional on CLI hook support | self-test + mutation | unit |
| #49 python | `snapdiff.py` deleted (unreferenced); anchor checker ported to `node -e`; self-test bans python in `commands/`, `skills/` | the Node and Python versions give identical output on a Vietnamese-heading fixture; mutation red | unit + differential |
| #50 Codex trust | trust persisted through Codex's own app-server (`hooks/list` → `config/batchWrite hooks.state.<key>.trusted_hash`), then plain `codex exec` **without** bypass: untrusted → `spec-probe ok` ran; trusted → `PreToolUse Blocked`, `allowed-ok` ran. Finding: the key is the **realpath** (`/private/tmp/...`); trusting `/tmp/...` protected nothing. Windows: documented ceiling (openai/codex#24453) | e2e codex 0.154.0 | e2e |
| #51 login-gated | cursor / devin / kiro still need a human login | — | blocked |

Mutation harness: 44/44 red, baseline green. Regression on codex, pi, goose, agy, opencode, qwen and copilot: all green.
