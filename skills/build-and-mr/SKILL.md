---
name: build-and-mr
description: Use when the user wants to build and open a merge/pull request from the current branch to the base branch — e.g. "run the build and make an MR", "build, fix any issues, then create the MR". Runs the ProjectRules §7 build, auto-fixes build breakage (≤3 rounds), pushes the current branch, then creates the MR through the git-host MCP. The description follows the repo's own MR template and includes a "Tasks completed" section with tracker links pulled from the commit log + diffstat vs the base branch.
---

# build-and-mr

## Overview

One flow: **§7 build → fix any breakage → push current branch → open an MR to the base branch** with a detailed, auto-generated description.

**Core principle:** the MR must reflect what was actually built *and verified green*. Any fix the build needed is committed (fix-only, nothing unrelated) and pushed *before* the MR is created — the MR diff and the green build always match.

**Repo facts — read, don't guess:**
- Build: the build command of **ProjectRules §7** (`$BUILD` below).
- Base branch: **ProjectRules §3** (`$BASE` below). Protected branches: same section.
- Remote + project path: `git remote get-url origin`. MR is created through the git-host MCP declared in ProjectRules §1.
- MR title format and template path: ProjectRules §3 if it declares them; otherwise `<branch>: <one-line summary>` and the host's default template.

## When to use

- User asks to build and raise an MR/merge request off the current branch.

**Not for:** merging the MR, assigning reviewers/labels, CI polling, or targeting `main` (ask first if the user says main). No watch-mode commands ever (dev servers never exit).

## Workflow

```
1. Preflight → 2. Build (+fix loop) → 3. Commit fixes → 4. Push → 5. Compose → 6. Create MR → 7. Report
```

### 1. Preflight
- `git rev-parse --abbrev-ref HEAD` → current branch. **Abort** if it is a protected branch (nothing to MR from a base branch).
- `git fetch origin $BASE` so the diff base is current.

### 2. Build + fix loop (≤3 rounds)
Run `$BUILD`. If it **passes**, go to step 3.

If it fails, for each round (max 3):
- Read the build errors. Fix only **clear build blockers** — type errors, bad/missing imports, obvious lint-fatal issues — at the **root cause**, minimal diff. Match surrounding code style.
- Re-run `$BUILD`.

Still failing after 3 rounds → **STOP. Do not push. Do not create the MR.** Report the remaining errors and which files you touched. This is a hard gate.

Never "fix" by loosening types wholesale (`any`, `@ts-ignore`, disabling rules) unless that is genuinely the correct fix and you say so.

### 3. Commit fixes (only if the loop edited files)
Stage **only the files you edited to fix the build** — never `git add -A`, never sweep in the user's unrelated working-tree changes. Then:

```
fix(build): <one line on what broke and the fix>
```

If the build was green and you edited nothing, there is no fix-commit — proceed.

### 4. Push
`git push -u origin <current-branch>`. Pushes existing commits only; the user has authorized push for this flow.

### 5. Compose the MR
- **Title** — the format ProjectRules §3 declares (a timestamp in it → `date` at run
  time, never typed); none declared → `<branch>: <one-line summary>`.

- **Description** — start from the repo's own MR template so the MR matches
  what reviewers expect, then fill it from git facts (not memory):
  ```
  cat <MR template path>                       # .gitlab/merge_request_templates/*.md or .github/pull_request_template.md
  git log --pretty='- %s' origin/$BASE..HEAD   # commit list
  git diff --stat origin/$BASE...HEAD          # changed files, group by area
  ```
  Fill the template's sections in place — do **not** invent a parallel structure:
  - **Description**: one paragraph on what the branch does.
  - **Type of Change**: check the box(es) the commits actually match.
  - **Changes Summary**: grouped diffstat bullets by area.
  - **Checklist**: tick only what's genuinely true (build green → testing/quality boxes you verified); leave the rest unchecked.
  - Drop `Closes #`, `How to Test`, `Screenshots`, and any quick-action footer unless the user asked for them — this flow neither assigns nor closes issues.
  - Replace the `Related Issues` section with the **Tasks completed** block below.

- **Tasks completed (with tracker links)** — insert right after Changes Summary:
  - Extract task ids from commit subjects and bodies (`git log --pretty='%s%n%b' origin/$BASE..HEAD`),
    using the id shape of this repo's commits (ProjectRules §3 branch formula carries `{taskId}`).
  - For each id, one bullet: **what was done** (from the matching commit subject,
    human-readable) + the task URL, built so it matches `harness.config.json → tracker.urlPattern`.
  - If a commit has no id, still list its work under a plain bullet (no link).
  - No ids anywhere → write `_No task references found in commits._`

```markdown
### Tasks completed
- **<short human summary of the task>** — <task URL>
- ...
```

  Full description skeleton (template sections + the two custom blocks):
```markdown
## 📝 Description
<one paragraph on what this branch does>

## Type of Change
- [x] ✨ New feature ...   <!-- tick the ones that apply -->

## Changes Summary
- **<area>**: <what changed>
- ...

### Tasks completed
- **<task summary>** — <task URL>
- ...

### Verification
- `$BUILD`: <passed clean | passed after fixes — 1-line note>

## Additional Context
<external deps, BE-side work, or "none">
```

### 6. Create the MR
Call the git-host MCP's create-merge-request tool (ProjectRules §1):
- `id`: project path from `git remote get-url origin`
- `source_branch`: current branch · `target_branch`: `$BASE`
- `title`: `$TITLE` · `description`: composed markdown

**If the git-host MCP is unavailable or errors (auth/network):** the branch is already pushed — do **not** loop. Print the exact title + description and the host's "new merge request" URL for this branch (e.g. `https://<git-host>/<project-path>/-/merge_requests/new?merge_request%5Bsource_branch%5D=<branch>`) so the user can finish in one click, and say re-auth via `/mcp` if it was an auth error.

### 7. Report
Print the MR URL (from the MCP response), the title, whether fixes were needed, and any follow-up notes. Stop — do not merge.

## Common mistakes

| Mistake | Do instead |
| --- | --- |
| `git add -A` before the fix-commit | Stage only the files you edited for the build fix. |
| Creating the MR before pushing | Push first — MR creation needs the branch on origin. |
| Hardcoding the timestamp | Always `date +'%d%m%Y_%H%M'` at run time. |
| Targeting a branch other than `$BASE` | Target `$BASE`; confirm with the user if they meant another. |
| Committing unrelated working-tree changes to make the diff "clean" | Leave them; the MR is only your branch's commits vs `$BASE`. |
| Silencing type errors with `any`/`@ts-ignore` to force green | Fix the root cause; if still red after 3 rounds, stop and report. |

## Self-check (before creating the MR)

- [ ] `$BUILD` exited 0 (real output, not assumed).
- [ ] Only build-fix files are in the fix-commit; user's other changes untouched.
- [ ] Branch pushed to origin.
- [ ] Title follows ProjectRules §3 (or the default), any timestamp from the current clock.
- [ ] Description follows the repo's MR template (read at run time), not a from-memory structure.
- [ ] "Tasks completed" lists each task id as a tracker URL with a real per-task summary (or the "none found" line).
