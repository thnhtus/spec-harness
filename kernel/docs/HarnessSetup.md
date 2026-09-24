# HarnessSetup — Bootstrap, MCP, generating harness files, resume

> **Role:** bootstrap rules for the AI harness — read this when starting a new session, configuring MCP, generating per-tool harness files, or resuming an unfinished task.
> **Scope:** every repo layout declared in `harness.config.json → repos` — harness inside the code repo, or alongside several repos ([`Agents.md` §0](./Agents.md)).
> **Language:** write prose in `harness.config.json → docLanguage`; technical tokens stay as they are.

---

## 1. Load order (what to read at startup)

The **main loop / orchestrator** reads the whole chain; a **role subagent** reads only steps 2, 4 and 5 (it has its own context — see [`Agents.md`](./Agents.md) §2):

| # | File | Who reads it | What it establishes |
| --- | --- | --- | --- |
| 1 | [`README.md`](./README.md) | main loop | index + operating model |
| 2 | [`Instructions.md`](./Instructions.md) | every agent | global rules |
| 3 | [`Agents.md`](./Agents.md) | main loop | lifecycle, the 5 gates, choosing an implementer, skip rules |
| 4 | [`agents/SharedRules.md`](./agents/SharedRules.md) | every agent | handoff, task docs, `status`, token budget (§4/§5/§6/§8/§9) |
| 5 | `agents/{Role}.md` | the running role | that role's procedure (table in §5 below) |

> The path is **lowercase** `docs/agents/` (case-sensitive on Linux/CI). If a file from steps 1–4 is missing or contradicts the repo → **stop** and report a blocker; never infer replacement content.

---

## 2. Environment prerequisites

Check once when onboarding a new machine. The project's specific toolchain: [`agents/ProjectRules.md` §7](./agents/ProjectRules.md).

| Component | Requirement | Check |
| --- | --- | --- |
| Git + SSH to the git host | configured | `git --version` & `ssh -T git@<host>` |
| Node.js (runs the validator) | 20+ | `node -v` |
| A package manager | npm (ships with Node), or yarn / pnpm / bun | `npm -v` / `yarn -v` / `pnpm -v` / `bun -v` |
| Harness CLI | Claude Code or Codex CLI | `claude --version` / `codex --version` |

Install dependencies with whatever the repo uses (`npm install` / `yarn` / `pnpm install` / `bun install` — the lockfile decides; do not mix). The list of valid check commands (one-shot vs watch mode): [`agents/SharedRules.md` §7](./agents/SharedRules.md).

---

## 3. MCP setup

`install.mjs` writes a starter `.mcp.json` at the repo root (template: tracker + git host + design tool). Edit it for your project — delete the servers you do not use, fill in the real hosts:

```json
{
  "mcpServers": {
    "tracker":  { "type": "http", "url": "https://mcp.clickup.com/mcp" },
    "git-host": { "type": "http", "url": "https://gitlab.example.com/api/v4/mcp" },
    "design":   { "type": "http", "url": "https://mcp.figma.com/mcp" }
  }
}
```

> **The URL must parse, even while it is still a placeholder.** `https://<git-host>/…` kills the CLI with `ERR_INVALID_URL` at startup — before you get a chance to fix it, because `<` and `>` are not valid in a hostname. Use a real hostname such as `example.com` until you have the right value.

Those three servers are the default skeleton. If the project has a UI, also declare a **browser-control** server (BrowserOS neo, Playwright, chrome-devtools…): Gate 5 needs it to drive the real app AC by AC ([`agents/Adversary.md`](./agents/Adversary.md), skill `pre-qc-gate` §4a) — without it Gate 5 is reduced to the test layer. A locally running server is declared with `command` + `args` instead of `type` + `url`.

Do not declare servers just to have them: every connected server is a block of tools sitting in context on **every turn**, including the turns that never use it — see the budget in [`agents/SharedRules.md` §8](./agents/SharedRules.md). A filesystem/shell MCP is outright redundant; the CLI already has those.

`.mcp.json` is **project-scoped**: commit it and the whole team shares one declaration, with nobody running `claude mcp add` by hand. After editing it, type `/mcp` in the session to complete OAuth for each server, and verify with `claude mcp list`.

What each server is for, plus the "never invent MCP data" rule: [`agents/ProjectRules.md` §1](./agents/ProjectRules.md). Payload discipline (summary-first, metadata-first): [`agents/SharedRules.md` §8](./agents/SharedRules.md).

> Subagents do **not** declare `tools:` — they inherit every tool in the session, so switching tracker (ClickUp → Jira/Linear) only means editing `.mcp.json` and ProjectRules §1, never a role file.

> **Never commit** tokens, cookies, or `.claude.json` — see [`Instructions.md` §4](./Instructions.md).

---

## 4. Generating per-tool harness files

The core rule: **merge, never clobber** — replace only the region between the `SPEC-HARNESS:START` … `SPEC-HARNESS:END` markers; anything the user wrote outside the markers stays.

