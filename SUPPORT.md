# Hỗ trợ

Dự án OSS, **không có SLA**. Không cam kết thời gian phản hồi. Nếu bạn cần cam kết (thời gian sửa, bản vá bảo mật có hạn định, hỗ trợ có hợp đồng), đừng dựa vào file này — thoả thuận riêng với chủ repo.

## Trước khi mở issue

1. `node scripts/validate-tasks.mjs --preflight` — phần lớn sự cố cài đặt hiện ra ở đây.
2. [`docs/runbook.md`](docs/runbook.md) — sự cố thường gặp và lệnh khôi phục.
3. `node install.mjs --self-test` — nếu lệnh này đỏ trên bản mới clone, đó là bug của harness, không phải của project bạn.

## Khi báo lỗi, kèm theo

- `node scripts/validate-tasks.mjs --preflight` (toàn bộ output).
- Nội dung `docs/.kernel-version` (bản kernel đang chạy).
- CLI và phiên bản (`claude --version`, `codex --version`, …).
- Nguyên văn thông báo lỗi. Đừng diễn giải lại — các gate được nhận diện bằng chuỗi lỗi chính xác.

## Bảo mật

Lỗ hổng: báo riêng cho chủ repo, đừng mở issue công khai. Không có quy trình phát hành bản vá theo hạn định.

## Phạm vi đã kiểm chứng

| Đã chạy thật | Chưa |
|---|---|
| Claude Code (eval 8/8) | Codex (proxy nội bộ hết credit — xem #130) |
| ClickUp | Jira, Linear (chỉ có fixture — #135) |
| macOS | Linux (chỉ qua CI), Windows |

Những dòng ở cột "chưa" không phải là đã hỏng — là **chưa ai đo**. Đừng đọc im lặng thành bảo đảm.

Từng capability (guard hook, role file, Gate 5 chạy tiến trình riêng) hiện ở dạng bảng, mặc định `UNVERIFIED` khi chưa có lần chạy thật ghi trên đĩa:

```bash
node scripts/validate-tasks.mjs --capabilities
```

Có adapter trong installer **không** được tính là đã tương thích production.
