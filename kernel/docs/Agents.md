# Agents — Role registry, workflow, gate (nguồn chuẩn duy nhất cho lifecycle)

> **Phạm vi:** tài liệu canonical định nghĩa 6 role FE, lifecycle qua các stage có gate, cách chọn implementer theo `branchType`, và quy tắc skip. Quy tắc vận hành chi tiết (MCP, guardrail, nhánh, handoff, lệnh, ngân sách token): [`agents/SharedRules.md`](./agents/SharedRules.md) — không lặp lại ở đây.
> **Repo:** một repo FE duy nhất. Mỗi task chạy trong một worktree riêng do `/start-task` step 0 tạo — subagent không tự tạo/đổi worktree ([`Instructions.md` §1](./Instructions.md)).

---

## 1. Bảng role (6 role FE)

Tên kebab-case; `layer` luôn `frontend`; mỗi role một file trong [`agents/`](./agents/SharedRules.md).

| Role | Stage | Output chính | Gate chặn khi | Chi tiết |
| --- | --- | --- | --- | --- |
| `orchestrator` | bootstrap | task folder, `task.agent.json`, `00-Metadata.md`, `.agent-memory/` | metadata thiếu không suy ra được | [`agents/Orchestrator.md`](./agents/Orchestrator.md) |
| `fsd-writer` | fsd_write | `01-FSD.md` (FSD IEEE cấp task — skill `document-to-ieee-srs`) | FSD chưa đủ / không truy vết được (**Gate 1**) | [`agents/FSDWriter.md`](./agents/FSDWriter.md) |
| `fsd-reviewer` | fsd_review | `02-FSD-Review.md` (AC, câu hỏi BA, risk) | intent / AC chưa rõ (**Gate 2**) | [`agents/FSDReviewer.md`](./agents/FSDReviewer.md) |
| `technical-planner` | technical_plan | `03-Technical-Plan.md` (file sẽ đổi, test plan, checklist, risk) | thiếu plan / test (**Gate 3**) | [`agents/TechnicalPlanner.md`](./agents/TechnicalPlanner.md) |
| `fe-implementer` | implementation (feature/hotfix) | code + `06-FE-Implementation-Notes.md` + `08-Test-Evidence.md` | thiếu evidence / ngoài scope (**Gate 4**) | [`agents/FEImplementer.md`](./agents/FEImplementer.md) |
| `fe-fix` | implementation (bugfix) | như trên, định hướng reproduce-first | như trên (**Gate 4**) | [`agents/FEFix.md`](./agents/FEFix.md) |

> Repo không chứa backend → contract FE↔API chỉ ghi ở **góc nhìn client** trong `03-Technical-Plan.md` (nguồn: [`api/`](./api/README.md)). Trường thiếu ⇒ `unavailable`, không bịa.

---

## 2. Lifecycle

```mermaid
flowchart TD
    START([start task &lt;taskId&gt;]) --> ORCH[orchestrator<br/>bootstrap]
    ORCH --> WRITE[fsd-writer<br/>fsd_write]
    WRITE -->|Gate 1| FSD[fsd-reviewer<br/>fsd_review]
    FSD -->|Gate 2| PLAN[technical-planner<br/>technical_plan]
    PLAN -->|Gate 3| PICK{branchType?}
    PICK -->|feature / hotfix| IMPL[fe-implementer]
    PICK -->|bugfix| FIX[fe-fix]
    IMPL -->|Gate 4| REVIEW[status: reviewing]
    FIX -->|Gate 4| REVIEW
    REVIEW --> MR([user duyệt push + MR])

    WRITE -.fail.-> BLOCK[[blocked /<br/>needs_clarification]]
    FSD -.fail.-> BLOCK
    PLAN -.fail.-> BLOCK
    IMPL -.fail.-> BLOCK
    FIX -.fail.-> BLOCK
```

Gate fail → `status = blocked` / `needs_clarification`, ghi blocker vào doc + `.agent-memory/{role}.md`, **báo to cho user** (4 ý bắt buộc — [`agents/SharedRules.md` §4](./agents/SharedRules.md)), dừng automation tới khi user/BA resolve.

