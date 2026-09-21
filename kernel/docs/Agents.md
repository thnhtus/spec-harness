# Agents — Role registry, workflow, gate (nguồn chuẩn duy nhất cho lifecycle)

> **Phạm vi:** tài liệu canonical định nghĩa 7 role, lifecycle qua các stage có gate, cách chọn implementer theo `branchType`, và quy tắc skip. Quy tắc vận hành chi tiết (MCP, guardrail, nhánh, handoff, lệnh, ngân sách token): [`agents/SharedRules.md`](./agents/SharedRules.md) — không lặp lại ở đây.
> **Repo:** khai ở `harness.config.json → repos`. Harness chạy được ở ba bố cục — xem §0.

---

## 0. Bố cục repo

Harness không giả định code nằm ở đâu. `harness.config.json → repos` khai từng repo mà agent được sửa, `path` tính từ thư mục chứa config:

| Bố cục | `repos` | Task docs nằm | Worktree |
| --- | --- | --- | --- |
| **A. Trong repo code** (một repo FE, hoặc một repo BE) | `[{ name, path: ".", layer }]` | **cùng repo** với code | `/start-task` tạo worktree của chính repo đó; task doc đi theo worktree |
| **B. Trong một repo, đọc repo anh em** | `[{ path: "." }, { path: "../<repo>", … }]` | trong repo chính | như A; repo anh em **read-only**, không worktree, không sửa |
| **C. Ngang hàng FE + BE** (harness là repo riêng) | `[{ path: "../fe" }, { path: "../be" }]` | **repo harness**, tách khỏi mọi repo code | worktree tạo **trong repo code** đang sửa (`repoName` của task); task doc ở lại repo harness, **không** vào worktree |

**Quy tắc chung cho cả ba:**

- `repoName` trong `task.agent.json` chỉ một entry của `repos` — đó là repo agent được sửa. Sai tên → validator chặn.
- Repo khai trong `repos` mà **không** phải `repoName` của task: **read-only** (vd đọc DTO của BE — [`agents/TechnicalPlanner.md` §3.2](./agents/TechnicalPlanner.md)). Đọc được, không sửa.
- Repo **không** khai trong `repos`: không đụng tới.
- Subagent **không bao giờ** tự tạo/đổi worktree — nó đã ở đúng chỗ khi được dispatch ([`Instructions.md` §1](./Instructions.md)).
- Bố cục C: commit task doc và commit code là **hai repo khác nhau**, hai lần commit. Gate pass → `reviewing` → user tự quyết commit ở đâu.

Task chạm **nhiều layer** (vd sửa cả FE lẫn BE): tách thành hai task, mỗi task một `repoName`. Một `task.agent.json` chỉ có một `repoName` — cố nhét hai repo vào một task thì AC traceability và scope Gate 3 mất nghĩa.

---

## 1. Bảng role (7 role)

Tên kebab-case; `layer` luôn `frontend`; mỗi role một file trong [`agents/`](./agents/SharedRules.md).

| Role | Stage | Output chính | Gate chặn khi | Chi tiết |
| --- | --- | --- | --- | --- |
| `orchestrator` | bootstrap | task folder, `task.agent.json`, `00-Metadata.md`, `.agent-memory/` | metadata thiếu không suy ra được | [`agents/Orchestrator.md`](./agents/Orchestrator.md) |
| `fsd-writer` | fsd_write | `01-FSD.md` (FSD IEEE cấp task — skill `document-to-ieee-srs`) | FSD chưa đủ / không truy vết được (**Gate 1**) | [`agents/FSDWriter.md`](./agents/FSDWriter.md) |
| `fsd-reviewer` | fsd_review | `02-FSD-Review.md` (AC, câu hỏi BA, risk) | intent / AC chưa rõ (**Gate 2**) | [`agents/FSDReviewer.md`](./agents/FSDReviewer.md) |
| `technical-planner` | technical_plan | `03-Technical-Plan.md` (file sẽ đổi, test plan, checklist, risk) | thiếu plan / test (**Gate 3**) | [`agents/TechnicalPlanner.md`](./agents/TechnicalPlanner.md) |
| `fe-implementer` | implementation (feature/hotfix) | code + `06-FE-Implementation-Notes.md` + `08-Test-Evidence.md` | thiếu evidence / ngoài scope (**Gate 4**) | [`agents/FEImplementer.md`](./agents/FEImplementer.md) |
| `fe-fix` | implementation (bugfix) | như trên, định hướng reproduce-first | như trên (**Gate 4**) | [`agents/FEFix.md`](./agents/FEFix.md) |
| `adversary` | adversarial_review | `09-Adversarial-Review.md` (tự chạy lại lệnh, soi diff + test, finding) | có finding BLOCKING / evidence không tái lập (**Gate 5**) | [`agents/Adversary.md`](./agents/Adversary.md) |

