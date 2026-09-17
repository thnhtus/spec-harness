# 00 — Metadata: {taskName}

> Sinh bởi `orchestrator` ở stage bootstrap. Append-only, tiếng Việt.

## Thông tin task

| Field | Giá trị |
| --- | --- |
| Task ID | `{taskId}` |
| Task URL | {clickupUrl} |
| Tên task | {taskName} |
| Sprint | {sprintNumber} |
| Repo | <repo> |
| Developer | {developer} |
| branchType | {branchType} (`feature` / `bugfix` / `hotfix`) |
| layer | frontend |
| taskComplexity | {taskComplexity} (`trivial` / `normal` / `high`) |
| Nhánh | `<theo ProjectRules §3>` |
| Target branch | develop |

## Liên kết nguồn (MCP)

| Nguồn | Link / ID | Ghi chú |
| --- | --- | --- |
| Tracker task | {clickupUrl} | nguồn yêu cầu |
| Design tool | unavailable | điền nếu có thiết kế |
| SRS liên quan | `../../../srs/…` | điền module liên quan |
| FSD liên quan | `../../../fsd/…` | điền màn hình / node liên quan |

## Pre-flight (orchestrator)

- [ ] MCP sẵn sàng — đủ server khai ở ProjectRules §1 (`claude mcp list`)
- [ ] `cwd` đúng repo của `repoName` (config `repos`), nhánh hiện tại không phải protected
- [ ] git user đã cấu hình
- [ ] Suy ra đủ metadata (taskId, sprint, branchType)
