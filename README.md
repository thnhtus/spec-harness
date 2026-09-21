# spec-harness

Spec-driven agent harness, tách từ một harness đã chạy thật **240 task / 17 sprint** trên một codebase production.

7 role · 5 gate · mọi AC truy vết được từ spec tới test evidence — và gate được enforce bằng **exit code**, không phải bằng lời nhắc trong prompt.

Hai thứ khiến nó khác một bộ prompt có tổ chức:

- **Gate 5 là agent đối kháng.** Gate 1–4 do chính người làm tự chấm. Nên có thêm một role mặc định FAIL: tự chạy lại lệnh thay vì tin `08-Test-Evidence.md`, đọc `git diff` thật thay vì đọc mô tả diff, và hỏi "đổi hằng số thì test có đỏ không".
- **Harness học từ task đã đóng.** Độ phức tạp ước lượng trước, rework đo trong lúc làm, kết quả ghi sau khi ship — `--calibrate` đối chiếu ba mốc đó và chỉ ra ngưỡng nào đang sai.

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

Kernel không biết project dùng stack nào, tracker nào, đặt tên nhánh ra sao. Bốn mục đó — và chỉ bốn mục đó — nằm ở `ProjectRules.md`. Số mục giữ nguyên **1/2/3/7** để mọi tham chiếu chéo `SharedRules §n` trong kernel vẫn trỏ đúng.

Kernel cũng không gắn với một CLI: file role không khai `model:`, không hardcode tên tool MCP. Đổi Claude Code ↔ Codex ↔ Gemini thì sửa `models` trong config, không đụng kernel.

## Cài vào project mới

Chọn một trong hai trường hợp — khác nhau ở chỗ `harness.config.json` nằm đâu, kéo theo task docs nằm đâu.

`install.mjs` nhận **một tham số: thư mục đích** — nơi harness được cài vào. Thư mục đó phải tồn tại; git repo thì tốt hơn nhưng không bắt buộc (xem ghi chú cuối mục). Ví dụ dưới dùng repo tên `my-app`; thay bằng đường dẫn thật của bạn.

### Trường hợp A — cài **vào trong** repo code

Một repo (FE hoặc BE), task docs nằm cùng chỗ với code. Đây là mặc định.

```bash
cd ~/code/my-app          # ← repo code của bạn, đứng sẵn ở đây

npx spec-harness .

# ghim version:  npx spec-harness@0.1.0 .
# repo private:  git clone --depth 1 <url> /tmp/sh && node /tmp/sh/install.mjs .
```

Installer viết bằng **Node**, không phải bash — chạy y hệt nhau từ PowerShell, cmd, bash, zsh, WSL. Node 20+ vốn đã bắt buộc (validator cần nó), nên đây không phải phụ thuộc thêm.

Dấu `.` cuối là thư mục đích = repo bạn đang đứng. Task docs vào `my-app/docs/tasks/`, commit chung với code. `repos` sẽ là `[{ path: "." }]`.

Mở CLI ngay tại repo root là xong — `.claude/` nằm sẵn ở đó. Thư mục con (`packages/web/`) và worktree do `/start-task` tạo đều thấy được, vì CLI quét ngược lên cha và `.claude/` được commit vào git. **Đừng thêm `.claude/` vào `.gitignore`** — worktree sẽ rỗng và `/start-task` mất skills giữa chừng. Lệnh `node scripts/validate-tasks.mjs` chạy từ repo root.

Harness cài **đè lên** repo đang có, nên file trùng tên bị kernel ghi đè: `docs/README.md` (thường gặp nhất), `scripts/validate-tasks.mjs`, `hooks/pre-commit`. Installer liệt kê ra những file nó vừa đè; bản cũ còn trong git (`git diff`, `git checkout -- <file>` để lấy lại). File không trùng tên trong `docs/` không bị đụng.

### Trường hợp B — cài **cạnh** các repo code

Nhiều repo (FE + BE), hoặc muốn task docs tách khỏi code. Harness đứng riêng ngang hàng — **tự tạo thư mục trước**, vì nó chưa tồn tại:

