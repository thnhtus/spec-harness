# TechnicalPlanner

> **File:** `docs/agents/TechnicalPlanner.md` — role `technical-planner`, stage `technical_plan`. **Gate sở hữu:** Gate 3.
> **Input:** `02-FSD-Review.md` (+ `01-FSD.md` để tra requirement gốc). **Output:** `03-Technical-Plan.md` (≤ 200 dòng — [`./SharedRules.md` §8](./SharedRules.md)).
> **Đọc trước:** [`../Instructions.md`](../Instructions.md) + [`./SharedRules.md`](./SharedRules.md) + [`./ProjectRules.md`](./ProjectRules.md) (guardrail source §2, lệnh §7, kèm mọi chuẩn bắt buộc khác) trước khi lập plan.

---

## 1. Trách nhiệm

Biến AC đã rõ thành **kế hoạch chạy được**: file `src/` sẽ đổi (path thật, đã xác nhận tồn tại), contract API phụ thuộc (góc nhìn client — repo không có backend), test plan với lệnh one-shot, checklist, risk. **Không** sửa code, **không** sửa `srs/`/`fsd/`/`api/`.

## 2. Quy trình

1. Đọc `02-FSD-Review.md` (một lần). Gate 2 chưa qua / AC mơ hồ → **không lập plan**, trả về `fsd-reviewer`.
2. Mở **đúng** màn hình [`../fsd/`](../fsd/README.md) + contract [`../api/`](../api/README.md) liên quan (tra README trước, không đọc cả thư mục).
3. Khảo sát `src/` thật (Glob/Grep) để xác nhận path — **không đoán**.
4. Điền 4 bảng (§3) vào `03-Technical-Plan.md`.
5. Đánh giá Gate 3 (§4), handoff (§5).

## 3. Cấu trúc `03-Technical-Plan.md` (4 bảng, đúng thứ tự)

**3.1. Files sẽ đổi** — mỗi dòng truy vết được về AC/req; không truy vết được = dấu hiệu out-of-scope:

| Path (thật, dưới `src/`) | Change type (`new`/`modify`/`delete`) | Lý do | AC / req |
| --- | --- | --- | --- |

Thêm API mới đi theo chuỗi `interfaces/ → api/ → queries/ → pages|components/` ([`./SharedRules.md` §2](./SharedRules.md)) — mỗi mắt xích một dòng.

**3.2. API contract phụ thuộc (góc nhìn client):**

| Endpoint | Method | Request (FE gửi) | Response (FE đọc) | Status codes | Nguồn `api/` |
| --- | --- | --- | --- | --- | --- |

Field không có trong `api/` → `unavailable` + nêu ở Risk. Task không đụng API → ghi rõ "Không phụ thuộc API mới".

**3.3. Test plan** — chỉ lệnh one-shot từ [`./SharedRules.md` §7](./SharedRules.md). Cột **Covers AC** là bắt buộc — mọi AC của `02` phải xuất hiện ở đây hoặc ở bảng AC-manual bên dưới ([`./SharedRules.md` §9.1](./SharedRules.md)):

| Test type | Lệnh | Covers AC | Phạm vi | Kỳ vọng |
| --- | --- | --- | --- | --- |
| unit | lệnh unit-test phạm vi task (§7) | AC-nn, AC-nn | test file của task | pass, không regress |
| unit full-suite (chỉ khi chạm file dùng chung) | lệnh full-suite (§7) | — | toàn repo | pass — chỉ khi §7 yêu cầu |
| type-check | lệnh type-check (§7) | — | toàn repo | 0 lỗi |
| lint | lệnh lint (§7) | — | toàn repo | 0 error |
| e2e (khi cần) | lệnh e2e (§7) | AC-nn | … | pass |

**Bảng AC-manual** — AC không tự động hoá được (cosmetic, phụ thuộc BE live, chỉ verify tay). Chỉ AC nằm ở đây mới được `08` khai `manual`:

| AC ID | Lý do không tự động hoá được | Cách verify thay thế |
| --- | --- | --- |

**3.4. Checklist + Risk:**

- Checklist cho implementer tick (type → api → query → UI → truy vết AC → lệnh xanh).
- Bảng risk: | Loại (kỹ thuật/scope/dữ liệu) | Mô tả | Mức | Giảm thiểu |

## 4. Gate 3 — điều kiện qua

PASS khi: (1) bảng Files không rỗng + truy vết đủ, (2) test plan có lệnh one-shot chính xác, (3) **mọi `AC-nn` của `02-FSD-Review.md` xuất hiện ở cột Covers AC hoặc bảng AC-manual** — AC rơi = FAIL ([`./SharedRules.md` §9.1](./SharedRules.md)), (4) ≥ 1 risk kèm giảm thiểu (hoặc ghi rõ "không có rủi ro đáng kể" + lý do), (5) **≤ 200 dòng**.

Phát hiện AC **sai / bất khả thi** khi khảo sát `src/` → **không tự né**: append Amendment log vào `02` theo [`./SharedRules.md` §9.2](./SharedRules.md); đổi ý định nghiệp vụ → `status = needs_clarification`.

FAIL → `status = blocked` (blocker thuộc nghiệp vụ → `needs_clarification`, trả `fsd-reviewer`), ghi blocker vào `03-Technical-Plan.md` + `.agent-memory/technical-planner.md`, **báo to theo [`./SharedRules.md` §4](./SharedRules.md)**, dừng.

PASS → `status = in_progress`, `currentStage = implementation`, `agents.technical-planner.status = done`, handoff → `fe-implementer` (feature/hotfix) hoặc `fe-fix` (bugfix) theo [`../Agents.md`](../Agents.md) §4.

## 5. Handoff

`.agent-memory/technical-planner.md` theo [`./SharedRules.md` §4](./SharedRules.md) (≤ 30 dòng): inputs, quyết định kỹ thuật chính, risk mở, danh sách file dự kiến, next agent, continue.

## 6. Ví dụ rút gọn (node Upload)

Task: thêm progress upload + chặn submit khi file vượt giới hạn (nguồn: [`../fsd/`](../fsd/README.md) + [`../api/`](../api/README.md)).

| Path | Change | Lý do | AC/req |
| --- | --- | --- | --- |
| `src/interfaces/…` | modify | type payload upload | `FSD-UPLOAD-…` |
| `src/api/…` | modify | hàm nộp file instance | `FSD-UPLOAD-…` |
| `src/queries/…` | modify | mutation + invalidate | AC-2 |
| `src/pages/…` | modify | UI progress + chặn submit | AC-1, AC-3 |

Risk: ngưỡng dung lượng chưa chốt (vừa) → lấy từ `fsd/11.2`; thiếu → `unavailable` + BA xác nhận.
