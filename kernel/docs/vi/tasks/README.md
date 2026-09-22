# Task docs — bố cục & cách dùng template

> Bản dịch của [`../../tasks/README.md`](../../tasks/README.md). Lệch nhau → bản tiếng Anh thắng.
> Khu vực **task doc** của AI harness. Mỗi task trên tracker có một thư mục `{tasksDir}/{groupPrefix}{n}/{taskId}-{slug}/` chứa các artifact chỉ-append do một workflow có gate sinh ra.
> File này chỉ giải thích **bố cục & template**. Vòng đời/gate: [`../Agents.md`](../Agents.md); luật chung + giới hạn kích thước: [`../agents/SharedRules.md`](../agents/SharedRules.md); resume: [`../HarnessSetup.md`](../HarnessSetup.md) §7.
> **Template không được dịch:** validator đọc đúng các heading/cột trong `_templates/`. Dùng bản gốc: [`../../tasks/_templates/`](../../tasks/_templates/).

---

## 1. Bố cục một task

```
docs/tasks/
├── README.md              # file này
├── _templates/            # template, copy cho mỗi task mới (§3)
└── sprint-{n}/
    └── {taskId}-{slug}/
        ├── task.agent.json                # trạng thái máy đọc được
        ├── 00-Metadata.md                 # orchestrator (≤ 80 dòng)
        ├── 01-FSD.md                      # fsd-writer — Gate 1 (≤ 250 dòng)
        ├── 02-FSD-Review.md               # fsd-reviewer — Gate 2 (≤ 150 dòng)
        ├── 03-Technical-Plan.md           # technical-planner — Gate 3 (≤ 200 dòng)
        ├── 06-Implementation-Notes.md     # implementer | fixer — Gate 4
        ├── 08-Test-Evidence.md            # bằng chứng thật (lệnh ProjectRules §7 + kết quả)
        ├── 09-Adversarial-Review.md       # adversary — Gate 5 (chạy lại, không tin 08)
        ├── 01a-…/02a-…-Appendix.md        # (tuỳ chọn) phần tràn — stage sau KHÔNG đọc
        └── .agent-memory/{role}.md        # handoff (≤ 30 dòng/khối)
```

Các giới hạn kích thước là điều kiện gate — định nghĩa ở [`../agents/SharedRules.md` §8](../agents/SharedRules.md).

## 2. Role nào viết file nào

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

- `task.agent.json`: schema, giá trị `status` và field tuỳ chọn (`branchActual`, `parentTaskId`) định nghĩa ở [`../agents/SharedRules.md` §6](../agents/SharedRules.md). `taskComplexity ∈ {trivial, normal, high}`.
- Các file `00-…` → `08-…` copy nguyên trạng; mỗi role mở file của mình và **append**.
- Không bao giờ sửa file trong `_templates/` khi đang làm một task — chỉ đổi template khi bạn cố ý đổi cấu trúc cho **mọi** task sau này.

## 4. Quy ước

- **Chỉ-append**, văn xuôi theo `harness.config.json → docLanguage`, ID kỹ thuật giữ nguyên — chi tiết: [`../agents/SharedRules.md` §5](../agents/SharedRules.md).
- `task.agent.json` **không** có field token/usage; nó có `telemetry` (stage · hạng · model · mốc thời gian).
- Lệnh lấy bằng chứng cho Gate 4: danh sách one-shot ở [`../agents/SharedRules.md` §7](../agents/SharedRules.md) — đừng chép bảng lệnh sang đây.

## 5. Nhánh & resume

Luật nhánh (kể cả ngoại lệ `branchActual`): [`../agents/SharedRules.md` §3](../agents/SharedRules.md). Resume task còn dở: [`../HarnessSetup.md`](../HarnessSetup.md) §7.

## 6. Kiểm task doc (tự động)

Chạy `node scripts/validate-tasks.mjs` (không dependency; nó đọc `harness.config.json` ở gốc repo) để kiểm mọi thư mục task theo quy ước của harness:

