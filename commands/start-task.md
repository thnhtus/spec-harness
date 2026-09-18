---
description: Assess a tracker task, then run it through the repo's docs/ harness (assessment → task folder → worktree if needed → 7 roles, 5 gates), one subagent per stage
argument-hint: <task-url-or-id>
---

You are starting work on a tracker task: **$ARGUMENTS**

Run the task through the **repo `docs/` harness** (7 roles, 5 gates, defined
under `docs/`).

**Thứ tự:** assessment (step 0) → task folder (step 1) → worktree nếu cần
(step 2) → dispatch từng stage. Đánh giá độ phức tạp đi **trước** vì nó quyết
định worktree, model, và độ nặng Gate 1/2.

Không stage nào bị bỏ vì thay đổi "trông nhỏ" — `taskComplexity = trivial` làm
Gate 1–2 chạy **ngắn hơn**, không xoá chúng.

## Architecture: you are the COORDINATOR, not the worker

**Mỗi stage chạy như một subagent riêng, context mới.** Bạn — vòng lặp chính —
**không** tự viết FSD, review, plan, hay code. Chạy hết mọi stage trong một
context là lỗi đã biết của harness này (cạn context → treo giữa chừng).

CLI **không** hỗ trợ subagent → chạy tuần tự trong cùng phiên, nhưng giữa hai
stage phải **xoá ngữ cảnh stage trước** (`/clear`, phiên mới, hoặc tương đương)
và chỉ mang sang đúng hai thứ: `task.agent.json` và block handoff cuối. Artifact
trên đĩa là giao diện giữa các stage — không phải lịch sử hội thoại.

Your responsibilities only:

1. Read `docs/Agents.md` **§2 (lifecycle) + §3 (gates) + §4 (routing)** — you do not need the role files, and §5 (complexity) only if step 0 has not already produced the vector.
2. Dispatch one subagent per stage, in order, passing a **small** prompt
   (paths + IDs, never pasted file contents).
3. After each subagent returns, read ONLY:
   - `task.agent.json` (`status`, `currentStage`)
   - the last `## Next Handoff` block of `.agent-memory/{role}.md`
4. Gate PASS (`Continue automation: yes`) → dispatch the next stage.
   Gate FAIL → **stop everything** and report loudly (see Gate-fail handling).
5. Never read `01-FSD.md` / `02-FSD-Review.md` / `03-Technical-Plan.md`
   contents into your own context — subagents read them; you route on
   handoffs only.

## Step 0 — Assessment (LUÔN chạy đầu tiên, trước mọi quyết định khác)

Chưa biết task nặng nhẹ ra sao thì chưa quyết được worktree, model, hay độ nặng
luồng. Nên bước này đi trước — **trước cả worktree**.

1. **Đọc task từ tracker** (tool đọc task của server tracker khai ở ProjectRules
   §1 — tự tìm, đừng hardcode tên; chỉ đọc summary). Lấy `taskId`, `taskName`,
   suy ra `slug` = kebab-case không dấu.

2. **Chọn repo** (`harness.config.json → repos`). Một entry → dùng luôn. Nhiều
   entry mà user không nói rõ → **hỏi, đừng đoán**. Đó là `repoName`, không sửa
   lại được sau bootstrap.

3. **Khảo sát nhanh để trích vector** — Glob/Grep đủ để trả lời 8 chiều của
   [`docs/Agents.md` §5.1](../../docs/Agents.md), **không** đọc code sâu, không
   sửa gì. Mục tiêu là biết task chạm đâu, không phải hiểu hết.

4. **Tính `taskComplexity`** bằng công thức §5.1.1 (`max(base, riskFloor)`).
   Đừng tự phán nhãn — điền vector, để công thức ra nhãn. Validator kiểm lại.

Kết quả bước 0 quyết định ba thứ ở bước 1–2 dưới đây.

## Step 0b — Lease: task này có ai đang chạy không?

