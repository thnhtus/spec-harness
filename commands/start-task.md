---
description: Start a ClickUp task and run it through the repo's docs/ FE harness (orchestrator → fsd-writer → fsd-reviewer → technical-planner → implementer → reviewing), one subagent per stage
argument-hint: <clickup-task-url-or-id>
---

You are starting work on a ClickUp task: **$ARGUMENTS**

Run the task through the **repo `docs/` harness** (6 roles, 4 gates, defined
under `docs/`). Do **not** use `claude-code-harness`. Never skip a stage
because the change "looks small" — the weight of the flow is decided *after*
the task is understood (`taskComplexity = trivial` makes Gates 1–2 run light,
it does not remove them).

## Architecture: you are the COORDINATOR, not the worker

**Each stage runs as a separate subagent (Agent tool) with its own fresh
context.** You — the main loop — must NOT write the FSD, the review, the plan,
or the implementation yourself. Running all stages in one context is the
known failure mode of this harness (context exhaustion → mid-run stall).

Your responsibilities only:

1. Read `docs/Agents.md` (lifecycle, gates) — you do not need the role files.
2. Dispatch one subagent per stage, in order, passing a **small** prompt
   (paths + IDs, never pasted file contents).
3. After each subagent returns, read ONLY:
   - `task.agent.json` (`status`, `currentStage`)
   - the last `## Next Handoff` block of `.agent-memory/{role}.md`
4. Gate PASS (`Continue automation: yes`) → dispatch the next stage.
   Gate FAIL → **stop everything** and report loudly (see Gate-fail handling).
5. Never read `01-FSD.md` / `02-FSD-Review.md` / `03-Technical-Plan.md`
   contents into your own context — subagents read them; you route on
   handoffs only.

## Step 0 — cách ly worktree (trước mọi dispatch)

Hai session Claude trên cùng một tree đã từng làm mất một stage hoàn chỉnh: một
session chạy `git stash push -u` để lấy baseline test, quét luôn task folder
(còn untracked) của session kia → planner phải chạy lại. Worktree loại bỏ hẳn
lớp lỗi đó.

1. Lấy `taskId` + `taskName` từ ClickUp (`mcp__clickup__getTaskById`, chỉ đọc
   summary) rồi suy ra `slug` = kebab-case không dấu của `taskName` — **cùng
   `slug`** mà orchestrator dùng cho `docsPath`/`branch`
   ([`docs/agents/SharedRules.md` §3](../../docs/agents/SharedRules.md)), để tên
   worktree, thư mục task doc và nhánh đọc khớp nhau.
2. Gọi `EnterWorktree` với `name: task-{taskId}-{slug}` → worktree nằm tại
   `.claude/worktrees/task-{taskId}-{slug}/` (thư mục `.claude/worktrees/` do
   tool cố định, không cấu hình được).

   Ví dụ: `86d3ukd1v` + "Filter trạng thái biểu mẫu" →
   `task-86d3ukd1v-filter-trang-thai-bieu-mau`.

   `slug` quá dài thì cắt bớt để cả tên ≤ 64 ký tự (giới hạn của
   `EnterWorktree`); `taskId` luôn giữ nguyên vì nó là phần tra ngược.
3. **Sửa nhánh ngay sau khi vào worktree — bắt buộc.** `EnterWorktree` chỉ
   nhận `name` (tên thư mục); nó tự đặt tên nhánh `worktree-{name}` và
   `worktree.baseRef: fresh` cho nhánh mọc từ `origin/HEAD` — mà `origin/HEAD`
   ở repo này trỏ `origin/main`, **không** phải `develop`. Cả hai đều lệch
   [`SharedRules §3`](../../docs/agents/SharedRules.md). Chạy ngay:

   ```bash
   git status --porcelain          # phải rỗng — worktree vừa tạo, chưa có gì
   git fetch origin
   git switch -C tubt/t/{taskId}-{slug} origin/develop
   git branch -D worktree-task-{taskId}-{slug}
   ```

   `switch -C` an toàn ở đây và **chỉ** ở đây: worktree vừa sinh ra, tree rỗng
   nên không có gì để mất. Nếu `git status --porcelain` có output thì **dừng**,
   hỏi user — đừng chuyển nhánh đè lên thay đổi của họ.

   Kiểm lại: `git branch --show-current` = `tubt/t/{taskId}-{slug}` và
   `git log --oneline -1` = tip của `origin/develop`.
