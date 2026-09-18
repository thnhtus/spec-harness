# SharedRules — Quy tắc chung cho mọi agent (kernel, nguồn chuẩn duy nhất)

> **Tài liệu:** `docs/agents/SharedRules.md` — **nơi định nghĩa duy nhất** (normative home) cho: format handoff (§4), quy ước task doc (§5), giá trị `status` (§6), ngân sách ngữ cảnh/artifact (§8), và truy vết AC + amendment spec (§9). Tài liệu khác **link về đây**, không chép lại.
> **Phần thuộc về project** — nguồn truth/tracker, guardrail source, quy tắc nhánh, lệnh kiểm tra — định nghĩa tại [`ProjectRules.md`](./ProjectRules.md). Kernel không biết project dùng stack nào.
> **Thứ tự ưu tiên khi xung đột:** [`../Instructions.md`](../Instructions.md) > SharedRules > ProjectRules > role file (trừ khi role file ghi rõ "override").
> **Ngôn ngữ:** Tiếng Việt; token kỹ thuật (ENUM, ID, lệnh, đường dẫn) giữ nguyên gốc.

---

## 1–3, 7 — xem `ProjectRules.md`

Bốn mục dưới đây phụ thuộc project, nằm ở [`ProjectRules.md`](./ProjectRules.md):

| Mục | Nội dung |
| --- | --- |
| §1 | Nguồn sự thật qua tracker/design MCP — không đoán |
| §2 | Architecture guardrails cho source |
| §3 | Quy tắc nhánh + worktree |
| §7 | Lệnh kiểm tra hợp lệ (one-shot vs watch-mode) |

Tham chiếu chéo trong kernel ghi `SharedRules §1/§2/§3/§7` vẫn đúng — đọc ở `ProjectRules.md`.

---

## 4. Định dạng handoff — `.agent-memory/{role}.md`

Mỗi role kết thúc stage phải append một block (bắt đầu bằng `### YYYY-MM-DD — {role}`), **tối đa 30 dòng**:

```markdown
## Next Handoff
- **Inputs**: nguồn đã dùng (URL task tracker, node thiết kế, ID FR-/FSD-, file đã đọc)
- **Decisions**: quyết định đã chốt + lý do ngắn
- **Risks**: rủi ro / giả định / "unavailable"
- **Changed Files**: path tương đối (rỗng nếu chưa đụng code)
- **Evidence**: bằng chứng (output test, trích AC, node thiết kế)
- **Next agent**: role kế tiếp (hoặc "skipped: <reason>")
- **Continue automation**: yes | no (no ⇒ kèm lý do + status)
```

Quy tắc:

- `Continue automation: no` khi gate fail hoặc cần BA/user → đặt `status` tương ứng và ghi blocker rõ.
- **Dừng phải kêu to:** khi dừng vì gate fail / blocker, **message cuối cùng gửi user** phải nêu đủ 4 ý: (1) gate nào fail, (2) lý do, (3) file đã ghi blocker, (4) user/BA cần làm gì để mở khoá. Dừng im lặng = lỗi quy trình.
- Append-only — không xoá block cũ.

---

## 5. Quy ước task doc

Task doc nằm tại `docs/tasks/sprint-{n}/{taskId}-{slug}/` (layout + template: [`../tasks/README.md`](../tasks/README.md)).

| File | Người ghi | Nội dung |
| --- | --- | --- |
| `task.agent.json` | orchestrator tạo; mọi role cập nhật | Metadata máy đọc (§6) |
| `00-Metadata.md` | orchestrator | Tóm tắt task, link tracker/thiết kế, sprint, branchType |
| `01-FSD.md` | fsd-writer | FSD IEEE cấp task (skill `document-to-ieee-srs`) |
| `02-FSD-Review.md` | fsd-reviewer | AC, câu hỏi BA, risk |
| `03-Technical-Plan.md` | technical-planner | File sẽ đổi, test plan, checklist, risk |
| `06-FE-Implementation-Notes.md` | fe-implementer / fe-fix | Quyết định khi code, file đã sửa |
| `08-Test-Evidence.md` | fe-implementer / fe-fix | Output thật của lệnh ProjectRules §7 |
| `09-Adversarial-Review.md` | adversary | Kiểm đối kháng: tự chạy lại lệnh, soi diff + test, finding (Gate 5) |
| `.agent-memory/{role}.md` | từng role | Handoff (§4) |

