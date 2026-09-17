# ProjectRules — Quy tắc phụ thuộc project (ADAPTER — project này tự viết)

> **Tài liệu:** `docs/agents/ProjectRules.md` — normative home cho 4 mục mà kernel **không** biết: §1 nguồn sự thật, §2 architecture guardrail, §3 quy tắc nhánh, §7 lệnh kiểm tra.
> **Quan hệ:** [`../Instructions.md`](../Instructions.md) > [`SharedRules.md`](./SharedRules.md) (kernel) > file này > role file.
> **Số mục giữ nguyên 1/2/3/7** — kernel tham chiếu chéo bằng số (`SharedRules §2` = mục 2 ở đây). Đừng đánh lại số, đừng thêm mục mới xen giữa.
> **Chỉ bốn mục này.** Thứ gì kernel đã định nghĩa (handoff, status, trần dòng, truy vết AC) thì không chép lại xuống đây.

<!-- CHƯA-ĐIỀN: xoá dòng này khi cả 4 mục đã viết thật. Chạy /init-project-rules để điền tự động. -->

---

## 1. Nguồn sự thật qua MCP — không đoán

| MCP server | Vai trò | Dùng để |
| --- | --- | --- |
| `<tên server trong .mcp.json>` | Nguồn yêu cầu | taskId, mô tả, AC của BA, comment |
| `<…>` | Nguồn nhánh / MR | kiểm nhánh, MR, nhánh protected |
| `<…>` | Nguồn thiết kế | node/screen, trạng thái UI |

- **Không bịa dữ liệu MCP.** Trường không lấy được → ghi nguyên văn `unavailable`; nếu trường đó chặn gate → `status = needs_clarification`.
- **Trích dẫn, không diễn giải:** nêu yêu cầu phải kèm nguồn (URL task, node thiết kế, ID requirement).
- **Không cache ngầm:** BA sửa task giữa chừng → đọc lại trước gate kế tiếp.
- **MCP hết hạn auth:** lời gọi fail vì auth → `status = blocked`, báo user chạy `/mcp` login lại, **dừng** — không retry vòng lặp, không bịa dữ liệu thay thế.

<!-- Thêm quy tắc riêng của project ở đây: ví dụ "contract API thiếu shape thì đọc source BE tại <path> trước khi ghi unavailable". -->

---

## 2. Architecture guardrails

Stack: `<ngôn ngữ + framework + thư viện chính>`.

| Thư mục | Quy tắc cho agent |
| --- | --- |
| `<src/…>` | `<cái gì bắt buộc đi qua đâu; cái gì cấm tự tạo>` |

Ràng buộc xuyên suốt:

- `<vd: mọi lỗi từ backend phải đi qua helper X, không xử lý inline từng case>`
- `<vd: thêm API mới đi theo chuỗi type → client → hook → UI>`
- Không thêm thư viện mới nếu plan chưa duyệt.

> Mục này **đắt nhất khi viết vội**. Phần lớn giá trị của nó chỉ xuất hiện sau khi project gặp sự cố thật — viết đúng cái đã biết, rồi bồi dần sau mỗi lần agent làm sai.

---

## 3. Quy tắc nhánh

- **Nhánh protected (không bao giờ commit/push/rebase/xoá trực tiếp):** `<main, develop, …>`
- **Tên nhánh:** `<công thức, vd {user}/t/{taskId}-{slug}>` — `slug` cùng giá trị với thư mục `docsPath`.
- **Nhánh đích (tạo nhánh mới từ đây):** `<develop | main>`

  ```bash
  git fetch origin
  git switch <nhánh-đích>
  git pull --ff-only origin <nhánh-đích>
  git switch -c <công-thức-tên-nhánh>
  ```

  Luôn `--ff-only` — `git pull` trần có thể mở merge editor tương tác và treo phiên.
- **Ngoại lệ — nhánh do user quản lý:** user đang đứng sẵn trên nhánh không-protected → **giữ nguyên**, không tự checkout. Ghi `branch` = tên quy ước, `branchActual` = nhánh thật.
- Việc tạo/chọn nhánh thuộc **implementer**, không phải orchestrator.
- **Không bao giờ chạy lệnh git đổi trạng thái working tree:** `git stash` (kể cả `push -u`), `git checkout -- …`, `git restore`, `git reset --hard`, `git clean`. Task khác có thể đang ghi file cùng lúc. Cần tree sạch → xin user.
- **Cần user yêu cầu rõ trong phiên:** `git commit`, `git push`, tạo/cập nhật MR, xoá nhánh. Gate pass → `status = reviewing` và **dừng chờ user**.

---

## 7. Lệnh kiểm tra (chỉ dùng các lệnh này)

**Lệnh one-shot — agent dùng (tự kết thúc, trả exit code):**

| Lệnh | Mục đích |
| --- | --- |
| `<lệnh unit test giới hạn path>` | **evidence Gate 4 mặc định** — chỉ chạy test file của task |
| `<lệnh unit test toàn repo>` | chỉ khi diff chạm file dùng chung nhiều nơi |
| `<lệnh type-check>` | 0 lỗi |
| `<lệnh lint>` | 0 error |
| `<lệnh build>` | success |

> Các lệnh trên phải khớp `evidenceCommandPattern` trong `harness.config.json` — sai là Gate 4 không nhận evidence. Kiểm bằng `node scripts/validate-tasks.mjs --self-check`.

**Lệnh watch/server — CHỈ user chạy tay, agent KHÔNG bao giờ chạy** (không tự kết thúc → treo phiên): `<dev server, test watch, preview…>`

Quy tắc trung thực: không tuyên bố "pass" khi chưa chạy lệnh thật trong phiên; dán output thật (lệnh, số pass/fail, exit code) vào `08-Test-Evidence.md`; test fail → `status = blocked`, không tắt/skip test để "làm xanh".

<!-- Idiom test hay vấp của project (vd: cách mở dropdown của thư viện UI trong jsdom) viết vào đây, kèm helper dùng chung — đừng để mỗi implementer tự mò lại. -->
