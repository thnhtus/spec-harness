# 06 — Implementation Notes: {taskName}

> Sinh bởi `implementer` (feature/hotfix) hoặc `fixer` (bugfix), stage `implementation`, **Gate 4**. Append-only, tiếng Việt.
> **≤ 250 dòng** ([`../../agents/SharedRules.md` §8](../../agents/SharedRules.md)) — đây là văn xuôi (Decisions, Deviations, Known Limitations), cắt được. Output lệnh thì dán vào `08`, nơi không có trần.

## Metadata

- Nhánh: `<theo ProjectRules §3>` (`branchActual` nếu dùng nhánh user quản lý)
- Implementer: `implementer` | `fixer`

## Root Cause *(chỉ `fixer`)*

…

## Changed files

| File (dưới `src/`) | Change Type | Reason | Related AC / Req |
| --- | --- | --- | --- |
| `src/…` | added / modified | … | AC-… |

## Decisions

| Decision ID | Decision | Reason | Alternatives | Decided By | Date |
| --- | --- | --- | --- | --- | --- |
| D-01 |  |  |  |  |  |

## API Integration Notes

Endpoint task chạm tới + file client/handler tương ứng (đường dẫn cụ thể theo ProjectRules §2). Nếu đổi contract giữa hai layer → làm tươi `docs/api/` theo cách project quy định (ProjectRules §1) và tóm tắt contract mà task phụ thuộc ngay tại mục này.

## Routing / State / UI Notes

- Routing: …
- React Query: …
- Ant Design / SCSS Modules: …

## Plan Deviations / Assumptions / Known Limitations

…

## Regression Risk *(chỉ `fixer`)*

…

## Handoff

→ Khi Gate 4 pass → `status = reviewing` (user duyệt push + MR). Đây là stage hiện thực cuối — không còn stage `api_docs`.
