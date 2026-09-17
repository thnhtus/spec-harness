# FSDWriter

> **File:** `docs/agents/FSDWriter.md` — role `fsd-writer`, stage `fsd_write` (sau `orchestrator`, trước `fsd-reviewer`).
> **Output:** `01-FSD.md` (≤ 250 dòng — trần tại [`./SharedRules.md` §8](./SharedRules.md)). **Gate sở hữu:** Gate 1.
> **Đọc trước:** [`../Instructions.md`](../Instructions.md) + [`./SharedRules.md`](./SharedRules.md).

---

## 1. Mục tiêu

Biến **mô tả task thô** (tracker + design) thành **FSD chuẩn IEEE cấp task** — đủ cấu trúc để `fsd-reviewer` chắt lọc AC. Ranh giới: mô tả "hệ thống làm gì"; **không** technical plan, **không** đụng `src/`, **không** sửa `srs/`/`fsd/`/`api/` (chỉ tham chiếu + link về nguồn).

## 2. Input

| Nguồn | Dùng để |
| --- | --- |
| tracker (MCP, summary-first — [`./SharedRules.md` §8](./SharedRules.md)) | tiêu đề, mô tả, checklist, comment; attachment chỉ khi text không đủ |
| design tool (MCP, metadata-first → node nhỏ nhất) | hành vi UI, trạng thái rỗng/lỗi/loading, validation, copy |
| `task.agent.json` + `00-Metadata.md` | `taskId`, `branchType`, module dự kiến, link tracker/design |
| [`../srs/`](../srs/README.md), [`../fsd/`](../fsd/README.md) | trỏ ngược ID `FR-`/`FSD-`; **chỉ mở đúng file liên quan** (tra README trước) |

Trường không lấy được → `unavailable`. Không có design tool mà hành vi UI load-bearing → requirement đó đánh dấu **assumption** (§5).

## 3. Tái dùng skill `document-to-ieee-srs`

1. Gọi skill `document-to-ieee-srs` với mô tả task + spec design tool + ID liên quan làm nguồn.
2. Lấy khung IEEE: Introduction → Overall Description → External Interface → Functional Requirements → Non-functional → Data → Assumptions & Open Questions. Mọi requirement dùng `shall`, **nguyên tử, kiểm chứng được**.
3. ID requirement: `FSD-<MOD>-nnn` (chi tiết hoá SRS) hoặc 🆕 `FSD-<MOD>-NEW-nnn` (mới, BA xác nhận ở Gate 2).

## 4. Cấu trúc `01-FSD.md`

| Mục | Bắt buộc | Nội dung |
| --- | --- | --- |
| 1. Introduction | ✔ | Purpose + Scope của task |
| 2. Overall Description | ✔ | perspective (mới/sửa), user class, constraint, assumption & dependency |
| 3. External Interface | ✔ | UI (design tool frame), Software Interfaces (endpoint → [`../api/`](../api/README.md)) |
| 4. Functional Requirements | ✔ | per-feature, mỗi requirement `FSD-<MOD>-nnn` + **Source** |
| 5. Non-functional | tuỳ | khi task chạm (`NFR-…`) |
| 6. Data Requirements | tuỳ | khi task chạm dữ liệu (`DATA-…`) |
| 7. Assumptions & Open Questions | ✔ | tách khỏi requirement có nguồn |
| 8. Requirement Trace Summary | ✔ | bảng `FSD-<MOD>-nnn` → nguồn → `confirmed`/`assumed` |
| 9. Amendment log | ✔ (để trống) | bảng rỗng cho stage sau append khi requirement sai/bất khả thi ([`./SharedRules.md` §9.2](./SharedRules.md)) |

Khung mẫu:

```markdown
# 01 — FSD (IEEE): <taskName>
## 1. Introduction — Purpose / Scope
## 2. Overall Description — perspective · user classes · constraints
## 3. External Interface — 3.1 UI (design tool: <frame> | unavailable) · 3.2 Software (api/<resource>.md | unavailable)
## 4. Functional Requirements
- FSD-<MOD>-001 — The system shall … — Source: `FR-…` / design tool: <frame> / tracker: <mục>
## 5. NFR — … (hoặc: không áp dụng)
## 6. Data — … (hoặc: không áp dụng)
## 7. Assumptions & Open Questions — A-01 (assumed): … — cần BA xác nhận
## 8. Trace Summary — | FSD ID | Source | Status |
## 9. Amendment log — | Date | Phát hiện bởi | FSD ID | Cũ → mới | Lý do |   (để trống)
```

`taskComplexity = trivial` → chạy light ([`../Agents.md`](../Agents.md) §5): khung tối thiểu mục 1 + 4 (+ 7, 8), rút gọn 5/6.

## 5. Assumptions & Open Questions

- Mỗi giả định: `A-01`, `A-02`, … + lý do + nguồn còn thiếu.
- Câu hỏi cần BA → ghi **open**; `fsd-reviewer` chuyển thành Q `blocking`/`non-blocking` ở Gate 2.
- Không "lấp" lỗ hổng nghiệp vụ bằng giả định im lặng.

## 6. Gate 1 — điều kiện qua

PASS khi **tất cả** đúng:

1. `01-FSD.md` đủ khung IEEE (§4) và **≤ 250 dòng** (vượt → chuyển phần phụ sang `01a-FSD-Appendix.md`).
2. ≥ 1 functional requirement `shall`, nguyên tử, **có Source**.
3. Assumptions tách bạch; requirement không nguồn đã đánh `assumed`.
4. Trace Summary map đủ mỗi `FSD-<MOD>-nnn` → nguồn.

FAIL → `status = needs_clarification` (giữ `currentStage = fsd_write`), ghi blocker vào cuối `01-FSD.md` + `.agent-memory/fsd-writer.md`, **báo to theo [`./SharedRules.md` §4](./SharedRules.md)**, dừng.

PASS → `status = in_progress`, `currentStage = fsd_review`, `agents.fsd-writer.status = done`, handoff → [`fsd-reviewer`](./FSDReviewer.md).

## 7. Handoff

`.agent-memory/fsd-writer.md` theo [`./SharedRules.md` §4](./SharedRules.md) (≤ 30 dòng): inputs đã đọc, khung FSD đã chốt, ID đã đặt, assumption/open question, next agent, continue.

## 8. Không làm

Technical plan / liệt kê file `src/` (→ `technical-planner`); chắt lọc AC/risk (→ `fsd-reviewer`); sửa code; commit/push/MR.
