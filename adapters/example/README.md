# adapters/example — adapter mẫu

Copy hai file này vào project mới rồi **thay hết nội dung**:

| File | Đi đâu | Sửa gì |
| --- | --- | --- |
| `harness.config.json` | repo root | `tasksDir`, `groupPrefix`, `tracker.urlPattern`, `lineCaps`, `evidenceCommandPattern` + `evidenceSampleCommand` (lệnh test/lint thật của project), `acTrace.since` (đặt = ngày bạn bật harness) |
| `docs/agents/ProjectRules.md` | `docs/agents/` | §1 tracker/design MCP · §2 guardrail source · §3 công thức nhánh · §7 lệnh kiểm tra |

Giữ nguyên số mục **1/2/3/7** — kernel tham chiếu chéo tới chúng bằng số.

Nội dung hiện tại là của một workspace FE React/TS + BE, dùng ClickUp + GitLab + Figma, chỉ để cho thấy **độ chi tiết cần đạt**. §2 và §7 của bạn sẽ khác hoàn toàn, và phần lớn giá trị của chúng chỉ xuất hiện sau khi project gặp sự cố thật — đừng cố viết đủ ngay từ đầu, viết đúng cái đã biết rồi bồi dần.

Sau khi sửa xong, bắt buộc:

```bash
node scripts/validate-tasks.mjs --self-check
```

Nó fail nếu config tự mâu thuẫn (stage không khớp `requiredAtStage`, routing trỏ role không tồn tại, `evidenceSampleCommand` không khớp pattern, `docsPath` regex sinh ra lại từ chối chính folder hợp lệ). Config sai kiểu đó khiến gate im lặng no-op — fail sớm rẻ hơn nhiều.

> Trường `clickupUrl` trong `task.agent.json` giữ tên cũ vì lý do lịch sử — hình dạng URL lấy từ `tracker.urlPattern`, nên Linear/Jira/GitHub Issues đều dùng được mà không phải đổi dữ liệu task đã có.
