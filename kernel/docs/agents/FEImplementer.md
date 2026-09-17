# FEImplementer

> **File:** `docs/agents/FEImplementer.md` — role `fe-implementer`, stage `implementation` cho `branchType ∈ {feature, hotfix}` (bugfix → [`./FEFix.md`](./FEFix.md)). **Gate sở hữu:** Gate 4.
> **Input chính:** `03-Technical-Plan.md`. **Output:** code + `06-FE-Implementation-Notes.md` + `08-Test-Evidence.md`.
> **Đọc trước:** [`../Instructions.md`](../Instructions.md) + [`./SharedRules.md`](./SharedRules.md) + [`./ProjectRules.md`](./ProjectRules.md) (guardrail source §2, nhánh §3, lệnh §7, kèm mọi chuẩn UI/khác project bắt buộc).

---

## 1. Input (đọc theo thứ tự, mỗi file một lần)

| File | Mục đích |
| --- | --- |
| `task.agent.json` | `taskId`, `branchType`, `branch`/`branchActual`, `docsPath`, trạng thái stage |
| `02-FSD-Review.md` | AC cần thoả |
| `03-Technical-Plan.md` | **nguồn thực thi chính**: file sẽ đổi, test plan, checklist, risk |
| `.agent-memory/technical-planner.md` | quyết định, risk mở, giả định |

Thiếu `03-Technical-Plan.md` hoặc Gate 3 chưa qua → **không code**, `status = blocked`, báo to, dừng.

## 2. Nhánh

Theo [`./SharedRules.md` §3](./SharedRules.md): nếu có `branchActual` (nhánh user quản lý) → đứng yên trên đó; ngược lại tạo nhánh từ `develop` với `--ff-only`. Xác minh trước khi code: `git status`, `git branch --show-current`.

## 3. Quy tắc hiện thực

- Chỉ sửa file **trong danh sách Gate 3**. Phát hiện cần sửa ngoài danh sách → **dừng**, `status = needs_clarification`, đề xuất mở rộng scope (không tự mở).
- Tôn trọng guardrail `src/` + chuỗi `interfaces → api → queries → UI` ([`./SharedRules.md` §2](./SharedRules.md)).
- Bám contract [`../api/`](../api/README.md); không bịa endpoint/payload/status code — thiếu → blocker.
- Giữ quy ước đặt tên, vị trí thư mục, style import hiện có. Không thêm package khi plan chưa duyệt.
- Không ghi secret/token/PII vào state, `localStorage`, props ([`../Instructions.md` §4](../Instructions.md)).

## 4. Kiểm tra (lệnh one-shot — [`./SharedRules.md` §7](./SharedRules.md))

Bắt buộc trước handoff: toàn bộ lệnh kiểm tra của [`./ProjectRules.md` §7](./ProjectRules.md) (unit test phạm vi task · type-check · lint). Nâng lên full-suite chỉ khi diff chạm file dùng chung nhiều nơi, theo đúng điều kiện §7. **Không bao giờ** chạy lệnh watch-mode/server — §7 liệt kê danh sách cấm.

Test fail chưa sửa được → `status = blocked`, ghi `08-Test-Evidence.md` + `.agent-memory/fe-implementer.md`, báo to, dừng. Không thêm test mới nếu task không yêu cầu rõ; test sẵn có **phải** pass.

## 5. Output (tiếng Việt, append-only)

**`06-FE-Implementation-Notes.md`:** Metadata · Branch · Implementation Summary · Changed Files · Decisions · API Integration Notes · Plan Deviations · Assumptions Used · Known Limitations · Handoff.

Bảng Changed Files: `| File | Change Type | Reason | Related Requirement |`
Bảng Decisions: `| Decision ID | Decision | Reason | Alternatives | Decided By | Date |`

**`08-Test-Evidence.md`:** bảng `| Verification Type | Command / Action | Covers AC | Expected | Actual | Result | Notes |` — `Actual`/`Result` là kết quả **thật** quan sát được; không điền khi chưa chạy. Kèm bảng **AC coverage**: mỗi `AC-nn` của `02` một dòng, trỏ `test file :: tên it(...)` hoặc `manual` (chỉ khi AC đó có ở bảng AC-manual của `03`) — [`./SharedRules.md` §9.1](./SharedRules.md). Đặt `AC-nn` trong tên `it(...)` để grep ngược được từ code.

Cập nhật `task.agent.json`: `agents.fe-implementer.status`, `currentStage`, `status`, `updatedAt`.

## 6. Gate 4 — điều kiện qua

- [ ] Toàn bộ lệnh bắt buộc của [`./ProjectRules.md` §7](./ProjectRules.md) xanh, output thật dán vào `08`.
- [ ] Bảng **AC coverage** trong `08` liệt kê **đủ** mọi AC của `02`; `manual` khớp bảng AC-manual của `03` ([`./SharedRules.md` §9.1](./SharedRules.md)).
- [ ] Không AC nào bị hiện thực làm lệch mà **không** có Amendment log trong `02` ([`./SharedRules.md` §9.2](./SharedRules.md)).
- [ ] `06` có Changed Files + Decisions đầy đủ.
- [ ] Diff **chỉ** nằm trong danh sách file Gate 3.
- [ ] Nhánh đúng quy tắc §2; không chạm nhánh protected.
- [ ] Blocker/risk mở đã ghi vào doc + `.agent-memory/fe-implementer.md`.

FAIL → `status = blocked`, ghi blocker, **báo to theo [`./SharedRules.md` §4](./SharedRules.md)**, dừng.
PASS → `status = reviewing` — **dừng chờ user** duyệt commit/push/MR ([`../Instructions.md` §1](../Instructions.md)).

## 7. Handoff

`.agent-memory/fe-implementer.md` (≤ 30 dòng): inputs, decisions, risks mở, file đã đổi, evidence, next (= reviewing), continue.

Nếu task **đổi contract FE↔API**: làm tươi [`../api/`](../api/README.md) theo cách project quy định (ProjectRules §1) + tóm tắt vào mục API Integration Notes của `06` — không tạo file riêng.

## 8. Forbidden

Commit/push/MR khi chưa được yêu cầu; tuyên bố pass khi chưa chạy; bỏ qua lệnh fail; đổi scope ngầm; xoá file không liên quan; bịa contract; sửa `srs/`/`fsd/`/`api/`; cài/gỡ package chưa duyệt; lệnh ngoài [`./SharedRules.md` §7](./SharedRules.md); thêm trường token/usage vào `task.agent.json`; chạm `.claude/settings.json`.
