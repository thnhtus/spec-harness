# 02 — FSD Review: {taskName}

> Sinh bởi `fsd-reviewer` (stage `fsd_review`, **Gate 2**). Đọc `01-FSD.md` (do `fsd-writer` soạn) + tracker + thiết kế qua MCP; trích ID `FR-`/`NFR-`/`FSD-` từ `srs/` + `fsd/`. Append-only; văn xuôi theo `harness.config.json → docLanguage`. Trường MCP thiếu → ghi "unavailable", không bịa.

## Tiêu chí nghiệm thu (AC)

> Đánh số thật (`AC-01`, `AC-02`, …). `AC-nn` là **placeholder** — validator bỏ qua, nên dòng chưa điền không bị tính là AC.

| AC ID | Acceptance Criteria | Source | Status | Test Case |
| --- | --- | --- | --- | --- |
| AC-nn |  | FSD §… / FR-… | open | TC-… |

## Câu hỏi BA

| Question ID | Question | Type | Status | Owner | Created At | Resolved At |
| --- | --- | --- | --- | --- | --- | --- |
| Q-01 |  | clarification / contradiction | open |  |  |  |

## Risk

| Risk ID | Risk | Type | Severity | Mitigation | Owner | Status |
| --- | --- | --- | --- | --- | --- | --- |
| R-01 |  | tech / business | low/medium/high |  |  | open |

## Amendment log

> Append khi stage sau (plan / implement) phát hiện AC hoặc requirement **sai / thiếu / bất khả thi**. Spec là source of truth — sửa spec, đừng để code âm thầm lệch. Quy tắc: [`../../agents/SharedRules.md` §9](../../agents/SharedRules.md).

| Date | Phát hiện bởi | AC / FSD ID | Nội dung cũ → mới | Lý do |
| --- | --- | --- | --- | --- |

## Gate 2 — checklist

- [ ] Business intent rõ ràng
- [ ] AC đầy đủ, đo được, có nguồn (`FR-`/`FSD-` hoặc `FSD-<MOD>-nnn` trong `01-FSD.md`)
- [ ] Không còn câu hỏi BA dạng blocking (chưa resolved)

> Gate 2 fail → `status = needs_clarification`, ghi blocker vào đây + `.agent-memory/fsd-reviewer.md`, dừng automation.