```bash
cd ~/code/my-workspace    # ← thư mục đang chứa fe/ và be/
mkdir harness && cd harness
git init                  # tuỳ chọn — xem "Có cần git init không?" bên dưới

npx spec-harness .
```

```
my-workspace/
├── harness/     ← vừa tạo, cài vào đây; task docs, spec, evidence
├── fe/          ← code, không bị đụng
└── be/          ← code, không bị đụng
```

Task docs ở `harness/docs/tasks/`, code ở `fe/` + `be/`. `repos` trỏ `../fe`, `../be`. Commit task doc và commit code là **hai repo, hai lần commit**.

**Mở CLI trong `harness/`, không phải `my-workspace/`.** CLI chỉ đọc `.claude/` ở cwd và các thư mục *cha* — không quét xuống con. Mở ở `my-workspace/` thì `harness/.claude/` vô hình: mất skills, mất `/start-task`, và mất cả deny `git push` / `git reset --hard`. Từ trong `harness/` vẫn sửa được repo anh em bằng `/add-dir ../fe ../be`.

`--add-dir harness` từ thư mục cha **không** thay thế được: nó nạp skills và commands nhưng bỏ qua `settings.json`, nên guardrail biến mất trong im lặng — hỏng mà trông như chạy được. Installer đặt sẵn một `CLAUDE.md` cảnh báo ở thư mục cha để bắt lỗi nếu bạn lỡ mở nhầm (có `CLAUDE.md` rồi thì không đè).

#### Vẫn muốn mở CLI ở `my-workspace/`?

Symlink **sáu** thứ lên cha — không chỉ `.claude`. Nạp và chạy là hai chuyện khác nhau: `.claude` lo phần nạp (skills, commands, `settings.json`), bốn cái còn lại lo phần chạy, vì `/start-task` gọi `node scripts/lease.mjs` và `docs/tasks/...` bằng **đường dẫn tương đối tính từ cwd**:

```bash
cd ~/code/my-workspace
for x in .claude .mcp.json scripts docs harness.config.json hooks; do ln -s harness/$x $x; done
```

Thiếu `scripts/` thì `/start-task` chết ở step 0b (`Cannot find module .../scripts/lease.mjs`) — nạp xong vẫn không chạy được.

File thật vẫn nằm trong `harness/`: lease, task folder, evidence đều ghi xuyên symlink về đó, nên vẫn commit chung với task docs và nâng kernel không phải làm lại. Installer thấy `.claude` ở cha thì tự gỡ biển báo cảnh báo.

Đã kiểm end-to-end ở bố cục này: `/start-task` qua được step 0b + step 1, `task.agent.json` và `.lease.d/owner` nằm đúng trong `harness/docs/tasks/`, thư mục cha không có file rác, `git worktree add` vào `../fe` chạy bình thường.

Đổi lại: `fe/` và `be/` giờ nằm trong cwd, agent chạm được mà không cần `/add-dir` — tiện hơn, nhưng mất một lớp chặn tay nhầm.

Windows: `ln -s` cần Developer Mode hoặc admin. Không bật được thì dùng `mklink /D` trong cmd (admin), hoặc mở CLI trong `harness/` như mặc định.

### Sau khi cài — bắt buộc chạy `/init-project-rules`

Installer chỉ chép file. Nó **không** biết project bạn dùng stack gì, tracker nào, nhánh đặt tên ra sao — nên `harness.config.json` và `docs/agents/ProjectRules.md` cài ra là **khung rỗng**. Chạy task lúc này thì gate không có gì để kiểm.

Mở CLI agent trong thư mục vừa cài rồi gõ:

```
/init-project-rules
```

Nó dò repo (`.mcp.json`, manifest package, `git branch`, CI workflow, `CLAUDE.md`, repo anh em), hỏi đúng phần không dò được, rồi điền:

| Điền vào | Gì |
| --- | --- |
| `docs/agents/ProjectRules.md` | §1 nguồn truth MCP · §2 guardrail source · §3 quy tắc nhánh · §7 lệnh kiểm tra |
| `harness.config.json` | `repos`, `layers`, `models`, `evidenceCommandPattern` + `evidenceSampleCommand` |

