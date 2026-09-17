# spec-harness

Spec-driven agent harness, tách từ một harness đã chạy thật **240 task / 17 sprint** trên một codebase production.

6 role · 4 gate · mọi AC truy vết được từ spec tới test evidence — và gate được enforce bằng **exit code**, không phải bằng lời nhắc trong prompt.

## Kernel vs adapter

```
kernel/                              ← dùng chung, không sửa khi sang project mới
├── docs/Instructions.md             luật toàn cục: repo safety, scope, secret, trung thực test
├── docs/Agents.md                   6 role · lifecycle · 4 gate · routing · skip rule
├── docs/agents/SharedRules.md       §4 handoff · §5 task doc · §6 status · §8 budget · §9 AC trace
├── docs/agents/{Role}.md            quy trình từng role
├── docs/tasks/_templates/           khuôn task doc
└── scripts/validate-tasks.mjs       validator, đọc harness.config.json

adapters/example/                    ← mỗi project tự viết (~110 dòng + 1 file config)
├── harness.config.json              đường dẫn, stage, cap, routing, lệnh evidence
└── docs/agents/ProjectRules.md      §1 nguồn truth · §2 guardrail · §3 nhánh · §7 lệnh
```

Kernel không biết project dùng stack nào, tracker nào, đặt tên nhánh ra sao. Bốn mục đó — và chỉ bốn mục đó — nằm ở `ProjectRules.md`. Số mục giữ nguyên **1/2/3/7** để mọi tham chiếu chéo `SharedRules §n` trong kernel vẫn trỏ đúng.

## Cài vào project mới

```bash
# không cần clone (repo phải public)
curl -fsSL https://raw.githubusercontent.com/thnhtus/spec-harness/master/install.sh | bash -s -- <project-root>

# hoặc từ bản clone
git clone --depth 1 https://github.com/thnhtus/spec-harness
bash spec-harness/install.sh <project-root>
```

Cách đầu tự tải tarball vào thư mục tạm rồi xoá — không để lại bản clone. Ghim phiên bản bằng `SPEC_HARNESS_REF=v0.1.0`. Repo private thì chỉ dùng được cách hai (script báo rõ và dừng, không cài nửa vời).

Sinh `docs/`, `scripts/`, `hooks/`, `.claude/agents/` (6 subagent), `.claude/commands/`, `.mcp.json`, cắm git hook (tôn trọng `core.hooksPath` nếu project dùng husky/lefthook), rồi chạy `--self-check`. Project đã có `pre-commit` riêng → installer không đè mà **cảnh báo to**: gate chưa cắm nghĩa là harness chỉ còn là markdown. Chạy lại được: kernel ghi đè, còn `harness.config.json` / `ProjectRules.md` / `start-task.md` đã sửa thì **giữ nguyên** — nâng kernel không mất adapter. Hook sẵn có của project cũng không bị nuốt (script báo để bạn tự chain).

Xong còn 3 việc tay:

| File | Sửa gì |
| --- | --- |
| `.mcp.json` | khai MCP server thật (tracker / git host / design tool), xoá dòng không dùng → rồi `/mcp` login. Project-scoped, commit được cho cả team |
| `harness.config.json` | `evidenceCommandPattern` + `evidenceSampleCommand` (lệnh test thật, sample phải khớp pattern), `tracker.urlPattern`, `acTrace.since` = ngày bật harness |
| `docs/agents/ProjectRules.md` | thay sạch §1 MCP · §2 guardrail · §3 nhánh · §7 lệnh — giữ nguyên số mục **1/2/3/7**, kernel trỏ chéo bằng số |

Rồi `node scripts/validate-tasks.mjs --self-check` phải xanh trước task đầu tiên.

`.claude/commands/start-task.md` step 0 còn hardcode quy ước nhánh/worktree của harness gốc (`tubt/t/`, `origin/develop`, `node_modules`, `.env`) — sửa theo ProjectRules §3 của bạn.

`docs/srs/`, `docs/fsd/`, `docs/api/` cài ra là **rỗng** (chỉ có README làm mục lục). Project tự đổ nội dung, hoặc xoá nếu không dùng — kernel chỉ trỏ tới, không bắt buộc có file.

`--self-check` kiểm tra chính config: stage/routing/artifact có nhất quán không, và `evidenceSampleCommand` có thật sự khớp `evidenceCommandPattern` không. Sai một chỗ thì mọi gate sau đó im lặng no-op — nên nó fail sớm thay vì để bạn phát hiện sau 50 task.

## Vì sao có cái này

Gate bằng văn bản ("agent phải chạy test trước khi báo xong") là gate mà model **chọn** tuân thủ. Gate bằng exit code thì không có chỗ để chọn. Harness gốc mất một thời gian mới học được điều đó; phần đắt nhất ở đây là `validate-tasks.mjs` + chuỗi truy vết AC, không phải mấy file markdown.

Ba thứ validator bắt mà con người hay bỏ sót:

- **AC rơi giữa đường** — `AC-04` có trong review nhưng không ai đưa vào plan, hoặc có trong plan mà không có dòng nào trong test evidence.
- **Evidence giả** — `08` viết "mọi thứ đều pass" nhưng không có lệnh nào được chạy. Phải có **cả** lệnh **và** kết quả mới tính.
- **Template chưa điền** — bản copy nguyên khuôn không được phép thoả mãn traceability (đó là lý do placeholder dùng `AC-nn`, và self-check có regression test cho đúng điều này).


