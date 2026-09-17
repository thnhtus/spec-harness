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

**Trước hết: xác định bố cục** (`harness.config.json → repos`, chi tiết
[`docs/Agents.md` §0](../../docs/Agents.md)). Worktree luôn tạo **trong repo
sẽ bị sửa**, không phải trong repo chứa config:

| `repos` | Repo sẽ sửa | Task docs |
| --- | --- | --- |
| một entry `path: "."` | chính repo này | đi theo worktree |
| nhiều entry, có `path: "."` | entry khớp `repoName` | đi theo worktree nếu đó là `"."`, ngược lại ở lại repo harness |
| không entry nào `path: "."` (harness đứng riêng) | entry khớp `repoName` | **ở lại repo harness**, không vào worktree |

Nhiều repo mà user không nói rõ sửa repo nào → **hỏi, đừng đoán**. Đó là
`repoName` của task và không sửa lại được sau bootstrap.

1. Lấy `taskId` + `taskName` từ tracker (tool đọc task của server tracker khai
   ở ProjectRules §1 — tự tìm, đừng hardcode tên; chỉ đọc summary) rồi suy ra
   `slug` = kebab-case không dấu của `taskName` — **cùng `slug`** mà
   orchestrator dùng cho `docsPath`/`branch`, để tên worktree, thư mục task doc
   và nhánh đọc khớp nhau.

2. Vào repo sẽ sửa rồi tạo worktree tên `task-{taskId}-{slug}`.

   - Repo đó **là** repo hiện tại → `EnterWorktree` với `name: task-{taskId}-{slug}`.
   - Repo đó **khác** (bố cục C) → `EnterWorktree` với `path:` trỏ worktree của
     repo kia, hoặc `git -C <repo-path> worktree add` rồi làm việc tại đó.

   `slug` quá dài thì cắt để cả tên ≤ 64 ký tự; `taskId` luôn giữ nguyên vì nó
   là phần tra ngược.

3. **Sửa nhánh ngay sau khi vào worktree — bắt buộc.** `EnterWorktree` tự đặt
   tên nhánh `worktree-{name}` mọc từ `origin/HEAD`, mà `origin/HEAD` thường
   trỏ `origin/main`. Cả tên lẫn gốc đều có thể lệch ProjectRules §3. Chạy ngay:

   ```bash
   git status --porcelain          # phải rỗng — worktree vừa tạo
   git fetch origin
   git switch -C <công-thức-nhánh ProjectRules §3> origin/<nhánh-đích>
   git branch -D worktree-task-{taskId}-{slug}
   ```

   `switch -C` an toàn ở đây và **chỉ** ở đây: worktree vừa sinh, tree rỗng nên
   không có gì để mất. `git status --porcelain` có output → **dừng, hỏi user**.

4. **Dựng thứ không nằm trong git mà worktree cần** (dependency đã cài, file
   env). Cách làm phụ thuộc stack — ProjectRules §7. Hai luật chung:

   - **Đừng symlink thư mục dependency** nếu toolchain ghi state build tăng
     tiến vào trong đó (vd `tsBuildInfoFile`, cache biên dịch): hai worktree
     dùng chung state → lỗi ảo. Clone copy-on-write (`cp -c` trên APFS,
     `cp --reflink=auto` trên Linux) rẻ tương đương mà không chia sẻ file.
   - **File env**: symlink được vì nó tĩnh và đã nằm trong `.gitignore`.
     **Cảnh báo bảo mật:** symlink làm nội dung env tới được mọi tiến trình
     agent khởi động. Đừng để secret không được phép lộ trong file đó.

   Gate tĩnh (type-check, lint, unit scope) thường **không** cần env — chỉ e2e
   chạm API thật mới cần.

5. Xong task (`status = reviewing`) → `ExitWorktree` với `action: "keep"`, báo
   user đường dẫn worktree. Bố cục C: nhắc rõ **task doc ở repo harness, code ở
   worktree** — hai lần commit, hai repo khác nhau.

   `ExitWorktree` có thể cảnh báo "Removing will discard N commits" với N rất
   lớn — đó là khoảng cách so với `origin/HEAD`, không phải công việc của bạn.
   `git status --porcelain` rỗng và `git log --oneline -1` = tip nhánh đích là
   an toàn.

Bỏ qua step 0 chỉ khi user nói rõ "làm ngay trên tree hiện tại".

> **Lock test dùng chung máy, không dùng chung worktree.** Project nào chặn
> chạy song song bằng lock toàn máy (chống OOM) thì worktree **không** gỡ được
> lock đó — worktree cách ly *file*, không cách ly CPU/RAM. Đấy là hành vi
> đúng, đừng "sửa" bằng cách bỏ lock.

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
| 6 | adversarial_review → Gate 5 | `adversary` | `docs/agents/Adversary.md` | `docsPath`; remind: mặc định FAIL, **tự chạy lại** lệnh ProjectRules §7 chứ không tin `08`, không sửa `src/` |
| 7 | reviewing | — (you) | — | see below |

Gate 5 FAIL → re-dispatch implementer (step 5) **một lần** với finding từ `09`;
vẫn FAIL lần hai → dừng, báo user (Gate-fail handling). Không lặp vô hạn.

Step 7 (you, no subagent): confirm `task.agent.json` has `status = reviewing`,
run `node scripts/validate-tasks.mjs --quiet` and make sure this task folder reports no
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
- Watch-mode commands (dev server, test watch, preview — liệt kê ở
  ProjectRules §7) are never run by you or any subagent.
- No working-tree-destroying git command, ever — no `git stash` (incl.
  `push -u`), `git checkout -- …`, `git restore`, `git reset --hard`,
  `git clean`. That is the exact command that lost a stage. Need a clean tree
  for a baseline? You already have one: step 0 gave you a fresh worktree.

## Step 7 — dọn worktree đã merge (sau khi báo user, trước khi dừng)

`ExitWorktree action:"keep"` không dọn gì, nên worktree tích lại — một máy đã
từng tích **108 worktree / 65 GB**, trong đó 79 nhánh đã merge (việc xong, giữ
vô nghĩa). Mỗi worktree mới clone lại dependency trên nền đó → càng lúc càng chậm.

Chạy dry-run rồi báo user con số, **không tự xoá**. Với mỗi repo trong
`harness.config.json → repos`:

```bash
TARGET=origin/<nhánh-đích ProjectRules §3>
git -C <repo-path> fetch origin -q
for w in $(git -C <repo-path> worktree list --porcelain | awk '/^worktree /{print $2}'); do
  b=$(git -C "$w" branch --show-current 2>/dev/null) || continue
  [ -z "$b" ] && continue
  # đã merge nhánh đích + tree sạch = an toàn để xoá
  git -C <repo-path> merge-base --is-ancestor "$b" "$TARGET" 2>/dev/null \
    && [ -z "$(git -C "$w" status --porcelain)" ] \
    && echo "$w  [$b]"
done
```

Danh sách in ra là **ứng viên** — commit đã nằm trong nhánh đích *và* tree sạch.
User tự quyết xoá:

```bash
git worktree remove <path> && git branch -d <branch>   # -d, KHÔNG -D: -d từ chối nếu chưa merge
```

Worktree của task **này** không bao giờ nằm trong danh sách (chưa merge) — nên
step 7 không đụng việc bạn vừa làm.