- **Append-only, tiếng Việt**, ID kỹ thuật giữ nguyên (`FR-…`, `FSD-<MOD>-nnn`, ENUM, path, lệnh).

**Văn xuôi phải đọc được — dùng skill `humanizer`.** Task doc có người đọc: BA đọc `02`, dev khác đọc `06`, reviewer đọc `09`. Trước khi đóng stage, chạy `humanizer` trên **phần văn xuôi** mình vừa viết:

| Áp cho | Không áp cho |
| --- | --- |
| `02` §3.1 business intent · cột lý do trong các bảng | `01` requirement — `shall`/`phải` là **construct bắt buộc** của IEEE 29148, formulaic có chủ đích |
| `06` Decisions · Plan Deviations · Known Limitations | ID, path, lệnh, output test dán nguyên văn |
| `09` mô tả finding · mục "đã soi những gì" | Bảng thuần dữ liệu (AC coverage, Changed Files) |
| Block handoff `.agent-memory/` · message báo gate fail | |

Hay gặp nhất trong doc của agent: câu chốt một dòng lặp lại ý vừa nói, "không phải X mà là Y", bộ ba gượng, bold trang trí ở mọi đầu mục, và mở bài dàn cảnh trước khi vào việc. Cắt chúng làm doc ngắn lại — ngắn thì đỡ chạm trần §8.
- **Không sửa** nội dung `srs/`, `fsd/`, `api/` — chỉ tham chiếu. `docs/api/` sinh tự động nếu project có pipeline riêng (ProjectRules §1).
- **Không bịa** số liệu test (§7).
- `task.agent.json` **không** có trường token/usage (dữ liệu vendor). Trường `telemetry` (stage · tier · model · thời gian) thì **có** — coordinator ghi khi dispatch, `--calibrate` đọc để đối chiếu chi phí với kết quả ([`../Agents.md` §5.6](../Agents.md)).

---

## 6. Giá trị `status` trong `task.agent.json`

Trường chính: `taskId, taskName, clickupUrl, repoName, sprintNumber, developer, branchType, layer, taskComplexity, currentStage, status, branch, docsPath, agents.{role}.status, createdAt, updatedAt`. Trường **tuỳ chọn**: `branchActual` (nhánh thật khi khác `branch` quy ước — §3), `parentTaskId` (task cha trên tracker nếu có), `complexity` (vector — [`../Agents.md` §5.1](../Agents.md)), `attempts` (số lần mỗi stage chạy lại — §5.5), `outcome` (kết quả sau khi ship — §5.6, **người điền khi đóng task**).

`taskComplexity ∈ {trivial, normal, high}` — **dẫn xuất** từ `complexity.vector` bằng công thức [`../Agents.md` §5.1.1](../Agents.md), không tự phán; validator tính lại và chặn nếu lệch. Quyết định độ nặng Gate 1/2 (§5.2), model mỗi stage (§5.3), và điểm dừng hỏi người (§5.4). Role sau chỉ được **nâng**, không được hạ.

| `status` | Khi nào | Hành động |
| --- | --- | --- |
| `DRAFT` | bootstrap chưa đủ metadata | bổ sung trước khi chạy tiếp |
| `in_progress` | stage đang chạy bình thường | tiếp tục workflow |
| `blocked` | gate fail vì lý do kỹ thuật | ghi blocker, dừng, báo to (§4) |
| `needs_clarification` | thiếu dữ liệu MCP / AC mơ hồ | ghi câu hỏi, chờ BA/user, báo to (§4) |
| `reviewing` | mọi gate pass **kể cả Gate 5**, diff sạch | chờ user duyệt commit/push + MR |
| `mr_created` | user đã push, MR đã tạo | theo dõi review/CI |
| `done` | MR merged | đóng task |