Rồi tự chạy `node scripts/validate-tasks.mjs --self-check` để xác nhận config không tự mâu thuẫn.

**Còn hai việc tay nó không làm được:**

| File | Vì sao phải tự làm |
| --- | --- |
| `.mcp.json` | URL server và OAuth là thứ chỉ bạn có. Sửa URL rồi gõ `/mcp` để login. Project-scoped, commit được cho cả team |
| `acTrace.since` trong `harness.config.json` | Đặt = ngày bạn bật harness. Task cũ hơn mốc này chỉ warning, không chặn — nếu không thì mọi task có sẵn đều đỏ |

Xong hết thì `node scripts/validate-tasks.mjs --preflight` phải xanh **trước task đầu tiên**. Chưa xanh thì gate im lặng no-op và bạn chỉ phát hiện sau vài chục task.

`--preflight` = `--self-check` (config có tự mâu thuẫn không) **cộng** ba thứ self-check không nhìn thấy vì chúng nằm ngoài file config: `.claude/settings.json` có thực sự được nạp từ cwd hiện tại không (bẫy bố cục B ở trên — CLI chỉ quét **ngược lên**, nên mở ở thư mục cha là mất guardrail trong im lặng), `tasksDir` và `repos[].path` có resolve được không. Thiếu git / hook / CI chỉ là warning — README nói rõ cả ba đều tuỳ chọn. `/start-task` gọi nó ở step 0a.

### MCP server nên dùng

Kernel **không** hardcode tên tool MCP (`node install.mjs --self-test` fail nếu có) — nên đổi tracker hay design tool chỉ là sửa `.mcp.json` + ProjectRules §1, không đụng file role. Bốn vai trò dưới đây là những chỗ harness thật sự gọi tới; phần còn lại là tuỳ project.

| Vai trò | Harness dùng ở đâu | Cần không |
| --- | --- | --- |
| **tracker** — ClickUp · Linear · Jira · GitHub Issues | Nguồn AC ở Gate 1 (`fsd-writer`), đọc ticket của skill `quick-task` / `fix-bug` / `pre-qc-gate`, ProjectRules §1 | **Bắt buộc.** Thiếu thì Gate 1 không có nguồn yêu cầu và cả chuỗi truy vết AC là tự bịa |
| **git-host** — GitLab · GitHub | Skill `build-and-mr` tạo MR; kiểm nhánh protected (ProjectRules §3) | Nên có. Thiếu thì skill vẫn push rồi in sẵn title + URL "new merge request" để bạn bấm một phát |
| **design** — Figma | `fsd-writer` đối chiếu node/screen khi viết `01-FSD.md` | Chỉ khi task bám design. Không có UI thì xoá dòng này |
| **browser** — BrowserOS neo · Playwright · chrome-devtools | Gate 5: `pre-qc-gate` §4a drive app thật theo từng AC; `fix-bug` chạy repro before/after | Nên có **khi có UI**. Thiếu thì Gate 5 chỉ còn tầng test — mất đúng phần "chạy thật" |

**Đừng thêm cho đủ.** Mỗi server nối vào là một khối tool nằm trong context **mọi lượt**, kể cả lượt không dùng tới nó — ngược với ngân sách token ở `SharedRules` §8. Filesystem/shell MCP thì thừa hẳn: CLI đã có `Read`/`Bash`.

#### Cài

Sửa `.mcp.json` ở repo root (installer đã sinh sẵn khung):

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

Server remote dùng `type` + `url`; server chạy local dùng `command` + `args` (**không** có `url`). URL tham khảo — vendor đổi endpoint theo thời gian, tra doc chính thức trước khi dán:

| Server | URL |
| --- | --- |
| ClickUp | `https://mcp.clickup.com/mcp` |
| Linear | `https://mcp.linear.app/mcp` |
| Atlassian (Jira) | `https://mcp.atlassian.com/v1/sse` |
| GitHub | `https://api.githubcopilot.com/mcp/` |
| GitLab (self-hosted) | `https://<host>/api/v4/mcp` |
| Figma | `https://mcp.figma.com/mcp` |

Rồi trong phiên CLI:

```
/mcp                  # login OAuth từng server
```

```bash
claude mcp list       # xác nhận server đã connect trước task đầu tiên
```

Ba thứ hay sai:

- **Placeholder phải parse được.** `https://<git-host>/…` làm CLI chết bằng `ERR_INVALID_URL` **ngay lúc khởi động** — trước cả khi bạn kịp sửa, vì `<` `>` không hợp lệ trong hostname. Để `example.com` cho tới khi có giá trị thật.
- **`.mcp.json` là project-scoped** — commit nó thì cả team dùng chung một khai báo, không ai phải `claude mcp add` tay. Token OAuth nằm ngoài repo (`~/.claude.json`), không lọt vào commit.
- **Khai xong phải điền ProjectRules §1.** Bảng ở đó là chỗ duy nhất nói server nào giữ vai trò nào; `/init-project-rules` đọc `.mcp.json` để điền, nên sửa `.mcp.json` **trước** khi chạy lệnh đó.

### Ghi chú cài đặt

`npx` tải tarball từ npm vào cache rồi chạy `install.mjs` (khai báo ở `bin`) — không để lại bản clone trong project. Ghim phiên bản bằng `npx spec-harness@0.1.0`. Chạy `install.mjs` đơn lẻ (không qua npm) thì nó tự tải tarball từ GitHub, ref ghim bằng `SPEC_HARNESS_REF=v0.1.0`.

Sinh `docs/`, `scripts/`, `hooks/`, `.claude/agents/` (7 subagent), `.claude/commands/`, `.claude/skills/`, `.github/workflows/`, `.mcp.json`, và `.claude/settings.json` (deny-list lệnh phá working tree — cài một lần, không đè).

**Chạy lại được.** Kernel ghi đè, còn `harness.config.json` / `ProjectRules.md` / `start-task.md` / `.mcp.json` đã sửa thì **giữ nguyên** — nâng kernel không mất adapter. Nên nâng cấp chỉ cần chạy lại `install.mjs`, không phải chạy lại `/init-project-rules`.

**Có cần `git init` không?** Không bắt buộc — harness cài được vào thư mục thường, validator vẫn chạy, `--self-check` vẫn xanh. Nhưng thiếu git thì mất ba thứ:

| Mất | Vì sao đáng tiếc |
| --- | --- |
| Hook pre-commit | Gate không chạy lúc commit; phải nhớ gọi validator bằng tay |
| CI | Workflow được cài nhưng không có repo để push → không bao giờ chạy |
| Lịch sử task doc | Task doc là append-only theo thiết kế; không có git thì không tra ngược được ai sửa gì, lúc nào |

Trường hợp A luôn có git sẵn (nó là repo code của bạn). Trường hợp B thì `git init` là khuyến nghị mạnh — task doc và evidence là thứ đáng có lịch sử, đó gần như là toàn bộ nội dung của repo đó. Không init thì installer vẫn cài và in một dòng ghi chú.

**Gate chạy ở hai chỗ, pre-commit là tuỳ chọn.** CI (`.github/workflows/spec-harness.yml`) là chỗ `git commit --no-verify` không với tới. Hook pre-commit chỉ để biết sớm hơn: repo sạch thì installer tự cắm (tôn trọng `core.hooksPath` của husky/lefthook); project đã có hook riêng, hoặc thư mục không phải git repo → vẫn cài bình thường, chỉ in một dòng ghi chú.

`.claude/commands/start-task.md` là adapter, không phải kernel: step 2 dựng worktree theo công thức nhánh của ProjectRules §3 — đọc lại nếu project bạn khác quy ước.

### Ba bố cục repo

`repos` khai repo mà agent được sửa, `path` tính từ chỗ đặt `harness.config.json`:

| Bố cục | `repos` | Task docs | Worktree |
| --- | --- | --- | --- |
| Harness trong repo code | `[{ path: "." }]` | cùng repo | worktree của chính repo đó |
| Trong repo FE, đọc BE anh em | `[{ path: "." }, { path: "../be" }]` | repo chính | như trên; BE read-only |
| Harness ngang hàng FE + BE | `[{ path: "../fe" }, { path: "../be" }]` | **repo harness** | worktree trong repo đang sửa; task doc ở lại |