> Task ở layer `frontend` mà repo BE **không** nằm trong `repos`: contract FE↔API chỉ ghi ở **góc nhìn client** trong `03-Technical-Plan.md`. Có repo BE trong `repos` → đọc thẳng source BE (read-only) theo thang bậc [`agents/TechnicalPlanner.md` §3.2](./agents/TechnicalPlanner.md). Thiếu ⇒ `unavailable`, không bịa.

---

## 2. Lifecycle

```mermaid
flowchart TD
    START([start task &lt;taskId&gt;]) --> ORCH[orchestrator<br/>bootstrap]
    ORCH --> WRITE[fsd-writer<br/>fsd_write]
    WRITE -->|Gate 1| FSD[fsd-reviewer<br/>fsd_review]
    FSD -->|Gate 2| PLAN[technical-planner<br/>technical_plan]
    PLAN -->|Gate 3| PICK{branchType?}
    PICK -->|feature / hotfix| IMPL[fe-implementer]
    PICK -->|bugfix| FIX[fe-fix]
    IMPL -->|Gate 4| ADV[adversary<br/>adversarial_review]
    FIX -->|Gate 4| ADV
    ADV -->|Gate 5| REVIEW[status: reviewing]
    ADV -.FAIL.-> IMPL
    REVIEW --> MR([user duyệt push + MR])

    WRITE -.fail.-> BLOCK[[blocked /<br/>needs_clarification]]
    FSD -.fail.-> BLOCK
    PLAN -.fail.-> BLOCK
    IMPL -.fail.-> BLOCK
    FIX -.fail.-> BLOCK
    ADV -.fail.-> BLOCK
```

Gate fail → `status = blocked` / `needs_clarification`, ghi blocker vào doc + `.agent-memory/{role}.md`, **báo to cho user** (4 ý bắt buộc — [`agents/SharedRules.md` §4](./agents/SharedRules.md)), dừng automation tới khi user/BA resolve.

**Cách ly ngữ cảnh per-stage:** mỗi stage chạy như **một subagent riêng** (context mới), nhận đầu vào qua artifact + handoff `.agent-memory/` thay vì qua hội thoại. Main loop chỉ điều phối gate. Chi tiết dispatch: lệnh `/start-task` (`.claude/commands/start-task.md`).

---

## 3. Định nghĩa gate

Gate là điểm kiểm tra **chặn**. PASS mới handoff; FAIL → đặt status, ghi blocker, báo to, dừng.

| Gate | Sau stage | Điều kiện PASS | FAIL → status |
| --- | --- | --- | --- |
| **Gate 1** | fsd_write | `01-FSD.md` đủ khung IEEE (Introduction, Overall Description, External Interface, Functional Requirements); mỗi requirement dùng `shall` + truy vết được (`FR-`/`FSD-`/tracker/design); assumption tách riêng; **≤ 250 dòng** (trần tại [`agents/SharedRules.md` §8](./agents/SharedRules.md)) | `needs_clarification` |
| **Gate 2** | fsd_review | AC + business intent rõ; câu hỏi BA `blocking` đã trả lời; ID `FR-`/`NFR-`/`FSD-` đã trích; **≤ 150 dòng** | `needs_clarification` |
| **Gate 3** | technical_plan | `03-Technical-Plan.md` có: danh sách file FE sẽ đổi, test plan (lệnh one-shot cụ thể), checklist, risk; **mọi AC của `02` có ở cột Covers AC hoặc bảng AC-manual** ([SharedRules §9.1](./agents/SharedRules.md)); **≤ 200 dòng** | `blocked` |
| **Gate 4** | implementation | Bộ lệnh kiểm tra bắt buộc của project PASS ([`agents/ProjectRules.md` §7](./agents/ProjectRules.md)) với evidence thật trong `08-Test-Evidence.md`; **bảng AC coverage đủ mọi AC**, AC bị làm lệch đã có Amendment log ([SharedRules §9](./agents/SharedRules.md)); thay đổi **trong scope** danh sách Gate 3 | `blocked` |

