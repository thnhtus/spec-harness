# 03 — Technical Plan: {taskName}

> Sinh bởi `technical-planner` (stage `technical_plan`, **Gate 3**). Trỏ màn hình trong `fsd/` + contract trong `api/`. Append-only; văn xuôi theo `harness.config.json → docLanguage`.

## File sẽ đổi

| File (dưới `src/`) | Change Type | Reason | Related AC / Req |
| --- | --- | --- | --- |
| `src/pages/…` | new / edit | … | AC-nn |

## Contract API phụ thuộc (góc nhìn client)

> Contract mà repo này **tiêu thụ**, không phải hiện thực server. Nguồn theo thang bậc TechnicalPlanner §3.2: `docs/api/` → source BE trong `repos` (read-only) → Swagger → `unavailable`.

| Endpoint | Method | Request | Response | Status Codes | Source (`docs/api/`) |
| --- | --- | --- | --- | --- | --- |
| /… | GET/POST/… | … | … | 200/400/401/… | `../../../api/….md` |

## Test plan

> Mỗi dòng test phải ghi **AC nào được phủ** — AC không có dòng test = Gate 3 FAIL.

| Test Type | Command | Covers AC | Expected | Notes |
| --- | --- | --- | --- | --- |
| Unit (scope) | `<lệnh unit phạm vi task — ProjectRules §7>` | AC-nn, AC-nn | pass | evidence Gate 4 mặc định |
| Unit (full) | `<lệnh full-suite>` | — | không regress | **chỉ** khi §7 yêu cầu |
| Type-check | `<lệnh type-check>` | — | 0 lỗi | |
| Lint | `<lệnh lint>` | — | 0 error | |
| E2E (nếu cần) | `<lệnh e2e>` | AC-nn | pass | chỉ khi luồng UI quan trọng |
| Build | `<lệnh build>` | — | success | |

**AC không phủ được bằng test tự động** (chỉ verify tay / cosmetic) → liệt kê ở đây kèm lý do; đó là danh sách hợp lệ để `08` đánh dấu `manual`:

| AC ID | Lý do không tự động hoá được | Cách verify thay thế |
| --- | --- | --- |

## Checklist hiện thực

- [ ] …

## Risk

| Risk ID | Risk | Severity | Mitigation |
| --- | --- | --- | --- |
| R-01 |  | low/medium/high |  |

## Gate 3 — checklist

- [ ] Danh sách file sẽ đổi đầy đủ
- [ ] Test plan có lệnh one-shot cụ thể + kỳ vọng
- [ ] **Mọi AC trong `02-FSD-Review.md` xuất hiện ở cột "Covers AC" hoặc ở bảng AC-manual** (không AC nào rơi)
- [ ] Risk đã nêu + mitigation

> Gate 3 fail → `status = blocked`, ghi blocker + `.agent-memory/technical-planner.md`.
