# HarnessSetup — Bootstrap, MCP, sinh file harness, resume

> Bản dịch của [`../HarnessSetup.md`](../HarnessSetup.md). Lệch nhau → bản tiếng Anh thắng.
> **Vai trò:** luật bootstrap cho AI harness — đọc file này khi mở phiên mới, cấu hình MCP, sinh file harness cho từng tool, hoặc resume một task còn dở.
> **Phạm vi:** mọi bố cục repo khai trong `harness.config.json → repos` — harness nằm trong repo code, hoặc nằm cạnh nhiều repo ([`Agents.md` §0](./Agents.md)).
> **Ngôn ngữ:** viết văn xuôi theo `harness.config.json → docLanguage`; token kỹ thuật giữ nguyên.

---

## 1. Thứ tự nạp (đọc gì lúc khởi động)

**Vòng lặp chính / orchestrator** đọc toàn bộ chuỗi; **subagent role** chỉ đọc bước 2, 4 và 5 (nó có context riêng — xem [`Agents.md`](./Agents.md) §2):

| # | File | Ai đọc | Xác lập điều gì |
| --- | --- | --- | --- |
| 1 | [`README.md`](./README.md) | vòng lặp chính | mục lục + mô hình vận hành |
| 2 | [`Instructions.md`](./Instructions.md) | mọi agent | luật toàn cục |
| 3 | [`Agents.md`](./Agents.md) | vòng lặp chính | vòng đời, 5 gate, chọn implementer, luật rút gọn |
| 4 | [`agents/SharedRules.md`](./agents/SharedRules.md) | mọi agent | handoff, task doc, `status`, token budget (§4/§5/§6/§8/§9) |
| 5 | `agents/{Role}.md` | role đang chạy | quy trình của role đó (bảng ở §5 bên dưới) |

> Đường dẫn là **chữ thường** `docs/agents/` (Linux/CI phân biệt hoa thường). Nếu file ở bước 1–4 thiếu hoặc mâu thuẫn với repo → **dừng** và báo blocker; không bao giờ tự suy ra nội dung thay thế.

---

## 2. Điều kiện môi trường

Kiểm một lần khi onboard máy mới. Toolchain riêng của project: [`../agents/ProjectRules.md` §7](../agents/ProjectRules.md).

| Thành phần | Yêu cầu | Kiểm |
| --- | --- | --- |
| Git + SSH tới git host | đã cấu hình | `git --version` & `ssh -T git@<host>` |
| Node.js (chạy validator) | 20+ | `node -v` |
| Một package manager | npm (đi kèm Node), hoặc yarn / pnpm / bun | `npm -v` / `yarn -v` / `pnpm -v` / `bun -v` |
| Harness CLI | Claude Code hoặc Codex CLI | `claude --version` / `codex --version` |

Cài dependency bằng đúng thứ repo đang dùng (`npm install` / `yarn` / `pnpm install` / `bun install` — lockfile quyết định; đừng trộn). Danh sách lệnh kiểm hợp lệ (one-shot vs watch mode): [`agents/SharedRules.md` §7](./agents/SharedRules.md).

---

## 3. Thiết lập MCP

`install.mjs` ghi một `.mcp.json` khởi đầu ở gốc repo (mẫu: tracker + git host + design tool). Sửa nó cho project của bạn — xoá server không dùng, điền host thật:

```json
{
  "mcpServers": {
    "tracker":  { "type": "http", "url": "https://mcp.clickup.com/mcp" },
    "git-host": { "type": "http", "url": "https://gitlab.example.com/api/v4/mcp" },
    "design":   { "type": "http", "url": "https://mcp.figma.com/mcp" }
  }
}
```

> **URL phải parse được, kể cả khi còn là placeholder.** `https://<git-host>/…` giết CLI bằng `ERR_INVALID_URL` ngay lúc khởi động — trước khi bạn kịp sửa, vì `<` và `>` không hợp lệ trong hostname. Dùng hostname thật như `example.com` cho tới khi có giá trị đúng.

Ba server đó là bộ khung mặc định. Nếu project có UI, khai thêm một server **điều khiển trình duyệt** (BrowserOS neo, Playwright, chrome-devtools…): Gate 5 cần nó để lái app thật theo từng AC ([`agents/Adversary.md`](./agents/Adversary.md), skill `pre-qc-gate` §4a) — thiếu nó thì Gate 5 co lại chỉ còn tầng test. Server chạy local thì khai bằng `command` + `args` thay vì `type` + `url`.

Đừng khai server chỉ để cho có: mỗi server kết nối là một khối tool nằm trong context ở **mọi lượt**, kể cả lượt không dùng tới — xem ngân sách ở [`agents/SharedRules.md` §8](./agents/SharedRules.md). MCP filesystem/shell là thừa hẳn; CLI đã có sẵn.

`.mcp.json` thuộc **phạm vi project**: commit nó thì cả team dùng chung một khai báo, không ai phải `claude mcp add` bằng tay. Sau khi sửa, gõ `/mcp` trong phiên để hoàn tất OAuth cho từng server, và kiểm bằng `claude mcp list`.

Mỗi server để làm gì, cộng luật "không bao giờ bịa dữ liệu MCP": [`../agents/ProjectRules.md` §1](../agents/ProjectRules.md). Kỷ luật payload (summary-first, metadata-first): [`agents/SharedRules.md` §8](./agents/SharedRules.md).

> Subagent **không** khai `tools:` — chúng thừa hưởng mọi tool của phiên, nên đổi tracker (ClickUp → Jira/Linear) chỉ là sửa `.mcp.json` và ProjectRules §1, không bao giờ phải sửa file role.