| **Gate 5** | adversarial_review | `adversary` **tự chạy lại** toàn bộ lệnh ProjectRules §7 và khớp với `08`; mọi AC có test thật sự assert được nó; diff nằm trong scope Gate 3 (phần ngoài đã khai Plan Deviations); **không** finding BLOCKING; không còn UNCERTAIN | `blocked` → re-route implementer |

Danh sách lệnh hợp lệ (one-shot vs watch-mode): [`agents/SharedRules.md` §7](./agents/SharedRules.md).

> **Vì sao có Gate 5:** Gate 1–4 đều do chính người làm tự chấm. Validator chỉ đọc được văn bản — nó thấy `08` có lệnh và có chữ "passed", không thấy được test đó có thật sự chứng minh AC. `adversary` mặc định FAIL và phải tự kiếm bằng chứng để PASS.

---

## 4. Chọn implementer theo `branchType`

| branchType | Implementer |
| --- | --- |
| `feature`, `hotfix` | `fe-implementer` |
| `bugfix` | `fe-fix` |

Quy tắc nhánh (tạo từ `develop` với `--ff-only`, ngoại lệ nhánh user quản lý + `branchActual`): [`agents/SharedRules.md` §3](./agents/SharedRules.md).

---

## 5. Đánh giá độ phức tạp → chọn độ nặng luồng & model

`taskComplexity` quyết định **hai** thứ: Gate 1/2 chạy đầy hay light, và role nào đáng dùng model đắt. Đoán sai theo hướng thấp thì gate thành hình thức; đoán sai theo hướng cao thì đốt tiền vào task sửa một dòng CSS.

### 5.1. Chấm điểm — LLM trích, công thức tính

**Agent không tự phán "task này 7/10".** Con số đó không kiểm lại được và không debug được. Agent chỉ **trích từng chiều**; điểm và phân loại do **công thức** ra. Vector lưu vào `task.agent.json → complexity`, validator kiểm công thức khớp phân loại.

**Sáu chiều công sức**, mỗi chiều `0` (không) · `1` (vừa) · `2` (nhiều):

| Chiều | `0` | `1` | `2` |
| --- | --- | --- | --- |
| `scope` | 1 file | vài file, một module | nhiều module / nhiều tầng |
| `uncertainty` | yêu cầu rõ hết | vài chỗ suy ra được | phải hỏi BA mới làm được |
| `dependency` | không phụ thuộc | phụ thuộc module có sẵn | phụ thuộc service/repo khác |
| `dataImpact` | không chạm dữ liệu | đọc/ghi qua API sẵn có | đổi schema · migration · đổi shape dùng chung |
| `integration` | không | gọi API sẵn có | thêm/đổi contract · hệ thống ngoài |
| `testing` | test sẵn phủ được | thêm test thường | khó tái hiện · cần e2e/thủ công |

`effort = tổng` (0–12).

**Chấm từ số đo, không từ mô tả task.** Mô tả task là thứ nói thiếu nhất, và vector chấm từ nó là cách rẻ nhất để ước lượng thấp — mà ước lượng thấp đẻ ra retry, và retry đắt hơn mọi quyết định model cộng lại. Nên ba chiều dễ đo phải đi kèm số, ghi vào `complexity.counts` / `complexity.questions`:

| Chiều | Chạy | Ràng buộc validator enforce |
| --- | --- | --- |
| `scope` | `rg -l '<symbol chính>' <src> \| wc -l` → `counts.filesTouched` | `1` ⇒ `scope 0` · `>5` ⇒ `scope 2` |
| `testing` | đếm test file đang phủ code đó → `counts.existingTests` | `0` ⇒ `testing ≥ 1` |
| `uncertainty` | viết ra danh sách "không làm được nếu không biết X" → `questions[]` | rỗng ⇒ `uncertainty 0` · có mục ⇒ `uncertainty ≥ 1` |

Ba chiều còn lại (`dependency`, `dataImpact`, `integration`) không có phép đếm nào nói đúng được, nên vẫn là phán đoán — nhưng `note` nên nêu file/contract cụ thể đã thấy.

`uncertainty` là chiều bị chấm thấp nhiều nhất và đắt nhất: nó chính là thứ sinh ra `fsd_review ≥ 2`. Luật: **chưa viết ra được danh sách câu hỏi thì chưa được chấm `uncertainty: 0`** — "rỗng" phải là kết luận sau khi tìm, không phải mặc định.

**Hai chiều rủi ro**, tách riêng vì chúng **không đi cùng kích thước**:

| Chiều | Ý nghĩa | Thang |
| --- | --- | --- |
| `blastRadius` | hỏng thì lan tới đâu | `0` một chỗ · `1` một module · `2` một feature · `3` một service · `4` toàn hệ thống |
| `reversibility` | rollback khó tới đâu | `0` sửa lại là xong · `1` revert commit · `2` cần deploy lại · `3` phải sửa dữ liệu · `4` không lùi được (migration xoá cột, tiền đã chuyển) |

### 5.1.1. Công thức (deterministic — không phải LLM quyết)

```
effort = scope + uncertainty + dependency + dataImpact + integration + testing   # 0–12

base        = trivial khi effort ≤ 2 · normal khi effort ≤ 6 · high khi effort ≥ 7
riskFloor   = high     khi blastRadius ≥ 3  hoặc reversibility ≥ 3
            = normal   khi blastRadius ≥ 2  hoặc reversibility ≥ 2
            = trivial  còn lại

taskComplexity = max(base, riskFloor)          # trivial < normal < high
```

`riskFloor` là lý do bug race condition trong websocket không bị chấm `trivial`: `effort` có thể là 2 (sửa một file) nhưng `blastRadius = 3` kéo lên `high`. Ngược lại, đổi copy ở 12 file là `effort` cao mà `blastRadius = 0` — vẫn chỉ `normal`, không đáng đốt model đắt.

### 5.1.2. Ghi vào `task.agent.json`

```json
"complexity": {
  "vector": { "scope": 2, "uncertainty": 1, "dependency": 2, "dataImpact": 2,
              "integration": 1, "testing": 2, "blastRadius": 2, "reversibility": 1 },
  "effort": 10,
  "counts": { "filesTouched": 9, "existingTests": 0 },
  "questions": ["notification gửi cho role nào khi nhân viên bị gỡ khỏi phòng ban?"],
  "splitEvaluated": "tách thành ABC-12 (resolver) + ABC-13 (notification) — ship riêng được",
  "assessedAt": "bootstrap",
  "note": "chạm resolver nhân viên + notification; test cần mock queue"
}
```

`counts` và `questions` **không phải chú thích** — validator đối chiếu chúng với vector và chặn nếu mâu thuẫn (`filesTouched: 1` mà `scope: 1`, `questions` rỗng mà `uncertainty: 2`, …). Thiếu chúng cũng là error với task tạo sau `acTrace.since`; task cũ hơn chỉ warning.

`taskComplexity` (trường cũ) vẫn là nơi đọc nhanh; `complexity.vector` là **cơ sở** của nó. Validator tính lại công thức từ vector — lệch với `taskComplexity` là **error**. Đó là chỗ "deterministic" có răng: agent không ghi được vector thấp rồi tuyên bố `high`, hay ngược lại.

### 5.1.3. Đánh giá lại sau khi khảo sát

