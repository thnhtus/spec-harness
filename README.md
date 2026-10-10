# spec-harness

Harness spec-driven cho CLI agent (Claude Code, Codex, Cursor và 13 CLI khác): **7 role, 5 gate**, truy vết từng AC từ spec tới test evidence.

Gate chặn bằng **exit code**, không bằng lời nhắc. Prompt thì model có thể bỏ qua; exit code thì không.

Tách từ một harness đã chạy thật 240 task qua 17 sprint trên codebase production.

## Cài

Cần Node 22+. Chạy trong repo code của bạn:

```bash
cd ~/code/my-app
git init                 # nên có trước: để cắm hook pre-commit
npx spec-harness         # Claude Code
npx spec-harness --cli codex,cursor   # thêm CLI khác (danh sách đầy đủ: docs/advanced.md)
```

Nâng cấp: `npx spec-harness@latest`. Config bạn đã sửa được giữ nguyên.

> [!WARNING]
> `npm i spec-harness` **không** cài harness — nó chỉ tải package về `node_modules/`. Luôn dùng `npx`.

## Bắt đầu

Mở CLI agent trong repo, rồi:

```bash
/init-project-rules                              # 1. dò repo, điền config cho project
node scripts/validate-tasks.mjs --preflight      # 2. phải xanh trước task đầu tiên
/start-task <ticket-id>                          # 3. chạy task
```

Trên Codex/Cursor, gọi skill `init-project-rules` / `start-task` thay cho lệnh `/`.

Hai việc `/init-project-rules` không làm thay được:

- **`.mcp.json`**: điền URL tracker (bắt buộc — là nguồn AC), git-host, design, browser; rồi `/mcp` để login.
- **`acTrace.since`** trong `harness.config.json`: ngày bật harness, để task cũ chỉ bị cảnh báo chứ không bị chặn.

## Cách hoạt động

Mỗi task đi qua 7 role theo thứ tự; giữa các role là một gate. Gate trượt thì task quay lại, không đi tiếp.

| Role | Viết ra | Gate chặn khi |
| --- | --- | --- |
| `orchestrator` | task folder + độ phức tạp | — |
| `fsd-writer` | `01-FSD.md` | FSD thiếu / không truy vết được (**Gate 1**) |
| `fsd-reviewer` | `02-FSD-Review.md` (AC, câu hỏi BA) | AC mơ hồ, còn câu hỏi blocking (**Gate 2**) |
| `technical-planner` | `03-Technical-Plan.md` | thiếu plan / test, rơi AC (**Gate 3**) |
| `implementer` / `fixer` | code + `08-Test-Evidence.md` | thiếu evidence, ngoài scope (**Gate 4**) |
| `adversary` | `09-Adversarial-Review.md` | finding blocking, evidence không tái lập được (**Gate 5**) |

Hai điểm khác một bộ prompt có tổ chức:

- **Gate 5 là đối kháng.** Adversary mặc định FAIL, tự chạy lại lệnh thay vì tin evidence, đọc `git diff` thật, và hỏi "đổi hằng số thì test có đỏ không".
- **Evidence không giả được.** Evidence do `run-evidence.mjs` sinh và gắn hash với output; dán tay hay chép từ task khác đều lệch hash.

Độ phức tạp (vector 8 chiều, validator tự tính lại) chỉ quyết định gate nặng hay nhẹ và dùng model nào — mức nào cũng đủ 5 gate. Task nhỏ thật sự thì đi đường tắt `quick-task` / `fix-bug`; ranh giới đó cũng do exit code quyết định.

## Guardrail

Ngoài validator, harness cài sẵn một lớp permission:

| Lệnh | Hành vi |
| --- | --- |
| `git reset --hard`, `git stash`, `git clean`, đọc `.env` | **chặn** |
| `git push` | **hỏi user**, chỉ sau khi gate cuối đã qua |

Claude Code dùng `permissions.deny` / `permissions.ask`; các CLI khác dùng hook (`--guard <cli>`) và Codex dùng `.codex/rules`. Nhiều CLI tắt hook cho tới khi bạn **trust project** — installer in đúng bước cho CLI bạn chọn.

Guard khớp theo prefix lệnh: nó chặn tai nạn, không chặn người cố ý (`bash -c "git push"` vẫn lọt). Bảo vệ thật cho secret là không để chúng trong repo.

## Tuỳ chọn: Jev pre-filter (tiết kiệm token ở Gate 5)

Jev là decision model của TypeSafe. Nó đọc diff + evidence **trước** adversary; chỉ khi chắc chắn code sai (FAIL, confidence ≥ 0.9) thì `--advance` mới chặn và trả task về implementer, bỏ qua một lượt review 54k–132k token. **Mặc định tắt.** Không có key thì harness chạy y như cũ, lỗi mạng hay key sai cũng không chặn gì.

```bash
# 1. Lấy API key ở TypeSafe, lưu vào Keychain (key không vào shell history, không vào repo)
read -s "k?TYPESAFE_API_KEY: " && security add-generic-password -a "$USER" -s TYPESAFE_API_KEY -w "$k" -U && unset k
echo 'export TYPESAFE_API_KEY="$(security find-generic-password -a "$USER" -s TYPESAFE_API_KEY -w 2>/dev/null)"' >> ~/.zshrc && source ~/.zshrc

# 2. Kiểm: in độ dài, > 0 là đã nạp
echo ${#TYPESAFE_API_KEY}
```

Xong, không cần cấu hình gì thêm: `npx spec-harness` đã cài `scripts/gate5-prefilter.mjs`, và `--advance <task> adversarial_review` tự gọi nó. Mở **terminal mới** (hoặc `source ~/.zshrc`) trước khi chạy agent, nếu không agent không thấy key. Linux / CI: xem [`adapters/gate5-prefilter/README.md`](adapters/gate5-prefilter/README.md).

Thấy nó hoạt động: khi chặn, `--advance` in `pre-filter FAIL … tests_fail_now` và exit 1; khi PASS thì im lặng và adversary chạy bình thường. Kiểm tay: `node scripts/gate5-prefilter.mjs <task-folder> main`.

Đừng kỳ vọng quá: đo trên 20 case, nó chặn được 5/14 case lỗi và chặn nhầm 0/6 case sạch. Lỗi tinh vi (lệch biên, làm tròn) nó trả PASS, adversary vẫn lo phần đó. Đây là bộ lọc rẻ chặn lỗi lộ liễu (test đang đỏ, evidence cũ), không thay adversary.

## Lệnh hay dùng

```bash
node scripts/validate-tasks.mjs              # kiểm toàn bộ task (pre-commit + CI chạy lệnh này)
node scripts/validate-tasks.mjs --preflight  # setup có đúng không
node scripts/validate-tasks.mjs --calibrate  # task đã đóng: ngưỡng độ phức tạp nào đang sai
node scripts/validate-tasks.mjs --cost       # mỗi task tốn bao nhiêu KB luật phải đọc
```

CI là bắt buộc — `git commit --no-verify` bỏ qua được pre-commit, không bỏ qua được CI.

## Tài liệu

- [`adapters/gate5-prefilter/README.md`](adapters/gate5-prefilter/README.md) — pre-filter Jev: cách gắn key, số đo, giới hạn
- [`docs/advanced.md`](docs/advanced.md) — bảng hỗ trợ từng CLI, đặt harness cạnh nhiều repo (FE + BE), MCP server, độ phức tạp, eval/bench, giới hạn đã biết, ghi chú cài đặt
- `docs/Instructions.md` — luật toàn cục (cài vào project)
- `docs/Agents.md` — 7 role, lifecycle, 5 gate (cài vào project)