> **Tuyệt đối không commit** token, cookie, hay `.claude.json` — xem [`Instructions.md` §4](./Instructions.md).

---

## 4. Sinh file harness cho từng tool

Luật cốt lõi: **merge, không đè** — chỉ thay vùng giữa marker `SPEC-HARNESS:START` … `SPEC-HARNESS:END`; những gì user viết ngoài marker được giữ nguyên.

| Tool | Đường dẫn | Nội dung |
| --- | --- | --- |
| Claude Code | `.claude/agents/{role}.md` (7 file) | file ngắn trỏ về `docs/agents/{Role}.md`, marker dạng HTML comment |
| Codex | `.codex/AGENTS.md` + `.codex/agents/{role}.toml` (7 file) | tương đương, marker `# SPEC-HARNESS:START` |

Bảy `{role}`: `orchestrator`, `fsd-writer`, `fsd-reviewer`, `technical-planner`, `implementer`, `fixer`, **`adversary`**.

> Không sinh `adversary` là **âm thầm gỡ mất Gate 5** — harness vẫn chạy, vẫn báo PASS, chỉ là không còn ai kiểm bằng chứng của implementer. Đếm đủ bảy file trước task đầu tiên.

Ràng buộc khi sinh:

- **Không** đụng `.claude/settings.json` / `.claude/settings.local.json` trong lúc *sinh file role*. Installer ghi `settings.json` **một lần** (deny-list cho các lệnh phá cây làm việc — [`Instructions.md` §1](./Instructions.md)) rồi không bao giờ ghi đè nữa; đó là adapter của project, không phải thứ agent sửa.
- **Không** đụng skill riêng của project trong `.claude/skills/` (ngoài các skill do harness ship).
- Sinh lại chỉ thay vùng giữa marker; phần ngoài được ghép lại nguyên vẹn.
- File role là "con trỏ" — quy trình thật nằm ở `docs/agents/{Role}.md`, tránh hai bản trôi lệch nhau.

---

## 5. Tra cứu file role

| Role | File quy trình |
| --- | --- |
| `orchestrator` | [`agents/Orchestrator.md`](./agents/Orchestrator.md) |
| `fsd-writer` | [`agents/FSDWriter.md`](./agents/FSDWriter.md) |
| `fsd-reviewer` | [`agents/FSDReviewer.md`](./agents/FSDReviewer.md) |
| `technical-planner` | [`agents/TechnicalPlanner.md`](./agents/TechnicalPlanner.md) |
| `implementer` | [`agents/Implementer.md`](./agents/Implementer.md) |
| `fixer` | [`agents/Fixer.md`](./agents/Fixer.md) |
| `adversary` | [`agents/Adversary.md`](./agents/Adversary.md) |

Artifact tham chiếu (chỉ đọc, không sửa): [`srs/README.md`](./srs/README.md) · [`fsd/README.md`](./fsd/README.md) · [`api/README.md`](./api/README.md).

---

## 6. Lệnh khởi đầu an toàn (chỉ đọc, chạy đầu phiên)

```bash
pwd                              # đúng gốc repo
ls docs                          # README/HarnessSetup/Instructions/Agents + agents/ srs/ fsd/ api/ tasks/
git status --short --branch      # nhánh hiện tại + thay đổi chưa commit
claude mcp list                  # các server trong .mcp.json đã kết nối
```

Luật nhánh làm việc (công thức đặt tên, `--ff-only`, ngoại lệ nhánh do user quản): [`agents/SharedRules.md` §3](./agents/SharedRules.md).

---

## 7. Resume một task còn dở

Task doc nằm ở `docs/tasks/sprint-{n}/{taskId}-{slug}/` (bố cục: [`tasks/README.md`](./tasks/README.md)). Cách resume:

1. **Đọc trạng thái:** `task.agent.json` → `currentStage`, `status`, `branch` (+ `branchActual` nếu có), `agents.{role}.status`.
2. **Đọc handoff:** `.agent-memory/{role}.md` của role khớp `currentStage` → input, quyết định, rủi ro, bằng chứng, "next agent", cờ continue.
3. **Kiểm lại gate** theo vòng đời ở [`Agents.md`](./Agents.md) §2.
4. **Tiếp tục đúng chỗ:** `blocked` / `needs_clarification` → đọc blocker, chờ user/BA gỡ; `in_progress` → dispatch lại đúng subagent role từ chỗ nó dừng.
5. **Append, không ghi đè:** mọi cập nhật doc / `.agent-memory` đều thêm một heading `## Update — YYYY-MM-DD` mới. Heading đó là **marker cấu trúc** validator dùng để tách, nên nó giữ tiếng Anh (hoặc `## Cập Nhật` nếu đang dùng sẵn) bất kể `docLanguage`.
6. **Đồng bộ checkout:** làm trên nhánh ghi trong `task.agent.json` (`branchActual` nếu có, không thì `branch`).

> `task.agent.json` không có field **token/usage** (đó là dữ liệu nhà cung cấp). Nó có `telemetry`: stage, hạng, tên model, mốc thời gian — đủ để `--calibrate` cân chi phí với kết quả ([`Agents.md` §5.6](./Agents.md)) mà không lộ số token.

---

## 8. Không bao giờ commit secret

Xem [`Instructions.md` §4](./Instructions.md) — nguồn sự thật duy nhất. Trước khi đề xuất commit: `git status --short`, và xác nhận không có file nhạy cảm nào được stage.