Đánh giá ở bootstrap dựa trên mô tả task, mà mô tả task hay nói thiếu. `technical-planner` khảo sát `src/` xong **phải** đối chiếu lại vector:

- Vector cũ vẫn đúng → không làm gì.
- Rộng hơn hẳn (phát hiện thêm tầng phụ thuộc, migration, contract đổi) → **cập nhật vector**, ghi `assessedAt: "technical_plan"` + lý do, tính lại `taskComplexity`.

Chỉ được **nâng**. Hạ để chạy nhẹ đi là né gate — muốn hạ thì `needs_clarification`, hỏi user.

Vector tăng lên `high` sau khảo sát → stage sau dùng model theo cột `high` (§5.3), và nếu `blastRadius ≥ 3` thì planner nêu ở Risk để user biết trước khi implementer chạy.

### 5.1.4. Tách task **trước** khi đốt budget

Đòn bẩy chi phí lớn nhất không nằm ở chọn model — nằm ở chỗ một task quá to. So sánh thẳng:

| | 1 task `high` | 2 task `normal` |
| --- | --- | --- |
| Stage | 7 × tier `strong` ở 3 role | 14 × tier `mid` |
| Gate 1/2 | đầy đủ + soi kỹ | rút gọn được |
| Retry | xác suất cao (spec rộng, plan dễ sai chỗ) | mỗi task hẹp, ít bật |

Số stage gấp đôi nhưng tier rẻ hơn và rework ít hơn — tổng thường **rẻ hơn**, và cái rẻ đi rõ nhất là rework.

`status = split` (§5.5) đã có, nhưng nó là lối thoát khi **hết** `retryBudget` — lúc đó tiền đã đốt xong. Nên có thêm một chốt ở bootstrap:

> `effort ≥ 9`, **hoặc** `scope = 2` kèm `uncertainty = 2` → phải điền `complexity.splitEvaluated`.

Hai giá trị hợp lệ: danh sách taskId con (đã tách), hoặc lý do không tách được ("một migration, một lần deploy — không ship riêng được"). Validator chặn nếu để trống. Nó không ép tách — nó ép **trả lời câu hỏi có tách không** vào đúng lúc câu trả lời còn rẻ.

`scope 2 + uncertainty 2` lọt vào dù `effort` chưa tới 9 vì đó là tổ hợp tệ nhất: rộng **và** chưa rõ. Task kiểu đó gần như luôn bật ở `fsd_review` rồi bật tiếp ở `implementation`.

### 5.2. Độ nặng luồng

Không mức nào bỏ được stage hay gate. `trivial` chỉ làm Gate 1/2 **ngắn lại**:

| | `trivial` | `normal` | `high` |
| --- | --- | --- | --- |
| `fsd-writer` | khung IEEE tối thiểu: Introduction + Functional Requirements có `shall` + trace. Rút gọn non-functional/data khi task không chạm | đầy đủ | đầy đủ + soi kỹ ràng buộc & phụ thuộc |
| `fsd-reviewer` | AC tối thiểu + ID liên quan; bỏ được risk dài/câu hỏi BA nếu intent đã rõ | đầy đủ | thêm phân tích risk + đối chiếu chéo spec |
| `technical-planner` · implementer · `adversary` | **không** rút gọn | **không** rút gọn | **không** rút gọn |

Gate 1 và Gate 2 vẫn phải PASS ở cả ba mức.

### 5.3. Chọn model theo **tier**, không theo tên hãng

Kernel không biết bạn chạy Claude Code, Codex, hay CLI khác — nên nó chỉ nói **ba tier**. Ánh xạ tier → tên model thật nằm ở `harness.config.json → models`:

```json
"models": { "cheap": "haiku", "mid": "sonnet", "strong": "opus" }
```

Đổi CLI thì đổi đúng ba dòng đó (`gpt-5-mini` / `gpt-5` / `gpt-5-pro`, `gemini-flash` / `gemini-pro` / …). Toàn bộ bảng dưới không đổi. Để `models` rỗng `{}` = dùng mặc định của CLI, không định tuyến gì.

