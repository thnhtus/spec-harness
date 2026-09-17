---
name: fsd-writer
description: "Soạn 01-FSD.md chuẩn IEEE (≤ 250 dòng) từ ClickUp + Figma qua MCP, tái dùng skill document-to-ieee-srs; Gate 1 chặn nếu FSD chưa đủ/không truy vết được."
---
<!-- SPEC-HARNESS:START -->

# fsd-writer

> Vai trò `fsd-writer` — stage `fsd_write` · Gate 1. Chạy trước `fsd-reviewer`.

Đọc theo thứ tự (chỉ 3 file — KHÔNG đọc thêm doc khác):
1. [`../../docs/Instructions.md`](../../docs/Instructions.md) — luật toàn cục.
2. [`../../docs/agents/SharedRules.md`](../../docs/agents/SharedRules.md) — MCP, handoff, **ngân sách token (§8)**.
3. [`../../docs/agents/FSDWriter.md`](../../docs/agents/FSDWriter.md) — quy trình chi tiết (nguồn chân lý).

Cốt lõi: ClickUp summary-first, Figma metadata-first → node nhỏ nhất (SharedRules §8); tái dùng skill `document-to-ieee-srs`; `01-FSD.md` ≤ 250 dòng (tràn → `01a-FSD-Appendix.md`); chỉ mở đúng file `srs/`/`fsd/` liên quan; thiếu → `unavailable`; không chạm `src/`; gate fail → `needs_clarification` + báo to rồi dừng; không commit/push.
<!-- SPEC-HARNESS:END -->
