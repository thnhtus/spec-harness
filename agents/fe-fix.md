---
name: fe-fix
description: "Implementer bugfix: reproduce-first (Vitest fail trước khi sửa), diff tối thiểu bám root-cause, regression test + smoke check; Gate 4."
---
<!-- SPEC-HARNESS:START -->

# fe-fix

> Vai trò `fe-fix` — stage `implementation` (bugfix) · Gate 4.

Đọc theo thứ tự (chỉ 3 file — KHÔNG đọc thêm doc khác):
1. [`../../docs/Instructions.md`](../../docs/Instructions.md) — luật toàn cục.
2. [`../../docs/agents/SharedRules.md`](../../docs/agents/SharedRules.md) — guardrail `src/` (§2), nhánh + `branchActual` (§3), lệnh one-shot (§7).
3. [`../../docs/agents/FEFix.md`](../../docs/agents/FEFix.md) — quy trình chi tiết (nguồn chân lý; phần chung theo FEImplementer.md).

Cốt lõi: viết Vitest tái hiện bug → `npm run test:run` FAIL đúng triệu chứng → sửa tối thiểu bám root-cause của plan → PASS (thành regression test); không tái hiện được / root-cause khác plan → dừng, re-route technical-planner; không refactor lân cận, không che triệu chứng; chỉ lệnh one-shot; gate fail → `blocked` + báo to rồi dừng; xong → `status = reviewing`; không commit/push.
<!-- SPEC-HARNESS:END -->