`repoName` của task chỉ một entry — đó là repo được sửa; repo khác trong `repos` là **read-only** (vd đọc DTO của BE để lấy contract); repo không khai thì không đụng. Sai tên → validator chặn. Chi tiết: `docs/Agents.md` §0.

`docs/srs/`, `docs/fsd/`, `docs/api/` cài ra là **rỗng** (chỉ có README làm mục lục). Project tự đổ nội dung, hoặc xoá nếu không dùng — kernel chỉ trỏ tới, không bắt buộc có file.

`--self-check` kiểm tra chính config: stage/routing/artifact có nhất quán không, `evidenceSampleCommand` có thật sự khớp `evidenceCommandPattern` không, `acTrace.reachedIn[].fromStage` có tồn tại trong `stages` không. Sai một chỗ thì mọi gate sau đó im lặng no-op — nên nó fail sớm thay vì để bạn phát hiện sau 50 task.

## Độ phức tạp quyết định độ nặng, không quyết định có gate hay không

Mỗi task được trích một **vector 8 chiều** ở bootstrap: 6 chiều công sức (`scope`, `uncertainty`, `dependency`, `dataImpact`, `integration`, `testing`) + 2 chiều rủi ro (`blastRadius`, `reversibility`). Agent **không tự phán nhãn** — công thức ra nhãn, validator tính lại và chặn nếu lệch:

```
effort    = tổng 6 chiều công sức          (0–12)
base      = ≤2 trivial · ≤6 normal · ≥7 high
riskFloor = blastRadius≥3 hoặc reversibility≥3 → high · ≥2 → normal
taskComplexity = max(base, riskFloor)
```

`riskFloor` tách rủi ro khỏi kích thước: bug race condition sửa một file nhưng lan cả service vẫn là `high`; đổi copy ở 12 file vẫn chỉ `normal`. Nhãn đó quyết định ba thứ — Gate 1/2 chạy đầy hay ngắn, tier model mỗi stage, và có cần worktree không. **Không mức nào bỏ được stage hay gate.**

Có một lối thoát — skill `quick-task` / `fix-bug` — và ranh giới của nó cũng là exit code, không phải cảm giác "task này nhỏ":

```bash
node scripts/validate-tasks.mjs --triage '<vector>' --branch-type bugfix --task-id ABC-1
# fix-bug → exit 0 · harness → exit 10
```

Dùng lại đúng vector và đúng `riskFloor` ở trên, không phát minh ngưỡng thứ hai: không `trivial`, hoặc bất kỳ chiều rủi ro nào ≥ 2 → ra harness. Ranh giới này hỏng được **cả hai chiều**: lạm dụng lối thoát thì harness thành cảnh trí, không dám dùng thì một task đổi copy vẫn ăn 7 stage. Bỏ qua harness vẫn được (`--force "<lý do>"`) — nhưng ghi vào `_triage.log`: bỏ qua là quyết định hợp lệ, bỏ qua không dấu vết thì không.

Vẫn còn một đường vòng: vector do agent chấm, nên chấm `scope: 0` thay vì `1` là verdict thành `quick-task`. Khác với nhãn complexity (validator tính lại từ vector đã lưu), triage chạy **trước** khi có `task.agent.json` nên không có gì để đối chiếu. Nên **mọi** lần triage đều vào `_triage.log` (không chỉ lúc `--force` — ghi mỗi ca đã thú nhận thì bỏ sót đúng ca cần bắt), và vector bootstrap cao hơn vector triage → warning nêu đích danh chiều nào. Nó không làm ai trung thực hơn; nó chuyển việc chấm thấp để né gate từ "lọt" thành "có log" — cùng mức phòng thủ `run-evidence.mjs` đã chọn.

`technical-planner` khảo sát code xong phải đối chiếu lại vector. Chỉ được **nâng** — hạ để chạy nhẹ đi là né gate.

## Vòng lặp học từ task thật

