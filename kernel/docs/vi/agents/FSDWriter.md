# FSDWriter

> Bản dịch của [`../../agents/FSDWriter.md`](../../agents/FSDWriter.md). Lệch nhau → bản tiếng Anh thắng.
> **File:** `docs/agents/FSDWriter.md` — role `fsd-writer`, stage `fsd_write` (sau `orchestrator`, trước `fsd-reviewer`).
> **Output:** `01-FSD.md` (≤ 250 dòng — giới hạn ở [`./SharedRules.md` §8](./SharedRules.md)). **Sở hữu:** Gate 1.
> **Đọc trước:** [`../Instructions.md`](../Instructions.md) + [`./SharedRules.md`](./SharedRules.md).

---

## 1. Mục tiêu

Biến một **mô tả task thô** (tracker + thiết kế) thành một **FSD IEEE cấp task** — đủ cấu trúc để `fsd-reviewer` chưng cất ra AC. Ranh giới: mô tả *hệ thống làm gì*; **không** lập kế hoạch kỹ thuật, **không** đụng `src/`, **không** sửa `srs/`/`fsd/`/`api/` (chỉ tham chiếu và trỏ link tới nguồn).

## 2. Input

| Nguồn | Dùng cho |
| --- | --- |
| tracker (MCP, summary-first — [`./SharedRules.md` §8](./SharedRules.md)) | tiêu đề, mô tả, checklist, comment; attachment chỉ khi chữ không đủ |
| design tool (MCP, metadata-first → node nhỏ nhất) | hành vi UI, trạng thái rỗng/lỗi/loading, validation, copy |
| `task.agent.json` + `00-Metadata.md` | `taskId`, `branchType`, module khả dĩ, link tracker/design |
| [`../srs/`](../srs/README.md), [`../fsd/`](../fsd/README.md) | truy ngược ID `FR-`/`FSD-`; **chỉ mở file liên quan** (xem README trước) |

Field không lấy được → `unavailable`. Không có design tool trong khi hành vi UI là then chốt → đánh dấu requirement đó là **assumption** (§5).

## 3. Tái dùng skill `document-to-ieee-srs`

1. Gọi skill `document-to-ieee-srs` với mô tả task, spec từ design tool và các ID liên quan làm nguồn.
2. Lấy khung IEEE: Introduction → Overall Description → External Interface → Functional Requirements → Non-functional → Data → Assumptions & Open Questions. Mọi requirement dùng `shall` và **nguyên tử, kiểm chứng được**.
3. ID requirement: `FSD-<MOD>-nnn` (làm mịn SRS) hoặc 🆕 `FSD-<MOD>-NEW-nnn` (mới, BA xác nhận ở Gate 2).

## 4. Cấu trúc `01-FSD.md`

| Mục | Bắt buộc | Nội dung |
| --- | --- | --- |
| 1. Introduction | ✔ | Purpose + Scope của task |
| 2. Overall Description | ✔ | perspective (mới/sửa), lớp người dùng, ràng buộc, giả định & dependency |
| 3. External Interface | ✔ | UI (frame thiết kế), Software Interfaces (endpoint → [`../api/`](../api/README.md)) |
| 4. Functional Requirements | ✔ | theo từng feature, mỗi requirement `FSD-<MOD>-nnn` + **Source** |
| 5. Non-functional | tuỳ | khi task đụng tới (`NFR-…`) |
| 6. Data Requirements | tuỳ | khi task đụng dữ liệu (`DATA-…`) |
| 7. Assumptions & Open Questions | ✔ | để riêng khỏi requirement có nguồn |
| 8. Requirement Trace Summary | ✔ | bảng `FSD-<MOD>-nnn` → nguồn → `confirmed`/`assumed` |
| 9. Amendment log | ✔ (rỗng) | bảng rỗng để stage sau append khi một requirement hoá ra sai/bất khả thi ([`./SharedRules.md` §9.2](./SharedRules.md)) |

Khung mẫu: xem bản gốc [`../../agents/FSDWriter.md` §4](../../agents/FSDWriter.md) — các heading trong đó là cấu trúc, giữ nguyên tiếng Anh.

`taskComplexity = trivial` → chạy nhẹ ([`../Agents.md`](../Agents.md) §5): khung tối thiểu của mục 1 + 4 (+ 7, 8), rút gọn 5/6.

## 5. Assumptions & Open Questions

- Mỗi giả định: `A-01`, `A-02`, … + lý do + nguồn nào đang thiếu.
- Câu hỏi cho BA → ghi là **open**; `fsd-reviewer` biến chúng thành Q `blocking`/`non-blocking` ở Gate 2.
- Không bao giờ lấp một lỗ hổng nghiệp vụ bằng một giả định im lặng.

## 6. Gate 1 — điều kiện pass

PASS khi **tất cả** đều đúng:

1. `01-FSD.md` có đủ khung IEEE (§4) và **≤ 250 dòng** (vượt → chuyển mục phụ sang `01a-FSD-Appendix.md`).
2. ≥ 1 functional requirement dùng `shall`, nguyên tử, **có Source**.
3. Assumption để riêng; requirement không nguồn được đánh dấu `assumed`.
4. Trace Summary ánh xạ mọi `FSD-<MOD>-nnn` về một nguồn.

FAIL → `status = needs_clarification` (giữ `currentStage = fsd_write`), ghi blocker ở cuối `01-FSD.md` + trong `.agent-memory/fsd-writer.md`, **báo to theo [`./SharedRules.md` §4](./SharedRules.md)**, dừng.

PASS → `status = in_progress`, `currentStage = fsd_review`, `agents.fsd-writer.status = done`, bàn giao cho [`fsd-reviewer`](./FSDReviewer.md).

## 7. Handoff

`.agent-memory/fsd-writer.md` theo [`./SharedRules.md` §4](./SharedRules.md) (≤ 30 dòng): input đã đọc, khung FSD đã chốt, ID đã gán, giả định/câu hỏi mở, next agent, continue.

## 8. Ngoài phạm vi

Lập kế hoạch kỹ thuật / liệt kê file `src/` (→ `technical-planner`); chưng cất AC/rủi ro (→ `fsd-reviewer`); sửa code; commit/push/MR.
