# 01 — FSD (IEEE): Giỏ hàng: giảm giá, phí ship, coupon, thuế, checkout

## 1. Introduction

- **1.1 Purpose:** Tính giá sau giảm cho giỏ hàng.
- **1.2 Scope:** 5 module thuần dưới `src/cart/`; không đổi `config.js` / `format.js`.

## 2. Overall Description

- Product perspective: enhancement
- Affected user classes: khách mua hàng

## 3. External Interface Requirements

- **3.1 User Interfaces:** unavailable
- **3.2 Software Interfaces:** `src/cart/{discount,shipping,coupon,tax,checkout}.js`

## 4. Functional Requirements

### 4.1 Giỏ hàng

| FSD ID | Requirement (The system shall …) | Source | Status |
| --- | --- | --- | --- |
| FSD-CRT-001 | Hệ thống phải: giảm 10% khi t >= 100; t < 100 giữ nguyên; t < 0 ném RangeError. | `tracker: SHOP-8` | confirmed |
| FSD-CRT-002 | Hệ thống phải: phí ship 5 khi t < 50, 0 khi t >= 50. | `tracker: SHOP-8` | confirmed |
| FSD-CRT-003 | Hệ thống phải: mã SAVE5 trừ 5 (không âm), mã khác ném Error. | `tracker: SHOP-8` | confirmed |
| FSD-CRT-004 | Hệ thống phải: thuế = t * TAX_RATE từ src/config.js, làm tròn 2 chữ số. | `tracker: SHOP-8` | confirmed |
| FSD-CRT-005 | Hệ thống phải tính checkoutTotal(t, code) = money(tax-inclusive (coupon(discount(t)) + shipping)). | `tracker: SHOP-8` | confirmed |

## 5. Non-functional Requirements

not applicable to this task

## 6. Data Requirements

not applicable to this task

## 7. Assumptions & Open Questions

| ID | Assumption / Open Question | Why it was inferred / what source is missing | Needs BA sign-off? |
| --- | --- | --- | --- |

## 8. Requirement Trace Summary

| FSD ID | Source | Status |
| --- | --- | --- |
| FSD-CRT-001 | tracker: SHOP-8 | confirmed |
| FSD-CRT-002 | tracker: SHOP-8 | confirmed |
| FSD-CRT-003 | tracker: SHOP-8 | confirmed |
| FSD-CRT-004 | tracker: SHOP-8 | confirmed |
| FSD-CRT-005 | tracker: SHOP-8 | confirmed |

## Gate 1 — checklist

- [x] `01-FSD.md` follows the IEEE skeleton
- [x] ≥ 1 functional requirement written with a modal from `harness.config.json → fsdModal`, atomic, with a Source
- [x] Assumptions & Open Questions kept separate
- [x] Requirement Trace Summary maps every `FSD-<MOD>-nnn` back to a source
