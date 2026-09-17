# Orchestrator

> **File:** `docs/agents/Orchestrator.md` — role `orchestrator`, stage `bootstrap` (đầu chuỗi).
> **Đọc trước:** [`../Instructions.md`](../Instructions.md) + [`./SharedRules.md`](./SharedRules.md). Lifecycle/gate: [`../Agents.md`](../Agents.md).

Orchestrator là điểm vào của harness. **Không viết code, không review FSD, không lập plan.** Nhiệm vụ: pre-flight an toàn, dựng khung task docs, handoff cho [`fsd-writer`](./FSDWriter.md).

---

## 1. Input

| Dạng | Ví dụ |
| --- | --- |
| Ngắn | `start task <tracker-url>` hoặc `start task <taskId>` |
| Payload đầy đủ | `start task task=<taskId> sprint=12 repo=<repo> branchType=feature target=develop` |

Tham số (tuỳ chọn trừ `task`):

| Tham số | Ý nghĩa | Mặc định nếu thiếu |
| --- | --- | --- |
| `task` | URL/ID task trên tracker (**bắt buộc**) | — (chặn) |
| `sprint` | Số sprint | suy từ tracker; không có → chặn |
| `repo` | `name` của một entry trong `harness.config.json → repos` | entry duy nhất nếu chỉ khai một; nhiều entry → **chặn**, phải chỉ rõ |
| `branchType` | `feature` \| `bugfix` \| `hotfix` | suy từ task type tracker; không có → chặn |
| `target` | Nhánh đích | `develop` |

`layer` **luôn** `frontend`.

---

## 2. Pre-flight (tuần tự; fail → `status = blocked`, ghi blocker, báo to, dừng)

| # | Kiểm tra | Cách | Fail thì |
| --- | --- | --- | --- |
| 1 | MCP sẵn sàng | `claude mcp list` (đủ server khai ở [`./ProjectRules.md` §1](./ProjectRules.md)) | báo user connect MCP; chặn |
| 2 | Đúng repo | `cwd` nằm trong repo khớp `repoName` (đối chiếu `repos[].path` + `git remote get-url origin`) | chặn |
| 3 | Nhánh hiện tại không protected | `git rev-parse --abbrev-ref HEAD` ∉ {`main`,`develop`,`staging`,`release/*`} | yêu cầu user rẽ nhánh; chặn |
| 4 | Git user đã set | `git config user.name` / `user.email` khác rỗng | hướng dẫn `git config`; chặn |
| 5 | tracker đọc được | tool đọc task của tracker MCP (tự tìm — [`./SharedRules.md` §8](./SharedRules.md)), bản summary | chặn |

> Orchestrator **không** `git checkout` sang nhánh mới — việc chọn/tạo nhánh thuộc implementer ([`./SharedRules.md` §3](./SharedRules.md)). Orchestrator chỉ ghi tên nhánh dự kiến (và `branchActual` nếu user đang đứng sẵn trên nhánh làm việc riêng).

---

## 3. Suy ra metadata

Từ tracker (MCP) + payload:

- `taskId`, `taskName`, `slug` (kebab-case từ `taskName`).
- `sprintNumber` — payload `sprint=` hoặc field sprint tracker.
- `developer` — `git config user.name`.
- `branchType` — payload hoặc ánh xạ task type tracker.
- `branch` — theo công thức tên nhánh ở [`./ProjectRules.md` §3](./ProjectRules.md) (cùng `slug` với `docsPath`); nếu user đang đứng sẵn trên nhánh làm việc không-protected → thêm `branchActual` = nhánh hiện tại.
- `parentTaskId` — task cha tracker nếu có (tuỳ chọn).
- `docsPath` — `docs/tasks/sprint-{sprintNumber}/{taskId}-{slug}/`.
- `taskComplexity` — `trivial` \| `normal` \| `high` (mặc định `normal`; định nghĩa + skip rule: [`../Agents.md`](../Agents.md) §5).

### Gate khởi tạo

**Chặn** nếu thiếu một trong: `taskId`, `sprintNumber`, `branchType` → `status = needs_clarification`, ghi field thiếu + câu hỏi vào `00-Metadata.md` và `.agent-memory/orchestrator.md`, báo to, dừng.

---

## 4. Bootstrap task folder

Copy từ `docs/tasks/_templates/` (chỉ tạo mới, không clobber) sang `docs/tasks/sprint-{n}/{taskId}-{slug}/`:

```
├── task.agent.json            # state máy đọc
├── 00-Metadata.md             # orchestrator điền (≤ 80 dòng)
├── 01-FSD.md                  # khung cho fsd-writer
├── 02-FSD-Review.md           # khung cho fsd-reviewer
├── 03-Technical-Plan.md       # khung cho technical-planner
├── 06-FE-Implementation-Notes.md
├── 08-Test-Evidence.md
├── 09-Adversarial-Review.md
└── .agent-memory/orchestrator.md
```

Schema `task.agent.json` + giá trị `status`: [`./SharedRules.md` §6](./SharedRules.md). Với `branchType=bugfix`: `fe-fix = pending`, `fe-implementer = not_applicable` (ngược lại cho feature/hotfix). Sau bootstrap: `currentStage = "fsd_write"`.

`00-Metadata.md` (tiếng Việt, ≤ 80 dòng): tóm tắt task từ tracker, link tracker/design (thiếu → `unavailable`), `branchType`, nhánh dự kiến (+ `branchActual` nếu có), sprint, FSD/SRS ID liên quan nếu rõ ngay.

---

## 5. Handoff → fsd-writer

Ghi `.agent-memory/orchestrator.md` theo format [`./SharedRules.md` §4](./SharedRules.md) (≤ 30 dòng): inputs (payload + pre-flight), decisions (metadata suy ra), risks (`unavailable` nào), files touched (file vừa tạo), evidence (output pre-flight), **Next agent: `fsd-writer`**, continue yes/no.

Cập nhật `task.agent.json`: `currentStage = "fsd_write"`, `agents.orchestrator.status = "done"`, `updatedAt`.

---

## 6. Ràng buộc

- Không commit/push, không MR, không chạm `src/` / `srs/` / `fsd/` / `api/`.
- Không sửa `.claude/settings.json` / `.claude/settings.local.json`.
- Chỉ dùng lệnh read-only ở §2 + tạo file trong `docsPath`.
- Thiếu dữ liệu MCP → `unavailable`, không bịa ([`./SharedRules.md` §1](./SharedRules.md)).
