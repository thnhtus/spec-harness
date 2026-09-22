# SharedRules — Luật chung cho mọi agent (kernel, nguồn sự thật duy nhất)

> Bản dịch của [`../../agents/SharedRules.md`](../../agents/SharedRules.md). Lệch nhau → bản tiếng Anh thắng.
> **Tài liệu:** `docs/agents/SharedRules.md` — nơi **chuẩn hoá** cho: định dạng handoff (§4), quy ước task doc (§5), giá trị `status` (§6), ngân sách context/artifact (§8), và truy vết AC + sửa spec (§9). Các tài liệu khác **trỏ về đây**; không chép lại nội dung.
> **Phần thuộc project** — nguồn sự thật/tracker, nguồn guardrail, luật nhánh, lệnh kiểm — định nghĩa ở [`../../agents/ProjectRules.md`](../../agents/ProjectRules.md). Kernel không biết project dùng stack nào.
> **Thứ tự ưu tiên khi xung đột:** [`../Instructions.md`](../Instructions.md) > SharedRules > ProjectRules > file role (trừ khi file role ghi rõ "override").
> **Ngôn ngữ:** viết văn xuôi theo `harness.config.json → docLanguage`; token kỹ thuật (ENUM, ID, lệnh, đường dẫn) giữ nguyên bất kể giá trị đó. Kernel không chọn thay bạn — team nói tiếng Anh thì đặt `"English"`.

---

## 1–3, 7 — xem `ProjectRules.md`

Bốn mục dưới đây phụ thuộc project và nằm ở [`../../agents/ProjectRules.md`](../../agents/ProjectRules.md):

| Mục | Nội dung |
| --- | --- |
| §1 | Nguồn sự thật qua MCP tracker/design — không đoán |
| §2 | Guardrail kiến trúc cho source |
| §3 | Luật nhánh + worktree |
| §7 | Lệnh kiểm hợp lệ (one-shot vs watch mode) |

Các tham chiếu chéo trong kernel ghi `SharedRules §1/§2/§3/§7` vẫn đúng — đọc chúng trong `ProjectRules.md`.

---

## 4. Định dạng handoff — `.agent-memory/{role}.md`

Mỗi role kết thúc một stage phải append một khối (mở đầu bằng `### YYYY-MM-DD — {role}`), **tối đa 30 dòng**:

```markdown
## Next Handoff
- **Inputs**: nguồn đã dùng (URL task tracker, node thiết kế, ID FR-/FSD-, file đã đọc)
- **Decisions**: quyết định đã lấy + lý do ngắn
- **Risks**: rủi ro / giả định / "unavailable"
- **Changed Files**: đường dẫn tương đối (rỗng nếu không đụng code)
- **Evidence**: bằng chứng (output test, trích AC, node thiết kế)
- **Next agent**: role kế tiếp (hoặc "skipped: <lý do>")
- **Continue automation**: yes | no (no ⇒ kèm lý do + status)
```

Luật:

- `Continue automation: no` khi gate fail hoặc cần BA/user → đặt `status` tương ứng và ghi blocker rõ ràng.
- **Dừng thì phải dừng thật to:** khi dừng vì gate fail hay blocker, **tin nhắn cuối cùng gửi user** phải đủ bốn điểm: (1) gate nào fail, (2) vì sao, (3) file nào ghi blocker, (4) user/BA phải làm gì để gỡ. Dừng im lặng là một lỗi quy trình.
- Chỉ-append — không bao giờ xoá khối cũ.

---

## 5. Quy ước task doc

Task doc nằm ở `docs/tasks/sprint-{n}/{taskId}-{slug}/` (bố cục + template: [`../tasks/README.md`](../tasks/README.md)).

| File | Ai viết | Nội dung |
| --- | --- | --- |
| `task.agent.json` | orchestrator tạo; mọi role cập nhật | metadata máy đọc được (§6) |
| `00-Metadata.md` | orchestrator | tóm tắt task, link tracker/design, sprint, branchType |
| `01-FSD.md` | fsd-writer | FSD IEEE cấp task (skill `document-to-ieee-srs`) |
| `02-FSD-Review.md` | fsd-reviewer | AC, câu hỏi BA, rủi ro |
| `03-Technical-Plan.md` | technical-planner | file cần sửa, test plan, checklist, rủi ro |
| `06-Implementation-Notes.md` | implementer / fixer | quyết định trong lúc code, file đã đổi |
| `08-Test-Evidence.md` | implementer / fixer | output thật của các lệnh ProjectRules §7 |
| `09-Adversarial-Review.md` | adversary | kiểm đối kháng: chạy lại lệnh, soi diff + test, findings (Gate 5) |
| `.agent-memory/{role}.md` | từng role | handoff (§4) |