4. Trong worktree mới, chép `node_modules` (thứ duy nhất không có trong git mà
   agent chép được):

   ```bash
   cp -c -R <đường-dẫn-repo-gốc>/node_modules node_modules   # APFS copy-on-write: ~6s, ~0 disk thật
   ```

   **Không symlink `node_modules`** — `tsconfig.app.json` ghi `tsBuildInfoFile`
   vào `./node_modules/.tmp/`; symlink làm hai worktree dùng chung state
   incremental của `tsc -b` → lỗi type ảo. `cp -c` là clone CoW, rẻ như symlink
   mà không chia sẻ file.

   `.env` thì **symlink**, không `cp` — `cp` phải *đọc* file nên bị
   `permissions.deny` + `sandbox.filesystem.denyRead` (`.claude/settings.json`)
   từ chối, còn `ln -s` chỉ *tạo* link nên chạy được:

   ```bash
   ln -sfn <đường-dẫn-repo-gốc>/.env .env   # KHÔNG dùng cp — cp bị deny
   ```

   Lệnh này cần rule `Bash(ln -sfn */.env .env)` trong `permissions.allow`
   (đã có ở `~/.claude/settings.json`). Symlink an toàn ở đây (khác
   `node_modules` bên trên): `.env` là file tĩnh chỉ-đọc, không có state
   incremental nào để hai worktree giẫm lên nhau; `.env` cũng đã nằm trong
   `.gitignore` nên symlink không bao giờ bị commit.

   Có symlink thì `npx vite` trong worktree tự nạp `VITE_API` — không cần
   truyền tay nữa (đã kiểm chứng 2026-08-28).

   **Chạy e2e API thật:** vite chỉ nạp `.env` cho code trình duyệt, tiến trình
   vitest thì không — mà `helpers/auth.ts` đọc `VITE_E2E_CREDENTIAL_USERNAME`/
   `_PASSWORD` từ `process.env`. Nạp vào shell trước khi chạy (`--env-file`
   **không** dùng được trong `NODE_OPTIONS`, node từ chối):

   ```bash
   set -a; . ./.env; set +a
   E2E_BASE_URL=http://localhost:<port> npm run test:e2e:run -- <file>
   ```

   **Cảnh báo bảo mật — đọc kỹ.** Symlink làm nội dung `.env` (kể cả
   `GITLAB_TOKEN`, credentials) tới được **mọi tiến trình agent khởi động**:
   vite, vitest, script node. Đó chính là thứ làm e2e chạy được, không phải
   tác dụng phụ. Ngoài ra nếu `permissions.allow` có `Read(./.env)` thì agent
   đọc thẳng được nội dung — user allow thắng project deny; xoá dòng `Read`
   đó nếu chỉ muốn symlink (bỏ `Read` **không** làm hỏng symlink). Đừng để
   secret không được phép lộ với tiến trình test trong `.env`.

   Vẫn không bắt buộc cho gate: `tsc -b`, `npm run lint`, `npm run test:scope`
   không cần `.env`.
5. Xong task (`status = reviewing`) → `ExitWorktree` với `action: "keep"`, rồi
   báo user đường dẫn worktree để họ tự commit/push/MR ở đó.

   Xoá worktree bỏ đi thì `ExitWorktree` cảnh báo kiểu "Removing will discard
   N commits" với N rất lớn (vd 1111) — đó là khoảng cách so với `origin/main`,
   **không** phải công việc của bạn. Kiểm `git status --porcelain` rỗng và
   `git log --oneline -1` = tip `origin/develop` là biết an toàn; xoá xong nhớ
   `git branch -D tubt/t/{taskId}-{slug}` vì nhánh vẫn còn lại.

Bỏ qua step 0 chỉ khi user nói rõ "làm ngay trên tree hiện tại".

> **Test vẫn xếp hàng giữa các worktree** — `scripts/test-locked.mjs` lock theo
> máy (`tmpdir()`), cố ý: OOM là giới hạn RAM máy, không phải RAM/worktree.
> Worktree cách ly *file*, không cách ly CPU/RAM. Đây là hành vi đúng, không
> phải bug — đừng "sửa" bằng cách bỏ lock.

## Stage dispatch table

Dispatch with the Agent tool, `subagent_type` = the role name (registered in
`.claude/agents/`). Every subagent prompt MUST start with this preamble:

> Read, in order: `docs/Instructions.md`, `docs/agents/SharedRules.md`, then
> your role file named below. Obey the artifact size caps and MCP payload
> discipline in SharedRules §8. Work only inside the task folder and the
> files your role owns. When done, append your `## Next Handoff` block
> (≤ 30 lines) to `.agent-memory/{role}.md` and update `task.agent.json`.
> End your final message with: gate verdict (PASS/FAIL), status set, and the
> one-line reason.

