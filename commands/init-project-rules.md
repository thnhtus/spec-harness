---
description: BẮT BUỘC sau khi cài harness — dò repo rồi điền docs/agents/ProjectRules.md (§1 MCP · §2 guardrail · §3 nhánh · §7 lệnh) + harness.config.json (repos, layers, models, evidenceCommandPattern)
argument-hint: (không cần tham số)
---

**Bước bắt buộc sau khi cài harness.** `install.sh` chỉ chép file; nó không biết
project dùng stack gì, tracker nào, nhánh đặt tên ra sao. Chưa chạy lệnh này thì
`ProjectRules.md` và `harness.config.json` còn là khung rỗng — gate không có gì
để kiểm.

Điền hai file:

| File | Mục |
| --- | --- |
| `docs/agents/ProjectRules.md` | §1 nguồn truth MCP · §2 guardrail source · §3 quy tắc nhánh · §7 lệnh kiểm tra |
| `harness.config.json` | `repos` · `layers` · `models` · `evidenceCommandPattern` + `evidenceSampleCommand` |

**Nhận biết bố cục trước tiên** — nó quyết định `repos`:

- `harness.config.json` nằm **trong** repo code (`git rev-parse --show-toplevel`
  = thư mục chứa config) → `repos: [{ name, path: ".", layer }]`.
- Nằm **cạnh** các repo code (thư mục chứa config là repo riêng, `ls ..` thấy
  repo anh em) → mỗi repo code một entry, `path` là `../<tên>`. Hỏi user repo
  nào thuộc layer nào nếu không suy ra được từ manifest.

**Giữ nguyên số mục 1/2/3/7.** Kernel tham chiếu chéo bằng số (`SharedRules §2`
= mục 2 của file này). Đừng đánh lại số, đừng chèn mục mới xen giữa.

## Nguyên tắc

- **Dò trước, hỏi sau.** Phần lớn 4 mục suy ra được từ repo. Chỉ hỏi user thứ
  không có trong file nào (quy ước tên nhánh, nhánh đích).
- **Không bịa.** Không tìm thấy thì để `<…>` kèm `TODO:` — người đọc thấy ngay
  chỗ trống còn hơn đọc một dòng sai mà tin.
- **Viết cái đã biết, không viết cho đủ.** §2 đắt nhất khi viết vội; phần lớn
  giá trị của nó đến sau sự cố thật. Ba dòng đúng hơn hai mươi dòng đoán.

## Bước 1 — dò

Chạy song song, đọc kết quả rồi mới viết:

| Cần biết | Dò ở đâu |
| --- | --- |
| MCP server (§1) | `.mcp.json` ở repo root — lấy đúng key trong `mcpServers` |
| Stack (§2) | `package.json` / `pyproject.toml` / `go.mod` / `Cargo.toml`… — dependencies chính |
| Layout thư mục (§2) | `ls src/` (hoặc gốc source tương đương), 2 cấp |
| Guardrail có sẵn (§2) | `CLAUDE.md`, `AGENTS.md`, `CONTRIBUTING.md`, `.cursorrules`, `docs/*RULES*` — nếu có thì **trích ngắn + link**, đừng chép cả file |
| Nhánh protected + nhánh đích (§3) | `git branch -r`, `git symbolic-ref refs/remotes/origin/HEAD` |
| Tên nhánh đang dùng (§3) | `git branch --format='%(refname:short)' \| head -20` — suy ra công thức thật của team |
| Lệnh test/lint/build (§7) | `scripts` trong `package.json`, `Makefile`, `justfile`, `tox.ini`, CI workflow (`.github/workflows/*.yml`) |
| Lệnh watch/server cấm agent (§7) | cùng nguồn — lệnh nào không tự kết thúc (`dev`, `watch`, `serve`, `--watch`) |
| Repo BE cùng cấp (§1, bậc 2) | `ls ..` — có repo anh em nào là backend của project này không (tên gợi ý: `*-service`, `*-api`, `*-backend`) |
| Swagger/OpenAPI (§1, bậc 3) | `.claude/skills/api-docs-sync/services.json`, hoặc URL swagger trong README / `.env.example` / docker-compose |
| `models` cho `harness.config.json` | CLI đang dùng là gì (Claude Code / Codex / khác) → map `cheap`/`mid`/`strong` sang tên model của nó; không rõ → để `{}` |
| `repos` cho `harness.config.json` | `harness.config.json` nằm trong repo code hay repo riêng? (`git rev-parse --show-toplevel` so với cwd) · `ls ..` tìm repo anh em · điền `[{name,path,layer}]`, `path: "."` nếu cùng repo |
| `layers` cho `harness.config.json` | repo là FE, BE, hay monorepo? (`ls`, `go.mod`/`package.json`/`pyproject.toml` ở đâu) — ghi vào `layers`, vd `["frontend"]` hoặc `["frontend","backend"]` |
| Tầng chạy thật khi verify (§7) | có UI không? có harness e2e/integration sẵn không (`e2e/`, `test/integration/`, `*_test.go`, `conftest.py`) |

Repo có `CLAUDE.md`/`AGENTS.md` thì đó là nguồn tốt nhất cho §2 — **link về nó**
thay vì chép lại, tránh hai bản lệch nhau.

## Bước 2 — hỏi user đúng cái không dò được

Gộp **một lần** bằng AskUserQuestion, chỉ hỏi phần còn trống sau bước 1:

1. Công thức tên nhánh (nếu `git branch` không cho ra pattern rõ).
2. Nhánh đích để tạo nhánh mới (`develop` hay `main`) — nếu cả hai cùng tồn tại.
3. Lệnh nào là **evidence Gate 4 mặc định** — nếu có nhiều lệnh test và không
   rõ cái nào chạy giới hạn path.
4. Repo BE cùng cấp: dò thấy ứng viên thì **xác nhận đúng repo không**; không
   thấy thì hỏi URL Swagger để điền `services.json` của skill `api-docs-sync`.

Dò ra rồi thì đừng hỏi lại.

## Bước 3 — viết

Ghi đè `docs/agents/ProjectRules.md`, giữ nguyên khung 4 mục của template
(`adapters/ProjectRules.template.md` là bản gốc). Xoá dòng `<!-- CHƯA-ĐIỀN: … -->`.

Mục 7 có ràng buộc cứng: **mọi lệnh liệt kê phải khớp `evidenceCommandPattern`
trong `harness.config.json`**. Lệch là Gate 4 không nhận evidence dù test xanh.
Nên sau khi viết §7, cập nhật luôn `harness.config.json`:

- `evidenceCommandPattern` — regex phủ đúng bộ lệnh vừa viết
- `evidenceSampleCommand` — một lệnh thật, phải khớp pattern đó

## Bước 4 — verify (bắt buộc, đừng báo xong khi chưa chạy)

```bash
node scripts/validate-tasks.mjs --self-check
```

Fail ở `evidenceSampleCommand` = pattern và lệnh lệch nhau → sửa, chạy lại.
Đây là cái bắt lỗi cấu hình khiến mọi gate sau đó im lặng no-op.

Rồi báo user, ngắn:

- 4 mục: mục nào dò ra, mục nào còn `TODO:`
- Dòng `evidenceCommandPattern` đã đặt
- Kết quả `--self-check`
- Nhắc: §2 sẽ đúng dần sau mỗi lần agent làm sai — không cần viết đủ ngay
