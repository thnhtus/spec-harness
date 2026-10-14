# Kiến trúc (#134)

Bản đồ cho người thứ hai đọc code, không phải tổng quan marketing. Hai file làm gần hết việc:

| File | Vai trò | Kích thước |
|---|---|---|
| `kernel/scripts/validate-tasks.mjs` | validator + mọi lệnh CLI (gate, tier, telemetry, tracker, audit) | ~6k dòng |
| `install.mjs` | cài đặt + `--eval`/`--bench`/`--self-test` (sandbox hoá toàn bộ pipeline để test không cần agent thật) | ~2.9k dòng |

Vì sao không tách: mỗi hàm có self-check/e2e đi kèm ngay cạnh nó (grep `assert.` trong cùng file), nên chi phí thật là đọc/điều hướng, không phải sửa sai. Xem `#118` (đóng, hoãn tới ngưỡng contributor #2 hoặc 200 task/năm).

## `kernel/scripts/validate-tasks.mjs` — các khối chính (theo thứ tự trong file)

1. **Guard** (`--guard`, `--guard-role`, `--check-settings`, `--codex-rules`) — deny-list cho các CLI không đọc `permissions.deny` của Claude.
2. **Pure predicates** (không I/O) — mỗi gate là một hàm `xDefects(...)` trả mảng lỗi, test được không cần filesystem. Đây là phần nên đọc trước khi sửa một gate.
3. **`--self-check`** — chạy mọi assert trong file. Đây là nguồn sự thật duy nhất khi nghi ngờ một hành vi; không đoán, chạy nó.
4. **Telemetry/budget/tracker** (`--report`, `--writeback`, `--key-migrate`) — #121, #120, #132.
5. **`--advance`** — nơi mọi gate thực sự được enforce theo thứ tự: budget (#121) → pre-filter (#109) → scope creep (#115) → pack cap (#116) → lease → stamp (#124) → telemetry. Đọc khối này để hiểu thứ tự ưu tiên khi hai gate cùng muốn chặn.
6. **`--run-adversary`** (#131) — Gate 5 ở tiến trình mới.
7. **`--bootstrap` / `--triage`** — stage 1 không cần subagent.
8. **`--preflight`** — mọi cảnh báo trạng thái cài đặt (guard, CODEOWNERS #133, isolation #126, key #125, branch protection #119) nằm ở đây, cộng dồn, không dừng ở lỗi đầu tiên.
9. **`--capabilities`** (#139) — ma trận per-CLI (guard hook, role file, Gate 5 tiến trình riêng), mặc định `UNVERIFIED`; chỉ một lần chạy thật trên đĩa mới đổi được thành `verified`. Installer self-test khoá phần bằng chứng (file phải tồn tại) và chỉ matrix không được tự nhận `verified` khi mới có file cài.

## Ranh giới của attestation (đọc trước khi tin Gate 4)

`run-evidence.mjs` làm Gate 4 đắt hơn để gian lận: `outputHash` gắn attestation với đúng output, `worktree:` gắn với nội dung cây code lúc chạy (#137), `_stamp.log` ký HMAC chuỗi. **Nó không phải chữ ký.** Hàm hash công khai và agent cùng OS user đọc được (key có thể đưa vào Keychain bằng `--key-migrate`, #125/#132). Ba chỗ fail-open: CI, task đã qua `reviewing`, và git không trả lời được.

Nghĩa là: mức phòng thủ này chặn **nhầm lẫn** — dán evidence của task khác, sửa output sau khi chạy, chạy test hôm trước rồi đổi code hôm sau. Nó không chặn **ý định**. Thứ chặn ý định là adversary tự chạy lại lệnh ProjectRules §7 (Gate 5), không phải hash.
10. **Validator chính** (cuối file) — duyệt mọi task folder, gọi các `xDefects`, in hoặc trả JSON.

## `install.mjs` — các khối chính

1. `installInto(P, clis, coOwner)` — ghi file vào project đích, không đè file đã có (trừ kernel).
2. `ADAPTERS` — bảng cấu hình hook cho 13+ CLI khác Claude.
3. `buildBase` / `buildEvalCase` / `evalCases()` — dựng sandbox cài sẵn harness, dùng chung bởi `--eval`, `--bench`, và phần lớn `--self-test`.
4. `--eval` (#123) — chạy agent thật qua các case adversary, ghi `kernel/eval/last-pass.json` khi 100% xanh.
5. `--bench` — đọc token/thời gian từ stream-json (Claude) hoặc rollout (Codex).
6. `--self-test` — cài vào sandbox tạm, assert hành vi thật (không mock `installInto`).

## Luồng một task (tham chiếu nhanh)

```
--bootstrap → --advance fsd_write → --advance fsd_review → --advance technical_plan
→ --advance implementation [--slice Sn] → --advance adversarial_review (hoặc --run-adversary)
→ --advance reviewing → --writeback
```

Mỗi `--advance` gọi lại chính validator (`--task <dir>`) để chấm gate trước khi cho dispatch tiếp — không có đường tắt nào bỏ qua việc này.

## Khi cần sửa một gate

1. Tìm hàm pure tương ứng (ví dụ `budgetDefect`, `writeBackRecordDefect`) — sửa ở đó trước.
2. Thêm assert vào `--self-check` ngay cạnh hàm, không thêm ở cuối file.
3. Nếu gate liên quan tới `--advance` hay installer, thêm e2e thật trong `install.mjs --self-test` (sandbox, không mock).
4. `node install.mjs --self-test` phải xanh trước khi coi là xong.