| # | Stage | subagent_type | Role file | Prompt adds |
| --- | --- | --- | --- | --- |
| 1 | bootstrap | `orchestrator` | `docs/agents/Orchestrator.md` | the ClickUp URL/id from `$ARGUMENTS`; current git branch |
| 2 | fsd_write → Gate 1 | `fsd-writer` | `docs/agents/FSDWriter.md` | `docsPath` from step 1 |
| 3 | fsd_review → Gate 2 | `fsd-reviewer` | `docs/agents/FSDReviewer.md` | `docsPath` |
| 4 | technical_plan → Gate 3 | `technical-planner` | `docs/agents/TechnicalPlanner.md` | `docsPath` |
| 5 | implementation → Gate 4 | `fe-implementer` (branchType feature/hotfix) or `fe-fix` (bugfix) | `docs/agents/FEImplementer.md` / `docs/agents/FEFix.md` | `docsPath`; remind: only files in the Gate-3 list; one-shot commands only |
| 6 | reviewing | — (you) | — | see below |

Step 6 (you, no subagent): confirm `task.agent.json` has `status = reviewing`,
run `npm run validate:tasks --quiet` and make sure this task folder reports no
errors (it enforces the AC traceability chain, SharedRules §9), then post the
final summary: what changed (from the implementer's handoff), test evidence
location (`08-Test-Evidence.md`), and the remaining user decisions (commit /
push / MR / ClickUp status). **Stop.** Do not commit or push — the user does
that themselves.

## Hard rules for subagent prompts

- Pass **paths and IDs**, never file contents — the subagent reads its own
  inputs from disk/MCP. A bloated dispatch prompt recreates the token problem
  this architecture exists to solve.
- One stage = one subagent call. Do not merge stages "to save time".
- If a subagent returns without having written its handoff block, re-dispatch
  it once with the instruction to complete the handoff; if it fails again,
  treat it as a gate FAIL.

## Gate-fail handling

When any gate fails (`status = blocked` or `needs_clarification`,
`Continue automation: no`):

- Do NOT dispatch the next stage. Do NOT retry in a loop.
- Report to the user, loudly and immediately, all four of:
  1. which gate failed,
  2. why (from the handoff block),
  3. which file holds the blocker details,
  4. exactly what the user/BA must do to unblock.
- Stop. Resume later via `docs/HarnessSetup.md` §7 (re-dispatch the stage
  recorded in `currentStage`).

## Constraints (inherited — do not restate to subagents, they read the docs)

- No commit / push / MR unless the user explicitly asks (user commits
  themselves).
- MCP is the source of truth; missing fields are `unavailable`, never
  invented. If an MCP call fails with an auth error: stop and tell the user
  to re-login via `/mcp`.
- Never modify `docs/srs/`, `docs/fsd/`, `docs/api/` content, the
  `docs/tasks/_templates/` originals, or `.claude/settings*.json`.
- Watch-mode commands (`npm run dev`, `npm run test`, `npm run test:ui`,
  `npm run test:e2e`, `npm run preview`) are never run by you or any
  subagent.
- No working-tree-destroying git command, ever — no `git stash` (incl.
  `push -u`), `git checkout -- …`, `git restore`, `git reset --hard`,
  `git clean`. That is the exact command that lost a stage. Need a clean tree
  for a baseline? You already have one: step 0 gave you a fresh worktree.

## Step 7 — dọn worktree đã merge (sau khi báo user, trước khi dừng)

`ExitWorktree action:"keep"` không dọn gì, nên worktree tích lại: đo ngày
2026-08-31 được **108 worktree / 65 GB**, trong đó **79 branch đã merge vào
`origin/develop`** (việc xong, giữ vô nghĩa). Mỗi worktree mới `cp -c`
`node_modules` trên nền đó → càng lúc càng chậm.

Chạy dry-run rồi báo user con số, **không tự xoá**:

```bash
git fetch origin -q
for w in $(git worktree list --porcelain | awk '/^worktree /{print $2}' | grep '/.claude/worktrees/'); do
  b=$(git -C "$w" branch --show-current 2>/dev/null) || continue
  [ -z "$b" ] && continue
  # đã merge develop + tree sạch = an toàn để xoá
  git merge-base --is-ancestor "$b" origin/develop 2>/dev/null \
    && [ -z "$(git -C "$w" status --porcelain)" ] \
    && echo "$w  [$b]"
done
```

Danh sách in ra là **ứng viên** — chỉ những worktree mà commit đã nằm trong
`origin/develop` *và* tree sạch. User tự quyết xoá:

```bash
git worktree remove <path> && git branch -d <branch>   # -d, KHÔNG -D: -d từ chối nếu chưa merge
```

Worktree của task **này** không bao giờ nằm trong danh sách (chưa merge) — nên
step 7 không đụng việc bạn vừa làm.
