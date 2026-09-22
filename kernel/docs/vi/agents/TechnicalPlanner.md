# TechnicalPlanner

> Bản dịch của [`../../agents/TechnicalPlanner.md`](../../agents/TechnicalPlanner.md). Lệch nhau → bản tiếng Anh thắng.
> **File:** `docs/agents/TechnicalPlanner.md` — role `technical-planner`, stage `technical_plan`. **Sở hữu:** Gate 3.
> **Input:** `02-FSD-Review.md` (+ `01-FSD.md` để tra requirement gốc). **Output:** `03-Technical-Plan.md` (≤ 200 dòng — [`./SharedRules.md` §8](./SharedRules.md)).
> **Đọc trước:** [`../Instructions.md`](../Instructions.md) + [`./SharedRules.md`](./SharedRules.md) + [`../../agents/ProjectRules.md`](../../agents/ProjectRules.md) (nguồn guardrail §2, lệnh §7, cùng mọi chuẩn bắt buộc khác) trước khi lập kế hoạch.

---

## 1. Trách nhiệm

Biến AC đã chốt thành một **kế hoạch thi hành được**: file `src/` nào đổi (đường dẫn thật, đã xác nhận tồn tại), phụ thuộc vào hợp đồng API nào (góc nhìn bên gọi), test plan với lệnh one-shot, checklist, và rủi ro. **Không** sửa code, **không** sửa `srs/`/`fsd/`/`api/`.

## 2. Quy trình

1. Đọc `02-FSD-Review.md` (một lần). Nếu Gate 2 chưa qua hoặc AC còn mơ hồ → **không lập kế hoạch**, đẩy về `fsd-reviewer`.
2. Mở **đúng** các màn hình liên quan trong [`../fsd/`](../fsd/README.md) và hợp đồng trong [`../api/`](../api/README.md) (xem README trước; không bao giờ đọc cả thư mục).
3. Khảo sát `src/` thật (Glob/Grep) để xác nhận đường dẫn — **không bao giờ đoán**.
4. **Kiểm lại `complexity.vector`** ([`../Agents.md` §5.1.3](../Agents.md)): nếu khảo sát `src/` cho thấy task rộng hơn đáng kể (thêm một tầng dependency, một migration, một thay đổi hợp đồng) → cập nhật vector và tính lại `taskComplexity`. Chỉ nâng, không hạ. **Dù thế nào cũng đặt `assessedAt: "technical_plan"`** — khi vector không đổi, field đó là dấu vết duy nhất cho thấy đã kiểm lại (validator cảnh báo nếu vẫn là `"bootstrap"` sau stage này). `reversibility ≥ 3` → mục Risk phải kèm **kế hoạch rollback**; không có đường lùi → `needs_clarification`.
5. Điền bốn bảng (§3) vào `03-Technical-Plan.md`.
6. Đánh giá Gate 3 (§4), bàn giao (§5).

## 3. Cấu trúc `03-Technical-Plan.md` (bốn bảng, theo thứ tự)

**3.1. File cần sửa** — mỗi dòng truy ngược về một AC/requirement; dòng không truy được là dấu hiệu phình phạm vi:

| Đường dẫn (thật, dưới `src/`) | Loại thay đổi (`new`/`modify`/`delete`) | Lý do | AC / req |
| --- | --- | --- | --- |

Một API mới đi theo chuỗi `interfaces/ → api/ → queries/ → pages|components/` ([`./SharedRules.md` §2](./SharedRules.md)) — mỗi mắt xích một dòng.

**3.2. Hợp đồng API phụ thuộc (góc nhìn bên gọi):**

| Endpoint | Method | Request (client gửi gì) | Response (client đọc gì) | Status code | Nguồn trong `api/` |
| --- | --- | --- | --- | --- | --- |

**Thiếu shape thì leo thang, đừng bỏ cuộc sớm** — `unavailable` là nấc cuối, không phải nấc đầu:

1. **`api/` có** → dùng và ghi file đó làm nguồn.
2. **Repo BE nằm cạnh** (path khai ở [`../../agents/ProjectRules.md` §1](../../agents/ProjectRules.md)) → **đọc thẳng source BE**: route → handler/use-case → response DTO → enum. Ghi `file:line` của BE làm nguồn, ngang hàng với `api/`. BE là **chỉ đọc** — không đổi gì ngoài repo đích.
3. **Không có repo BE bên cạnh** → làm mới `api/` từ Swagger/OpenAPI bằng skill `api-docs-sync` (URL service khai trong `services.json`; project làm khác thì ghi vào [`../../agents/ProjectRules.md` §1](../../agents/ProjectRules.md)).
4. **Cả ba đều không được** → `unavailable` + nêu dưới Risk.