Nguyên tắc: **tier rẻ cho việc đọc-và-chép, tier mạnh cho việc phán đoán.** Stage nào sai thì cả chuỗi sau sai theo — đó là chỗ trả tiền đáng.

| Role | trivial | normal | high | Vì sao |
| --- | --- | --- | --- | --- |
| `orchestrator` | cheap | cheap | mid | đọc tracker, điền template — ít phán đoán |
| `fsd-writer` | cheap | mid | mid | chuyển mô tả thành requirement có cấu trúc |
| `fsd-reviewer` | mid | mid | strong | **AC sai ở đây thì mọi stage sau đều sai** |
| `technical-planner` | mid | mid | strong | chọn sai chỗ sửa → implementer làm lại từ đầu |
| `fe-implementer` / `fe-fix` | mid | mid | strong | viết code thật |
| `adversary` | mid | mid | strong | phải tìm ra cái implementer bỏ sót — cùng tier thì cùng điểm mù |

**Tại sao `adversary` không hạ xuống cheap:** role này tồn tại để nhìn ra thứ người làm không nhìn ra. Tier yếu hơn implementer thì nó chỉ gật đầu.

**Áp dụng:** file `.claude/agents/{role}.md` **không ghi `model:`** — mặc định là model của phiên. `/start-task` tra bảng trên + `config.models` rồi truyền `model` khi dispatch. CLI không hỗ trợ chọn model per-subagent → bỏ qua, mọi stage chạy model của phiên; harness vẫn đúng, chỉ không tiết kiệm.

**Đừng tối ưu ngược:** hạ tier của `fsd-reviewer`/`adversary` để tiết kiệm là bỏ tiền mua rủi ro — một AC rơi hoặc một bug lọt tốn nhiều hơn toàn bộ tiền model của task.

### 5.4. Hai chiều rủi ro dùng ngoài việc chọn model

`blastRadius` và `reversibility` không chỉ kéo `taskComplexity`. Chúng còn quyết định **dừng ở đâu để hỏi người**:

| Điều kiện | Harness làm gì |
| --- | --- |
| `reversibility ≥ 3` (phải sửa dữ liệu, hoặc không lùi được) | `technical-planner` nêu thành Risk bắt buộc + **cách rollback**; không có cách rollback → `needs_clarification`, hỏi user trước khi implementer chạy |
| `blastRadius ≥ 3` (một service trở lên) | `adversary` **không** được kết luận PASS chỉ bằng test scope của task — phải kiểm thêm đường lân cận, hoặc ghi rõ giới hạn trong `09` |
| `uncertainty = 2` (phải hỏi BA) | Gate 2 chặn sẵn: Q `blocking` còn `open` thì không qua được (§3) |

Đây là chỗ vector hơn một con số: *"code không nhiều nhưng không lùi được"* là tình huống có thật, và một con số 42 không nói ra được điều đó.

### 5.5. Đo lại sau khi chạy: `attempts`

Vector là **ước lượng trước**. Thứ duy nhất đo được **sau** là task phải làm lại bao nhiêu lần.

`task.agent.json → attempts` đếm số lần mỗi stage thực sự chạy. Tối ưu là `1`. Mỗi lần gate trả về là `+1`:

```json
"attempts": { "fsd_write": 1, "fsd_review": 2, "technical_plan": 1, "implementation": 2 }
```

Đọc nó theo cặp — chỗ bị trả về nói ra chỗ hỏng thật:

| Dấu hiệu | Nghĩa |
| --- | --- |
| `fsd_review` ≥ 2 | FSD viết thiếu, hoặc yêu cầu vốn mơ hồ — `uncertainty` trong vector chấm thấp hơn thực tế |
| `technical_plan` ≥ 2 | AC chưa đủ rõ để lập plan; Gate 2 qua quá dễ |
| `implementation` ≥ 2 | plan sai chỗ sửa, hoặc scope Gate 3 thiếu |
| `adversarial_review` ≥ 2 | evidence lần đầu không tái lập được — chỗ này đúng là việc của Gate 5 |

