# FEFix

> **File:** `docs/agents/FEFix.md` — role `fe-fix`, stage `implementation` cho `branchType = bugfix`. **Gate sở hữu:** Gate 4.
> Cùng hình dạng [`./FEImplementer.md`](./FEImplementer.md) nhưng định hướng **sửa lỗi**: reproduce-first, diff tối thiểu, bám root-cause. File này chỉ ghi phần **khác** so với FEImplementer — phần còn lại (input, nhánh, lệnh, output, forbidden) theo FEImplementer + [`./SharedRules.md`](./SharedRules.md).

---

## 1. Input bổ sung

- `02-FSD-Review.md`: **expected vs actual** + các bước tái hiện (repro). Nếu `fsd-reviewer.status = skipped` → đọc repro/AC trực tiếp từ tracker (MCP, summary-first).
- `03-Technical-Plan.md`: **root-cause analysis** + fix plan — nguồn ràng buộc scope chính.
- design tool chỉ khi lỗi là lệch UI so thiết kế.

## 2. Reproduce-first (TDD cho bug — bắt buộc)

```
Đọc repro + root-cause từ 03
  → Viết test tái hiện bug (framework theo [`./ProjectRules.md` §7](./ProjectRules.md))
  → chạy test đó → FAIL đúng triệu chứng   (fail sai lý do = test viết sai, sửa test)
  → Sửa code: diff tối thiểu, bám root-cause
  → chạy lại → PASS (test tái hiện thành regression test vĩnh viễn)
  → lint + type-check + phần còn lại của ProjectRules §7
  → Ghi 06 + 08, Gate 4
```

- **Không tái hiện được** hoặc **root-cause thực tế khác plan** → STOP, `status = blocked`, ghi `.agent-memory/fe-fix.md`, báo to, re-route `technical-planner`.
- Bug chỉ thấy trên trình duyệt → bổ sung repro thủ công ngắn (before/after) trong `08`.

## 3. Kỷ luật bugfix

- **Minimal-diff:** không refactor lân cận, không đổi tên prop, không restyle, không nâng version, không "dọn dẹp tiện tay".
- **Không che triệu chứng:** không `@ts-ignore` giấu lỗi type, không nuốt lỗi axios, không ẩn state UI, không tắt/skip test sẵn có đang fail.
- Bug do lệch contract FE↔API → không vá FE "chịu đựng" âm thầm: log quyết định vào `06` (API Integration Notes) + làm tươi `docs/api/` bằng skill `api-docs-sync`.

## 4. Output bổ sung (so với FEImplementer)

- `06-FE-Implementation-Notes.md` thêm mục: **Root Cause** · **Reproduction Test** (test mới + file) · **Regression Risk**.
- `08-Test-Evidence.md` phần `## Frontend`: **Reproduction Before Fix** (log test fail trước khi sửa) · Kết quả từng lệnh của ProjectRules §7 · **Adjacent Flow Smoke Checks** (≥ 1 luồng lân cận, before/after khi UI thấy được) · bảng **AC coverage** như FEImplementer ([`./SharedRules.md` §9.1](./SharedRules.md)) — bug thường ít AC, nhưng AC nào có trong `02` cũng phải có dòng.

## 5. Gate 4 — tiêu chí bugfix

| # | Tiêu chí |
| --- | --- |
| 1 | Root-cause được document, liên kết tới Changed Files |
| 2 | Có evidence test tái hiện **fail-trước-fix** |
| 3 | Test của bug (gồm regression test mới) pass; không skip/tắt test sẵn có |
| 4 | Các lệnh còn lại của [`./ProjectRules.md` §7](./ProjectRules.md) xanh |
| 5 | Smoke check ≥ 1 luồng lân cận |
| 6 | Diff chỉ trong fix scope của plan |
| 7 | Regression Risk có mitigation nếu ≥ medium |
| 8 | Bảng **AC coverage** đủ mọi AC của `02`; root-cause thật khác AC → Amendment log ([`./SharedRules.md` §9](./SharedRules.md)) |

FAIL → `status = blocked` / `needs_clarification`, ghi blocker vào `06`/`08` + `.agent-memory/fe-fix.md`, **báo to theo [`./SharedRules.md` §4](./SharedRules.md)**, dừng.
PASS → `status = reviewing`, dừng chờ user duyệt commit/push/MR.

## 6. Ví dụ rút gọn

Bug: một component không hiển thị dữ liệu vừa tạo (mismatch response↔state). Quy trình: viết test tái hiện (mock response → expect render fail) → chạy → FAIL → sửa mapping tối thiểu → chạy lại → PASS → `06` + `08`. Nguồn: file spec + API doc liên quan.
