# 03 — Technical Plan: Giảm giá 10% cho đơn từ 100

## Files to change

| File (under `src/`) | Change Type | Reason | Related AC / Req |
| --- | --- | --- | --- |
| `src/discount.js` | new | hàm giảm giá | AC-01, AC-02, AC-03 |
| `test/discount.test.js` | new | test cho 3 AC | AC-01, AC-02, AC-03 |

## Test plan

| Test Type | Command | Covers AC | Expected | Notes |
| --- | --- | --- | --- | --- |
| Unit (scope) | `npm run test:scope` | AC-01, AC-02, AC-03 | pass | the default Gate 4 evidence |

**ACs that cannot be covered by an automated test:**

| AC ID | Why it cannot be automated | Alternative verification |
| --- | --- | --- |

## Implementation checklist

- [x] `discount()` + test biên

## Risk

| Risk ID | Risk | Severity | Mitigation |
| --- | --- | --- | --- |
| R-01 | Sai ngưỡng 100 | medium | test tại đúng 100 |

## Gate 3 — checklist

- [x] The list of files to change is complete
- [x] The test plan has concrete one-shot commands + expectations
- [x] Every AC in `02-FSD-Review.md` appears in the "Covers AC" column
- [x] Risks stated + mitigations
