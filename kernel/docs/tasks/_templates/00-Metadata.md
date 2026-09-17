# 00 — Metadata: {taskName}

> Sinh bởi `orchestrator` ở stage bootstrap. Append-only, tiếng Việt.

## Thông tin task

| Field | Giá trị |
| --- | --- |
| ClickUp ID | `{taskId}` |
| ClickUp URL | {clickupUrl} |
| Tên task | {taskName} |
| Sprint | {sprintNumber} |
| Repo | <repo> |
| Developer | {developer} |
| branchType | {branchType} (`feature` / `bugfix` / `hotfix`) |
| layer | frontend |
| taskComplexity | {taskComplexity} (`trivial` / `normal` / `complex`) |
| Nhánh | `<theo ProjectRules §3>` |
| Target branch | develop |

## Liên kết nguồn (MCP)

| Nguồn | Link / ID | Ghi chú |
| --- | --- | --- |
| ClickUp task | {clickupUrl} | nguồn yêu cầu |
| Figma | unavailable | điền nếu có thiết kế |
| SRS liên quan | `../../../srs/…` | điền module liên quan |
| FSD liên quan | `../../../fsd/…` | điền màn hình / node liên quan |

## Pre-flight (orchestrator)

- [ ] MCP ClickUp/GitLab/Figma sẵn sàng (`claude mcp list`)
- [ ] Đúng repo đích (ProjectRules §3), nhánh hiện tại không phải protected
- [ ] git user đã cấu hình
- [ ] Suy ra đủ metadata (taskId, sprint, branchType)