Worktree cách ly **file của repo code**. Nó không cách ly `docs/tasks/` — ở bố cục C, mọi task dùng chung một repo harness. Hai `/start-task` cùng một task (hoặc hai máy cùng một repo harness) sẽ ghi đè handoff của nhau mà không ai biết.

Trước khi bootstrap, đặt lease vào task folder:

```bash
TASK={tasksDir}/{groupPrefix}{n}/{taskId}-{slug}
node scripts/lease.mjs acquire "$TASK" || exit 1    # ← exit 1 là bắt buộc
```

Exit `1` = phiên khác đang giữ (nó in owner ra stderr). **Chạy tiếp là cướp lease**, và bạn có hai phiên cùng tin mình giữ chỗ — tệ hơn là không có lease. Xong task (`reviewing`) hoặc gate fail:

```bash
node scripts/lease.mjs release "$TASK"
```

Kẹt vì một lease mồ côi mà không muốn chờ 30 phút: xoá thẳng thư mục `.agent-memory/.lease.d` của task đó là an toàn.

**Viết bằng Node, không phải bash** — `mkdir -p`, `find -mmin`, `hostname`, `$$` không có trên PowerShell/cmd, mà step 0b chạy **trước** mọi thứ khác: hỏng nó là hỏng cả lệnh. `node` thì đã bắt buộc sẵn vì validator cần.

Ba điểm thiết kế, ghi lại để đừng "tối ưu" mất:

- **`mkdir` chứ không phải kiểm-rồi-ghi.** Khe giữa "kiểm" và "ghi" đúng là cái race mà lease sinh ra để chống; `mkdir` thất bại-nếu-đã-tồn-tại trong **một** syscall. (`recursive: true` **không** ném khi đã tồn tại → mất sạch tác dụng.)
- **Thiếu file `owner` mặc định là *còn sống*.** Giữa `mkdir` và lúc ghi `owner` có khe vài ms mà thư mục đã có còn `owner` thì chưa. Đọc "chưa có owner" là "chết" thì mọi phiên rơi vào khe đó sẽ cướp lease của một phiên đang sống — đo trên bản bash cũ: 20 phiên song song, 7 phiên cướp được. Chỉ khi **thư mục** cũng quá 30 phút mới là mồ côi thật.
- **Lease cũ hơn 30 phút = chết**, tiếp quản được (phiên trước treo hoặc bị Ctrl-C).

Kiểm chứng: `node scripts/lease.mjs --self-check` (assert cả bốn ca, gồm hai ca khe `mkdir`→ghi). Đo song song thật: 30 vòng × 20 phiên → đúng 30 phiên thắng.

Đây là lease lạc quan, không phải lock phân tán: nó bắt trường hợp thường gặp (hai phiên, một task) bằng một `mkdir` nguyên tử, không xử lý được NFS hay đồng hồ lệch giữa hai máy. Đủ cho quy mô này.

## Step 1 — Task folder (LUÔN tạo, không phụ thuộc độ phức tạp)

Task folder là nơi ghi evidence. Task `trivial` vẫn cần nó: đó là chỗ duy nhất
trả lời được "đã kiểm gì" sau khi phiên kết thúc.

Folder nằm tại `{tasksDir}/{groupPrefix}{n}/{taskId}-{slug}/` **trong repo
harness** (repo chứa `harness.config.json`) — kể cả khi code nằm repo khác.
`orchestrator` tạo nó ở stage bootstrap; bạn chỉ cần đảm bảo nó được tạo trước
khi bất kỳ stage nào ghi file.

Không có ngoại lệ "task nhỏ khỏi cần folder". Không ghi evidence thì Gate 4/5
không có gì để kiểm, và validator chặn ở `reviewing`.

## Step 2 — Worktree (CÓ ĐIỀU KIỆN)

Worktree giải quyết đúng một vấn đề: hai session cùng ghi một tree. (Đã từng
mất một stage hoàn chỉnh vì `git stash push -u` của session khác quét luôn task
folder chưa commit.) Task không chạm code thì không có vấn đề đó.