- **Chỉ-append**, văn xuôi theo `docLanguage`, ID kỹ thuật giữ nguyên (`FR-…`, `FSD-<MOD>-nnn`, ENUM, đường dẫn, lệnh).

**Văn xuôi phải đọc được — dùng skill `humanizer`.** Task doc có người đọc: BA đọc `02`, dev khác đọc `06`, reviewer đọc `09`. Trước khi đóng một stage, chạy `humanizer` trên **phần văn xuôi bạn vừa viết**:

| Áp dụng cho | Không áp dụng cho |
| --- | --- |
| `02` §3.1 ý định nghiệp vụ · cột lý do trong bảng | requirement ở `01` — `shall` là **cấu trúc bắt buộc** của IEEE 29148, cố tình công thức |
| `06` Decisions · Plan Deviations · Known Limitations | ID, đường dẫn, lệnh, output test nguyên văn |
| `09` mô tả finding · phần "đã soi những gì" | bảng dữ liệu thuần (AC coverage, Changed Files) |
| khối handoff `.agent-memory/` · thông báo gate fail | |

Các dấu hiệu hay gặp nhất trong doc do agent viết: một câu kết một dòng nhắc lại vừa nói gì, "không phải X mà là Y", bộ ba gượng ép, in đậm trang trí ở mọi heading, và một đoạn dẫn nhập trước khi vào việc. Cắt chúng đi thì doc ngắn lại — mà ngắn thì đỡ áp lực với giới hạn ở §8.
- **Không bao giờ sửa** nội dung `srs/`, `fsd/`, `api/` — chỉ tham chiếu. `docs/api/` sinh tự động nếu project có pipeline riêng (ProjectRules §1).
- **Không bao giờ bịa** số liệu test (§7).
- `task.agent.json` **không** có field token/usage (dữ liệu nhà cung cấp). Nó có `telemetry` (stage · hạng · model · mốc thời gian) — coordinator ghi lúc dispatch và `--calibrate` đọc để cân chi phí với kết quả ([`../Agents.md` §5.6](../Agents.md)).

---

## 6. Giá trị `status` trong `task.agent.json`

Field chính: `taskId, taskName, trackerUrl, repoName, sprintNumber, developer, branchType, layer, taskComplexity, currentStage, status, branch, docsPath, agents.{role}.status, createdAt, updatedAt`. `createdAt` phải ở dạng `YYYY-MM-DD` và được đối chiếu với commit đầu tiên của thư mục — nó quyết định §5.1/§5.6 là lỗi hay cảnh báo, nên một giá trị lùi ngày từng tắt được cả loạt luật ([`../Agents.md` §5.1.2](../Agents.md)). Field **tuỳ chọn**: `branchActual` (nhánh thật khi khác `branch` quy ước — §3), `parentTaskId` (task cha trên tracker, nếu có), `complexity` (vector + `counts`/`questions`/`splitEvaluated` — [`../Agents.md` §5.1](../Agents.md)), `attempts` (mỗi stage chạy lại mấy lần — §5.5), `outcome` (kết quả sau khi ship — §5.6, **người điền khi đóng task**).

`taskComplexity ∈ {trivial, normal, high}` được **suy ra** từ `complexity.vector` bằng công thức ở [`../Agents.md` §5.1.1](../Agents.md), không bao giờ chấm tay; validator tính lại và chặn khi lệch. Nó quyết định Gate 1/2 nặng đến đâu (§5.2), mỗi stage dùng model nào (§5.3), và chỗ workflow dừng lại hỏi người (§5.4). Role sau chỉ được **nâng**, không được hạ.

| `status` | Khi nào | Hành động |
| --- | --- | --- |
| `DRAFT` | bootstrap còn thiếu metadata | điền đủ rồi mới tiếp |
| `in_progress` | một stage đang chạy bình thường | tiếp tục workflow |
| `blocked` | gate fail vì lý do kỹ thuật | ghi blocker, dừng, báo to (§4) |
| `needs_clarification` | thiếu dữ liệu MCP / AC mơ hồ | ghi câu hỏi, chờ BA/user, báo to (§4) |
| `reviewing` | mọi gate đã qua **kể cả Gate 5**, diff sạch | chờ user duyệt commit/push + MR |
| `mr_created` | user đã push, MR đã có | theo dõi review/CI |
| `done` | MR đã merge | đóng task |

