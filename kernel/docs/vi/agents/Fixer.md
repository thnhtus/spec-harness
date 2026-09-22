# Fixer

> Bản dịch của [`../../agents/Fixer.md`](../../agents/Fixer.md). Lệch nhau → bản tiếng Anh thắng.
> **File:** `docs/agents/Fixer.md` — role `fixer`, stage `implementation` cho `branchType = bugfix`. **Sở hữu:** Gate 4.
> Cùng khuôn với [`./Implementer.md`](./Implementer.md) nhưng hướng tới **sửa lỗi**: tái lập trước, diff tối thiểu, bám nguyên nhân gốc. File này chỉ ghi phần **khác** Implementer — mọi thứ còn lại theo Implementer + [`./SharedRules.md`](./SharedRules.md).

---

## 1. Input thêm

- `02-FSD-Review.md`: **kỳ vọng vs thực tế** cộng các bước tái lập. Nếu `fsd-reviewer.status = skipped` → đọc repro/AC thẳng từ tracker (MCP, summary-first).
- `03-Technical-Plan.md`: **phân tích nguyên nhân gốc** + kế hoạch sửa — ràng buộc phạm vi chính.
- Design tool chỉ khi lỗi là UI lệch so với thiết kế.

## 2. Tái lập trước (TDD cho bug — bắt buộc)

```
Đọc repro + nguyên nhân gốc từ 03
  → Viết test tái lập bug (framework theo [`../../agents/ProjectRules.md` §7](../../agents/ProjectRules.md))
  → chạy test đó → nó FAIL đúng triệu chứng   (fail vì lý do khác = test sai, sửa test)
  → Sửa code: diff tối thiểu, đúng nguyên nhân gốc
  → chạy lại → PASS (test repro trở thành test hồi quy vĩnh viễn)
  → lint + type-check + phần còn lại của ProjectRules §7
  → Viết 06 + 08, Gate 4
```

- **Không tái lập được**, hoặc **nguyên nhân gốc thật khác với kế hoạch** → DỪNG, `status = blocked`, ghi vào `.agent-memory/fixer.md`, báo to, đẩy về `technical-planner`.
- Bug chỉ thấy được trên trình duyệt → thêm một repro thủ công ngắn (trước/sau) vào `08`.

## 3. Kỷ luật bugfix

- **Diff tối thiểu:** không refactor chỗ lân cận, không đổi tên props, không sửa style, không nâng version, không "tiện tay dọn".
- **Không che triệu chứng:** không `@ts-ignore` giấu lỗi kiểu, không nuốt lỗi axios, không giấu trạng thái UI, không tắt/skip một test đang fail.
- Bug do lệch hợp đồng giữa hai layer → đừng lặng lẽ vá bên gọi cho "chịu được": ghi quyết định vào `06` (API Integration Notes) và làm mới `docs/api/` theo cách project quy định (ProjectRules §1).

## 4. Output thêm (ngoài phần của Implementer)

- `06-Implementation-Notes.md` có thêm: **Root Cause** · **Reproduction Test** (test mới + file của nó) · **Regression Risk**.
- `08-Test-Evidence.md` dưới `## Command output`: **Reproduction Before Fix** (log test fail trước khi sửa) · kết quả từng lệnh ProjectRules §7 · **Adjacent Flow Smoke Checks** (≥ 1 luồng lân cận, trước/sau khi UI nhìn thấy được) · bảng **AC coverage** như Implementer ([`./SharedRules.md` §9.1](./SharedRules.md)) — bug thường ít AC, nhưng mọi AC trong `02` vẫn cần một dòng.

## 5. Gate 4 — tiêu chí cho bugfix

| # | Tiêu chí |
| --- | --- |
| 1 | Nguyên nhân gốc được ghi lại và gắn với Changed Files |
| 2 | Có bằng chứng test repro **fail trước khi sửa** |
| 3 | Test của bug (kể cả test hồi quy mới) pass; không test sẵn có nào bị skip hay tắt |
| 4 | Các lệnh còn lại ở [`../../agents/ProjectRules.md` §7](../../agents/ProjectRules.md) đều xanh |
| 5 | Smoke check trên ≥ 1 luồng lân cận |
| 6 | Diff nằm trong phạm vi sửa của kế hoạch |
| 7 | Regression Risk có giảm thiểu nếu ≥ medium |
| 8 | Bảng **AC coverage** phủ mọi AC trong `02`; nếu nguyên nhân gốc thật khác AC → Amendment log ([`./SharedRules.md` §9](./SharedRules.md)) |

FAIL → `status = blocked` / `needs_clarification`, ghi blocker vào `06`/`08` + `.agent-memory/fixer.md`, **báo to theo [`./SharedRules.md` §4](./SharedRules.md)**, dừng.
PASS → `currentStage = adversarial_review`, `status = in_progress`, bàn giao cho [`adversary`](./Adversary.md). **Không bao giờ tự đặt `reviewing`** — Gate 5 mới là thứ chuyển task sang đó.

## 6. Ví dụ ngắn

Bug: một component không hiển thị dữ liệu vừa tạo (lệch giữa response và state). Quy trình: viết test repro (mock response → kỳ vọng render fail) → chạy → FAIL → sửa mapping tối thiểu → chạy lại → PASS → viết `06` + `08`. Nguồn: file spec liên quan + tài liệu API.