| Điều kiện | Worktree? |
| --- | --- |
| `taskComplexity = trivial` **và** `blastRadius ≤ 1` **và** không có session khác đang chạy trên repo đó | **không** — làm thẳng trên nhánh hiện tại |
| Còn lại (`normal`/`high`, hoặc blast rộng, hoặc có session song song) | **có** |
| User nói rõ "làm ngay trên tree hiện tại" | **không** |
| User nói rõ "tạo worktree" | **có** |

Không chắc có session khác hay không → **tạo worktree**. Sai hướng đó chỉ tốn
vài giây; sai hướng kia mất một stage.

Bỏ worktree thì `git status --porcelain` **phải** sạch trước khi bắt đầu — có
thay đổi chưa lưu của user thì dừng, hỏi. Ghi `"worktree": false` vào
`.agent-memory/orchestrator.md` để người đọc sau biết vì sao không có.

### Khi có worktree

Worktree luôn tạo **trong repo sẽ bị sửa** (`repoName`), không phải repo chứa
config ([`docs/Agents.md` §0](../../docs/Agents.md)):

| `repos` | Worktree ở | Task docs |
| --- | --- | --- |
| một entry `path: "."` | repo này | đi theo worktree |
| nhiều entry, `repoName` là `"."` | repo này | đi theo worktree |
| `repoName` trỏ repo khác | repo đó | **ở lại repo harness** |

1. Tạo worktree tên `task-{taskId}-{slug}` (`slug` cắt để cả tên ≤ 64 ký tự).
   CLI có tool worktree riêng (Claude Code: `EnterWorktree`) thì dùng nó; không
   thì `git -C <repo-path> worktree add .claude/worktrees/task-{taskId}-{slug}`
   rồi `cd` vào đó.

2. **Sửa nhánh ngay** — tool tự đặt tên `worktree-{name}` mọc từ `origin/HEAD`,
   thường lệch ProjectRules §3:

   ```bash
   git status --porcelain          # phải rỗng — worktree vừa tạo
   git fetch origin
   git switch -C <công-thức-nhánh ProjectRules §3> origin/<nhánh-đích>
   git branch -D worktree-task-{taskId}-{slug}
   ```

   `switch -C` an toàn ở đây và **chỉ** ở đây: tree vừa sinh, rỗng. Có output ở
   `git status --porcelain` → **dừng, hỏi user**.

3. **Dựng thứ không nằm trong git mà worktree cần** (dependency đã cài, file
   env) — cách làm theo ProjectRules §7. Hai luật chung:

   - **Đừng symlink thư mục dependency** nếu toolchain ghi state build tăng
     tiến vào trong đó: hai worktree dùng chung state → lỗi ảo. Clone
     copy-on-write (`cp -c` trên APFS, `cp --reflink=auto` trên Linux) rẻ
     tương đương mà không chia sẻ file.
   - **File env**: symlink được (tĩnh, đã trong `.gitignore`). **Cảnh báo bảo
     mật:** nội dung env tới được mọi tiến trình agent khởi động.

   Gate tĩnh (type-check, lint, unit scope) thường **không** cần env.

4. Xong task (`status = reviewing`) → rời worktree nhưng **giữ nguyên** nó
   (Claude Code: `ExitWorktree action: "keep"`; CLI khác: `cd` về, đừng
   `worktree remove`), báo user đường dẫn. Code ở worktree, task doc ở repo
   harness (bố cục C) = **hai lần commit, hai repo**.

> **Lock test dùng chung máy, không dùng chung worktree.** Project chặn chạy
> song song bằng lock toàn máy (chống OOM) thì worktree **không** gỡ được lock
> đó — worktree cách ly *file*, không cách ly CPU/RAM. Đúng hành vi, đừng "sửa".

## Stage dispatch table

