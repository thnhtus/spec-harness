# 00 — Metadata: {taskName}

> Sinh bởi `orchestrator` ở stage bootstrap. Append-only; văn xuôi theo `harness.config.json → docLanguage`.

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
| layer | {layer} (theo `repos[].layer` của repo đã chọn) |
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
- [ ] Chấm độ phức tạp (bảng dưới)

## Độ phức tạp (Agents.md §5.1)

> Điền **vector**, đừng tự phán điểm. `taskComplexity` do công thức §5.1.1 tính ra — validator kiểm lại, lệch là error.

| Chiều | 0 | 1 | 2 | Chấm |
| --- | --- | --- | --- | --- |
| scope | 1 file | vài file, 1 module | nhiều module/tầng | |
| uncertainty | rõ hết | suy ra được | phải hỏi BA | |
| dependency | không | module có sẵn | service/repo khác | |
| dataImpact | không chạm | đọc/ghi qua API sẵn | schema · migration · shape dùng chung | |
| integration | không | API sẵn có | thêm/đổi contract · hệ thống ngoài | |
| testing | test sẵn phủ | thêm test thường | khó tái hiện · e2e/thủ công | |

**effort = tổng (0–12):** {n}

**Số đo đã chấm từ đó** (validator đối chiếu, thiếu là error): `counts.symbol` = `{symbol đã grep}` · `counts.filesTouched` = {n} · `counts.existingTests` = {n} · `questions[]` = {danh sách "không làm được nếu không biết X", rỗng chỉ khi đã đi tìm}

| Chiều rủi ro | Thang | Chấm |
| --- | --- | --- |
| blastRadius | 0 một chỗ · 1 module · 2 feature · 3 service · 4 toàn hệ thống | |
| reversibility | 0 sửa lại xong · 1 revert · 2 deploy lại · 3 sửa dữ liệu · 4 không lùi được | |

> Hai chiều này không có số đo nào đối chiếu, mà chúng một mình kéo `trivial → high`. Đây là chỗ duy nhất còn dựa hoàn toàn vào phán đoán — đừng chấm cho qua.

**→ `taskComplexity` = {trivial\|normal\|high}** · ghi vector vào `task.agent.json → complexity`
