# 06 — Implementation Notes: Giảm giá 10% cho đơn từ 100

## Metadata

- Branch: `feature/SHOP-7-discount` (base `main` @ `{base}`)
- Implementer: `implementer`

## Changed files

| File (under `src/`) | Change Type | Reason | Related AC / Req |
| --- | --- | --- | --- |
| `src/discount.js` | added | hàm giảm giá | AC-01, AC-02, AC-03 |
| `test/discount.test.js` | added | test | AC-01, AC-02, AC-03 |

## Decisions

| Decision ID | Decision | Reason | Alternatives | Decided By | Date |
| --- | --- | --- | --- | --- | --- |
| D-01 | Hàm thuần, không đọc config | dễ test | đọc TAX_RATE | dev | 2026-09-28 |

## Plan Deviations / Assumptions / Known Limitations

{deviation}

## Handoff

→ Gate 4 passed → adversarial_review.
