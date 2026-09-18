# HarnessSetup — Bootstrap, MCP, sinh harness, resume

> **Vai trò:** quy tắc bootstrap cho AI harness — đọc khi khởi động phiên mới, cấu hình MCP, sinh file harness per-tool, hoặc resume task dang dở.
> **Phạm vi:** mọi bố cục repo khai ở `harness.config.json → repos` — harness nằm trong repo code, hoặc ngang hàng nhiều repo ([`Agents.md` §0](./Agents.md)).
> **Ngôn ngữ:** Tiếng Việt; token kỹ thuật giữ nguyên gốc.

---

## 1. Load order (thứ tự đọc khi khởi động)

**Main loop / orchestrator** đọc đủ chuỗi; **role subagent** chỉ đọc bước 2 + 4 + 5 (context riêng — xem [`Agents.md`](./Agents.md) §2):

| # | File | Ai đọc | Đọc để biết |
| --- | --- | --- | --- |
| 1 | [`README.md`](./README.md) | main loop | chỉ mục + mô hình vận hành |
| 2 | [`Instructions.md`](./Instructions.md) | mọi agent | luật toàn cục |
| 3 | [`Agents.md`](./Agents.md) | main loop | lifecycle, 5 gate, chọn implementer, skip rule |
| 4 | [`agents/SharedRules.md`](./agents/SharedRules.md) | mọi agent | handoff, task doc, `status`, ngân sách token (§4/§5/§6/§8/§9) |
| 5 | `agents/{Role}.md` | role đang chạy | quy trình của đúng role (bảng §5 bên dưới) |

> Đường dẫn là **chữ thường** `docs/agents/` (case-sensitive trên Linux/CI). File bước 1–4 thiếu hoặc mâu thuẫn repo → **dừng**, báo blocker; không tự suy diễn nội dung thay thế.

---

## 2. Environment prerequisites

Kiểm tra một lần khi onboard máy mới. Toolchain cụ thể của project: [`agents/ProjectRules.md` §7](./agents/ProjectRules.md).

| Thành phần | Yêu cầu | Kiểm tra |
| --- | --- | --- |
| Git + SSH tới git host | đã cấu hình | `git --version` & `ssh -T git@<host>` |
| Node.js (chạy validator) | 20+ | `node -v` |
| npm | đi kèm Node | `npm -v` |
| Harness CLI | Claude Code hoặc Codex CLI | `claude --version` / `codex --version` |

Cài dependency: `npm install`. Danh sách lệnh kiểm tra hợp lệ (one-shot vs watch-mode): [`agents/SharedRules.md` §7](./agents/SharedRules.md).

---

## 3. MCP setup

`install.sh` sinh sẵn `.mcp.json` ở repo root (mẫu: tracker + git host + design tool). Sửa nó cho đúng project — xoá server không dùng, điền host thật:

```json
{
  "mcpServers": {
    "tracker":  { "type": "http", "url": "https://mcp.clickup.com/mcp" },
    "git-host": { "type": "http", "url": "https://gitlab.example.com/api/v4/mcp" },
    "design":   { "type": "http", "url": "https://mcp.figma.com/mcp" }
  }
}
```

> **URL phải parse được, kể cả khi đang là placeholder.** `https://<git-host>/…` làm CLI chết bằng `ERR_INVALID_URL` ngay lúc khởi động — trước cả khi bạn kịp sửa, vì `<` `>` không hợp lệ trong hostname. Dùng một hostname thật như `example.com` cho tới khi điền giá trị đúng.

`.mcp.json` là **project-scoped**: commit nó thì cả team dùng chung một khai báo, không ai phải `claude mcp add` tay. Sau khi sửa: gõ `/mcp` trong phiên để login OAuth từng server; kiểm bằng `claude mcp list`.

Vai trò từng server + quy tắc "không bịa dữ liệu MCP": [`agents/ProjectRules.md` §1](./agents/ProjectRules.md). Kỷ luật payload (summary-first, metadata-first): [`agents/SharedRules.md` §8](./agents/SharedRules.md).

> Subagent **không** khai `tools:` — chúng thừa kế toàn bộ tool của phiên, nên đổi tracker (ClickUp → Jira/Linear) chỉ cần sửa `.mcp.json` + ProjectRules §1, không đụng file role.

> **Không commit** token, cookie, `.claude.json` — xem [`Instructions.md` §4](./Instructions.md).

---

## 4. Sinh harness per-tool

Quy tắc cốt lõi: **merge, không clobber** — chỉ thay vùng giữa marker `SPEC-HARNESS:START` … `SPEC-HARNESS:END`; nội dung user viết ngoài marker giữ nguyên.

