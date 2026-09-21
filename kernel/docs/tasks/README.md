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
        ├── 06-Implementation-Notes.md  # implementer | fixer — Gate 4
        ├── 08-Test-Evidence.md            # evidence thật (lệnh ProjectRules §7 + kết quả)
        ├── 09-Adversarial-Review.md       # adversary — Gate 5 (tự chạy lại, không tin 08)
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
| `06-…` + `08-…` | implementer \| fixer | Gate 4 |
| `09-Adversarial-Review.md` | adversary | Gate 5 |
| `.agent-memory/{role}.md` | từng role | — |

## 3. Cách dùng template

Orchestrator **copy** `docs/tasks/_templates/` → thư mục task rồi điền giá trị thật:

- `task.agent.json`: schema + giá trị `status` + trường tuỳ chọn (`branchActual`, `parentTaskId`) định nghĩa tại [`../agents/SharedRules.md` §6](../agents/SharedRules.md). `taskComplexity ∈ {trivial, normal, high}`.
- File `00-…` → `08-…` copy nguyên khuôn; mỗi role mở đúng file của mình và **append**.
- Không sửa trực tiếp file trong `_templates/` khi làm task — chỉ chỉnh khuôn khi muốn đổi cấu trúc cho **mọi** task về sau.

## 4. Quy ước

- **Append-only**, văn xuôi theo `harness.config.json → docLanguage`, ID kỹ thuật giữ nguyên — chi tiết: [`../agents/SharedRules.md` §5](../agents/SharedRules.md).
- `task.agent.json` **không** có trường token/usage; trường `telemetry` (stage · tier · model · thời gian) thì có.
- Lệnh evidence Gate 4: danh sách one-shot tại [`../agents/SharedRules.md` §7](../agents/SharedRules.md) — không chép bảng lệnh vào đây.

## 5. Nhánh & resume

Quy tắc nhánh (gồm ngoại lệ `branchActual`): [`../agents/SharedRules.md` §3](../agents/SharedRules.md). Resume task dang dở: [`../HarnessSetup.md`](../HarnessSetup.md) §7.

## 6. Validate task docs (tự động)

Chạy `node scripts/validate-tasks.mjs` (không cần dependency; đọc `harness.config.json` ở repo root) để kiểm tra mọi task folder theo đúng quy ước harness:

- `task.agent.json` hợp lệ theo schema `_templates/task.agent.schema.json` (enum `status`, `branchType`, `currentStage`, role bắt buộc…).
- Số nhóm (`sprintNumber`) / `taskId` / `docsPath` khớp vị trí folder; **không trùng** `taskId` của tracker.
- File artifact bắt buộc có mặt theo `currentStage` đã đạt (vd `01-FSD.md` phải có khi `currentStage ≥ fsd_review`).
- Trần dòng [§8](../agents/SharedRules.md) (00≤80, 01≤250, 02≤150, 03≤200, 06≤250, block handoff ≤30). Doc đã có `## Update — …` / `## Cập Nhật — …` (task bị gate trả về) thì trần áp cho **block mới nhất**, không phải cả file — append-only mà cap cả file là cái bẫy đóng: vượt trần, và §5 cấm xoá bớt để chui xuống dưới.
- `08`/`09` **không có trần cứng** (`lineWarn` 400 = cảnh báo). Chúng chứa output dán nguyên văn; trần ở đó chỉ ép cắt bằng chứng, mà `adversary` cần đúng output đó để đối chiếu. Vượt 400 dòng = tín hiệu tách task, không phải lỗi.
- `branchType` ↔ implementer (feature/hotfix → `implementer`; bugfix → `fixer`).
- Khi `status ∈ {reviewing, mr_created, done}`: `08-Test-Evidence.md` phải có bằng chứng thật — lệnh khớp `evidenceCommandPattern` **và** kết quả pass/exit nằm **trong block ```code fence```**. Chữ "passed" ở ô *Expected* của bảng không tính: đó là kế hoạch, không phải kết quả ([Gate 4](../Agents.md) §3).
- `09-Adversarial-Review.md` phải có verdict (PASS/FAIL/UNCERTAIN), output adversary **tự chạy**, và bảng "Tầng tĩnh" với cột *Kết quả tự chạy* **không rỗng** — tồn tại file là chưa đủ. Fence giống hệt `08` từng byte → cảnh báo copy-paste.
- **Retry budget**: số block handoff của một role ≥ `retryBudget` (mặc định 4) → error. Block handoff là append-only nên nó đo rework độc lập với `attempts` (do coordinator tự khai); lệch nhau → warning. Hết budget thì đặt `status = split` + `splitInto` (≥2 taskId) để hạ xuống warning — xem `Agents.md` §5.5.
- **Truy vết AC theo stage** ([SharedRules §9.1](../agents/SharedRules.md)): mỗi đích trong `acTrace.reachedIn` được kiểm **ngay khi stage của nó tới** — AC rơi khỏi `03-Technical-Plan.md` fail ở **Gate 3**, không đợi tới lúc review. Task có `updatedAt ≥ mốc` → **error**; cũ hơn → **warning**.
- **Handoff** ([SharedRules §4](../agents/SharedRules.md)): role nào `status = done` thì `.agent-memory/{role}.md` phải có block `### ` kèm `Next agent` + `Continue automation` — coordinator route dựa vào đó.
- **Gate 2**: không còn câu hỏi `blocking` + `open` sau khi qua `fsd_review`.
- **Stage/status khớp nhau**: `reviewing` đòi `currentStage = reviewing` và mọi role đã kết thúc — không nhảy cóc qua gate.
- **Độ phức tạp**: `taskComplexity` phải khớp thứ `complexity.vector` suy ra ([Agents.md §5.1.1](../Agents.md)), và mỗi chiều phải nằm trong thang của nó (`0–2`, riêng `blastRadius`/`reversibility` `0–4`).
- **AC phải tồn tại**: qua khỏi `fsd_review` mà `02-FSD-Review.md` không khai AC nào → error. Không có AC thì cả chuỗi truy vết thành vô nghĩa, và task rỗng đi thẳng tới `reviewing`.

Exit code `1` nếu có error → dùng được trong **pre-commit hook** hoặc **CI**. Flag: `--json` (máy đọc), `--no-warn`, `--quiet`, `--self-check` (kiểm chính logic của script, không đọc task), `--calibrate` ([Agents.md §5.6](../Agents.md)), `--staged`.

`--staged` chỉ kiểm task folder mà commit hiện tại chạm tới — pre-commit dùng nó. Một task đang `blocked` chờ BA là trạng thái hợp lệ; để nó chặn mọi commit không liên quan trong repo chỉ dạy cả team gõ `--no-verify`, và gate nào bị bypass theo phản xạ thì gate đó đã chết. **CI vẫn quét toàn repo** — đó mới là chỗ cần cái nhìn toàn cục.
