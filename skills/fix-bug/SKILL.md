---
name: fix-bug
description: Use when the user wants a ClickUp bug fixed fast, without the docs/ FE harness — e.g. "fix bug <id>", "sửa bug <url>, khỏi harness", "debug ticket này rồi fix". Reads the ticket, isolates a worktree, reproduces the bug with a failing test, fixes the root cause, verifies, and writes ONE evidence file. No FSD, no SRS, no task folder, no gates, no subagents.
---

# fix-bug — ticket → worktree → repro → fix → evidence

Giữ đúng 3 thứ đáng giá của harness: **worktree cách ly**, **reproduce-first**,
**evidence thật**. Bỏ hết phần giấy tờ: không FSD, không FSD-Review, không
technical plan, không `task.agent.json`, không `.agent-memory/`, không gate,
không subagent. Một context, một file evidence.

Feature/task chung (không phải bug) → dùng `quick-task` hoặc `/start-task`.

## 1. Ticket

Tool đọc task của tracker MCP (tự tìm trong tool của phiên — ProjectRules §1) với id (bỏ tiền tố `#`, `CU-`, phần URL). Đọc description +
comment: **expected vs actual** và **các bước tái hiện**. Thiếu repro → hỏi
user, đừng đoán triệu chứng.

Rút ra: `slug` = kebab-case không dấu của tên task.

## 2. Worktree

Theo đúng Step 0 của [`.claude/commands/start-task.md`](../../commands/start-task.md)
— đọc file đó, đừng chép lại ở đây. Tóm tắt:

```bash
# EnterWorktree name: task-{taskId}-{slug}   → .claude/worktrees/task-{taskId}-{slug}/
git status --porcelain                        # phải rỗng, không thì DỪNG hỏi user
git fetch origin
git switch -C {công-thức-nhánh} origin/{nhánh-đích}   # ProjectRules §3; EnterWorktree mọc từ origin/HEAD, phải sửa
git branch -D worktree-task-{taskId}-{slug}
cp -c -R <repo-gốc>/node_modules node_modules # CoW ~6s; KHÔNG symlink (tsBuildInfo dùng chung → lỗi type ảo)
```

**Link `.env` ngay — đây là thứ mở khoá e2e API thật ở §5.** Worktree không có
`.env` thì `VITE_API` rỗng, request đi vào hư không và credential e2e cũng
không có:

```bash
ln -sfn <repo-gốc>/.env .env   # symlink; KHÔNG cp — cp phải *đọc* .env nên bị deny
```

`ln -s` chỉ *tạo* link nên chạy được, `cp` thì không. `.env` là file tĩnh
chỉ-đọc nên hai worktree dùng chung vô hại (khác `node_modules`), và đã nằm
trong `.gitignore` nên không bao giờ bị commit. Có symlink thì `npx vite` trong
worktree tự nạp `VITE_API`.

Kiểm nhanh, không cần đọc nội dung:

```bash
test -e .env && grep -c VITE_E2E_CREDENTIAL_USERNAME .env   # 1 → e2e login thật chạy được
```

User nói "làm ngay trên tree hiện tại" → bỏ qua cả mục này.

## 3. Reproduce-first — bắt buộc, đây là phần không được bỏ

```
Viết Vitest tái hiện bug
  → npm run test:scope -- <file>   → FAIL đúng triệu chứng
     (fail sai lý do = test viết sai → sửa test, chưa động vào src/)
  → sửa code
  → npm run test:scope -- <file>   → PASS
```

Test này ở lại vĩnh viễn làm regression test. Thêm vào file test sẵn có cùng
feature nếu có; đừng dựng suite mới.

**Không tái hiện được** → dừng, báo user, đừng "sửa mò" theo mô tả.

Bug chỉ thấy trên trình duyệt → dùng skill `verify`, ghi repro thủ công
before/after vào evidence.

## 4. Fix — root cause, diff tối thiểu

- Grep **mọi caller** của hàm sắp sửa trước khi sửa. Một guard trong hàm dùng
  chung nhỏ hơn một guard ở từng caller — và vá riêng đường ticket nhắc tên thì
  các caller anh em vẫn hỏng.
- Không refactor lân cận, không đổi tên prop, không restyle, không "dọn tiện tay".
- Không che triệu chứng: không `@ts-ignore`, không nuốt lỗi axios, không
  skip/tắt test sẵn có đang fail.
- Guardrail `src/` vẫn áp dụng — `docs/agents/SharedRules.md` §2. Hay vi phạm
  nhất: request qua `src/api/apiClient.ts`, server state qua `queries/` +
  react-query, lỗi BE qua `normalizeErrorHelper()`, không thêm dependency.

## 5. Verify

```bash
npm run test:scope -- <file test của bug>
npx tsc -b            # root --noEmit là no-op
npm run lint
```

`npm run test:run` (full suite) **chỉ khi** chạm barrel dùng chung. Baseline
`develop` có sẵn ~164 test fail — so **tập file fail**, đừng so tổng số.

**E2E API thật — setup y hệt §5b của skill `quick-task`**, không chép lại ở đây:
dev server riêng trên cổng trống, rồi một MCP điều khiển browser nếu phiên có (vd BrowserOS neo, Playwright)
và **Playwright** (`test:e2e:run`) theo đúng phân vai ở đó. `.env` đã symlink ở
§2 nên credential có sẵn.

Với bug, cả hai đều có việc và đi theo trình tự:

1. **neo** — chạy đúng repro của ticket trên UI thật, xác nhận lỗi có thật và
   quan sát triệu chứng. Đây là before.
2. sửa xong → **neo** lại lần nữa: after.
3. **Playwright** — nếu triệu chứng khoá được bằng e2e thì viết một test giữ
   lại; không thì regression test ở §3 (unit) là đủ.

Smoke ≥ 1 luồng lân cận (test hoặc trình duyệt) — bug hay đẻ bug.

## 6. Evidence — MỘT file

`docs/tasks/fixes/{taskId}-{slug}.md`, tiếng Việt, ngắn:

```markdown
# {taskId} — {tên task}

**Ticket:** {tracker-url} · **Nhánh:** {công-thức-nhánh — ProjectRules §3}

## Triệu chứng
Expected vs actual, các bước tái hiện.

## Root cause
Vì sao lỗi, ở `file:line` nào.

## Fix
File đã sửa + một dòng lý do mỗi file.

## Evidence
- Repro FAIL trước fix: <output thật, cắt gọn>
- Test PASS sau fix: <output thật>
- `npx tsc -b`: <output>
- `npm run lint`: <output>
- E2E API thật (BrowserOS neo / Playwright): <repro before/after trên UI thật>
- Smoke luồng lân cận: <mô tả + kết quả>

## Regression risk
Rủi ro còn lại + cách giảm (bỏ trống nếu không có).
```

**Không bịa số liệu test** — dán output thật, hoặc ghi rõ chưa chạy.

## 7. Dừng

Báo user: root cause, file đã sửa, đường dẫn worktree, đường dẫn file evidence.
`ExitWorktree action: "keep"`.

`git commit` / `git push` / MR / đổi status ClickUp: **chỉ khi user yêu cầu**.