| Công cụ | Đường dẫn | Nội dung |
| --- | --- | --- |
| Claude Code | `.claude/agents/{role}.md` (7 file) | File ngắn trỏ về `docs/agents/{Role}.md`, marker HTML comment |
| Codex | `.codex/AGENTS.md` + `.codex/agents/{role}.toml` (7 file) | Tương đương, marker `# SPEC-HARNESS:START` |

Bảy `{role}`: `orchestrator`, `fsd-writer`, `fsd-reviewer`, `technical-planner`, `fe-implementer`, `fe-fix`, **`adversary`**.

> Sinh thiếu `adversary` là **mất Gate 5 trong im lặng** — harness vẫn chạy, vẫn báo PASS, chỉ không còn ai kiểm chứng evidence của implementer. Đếm đủ bảy file trước khi chạy task đầu tiên.

Ràng buộc khi sinh:

- **KHÔNG** sửa `.claude/settings.json` / `.claude/settings.local.json` khi *sinh file role*. Installer đặt `settings.json` **một lần** (deny-list lệnh phá working tree — [`Instructions.md` §1](./Instructions.md)) rồi không đè lại; nó là adapter của project, agent không tự sửa.
- **KHÔNG** đụng skill riêng của project trong `.claude/skills/` (ngoài skill harness ship kèm).
- Re-generate chỉ thay phần giữa marker; nội dung ngoài marker ghép lại nguyên vẹn.
- File role là "con trỏ" — quy trình thật ở `docs/agents/{Role}.md`, tránh trùng lặp lệch pha.

---

## 5. Tham chiếu role file

| Role | File quy trình |
| --- | --- |
| `orchestrator` | [`agents/Orchestrator.md`](./agents/Orchestrator.md) |
| `fsd-writer` | [`agents/FSDWriter.md`](./agents/FSDWriter.md) |
| `fsd-reviewer` | [`agents/FSDReviewer.md`](./agents/FSDReviewer.md) |
| `technical-planner` | [`agents/TechnicalPlanner.md`](./agents/TechnicalPlanner.md) |
| `fe-implementer` | [`agents/FEImplementer.md`](./agents/FEImplementer.md) |
| `fe-fix` | [`agents/FEFix.md`](./agents/FEFix.md) |
| `adversary` | [`agents/Adversary.md`](./agents/Adversary.md) |

Artifact tham chiếu (đọc, không sửa): [`srs/README.md`](./srs/README.md) · [`fsd/README.md`](./fsd/README.md) · [`api/README.md`](./api/README.md).

---

## 6. Safe initial commands (read-only, chạy đầu phiên)

```bash
pwd                              # đúng repo root
ls docs                          # thấy README/HarnessSetup/Instructions/Agents + agents/ srs/ fsd/ api/ tasks/
git status --short --branch      # nhánh hiện tại + thay đổi chưa commit
claude mcp list                  # server ở .mcp.json đã connect
```

Quy tắc nhánh làm việc (công thức tên, `--ff-only`, ngoại lệ nhánh user quản lý): [`agents/SharedRules.md` §3](./agents/SharedRules.md).

---

## 7. Resume task (tiếp tục task dang dở)

Task docs tại `docs/tasks/sprint-{n}/{taskId}-{slug}/` (layout: [`tasks/README.md`](./tasks/README.md)). Resume:

1. **Đọc state:** `task.agent.json` → `currentStage`, `status`, `branch` (+ `branchActual` nếu có), `agents.{role}.status`.
2. **Đọc handoff:** `.agent-memory/{role}.md` của role ứng với `currentStage` → inputs, decisions, risks, evidence, "next agent", cờ continue.
3. **Đối chiếu gate** theo lifecycle trong [`Agents.md`](./Agents.md) §2.
4. **Tiếp tục đúng chỗ:** `blocked` / `needs_clarification` → đọc blocker, chờ user/BA resolve; `in_progress` → dispatch lại đúng role subagent từ điểm dừng.
5. **Append, không overwrite:** mọi cập nhật doc/`.agent-memory` thêm mục mới `## Cập Nhật — YYYY-MM-DD`.
6. **Đồng bộ checkout:** làm việc đúng nhánh trong `task.agent.json` (`branchActual` nếu có, ngược lại `branch`).

> `task.agent.json` không có trường **token/usage** (dữ liệu vendor). Nó **có** `telemetry`: stage, tier, tên model, mốc thời gian — đủ để `--calibrate` đối chiếu chi phí với kết quả ([`Agents.md` §5.6](./Agents.md)), không lộ số token.

---

## 8. Không commit secret

Xem [`Instructions.md` §4](./Instructions.md) — nguồn chuẩn duy nhất. Trước khi đề xuất commit: `git status --short`, xác nhận không có file nhạy cảm trong staging.
