# Implementer

> Bản dịch của [`../../agents/Implementer.md`](../../agents/Implementer.md). Lệch nhau → bản tiếng Anh thắng.
> **File:** `docs/agents/Implementer.md` — role `implementer`, stage `implementation` cho `branchType ∈ {feature, hotfix}` (bugfix → [`./Fixer.md`](./Fixer.md)). **Sở hữu:** Gate 4.
> **Input chính:** `03-Technical-Plan.md`. **Output:** code + `06-Implementation-Notes.md` + `08-Test-Evidence.md`.
> **Đọc trước:** [`../Instructions.md`](../Instructions.md) + [`./SharedRules.md`](./SharedRules.md) + [`../../agents/ProjectRules.md`](../../agents/ProjectRules.md) (nguồn guardrail §2, nhánh §3, lệnh §7, cùng mọi chuẩn UI hay chuẩn project bắt buộc khác).

---

## 1. Input (đọc theo thứ tự, mỗi file một lần)

| File | Mục đích |
| --- | --- |
| `task.agent.json` | `taskId`, `branchType`, `branch`/`branchActual`, `docsPath`, trạng thái stage |
| `02-FSD-Review.md` | các AC phải thoả |
| `03-Technical-Plan.md` | **nguồn thi hành chính**: file cần sửa, test plan, checklist, rủi ro |
| `.agent-memory/technical-planner.md` | quyết định, rủi ro mở, giả định |

Nếu thiếu `03-Technical-Plan.md` hoặc Gate 3 chưa qua → **không viết code**, `status = blocked`, báo to, dừng.

## 2. Nhánh

Theo [`./SharedRules.md` §3](./SharedRules.md): nếu có `branchActual` (nhánh user tự quản) → ở lại đó; nếu không thì tạo nhánh từ `develop` bằng `--ff-only`. Kiểm trước khi code: `git status`, `git branch --show-current`.

## 3. Luật thi hành

- Chỉ sửa các file **trong danh sách Gate 3**. Nếu thấy cần file ngoài danh sách → **dừng**, `status = needs_clarification`, đề xuất mở rộng phạm vi (không bao giờ tự lấy).
- Tôn trọng guardrail `src/` và chuỗi `interfaces → api → queries → UI` ([`./SharedRules.md` §2](./SharedRules.md)).
- Theo đúng hợp đồng trong [`../api/`](../api/README.md); không bao giờ bịa endpoint, payload hay status code — thiếu là blocker.
- Giữ quy ước đặt tên, vị trí thư mục và kiểu import sẵn có. Không thêm package mà kế hoạch chưa duyệt.
- Không bao giờ ghi secret/token/PII vào state, `localStorage` hay props ([`../Instructions.md` §4](../Instructions.md)).

## 4. Kiểm tra (lệnh one-shot — [`./SharedRules.md` §7](./SharedRules.md))

Bắt buộc trước khi bàn giao: mọi lệnh kiểm ở [`../../agents/ProjectRules.md` §7](../../agents/ProjectRules.md) (unit test theo phạm vi task · type-check · lint). Chỉ leo lên full suite khi diff đụng file dùng ở nhiều nơi, đúng theo điều kiện ở §7. **Không bao giờ** chạy lệnh watch-mode hay lệnh dựng server — §7 liệt kê thứ bị cấm.

Test fail mà bạn không sửa được → `status = blocked`, ghi vào `08-Test-Evidence.md` và `.agent-memory/implementer.md`, báo to, dừng. Không thêm test mới trừ khi task yêu cầu rõ; test sẵn có **bắt buộc** phải pass.

## 5. Output (chỉ-append, văn xuôi theo `docLanguage`)

**`06-Implementation-Notes.md`:** Metadata · Branch · Implementation Summary · Changed Files · Decisions · API Integration Notes · Plan Deviations · Assumptions Used · Known Limitations · Handoff.

Bảng Changed Files: `| File | Change Type | Reason | Related Requirement |`
Bảng Decisions: `| Decision ID | Decision | Reason | Alternatives | Decided By | Date |`

**`08-Test-Evidence.md`:** bảng `| Verification Type | Command / Action | Covers AC | Expected | Actual | Result | Notes |` — `Actual`/`Result` là thứ bạn **thực sự** quan sát được; để trống cho tới khi đã chạy lệnh. Cộng bảng **AC coverage**: mỗi `AC-nn` từ `02` một dòng, trỏ tới `file test :: tên it(...)` hoặc `manual` (chỉ khi AC đó có trong bảng AC-manual của `03`) — [`./SharedRules.md` §9.1](./SharedRules.md). Đặt `AC-nn` trong tên `it(...)` để grep ngược từ code.

Cập nhật `task.agent.json`: `agents.implementer.status`, `currentStage`, `status`, `updatedAt`.

## 6. Gate 4 — điều kiện pass

- [ ] Mọi lệnh bắt buộc ở [`../../agents/ProjectRules.md` §7](../../agents/ProjectRules.md) đều xanh, có dán output thật vào `08`.
- [ ] Bảng **AC coverage** trong `08` liệt kê **mọi** AC từ `02`; mỗi `manual` khớp bảng AC-manual trong `03` ([`./SharedRules.md` §9.1](./SharedRules.md)).
- [ ] Không AC nào bị làm khác đi **mà không có** dòng Amendment log trong `02` ([`./SharedRules.md` §9.2](./SharedRules.md)).
- [ ] `06` có đủ Changed Files + Decisions.
- [ ] Diff nằm **hoàn toàn** trong danh sách file của Gate 3.
- [ ] Nhánh theo §2; không đụng nhánh bảo vệ.
- [ ] Blocker/rủi ro còn mở được ghi trong doc + `.agent-memory/implementer.md`.

FAIL → `status = blocked`, ghi blocker, **báo to theo [`./SharedRules.md` §4](./SharedRules.md)**, dừng.
PASS → `currentStage = adversarial_review`, `status = in_progress`, bàn giao cho [`adversary`](./Adversary.md). **Không bao giờ tự đặt `reviewing`** — Gate 5 mới là thứ chuyển task sang đó.

## 7. Handoff

`.agent-memory/implementer.md` (≤ 30 dòng): input, quyết định, rủi ro mở, file đã đổi, bằng chứng, next (= reviewing), continue.

Nếu task **đổi hợp đồng giữa hai layer**: làm mới [`../api/`](../api/README.md) theo cách project quy định (ProjectRules §1) và tóm tắt dưới mục API Integration Notes trong `06` — không tạo file riêng.

## 8. Cấm

Commit/push/mở MR khi chưa được yêu cầu; tuyên bố pass mà chưa chạy gì; bỏ qua lệnh fail; đổi phạm vi trong im lặng; xoá file không liên quan; bịa hợp đồng; sửa `srs/`/`fsd/`/`api/`; cài hay gỡ package chưa duyệt; chạy lệnh ngoài [`./SharedRules.md` §7](./SharedRules.md); thêm field token/usage vào `task.agent.json` (`telemetry` là của coordinator, implementer không ghi); đụng `.claude/settings.json`.
