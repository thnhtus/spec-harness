# spec-harness

Spec-driven agent harness, tách từ một harness đã chạy thật **240 task / 17 sprint** trên một codebase production.

7 role · 5 gate · mọi AC truy vết được từ spec tới test evidence — và gate được enforce bằng **exit code**, không phải bằng lời nhắc trong prompt.

Gate 5 là **agent đối kháng**: Gate 1–4 do chính người làm tự chấm, nên có thêm một role mặc định FAIL, tự chạy lại lệnh thay vì tin `08-Test-Evidence.md`, đọc `git diff` thật thay vì đọc mô tả diff, và hỏi "đổi hằng số thì test có đỏ không".

## Kernel vs adapter

```
kernel/                              ← dùng chung, không sửa khi sang project mới
├── docs/Instructions.md             luật toàn cục: repo safety, scope, secret, trung thực test
├── docs/Agents.md                   6 role · lifecycle · 4 gate · routing · skip rule
├── docs/agents/SharedRules.md       §4 handoff · §5 task doc · §6 status · §8 budget · §9 AC trace
├── docs/agents/{Role}.md            quy trình từng role
├── docs/tasks/_templates/           khuôn task doc
└── scripts/validate-tasks.mjs       validator, đọc harness.config.json

skills/                              ← ship kèm, cài vào .claude/skills/
├── document-to-ieee-srs             fsd-writer gọi ở Gate 1 (ISO/IEC/IEEE 29148:2018)
├── pre-qc-gate                      adversary gọi ở Gate 5 khi UI load-bearing (drive app thật)
├── humanizer                        cắt giọng AI khỏi văn xuôi task doc (SharedRules §5)
├── api-docs-sync                    Swagger/OpenAPI → docs/api/ (bậc 3 của thang contract API)
├── documents-sync                   tracker doc → docs/srs/ + docs/fsd/
├── build-and-mr                     build → push → tạo MR
├── fix-bug                          bug nhỏ: repro-first, không qua harness
└── quick-task                       task nhỏ: làm thẳng, không qua harness

adapters/                            ← phần mỗi project tự viết
├── ProjectRules.template.md         khung rỗng 4 mục, /init-project-rules điền
├── example/harness.config.json      đường dẫn, stage, cap, routing, lệnh evidence
├── example/.mcp.json                khai MCP server
└── example/docs/agents/…            bản mẫu đã điền (một FE React/TS) — tham khảo độ chi tiết
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

Sinh `docs/`, `scripts/`, `hooks/`, `.claude/agents/` (6 subagent), `.claude/commands/`, `.claude/skills/`, `.mcp.json`, rồi chạy `--self-check`.

**Pre-commit hook là tuỳ chọn** — một chỗ cắm gate, không phải điều kiện chạy. Repo sạch thì installer tự cắm (tôn trọng `core.hooksPath` của husky/lefthook). Project đã có hook riêng, hoặc thư mục không phải git repo → vẫn cài bình thường, chỉ in một dòng ghi chú. Gate lúc đó chạy tay hoặc từ CI: `node scripts/validate-tasks.mjs` (exit 1 khi có error). Chạy lại được: kernel ghi đè, còn `harness.config.json` / `ProjectRules.md` / `start-task.md` đã sửa thì **giữ nguyên** — nâng kernel không mất adapter. Hook sẵn có của project cũng không bị nuốt (script báo để bạn tự chain).

Xong còn 3 việc tay:

| File | Sửa gì |
| --- | --- |
| `.mcp.json` | khai MCP server thật (tracker / git host / design tool), xoá dòng không dùng → rồi `/mcp` login. Project-scoped, commit được cho cả team |
| `harness.config.json` | `repos` (repo nào agent được sửa — xem dưới), `layers`, `models` (ánh xạ tier `cheap`/`mid`/`strong` → tên model của CLI bạn dùng; `{}` = dùng mặc định), `evidenceCommandPattern` + `evidenceSampleCommand` (sample phải khớp pattern), `tracker.urlPattern`, `acTrace.since` |
| `docs/agents/ProjectRules.md` | cài ra là **template rỗng**. Mở Claude Code trong project rồi gõ `/init-project-rules` — nó dò `.mcp.json`, `package.json`, `git branch`, CI workflow, `CLAUDE.md` để điền §1 MCP · §2 guardrail · §3 nhánh · §7 lệnh, hỏi đúng phần không dò được, rồi cập nhật luôn `evidenceCommandPattern` ở dòng trên. Giữ nguyên số mục **1/2/3/7** — kernel trỏ chéo bằng số |

Rồi `node scripts/validate-tasks.mjs --self-check` phải xanh trước task đầu tiên.

`.claude/commands/start-task.md` step 0 còn hardcode quy ước nhánh/worktree của harness gốc (`tubt/t/`, `origin/develop`, `node_modules`, `.env`) — sửa theo ProjectRules §3 của bạn.

### Ba bố cục repo

`repos` khai repo mà agent được sửa, `path` tính từ chỗ đặt `harness.config.json`:

| Bố cục | `repos` | Task docs | Worktree |
| --- | --- | --- | --- |
| Harness trong repo code | `[{ path: "." }]` | cùng repo | worktree của chính repo đó |
| Trong repo FE, đọc BE anh em | `[{ path: "." }, { path: "../be" }]` | repo chính | như trên; BE read-only |
| Harness ngang hàng FE + BE | `[{ path: "../fe" }, { path: "../be" }]` | **repo harness** | worktree trong repo đang sửa; task doc ở lại |

`repoName` của task chỉ một entry — đó là repo được sửa; repo khác trong `repos` là **read-only**; repo không khai thì không đụng. Sai tên → validator chặn. Chi tiết: `docs/Agents.md` §0.

`docs/srs/`, `docs/fsd/`, `docs/api/` cài ra là **rỗng** (chỉ có README làm mục lục). Project tự đổ nội dung, hoặc xoá nếu không dùng — kernel chỉ trỏ tới, không bắt buộc có file.

`--self-check` kiểm tra chính config: stage/routing/artifact có nhất quán không, và `evidenceSampleCommand` có thật sự khớp `evidenceCommandPattern` không. Sai một chỗ thì mọi gate sau đó im lặng no-op — nên nó fail sớm thay vì để bạn phát hiện sau 50 task.

## Vì sao có cái này

Gate bằng văn bản ("agent phải chạy test trước khi báo xong") là gate mà model **chọn** tuân thủ. Gate bằng exit code thì không có chỗ để chọn. Harness gốc mất một thời gian mới học được điều đó; phần đắt nhất ở đây là `validate-tasks.mjs` + chuỗi truy vết AC, không phải mấy file markdown.

Ba thứ validator bắt mà con người hay bỏ sót:

- **AC rơi giữa đường** — `AC-04` có trong review nhưng không ai đưa vào plan, hoặc có trong plan mà không có dòng nào trong test evidence.
- **Evidence giả** — `08` viết "mọi thứ đều pass" nhưng không có lệnh nào được chạy. Phải có **cả** lệnh **và** kết quả mới tính.
- **Template chưa điền** — bản copy nguyên khuôn không được phép thoả mãn traceability (đó là lý do placeholder dùng `AC-nn`, và self-check có regression test cho đúng điều này).