Dispatch mỗi stage bằng cơ chế subagent của CLI (Claude Code: tool `Agent`,
`subagent_type` = tên role đã đăng ký ở `.claude/agents/`). CLI khác: đọc file
role tương ứng rồi chạy trong context sạch. Prompt của mọi subagent **phải** mở
đầu bằng preamble này:

> Read, in order: `docs/Instructions.md`, then `docs/agents/SharedRules.md`
> **§4 §5 §6 §8** (add **§9** unless you are `orchestrator` — it owns no AC),
> then your role file named below. Obey the artifact size caps and MCP payload
> discipline in SharedRules §8. Work only inside the task folder and the
> files your role owns. **If this is a re-run (`attempts[<stage>] > 1`), read
> only the newest `## Cập Nhật` block of `06`/`08`/`09` plus the last handoff —
> not the whole history; earlier rounds are already distilled there.** When done,
> append your `## Next Handoff` block (≤ 30 lines) to `.agent-memory/{role}.md`
> and update `task.agent.json`. End your final message with: gate verdict
> (PASS/FAIL), status set, and the one-line reason.

Preamble nêu **mục**, không nêu cả file: sàn luật mỗi subagent đọc được nhân lên theo từng stage của từng task, nên một mục thừa là chi phí trả sáu lần. Đây là chỗ rẻ nhất để cắt — sửa một dòng, không đụng kernel, giữ nguyên "một normative home". Số thật thì khiêm tốn: chỉ `orchestrator` bỏ được §9 (~580 tok), sáu role còn lại đều dùng nó. Đừng cắt sâu hơn bằng cảm tính — §8 là mục dài nhất nhưng mọi role đều cần.

**Chọn model theo `taskComplexity`.** Sau khi orchestrator xong, đọc
`taskComplexity` trong `task.agent.json` rồi truyền `model` khi dispatch từng
stage theo bảng [`docs/Agents.md` §5.3](../../docs/Agents.md). Rẻ cho việc
đọc-và-chép, mạnh cho việc phán đoán:

| Role | trivial | normal | high |
| --- | --- | --- | --- |
| `orchestrator` | cheap | cheap | mid |
| `fsd-writer` | cheap | mid | mid |
| `fsd-reviewer` | mid | mid | strong |
| `technical-planner` | mid | mid | strong |
| implementer | mid | mid | strong |
| `adversary` | mid | mid | strong |

Tier → tên model thật tra ở `harness.config.json → models`
(`{ "cheap": …, "mid": …, "strong": … }`). Kernel không biết bạn chạy CLI nào,
nên nó chỉ nói tier — đổi Claude ↔ Codex ↔ Gemini thì sửa ba dòng đó, bảng này
không đổi.

`models` rỗng `{}`, hoặc CLI không cho chọn model per-subagent → **bỏ qua bước
này**, mọi stage chạy model của phiên. Harness vẫn đúng, chỉ không tiết kiệm. **Đừng** hạ model của `fsd-reviewer` hay
`adversary` dưới bảng này: một AC rơi hoặc một bug lọt tốn hơn toàn bộ tiền
model của task.

| # | Stage | subagent_type | Role file | Prompt adds |
| --- | --- | --- | --- | --- |
| 1 | bootstrap | `orchestrator` | `docs/agents/Orchestrator.md` | task URL/id; `repoName` + nhánh hiện tại; **vector + `taskComplexity` từ step 0** (nó ghi vào `task.agent.json` + `00-Metadata.md`, không chấm lại từ đầu) |
| 2 | fsd_write → Gate 1 | `fsd-writer` | `docs/agents/FSDWriter.md` | `docsPath` from step 1 |
| 3 | fsd_review → Gate 2 | `fsd-reviewer` | `docs/agents/FSDReviewer.md` | `docsPath` |
| 4 | technical_plan → Gate 3 | `technical-planner` | `docs/agents/TechnicalPlanner.md` | `docsPath` |
| 5 | implementation → Gate 4 | `fe-implementer` (branchType feature/hotfix) or `fe-fix` (bugfix) | `docs/agents/FEImplementer.md` / `docs/agents/FEFix.md` | `docsPath`; remind: only files in the Gate-3 list; one-shot commands only |
| 6 | adversarial_review → Gate 5 | `adversary` | `docs/agents/Adversary.md` | `docsPath`; remind: mặc định FAIL, **tự chạy lại** lệnh ProjectRules §7 chứ không tin `08`, không sửa `src/` |
| 7 | reviewing | — (you) | — | see below |

