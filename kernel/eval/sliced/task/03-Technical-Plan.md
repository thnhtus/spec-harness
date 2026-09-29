# 03 — Technical Plan: Giỏ hàng: giảm giá, phí ship, coupon, thuế, checkout

## Files to change

| File | Change Type | Reason | Related AC / Req | Slice |
| --- | --- | --- | --- | --- |
| `src/cart/discount.js` | new | discount | AC-01 | S1 |
| `test/cart/discount.test.js` | new | test discount | AC-01 | S1 |
| `src/cart/shipping.js` | new | shipping | AC-02 | S1 |
| `test/cart/shipping.test.js` | new | test shipping | AC-02 | S1 |
| `src/cart/coupon.js` | new | coupon | AC-03 | S1 |
| `test/cart/coupon.test.js` | new | test coupon | AC-03 | S1 |
| `src/cart/tax.js` | new | tax | AC-04 | S1 |
| `test/cart/tax.test.js` | new | test tax | AC-04 | S1 |
| `src/cart/checkout.js` | new | ghép 4 module + money() | AC-05 | S2 |
| `test/cart/checkout.test.js` | new | test checkout | AC-05 | S2 |

## Test plan

| Test Type | Command | Covers AC | Expected | Notes |
| --- | --- | --- | --- | --- |
| Unit (scope) | `npm run test:scope` | AC-01, AC-02, AC-03, AC-04, AC-05 | pass | the default Gate 4 evidence |

**ACs that cannot be covered by an automated test:**

| AC ID | Why it cannot be automated | Alternative verification |
| --- | --- | --- |

## Implementation checklist

- [ ] S1: 4 module thuần + test biên
- [ ] S2: checkout ghép S1 + test AC-05

## Risk

| Risk ID | Risk | Severity | Mitigation |
| --- | --- | --- | --- |
| R-01 | Sai ngưỡng 100 | medium | test tại đúng 100 |

## Gate 3 — checklist

- [x] The list of files to change is complete
- [x] The test plan has concrete one-shot commands + expectations
- [x] Every AC in `02-FSD-Review.md` appears in the "Covers AC" column
- [x] Risks stated + mitigations
