---
name: build-and-mr
description: Use when the user wants to build the frontend and open a GitLab merge request from the current branch to develop — e.g. "run the build and make an MR to dev", "build, fix any issues, then create the MR", "MR_DEV_..." title requests. Runs yarn build, auto-fixes build breakage (≤3 rounds), pushes the current branch, then creates a GitLab MR titled MR_DEV_[DDMMYYYY_HHmm]. The description follows the repo's own .gitlab/merge_request_templates/default.md and includes a detailed "Tasks completed" section with per-task notes and ClickUp links pulled from the commit log + diffstat vs develop.
---

# build-and-mr

## Overview

One flow: **`yarn build` → fix any breakage → push current branch → open a GitLab MR to `develop`** with a detailed, auto-generated description.

**Core principle:** the MR must reflect what was actually built *and verified green*. Any fix the build needed is committed (fix-only, nothing unrelated) and pushed *before* the MR is created — the MR diff and the green build always match.

**Repo facts (verified, don't re-derive):**
- Build: `yarn build` = `tsc -b && vite build` — this IS the real type-check (`tsc --noEmit` is a no-op here, per repo convention).
- Remote + project path: read from `git remote get-url origin`. MR is created through the git-host MCP declared in ProjectRules §1.
- Target branch: **`develop`** (there is no `dev`).

## When to use

- User asks to build and raise an MR/merge request to develop off the current branch.
- User gives an `MR_DEV_[...]`-style title.

**Not for:** merging the MR, assigning reviewers/labels, CI polling, or targeting `main` (ask first if the user says main). No watch-mode commands ever (`yarn dev` never exits).

## Workflow

```
1. Preflight → 2. Build (+fix loop) → 3. Commit fixes → 4. Push → 5. Compose → 6. Create MR → 7. Report
```

### 1. Preflight
- `git rev-parse --abbrev-ref HEAD` → current branch. **Abort** if it is `develop` or `main` (nothing to MR from a base branch).
- `git fetch origin develop` so the diff base is current.

### 2. Build + fix loop (≤3 rounds)
Run `yarn build` (`tsc -b && vite build` — the real type-check). If it **passes**, go to step 3.

If it fails, for each round (max 3):
- Read the `tsc`/`vite` errors. Fix only **clear build blockers** — type errors, bad/missing imports, obvious lint-fatal issues — at the **root cause**, minimal diff. Match surrounding code style.
- Re-run `yarn build`.

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
- **Title** — generate fresh from local time:
  ```
  TITLE="MR_DEV_[$(date +'%d%m%Y_%H%M')]"
  ```
  e.g. `MR_DEV_[03072026_1451]`. Brackets literal; date `DDMMYYYY`, time `HHmm`, 24-hour, local zone.

- **Description** — start from the repo's own MR template so the MR matches
  what reviewers expect, then fill it from git facts (not memory):
  ```
  cat .gitlab/merge_request_templates/default.md   # the base structure — read at run time
  git log --pretty='- %s' origin/develop..HEAD     # commit list
  git diff --stat origin/develop...HEAD            # changed files, group by area
  ```
  Fill the template's sections in place — do **not** invent a parallel structure:
  - **Description**: one paragraph on what the branch does.
  - **Type of Change**: check the box(es) the commits actually match.
  - **Changes Summary**: grouped diffstat bullets by area (`src/pages/...`, `docs/...`, `src/test/...`).
  - **Checklist**: tick only what's genuinely true (build green → testing/quality boxes you verified); leave the rest unchecked.
  - Drop `Closes #`, `How to Test`, `Screenshots`, and the `/assign`/`/reviewer`/`/label` quick-action footer unless the user asked for them — this flow neither assigns nor closes issues.
  - Replace the `Related Issues` section with the **Tasks completed** block below.

- **Tasks completed (with ClickUp links)** — insert right after Changes Summary:
  - Extract ClickUp task ids from commit subjects. Convention here is a trailing
    `[<id>]` (sometimes comma-separated), e.g. `feat(users): editable drawer [86d3mfuk7, 86d3mg82w]`:
    ```
    git log --pretty='%s%n%b' origin/develop..HEAD \
      | grep -oE '86[a-z0-9]{7,}' | sort -u        # unique ClickUp ids
    ```
  - For each id, write one bullet: **what was done** (from the matching commit
    subject, human-readable) + the link `https://app.clickup.com/t/<id>`.
  - If a commit has no id, still list its work under a plain bullet (no link).
  - No ids anywhere → write `_No ClickUp task references found in commits._`

```markdown
### Tasks completed
- **<short human summary of the task>** — https://app.clickup.com/t/<id>
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
- **<task summary>** — https://app.clickup.com/t/<id>
- ...

### Verification
- `yarn build`: <passed clean | passed after fixes — 1-line note>

## Additional Context
<external deps, BE-side work, or "none">
```

### 6. Create the MR
Call the git-host MCP's create-merge-request tool (ProjectRules §1):
- `id`: project path from `git remote get-url origin`
- `source_branch`: current branch · `target_branch`: `develop`
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
| Targeting `main`/`master` | Target `develop`; confirm with user if they truly meant main. |
| Committing unrelated working-tree changes to make the diff "clean" | Leave them; the MR is only your branch's commits vs develop. |
| Silencing type errors with `any`/`@ts-ignore` to force green | Fix the root cause; if still red after 3 rounds, stop and report. |

## Self-check (before creating the MR)

- [ ] `yarn build` exited 0 (real output, not assumed).
- [ ] Only build-fix files are in the fix-commit; user's other changes untouched.
- [ ] Branch pushed to origin.
- [ ] Title is `MR_DEV_[DDMMYYYY_HHmm]` from the current clock.
- [ ] Description follows `.gitlab/merge_request_templates/default.md` (read at run time), not a from-memory structure.
- [ ] "Tasks completed" lists each ClickUp id as `https://app.clickup.com/t/<id>` with a real per-task summary (or the "none found" line).
