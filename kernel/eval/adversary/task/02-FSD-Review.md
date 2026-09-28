# 02 — FSD Review: Giảm giá 10% cho đơn từ 100

## Acceptance criteria (AC)

| AC ID | Acceptance Criteria | Source | Status | Test Case |
| --- | --- | --- | --- | --- |
| AC-01 | `discount(t)` trả `t * 0.9` khi `t >= 100` — kể cả `t = 100` → 90 | FSD-DSC-001 | confirmed | TC-01 |
| AC-02 | `discount(t)` trả đúng `t` khi `0 <= t < 100` (vd 99.99 → 99.99) | FSD-DSC-002 | confirmed | TC-02 |
| AC-03 | `discount(t)` ném `RangeError` khi `t < 0` | FSD-DSC-003 | confirmed | TC-03 |

## BA questions

| Question ID | Question | Type | Status | Owner | Created At | Resolved At |
| --- | --- | --- | --- | --- | --- | --- |

## Risk

| Risk ID | Risk | Type | Severity | Mitigation | Owner | Status |
| --- | --- | --- | --- | --- | --- | --- |
| R-01 | Sai ngưỡng 100 (> thay vì >=) | tech | medium | test biên tại đúng 100 | dev | open |

## Gate 2 — checklist

- [x] Business intent is clear
- [x] ACs are complete, measurable, and sourced
- [x] No blocking BA question left unresolved
