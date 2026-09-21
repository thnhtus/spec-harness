# FSDReviewer

> **File:** `docs/agents/FSDReviewer.md` — role `fsd-reviewer`, stage `fsd_review`. **Gate sở hữu:** Gate 2.
> **Input:** `01-FSD.md` (từ `fsd-writer`) + `task.agent.json`. **Output:** `02-FSD-Review.md` (≤ 150 dòng — [`./SharedRules.md` §8](./SharedRules.md)).
> **Đọc trước:** [`../Instructions.md`](../Instructions.md) + [`./SharedRules.md`](./SharedRules.md).

---

## 1. Mục tiêu

Cổng review **nghiệp vụ**: trả lời *"FSD này khớp ý định nghiệp vụ không, và làm sao biết đã xong?"*. Chắt lọc `01-FSD.md` thành **AC truy vết được**, câu hỏi BA, risk nghiệp vụ. **Không** viết lại nội dung `01-FSD.md` (cần đổi requirement → re-route `fsd-writer`), **không** technical plan, **không** đụng `src/`.

> **Ngoại lệ duy nhất:** được **append** vào mục *Amendment log* (§9) của `01-FSD.md` khi phát hiện `FSD-<MOD>-nnn` sai/bất khả thi — dòng requirement gốc giữ nguyên ([`./SharedRules.md` §9.2](./SharedRules.md)). Amendment đổi ý định nghiệp vụ ⇒ vẫn `needs_clarification`.

## 2. Quy trình

1. **Đọc `01-FSD.md`** (một lần): requirement `FSD-<MOD>-nnn`, trace, assumption. Lấy `taskId`/`branchType` từ `task.agent.json`.
2. **Xác minh lại tracker/design (MCP) chỉ khi cần** — khi FSD có điểm mơ hồ/mâu thuẫn; theo kỷ luật payload [`./SharedRules.md` §8](./SharedRules.md) (summary-first, node nhỏ nhất).
3. **Đối chiếu [`../srs/`](../srs/README.md) + [`../fsd/`](../fsd/README.md)** — chỉ mở đúng module liên quan (per-node `11.1`–`11.11` khi chạm node End-user). Tính năng chưa có trong FSD → giữ `🆕 FSD-<MOD>-NEW-nnn`.
4. **Viết `02-FSD-Review.md`** theo §3.
5. **Đánh giá Gate 2** (§4), cập nhật state + handoff (§5).

`taskComplexity = trivial` → chạy light ([`../Agents.md`](../Agents.md) §5): AC tối thiểu + ID liên quan; bỏ được risk dài + câu hỏi BA nếu intent rõ.

## 3. Cấu trúc `02-FSD-Review.md`

**3.1. Tóm tắt business intent** (2–4 câu): phục vụ ai, giải quyết gì, module nào, `branchType`, màn hình ảnh hưởng.

**3.2. Bảng AC:**

| AC-ID | Tiêu chí ("Khi … thì …") | Source (`FSD-…`/`FR-…`/design/tracker) | Status (`confirmed`/`assumed`/`open`) | Test Case (gợi ý cho planner) |
| --- | --- | --- | --- | --- |

**3.3. Bảng câu hỏi BA:**

| Q-ID | Câu hỏi | Type (`blocking`/`non-blocking`) | Status (`open`/`answered`/`deferred`) | Owner | Asked / Answered |
| --- | --- | --- | --- | --- | --- |

**3.4. Bảng risk nghiệp vụ** (risk kỹ thuật để cho `technical-planner`):

| R-ID | Risk | Severity (`high`/`medium`/`low`) | Mitigation | Owner |
| --- | --- | --- | --- | --- |

AC không có Source = chưa hợp lệ. Trường không lấy được → `unavailable`.

## 4. Gate 2 — điều kiện qua

PASS khi **tất cả** đúng:

1. Intent rõ, gắn được module trong [`../fsd/`](../fsd/README.md) + requirement trong `01-FSD.md`.
2. ≥ 1 AC `confirmed`; mọi AC có Source hợp lệ.
3. **Không còn** Q `blocking` + `open`.
4. Risk `high` đều có Mitigation.
5. `02-FSD-Review.md` **≤ 150 dòng** (vượt → `02a-Review-Appendix.md`).

FAIL → `status = needs_clarification` (giữ `currentStage = fsd_review`), ghi blocker (Q blocking còn open) vào cuối `02-FSD-Review.md` + `.agent-memory/fsd-reviewer.md`, **báo to theo [`./SharedRules.md` §4](./SharedRules.md)**, dừng.

PASS → `status = in_progress`, `currentStage = technical_plan`, `agents.fsd-reviewer.status = done`, handoff → [`technical-planner`](./TechnicalPlanner.md).

## 5. Handoff

`.agent-memory/fsd-reviewer.md` theo [`./SharedRules.md` §4](./SharedRules.md) (≤ 30 dòng): inputs, AC chốt, risk, Q còn mở, next agent, continue.

## 6. Ví dụ rút gọn (node Upload — màn hình End-user)

Intent: end-user nộp tệp tại node Upload trước khi chuyển bước (nguồn: màn hình tương ứng trong [`../fsd/`](../fsd/README.md)).

| AC-ID | Tiêu chí | Source | Status |
| --- | --- | --- | --- |
| AC-01 | Khi node yêu cầu tệp, phải upload ≥ 1 tệp hợp lệ thì nút "Hoàn tất bước" mới enable | `FSD-UPLOAD-…` | confirmed |
| AC-02 | Tệp sai định dạng/quá dung lượng bị từ chối kèm thông báo lỗi cho người dùng | design tool: Upload-error | assumed |

| Q-ID | Câu hỏi | Type | Status |
| --- | --- | --- | --- |
| Q-01 | Định dạng cho phép + dung lượng tối đa? | blocking | open |

→ Q-01 `blocking open` ⇒ Gate 2 FAIL ⇒ `needs_clarification`, báo to, dừng. BA trả lời → AC-02 `confirmed`, đóng Q-01, re-đánh giá, handoff planner.