- `task.agent.json` hợp lệ với schema `_templates/task.agent.schema.json` (các ENUM `status`, `branchType`, `currentStage`, các role bắt buộc…).
- Số nhóm (`sprintNumber`) / `taskId` / `docsPath` khớp vị trí thư mục; `taskId` trên tracker **không trùng**.
- Artifact bắt buộc tồn tại theo `currentStage` đã tới (ví dụ `01-FSD.md` phải có khi `currentStage ≥ fsd_review`).
- Giới hạn số dòng [§8](../agents/SharedRules.md) (00≤80, 01≤250, 02≤150, 03≤200, 06≤250, khối handoff ≤30). Khi doc đã có khối `## Update — …` / `## Cập Nhật — …` (task bị gate đẩy về) thì giới hạn áp cho **khối mới nhất**, không phải cả file — một doc chỉ-append với trần tính trên cả file là cái bẫy đóng kín: vượt trần mà §5 lại cấm xoá bớt.
- `08`/`09` **không có trần cứng** (`lineWarn` 400 = cảnh báo). Chúng chứa output nguyên văn; đặt trần ở đó chỉ ép làm loãng bằng chứng, mà `adversary` cần đúng output đó để đối chiếu. Vượt 400 dòng là tín hiệu tách task, không phải lỗi.
- `branchType` ↔ implementer (feature/hotfix → `implementer`; bugfix → `fixer`).
- Khi `status ∈ {reviewing, mr_created, done}`: `08-Test-Evidence.md` phải có bằng chứng thật — một lệnh khớp `evidenceCommandPattern` **và** một kết quả pass/exit **nằm trong ```code fence```**. Chữ "passed" ở cột *Expected* không tính: đó là kế hoạch, không phải kết quả ([Gate 4](../Agents.md) §3).
- `09-Adversarial-Review.md` phải có phán quyết (PASS/FAIL/UNCERTAIN), output do adversary **tự chạy**, và bảng "Static layer" với cột *Result when you ran it* **không rỗng** — chỉ tồn tại file là chưa đủ. Fence giống `08` từng byte sẽ bị cảnh báo copy-paste.
- **Ngân sách retry**: một role có ≥ `retryBudget` khối handoff (mặc định 4) → lỗi. Khối handoff là chỉ-append nên chúng đo phần làm lại độc lập với `attempts` (do coordinator tự khai); hai bên lệch nhau → cảnh báo. Khi hết ngân sách, đặt `status = split` + `splitInto` (≥2 taskId) để hạ xuống cảnh báo — xem `Agents.md` §5.5.
- **Truy vết AC theo stage** ([SharedRules §9.1](../agents/SharedRules.md)): mọi đích trong `acTrace.reachedIn` được kiểm **ngay khi stage của nó tới** — một AC bị rơi khỏi `03-Technical-Plan.md` fail ngay ở **Gate 3**, không đợi tới lúc review. Task có `updatedAt ≥ mốc` → **lỗi**; cũ hơn → **cảnh báo**.
- **Handoff** ([SharedRules §4](../agents/SharedRules.md)): mọi role ở `status = done` phải có một khối `### ` trong `.agent-memory/{role}.md` mang `Next agent` + `Continue automation` — coordinator route dựa vào đó.
- **Gate 2**: không còn câu hỏi `blocking` + `open` sau `fsd_review`. Dòng `Q-` nào có nội dung nhưng Loại/Trạng thái không phải ENUM (ví dụ bị dịch thành "chặn"/"chưa trả lời") → **lỗi**: một dòng không đọc được thì vô hình với Gate 2, mà bỏ sót trong im lặng nghĩa là "không có câu hỏi blocking nào" — gate tắt mà bảng vẫn trông đầy đủ. Dòng template chưa điền (ô Câu hỏi rỗng) không tính.
- **ENUM của bảng doc** (`harness.config.json → docEnums`): giá trị hợp lệ cho cột `Type`/`Status` của câu hỏi, `Status` của AC, `Type`/`Severity` của risk. `task.agent.json` có schema từ đầu; mấy bảng này thì không, nên giá trị của chúng bị chép tay vào regex của validator rồi hai bên trôi lệch — template từng dạy `clarification / contradiction`, toàn tiếng Anh, mà Gate 2 không bao giờ khớp. `--preflight` nay đối chiếu template và `agents/FSDReviewer.md` với danh sách này, kể cả **dòng mẫu** mà agent thực sự copy.
- **Stage/status khớp nhau**: `reviewing` đòi `currentStage = reviewing` và mọi role đã xong — không nhảy gate.
- **Complexity**: `taskComplexity` phải khớp thứ `complexity.vector` suy ra ([Agents.md §5.1.1](../Agents.md)), và mỗi chiều phải nằm trong thang của nó (`0–2`, trừ `blastRadius`/`reversibility` là `0–4`).
- **AC phải tồn tại**: qua `fsd_review` mà `02-FSD-Review.md` không khai AC nào → lỗi. Không có AC thì cả chuỗi truy vết vô nghĩa, và một task rỗng đi thẳng tới `reviewing`.

Exit code `1` khi có lỗi → dùng được trong **pre-commit hook** hoặc **CI**. Cờ: `--json` (máy đọc), `--no-warn`, `--quiet`, `--self-check` (kiểm logic của chính script, không đọc task), `--calibrate` ([Agents.md §5.6](../Agents.md)), `--staged`.

`--staged` chỉ kiểm các thư mục task mà commit hiện tại đụng tới — pre-commit hook dùng cờ này. Một task đang `blocked` chờ BA là trạng thái hợp lệ; để nó chặn mọi commit không liên quan trong repo chỉ dạy cả team gõ `--no-verify`, và một gate bị bỏ qua theo phản xạ là gate đã chết. **CI vẫn quét cả repo** — đó mới là chỗ của góc nhìn toàn cục.