Chỉ user chuyển `reviewing → mr_created` (push + MR thật).

**Ghi `task.agent.json` phải nguyên tử.** Mọi role ghi đè file này, và nó là thứ duy nhất resume đọc để biết task đang ở đâu ([`../HarnessSetup.md` §7](../HarnessSetup.md)). Crash hoặc Ctrl-C giữa lúc ghi để lại JSON hỏng — validator `exit 2`, resume mù, task chết cứng. Ghi file tạm cùng thư mục rồi đổi tên:

```bash
tmp="$(dirname "$F")/.task.agent.json.tmp"
printf '%s' "$NEW_JSON" > "$tmp" && mv "$tmp" "$F"     # rename(2) nguyên tử trên cùng filesystem
```

Cùng thư mục là bắt buộc — `mv` qua filesystem khác là copy, hết nguyên tử. Sửa file tại chỗ hoặc ghi đè trực tiếp là mở đúng khe đó ra.

Khi chuyển sang `done`: điền `outcome` ([`../Agents.md` §5.6](../Agents.md)) — `escapedBugs`, `reworkAfterReview`, `closedAt`. Bỏ trống thì `--calibrate` không có gì để đối chiếu, và ngưỡng §5.1.1 mãi là phỏng đoán ban đầu.

---

## 8. Ngân sách ngữ cảnh & artifact (chống phình token)

> **Kiểm tra tự động:** `node scripts/validate-tasks.mjs` enforce các trần dưới đây + schema `task.agent.json` + file bắt buộc theo stage + evidence Gate 4. Dùng trong pre-commit/CI; chi tiết: [`../tasks/README.md` §6](../tasks/README.md).

**Trần kích thước artifact** (đếm theo dòng; vượt trần = gate FAIL của stage đó).

> **Task bị gate trả về:** doc là append-only (§5) và resume phải append `## Cập Nhật — …` ([`../HarnessSetup.md` §7](../HarnessSetup.md)) — nên sau hai vòng, cap cả file thành bẫy đóng: vượt trần mà không được phép cắt. Vì vậy khi doc đã có block `## Cập Nhật`, trần áp cho **block mới nhất** (phần role hiện tại viết, và là phần duy nhất nó được quyền rút gọn); tổng file vượt trần chỉ còn là **warning** nhắc tách appendix.

| Artifact | Trần | Khi vượt |
| --- | --- | --- |
| `00-Metadata.md` | ≤ 80 dòng | cắt gọn — metadata không phải spec |
| `01-FSD.md` | ≤ 250 dòng | phần chi tiết phụ → `01a-FSD-Appendix.md` (stage sau **không** tự đọc appendix) |
| `02-FSD-Review.md` | ≤ 150 dòng | như trên → `02a-Review-Appendix.md` |

> **Không bao giờ đẩy sang appendix:** bảng **AC** và **Amendment log** (§9). Appendix là phần stage sau *không đọc* — AC hoặc amendment nằm ở đó = vô hình với planner/implementer và validator. Chạm trần → cắt phần khảo sát/diễn giải, giữ nguyên hai bảng này.
| `03-Technical-Plan.md` | ≤ 200 dòng | tách phần khảo sát dài ra appendix |
| Block handoff `.agent-memory/` | ≤ 30 dòng / block | viết cô đọng hơn |

**Kỷ luật MCP payload:**

