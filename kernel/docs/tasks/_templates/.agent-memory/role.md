# {role} — handoff

> Khuôn mẫu handoff giữa các stage. Copy thành `.agent-memory/{role}.md` cho từng role tham gia (vd `orchestrator.md`, `fsd-writer.md`, `fsd-reviewer.md`, `technical-planner.md`, `implementer.md`, `fixer.md`, `adversary.md`). Append-only; văn xuôi theo `harness.config.json → docLanguage`.

## Next Handoff → {next-role}

- **Inputs**: tài liệu / dữ liệu đã đọc (doc nào, field nào của tracker/thiết kế).
- **Decisions**: quyết định đã chốt (ID `D-…` nếu có).
- **Risks**: risk / giả định còn mở (ID `R-…`).
- **Changed Files**: file đã chạm (nếu là stage implementation).
- **Evidence**: bằng chứng (link `08-Test-Evidence.md`, kết quả gate).
- **Blockers**: none | mô tả blocker + ai cần resolve.
- **Next agent**: `{next-role}` (hoặc `(none)` nếu chuyển `reviewing`).
- **Continue automation**: yes / no.
