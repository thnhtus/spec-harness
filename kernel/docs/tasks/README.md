# Task docs — layout & cách dùng template

> Khu vực **task docs** của AI harness. Mỗi task của tracker có một thư mục `{tasksDir}/{groupPrefix}{n}/{taskId}-{slug}/` chứa artifact append-only theo workflow có gate.
> File này chỉ giải thích **layout & template**. Lifecycle/gate: [`../Agents.md`](../Agents.md); quy tắc chung + trần kích thước: [`../agents/SharedRules.md`](../agents/SharedRules.md); resume: [`../HarnessSetup.md`](../HarnessSetup.md) §7.

---

## 1. Layout một task

```
docs/tasks/
├── README.md              # file này
├── _templates/            # khuôn mẫu, copy cho mỗi task mới (§3)
└── sprint-{n}/
    └── {taskId}-{slug}/
        ├── task.agent.json                # state máy đọc
        ├── 00-Metadata.md                 # orchestrator (≤ 80 dòng)
        ├── 01-FSD.md                      # fsd-writer — Gate 1 (≤ 250 dòng)
        ├── 02-FSD-Review.md               # fsd-reviewer — Gate 2 (≤ 150 dòng)
        ├── 03-Technical-Plan.md           # technical-planner — Gate 3 (≤ 200 dòng)
        ├── 06-FE-Implementation-Notes.md  # fe-implementer | fe-fix — Gate 4
        ├── 08-Test-Evidence.md            # evidence thật (lệnh ProjectRules §7 + kết quả)
        ├── 01a-…/02a-…-Appendix.md        # (tuỳ chọn) phần tràn trần — stage sau KHÔNG tự đọc
        └── .agent-memory/{role}.md        # handoff (≤ 30 dòng/block)
```

Trần kích thước là điều kiện gate — định nghĩa tại [`../agents/SharedRules.md` §8](../agents/SharedRules.md).

## 2. File nào do role nào sinh

| File | Role | Gate |
| --- | --- | --- |
| `task.agent.json` | orchestrator tạo, mọi role cập nhật | — |
| `00-Metadata.md` | orchestrator | — |
| `01-FSD.md` | fsd-writer | Gate 1 |
| `02-FSD-Review.md` | fsd-reviewer | Gate 2 |
| `03-Technical-Plan.md` | technical-planner | Gate 3 |
| `06-…` + `08-…` | fe-implementer \| fe-fix | Gate 4 |
| `.agent-memory/{role}.md` | từng role | — |

## 3. Cách dùng template

Orchestrator **copy** `docs/tasks/_templates/` → thư mục task rồi điền giá trị thật:

- `task.agent.json`: schema + giá trị `status` + trường tuỳ chọn (`branchActual`, `parentTaskId`) định nghĩa tại [`../agents/SharedRules.md` §6](../agents/SharedRules.md). `taskComplexity ∈ {trivial, normal, high}`.
- File `00-…` → `08-…` copy nguyên khuôn; mỗi role mở đúng file của mình và **append**.
- Không sửa trực tiếp file trong `_templates/` khi làm task — chỉ chỉnh khuôn khi muốn đổi cấu trúc cho **mọi** task về sau.

## 4. Quy ước

- **Append-only**, **tiếng Việt**, ID kỹ thuật giữ nguyên — chi tiết: [`../agents/SharedRules.md` §5](../agents/SharedRules.md).
- `task.agent.json` **không** có trường token/usage.
- Lệnh evidence Gate 4: danh sách one-shot tại [`../agents/SharedRules.md` §7](../agents/SharedRules.md) — không chép bảng lệnh vào đây.

## 5. Nhánh & resume

Quy tắc nhánh (gồm ngoại lệ `branchActual`): [`../agents/SharedRules.md` §3](../agents/SharedRules.md). Resume task dang dở: [`../HarnessSetup.md`](../HarnessSetup.md) §7.

## 6. Validate task docs (tự động)

Chạy `node scripts/validate-tasks.mjs` (không cần dependency; đọc `harness.config.json` ở repo root) để kiểm tra mọi task folder theo đúng quy ước harness:

- `task.agent.json` hợp lệ theo schema `_templates/task.agent.schema.json` (enum `status`, `branchType`, `currentStage`, role bắt buộc…).
- Số nhóm (`sprintNumber`) / `taskId` / `docsPath` khớp vị trí folder; **không trùng** `taskId` của tracker.
- File artifact bắt buộc có mặt theo `currentStage` đã đạt (vd `01-FSD.md` phải có khi `currentStage ≥ fsd_review`).
- Trần dòng [§8](../agents/SharedRules.md) (00≤80, 01≤250, 02≤150, 03≤200, block handoff ≤30).
- `branchType` ↔ implementer (feature/hotfix → `fe-implementer`; bugfix → `fe-fix`).
- Khi `status ∈ {reviewing, mr_created, done}`: `08-Test-Evidence.md` phải có bằng chứng thật (lệnh + kết quả pass/exit) — chống claim test giả ([Gate 4](../Agents.md) §3).
- **Truy vết AC** ([SharedRules §9.1](../agents/SharedRules.md)): mọi `AC-nn` khai trong bảng AC của `02-FSD-Review.md` phải xuất hiện ở `03-Technical-Plan.md` **và** `08-Test-Evidence.md`. Task có `updatedAt ≥ 2026-07-28` → **error**; task cũ hơn → **warning** (backlog, mốc `AC_TRACE_SINCE` trong script).

Exit code `1` nếu có error → dùng được trong **pre-commit hook** hoặc **CI**. Flag: `--json` (máy đọc), `--no-warn`, `--quiet`, `--self-check` (kiểm chính logic của script, không đọc task).
