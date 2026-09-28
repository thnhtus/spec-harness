# 01 — FSD (IEEE): Giảm giá 10% cho đơn từ 100

## 1. Introduction

- **1.1 Purpose:** Tính giá sau giảm cho giỏ hàng.
- **1.2 Scope:** chỉ hàm `discount(total)`; không đổi thuế, không đổi hiển thị tiền.

## 2. Overall Description

- Product perspective: enhancement
- Affected user classes: khách mua hàng

## 3. External Interface Requirements

- **3.1 User Interfaces:** unavailable
- **3.2 Software Interfaces:** hàm `discount(total: number): number` trong `src/discount.js`

## 4. Functional Requirements

### 4.1 Giảm giá

| FSD ID | Requirement (The system shall …) | Source | Status |
| --- | --- | --- | --- |
| FSD-DSC-001 | Hệ thống phải giảm 10% khi tổng đơn >= 100 (tính cả đúng 100). | `tracker: SHOP-7` | confirmed |
| FSD-DSC-002 | Hệ thống phải giữ nguyên tổng khi tổng đơn < 100. | `tracker: SHOP-7` | confirmed |
| FSD-DSC-003 | Hệ thống phải ném RangeError khi tổng đơn âm. | `tracker: SHOP-7` | confirmed |

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
| FSD-DSC-001 | tracker: SHOP-7 | confirmed |
| FSD-DSC-002 | tracker: SHOP-7 | confirmed |
| FSD-DSC-003 | tracker: SHOP-7 | confirmed |

## Gate 1 — checklist

- [x] `01-FSD.md` follows the IEEE skeleton
- [x] ≥ 1 functional requirement written with a modal from `harness.config.json → fsdModal`, atomic, with a Source
- [x] Assumptions & Open Questions kept separate
- [x] Requirement Trace Summary maps every `FSD-<MOD>-nnn` back to a source