**Cách ly ngữ cảnh per-stage:** mỗi stage chạy như **một subagent riêng** (context mới), nhận đầu vào qua artifact + handoff `.agent-memory/` thay vì qua hội thoại. Main loop chỉ điều phối gate. Chi tiết dispatch: lệnh `/start-task` (`.claude/commands/start-task.md`).

---

## 3. Định nghĩa gate

Gate là điểm kiểm tra **chặn**. PASS mới handoff; FAIL → đặt status, ghi blocker, báo to, dừng.

| Gate | Sau stage | Điều kiện PASS | FAIL → status |
| --- | --- | --- | --- |
| **Gate 1** | fsd_write | `01-FSD.md` đủ khung IEEE (Introduction, Overall Description, External Interface, Functional Requirements); mỗi requirement dùng `shall` + truy vết được (`FR-`/`FSD-`/tracker/design); assumption tách riêng; **≤ 250 dòng** (trần tại [`agents/SharedRules.md` §8](./agents/SharedRules.md)) | `needs_clarification` |
| **Gate 2** | fsd_review | AC + business intent rõ; câu hỏi BA `blocking` đã trả lời; ID `FR-`/`NFR-`/`FSD-` đã trích; **≤ 150 dòng** | `needs_clarification` |
| **Gate 3** | technical_plan | `03-Technical-Plan.md` có: danh sách file FE sẽ đổi, test plan (lệnh one-shot cụ thể), checklist, risk; **mọi AC của `02` có ở cột Covers AC hoặc bảng AC-manual** ([SharedRules §9.1](./agents/SharedRules.md)); **≤ 200 dòng** | `blocked` |
| **Gate 4** | implementation | Bộ lệnh kiểm tra bắt buộc của project PASS ([`agents/ProjectRules.md` §7](./agents/ProjectRules.md)) với evidence thật trong `08-Test-Evidence.md`; **bảng AC coverage đủ mọi AC**, AC bị làm lệch đã có Amendment log ([SharedRules §9](./agents/SharedRules.md)); thay đổi **trong scope** danh sách Gate 3 | `blocked` |

Danh sách lệnh hợp lệ (one-shot vs watch-mode): [`agents/SharedRules.md` §7](./agents/SharedRules.md).

---

## 4. Chọn implementer theo `branchType`

| branchType | Implementer |
| --- | --- |
| `feature`, `hotfix` | `fe-implementer` |
| `bugfix` | `fe-fix` |

Quy tắc nhánh (tạo từ `develop` với `--ff-only`, ngoại lệ nhánh user quản lý + `branchActual`): [`agents/SharedRules.md` §3](./agents/SharedRules.md).

---

## 5. Quy tắc skip

`taskComplexity ∈ {trivial, normal, high}` (định nghĩa tại [`agents/SharedRules.md` §6](./agents/SharedRules.md)). Khi `taskComplexity = trivial`:

- **`fsd-writer` chạy light:** `01-FSD.md` đủ khung IEEE tối thiểu (Introduction + Functional Requirements có `shall` + trace), rút gọn mục non-functional/data khi task không chạm. Gate 1 vẫn phải PASS.
- **`fsd-reviewer` chạy light:** vẫn trích AC tối thiểu + ID liên quan; bỏ được phân tích risk dài + câu hỏi BA nếu intent đã rõ. Gate 2 vẫn phải PASS.
- `orchestrator`, `technical-planner`, implementer **không** được skip.

---

## 6. Liên kết

- Quy tắc vận hành chi tiết: [`agents/SharedRules.md`](./agents/SharedRules.md) · Global rule: [`Instructions.md`](./Instructions.md)
- Bootstrap & resume: [`HarnessSetup.md`](./HarnessSetup.md) · Chỉ mục: [`README.md`](./README.md)
- Role: [`agents/Orchestrator.md`](./agents/Orchestrator.md) · [`agents/FSDWriter.md`](./agents/FSDWriter.md) · [`agents/FSDReviewer.md`](./agents/FSDReviewer.md) · [`agents/TechnicalPlanner.md`](./agents/TechnicalPlanner.md) · [`agents/FEImplementer.md`](./agents/FEImplementer.md) · [`agents/FEFix.md`](./agents/FEFix.md)
- Task docs & template: [`tasks/README.md`](./tasks/README.md) · Artifact nguồn: [`srs/`](./srs/README.md) · [`fsd/`](./fsd/README.md) · [`api/`](./api/README.md)
