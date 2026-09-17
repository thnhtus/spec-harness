# Instructions — Global rule cho mọi agent

> **Phạm vi:** mọi agent của harness, trên Claude Code hoặc Codex.
> **Quan hệ:** đây là tầng luật **cao nhất** — khi xung đột, file này thắng [`agents/SharedRules.md`](./agents/SharedRules.md) và role file. Chi tiết vận hành (MCP, guardrail, nhánh, handoff, lệnh, ngân sách token) định nghĩa **một lần duy nhất** trong SharedRules — file này không lặp lại.
> **Ngôn ngữ:** Tiếng Việt; token kỹ thuật giữ nguyên gốc.

---

## 1. An toàn repository

Repo đích + các repo sibling (nếu có): [`agents/ProjectRules.md` §3](./agents/ProjectRules.md).

**Worktree — chỉ do `/start-task` tạo, agent không tự tạo.** Mỗi task chạy trong worktree riêng dưới `.claude/worktrees/` (lệnh `/start-task` step 0, qua tool `EnterWorktree`) để hai task song song không quét tree của nhau. Subagent **không** gọi `EnterWorktree`/`git worktree` — nó đã ở trong worktree khi được dispatch, cứ làm việc tại `cwd` hiện tại.

- **Nhánh protected — tuyệt đối không chạm:** `main`, `develop`, `staging`, `release/*`.
- Quy tắc nhánh làm việc (tên, cách tạo `--ff-only`, ngoại lệ nhánh user quản lý): [`agents/SharedRules.md` §3](./agents/SharedRules.md).
- **Chỉ làm khi user yêu cầu rõ trong phiên hiện tại:** `git commit`, `git push` (kể cả lần đầu), tạo/cập nhật MR, force-push, xoá nhánh. Gate xong → `status = reviewing`, tóm tắt, **dừng chờ user**.
- Không `git stash` đè thay đổi của user; không rời nhánh khi có thay đổi chưa lưu mà chưa xác nhận.

## 2. Phạm vi (Scope)

- Chỉ thực hiện đúng phạm vi đã chốt trong `03-Technical-Plan.md` của task.
- **Không refactor ngoài scope** — không "dọn" code, không đổi format hàng loạt, không đổi dependency, kể cả khi thấy code chưa tối ưu.
- Cần mở rộng scope → **escalate**: ghi đề xuất vào task doc + `.agent-memory/{role}.md`, đặt `status = needs_clarification`, dừng chờ user/BA. Không tự mở rộng.

## 3. Nguồn sự thật

Tracker = yêu cầu · Git host = nhánh/MR · Design tool = thiết kế — qua MCP, **không bịa**; trường thiếu ghi `unavailable`. Danh sách server cụ thể: [`agents/ProjectRules.md` §1](./agents/ProjectRules.md). Quy tắc đầy đủ + kỷ luật payload (summary-first, metadata-first): [`agents/SharedRules.md` §1 + §8](./agents/SharedRules.md).

Artifact nội bộ chỉ **tham chiếu**, không sửa: [`srs/`](./srs/README.md) (`FR-`/`NFR-`/`EXT-`/`DATA-`/`BR-`) · [`fsd/`](./fsd/README.md) (`FSD-<MOD>-nnn`, per-node `11.1`–`11.11`) · [`api/`](./api/README.md) (AUTOGEN từ Swagger, skill `api-docs-sync`).

## 4. Bí mật & dữ liệu nhạy cảm

**Tuyệt đối không** commit / log / ghi vào task doc / `.agent-memory/` / commit message:

- JWT (`accessToken`, `refreshToken`), cookie phiên.
- PAT của git host, token tracker/design tool, mọi MCP credential, file `.claude.json`.
- Giá trị thật của `.env` và mọi biến môi trường, khoá ký, secret CI.

Tham chiếu cấu hình bằng **tên biến**, không dán giá trị. Secret lọt vào diff → **dừng**, báo user.

## 5. Trung thực kiểm thử

Danh sách lệnh hợp lệ (one-shot cho agent; watch-mode cấm agent chạy) + quy tắc evidence: [`agents/SharedRules.md` §7](./agents/SharedRules.md). Nguyên tắc không thương lượng: **không bao giờ** tuyên bố test pass khi chưa chạy lệnh thật trong phiên; output dán nguyên văn vào `08-Test-Evidence.md`; fail → `status = blocked`, không tắt/skip test để làm xanh.

## 6. Tài liệu

Task doc tại `docs/tasks/sprint-{n}/{taskId}-{slug}/`, **append-only, tiếng Việt**, trần kích thước theo [`agents/SharedRules.md` §8](./agents/SharedRules.md). Không sửa `srs/`/`fsd/`/`api/`. Không sửa nội dung ngoài marker `SPEC-HARNESS:START…END` trong file harness sinh ra.

## 7. Tham chiếu

[`README.md`](./README.md) (chỉ mục) · [`Agents.md`](./Agents.md) (role + lifecycle + gate) · [`agents/SharedRules.md`](./agents/SharedRules.md) (quy tắc vận hành chi tiết) · [`HarnessSetup.md`](./HarnessSetup.md) (bootstrap/resume) · `../CLAUDE.md` (project instructions, nếu project có)