`attempts` ≥ 3 ở một stage → validator cảnh báo. Không phải lỗi (có task khó thật), nhưng đó là tín hiệu đáng đọc khi chỉnh prompt hoặc khi nên tách task.

**Retry budget có răng — và không tin lời khai.** `attempts` do coordinator ghi, mà coordinator chính là actor sẽ lặp nếu nó lặp; không ai tự ghi `attempts: 7` để tố cáo mình. Nên validator đếm **block handoff** trong `.agent-memory/{role}.md` — append-only (SharedRules §4), role không xoá được:

| Điều kiện | Mức |
| --- | --- |
| số block > `attempts[stage]` đã khai | **warning** — rework bị khai thiếu |
| số block ≥ `retryBudget` (mặc định 4) | **error** — hết ngân sách, tách task hoặc sửa spec, đừng retry tiếp |

Đây là chỗ duy nhất harness đo được rework một cách độc lập với lời khai. `retryBudget` khai ở `harness.config.json`.

**Hết budget thì đi đâu: `status = split`.** "Tách task" phải có cách nói ra — không thì task kẹt cứng: doc là append-only nên không xoá bớt block được, hạ `attempts` là khai man (validator đối chiếu với số block), còn `done` thì Gate 4/5 đòi evidence chưa có. Mọi commit chạm vào đều đỏ, và gate mà lối đi duy nhất là `--no-verify` là gate sắp chết.

| Điều kiện | Mức |
| --- | --- |
| `status = split` + `splitInto` ≥2 taskId | budget xuống **warning** — giữ lại làm lịch sử |
| `status = split` thiếu `splitInto` (hoặc chỉ 1) | **error** — "tách" mà không tách là đổi tên cho việc bỏ cuộc |

`split` không nằm trong `gate4Statuses` nên không bị đòi evidence — nó chưa từng ship. Đây là lối thoát **có tên và để lại dấu vết**, không phải cửa sau: `--calibrate` đếm task `split` như tín hiệu `scope` bị chấm thấp ở bootstrap.

**Context bleed — luật `/clear` có thêm một phép đo.** Mỗi stage chỉ đọc artifact **của chính nó** (`03` đọc `02`, không đọc `01`), nên `telemetry[].inputTokens` phải **dao động quanh một mức**. Không clear ngữ cảnh thì lịch sử hội thoại cộng dồn — tăng đơn điệu, stage sau luôn lớn hơn stage trước. ≥4 dispatch tăng đơn điệu và cuối ≥ 2.5× đầu → **warning**.

Warning chứ không error: task khó thật cũng có thể tăng, và `08` dán output máy thì to hợp lệ. Chuỗi dao động — dù tổng lớn — không bị báo. CLI không báo token thì im lặng, không đoán.

**Dùng nó để sửa vector, đừng để nó nằm im.** Task nào cũng `implementation: 2` thì hoặc `scope` đang bị chấm thấp, hoặc Gate 3 chưa liệt kê đủ file. Đó là dữ liệu thật để hiệu chỉnh §5.1, thay cho việc đoán trọng số.

### 5.6. Đóng vòng: `outcome` + `--calibrate`

`vector` là ước lượng **trước**, `attempts` là rework **trong** quá trình. Cả hai đều không biết task có thật sự ổn sau khi ship hay không. Thứ đó là `outcome`, điền khi task đóng:

```json
"outcome": {
  "escapedBugs": 1,
  "reworkAfterReview": 0,
  "closedAt": "2026-09-10",
  "note": "AC-03 thiếu trường hợp user không có phòng ban"
}
```

- `escapedBugs` — bug tìm thấy **sau** khi task rời harness (QC, staging, production). `> 0` nghĩa là gate đã cho qua thứ lẽ ra phải chặn.
- `reworkAfterReview` — số lần task quay lại sửa code sau `reviewing`.
- `note` — một dòng: ước lượng đã bỏ sót gì.

Không điền thì harness không học được gì. Đây là điểm duy nhất con người phải nhập tay, và là điểm đắt nhất nếu bỏ qua — nên `status = done` mà thiếu `closedAt` là **error**, không phải warning. (Warning thì pre-commit chạy `--no-warn` không bao giờ chặn, và vòng lặp học chết trong khi mọi gate vẫn xanh.) Task tạo **trước** `acTrace.since` vẫn chỉ là warning — nó có trước harness.

