---
description: REQUIRED after installing the harness — probe the repo, then fill in docs/agents/ProjectRules.md (§1 MCP · §2 guardrail · §3 branches · §7 commands) + harness.config.json (repos, layers, models, evidenceCommandPattern)
argument-hint: (no arguments needed)
---

**Required step after installing the harness.** `install.mjs` only copies files; it
does not know what stack the project uses, which tracker, how branches are named.
Until you run this command, `ProjectRules.md` and `harness.config.json` are still
empty skeletons — the gates have nothing to check.

Fill in two files:

| File | Sections |
| --- | --- |
| `docs/agents/ProjectRules.md` | §1 MCP source of truth · §2 guardrail source · §3 branch rules · §7 verification commands |
| `harness.config.json` | `repos` · `layers` · `models` · `evidenceCommandPattern` + `evidenceSampleCommand` + `evidenceNegativeSamples` |

**Identify the layout first** — it determines `repos`:

- `harness.config.json` sits **inside** the code repo (`git rev-parse --show-toplevel`
  = the directory holding the config) → `repos: [{ name, path: ".", layer }]`.
- It sits **next to** the code repos (the directory holding the config is its own
  repo, `ls ..` shows sibling repos) → one entry per code repo, `path` is
  `../<name>`. Ask the user which repo belongs to which layer if you cannot infer
  it from the manifest.

**Keep section numbers 1/2/3/7 as they are.** The kernel cross-references by number
(`SharedRules §2` = section 2 of this file). Do not renumber, do not insert new
sections in between.

## Principles

- **Probe first, ask second.** Most of the 4 sections can be inferred from the
  repo. Only ask the user for what is in no file (branch naming convention,
  target branch).
- **Do not invent.** If you cannot find it, leave `<…>` with a `TODO:` — a reader
  seeing the gap immediately beats a reader believing a wrong line.
- **Write what you know, not what fills the page.** §2 is most expensive when
  written in a hurry; most of its value arrives after a real incident. Three
  correct lines beat twenty guessed ones.

## Step 1 — probe

Run these in parallel, read the results, and only then write:

| What you need | Where to probe |
| --- | --- |
| MCP server (§1) | `.mcp.json` at the repo root — take the exact key in `mcpServers` |
| Stack (§2) | `package.json` / `pyproject.toml` / `go.mod` / `Cargo.toml`… — the main dependencies |
| Directory layout (§2) | `ls src/` (or the equivalent source root), 2 levels |
| Existing guardrails (§2) | `CLAUDE.md`, `AGENTS.md`, `CONTRIBUTING.md`, `.cursorrules`, `docs/*RULES*` — if present, **quote briefly + link**, do not copy the whole file |
| Protected branch + target branch (§3) | `git branch -r`, `git symbolic-ref refs/remotes/origin/HEAD` |
| Branch names in use (§3) | `git branch --format='%(refname:short)' \| head -20` — infer the team's actual formula |
| Package manager (§7 command prefix) | lockfile at the repo root: `package-lock.json` → `npm run`, `yarn.lock` → `yarn`, `pnpm-lock.yaml` → `pnpm`, `bun.lockb`/`bun.lock` → `bun run`; `packageManager` in `package.json` wins if present. Write every §7 command with that prefix — do not default to npm |
| Test/lint/build commands (§7) | `scripts` in `package.json`, `Makefile`, `justfile`, `tox.ini`, CI workflow (`.github/workflows/*.yml`) |
| Watch/server commands the agent must not run (§7) | same sources — any command that does not terminate on its own (`dev`, `watch`, `serve`, `--watch`) |
| Sibling BE repo (§1, tier 2) | `ls ..` — is any sibling repo the backend of this project (name hints: `*-service`, `*-api`, `*-backend`) |
| Swagger/OpenAPI (§1, tier 3) | `.claude/skills/api-docs-sync/services.json`, or a swagger URL in README / `.env.example` / docker-compose |
| `models` for `harness.config.json` | which CLI is in use (Claude Code / Codex / other) → map `cheap`/`mid`/`strong` to its model names; unclear → leave `{}` |
| `repos` for `harness.config.json` | is `harness.config.json` inside the code repo or its own repo? (`git rev-parse --show-toplevel` versus cwd) · `ls ..` to find sibling repos · fill in `[{name,path,layer}]`, `path: "."` if same repo |
| `layers` for `harness.config.json` | is the repo FE, BE, or a monorepo? (`ls`, where `go.mod`/`package.json`/`pyproject.toml` live) — write into `layers`, e.g. `["frontend"]` or `["frontend","backend"]` |
| The layer actually exercised when verifying (§7) | is there a UI? is there an existing e2e/integration harness (`e2e/`, `test/integration/`, `*_test.go`, `conftest.py`) |

If the repo has `CLAUDE.md`/`AGENTS.md`, that is the best source for §2 — **link to
it** instead of copying, so the two copies cannot drift.

## Step 2 — ask the user exactly what you could not probe

Batch it into **one** AskUserQuestion, asking only what is still blank after step 1:

1. The branch naming formula (if `git branch` does not yield a clear pattern).
2. The target branch to cut new branches from (`develop` or `main`) — if both exist.
3. Which command is the **default Gate 4 evidence** — if there are several test
   commands and it is unclear which one runs path-limited.
4. Sibling BE repo: if you found a candidate, **confirm it is the right repo**; if
   you found none, ask for the Swagger URL to fill in the `api-docs-sync` skill's
   `services.json`.

If you already probed it, do not ask again.

## Step 3 — write

Overwrite `docs/agents/ProjectRules.md`, keeping the template's 4-section skeleton
(`adapters/ProjectRules.template.md` is the original). Delete the `<!-- NOT-FILLED-IN: … -->` lines.

Section 7 has a hard constraint: **every command listed must match
`evidenceCommandPattern` in `harness.config.json`**. A mismatch means Gate 4
rejects the evidence even when the tests are green. So right after writing §7,
update `harness.config.json` too:

- `evidenceCommandPattern` — a regex covering exactly the set of commands you just wrote
- `evidenceSampleCommand` — a real command, must match that pattern
- `evidenceNegativeSamples` — ≥2 commands that **must not** match (dev server, watch mode…). If the pattern only has to *accept* the sample, `npm run .*` stays green; this is the opposite direction

Use the repo's real package manager in all three — a pattern written for `npm run` rejects the `yarn build` the team actually runs, and Gate 4 then fails on green tests.

## Step 4 — verify (required, do not report done before running it)

```bash
node scripts/validate-tasks.mjs --preflight
```

`--preflight` includes `--self-check`, plus two things self-check cannot see:
whether the CLI is open in the right directory to load `.claude/settings.json`,
and whether `repos[].path` resolves.

A failure on `evidenceSampleCommand` = the pattern and the command disagree → fix it, run again.
A failure on `evidenceNegativeSamples` = the pattern is written too broadly → narrow it, do not delete the sample.
This is what catches the configuration error that makes every later gate a silent no-op.

Then report to the user, briefly:

- the 4 sections: which were probed, which still carry `TODO:`
- the `evidenceCommandPattern` line you set
- the `--self-check` result
- a reminder: §2 gets more correct after each time the agent gets something wrong — no need to write it all now
