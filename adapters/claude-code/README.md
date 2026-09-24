# adapters/claude-code

CLI-specific glue. The kernel names no CLI (see `docs/Agents.md` §5.3 — it speaks
in model *tiers*, never vendor names); anything that calls one CLI's API lives
here.

## `prompt-submit` — paste a link, get routed

Without it, `/start-task <url>` is the only way into the harness, and the two
failures that costs are silent:

- a task started by editing code directly, with no FSD, no gates, no trace;
- a **second** task folder created for a URL that already has one — the docs are
  append-only, so a forked lifecycle cannot be cleaned up afterwards.

The hook reads the prompt, pulls the first URL out, and asks the validator:

```bash
node scripts/validate-tasks.mjs --route "<url>"
```

| Situation | What gets injected |
| --- | --- |
| URL does not match `tracker.urlPattern` | nothing |
| matches, no task folder | "run `/start-task <url>`" |
| matches, task unfinished | "already ABC-1 at stage `technical_plan` — resume it, do NOT create a second folder" |
| matches, task `reviewing`/`mr_created`/`done` | "already done — do not re-run; the docs are append-only" |

The tracker is not hardcoded: the pattern comes from
`harness.config.json → tracker.urlPattern`, the same field the schema uses for
`trackerUrl`. A Jira/Linear team changes that one line.

**It advises, it does not act.** The hook injects one line of context and the
model decides. There is no tool called "start working on a task", so there is
nothing a `PreToolUse` deny could match — this is the ceiling of the mechanism,
not an oversight. A false positive therefore costs one line of context, not a
seven-stage run.

**It fails open.** No node, no git repo, no validator, unparseable stdin, broken
config — every one of those exits 0 in silence. A hook that can break a prompt is
a hook that gets switched off, and then the guardrail is gone permanently rather
than for one prompt.

### Install

`install.mjs` does it: copies the hook to `hooks/prompt-submit` (executable) and
ships the `hooks` block in `.claude/settings.json`. Since `settings.json` is kept
on re-install, an existing project adds the block by hand:

```json
"hooks": {
  "UserPromptSubmit": [
    { "hooks": [{ "type": "command", "command": "\"$CLAUDE_PROJECT_DIR\"/hooks/prompt-submit" }] }
  ]
}
```

### Another CLI

Nothing to port: the decision lives in `--route`, which is plain stdout. Any CLI
with a prompt hook calls the same command and prints the same line.
