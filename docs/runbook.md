# Runbook

Sự cố thường gặp khi vận hành spec-harness. Mỗi mục: triệu chứng nguyên văn → nguyên nhân → lệnh khôi phục → cách xác nhận đã xong. Trích đúng thông báo trong code (`node install.mjs --self-test` kiểm các chuỗi này còn tồn tại, nên runbook không trôi khỏi code).

## `_stamp.log` mất hoặc hỏng chữ ký

**Triệu chứng:** `… is missing entirely (N telemetry window(s) lost their witness)` hoặc `… has no validly signed _stamp.log line`.

**Nguyên nhân:** file `docs/tasks/_stamp.log` không commit (append-only, cố ý), nên `git clean -fd`, reset worktree, hoặc một agent "dọn file lạ" xoá mất.

**Khôi phục:**
```bash
node scripts/validate-tasks.mjs --restamp               # dựng lại từ telemetry, bỏ qua task done
node scripts/validate-tasks.mjs --restamp --include-done # cả task done (cân nhắc — xem #103 dưới)
```
Lệnh từ chối (exit 1) nếu log vẫn còn — không bao giờ ghi đè nhân chứng sống.

**Xác nhận:** `node scripts/validate-tasks.mjs` sạch, không còn lỗi `_stamp.log`. Dòng dựng lại có cột 7 = `restamp`, phân biệt được với dòng máy gốc ghi.

## `_stamp.log` bị xoá dòng giữa hoặc cắt đuôi (#124)

**Triệu chứng:** `line N: chain broken — a line before it was deleted, reordered or edited` hoặc `no longer contains the line this task last wrote (stampHead …) — the log was truncated or replaced`.

**Nguyên nhân:** ai đó (hoặc agent) sửa tay vào `_stamp.log` sau khi `--advance` đã ghi.

**Khôi phục:** không có cách "sửa" — log đã mất tính làm chứng. Dùng git history/backup nếu có; nếu không, coi các stage liên quan là chưa witness và chạy lại `--advance` cho chúng (ghi chain mới).

**Xác nhận:** `node scripts/validate-tasks.mjs` không còn lỗi `#124`.

## Key ký (`~/.spec-harness/stamp.key`) mất hoặc đổi máy

**Triệu chứng:** mọi dòng cũ thành `has no validly signed _stamp.log line` sau khi đổi máy hoặc xoá key.

**Nguyên nhân:** key nằm ngoài repo theo thiết kế (không commit được), nên đổi máy = key mới = chữ ký cũ không khớp.

**Khôi phục:** nếu còn log cũ và máy cũ, copy `~/.spec-harness/stamp.key` sang máy mới (hoặc đặt `SPEC_HARNESS_KEY_CMD`/`SPEC_HARNESS_KEY` trỏ cùng một nguồn trên cả hai máy). Không copy được thì `--restamp` sau khi xoá `_stamp.log` (ký lại bằng key mới, mất tính "máy khác xác nhận được" của log cũ nhưng không mất dữ liệu task).

**Xác nhận:** `node scripts/validate-tasks.mjs --preflight` không còn cảnh báo `#125` (nếu đang dùng keychain) và `--self-check` xanh.

## Lease kẹt (`mkdir`/TTL)

**Triệu chứng:** `→ this task is already running elsewhere. STOP.` kèm `pid=… host=… at=…` dù phiên trước đã chết.

**Nguyên nhân:** `scripts/lease.mjs` dùng `mkdir` (loại trừ) + TTL 30 phút. Phiên trước crash/Ctrl-C để lại thư mục lease; TTL chưa hết thì lease vẫn coi là sống.

**Khôi phục:** chờ hết TTL (30 phút kể từ lần `renew` cuối), hoặc nếu chắc chắn phiên cũ đã chết: `node scripts/lease.mjs release <task-folder>`.

**Xác nhận:** `node scripts/lease.mjs acquire <task-folder>` exit 0.

**Ceiling:** chỉ đúng trên filesystem cục bộ; không dùng trên NFS/SMB (`docs/advanced.md` §Giới hạn đã biết).

## Vượt `budget.maxTokensPerTask` (#121)

**Triệu chứng:** `task has used N tokens (fresh input + output) ≥ budget.maxTokensPerTask M`.

**Khôi phục (một trong ba, là quyết định của người, không phải máy):**
```bash
# 1. Chấp nhận vượt cho lần dispatch này, có lý do
node scripts/validate-tasks.mjs --advance <task> <stage> --accept-over-budget "<lý do>"
# 2. Nâng trần trong harness.config.json → budget.maxTokensPerTask
# 3. Split task (xem mục retryBudget bên dưới)
```

**Xác nhận:** `--advance` tiếp tục exit 0; `task.agent.json.budgetAccepted[]` có bản ghi nếu chọn (1).

## `--eval-check` chặn publish (#123)

**Triệu chứng:** `adversary inputs changed since the last green eval (…): <file list> — re-run --eval and commit the new record`, hoặc `no eval record — run node install.mjs --eval …`.

**Nguyên nhân:** role `adversary`, `Adversary.md`/`SharedRules.md`/`Instructions.md`, hoặc fixture trong `kernel/eval/adversary/` đã đổi từ lần `--eval` xanh gần nhất.

**Khôi phục:**
```bash
node install.mjs --eval --agent '<lệnh agent thật, không --case>'   # phải 100% xanh
git add kernel/eval/last-pass.json && git commit
```

**Xác nhận:** `node install.mjs --eval-check` → `✔ eval record current (…)`.

## Gate 5 FAIL lặp, vượt `retryBudget`

**Triệu chứng:** `<role> ran N× (budget M) — …` là error (chưa split) hoặc warning (đã `status: split`, giữ làm lịch sử).

**Khôi phục:** đặt `status: "split"` và `splitInto: ["<id con 1>", "<id con 2>", …]` (≥ 2 phần tử) trong `task.agent.json`, tạo các task con.

**Xác nhận:** `node scripts/validate-tasks.mjs` không còn error cho task này (chuyển thành warning lịch sử).

## Hook guard không chạy (CLI chưa trust project)

**Triệu chứng:** `git reset --hard`/`.env` không bị chặn dù đã cài; hoặc `--preflight` báo `… does not run \`validate-tasks.mjs --guard …\`` / `on that CLI the deny-list … is gone`.

**Nguyên nhân:** nhiều CLI (Codex `/hooks`, Gemini/Qwen trusted folder, Copilot `trustedFolders`, pi trust project) tắt hook project cho tới khi người dùng trust thủ công trong phiên CLI đó.

**Khôi phục:** mở đúng CLI trong project, chạy bước trust của CLI đó (`docs/advanced.md` §CLI khác Claude Code có bảng theo từng CLI). Với Codex: trust project → `/hooks` → trust hai hook spec-harness.

**Xác nhận:** `node scripts/validate-tasks.mjs --preflight` không còn lỗi guard cho CLI đó.

## Cảnh báo `#126`: không xác minh được Gate 5 độc lập

**Triệu chứng:** `<cli>: no native role files installed — cannot verify Gate 5 (adversary) runs in its own context`.

**Nguyên nhân:** CLI đó không nằm trong nhóm có role file riêng (claude/codex/cursor/gemini/qwen/droid); 7 role chạy trong một context, hoặc qua cơ chế subagent installer không thấy được (ví dụ pi extension).

**Hành động:** không phải lỗi cần "sửa" — là giới hạn đã biết của CLI đó. Nếu task quan trọng, cân nhắc chạy Gate 5 trên CLI có role file riêng.
