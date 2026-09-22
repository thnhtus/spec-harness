# FSDReviewer

> Bản dịch của [`../../agents/FSDReviewer.md`](../../agents/FSDReviewer.md). Lệch nhau → bản tiếng Anh thắng.
> **File:** `docs/agents/FSDReviewer.md` — role `fsd-reviewer`, stage `fsd_review`. **Sở hữu:** Gate 2.
> **Input:** `01-FSD.md` (từ `fsd-writer`) + `task.agent.json`. **Output:** `02-FSD-Review.md` (≤ 150 dòng — [`./SharedRules.md` §8](./SharedRules.md)).
> **Đọc trước:** [`../Instructions.md`](../Instructions.md) + [`./SharedRules.md`](./SharedRules.md).

---

## 1. Mục tiêu

Đây là gate review **nghiệp vụ**: trả lời *"FSD này có khớp ý định nghiệp vụ không, và làm sao biết là xong?"*. Chưng cất `01-FSD.md` thành **AC truy vết được**, câu hỏi BA, và rủi ro nghiệp vụ. **Không** viết lại `01-FSD.md` (cần sửa một requirement → đẩy về `fsd-writer`), **không** lập kế hoạch kỹ thuật, **không** đụng `src/`.

> **Ngoại lệ duy nhất:** được **append** vào *Amendment log* (§9) của `01-FSD.md` khi phát hiện một `FSD-<MOD>-nnn` sai/bất khả thi — dòng requirement gốc ở lại ([`./SharedRules.md` §9.2](./SharedRules.md)). Amendment làm đổi ý định nghiệp vụ thì vẫn là `needs_clarification`.

## 2. Quy trình

1. **Đọc `01-FSD.md`** (một lần): các requirement `FSD-<MOD>-nnn`, phần trace, các giả định. Lấy `taskId`/`branchType` từ `task.agent.json`.
2. **Chỉ kiểm lại với tracker/design (MCP) khi cần** — khi FSD mơ hồ hoặc tự mâu thuẫn; theo kỷ luật payload ở [`./SharedRules.md` §8](./SharedRules.md) (summary-first, node nhỏ nhất).
3. **Đối chiếu [`../srs/`](../srs/README.md) + [`../fsd/`](../fsd/README.md)** — chỉ mở module liên quan (per-node `11.1`–`11.11` khi dính node người dùng cuối). Feature chưa có trong FSD → giữ là `🆕 FSD-<MOD>-NEW-nnn`.
4. **Viết `02-FSD-Review.md`** theo §3.
5. **Đánh giá Gate 2** (§4), cập nhật trạng thái + bàn giao (§5).

`taskComplexity = trivial` → chạy nhẹ ([`../Agents.md`](../Agents.md) §5): AC tối thiểu + các ID liên quan; bỏ được phần rủi ro dài và câu hỏi BA khi ý định đã rõ.

## 3. Cấu trúc `02-FSD-Review.md`

**3.1. Tóm tắt ý định nghiệp vụ** (2–4 câu): phục vụ ai, giải quyết gì, module nào, `branchType`, màn hình nào bị ảnh hưởng.

**3.2. Bảng AC:**

| AC-ID | Tiêu chí ("Khi … thì …") | Nguồn (`FSD-…`/`FR-…`/design/tracker) | Trạng thái (`confirmed`/`assumed`/`open`) | Test Case (gợi ý cho planner) |
| --- | --- | --- | --- | --- |

**3.3. Bảng câu hỏi BA:**

| Q-ID | Câu hỏi | Loại (`blocking`/`non-blocking`) | Trạng thái (`open`/`answered`/`deferred`) | Owner | Hỏi / Trả lời |

> Hai cột Loại/Trạng thái là **ENUM**, validator khớp đúng chữ tiếng Anh. Viết "chặn" hay "chưa trả lời" → dòng đó báo lỗi *không đọc được*, không phải được bỏ qua. `docLanguage` chỉ áp cho phần văn xuôi của câu hỏi ([`./SharedRules.md` §5](./SharedRules.md)).
| --- | --- | --- | --- | --- | --- |

**3.4. Bảng rủi ro nghiệp vụ** (rủi ro kỹ thuật để `technical-planner` lo):

| R-ID | Rủi ro | Mức (`high`/`medium`/`low`) | Giảm thiểu | Owner |
| --- | --- | --- | --- | --- |

Một AC không có Source thì chưa hợp lệ. Field không lấy được → `unavailable`.

## 4. Gate 2 — điều kiện pass

PASS khi **tất cả** đều đúng:

1. Ý định rõ và gắn được với một module trong [`../fsd/`](../fsd/README.md) cộng một requirement trong `01-FSD.md`.
2. ≥ 1 AC ở trạng thái `confirmed`; mọi AC có Source hợp lệ.
3. **Không** còn câu hỏi `blocking` + `open`.
4. Mọi rủi ro `high` đều có Mitigation.
5. `02-FSD-Review.md` **≤ 150 dòng** (vượt → `02a-Review-Appendix.md`).

FAIL → `status = needs_clarification` (giữ `currentStage = fsd_review`), ghi blocker (câu hỏi blocking còn mở) ở cuối `02-FSD-Review.md` + trong `.agent-memory/fsd-reviewer.md`, **báo to theo [`./SharedRules.md` §4](./SharedRules.md)**, dừng.

PASS → `status = in_progress`, `currentStage = technical_plan`, `agents.fsd-reviewer.status = done`, bàn giao cho [`technical-planner`](./TechnicalPlanner.md).

## 5. Handoff

`.agent-memory/fsd-reviewer.md` theo [`./SharedRules.md` §4](./SharedRules.md) (≤ 30 dòng): input, AC đã chốt, rủi ro, câu hỏi mở, next agent, continue.

## 6. Ví dụ ngắn (node Upload — màn hình người dùng cuối)

Ý định: người dùng cuối nộp file ở node Upload trước khi đi tiếp (nguồn: màn hình tương ứng trong [`../fsd/`](../fsd/README.md)).

| AC-ID | Tiêu chí | Nguồn | Trạng thái |
| --- | --- | --- | --- |
| AC-01 | Khi node bắt buộc có file, nút "Hoàn thành bước" chỉ bật khi đã upload ≥ 1 file hợp lệ | `FSD-UPLOAD-…` | confirmed |
| AC-02 | File sai định dạng hoặc vượt giới hạn dung lượng bị từ chối kèm thông báo lỗi cho người dùng | design tool: Upload-error | assumed |

| Q-ID | Câu hỏi | Loại | Trạng thái |
| --- | --- | --- | --- |
| Q-01 | Cho phép những định dạng nào, giới hạn dung lượng bao nhiêu? | blocking | open |

→ Q-01 là `blocking open` ⇒ Gate 2 FAIL ⇒ `needs_clarification`, báo to, dừng. Khi BA trả lời → AC-02 thành `confirmed`, Q-01 đóng, đánh giá lại, bàn giao cho planner.
