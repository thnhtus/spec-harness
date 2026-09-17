# 01 — FSD (IEEE): {taskName}

> Sinh bởi `fsd-writer` (stage `fsd_write`, **Gate 1**). Soạn theo chuẩn IEEE bằng cách tái dùng skill `document-to-ieee-srs`; nguồn là mô tả task ClickUp + Figma (qua MCP), trỏ ngược ID `FR-`/`NFR-`/`FSD-` từ `srs/` + `fsd/`. Append-only, tiếng Việt. Trường MCP thiếu → ghi "unavailable", không bịa.

## 1. Introduction

- **1.1 Purpose:** …
- **1.2 Scope:** … (ranh giới + phần loại trừ)

## 2. Overall Description

- Product perspective: mới | enhancement | replacement
- User classes chịu ảnh hưởng: …
- Constraints / Assumptions & Dependencies: …

## 3. External Interface Requirements

- **3.1 User Interfaces:** màn hình / flow (Figma: `<frame>` | unavailable)
- **3.2 Software Interfaces:** endpoint FE phụ thuộc → [`../../../api/<resource>.md`](../../../api/<resource>.md) | unavailable

## 4. Functional Requirements

### 4.1 <Feature>

| FSD ID | Requirement (The system shall …) | Source | Status |
| --- | --- | --- | --- |
| FSD-<MOD>-001 |  | `FR-…` / `Figma: <frame>` / `ClickUp: <mục>` | confirmed / assumed |

## 5. Non-functional Requirements

`NFR-…` (hoặc: không áp dụng cho task này)

## 6. Data Requirements

`DATA-…` (hoặc: không áp dụng cho task này)

## 7. Assumptions & Open Questions

| ID | Assumption / Open Question | Lý do suy ra / nguồn thiếu | Cần BA chốt? |
| --- | --- | --- | --- |
| A-01 |  |  | yes / no |

## 8. Requirement Trace Summary

| FSD ID | Source | Status |
| --- | --- | --- |
| FSD-<MOD>-001 | FR-… | confirmed |

## 9. Amendment log

> Append khi stage sau (review / plan / implement) phát hiện một `FSD-<MOD>-nnn` **sai / thiếu / bất khả thi**. Append-only: dòng requirement gốc **ở lại**, amendment ghi tại đây. Quy tắc: [`../../agents/SharedRules.md` §9.2](../../agents/SharedRules.md).

| Date | Phát hiện bởi | FSD ID | Nội dung cũ → mới | Lý do |
| --- | --- | --- | --- | --- |

## Gate 1 — checklist

- [ ] `01-FSD.md` theo bộ khung IEEE (Introduction + Overall Description + External Interface + Functional Requirements)
- [ ] ≥ 1 functional requirement viết bằng `shall`, nguyên tử, có Source
- [ ] Phần Assumptions & Open Questions tách bạch; requirement không nguồn đã đánh dấu `assumed`
- [ ] Requirement Trace Summary map mỗi `FSD-<MOD>-nnn` về nguồn

> Gate 1 fail → `status = needs_clarification`, ghi blocker vào đây + `.agent-memory/fsd-writer.md`, dừng automation. Khi Gate 1 đạt → handoff sang `fsd-reviewer` (`02-FSD-Review.md`).