Gate 5 FAIL → re-dispatch implementer (step 5) **một lần** với finding từ `09`;
vẫn FAIL lần hai → dừng, báo user (Gate-fail handling). Không lặp vô hạn.

**Sau MỖI stage, chạy validator trên đúng task này — trước khi dispatch stage kế:**

```bash
node scripts/validate-tasks.mjs --quiet --task "$TASK"    # exit 1 = gate FAIL
```

Không có bước này thì Gate 1–3 là **bạn tự đọc doc rồi tự phán** — cùng loại
self-report mà harness không tin ở `attempts` và `telemetry`. Hệ quả thật: AC rơi
khỏi `03` chỉ lộ ra ở step 7, tức là **sau khi implementer đã viết code** — đúng
lúc sửa đắt nhất, và đó là nguồn chính của `attempts.implementation ≥ 2`.

Exit code phân biệt sẵn: `0` pass · `1` gate FAIL (xử lý theo Gate-fail handling)
· `2` sai tham số `--task` (gõ sai đường dẫn — sửa lệnh, đừng coi là gate fail).

`--task` thay vì quét cả repo là có chủ đích: một task **khác** đang `blocked`
chờ BA là trạng thái hợp lệ, không được làm đỏ gate của task này.

**Mỗi lần dispatch một stage, tăng `task.agent.json → attempts[<stage>]`** (chưa
có thì đặt `1`). Đó là số đo duy nhất về rework mà harness có — `attempts` ≥ 3
validator sẽ cảnh báo ([`docs/Agents.md` §5.5](../../docs/Agents.md)).

**Và gia hạn lease — cùng chỗ đó, cùng lúc đó:**

```bash
node scripts/lease.mjs renew "$TASK"
```

Lease TTL 30 phút được thiết kế để phát hiện *phiên đã chết*, nhưng `acquire`
chỉ đóng dấu một lần — nên nếu không renew, nó áp cho **cả vòng đời task**. Một
task `high` chạy 6 stage với model `strong` vượt 30 phút là bình thường, và lúc
đó lease *đang sống* bị coi là mồ côi: phiên thứ hai acquire được, hai phiên
cùng ghi `.agent-memory/` — đúng cái race lease sinh ra để chống.

Mỗi lần dispatch là một nhịp tim tự nhiên, không cần timer hay tiến trình nền.

**Và append một dòng `telemetry`** — bạn là actor duy nhất biết stage vừa rồi
chạy tier nào:

```json
{ "stage": "implementation", "tier": "strong", "model": "opus", "attempt": 2,
  "startedAt": "2026-09-18T09:00:00Z", "endedAt": "2026-09-18T09:12:00Z",
  "inputTokens": 21400 }
```

`inputTokens` = số CLI báo sau lượt dispatch đó (bỏ qua nếu CLI không báo). Đây là thứ duy nhất cho thấy **trọng lượng của chính harness**: sàn luật mỗi subagent phải đọc được nhân lên theo từng stage, từng task — kernel phình lên thì hiện ở đây, hoặc không hiện ở đâu cả.

CLI không cho chọn model per-subagent → `"tier": "session-default"`, `model` bỏ
trống. **Không** ghi token/usage (SharedRules §5 cấm — đó là dữ liệu vendor); tên
model + wall-clock là đủ để `--calibrate` trả lời "tier `strong` có mua được gì
không", câu mà `outcome` một mình không trả lời được.

