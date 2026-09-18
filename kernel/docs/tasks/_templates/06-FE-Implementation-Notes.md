# 06 — FE Implementation Notes: {taskName}

> Sinh bởi `fe-implementer` (feature/hotfix) hoặc `fe-fix` (bugfix), stage `implementation`, **Gate 4**. Append-only, tiếng Việt.
> **≤ 250 dòng** ([`../../agents/SharedRules.md` §8](../../agents/SharedRules.md)) — đây là văn xuôi (Decisions, Deviations, Known Limitations), cắt được. Output lệnh thì dán vào `08`, nơi không có trần.

## Metadata

- Nhánh: `<theo ProjectRules §3>` (`branchActual` nếu dùng nhánh user quản lý)
- Implementer: `fe-implementer` | `fe-fix`

## Root Cause *(chỉ `fe-fix`)*

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

Endpoint FE chạm tới + file `src/api/*.api.ts` / `src/queries/*.queries.ts`. Nếu đổi contract FE↔API → làm tươi `docs/api/` theo cách project quy định (ProjectRules §1) và tóm tắt contract FE phụ thuộc ngay tại mục này.

## Routing / State / UI Notes

- Routing: …
- React Query: …
- Ant Design / SCSS Modules: …

## Plan Deviations / Assumptions / Known Limitations

…

## Regression Risk *(chỉ `fe-fix`)*

…

## Handoff

→ Khi Gate 4 pass → `status = reviewing` (user duyệt push + MR). Đây là stage hiện thực cuối — không còn stage `api_docs`.