| Tool | Path | Contents |
| --- | --- | --- |
| Claude Code | `.claude/agents/{role}.md` (7 files) | short file pointing at `docs/agents/{Role}.md`, HTML-comment markers |
| Codex | `.codex/AGENTS.md` + `.codex/agents/{role}.toml` (7 files) | equivalent, `# SPEC-HARNESS:START` markers |

The seven `{role}`s: `orchestrator`, `fsd-writer`, `fsd-reviewer`, `technical-planner`, `implementer`, `fixer`, **`adversary`**.

> Failing to generate `adversary` **silently removes Gate 5** — the harness still runs and still reports PASS, there is simply nobody left checking the implementer's evidence. Count all seven files before the first task.

Constraints when generating:

- Do **not** touch `.claude/settings.json` / `.claude/settings.local.json` while *generating role files*. The installer writes `settings.json` **once** (the deny-list for commands that destroy the working tree — [`Instructions.md` §1](./Instructions.md)) and never overwrites it again; it is the project's adapter, not something an agent edits.
- Do **not** touch the project's own skills in `.claude/skills/` (other than the skills the harness ships).
- Re-generating replaces only the region between the markers; content outside is reassembled untouched.
- Role files are "pointers" — the real procedure lives in `docs/agents/{Role}.md`, which avoids two copies drifting apart.

---

## 5. Role file reference

| Role | Procedure file |
| --- | --- |
| `orchestrator` | [`agents/Orchestrator.md`](./agents/Orchestrator.md) |
| `fsd-writer` | [`agents/FSDWriter.md`](./agents/FSDWriter.md) |
| `fsd-reviewer` | [`agents/FSDReviewer.md`](./agents/FSDReviewer.md) |
| `technical-planner` | [`agents/TechnicalPlanner.md`](./agents/TechnicalPlanner.md) |
| `implementer` | [`agents/Implementer.md`](./agents/Implementer.md) |
| `fixer` | [`agents/Fixer.md`](./agents/Fixer.md) |
| `adversary` | [`agents/Adversary.md`](./agents/Adversary.md) |

Reference artifacts (read, never edit): [`srs/README.md`](./srs/README.md) · [`fsd/README.md`](./fsd/README.md) · [`api/README.md`](./api/README.md).

---

## 6. Safe initial commands (read-only, run at the start of a session)

```bash
pwd                              # the right repo root
ls docs                          # README/HarnessSetup/Instructions/Agents + agents/ srs/ fsd/ api/ tasks/
git status --short --branch      # current branch + uncommitted changes
claude mcp list                  # the servers in .mcp.json are connected
```

Working-branch rules (name formula, `--ff-only`, the user-managed-branch exception): [`agents/SharedRules.md` §3](./agents/SharedRules.md).

---

## 7. Resuming an unfinished task

**Pasting the tracker link is enough to find out where a task stands.** `scripts/validate-tasks.mjs --route <url>` matches the URL against `tracker.urlPattern`, looks for a task folder already holding it, and prints one line: run `/start-task`, resume task X at stage Y, or do not re-run a finished task. On Claude Code the `hooks/prompt-submit` hook calls it on every prompt and injects that line automatically ([`adapters/claude-code/README.md`](../../adapters/claude-code/README.md)). It advises only — the model still decides, and the hook is silent on anything that is not a task link.

The expensive case it exists for is not "forgot to type `/start-task`": it is a **second** task folder created for a URL that already has one. These docs are append-only, so a forked lifecycle cannot be cleaned up afterwards.

Task docs live in `docs/tasks/sprint-{n}/{taskId}-{slug}/` (layout: [`tasks/README.md`](./tasks/README.md)). To resume:

1. **Read the state:** `task.agent.json` → `currentStage`, `status`, `branch` (+ `branchActual` if present), `agents.{role}.status`.
2. **Read the handoff:** `.agent-memory/{role}.md` for the role matching `currentStage` → inputs, decisions, risks, evidence, "next agent", continue flags.
3. **Re-check the gate** against the lifecycle in [`Agents.md`](./Agents.md) §2.
4. **Continue at the right point:** `blocked` / `needs_clarification` → read the blocker, wait for the user/BA to resolve it; `in_progress` → re-dispatch the right role subagent from where it stopped.
5. **Append, never overwrite:** every doc / `.agent-memory` update adds a new `## Update — YYYY-MM-DD` heading. That heading is a **structural marker** the validator splits on, so it stays in English (or the existing `## Cập Nhật`) regardless of `docLanguage`.
6. **Sync the checkout:** work on the branch recorded in `task.agent.json` (`branchActual` if present, otherwise `branch`).

> `task.agent.json` has no **token/usage** field (that is vendor data). It does have `telemetry`: stage, tier, model name, timestamps — enough for `--calibrate` to weigh cost against outcome ([`Agents.md` §5.6](./Agents.md)) without exposing token counts.

---

## 8. Never commit secrets

See [`Instructions.md` §4](./Instructions.md) — the single source of truth. Before proposing a commit: `git status --short`, and confirm no sensitive file is staged.