Chỉ user mới chuyển `reviewing → mr_created` (push thật + MR thật).

**Ghi `task.agent.json` theo kiểu atomic** — ghi file `.tmp` **trong cùng thư mục** rồi `mv`; không ghi đè tại chỗ (crash giữa chừng để lại JSON hỏng và resume mù luôn):

```bash
printf '%s' "$NEW" > "$(dirname "$F")/.tmp.json" && mv "$(dirname "$F")/.tmp.json" "$F"
```

Khi chuyển sang `done`: điền `outcome` ([`../Agents.md` §5.6](../Agents.md)) — `escapedBugs`, `reworkAfterReview`, `closedAt`. Để trống thì `--calibrate` không có gì để so, và các ngưỡng ở §5.1.1 nằm nguyên ở giá trị phỏng đoán ban đầu mãi mãi.

---

## 8. Ngân sách context & artifact (giữ token thấp)

> **Được ép tự động:** `node scripts/validate-tasks.mjs` áp các giới hạn dưới đây cộng schema `task.agent.json`, file bắt buộc theo stage, và bằng chứng Gate 4. Dùng nó trong pre-commit/CI; chi tiết: [`../tasks/README.md` §6](../tasks/README.md).

**Giới hạn kích thước artifact** (đếm theo dòng; vượt là FAIL gate của stage đó).

> **Khi một gate đẩy task quay lại:** doc chỉ-append (§5) và lúc tiếp tục phải append heading `## Update — …` (validator tách theo `## Update` hoặc `## Cập Nhật`; marker này không theo `docLanguage`) ([`../HarnessSetup.md` §7](../HarnessSetup.md)) — nên sau hai vòng, giới hạn tính trên cả file trở thành cái bẫy đóng kín: vượt trần mà lại không được cắt. Vì vậy, một khi doc đã có khối `## Update`, giới hạn áp cho **khối mới nhất** (phần role hiện tại viết, và là phần duy nhất nó được rút ngắn); tổng cả file vượt trần chỉ còn là **cảnh báo** gợi ý tách phụ lục.

**`08`/`09` không có trần cứng — có chủ đích.** Chúng chứa **output máy nguyên văn**, không phải văn xuôi role viết: khi `01`/`02`/`03` chạm trần, bạn cắt phần giải thích và phần cốt lõi vẫn sống; khi `08` chạm trần thì thứ duy nhất còn để cắt là bằng chứng. Và [`../Instructions.md` §5](../Instructions.md) không thương lượng: dán nguyên văn. Đẩy output sang phụ lục cũng không xong — phụ lục theo định nghĩa là phần các stage sau *không đọc*, trong khi `adversary` **bắt buộc** phải so output nó tự chạy với thứ `08` khai ([`./Adversary.md` §3.2](./Adversary.md)), và validator chỉ đếm bằng chứng nằm trong code fence của chính file đó. Đặt trần ở đây là mua một file ngắn hơn bằng cách làm loãng bằng chứng — ngược hẳn với mục đích của Gate 4/5.

Thay vào đó `08`/`09` có **ngưỡng cảnh báo** (`lineWarn`, mặc định 400 dòng): không chặn, chỉ báo. `08` chạm 400 dòng thường nghĩa là task đang gánh quá nhiều AC — đó là tín hiệu **tách task**, không phải viết ít lại.

**Khi chạy lại, đọc khối mới nhất, không đọc cả lịch sử.** Một stage bị gate đẩy về (`attempts > 1`) chỉ cần khối `## Update` mới nhất của `06`/`08`/`09` cộng handoff cuối; vòng trước đã được chưng cất vào đó rồi. Đọc lại tất cả là trả tiền cho cùng một lịch sử nhiều lần — file vẫn dài (nó là bằng chứng, phải vậy), nhưng không ai phải đọc lại hết.

| Artifact | Trần | Vượt thì |
| --- | --- | --- |
| `00-Metadata.md` | ≤ 80 dòng | cắt bớt — metadata không phải spec |
| `01-FSD.md` | ≤ 250 dòng | chuyển chi tiết phụ sang `01a-FSD-Appendix.md` (stage sau **không** đọc phụ lục) |
| `02-FSD-Review.md` | ≤ 150 dòng | tương tự → `02a-Review-Appendix.md` |

> **Tuyệt đối không chuyển sang phụ lục:** bảng **AC** và **Amendment log** (§9). Phụ lục là phần stage sau *không đọc* — một AC hay một amendment nằm đó là vô hình với planner, implementer và validator. Vượt trần → cắt phần khảo sát/giải thích, giữ nguyên hai bảng này.
| `03-Technical-Plan.md` | ≤ 200 dòng | chuyển phần khảo sát dài sang phụ lục |
| khối handoff `.agent-memory/` | ≤ 30 dòng / khối | viết gọn hơn |