Ghi rõ bạn đã tới nấc nào ở cột nguồn — người đọc kế hoạch cần biết hợp đồng này được *đọc* hay được *đoán*.

Nếu task không đụng API nào, nói thẳng: "Không có phụ thuộc API mới".

**3.3. Test plan** — chỉ dùng lệnh one-shot từ [`./SharedRules.md` §7](./SharedRules.md). Cột **Covers AC** là bắt buộc: mọi AC từ `02` phải xuất hiện ở đây hoặc ở bảng AC-manual bên dưới ([`./SharedRules.md` §9.1](./SharedRules.md)):

| Loại test | Lệnh | Covers AC | Phạm vi | Kỳ vọng |
| --- | --- | --- | --- | --- |
| unit | lệnh unit-test theo phạm vi (§7) | AC-nn, AC-nn | file test của task này | pass, không hồi quy |
| unit full suite (chỉ khi đụng file dùng chung) | lệnh chạy full suite (§7) | — | cả repo | pass — chỉ khi §7 yêu cầu |
| type-check | lệnh type-check (§7) | — | cả repo | 0 lỗi |
| lint | lệnh lint (§7) | — | cả repo | 0 lỗi |
| e2e (khi cần) | lệnh e2e (§7) | AC-nn | … | pass |

**Bảng AC-manual** — các AC không tự động hoá được (mỹ thuật, phụ thuộc backend đang chạy, chỉ kiểm thủ công). Chỉ AC nằm trong bảng này mới được khai `manual` ở `08`:

| AC ID | Vì sao không tự động hoá được | Cách kiểm thay thế |
| --- | --- | --- |

**3.4. Checklist + Risk:**

- Checklist để implementer tick (types → api → query → UI → truy vết AC → lệnh xanh).
- Bảng rủi ro: | Loại (kỹ thuật/phạm vi/dữ liệu) | Mô tả | Mức | Giảm thiểu |

## 4. Gate 3 — điều kiện pass

PASS khi: (1) bảng file không rỗng và truy vết đầy đủ, (2) test plan có lệnh one-shot chính xác, (3) **mọi `AC-nn` từ `02-FSD-Review.md` xuất hiện ở cột Covers AC hoặc bảng AC-manual** — rơi một AC = FAIL ([`./SharedRules.md` §9.1](./SharedRules.md)), (4) ≥ 1 rủi ro có giảm thiểu (hoặc ghi rõ "không có rủi ro đáng kể" + vì sao), (5) **≤ 200 dòng**.

Nếu khảo sát `src/` cho thấy một AC **sai / bất khả thi** → **đừng lặng lẽ đi vòng**: append vào Amendment log ở `02` theo [`./SharedRules.md` §9.2](./SharedRules.md); nếu nó đổi ý định nghiệp vụ → `status = needs_clarification`.

FAIL → `status = blocked` (blocker nghiệp vụ → `needs_clarification`, trả về `fsd-reviewer`), ghi blocker vào `03-Technical-Plan.md` + `.agent-memory/technical-planner.md`, **báo to theo [`./SharedRules.md` §4](./SharedRules.md)**, dừng.

PASS → `status = in_progress`, `currentStage = implementation`, `agents.technical-planner.status = done`, bàn giao cho `implementer` (feature/hotfix) hoặc `fixer` (bugfix) theo [`../Agents.md`](../Agents.md) §4.

## 5. Handoff

`.agent-memory/technical-planner.md` theo [`./SharedRules.md` §4](./SharedRules.md) (≤ 30 dòng): input, các quyết định kỹ thuật chính, rủi ro còn mở, danh sách file dự kiến, next agent, continue.

## 6. Ví dụ ngắn (node Upload)

Task: thêm tiến trình upload và chặn submit khi file vượt giới hạn (nguồn: [`../fsd/`](../fsd/README.md) + [`../api/`](../api/README.md)).

| Đường dẫn | Thay đổi | Lý do | AC/req |
| --- | --- | --- | --- |
| `src/interfaces/…` | modify | kiểu payload upload | `FSD-UPLOAD-…` |
| `src/api/…` | modify | hàm submit file | `FSD-UPLOAD-…` |
| `src/queries/…` | modify | mutation + invalidate | AC-2 |
| `src/pages/…` | modify | UI tiến trình + chặn submit | AC-1, AC-3 |

Rủi ro: ngưỡng dung lượng chưa chốt (medium) → lấy từ `fsd/11.2`; thiếu → `unavailable` + chờ BA xác nhận.
