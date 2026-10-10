# spec-harness: chi tiết

> Tài liệu đầy đủ, tách từ README. Bắt đầu nhanh thì đọc [README](../README.md).

## CLI khác Claude Code


```bash
npx spec-harness --cli codex,gemini   # thêm lớp cho CLI khác; .claude/ luôn được cài
```

Mọi CLI khác Claude nhận `AGENTS.md` + `.agents/skills/`. Guard deny (`reset --hard` / `stash` / `clean` / `.env`) chỉ có ở CLI có hook project; `git push` là `ask` riêng (#104/#106) — dừng hỏi user sau gate cuối, không deny cứng.

| Hạng | CLI | File guard | Kiểm |
|---|---|---|---|
| A | codex, cursor | `.codex/hooks.json`, `.cursor/hooks.json` | codex e2e (trust thật) |
| A | gemini · qwen | `.gemini/settings.json` · `.qwen/settings.json` (merge, giữ config của bạn) + `agents/` | e2e |
| A | copilot · droid · antigravity | `.github/hooks/spec-harness.json` · `.factory/hooks.json` (+`droids/`) · `.agents/hooks.json` | e2e |
| A | windsurf / Devin Desktop · devin (CLI) · kiro | `.devin/hooks.json` (+ `.windsurf/hooks.json` cho IDE cũ) · `.devin/hooks.v1.json` · `.kiro/hooks/spec-harness.json` | payload theo docs / `devin migrate` |
| A | cline | `.clinerules/hooks/PreToolUse` (chặn từng lệnh/file, task chạy tiếp) | e2e (3.0.65) |
| A | goose · pi · opencode | `.agents/plugins/spec-harness/` · `.pi/extensions/spec-harness.js` · `.opencode/plugins/spec-harness.js` | e2e |
| B | hermes | không ghi gì ngoài repo; installer in snippet cho `~/.hermes/config.yaml` | `hermes hooks test` |
| B | amp, codewhale | không có hook chặn được (hook của CodeWhale mới chỉ quan sát) | không |
| C | aider, continue, zed, roo, kilo, crush, augment, junie, warp, trae | tự trỏ vào `AGENTS.md`; guard = pre-commit + CI | không |

Nhiều CLI tắt hook project tới khi bạn trust (Codex `/hooks`, Gemini/Qwen trusted folder, Copilot `trustedFolders`, pi trust project). Installer in đúng bước cho CLI bạn chọn. `node scripts/validate-tasks.mjs --preflight` báo lỗi nếu file guard của CLI nào mất `--guard <cli>` (đọc `.agents/spec-harness-guards.json`).

Cài lại không cần `--cli`: installer tự nhận các lớp đã có và nâng luôn.

| Lớp | Claude Code | Codex | Cursor |
|---|---|---|---|
| Gate (pre-commit + CI) | ✅ | ✅ | ✅ |
| 7 role | `.claude/agents/` | `.codex/agents/*.toml` | đọc `.claude/agents/` |
| Skills + `start-task` / `init-project-rules` | `.claude/` | `.agents/skills/` | `.agents/skills/` |
| `adversary` / `fsd-reviewer` chỉ ghi trong `tasksDir` | hook frontmatter → `--guard-role`, bắt cả Edit/Write lẫn Bash `>`/`sed -i`/`cp` (cần trust folder) | ❌ chỉ prose | ❌ chỉ prose |
| Deny `reset --hard` / `.env` | `permissions.deny` | hook `PreToolUse` → `--guard codex` | hook `beforeShellExecution` + `beforeReadFile` → `--guard cursor` |
| Ask `git push` (dừng hỏi user sau gate cuối) | `permissions.ask` | `.codex/rules/*.rules` (`execpolicy`, #105) | hook `beforeShellExecution` trả `ask` |
| Gợi ý khi dán link task | ✅ | ✅ | ❌ (Cursor không chèn được context) |
| MCP | `.mcp.json` | `.codex/config.toml` | `.cursor/mcp.json` |

Guard dùng một danh sách duy nhất, gồm luật bắt buộc của harness cộng với `permissions.deny` trong `.claude/settings.json`. Thêm luật ở đó thì cả ba CLI cùng nhận. Codex bỏ qua hook cho tới khi bạn trust nó: mở `codex` trong project, trust project, rồi gõ `/hooks` và trust hai hook spec-harness. Chưa trust thì guard đang tắt. Trust gắn với đường dẫn thật (realpath) và hash của hook, nên mở qua symlink hay sửa `.codex/hooks.json` là phải trust lại. Codex trên Windows chưa gọi `PreToolUse` cho lệnh shell ([openai/codex#24453](https://github.com/openai/codex/issues/24453)), nên trên Windows chỉ còn pre-commit và CI.


## Chỗ khác với một bộ prompt có tổ chức

Gate 5 là agent đối kháng. Gate 1–4 do chính người làm tự chấm, nên cần thêm một role mặc định FAIL. Role này tự chạy lại lệnh chứ không tin `08-Test-Evidence.md`, đọc `git diff` thật chứ không đọc mô tả diff, và hỏi "đổi hằng số thì test có đỏ không".

Harness học từ task đã đóng. Độ phức tạp được ước lượng trước, rework được đo trong lúc làm, kết quả được ghi sau khi ship. `--calibrate` đối chiếu ba mốc đó và chỉ ra ngưỡng nào đang sai.

## Kernel vs adapter

```
kernel/                              ← dùng chung, không sửa khi sang project mới
├── docs/Instructions.md             luật toàn cục: repo safety, scope, secret, trung thực test
├── docs/Agents.md                   §0 bố cục repo · 7 role · lifecycle · 5 gate · §5 complexity
├── docs/agents/SharedRules.md       §4 handoff · §5 task doc · §6 status · §8 budget · §9 AC trace
├── docs/agents/{Role}.md            quy trình từng role (gồm Adversary.md — Gate 5)
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
├── ci/validate-tasks.yml            workflow chạy validator ở CI
├── example/harness.config.json      repos, layers, models, stage, cap, lệnh evidence
├── example/.mcp.json                khai MCP server
└── example/docs/agents/…            bản mẫu đã điền (một FE React/TS) — tham khảo độ chi tiết
```

Kernel không biết project dùng stack nào, tracker nào, đặt tên nhánh ra sao. Chỉ bốn mục đó nằm ở `ProjectRules.md`. Các mục giữ số 1/2/3/7 để mọi tham chiếu chéo `SharedRules §n` trong kernel vẫn trỏ đúng.

Kernel cũng không gắn với một CLI. Source chỉ ghi tên hạng (`cheap`/`mid`/`strong`), không hardcode tên model hay tên tool MCP. Tên model thật khai theo từng CLI trong `models.<cli>` của config; installer ghi `model:` vào file role của đúng CLI đó. Muốn thêm Codex hay Gemini thì cài thêm lớp bằng `--cli` và thêm key `models.codex`, kernel giữ nguyên.

## Đặt harness ở đâu

Hai trường hợp khác nhau ở chỗ `harness.config.json` nằm đâu, và task docs nằm theo nó.

| | A: trong repo code | B: cạnh các repo code |
| --- | --- | --- |
| Khi nào | Một repo (FE hoặc BE) | Nhiều repo, hoặc muốn task docs tách khỏi code |
| Task docs | `my-app/docs/tasks/`, commit chung với code | `harness/docs/tasks/`, commit riêng |
| `repos` | `[{ path: "." }]` | `[{ path: "../fe" }, { path: "../be" }]` |
| Mở CLI ở | repo root | `harness/` (thư mục cha thì không được) |

### A: trong repo code (mặc định)

```bash
cd ~/code/my-app
npx spec-harness
```

`.claude/` nằm sẵn ở repo root nên thư mục con (`packages/web/`) và worktree do `/start-task` tạo đều thấy được. Đừng thêm `.claude/` vào `.gitignore`: worktree sẽ rỗng và `/start-task` mất skills giữa chừng.

### B: cạnh các repo code

Harness đứng ngang hàng với các repo code. Thư mục chưa tồn tại nên phải tự tạo trước:

```bash
cd ~/code/my-workspace    # thư mục đang chứa fe/ và be/
mkdir harness && cd harness
git init                  # khuyến nghị mạnh — xem ghi chú cài đặt
npx spec-harness
```

```
my-workspace/
├── harness/     ← cài vào đây; task docs, spec, evidence
├── fe/          ← code, không bị đụng
└── be/          ← code, không bị đụng
```

Mở CLI trong `harness/`. CLI chỉ đọc `.claude/` ở cwd và các thư mục cha, không quét xuống thư mục con. Mở ở `my-workspace/` thì `harness/.claude/` vô hình: mất skills, mất `/start-task`, và mất cả deny `git reset --hard` lẫn ask `git push`. Từ trong `harness/` bạn vẫn sửa được repo anh em bằng `/add-dir ../fe ../be`.

Chạy `--add-dir harness` từ thư mục cha không thay được cách trên. Nó nạp skills và commands nhưng bỏ qua `settings.json`, nên guardrail mất mà không báo gì, trong khi mọi thứ khác trông vẫn chạy. Installer đặt sẵn một `CLAUDE.md` cảnh báo ở thư mục cha để bắt trường hợp bạn lỡ mở nhầm (đã có `CLAUDE.md` thì không đè).

<details>
<summary>Vẫn muốn mở CLI ở <code>my-workspace/</code>?</summary>

Symlink cả sáu thứ lên thư mục cha, `.claude` thôi thì chưa đủ. `.claude` lo phần nạp (skills, commands, `settings.json`). Năm thứ còn lại lo phần chạy, vì `/start-task` gọi `node scripts/lease.mjs` và `docs/tasks/...` bằng đường dẫn tương đối tính từ cwd:

```bash
cd ~/code/my-workspace
for x in .claude .mcp.json scripts docs harness.config.json hooks; do ln -s harness/$x $x; done
```

Thiếu `scripts/` thì `/start-task` chết ở step 0b (`Cannot find module .../scripts/lease.mjs`) dù đã nạp xong.

File thật vẫn nằm trong `harness/`. Lease, task folder và evidence đều ghi xuyên symlink về đó, nên vẫn commit chung với task docs và nâng kernel không phải làm lại. Installer thấy `.claude` ở thư mục cha thì tự gỡ biển báo cảnh báo.

Bố cục này đã được kiểm end-to-end: `/start-task` qua được step 0b và step 1, `task.agent.json` và `.lease.d/owner` nằm đúng trong `harness/docs/tasks/`, thư mục cha không có file rác, `git worktree add` vào `../fe` chạy bình thường.

Cái giá là `fe/` và `be/` giờ nằm trong cwd, agent chạm được mà không cần `/add-dir`. Tiện hơn, nhưng mất một lớp chặn tay nhầm.

Trên Windows, `ln -s` cần Developer Mode hoặc quyền admin. Không bật được thì dùng `mklink /D` trong cmd (admin), hoặc mở CLI trong `harness/` như mặc định.

</details>

<details>
<summary>Bố cục thứ ba: trong repo FE, đọc BE anh em</summary>

`repos` khai các repo agent được dùng, `path` tính từ chỗ đặt `harness.config.json`:

| Bố cục | `repos` | Task docs | Worktree |
| --- | --- | --- | --- |
| Harness trong repo code | `[{ path: "." }]` | cùng repo | worktree của chính repo đó |
| Trong repo FE, đọc BE anh em | `[{ path: "." }, { path: "../be" }]` | repo chính | như trên; BE read-only |
| Harness ngang hàng FE + BE | `[{ path: "../fe" }, { path: "../be" }]` | repo harness | worktree trong repo đang sửa; task doc ở lại |

`repoName` của task trỏ tới một entry, là repo được sửa. Repo khác trong `repos` chỉ được đọc (ví dụ đọc DTO của BE để lấy contract). Repo không khai thì không đụng tới. Sai tên thì validator chặn. Chi tiết ở `docs/Agents.md` §0.

</details>

## Sau khi cài: `/init-project-rules`

Installer chỉ chép file. Nó không biết project dùng stack gì, tracker nào, nhánh đặt tên ra sao, nên `harness.config.json` và `docs/agents/ProjectRules.md` cài ra là khung rỗng. Chạy task lúc này thì gate không có gì để kiểm.

`/init-project-rules` dò repo (`.mcp.json`, manifest package, `git branch`, CI workflow, `CLAUDE.md`, repo anh em), hỏi phần không dò được, rồi điền:

| Điền vào | Gì |
| --- | --- |
| `docs/agents/ProjectRules.md` | §1 nguồn truth MCP · §2 guardrail source · §3 quy tắc nhánh · §7 lệnh kiểm tra |
| `harness.config.json` | `repos`, `layers`, `models.<cli>`, `coordinatorTier`, `docLanguage`, `evidenceCommandPattern` + `evidenceSampleCommand` |

Cuối cùng nó tự chạy `--self-check` để xác nhận config không tự mâu thuẫn.

Còn vài việc nó không làm thay được:

| File | Vì sao phải tự làm |
| --- | --- |
| `.mcp.json` | URL server và OAuth chỉ bạn có. Sửa URL rồi gõ `/mcp` để login. File này project-scoped, commit được cho cả team |
| `acTrace.since` trong `harness.config.json` | Đặt bằng ngày bạn bật harness. Task cũ hơn mốc này chỉ bị warning, không bị chặn; nếu không có mốc thì mọi task có sẵn đều đỏ |
| `protectedBranches` trong `harness.config.json` | Danh sách regex nhánh mà `--bootstrap` từ chối (ProjectRules §3 ở dạng dữ liệu). Mặc định cài ra `main/master/develop/staging/release/.*`; thiếu key thì exit 2 |
| `stampSince` trong `harness.config.json` | Giống `acTrace.since`: task tạo từ ngày này phải có mọi khung telemetry khớp một dòng `_stamp.log` (chỉ `--advance` ghi). Thiếu key thì exit 2 |
| `_stamp.log` / `_triage.log` | Installer tự thêm hai file này vào `.gitignore` (sống qua `git clean -fd`, không commit vì append-only và commit không tăng độ tin cậy). Mỗi dòng `_stamp.log` do `--advance` ghi có HMAC (cột 8) ký bằng key riêng của máy ở `~/.spec-harness/stamp.key` (đổi chỗ bằng `SPEC_HARNESS_KEY_FILE`), nằm NGOÀI repo nên agent chỉ sửa file trong repo không ký được; máy không có key (CI, clone mới) thì bỏ qua phần chữ ký. Mất log thì `node scripts/validate-tasks.mjs --restamp` dựng lại từ telemetry (cột 7 `restamp`), từ chối khi log còn và bỏ qua task `done` trừ khi thêm `--include-done` |

Bản cài ra để `"evidenceMode": "attested"`: Gate 4/5 đòi evidence do `scripts/run-evidence.mjs` sinh, không nhận output dán tay. Hạ xuống `"legacy"` chỉ hợp lý khi di trú một repo đã có evidence viết tay. Trường này bắt buộc khai tường minh, không có mặc định ngầm.

Xong hết thì `--preflight` phải xanh trước task đầu tiên. Chưa xanh thì gate chạy mà không kiểm gì, và bạn chỉ phát hiện sau vài chục task.

Một việc nữa `--preflight` không tự biết (chỉ cảnh báo ở #97, không chặn): `sliceBytes` của model bạn chưa đo. Config mẫu chỉ có số đo cho `claude/sonnet` (64000, #76) — thêm CLI/model khác mà không đo thì rơi về ngưỡng này, và dấu hiệu đầu tiên là auto-compact giữa task lớn chứ không phải lỗi rõ ràng:

```bash
node install.mjs --bench --stage implementation --unsliced --find-slice-bytes --agent '<CLI + model thật của bạn>'
# dán số ra vào models.<cli>.<tier>.sliceBytes
```

`--preflight` chạy `--self-check` cộng thêm những thứ nằm ngoài file config mà self-check không thấy:

| Kiểm | Mức | Vì sao |
| --- | --- | --- |
| `.claude/settings.json` có được nạp từ cwd hiện tại không | error | bẫy bố cục B ở trên |
| …và có còn đủ deny rule không (`reset --hard`, `stash`, `clean`, `cat .env`, `env`, `printenv`, `Read(.env)`), và `git push` có đang nằm ở `ask` chứ không còn kẹt ở `deny` không (#106) | error | file tồn tại mà rỗng thì guardrail mất mà không báo; preflight nêu tên rule thiếu |
| `ProjectRules.md` còn `NOT-FILLED-IN`, hoặc `repos[]` còn `<repo-name>` | error | sửa `.mcp.json` xong là preflight từng xanh trong khi mọi role vẫn đọc `<lint command>` làm §7. Ô `<…>` còn sót trong ProjectRules thì warning |
| File được track còn gọi `--triage` với vector trần (script CI, Makefile, skill tự viết) | error | 0.12 nhận `{vector, counts, questions}`; installer chỉ sửa được dòng nó cài ra, còn lại preflight chỉ `file:line` |
| `.mcp.json` còn trỏ placeholder (`example.com`, `<host>`) | error | Gate 1 mất nguồn AC, cả chuỗi truy vết thành tự bịa |
| `.mcp.json` có field trông như credential | error | file này được commit |
| CI có chạy `validate-tasks.mjs` không | error | hook chạy `--staged` và `--no-verify` bỏ qua được nó; CI là lưới cuối cho cả hai lỗ đó |
| `tasksDir`, `repos[].path` resolve được không | error | |
| `evidenceMode` còn `legacy` | warning | Gate 4/5 nhận evidence dán tay |
| bản kernel đang chạy | in ra | từ `docs/.kernel-version` |
| không phải git repo / không có hook | warning | cả hai đều tuỳ chọn |

`/start-task` gọi nó ở step 0a.

## MCP server

Kernel không hardcode tên tool MCP (`node install.mjs --self-test` fail nếu có), nên đổi tracker hay design tool chỉ cần sửa `.mcp.json` và ProjectRules §1, file role giữ nguyên. Bốn vai trò dưới đây là những chỗ harness thật sự gọi tới; phần còn lại tuỳ project.

| Vai trò | Harness dùng ở đâu | Cần không |
| --- | --- | --- |
| tracker: ClickUp · Linear · Jira · GitHub Issues | Nguồn AC ở Gate 1 (`fsd-writer`), đọc ticket của skill `quick-task` / `fix-bug` / `pre-qc-gate`, ProjectRules §1 | Bắt buộc. Thiếu thì Gate 1 không có nguồn yêu cầu và cả chuỗi truy vết AC là tự bịa |
| git-host: GitLab · GitHub | Skill `build-and-mr` tạo MR; kiểm nhánh protected (ProjectRules §3) | Nên có. Thiếu thì skill vẫn push rồi in sẵn title và URL "new merge request" để bạn bấm |
| design: Figma | `fsd-writer` đối chiếu node/screen khi viết `01-FSD.md` | Chỉ khi task bám design. Không có UI thì xoá dòng này |
| browser: BrowserOS neo · Playwright · chrome-devtools | Gate 5: `pre-qc-gate` §4a drive app thật theo từng AC; `fix-bug` chạy repro before/after | Nên có khi có UI. Thiếu thì Gate 5 chỉ còn tầng test và mất phần chạy app thật |

Đừng thêm server cho đủ bộ. Mỗi server nối vào là một khối tool nằm trong context ở mọi lượt, kể cả lượt không dùng tới, trái với ngân sách token ở `SharedRules` §8. Filesystem/shell MCP thì thừa hẳn vì CLI đã có `Read`/`Bash`.

Sửa `.mcp.json` ở repo root (installer đã sinh sẵn khung), gõ `/mcp` trong phiên CLI để login OAuth, rồi chạy `claude mcp list` để xác nhận trước task đầu tiên:

```jsonc
{
  "mcpServers": {
    "tracker":  { "type": "http", "url": "https://mcp.clickup.com/mcp" },
    "git-host": { "type": "http", "url": "https://gitlab.example.com/api/v4/mcp" },
    "design":   { "type": "http", "url": "https://mcp.figma.com/mcp" },
    "browser":  { "command": "npx", "args": ["-y", "@playwright/mcp@latest"] }
  }
}
```

Server remote dùng `type` + `url`; server chạy local dùng `command` + `args` và không có `url`.

Ba lỗi hay gặp:

- Placeholder phải parse được. `https://<git-host>/…` làm CLI chết bằng `ERR_INVALID_URL` ngay lúc khởi động, trước khi bạn kịp sửa, vì `<` `>` không hợp lệ trong hostname. Để `example.com` cho tới khi có giá trị thật.
- `.mcp.json` là project-scoped. Commit nó thì cả team dùng chung một khai báo, không ai phải `claude mcp add` tay. Token OAuth nằm ngoài repo (`~/.claude.json`) nên không lọt vào commit.
- Khai xong phải điền ProjectRules §1. Bảng ở đó là chỗ duy nhất ghi server nào giữ vai trò nào. `/init-project-rules` đọc `.mcp.json` để điền, nên sửa `.mcp.json` trước khi chạy lệnh đó.

<details>
<summary>URL tham khảo từng vendor</summary>

Vendor đổi endpoint theo thời gian, tra doc chính thức trước khi dán.

| Server | URL |
| --- | --- |
| ClickUp | `https://mcp.clickup.com/mcp` |
| Linear | `https://mcp.linear.app/mcp` |
| Atlassian (Jira) | `https://mcp.atlassian.com/v1/sse` |
| GitHub | `https://api.githubcopilot.com/mcp/` |
| GitLab (self-hosted) | `https://<host>/api/v4/mcp` |
| Figma | `https://mcp.figma.com/mcp` |

</details>

## Độ phức tạp quyết định độ nặng của gate, không quyết định có gate hay không

Ở bootstrap, mỗi task được trích một vector 8 chiều: 6 chiều công sức (`scope`, `uncertainty`, `dependency`, `dataImpact`, `integration`, `testing`) và 2 chiều rủi ro (`blastRadius`, `reversibility`). Agent không tự chọn nhãn. Công thức ra nhãn, validator tính lại và chặn nếu lệch:

```
effort    = tổng 6 chiều công sức          (0–12)
base      = ≤2 trivial · ≤6 normal · ≥7 high
riskFloor = blastRadius≥3 hoặc reversibility≥3 → high · ≥2 → normal
taskComplexity = max(base, riskFloor)
```

`riskFloor` tách rủi ro khỏi kích thước. Bug race condition sửa một file nhưng ảnh hưởng cả service vẫn là `high`; đổi copy ở 12 file vẫn chỉ `normal`. Nhãn quyết định Gate 1/2 chạy đầy đủ hay rút gọn, tier model của từng stage, và có cần worktree không. Mức nào cũng giữ đủ stage và gate.

Lối thoát duy nhất là skill `quick-task` / `fix-bug`, và ranh giới của nó cũng do exit code quyết định:

```bash
node scripts/validate-tasks.mjs --triage '<complexity: vector+counts+questions>' --branch-type bugfix --task-id ABC-1
# fix-bug → exit 0 · harness → exit 10
```

Triage dùng lại đúng vector và `riskFloor` ở trên, không có ngưỡng thứ hai: task không phải `trivial`, hoặc có chiều rủi ro nào ≥ 2, thì đi qua harness. Ranh giới này có thể hỏng theo cả hai hướng. Lạm dụng lối thoát thì harness chỉ còn để trưng; không dám dùng thì một task đổi copy vẫn phải chạy 7 stage. Bạn vẫn bỏ qua harness được bằng `--force "<lý do>"`, và lần bỏ qua đó được ghi vào `_triage.log`. Bỏ qua là quyết định hợp lệ, miễn là để lại dấu vết.

Vẫn còn một đường vòng: vector do agent chấm, nên chấm `scope: 0` thay vì `1` là verdict thành `quick-task`. Nhãn complexity thì validator tính lại từ vector đã lưu, còn triage chạy trước khi có `task.agent.json` nên không có gì để đối chiếu. Vì vậy mọi lần triage đều vào `_triage.log`, kể cả khi không có `--force`; nếu chỉ ghi các ca đã tự khai thì sẽ sót đúng những ca cần bắt. Vector bootstrap cao hơn vector triage thì có warning nêu tên chiều bị lệch. Cách này không làm ai trung thực hơn, nhưng việc chấm thấp để né gate sẽ để lại log thay vì lọt qua im lặng, cùng mức phòng thủ mà `run-evidence.mjs` đã chọn.

`technical-planner` khảo sát code xong phải đối chiếu lại vector. Planner chỉ được nâng vector; hạ xuống để chạy nhẹ hơn là né gate.

## Vòng lặp học từ task thật

Harness ước lượng độ phức tạp trước khi làm (`complexity.vector`), đo rework trong khi làm (`attempts`, cộng 1 mỗi lần gate trả về) và ghi kết quả sau khi ship (`outcome.escapedBugs`, `reworkAfterReview`). Có ba mốc đó thì đối chiếu được:

```bash
node scripts/validate-tasks.mjs --calibrate
```

```
trivial  n=1  escaped=1  rework=0  stage-retries=1
normal   n=3  escaped=0  rework=1  stage-retries=3

findings:
• 75% of closed tasks retried "implementation" — "scope" is likely scored too low at bootstrap
• 1 bug(s) escaped from "trivial" tasks — the riskFloor thresholds are letting real risk through
```

Lệnh chỉ in bằng chứng và không tự sửa ngưỡng. Ngưỡng quyết định model, độ nặng gate và worktree; nếu harness tự viết lại luật thì không ai review luật đó. Con người đọc finding rồi sửa `Agents.md §5.1.1` bằng một commit ghi rõ lý do.

Điều kiện là phải điền `outcome` khi đóng task (validator cảnh báo nếu quên). Không điền thì không có dữ liệu để học, và ngưỡng mãi là phỏng đoán ban đầu.

Phần chi phí của câu hỏi ROI:

```bash
node scripts/validate-tasks.mjs --cost
```

```
  Instructions.md             5.7 KB
  agents/SharedRules.md      14.3 KB
  = every dispatch pays      20.0 KB

  bootstrap            + orchestrator         25.9 KB
  …
  6 stage(s) → 155.9 KB per task, before the task's own artifacts.
```

`--calibrate` trả lời "có đáng không" nhưng phải đợi task đóng. `--cost` trả lời được ngay, vì lượng luật phải đọc là file trên đĩa, không phụ thuộc kết quả chạy. Kernel phình 16% thì thấy ngay ở đây; nếu không đo, nó chỉ hiện trên hoá đơn cuối tháng và không truy được nguyên nhân. Lệnh đo bằng byte vì tokenisation khác nhau giữa các vendor và thay đổi theo phiên bản model.

### Eval adversary trước release: `--eval`

`--self-check` chỉ kiểm hình thức của 09, không biết adversary có bắt được bug hay không. `--eval` kiểm việc đó bằng 8 case trong `kernel/eval/adversary/cases.json`. Mỗi case là cùng một task đã cài sẵn một bug, hoặc không có bug để làm đối chứng PASS. Evidence trong `08` do `run-evidence.mjs` ký thật, rồi case được giao cho agent CLI thật.

```bash
node install.mjs --eval --agent 'claude -p --model sonnet --agent adversary --permission-mode bypassPermissions --strict-mcp-config'
# --strict-mcp-config: bỏ MCP user-level, nếu không thì đo máy bạn chứ không đo harness
# --case <id>  một case · --timeout <giây> (mặc định 1500) · --keep  giữ sandbox + agent.log
```

Một case được tính đúng khi thoả cả ba điều kiện: verdict khớp (đọc `status` role đã set, không có thì đọc dòng `Result`), 09 nêu đúng chỗ lỗi (`mustMention`), và role không sửa file nào ngoài task folder. Sai bất kỳ case nào thì exit 1. Eval tốn tiền model nên chỉ chạy trước release, không chạy trong CI. CI chạy `--self-test`, kiểm rằng fixture sạch ở điểm bàn giao, tên case không lộ vào sandbox, scorer báo đỏ/xanh đúng, và một agent luôn trả PASS thì bị `--eval` đánh trượt.

### Đo thời gian/token: `--bench`

Trước khi đổi thứ gì cho nhanh hơn, hãy đo. `--bench` dựng cùng sandbox với `--eval` rồi đọc số từ stream-json của agent (Claude) hoặc từ `codex exec --json` + rollout của nó (#78, OpenAI): `duration_api_ms` (wall clock vô nghĩa khi có retry 503), cost (Codex báo `$?` — proxy không trả `total_cost_usd`), turns, tool calls, token theo model, và mọi subagent đã dispatch.

```bash
# <!-- example -->  một stage (adversary, case clean), 3 lần, lấy median
node install.mjs --bench --stage adversary --runs 3 --agent 'claude -p --agent adversary --permission-mode bypassPermissions --strict-mcp-config --output-format stream-json --verbose'
# cả pipeline: repo base + /start-task trên task mẫu (benchTask trong cases.json)
node install.mjs --bench --stage full --agent 'claude -p --permission-mode bypassPermissions --strict-mcp-config --output-format stream-json --verbose'
# slice có đáng không: task 10 file (kernel/eval/sliced), S1+S2 mỗi slice 1 agent vs --unsliced 1 agent; so "peak" = context của turn lớn nhất
node install.mjs --bench --stage implementation [--unsliced] --agent 'claude -p --model sonnet --agent implementer --permission-mode bypassPermissions --strict-mcp-config --output-format stream-json --verbose'
# đo sliceBytes cho model của bạn (tự dò: nhân đôi từ 32 KB tới khi auto-compact, rồi chia đôi 2 bước) → dán vào models.<cli>.<tier>.sliceBytes
node install.mjs --bench --stage implementation --unsliced --find-slice-bytes --runs 2 --agent '…như trên, --model <model của bạn>…'
# một điểm đo tay: --pad N = N byte file có sẵn implementer phải đọc
node install.mjs --bench --stage implementation --unsliced --pad 64000 --agent '…'
# Codex: `--json` đủ (số nằm trong rollout $CODEX_HOME/sessions/**); không dùng --ephemeral
node install.mjs --bench --stage adversary --agent 'codex exec --json --model <model> --dangerously-bypass-approvals-and-sandbox -'
```

Chỉ chạy tay, không chạy trong CI. Thiếu `--agent` thì exit 2. Không có event `result` (Claude: CLI khác hoặc quên `--output-format stream-json`; Codex: `--ephemeral` không ghi rollout, hoặc chạy chưa xong) thì exit 1, không đoán số.

### Sổ sách do script làm: `--advance`, `--contract`

Trong một lần chạy thật, coordinator tốn 16/39 lượt để gõ tay validate, attempts, lease và telemetry (giờ thì bịa), còn các role grep `validate-tasks.mjs` 25 lần để đoán format. Các lệnh sau làm thay phần đó:

```bash
node scripts/validate-tasks.mjs --advance "$TASK" <stage> --cli claude   # trước mỗi dispatch: validate + renew lease + attempts + telemetry giờ máy + handoff cuối; exit 1 = dừng
node scripts/validate-tasks.mjs --bootstrap '<json>'                     # stage 1 không cần subagent: tạo folder từ _templates, validate, rollback nếu hỏng
node scripts/validate-tasks.mjs --contract <stage>                       # mọi check output của stage phải qua, sinh từ chính hằng của validator
node scripts/validate-tasks.mjs --advance <task> implementation --slice S<n>  # task lớn: 03 có cột Slice (file có sẵn > ngân sách của model: models.<cli>.<tier>.sliceBytes, không có thì sliceBytes) → mỗi slice 1 dispatch theo thứ tự, retry budget tính theo slice; slice sửa file ngoài dòng của nó → exit 1
node scripts/validate-tasks.mjs --pack <task> <stage> [--base <nhánh>]   # gói input của 1 dispatch (luật + role file + contract + artifact + handoff + git không lọc), 1 lần đọc thay vì 6-10 lần Read; vượt packCap → exit 1
```

## Vì sao có cái này

### Gate 5 pre-filter (tuỳ chọn, mặc định tắt)

`scripts/gate5-prefilter.mjs` để một decision model đọc trước state của Gate 5. Chỉ khi nó chắc chắn code sai (exit `78`) thì `--advance … adversarial_review` mới exit `1` và bỏ qua lượt adversary — tiết kiệm 54k–132k token. PASS không bao giờ được tin: đo trên 20 case, hai bug thật trả PASS ở confidence 0.78 và 0.98 vì model chỉ đọc chữ, không chạy code. Số thật: chặn 5/14 case lỗi, chặn nhầm 0/6 case sạch.

Không có `TYPESAFE_API_KEY` thì script exit `0` và harness chạy y như cũ — mọi nhánh lỗi (mất mạng, 4xx, crash, timeout 30 s) đều fail-open. Cách gắn key an toàn (Keychain / file 0600 / CI secret, không bao giờ để trong repo hay `.env`): [`adapters/gate5-prefilter/README.md`](../adapters/gate5-prefilter/README.md).

Nó nằm ở `adapters/`, không phải kernel: kernel chỉ biết "một script tên cố định trả exit code", không biết tên vendor, key hay endpoint. Xoá file đi thì mọi gate hoạt động như trước.

Gate viết bằng chữ ("agent phải chạy test trước khi báo xong") thì model có thể chọn không tuân thủ. Gate bằng exit code thì không cho chọn. Harness gốc mất một thời gian mới học được điều đó. Phần đắt nhất ở đây là `validate-tasks.mjs` và chuỗi truy vết AC; mấy file markdown rẻ hơn nhiều.

Những thứ validator bắt mà con người hay bỏ sót:

- AC rơi giữa đường: `AC-04` có trong review nhưng không ai đưa vào plan. Lỗi này bị bắt ngay tại Gate 3 chứ không đợi tới review, vì mỗi đích trong `acTrace.reachedIn` được kiểm khi stage của nó tới. Implementer không phải code xong mới biết plan thiếu AC.
- Evidence giả: `08` viết "mọi thứ đều pass" nhưng không có lệnh nào được chạy. Ở `evidenceMode: "attested"`, evidence phải do `run-evidence.mjs` sinh, và `outputHash` gắn attestation với đúng output đi kèm. Chép khối từ task khác hay sửa output sau khi chạy đều làm lệch hash. Phải có cả lệnh lẫn kết quả, và kết quả phải nằm trong code fence; chữ "passed" ở ô Expected của bảng chỉ là kế hoạch.
- Không có AC nào: task đi qua `fsd_review` mà `02` không khai AC nào thì cả chuỗi truy vết vô nghĩa.
- Gate 5 rỗng ruột: có file `09` thôi chưa đủ. File phải có verdict và output do adversary tự chạy, không chép từ `08`.
- Template chưa điền: bản copy nguyên khuôn không được thoả mãn traceability. Vì vậy placeholder dùng `AC-nn`, và self-check có regression test cho đúng trường hợp này.
- Handoff rỗng: role báo `done` mà không để lại `Next agent`/`Continue automation`. Coordinator route bằng đúng hai trường đó.
- Nhảy cóc gate: `status = reviewing` khi `currentStage` còn ở giữa chừng, hoặc còn role chưa kết thúc.
- Câu hỏi BA bị bỏ quên: `Q-01 | blocking | open` mà task đã đi qua `fsd_review`.
- Nhãn độ phức tạp không khớp vector: chấm vector nhẹ rồi khai `high` (hoặc ngược lại) để đổi tier model.

Validator không có dependency (Node 22+), chạy được từ pre-commit, CI hoặc bằng tay. Nó có `--self-check` riêng với assert cho từng predicate, gồm cả ca âm: lịch sử sạch không được sinh ra finding, và template chưa điền không được thoả mãn gate nào.

CI là bắt buộc: preflight báo đỏ nếu không workflow nào chạy validator. Pre-commit chạy `--staged`, chỉ kiểm task folder mà commit đó chạm tới, nên nó không thấy task hỏng ở chỗ khác. Đo thật: làm hỏng task A, commit file B thì commit đi qua, còn CI trên cùng cây báo 5 error. Đây là đánh đổi có chủ ý, và CI là lưới cuối. Một task đang `blocked` chờ BA là trạng thái hợp lệ. Nếu nó chặn mọi commit không liên quan, cả team sẽ quen gõ `--no-verify`, và gate bị bypass theo phản xạ thì coi như mất. CI vẫn quét toàn repo.

Ngoài validator còn một lớp nữa: `.claude/settings.json` deny sẵn `git reset --hard`, `git stash`, `git clean`, cùng `cat .env` / `env` / `printenv` / `Read(.env)`. `git push` nằm ở `permissions.ask`: dừng hỏi user sau khi gate cuối qua, không deny cứng. Luật "đừng phá working tree" viết trong prompt thì model có thể bỏ qua; deny ở tầng permission thì không, cùng lý do harness chọn exit code. Preflight nêu tên rule nào thiếu.

> Lớp này không phải sandbox. Deny khớp theo tool cộng tiền tố lệnh. Trước đây chỉ có `Read(.env)`: nó chặn tool Read, nhưng agent còn Bash, và `cat .env` đi thẳng qua. Bốn rule trên giảm xác suất tai nạn chứ không chặn được hết: `python3 -c "print(open('.env').read())"` vẫn lọt, và không danh sách deny nào theo kịp mọi cách đọc một file. Bảo vệ thật là không để secret trong repo; deny-list chỉ là lớp phụ.

## Giới hạn đã biết

Guard trên mọi CLI (`--guard <cli>`) chỉ khớp prefix lệnh, giống giới hạn của `permissions.deny` trên Claude. `bash -c "git push"`, `git -C x push`, `python -c "open('.env')"` vẫn lọt. Nó chặn tai nạn, không chặn người cố ý. Trên CLI không có subagent, 7 role chạy tuần tự trong cùng context, nên Gate 5 (adversary) không còn độc lập với implementer; 4 gate chặn bằng exit code thì vẫn giữ nguyên.

Lease chỉ đúng trên filesystem cục bộ. `scripts/lease.mjs` chặn hai phiên `/start-task` cùng chạy một task bằng `mkdir` (loại trừ) và `mtime` (TTL 30 phút). Trên NFS/SMB cả hai đều hỏng: `mkdir` không đảm bảo nguyên tử, và server đóng dấu `mtime` bằng đồng hồ của nó. Hai máy lệch giờ sẽ đọc một lease còn sống thành hết hạn rồi chiếm, và hai phiên ghi đè handoff của nhau. Để `docs/tasks/` trên ổ mạng thì lease này không có tác dụng. Không có cách vá rẻ: sửa đúng nghĩa là đổi cơ chế (lock server, hoặc trao token có fsync), và cũng không có cách nào đủ tin cậy để phát hiện mình đang chạy trên FS mạng mà cảnh báo.

Overhead đọc luật được đo bằng `node scripts/validate-tasks.mjs --cost`. Mỗi dispatch phải đọc `Instructions.md`, `SharedRules.md` và file role trước khi làm gì khác; 6 stage tốn tối thiểu khoảng 156 KB/task, chưa tính artifact của chính task. Lệnh in bảng theo stage và so được giữa hai bản kernel. Lệnh cố ý đo bằng byte vì tokenisation khác nhau theo vendor và thay đổi theo phiên bản model. Một con số token trông chính xác mà lệch 30% còn tệ hơn một tỉ lệ byte mà không ai nhầm là hoá đơn.

Token thật thì script tự thu:

```bash
node scripts/collect-telemetry.mjs docs/tasks/sprint-1/ABC-1-x --write
```

Mỗi bên ghi phần mình biết chắc. Coordinator ghi `startedAt`/`endedAt` vì nó là bên dispatch. Script đọc session log của CLI và điền token, khớp theo `cwd`, branch và khoảng thời gian đó. Trước đây coordinator phải tự gõ số token mà nó không biết, nên nó bỏ trống hoặc bịa. Một con số bịa tệ hơn không có số, vì `--cost` sẽ in nó ra như số thật.

`inputTokens` và `cacheReadTokens` được giữ riêng, không cộng. Cache read tính tiền khoảng 1/10, và trong phiên thật nhiều gấp khoảng 80 lần input mới (đo được 866k so với 66M). Gộp thành một số thì sai hai bậc độ lớn mà vẫn trông hợp lý.

Format `.jsonl` là nội bộ của CLI và có thể đổi mà không báo, nên script phân biệt các kiểu hỏng:

| Tình huống | Hành vi |
|---|---|
| Không phải Claude Code | thoát 0, không ghi gì: workflow chưa từng có dữ liệu này thì không tính là hỏng. Trỏ chỗ khác bằng `SPEC_HARNESS_SESSION_LOG`; có env mà đường dẫn không tồn tại thì exit 1 (bạn đã chỉ chỗ, và file không có ở đó) |
| Log có, parse ra rỗng | exit 1 |
| Log có, `usage` có, nhưng tên field đã đổi | exit 1, in ra tên field thật. Đây là ca nguy hiểm nhất: mọi lookup trả 0, window vẫn khớp, và 0 được ghi xuống như chi phí thật |
| Không khớp window | không ghi, và đếm riêng số dòng bị loại theo từng điều kiện (window / cwd / branch) kèm tên branch có trong log. Chỉ in "0 matched" thì người đọc phải đoán là sai giờ, sai repo hay sai branch |

Script chỉ mở file có `mtime` sau lần dispatch sớm nhất. Session log là append-only, nên file không được ghi từ trước thời điểm đó thì không thể chứa dữ liệu liên quan. Đo trên máy thật: 641 MB / 538 file, bỏ qua 533 file, thời gian giảm từ 2.5s xuống 0.08s.

Tracker write-back mặc định tắt, bật bằng `tracker.writeBack` trong config: `off` (mặc định, chỉ báo cáo), `comment` (đăng comment lên ticket gồm đường dẫn task doc, branch và chỗ chứa evidence), hoặc `status` (comment và chuyển ticket sang `tracker.statusOnReview`). Coordinator gọi qua MCP server `tracker` chứ không qua API vendor. ClickUp, Jira và Linear khác nhau cả mô hình status lẫn auth, nên một client viết ở đây sẽ không ai test được ngoài tracker của chính maintainer.

Khi đã bật, coordinator phải chứng minh đã làm bằng cách ghi `trackerWriteBack` vào `task.agent.json` sau khi MCP trả về. Validator cảnh báo khi `writeBack` bật mà field đó vắng, vì một setting trông như đang bật mà không làm gì chính là kiểu lỗi validator được viết ra để bắt. `writeBack: "status"` mà thiếu `statusOnReview` thì `--self-check`/`--preflight` báo đỏ ngay.

## Ghi chú cài đặt

<details>
<summary>Biến thể lệnh cài, ghi đè file, git init, phát hành</summary>

```bash
npx spec-harness@0.1.0                                      # ghim version
npx spec-harness@latest                                     # nâng cấp (bỏ qua bản cũ trong node_modules/cache)
npx spec-harness --yes                                      # không hỏi (CI, script)
npx spec-harness ./harness                                  # cài vào thư mục khác (phải tồn tại sẵn)
yarn dlx spec-harness / pnpm dlx spec-harness / bunx spec-harness   # cùng installer, khác runner
git clone --depth 1 <url> /tmp/sh && node /tmp/sh/install.mjs   # repo private
```

Installer viết bằng Node nên chạy giống nhau trên PowerShell, cmd, bash, zsh và WSL. Validator vốn đã cần Node 22+, nên đây không phải phụ thuộc thêm.

`npx` tải tarball từ npm vào cache rồi chạy `install.mjs` (khai báo ở `bin`), không để lại bản clone trong project. Chạy riêng `install.mjs` không qua npm thì nó tự tải tarball từ GitHub, ref ghim bằng `SPEC_HARNESS_REF=v0.1.0`.

Installer sinh ra `docs/`, `scripts/`, `hooks/`, `.claude/agents/` (7 subagent), `.claude/commands/`, `.claude/skills/`, CI workflow (`.github/workflows/` hoặc `.gitlab-ci.yml`, tuỳ remote), `.mcp.json`, `.claude/settings.json` (deny-list các lệnh phá working tree, cài một lần, không đè), và `docs/.kernel-version` (bản kernel đang chạy, `--preflight` in ra để sau khi nâng bạn biết mình đang ở bản nào).

Ghi đè: harness cài lên repo đang có, nên file trùng tên bị kernel ghi đè, thường gặp nhất là `docs/README.md`, ngoài ra có `scripts/validate-tasks.mjs` và `hooks/pre-commit`. Nếu thư mục đích không rỗng, installer liệt kê đúng những file sắp đè và hỏi `[y/N]` trước khi ghi. Trả lời khác `y` thì thoát mà không đụng gì. Không có TTY (CI, pipe) thì nó dừng hẳn chứ không tự đồng ý; thêm `--yes` để bỏ qua bước hỏi. Bản cũ vẫn còn trong git (`git checkout -- <file>` để lấy lại). File không trùng tên trong `docs/` không bị đụng.

Chạy lại được: kernel bị ghi đè, còn `harness.config.json`, `ProjectRules.md`, `start-task.md` và `.mcp.json` đã sửa thì giữ nguyên, nên nâng kernel không mất adapter. Nâng cấp chỉ cần `npx spec-harness@latest`, không phải chạy lại `/init-project-rules`.

Có cần `git init` không? Không bắt buộc. Harness cài được vào thư mục thường, validator vẫn chạy, `--self-check` vẫn xanh. Nhưng thiếu git thì mất ba thứ:

| Mất | Hệ quả |
| --- | --- |
| Hook pre-commit | Gate không chạy lúc commit; phải nhớ gọi validator bằng tay |
| CI | Workflow được cài nhưng không có repo để push nên không bao giờ chạy |
| Lịch sử task doc | Task doc được thiết kế append-only; không có git thì không tra ngược được ai sửa gì, lúc nào |

Trường hợp A luôn có git sẵn. Trường hợp B thì rất nên `git init`, vì task doc và evidence gần như là toàn bộ nội dung của repo đó.

Gate chạy ở hai chỗ, trong đó pre-commit là tuỳ chọn. CI là chỗ `git commit --no-verify` không bỏ qua được. Installer đọc `git remote get-url origin` để cài đúng loại: remote GitLab thì `.gitlab-ci.yml`, còn lại thì `.github/workflows/spec-harness.yml`. Nó không cài cả hai, vì `.github/workflows/` trong repo GitLab là lưới giả: preflight thấy file nên không báo, còn CI thì không bao giờ chạy nó. Preflight nhận cả hai loại file khi kiểm. Hook pre-commit chỉ giúp biết lỗi sớm hơn. Repo sạch thì installer tự cắm hook (tôn trọng `core.hooksPath` của husky/lefthook). Project đã có hook riêng hoặc thư mục không phải git repo thì vẫn cài bình thường, chỉ in một dòng ghi chú.

`.claude/commands/start-task.md` thuộc adapter chứ không thuộc kernel: step 2 dựng worktree theo công thức nhánh ở ProjectRules §3. Đọc lại file này nếu project bạn theo quy ước khác.

`docs/srs/`, `docs/fsd/`, `docs/api/` cài ra rỗng, chỉ có README làm mục lục. Project tự đổ nội dung, hoặc xoá nếu không dùng; kernel chỉ trỏ tới chứ không bắt buộc có file.

Phát hành phiên bản mới (chỉ maintainer): `npm version patch && git push --follow-tags`. Workflow `.github/workflows/publish.yml` bắt tag `v*`, kiểm tag khớp `package.json`, chạy self-test rồi `npm publish`. Không cần `NPM_TOKEN` vì dùng Trusted Publishing (OIDC): npm đổi token trực tiếp với GitHub nên không có secret nào để rò, và 2FA không hỏi OTP. Bật một lần ở npmjs.com → package → Settings → Trusted Publisher.

</details>
