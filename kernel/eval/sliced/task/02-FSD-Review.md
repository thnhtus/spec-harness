# 02 — FSD Review: Giỏ hàng: giảm giá, phí ship, coupon, thuế, checkout

## Acceptance criteria (AC)

| AC ID | Acceptance Criteria | Source | Status | Test Case |
| --- | --- | --- | --- | --- |
| AC-01 | `discount()`: giảm 10% khi t >= 100; t < 100 giữ nguyên; t < 0 ném RangeError | FSD-CRT-001 | confirmed | TC-01 |
| AC-02 | `shipping()`: phí ship 5 khi t < 50, 0 khi t >= 50 | FSD-CRT-002 | confirmed | TC-02 |
| AC-03 | `coupon()`: mã SAVE5 trừ 5 (không âm), mã khác ném Error | FSD-CRT-003 | confirmed | TC-03 |
| AC-04 | `tax()`: thuế = t * TAX_RATE từ src/config.js, làm tròn 2 chữ số | FSD-CRT-004 | confirmed | TC-04 |
| AC-05 | `checkoutTotal(120, "SAVE5")` = money((120*0.9-5+0)*(1+TAX_RATE)) | FSD-CRT-005 | confirmed | TC-05 |

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
