---
name: quick-task
description: Use when the user wants to do a ClickUp task directly, without the docs/ FE harness — e.g. "làm task <id> nhưng không chạy harness", "quick task <url>", "fix this task, skip the docs flow", "no harness". Reads the task from ClickUp, implements it in the current tree, and verifies with the repo's one-shot commands. No task folder, no FSD, no gates, no subagents.
---

# quick-task — làm task, bỏ qua harness

Đối lập với `/start-task`: cùng nguồn truth (ClickUp), cùng guardrail `src/`,
cùng lệnh kiểm tra — nhưng **không** tạo `docs/tasks/**`, không FSD/review/plan,
không gate, không dispatch subagent. Bạn tự làm, trong context này.

Dùng khi user nói rõ "không chạy harness" / "quick" / "skip docs flow".
User **chưa** nói vậy mà đưa link ClickUp → dùng `/start-task`.

## Flow

### 1. Đọc task (đừng đoán)
`mcp__clickup__getTaskById` với id (bỏ tiền tố `#`, `CU-`, URL). Đọc description,
comment, parent. Thiếu thông tin để quyết định → **hỏi user**, đừng bịa AC.

Ghi lại trong đầu: AC là gì, màn hình nào, file nào có khả năng đụng.

### 2. Định vị trước khi sửa
Grep/đọc luồng thật end-to-end trước khi viết dòng đầu tiên. Sửa ở chỗ mọi
caller đi qua, không vá riêng đường mà ticket nhắc tên.

Nhiều task E-TICKET **đã ship sẵn trên `develop`** — kiểm tra trước, có thể
deliverable chỉ là một regression test.

### 3. Guardrail `src/` (bắt buộc, y hệt harness)
Nguồn chuẩn: `docs/agents/SharedRules.md` §2. Tóm tắt phần hay vi phạm:

- Request → `src/api/apiClient.ts`. Không axios instance riêng, không hardcode base URL.
- Server state → `@tanstack/react-query` trong `queries/`. Không `useState`+`useEffect` tự quản.
- API mới đi theo chuỗi: `interfaces/` → `api/` → `queries/` → `pages/`|`components/`.
- `try/catch` lỗi BE → `normalizeErrorHelper(error)` (`src/helpers/normalize_errors.helper.ts`).
- Bảng danh sách / popup / filter → đọc `docs/DESIGN_RULES.md` trước.
- Không thêm dependency mới.

### 4. Nhánh
Đang ở nhánh không-protected của user → **giữ nguyên**, không checkout, không tạo nhánh.
Đang ở `main`/`develop`/`staging`/`release/*` → dừng, hỏi user muốn nhánh nào.
Không `git stash`, không `git reset --hard`, không `git checkout -- …`.

### 5. Verify — output thật, không phỏng đoán
```bash
npm run test:scope -- <file test liên quan>
npx tsc -b            # root --noEmit là no-op, phải dùng cái này
npm run lint
```
Logic không tầm thường → để lại **một** test chạy được (thêm vào file test sẵn có
cùng feature nếu có; đừng dựng suite mới).

Baseline repo hiện có ~164 test fail sẵn trên `develop` — so **tập file fail**,
đừng so tổng số.

### 5b. E2E API thật — bắt buộc khi task đụng luồng UI/API

Unit test mock hết BE nên không bắt được lệch contract. Task nào chạm màn hình
hoặc endpoint thì phải chạy thêm một vòng trên **API thật**.

**Bước 1 — credentials.** `.env` phải có `VITE_E2E_CREDENTIAL_USERNAME` +
`VITE_E2E_CREDENTIAL_PASSWORD` (login thật; `helpers/auth.ts` mặc định
`admin` nếu thiếu). Không đọc trực tiếp được (`.env` bị `permissions.deny` +
`sandbox.filesystem.denyRead`) — kiểm gián tiếp:

```bash
grep -c VITE_E2E_CREDENTIAL_USERNAME .env   # 0 → dừng, hỏi user
```

Không có worktree/`.env` → xem §2 của skill `fix-bug` (symlink `.env`).

**Bước 2 — dev server riêng.** Cổng mặc định `3004` có thể đang chạy repo gốc
(**không** có thay đổi của bạn). Luôn tự dựng một cổng trống:

```bash
npx vite --port 3010 --strictPort > /tmp/dev.log 2>&1   # chạy nền
```

**Bước 3 — hai công cụ, hai pha, không thay thế nhau:**

| | trả lời câu gì | để lại gì |
| --- | --- | --- |
| **BrowserOS neo** | "thật sự chạy đúng không?" — thao tác tay trên UI thật, không viết code | không gì |
| **Playwright** (`test:e2e:run`) | "lần sau còn đúng không?" | test ở lại repo + output dán vào evidence |

Mặc định: **neo trước** để xác nhận hành vi thật; thấy đúng rồi thì **đóng
thành Playwright test** nếu luồng đáng giữ. Không chạy cùng một kiểm tra hai
lần bằng hai trình duyệt — đó là lãng phí, không phải cẩn thận.

Chỉ neo: luồng khó dựng state, hoặc chỉ cần nhìn một lần.
Chỉ Playwright: neo lỗi/không có, hoặc luồng đã có sẵn file e2e.

**neo:**

```
mcp__browseros-neo__name_session   → nhãn 2-3 từ + category
mcp__browseros-neo__run            → mở tab, điều hướng, điền, đọc, khẳng định
```

`run` gói cả vòng lặp (`browser.pages.newPage` → `observe().snapshot()` →
`input().click/fill` → `read`) trong một lời gọi; tool lẻ (`tabs`, `snapshot`,
`act`, `read`) chỉ dùng khi debug từng bước. Tab của agent khác / của user thì
**không đụng** — `tabs action="list"` cho biết tab nào là của mình.

⚠️ **Cookie theo origin.** Profile neo đăng nhập sẵn ở host deploy **không**
dùng được trên `localhost:3010` — vẫn phải login bằng credential `.env` như
thường. Session sẵn của neo chỉ lợi khi soi trên môi trường deploy.

**Playwright:**

```bash
set -a; . ./.env; set +a          # vitest không tự nạp .env
E2E_BASE_URL=http://localhost:3010 npm run test:e2e:run -- src/test/e2e/<file>.test.ts
```

Mẫu live test có sẵn: `src/test/e2e/account-permissions-live.test.ts` (đọc
credential từ `.env` ngay trong file, không cần export ra shell).

Chi tiết cạm bẫy e2e (đọc output bị mangle, node-save validator, stub form…):
skill `verify`.

### 6. Báo cáo, rồi dừng
Tóm tắt: đã sửa gì, file nào, output test/tsc/lint thật, còn gì chưa làm.
`git commit` / `git push` / đổi status ClickUp: **chỉ khi user yêu cầu**.

## Không làm
- Không tạo `docs/tasks/sprint-*/…`, không `task.agent.json`, không `.agent-memory/`.
- Không sửa `docs/srs/`, `docs/fsd/`, `docs/api/` (autogen).
- Không dispatch subagent — quick nghĩa là một context.