**Kỷ luật payload MCP:**

> **Không bao giờ hardcode tên tool.** Kernel không biết project cắm MCP server nào — ClickUp hay Jira, Figma hay Penpot, GitLab hay GitHub. Agent **tự tìm tool phù hợp** trong danh sách tool của phiên, dựa theo vai trò khai ở [`../../agents/ProjectRules.md` §1](../../agents/ProjectRules.md). Tên tool có tiền tố theo server (`mcp__<server>__<tool>`), nên viết cứng một tên là khoá harness vào đúng một tracker.
>
> Cách tìm: khớp **vai trò → động từ** trong tên tool. Cần đọc task từ tracker → một tool trên server tracker có `get`/`read`/`task` trong tên. Cần tìm kiếm → `search`. Cần comment → `comment`. Không chắc tool nào đúng, hoặc không tool nào khớp vai trò → **dừng và hỏi user**; không đoán, không bịa dữ liệu thay thế.

Điều này áp cho mọi server, dù tên là gì:

- **Tracker:** gọi dạng **tóm tắt/rút gọn** trước (tool thường có tham số `detail_level` hay `fields`, hoặc một `get` nhẹ riêng); chỉ lấy bản đầy đủ khi bản tóm tắt thiếu thứ chặn công việc. Chỉ mở attachment/ảnh khi mô tả chữ **không đủ** để viết requirement (ảnh rất đắt token).
- **Design tool:** lấy **metadata trước** để xác định node liên quan **nhỏ nhất**, rồi mới lấy design context đúng node đó. Không bao giờ lấy context cho cả page/file. Screenshot chỉ khi hành vi UI là then chốt và chữ không mô tả nổi.
- **Git host:** chỉ truy vấn nhánh/MR của task này.

**Kỷ luật đọc tài liệu nội bộ:**

- Chỉ đọc **đúng** những file `fsd/` / `api/` / `srs/` mà task đụng tới (xem mục lục trong README của từng thư mục trước). Đọc cả thư mục là **bị cấm**.
- Stage sau đọc artifact của stage trước **một lần**, và không đọc lại nếu không có cập nhật.
- Khi trích artifact vào prompt/handoff: trích **ID + một dòng**, không dán cả đoạn.

---

## 9. Truy vết AC & sửa spec (vòng quay lại)

> **Được ép tự động:** `node scripts/validate-tasks.mjs` áp §9.1 khi `status ∈ {reviewing, mr_created, done}`.

### 9.1. Mọi AC phải đi tới bằng chứng

Một `AC-nn` xuất hiện trong `02-FSD-Review.md` **bắt buộc** đi hết chuỗi:

```
02 (AC-nn)  →  cột "Covers AC" ở 03  hoặc  bảng AC-manual
            →  bảng "AC coverage" ở 08: file test :: tên it(...)   hoặc   manual
```

- **Test tự động** là mặc định. Tên `it(...)` nên chứa `AC-nn` để grep ngược từ code.
- **`manual`** chỉ hợp lệ khi AC đó có trong bảng **AC-manual** của `03-Technical-Plan.md` kèm lý do — không được khai `manual` ở `08` để né viết test.
- AC bị rơi (không có trong `03`) → **Gate 3 FAIL**. AC không có dòng trong bảng AC coverage của `08` → **Gate 4 FAIL**.

### 9.2. Spec sai thì sửa spec, đừng trôi lệch trong im lặng

Khi technical-planner hay implementer phát hiện một AC/requirement **sai, thiếu, hoặc bất khả thi**:

1. Append một dòng vào **Amendment log** trong `02-FSD-Review.md` (và `01-FSD.md` nếu đụng một `FSD-<MOD>-nnn`): ngày, ai phát hiện, ID, cũ → mới, lý do.
2. Nếu amendment **đổi phạm vi hay ý định nghiệp vụ** → `status = needs_clarification`, dừng và chờ BA. Amendment thuần kỹ thuật (câu chữ sai, ID trỏ nhầm) → ghi log và đi tiếp.
3. Chỉ-append: **không** ghi đè dòng AC gốc — nó ở lại, amendment nằm bên dưới.

Ship code lệch khỏi một AC mà không có amendment là lỗi quy trình: FSD thoái hoá thành biên bản lịch sử và thôi làm nguồn sự thật.
