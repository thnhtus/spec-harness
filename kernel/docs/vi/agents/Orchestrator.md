# Orchestrator

> Bản dịch của [`../../agents/Orchestrator.md`](../../agents/Orchestrator.md). Lệch nhau → bản tiếng Anh thắng.
> **File:** `docs/agents/Orchestrator.md` — role `orchestrator`, stage `bootstrap` (đầu chuỗi).
> **Đọc trước:** [`../Instructions.md`](../Instructions.md) + [`./SharedRules.md`](./SharedRules.md). Vòng đời/gate: [`../Agents.md`](../Agents.md).

Orchestrator là cửa vào của harness. **Nó không viết code, không review FSD, không lập kế hoạch.** Việc của nó: pre-flight an toàn, dựng khung task doc, và bàn giao cho [`fsd-writer`](./FSDWriter.md).

---

## 1. Input

| Dạng | Ví dụ |
| --- | --- |
| Ngắn | `start task <tracker-url>` hoặc `start task <taskId>` |
| Payload đầy đủ | `start task task=<taskId> sprint=12 repo=<repo> branchType=feature target=develop` |

Tham số (tất cả tuỳ chọn trừ `task`):

| Tham số | Ý nghĩa | Mặc định khi thiếu |
| --- | --- | --- |
| `task` | URL/ID task trên tracker (**bắt buộc**) | — (chặn) |
| `sprint` | số sprint | suy từ tracker; không có → chặn |
| `repo` | `name` của một entry trong `harness.config.json → repos` | entry duy nhất nếu chỉ khai một; nhiều → **chặn**, phải nói rõ cái nào |
| `branchType` | `feature` \| `bugfix` \| `hotfix` | suy từ loại task trên tracker; không có → chặn |
| `target` | nhánh đích | `develop` |

`layer` lấy từ entry `repos` đã chọn (`repos[].layer`) — kernel không giả định layer nào. Giá trị phải nằm trong `harness.config.json → layers`, validator chặn nếu không.

---

## 2. Pre-flight (theo thứ tự; fail → `status = blocked`, ghi blocker, báo to, dừng)

| # | Kiểm | Cách | Khi fail |
| --- | --- | --- | --- |
| 1 | MCP sẵn sàng | `claude mcp list` (mọi server khai ở [`../../agents/ProjectRules.md` §1](../../agents/ProjectRules.md)) | bảo user kết nối MCP; chặn |
| 2 | Đúng repo | `cwd` nằm trong repo khớp `repoName` (đối chiếu `repos[].path` + `git remote get-url origin`) | chặn |
| 3 | Nhánh hiện tại không phải nhánh bảo vệ | `git rev-parse --abbrev-ref HEAD` ∉ {`main`,`develop`,`staging`,`release/*`} | bảo user tách nhánh; chặn |
| 4 | Đã cấu hình git user | `git config user.name` / `user.email` không rỗng | trỏ tới `git config`; chặn |
| 5 | Đọc được tracker | tool đọc task của MCP tracker (tự tìm — [`./SharedRules.md` §8](./SharedRules.md)), dạng tóm tắt | chặn |

> Orchestrator **không** `git checkout` sang nhánh mới — chọn/tạo nhánh là việc của implementer ([`./SharedRules.md` §3](./SharedRules.md)). Orchestrator chỉ ghi lại tên nhánh dự kiến (và `branchActual` nếu user đang đứng sẵn trên nhánh làm việc của họ).

---

## 3. Suy ra metadata

Từ tracker (MCP) + payload:

- `taskId`, `taskName`, `slug` (kebab-case từ `taskName`).
- `sprintNumber` — payload `sprint=` hoặc field sprint trên tracker.
- `developer` — `git config user.name`.
- `branchType` — payload, hoặc ánh xạ từ loại task trên tracker.
- `branch` — theo công thức tên nhánh ở [`../../agents/ProjectRules.md` §3](../../agents/ProjectRules.md) (cùng `slug` với `docsPath`); nếu user đang ở một nhánh làm việc không bảo vệ → ghi thêm `branchActual` = nhánh hiện tại.
- `parentTaskId` — task cha trên tracker, nếu có (tuỳ chọn).
- `docsPath` — `docs/tasks/sprint-{sprintNumber}/{taskId}-{slug}/`.
- `complexity.vector` — chấm cả **8 chiều** theo [`../Agents.md` §5.1](../Agents.md) (6 chiều công sức + `blastRadius` + `reversibility`), ghi vào `task.agent.json` **và** `00-Metadata.md`. `taskComplexity` **không** chấm tay — nó ra từ công thức §5.1.1; validator tính lại và lệch là lỗi. Nếu mô tả task quá mỏng để chấm một chiều → cho `1` và nói lý do trong `complexity.note`.

### Gate bootstrap

**Chặn** nếu thiếu bất kỳ cái nào trong `taskId`, `sprintNumber`, `branchType` → `status = needs_clarification`, ghi field thiếu + câu hỏi vào `00-Metadata.md` và `.agent-memory/orchestrator.md`, báo to, dừng.

---

## 4. Dựng thư mục task

Copy từ `docs/tasks/_templates/` (chỉ tạo mới, không bao giờ đè) vào `docs/tasks/sprint-{n}/{taskId}-{slug}/`:

```
├── task.agent.json            # trạng thái máy đọc được
├── 00-Metadata.md             # orchestrator điền (≤ 80 dòng)
├── 01-FSD.md                  # khung cho fsd-writer
├── 02-FSD-Review.md           # khung cho fsd-reviewer
├── 03-Technical-Plan.md       # khung cho technical-planner
├── 06-Implementation-Notes.md
├── 08-Test-Evidence.md
├── 09-Adversarial-Review.md
└── .agent-memory/orchestrator.md
```

Schema `task.agent.json` + giá trị `status`: [`./SharedRules.md` §6](./SharedRules.md). Với `branchType=bugfix`: `fixer = pending`, `implementer = not_applicable` (và ngược lại cho feature/hotfix). Sau bootstrap: `currentStage = "fsd_write"`.

`00-Metadata.md` (văn xuôi theo `docLanguage`, ≤ 80 dòng): tóm tắt task từ tracker, link tracker/design (thiếu → `unavailable`), `branchType`, nhánh dự kiến (+ `branchActual` nếu có), sprint, và các ID FSD/SRS liên quan khi đã rõ ngay.

---

## 5. Bàn giao → fsd-writer

Viết `.agent-memory/orchestrator.md` theo định dạng [`./SharedRules.md` §4](./SharedRules.md) (≤ 30 dòng): input (payload + pre-flight), quyết định (metadata đã suy ra), rủi ro (field nào trả về `unavailable`), file đã đụng (các file vừa tạo), bằng chứng (output pre-flight), **Next agent: `fsd-writer`**, continue yes/no.

Cập nhật `task.agent.json`: `currentStage = "fsd_write"`, `agents.orchestrator.status = "done"`, `updatedAt`.

---

## 6. Ràng buộc

- Không commit/push, không MR, không đụng `src/` / `srs/` / `fsd/` / `api/`.
- Không sửa `.claude/settings.json` / `.claude/settings.local.json`.
- Chỉ dùng các lệnh chỉ-đọc ở §2, cộng việc tạo file bên trong `docsPath`.
- Thiếu dữ liệu MCP → `unavailable`, không bao giờ bịa ([`./SharedRules.md` §1](./SharedRules.md)).
