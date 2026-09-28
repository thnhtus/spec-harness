# 08 — Test Evidence: Giảm giá 10% cho đơn từ 100

## Command output

| Verification Type | Command / Action | Covers AC | Expected | Actual | Result | Notes |
| --- | --- | --- | --- | --- | --- | --- |
| Unit (scope) | `npm run test:scope` | AC-01, AC-02, AC-03 | 3/3 passed | 3/3 passed | PASS | attested below |

### AC coverage

| AC ID | Covered by (test file :: `it(...)` name) or `manual` | Result |
| --- | --- | --- |
| AC-01 | `test/discount.test.js::AC-01 10% off at 100 and above` | PASS |
| AC-02 | `test/discount.test.js::AC-02 no discount below 100` | PASS |
| AC-03 | `test/discount.test.js::AC-03 negative total is rejected` | PASS |

### Output / Log