`--calibrate` in **độ phủ** ngay dòng đầu (`outcome coverage: 12/20`). Dưới 80% thì finding bên dưới đang dựa trên mẫu thủng — đừng sửa ngưỡng bằng nó.

`telemetry` (coordinator ghi mỗi lần dispatch: stage · tier · model · mốc thời gian) là **nửa còn lại** của câu hỏi ROI. `outcome` nói task có ổn không; `telemetry` nói nó tốn gì. Thiếu nó thì §5.3 ("tier mạnh đáng tiền") là niềm tin không ai kiểm chứng được. Không ghi token/usage — đó là dữ liệu vendor; tên model + wall-clock đã đủ.

**Đọc lại định kỳ** (cuối sprint, hoặc mỗi ~20 task):

```bash
node scripts/validate-tasks.mjs --calibrate
```

Nó đối chiếu ước lượng với kết quả và chỉ ra ngưỡng nào đang sai:

```
trivial  n=1  escaped=1  rework=0  stage-retries=1
normal   n=3  escaped=0  rework=1  stage-retries=3

findings:
• 75% of closed tasks retried "implementation" (4 extra runs) — "scope" is likely scored too low at bootstrap
• 1 bug(s) escaped from "trivial" tasks — the riskFloor thresholds (§5.1.1) are letting real risk through
```

**Nó in bằng chứng, không tự sửa ngưỡng.** Một luật mà harness âm thầm viết lại là luật không ai review — và ngưỡng ở §5.1.1 quyết định model, độ nặng gate, worktree. Con người đọc finding rồi sửa §5.1.1 bằng một commit, có lý do ghi lại. Đó là vòng lặp đóng, không phải tự động hoá mù.

Ba cách sửa thường gặp:

| Finding | Sửa gì |
| --- | --- |
| stage nào đó bị chạy lại nhiều | chiều tương ứng đang chấm thấp — sửa **mô tả thang** ở §5.1 cho rõ hơn, không phải sửa công thức |
| bug lọt từ `trivial` | ngưỡng `riskFloor` quá lỏng — hạ mốc `blastRadius`/`reversibility` ở §5.1.1 |
| nhiều `high` mà không rework, không bug lọt | ngưỡng `high` quá dễ kích hoạt — đang trả tiền model mạnh mà không mua được gì |
| `strong-runs` cao mà escaped=0, rework=0 | cùng chuyện trên nhưng **đo được**: tier mạnh chạy đều mà không mua được gì — hạ tier của stage ít phán đoán trước, đừng hạ `fsd-reviewer`/`adversary` |

> Finding chỉ xuất hiện từ **5 task đã đóng** trở lên. Một task khó bất thường không phải là xu hướng, và một khuyến nghị nghe rất chắc chắn dựa trên n=1 sẽ dẫn tới sửa sai ngưỡng.

---

## 6. Liên kết

- Quy tắc vận hành chi tiết: [`agents/SharedRules.md`](./agents/SharedRules.md) · Global rule: [`Instructions.md`](./Instructions.md)
- Bootstrap & resume: [`HarnessSetup.md`](./HarnessSetup.md) · Chỉ mục: [`README.md`](./README.md)
- Role: [`agents/Orchestrator.md`](./agents/Orchestrator.md) · [`agents/FSDWriter.md`](./agents/FSDWriter.md) · [`agents/FSDReviewer.md`](./agents/FSDReviewer.md) · [`agents/TechnicalPlanner.md`](./agents/TechnicalPlanner.md) · [`agents/FEImplementer.md`](./agents/FEImplementer.md) · [`agents/FEFix.md`](./agents/FEFix.md) · [`agents/Adversary.md`](./agents/Adversary.md)
- Task docs & template: [`tasks/README.md`](./tasks/README.md) · Artifact nguồn: [`srs/`](./srs/README.md) · [`fsd/`](./fsd/README.md) · [`api/`](./api/README.md)