> **Không hardcode tên tool.** Kernel không biết project cắm MCP server nào — ClickUp hay Jira, Figma hay Penpot, GitLab hay GitHub. Agent **tự tìm tool phù hợp** trong danh sách tool của phiên, theo vai trò khai ở [`ProjectRules.md` §1](./ProjectRules.md). Tên tool có tiền tố theo server (`mcp__<server>__<tool>`), nên viết cứng một tên là khoá harness vào đúng một tracker.
>
> Cách tìm: khớp **vai trò → động từ** trong tên tool. Cần đọc task từ tracker → tool của server tracker có `get`/`read`/`task` trong tên. Cần tìm → `search`. Cần bình luận → `comment`. Không chắc tool nào đúng, hoặc không có tool nào khớp vai trò → **dừng, hỏi user**, không đoán và không bịa dữ liệu thay thế.

Áp cho mọi server, không phụ thuộc tên:

- **Tracker:** gọi bản **summary/rút gọn** trước (tool thường có tham số kiểu `detail_level`, `fields`, hoặc một tool `get` nhẹ riêng); chỉ lấy bản đầy đủ khi summary thiếu thông tin chặn việc. Chỉ mở attachment/ảnh khi mô tả text **không đủ** để viết requirement (ảnh rất tốn token).
- **Design tool:** lấy **metadata trước** để xác định node **nhỏ nhất** liên quan, rồi mới lấy design context của đúng node đó. Không lấy context cho cả page/file. Screenshot chỉ khi hành vi UI là load-bearing và text không mô tả được.
- **Git host:** chỉ truy vấn nhánh/MR của đúng task.

**Kỷ luật đọc tài liệu nội bộ:**

- Chỉ đọc **đúng file** `fsd/` / `api/` / `srs/` mà task chạm tới (tra mục lục trong README từng thư mục trước). **Cấm** đọc cả thư mục.
- Stage sau đọc artifact stage trước **một lần**, không re-đọc nếu không có cập nhật.
- Khi cần trích artifact vào prompt/handoff: trích **ID + 1 dòng**, không dán nguyên đoạn.

---

## 9. Truy vết AC & amendment spec (vòng ngược)

> **Kiểm tra tự động:** `node scripts/validate-tasks.mjs` enforce mục 9.1 khi `status ∈ {reviewing, mr_created, done}`.

### 9.1. Mọi AC phải đi tới tận evidence

Một `AC-nn` xuất hiện trong `02-FSD-Review.md` **bắt buộc** đi hết chuỗi:

```
02 (AC-nn)  →  03 cột "Covers AC"  hoặc  bảng AC-manual
            →  08 bảng "AC coverage": test file :: tên it(...)   hoặc   manual
```

- **Test tự động** là mặc định. Tên `it(...)` của test nên chứa `AC-nn` để grep được ngược từ code.
- **`manual`** chỉ hợp lệ khi AC đó đã được liệt kê ở bảng **AC-manual** của `03-Technical-Plan.md` kèm lý do — không được tự khai `manual` ở `08` để né test.
- AC rơi (không ở `03`) → **Gate 3 FAIL**. AC không có dòng trong bảng AC coverage của `08` → **Gate 4 FAIL**.

### 9.2. Spec sai thì sửa spec, không lệch ngầm

Khi technical-planner hoặc implementer phát hiện một AC / requirement **sai, thiếu, hoặc bất khả thi**:

1. Append một dòng vào **Amendment log** của `02-FSD-Review.md` (và `01-FSD.md` nếu chạm `FSD-<MOD>-nnn`): ngày, ai phát hiện, ID, cũ → mới, lý do.
2. Amendment **đổi phạm vi hoặc ý định nghiệp vụ** → `status = needs_clarification`, dừng chờ BA. Amendment thuần kỹ thuật (diễn đạt sai, ID trỏ nhầm) → ghi log rồi chạy tiếp.
3. Append-only: **không** sửa đè dòng AC gốc — dòng gốc ở lại, amendment ghi bên dưới.

Ship code lệch AC mà không có amendment = lỗi quy trình: FSD tụt xuống thành biên bản lịch sử, không còn là source of truth.