Step 7 (you, no subagent): `node scripts/lease.mjs release "$TASK"` (step 0b), confirm `task.agent.json` has `status = reviewing`,
run `node scripts/validate-tasks.mjs --quiet` and make sure this task folder reports no
errors (it enforces the AC traceability chain, SharedRules §9), then post the
final summary: what changed (from the implementer's handoff), test evidence
location (`08-Test-Evidence.md`), and the remaining user decisions (commit /
push / MR / ClickUp status). **Stop.** Do not commit or push — the user does
that themselves.

## Hard rules for subagent prompts

- Pass **paths and IDs**, never file contents — the subagent reads its own
  inputs from disk/MCP. A bloated dispatch prompt recreates the token problem
  this architecture exists to solve.
- One stage = one subagent call. Do not merge stages "to save time".
- If a subagent returns without having written its handoff block, re-dispatch
  it once with the instruction to complete the handoff; if it fails again,
  treat it as a gate FAIL.

## Gate-fail handling

When any gate fails (`status = blocked` or `needs_clarification`,
`Continue automation: no`):

- Do NOT dispatch the next stage. Do NOT retry in a loop.
- Report to the user, loudly and immediately, all four of:
  1. which gate failed,
  2. why (from the handoff block),
  3. which file holds the blocker details,
  4. exactly what the user/BA must do to unblock.
- `node scripts/lease.mjs release "$TASK"` (step 0b) — task dừng thì không giữ chỗ nữa.
- Stop. Resume later via `docs/HarnessSetup.md` §7 (re-dispatch the stage
  recorded in `currentStage`).

## Constraints (inherited — do not restate to subagents, they read the docs)

- No commit / push / MR unless the user explicitly asks (user commits
  themselves).
- MCP is the source of truth; missing fields are `unavailable`, never
  invented. If an MCP call fails with an auth error: stop and tell the user
  to re-login via `/mcp`.
- Never modify `docs/srs/`, `docs/fsd/`, `docs/api/` content, the
  `docs/tasks/_templates/` originals, hay file cấu hình của CLI.
- Watch-mode commands (dev server, test watch, preview — liệt kê ở
  ProjectRules §7) are never run by you or any subagent.
- No working-tree-destroying git command, ever — no `git stash` (incl.
  `push -u`), `git checkout -- …`, `git restore`, `git reset --hard`,
  `git clean`. That is the exact command that lost a stage. Need a clean tree
  for a baseline? You already have one: step 0 gave you a fresh worktree.

## Step 7 — dọn worktree đã merge (sau khi báo user, trước khi dừng)

Rời worktree mà giữ lại thì không có gì dọn, nên chúng tích lại — một máy đã
từng tích **108 worktree / 65 GB**, trong đó 79 nhánh đã merge (việc xong, giữ
vô nghĩa). Mỗi worktree mới clone lại dependency trên nền đó → càng lúc càng chậm.

Chạy dry-run rồi báo user con số, **không tự xoá**. Với mỗi repo trong
`harness.config.json → repos`:

```bash
TARGET=origin/<nhánh-đích ProjectRules §3>
git -C <repo-path> fetch origin -q
for w in $(git -C <repo-path> worktree list --porcelain | awk '/^worktree /{print $2}'); do
  b=$(git -C "$w" branch --show-current 2>/dev/null) || continue
  [ -z "$b" ] && continue
  # đã merge nhánh đích + tree sạch = an toàn để xoá
  git -C <repo-path> merge-base --is-ancestor "$b" "$TARGET" 2>/dev/null \
    && [ -z "$(git -C "$w" status --porcelain)" ] \
    && echo "$w  [$b]"
done
```

Danh sách in ra là **ứng viên** — commit đã nằm trong nhánh đích *và* tree sạch.
User tự quyết xoá:

```bash
git worktree remove <path> && git branch -d <branch>   # -d, KHÔNG -D: -d từ chối nếu chưa merge
```

Worktree của task **này** không bao giờ nằm trong danh sách (chưa merge) — nên
step 7 không đụng việc bạn vừa làm.
