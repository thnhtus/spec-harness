# /start-task — phụ lục

> Chỉ đọc **đúng mục** mà `commands/start-task.md` link tới. Đây là phần lý do và các nhánh điều kiện, tách ra để coordinator không phải trả tiền cho chúng ở mọi task (#55). Lệnh và điều kiện vẫn nằm trong `start-task.md`.

## A. Kết quả escape hatch — vì sao quan trọng

`escaped` không phải nhận lỗi — nó là bằng chứng duy nhất cho thấy `riskFloor`
quá lỏng, và `--calibrate` cần vài mẫu mới lên tiếng. Ghi `clean` cho một task
sau đó cắn người khác là mục duy nhất không rút lại được (`escaped` ghi sau thắng,
`clean` ghi sau thì không).

User muốn chạy harness dù verdict là escape hatch → cứ chạy, không cần gì thêm.
Chiều ngược lại (verdict `harness` nhưng user muốn bỏ qua) → `--force "<lý do>"`.
Bỏ harness là quyết định hợp lệ; bỏ mà không để lại dấu vết thì không.

## B. Vector triage vs bootstrap — cả hai chiều

**Chấm trung thực, đừng chấm về phía đáp án mình muốn.** Mọi lần triage ghi vào
`_triage.log`, và validator đối chiếu giá trị **thấp nhất** từng ghi cho mỗi chiều
(chạy lại `--triage` không đè điểm thấp; task không có entry nào là warning) với
vector lưu trong task, **cả hai chiều**: chấm thấp ở đây rồi cao ở bootstrap →
warning (nâng sau khảo sát là bình thường, §5.1.3 — warning chỉ nói rõ con số thấp
mới là con số quyết định task có cần harness không); ngược lại, **hạ** một chiều
xuống dưới giá trị triage là **error** — đó là chiều §5.1.3 cấm.

## C. Lease — mồ côi, điểm thiết kế, giới hạn

Kẹt lease mồ côi và không muốn đợi 30 phút: xoá thẳng thư mục `.agent-memory/.lease.d` của task đó là an toàn.

**Viết bằng Node, không bash** — `mkdir -p`, `find -mmin`, `hostname`, `$$` không có trên PowerShell/cmd, và step 0b chạy **trước** mọi thứ: hỏng nó là hỏng cả lệnh. `node` vốn đã bắt buộc vì validator cần.

Ba điểm thiết kế, ghi ra để không ai "tối ưu" mất:

- **`mkdir`, không check-rồi-ghi.** Khe giữa "check" và "ghi" chính là race mà lease sinh ra để chặn; `mkdir` fail-nếu-đã-có trong **một** syscall. (`recursive: true` **không** throw khi đã tồn tại → mất sạch tác dụng.)
- **Thiếu file `owner` mặc định là *còn sống*.** Giữa `mkdir` và ghi `owner` có khe vài ms thư mục đã có mà `owner` chưa. Đọc "chưa có owner" thành "chết" nghĩa là mọi session rơi vào khe đó cướp lease của session đang sống — đo trên bản bash cũ: 20 session song song, 7 cái cướp. Chỉ khi **thư mục** cũng quá 30 phút mới là mồ côi thật.
- **Lease quá 30 phút = chết**, lấy được (session trước treo hoặc bị Ctrl-C).

Kiểm: `node scripts/lease.mjs --self-check` (assert cả bốn ca, gồm hai ca khe `mkdir`→ghi). Đo song song thật: 30 vòng × 20 session → đúng 30 người thắng.

Đây là lease lạc quan, không phải distributed lock: bắt ca thường gặp (hai session, một task) bằng một `mkdir` nguyên tử, không xử lý NFS hay lệch đồng hồ giữa hai máy. Đủ ở quy mô này.

## D. Tạo worktree

Worktree luôn tạo **trong repo sẽ bị sửa** (`repoName`), không phải repo chứa
config ([`docs/Agents.md` §0](../Agents.md)):

| `repos` | Worktree ở | Task docs |
| --- | --- | --- |
| một entry `path: "."` | repo này | đi theo worktree |
| nhiều entry, `repoName` là `"."` | repo này | đi theo worktree |
| `repoName` trỏ repo khác | repo đó | **ở lại repo harness** |

1. Tạo worktree tên `task-{taskId}-{slug}` (cắt `slug` để cả tên ≤ 64 ký tự). CLI
có tool worktree riêng (Claude Code: `EnterWorktree`) thì dùng; không thì
`git -C <repo-path> worktree add .claude/worktrees/task-{taskId}-{slug}` rồi `cd` vào.

2. **Sửa nhánh ngay** — tool đặt tên `worktree-{name}` rẽ từ `origin/HEAD`, thường
không khớp ProjectRules §3:

```bash
git status --porcelain          # phải rỗng — worktree vừa tạo
git fetch origin
git switch -C <công thức nhánh ProjectRules §3> origin/<target-branch>
git branch -D worktree-task-{taskId}-{slug}
```

`switch -C` an toàn ở đây và **chỉ** ở đây: cây vừa tạo, rỗng. `git status --porcelain`
có output → **dừng, hỏi user**.

3. **Dựng thứ worktree cần mà không nằm trong git** (dependency đã cài, file env) —
theo ProjectRules §7. Hai luật chung:

- **Đừng symlink thư mục dependency** nếu toolchain ghi build state tăng dần vào đó:
  hai worktree chung state → lỗi ma. Clone copy-on-write (`cp -c` trên APFS,
  `cp --reflink=auto` trên Linux) rẻ như nhau và không chung file.
- **File env**: symlink được (tĩnh, đã trong `.gitignore`). **Cảnh báo bảo mật:**
  nội dung env tới được mọi process agent khởi chạy.

Gate tĩnh (type-check, lint, unit test theo scope) thường **không** cần env.

4. Task xong (`status = reviewing`) → rời worktree nhưng **giữ** nó (Claude Code:
`ExitWorktree action: "keep"`; CLI khác: `cd` ra, không `worktree remove`), và báo
user đường dẫn. Code ở worktree, task docs ở repo harness (layout C) = **hai commit,
hai repo**.

> **Test lock là theo máy, không theo worktree.** Project chặn chạy song song bằng
> lock toàn máy (tránh OOM) thì worktree **không** gỡ được lock đó — worktree cô lập
> *file*, không cô lập CPU/RAM. Đó là hành vi đúng, đừng "sửa".

## E. Vì sao preamble nêu section

Preamble nêu **section**, không nêu cả file: sàn luật mọi subagent phải đọc nhân với mọi stage của mọi task, nên thừa một section là trả sáu lần. Đây là chỗ cắt rẻ nhất — đổi một dòng, kernel không đụng, "một nhà chuẩn" giữ nguyên. Con số thật khiêm tốn: chỉ `orchestrator` bỏ được §9 (~580 tok), sáu role kia đều dùng. Đừng cắt sâu hơn theo cảm tính — §8 dài nhất nhưng role nào cũng cần.

`--pack` (#66) biến lát cắt đó thành thứ role nhận được: đúng các file và section ấy, một tool call thay vì mỗi file một lần Read — mỗi Read là một turn, và mỗi turn tính lại tiền cả context. Đo trên fixture eval: 26 KB (fsd_write) đến 43 KB (adversarial_review) phần luật + prose. `packCap.<stage>` làm pack fail (exit 1) khi phần đó phình, nên kernel phình hiện thành một lệnh đỏ chứ không phải trên hoá đơn. Phần git chỉ warning (`packWarn`): đó là diff, và cắt nó chính là điều Gate 5 không bao giờ được làm — mọi dòng `git status --porcelain` được giữ, file ngoài danh sách Gate 3 được đánh dấu, không bị bỏ.

## F. Tên tier không phụ thuộc CLI

Tier → tên model thật tra ở `harness.config.json → models.<cli>`
(`{ "<cli>": { "cheap": { "model": … }, … } }`). Kernel không biết bạn chạy CLI nào nên
chỉ nói bằng tier — thêm Codex hay Gemini là thêm key của nó, bảng không đổi.

## F2. Lý do nâng tier khi retry

Dispatch lại trên đúng tier vừa fail là cùng lỗi §5.3 cấm với `adversary`: cùng tier
cùng điểm mù. *Hạ* tier khi retry là **error** validator chặn — không tiết kiệm,
chỉ mua thêm một lần bounce. `retryBudget` vẫn chặn trần: 4 lần block là hết budget.

Không có `models.<cli>`, hoặc CLI không chọn được model theo subagent → **bỏ bước này**,
mọi stage chạy model của session. Harness vẫn đúng, chỉ không rẻ hơn. **Không** hạ
model của `fsd-reviewer` hay `adversary` xuống dưới bảng: một AC rơi hay một bug lọt
tốn hơn cả hoá đơn model của task.

## G. Vì sao validate sau mọi stage

Thiếu bước này, Gate 1–3 là **bạn tự đọc doc rồi tự chấm** — cùng loại self-report
mà harness không tin ở `attempts` và `telemetry`. Hậu quả thật: một AC rơi khỏi `03`
chỉ lộ ra ở step 7, tức là **sau khi implementer đã viết code** — đúng lúc sửa đắt
nhất, và là nguồn chính của `attempts.implementation ≥ 2`.

Exit code đã phân biệt: `0` pass · `1` gate FAIL (xử lý theo Gate-fail handling) ·
`2` sai tham số `--task` (gõ sai đường dẫn — sửa lệnh, đừng coi là gate fail).

Dùng `--task` thay vì quét cả repo là cố ý: một task **khác** đang `blocked` chờ BA
là trạng thái hợp lệ, không được làm đỏ gate của task này.

## H. Vì sao renew lease mỗi lần dispatch

TTL 30 phút của lease để phát hiện *session chết*, nhưng `acquire` chỉ đóng dấu một
lần — không renew thì TTL áp cho **cả vòng đời task**. Task `high` chạy 6 stage trên
model `strong` quá 30 phút là bình thường, và lúc đó lease *đang sống* bị coi là mồ
côi: session thứ hai lấy được, hai session cùng ghi `.agent-memory/` — đúng race lease
sinh ra để chặn.

Mỗi lần dispatch là một nhịp tim tự nhiên — không cần timer hay process nền.

`--advance` renew lease, và exit `1` khi không giữ lease: một lần renew tự tạo lease là acquire đã bỏ qua bước kiểm.

## I. Trường telemetry — ghi gì và vì sao

`attempt` không tuỳ chọn khi một stage chạy hai lần: nó là thứ làm luật cascade
(§5.3.1) kiểm được, thiếu nó validator chỉ cảnh báo được là không phân biệt nổi
nâng tier với hạ tier.

**`--advance` ghi `startedAt`/`endedAt`; bỏ `inputTokens`.** Một lần chạy thật cho thấy
khung giờ gõ tay là bịa (phút tròn, không khớp đồng hồ nào), và validator không phân biệt
được — nên script dispatch giờ đóng dấu bằng đồng hồ máy, và ghi thêm từng mốc vào
`{tasksDir}/_stamp.log`. Khung giờ không có dòng ở đó là lỗi (task tạo từ `config.stampSince`
trở đi): nó được gõ, không được đo. Số token bạn không biết, và số đoán còn tệ hơn không có vì
`--cost` sẽ in nó như sự thật. `scripts/collect-telemetry.mjs` điền nó ở step 7 bằng
cách đọc session log của chính CLI, khớp theo cwd + nhánh + khung giờ đó. Đó là thứ
duy nhất cho thấy **sức nặng của chính harness**: sàn luật mọi subagent phải đọc nhân
với mọi stage, mọi task — kernel phình thì lộ ở đây, hoặc không lộ ở đâu cả.

CLI không chọn được model theo subagent → `"tier": "session-default"`, để trống
`model`. **Không** ghi token/usage (SharedRules §5 cấm — đó là dữ liệu vendor); tên
model + wall-clock đủ để `--calibrate` trả lời "tier `strong` có mua được gì không",
câu mà `outcome` một mình không trả lời được.

## J. Step 7 — dọn worktree đã merge

Rời worktree mà giữ lại nghĩa là không ai dọn, nên chúng chất đống — một máy từng
tích **108 worktree / 65 GB**, 79 cái trên nhánh đã merge (việc xong, giữ vô ích).
Mỗi worktree mới lại clone dependency chồng lên → càng lúc càng chậm.

Chạy dry-run và báo con số cho user, **không tự xoá gì**. Với mỗi repo trong
`harness.config.json → repos`:

```bash
TARGET=origin/<target-branch ProjectRules §3>
git -C <repo-path> fetch origin -q
for w in $(git -C <repo-path> worktree list --porcelain | awk '/^worktree /{print $2}'); do
  b=$(git -C "$w" branch --show-current 2>/dev/null) || continue
  [ -z "$b" ] && continue
  # đã merge vào target + cây sạch = xoá được
  git -C <repo-path> merge-base --is-ancestor "$b" "$TARGET" 2>/dev/null \
 && [ -z "$(git -C "$w" status --porcelain)" ] \
 && echo "$w  [$b]"
done
```

Danh sách in ra là **ứng viên** — commit đã nằm trong nhánh target *và* cây sạch.
User quyết định xoá:

```bash
git worktree remove <path> && git branch -d <branch>   # -d, KHÔNG -D: -d từ chối nếu chưa merge
```

Worktree của **task này** không bao giờ nằm trong danh sách (chưa merge) — nên
step 7 không bao giờ đụng tới việc bạn vừa làm.