Harness ước lượng độ phức tạp **trước** khi làm (`complexity.vector`), đo rework **trong** khi làm (`attempts` — mỗi lần gate trả về là +1), và ghi kết quả **sau** khi ship (`outcome.escapedBugs`, `reworkAfterReview`). Ba mốc đó cho phép đối chiếu:

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

Nó **in bằng chứng, không tự sửa ngưỡng**. Ngưỡng quyết định model, độ nặng gate, worktree — một luật harness âm thầm viết lại là luật không ai review. Con người đọc finding rồi sửa `Agents.md §5.1.1` bằng một commit có lý do ghi lại.

Điều kiện: điền `outcome` khi đóng task (validator cảnh báo nếu quên). Bỏ qua thì không có gì để học, và ngưỡng mãi là phỏng đoán ban đầu.

## Vì sao có cái này

Gate bằng văn bản ("agent phải chạy test trước khi báo xong") là gate mà model **chọn** tuân thủ. Gate bằng exit code thì không có chỗ để chọn. Harness gốc mất một thời gian mới học được điều đó; phần đắt nhất ở đây là `validate-tasks.mjs` + chuỗi truy vết AC, không phải mấy file markdown.

Những thứ validator bắt mà con người hay bỏ sót:

- **AC rơi giữa đường** — `AC-04` có trong review nhưng không ai đưa vào plan. Bắt **tại Gate 3**, không đợi tới lúc review: mỗi đích trong `acTrace.reachedIn` kiểm ngay khi stage của nó tới, nên implementer không code xong rồi mới biết plan thiếu AC.
- **Evidence giả** — `08` viết "mọi thứ đều pass" nhưng không có lệnh nào được chạy. Phải có **cả** lệnh **và** kết quả, và kết quả phải nằm **trong code fence**: chữ "passed" ở ô *Expected* của bảng là kế hoạch, không phải bằng chứng.
- **Không có AC nào** — task đi qua `fsd_review` mà `02` không khai AC nào thì cả chuỗi truy vết thành vô nghĩa. Bắt ngay, thay vì để một task rỗng đi thẳng tới `reviewing`.
- **Gate 5 rỗng ruột** — `09` tồn tại là chưa đủ: phải có verdict và output **adversary tự chạy**, không phải bản chép từ `08`.
- **Template chưa điền** — bản copy nguyên khuôn không được phép thoả mãn traceability (đó là lý do placeholder dùng `AC-nn`, và self-check có regression test cho đúng điều này).
- **Handoff rỗng** — role báo `done` mà không để lại `Next agent`/`Continue automation`; coordinator route bằng đúng hai trường đó.
- **Nhảy cóc gate** — `status = reviewing` khi `currentStage` còn ở giữa chừng, hoặc còn role chưa kết thúc.
- **Câu hỏi BA bị bỏ quên** — `Q-01 | blocking | open` mà task đã đi qua `fsd_review`.
- **Nhãn độ phức tạp không khớp vector** — chấm vector nhẹ rồi khai `high` (hoặc ngược lại) để đổi tier model.

Validator dependency-free (Node 20+), chạy từ pre-commit, CI, hoặc tay. Chính nó cũng có `--self-check`: assert cho từng predicate, gồm cả ca âm — lịch sử sạch **không** được bịa ra finding, và **template chưa điền không được thoả mãn gate nào**.

Pre-commit chạy `--staged`: chỉ kiểm task folder mà commit đó chạm tới — nên nó **không** thấy task hỏng mà commit này không đụng vào (đo thật: hỏng task A, commit file B → đi qua; CI cùng cây báo 5 error). Đó là đánh đổi có chủ ý, và CI là lưới cuối. Một task đang `blocked` chờ BA là trạng thái hợp lệ — để nó chặn mọi commit không liên quan chỉ dạy cả team gõ `--no-verify`, và gate bị bypass theo phản xạ là gate đã chết. CI vẫn quét toàn repo.

Và một lớp nữa không nằm trong validator: `.claude/settings.json` deny sẵn `git push`, `git reset --hard`, `git stash`, `git clean`. Luật "đừng phá working tree" viết trong prompt là luật model **chọn** tuân thủ; deny ở tầng permission thì không có chỗ để chọn — cùng lý do đã chọn exit code thay vì lời nhắc.
