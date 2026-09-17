# ProjectRules — Quy tắc phụ thuộc project (ADAPTER — mỗi project tự viết)

> **Tài liệu:** `docs/agents/ProjectRules.md` — normative home cho 4 mục mà kernel **không** biết: §1 nguồn sự thật, §2 architecture guardrail, §3 quy tắc nhánh, §7 lệnh kiểm tra.
> **Quan hệ:** [`../Instructions.md`](../Instructions.md) > [`SharedRules.md`](./SharedRules.md) (kernel) > file này > role file.
> **Đây là bản MẪU** (một FE React/TS). Copy sang project mới rồi thay toàn bộ: stack, MCP server, tên nhánh, lệnh test đều khác.
> **Số mục giữ nguyên 1/2/3/7** để mọi tham chiếu chéo `SharedRules §n` trong kernel vẫn trỏ đúng.

---

## 1. Nguồn sự thật qua MCP — không đoán

| MCP server | Vai trò | Dùng để |
| --- | --- | --- |
| **ClickUp** | Nguồn yêu cầu | `taskId`, tên task, mô tả, AC của BA, comment làm rõ |
| **GitLab** (`https://gitlab.example.com/api/v4/mcp`) | Nguồn nhánh / MR | Kiểm tra nhánh, MR, nhánh protected |
| **Figma** | Nguồn thiết kế | Node/screen, spacing, trạng thái UI khớp màn hình `fsd/` |

Quy tắc:

- **Không bịa dữ liệu MCP.** Trường không lấy được → ghi nguyên văn `unavailable`; nếu trường đó chặn gate → `status = needs_clarification`.
- **Trích dẫn, không diễn giải tự do:** nêu yêu cầu phải kèm nguồn (URL ClickUp, node Figma, ID `FR-`/`FSD-`).
- **Không phỏng đoán contract API — đọc BE trước khi ghi `unavailable`.** `docs/api/` sinh từ Swagger nên hầu như **không có response body** (chỉ `- 200`). Endpoint thiếu shape → đọc source BE tại `../<be-repo>/` (cùng cấp repo FE; từ worktree là `../../../../<be-repo>/`) theo thứ tự: `src/controller/**/*.controller.ts` (route) → `src/application/usecases/` (use case) → `src/application/dto/` (response DTO) → `src/domain/enums/` (enum). Ghi `unavailable` **chỉ khi** đã tra BE mà vẫn không thấy; trích dẫn `file:line` BE làm nguồn, ngang hàng `docs/api/`. BE là read-only — không sửa file nào ngoài repo FE.
- **Không cache ngầm:** BA cập nhật ClickUp giữa chừng → đọc lại trước gate kế tiếp.
- **Đối chiếu chéo:** yêu cầu ClickUp phải khớp ID trong [`../srs/`](../srs/README.md) (`FR-`/`NFR-`/`EXT-`/`DATA-`/`BR-`) và [`../fsd/`](../fsd/README.md) (`FSD-<MOD>-nnn`, mới: `🆕 FSD-<MOD>-NEW-nnn`). Lệch → ghi risk, không tự quyết.
- **MCP hết hạn auth giữa chừng:** nếu một lời gọi MCP fail vì authentication/authorization → `status = blocked`, báo user chạy `/mcp` đăng nhập lại server tương ứng, **dừng** — không retry vòng lặp, không bịa dữ liệu thay thế.

---

## 2. Architecture guardrails cho FE

Stack: React 19 + TypeScript, Vite, Ant Design 5, React Router 7, `@tanstack/react-query`, `@xyflow/react`, Axios, SCSS Modules, Vitest. Layout `src/` chi tiết: [`../../CLAUDE.md`](../../CLAUDE.md).

| Thư mục `src/` | Quy tắc cho agent |
| --- | --- |
| `api/` | Mọi request qua `src/api/apiClient.ts`; không tạo axios instance riêng, không hardcode base URL (dùng `VITE_API` / `VITE_API_AUTH`) |
| `queries/` | Server state luôn dùng `@tanstack/react-query`; không tự quản loading/cache bằng `useState`/`useEffect` |
| `pages/` | Page load bằng `React.lazy()` + `Suspense` |
| `components/` | Component dùng chung; không nhét logic page vào |
| `interfaces/` | Type/interface dùng chung; không lặp type rải rác |
| `helpers/` | Hàm thuần, không side-effect mạng |
| `constants/` | Route path, API path, enum tập trung; không magic string |
| `store/` | State client toàn cục theo pattern context hiện có |
| `config/`, `assets/`, `layout/`, `scss/` | SCSS Modules; không inline style trừ khi pattern hiện có cho phép |

Ràng buộc xuyên suốt:

- **Lỗi BE trong `try/catch` — BẮT BUỘC đi qua `normalizeErrorHelper(error)`** (`src/helpers/normalize_errors.helper.ts`): không tự đọc `response.data.message` / `errorCode` rồi gọi `customizeToast.error(...)` thủ công. Helper này sở hữu việc dịch code → tiếng Việt, ca network/5xx, và loại bỏ `message` dạng mảng của class-validator (`["... should not be empty"]` kèm `error: "Bad Request"` — tiếng Anh, không được hiển thị cho người dùng). Mã lỗi mới thì **thêm vào `ERROR_MESSAGE_CODES` + `ERROR_MESSAGE_TRANSLATIONS`**, không hardcode chuỗi tại chỗ gọi.
  - Ngoại lệ duy nhất: lỗi cần hiển thị **inline trên đúng field** (`form.setFields`) để người dùng biết sửa ô nào — vẫn phải lấy text từ `ERROR_MESSAGE_TRANSLATIONS`, và mọi nhánh còn lại vẫn rơi về `normalizeErrorHelper(error)`.
- **UI danh sách / popup / bộ lọc — BẮT BUỘC đọc [`../DESIGN_RULES.md`](../DESIGN_RULES.md):** khi xây/điều chỉnh màn hình có bảng danh sách, popup (Tạo mới/Chỉnh sửa/Xem chi tiết), hoặc bộ lọc, phải bám quy chuẩn ở đó (header/footer/cột sticky, popup panel phải 1/2 màn hình, độ rộng cột & field filter theo px). Lệch chuẩn = risk phải ghi, không tự quyết.
- **Auth:** JWT trong cookie (`accessToken`, `refreshToken`), decode `jwt-decode`, phân quyền qua `dataRoles`. Không đổi cơ chế auth/permission trừ khi task yêu cầu rõ.
- **Thêm API mới đi theo chuỗi:** `interfaces/` (type) → `api/` (hàm) → `queries/` (hook) → `pages/`|`components/` (UI).
- **Workflow editor:** node dùng `@xyflow/react`; sửa node phải bám FSD per-node (mục `11.1`–`11.11` trong [`../fsd/`](../fsd/README.md)).
- **Xử lý lỗi từ BE trong `try/catch`:** mọi function dùng `try/catch` để bắt lỗi từ backend **phải** gọi `normalizeErrorHelper(error)` (`src/helpers/normalize_errors.helper.ts`) để hiển thị lỗi, không viết nhánh xử lý lỗi thủ công từng case inline. Trường hợp đặc biệt cần message/flow riêng phải ghi rõ lý do và được approve trong plan.
- Không thêm thư viện state/UI/router/build mới nếu plan chưa duyệt.

---

## 3. Quy tắc nhánh — worktree do `/start-task` tạo, agent không tự tạo

- **Nhánh protected (không bao giờ commit/push/rebase/xoá trực tiếp):** `main`, `develop`, `staging`, `release/*`.
- **Tên nhánh:** `tubt/t/{taskId}-{slug}` — vd `tubt/t/86d3ukd1v-filter-trang-thai-bieu-mau`. `slug` = kebab-case không dấu của tên task, cùng slug với thư mục `docsPath`. Không có `branchType` trong tên (`branchType ∈ {feature, hotfix, bugfix}` chỉ dùng để **chọn implementer** — §4 [`../Agents.md`](../Agents.md)). `layer` luôn `frontend`.
- **Tạo nhánh mới** (chỉ khi cần — xem ngoại lệ bên dưới):

  ```bash
  git fetch origin
  git checkout develop
  git pull --ff-only origin develop
  git checkout -b tubt/t/{taskId}-{slug}
  ```

  Luôn dùng `--ff-only` — **không bao giờ** `git pull` trần (có thể mở merge editor tương tác và treo phiên).
- **Ngoại lệ — nhánh làm việc do user quản lý (thường gặp nhất):** nếu user đang đứng sẵn trên một nhánh không-protected (vd nhánh gộp nhiều task nhỏ như `tubt/t/86d3gmpyh`, hay `taskId` của task cha) thì **giữ nguyên nhánh đó, không tự checkout/tạo nhánh**. Ghi vào `task.agent.json`: `branch` = `tubt/t/{taskId}-{slug}` của task này, `branchActual` = nhánh thật đang dùng. Trong thực tế phần lớn task đi theo nhánh này — `branch` là tên quy ước để tra ngược, `branchActual` là nơi code thật nằm.
- Việc tạo/chọn nhánh thuộc về **implementer** (stage `implementation`), không phải orchestrator.
- **Không bao giờ chạy lệnh git đổi trạng thái working tree:** `git stash` (kể cả `push -u`), `git checkout -- …`, `git restore`, `git reset --hard`, `git clean`. Task khác / user có thể đang ghi file cùng lúc — `stash -u` quét cả file untracked (task folder chưa commit) và **đã từng làm mất một stage hoàn chỉnh**. Cần tree sạch để lấy baseline → xin user, không tự làm.
- **Không** force-push. **Không** tự gọi `EnterWorktree`/`git worktree`: worktree do `/start-task` step 0 tạo, subagent đã ở trong đó khi được dispatch — cứ làm việc tại `cwd` hiện tại, không đổi tree.
- **Cần user yêu cầu rõ ràng trong phiên:** `git commit`, `git push` (kể cả lần đầu), tạo/cập nhật MR, xoá nhánh. Gate pass xong thì đặt `status = reviewing` và **dừng chờ user**.

---

## 7. Lệnh kiểm tra (chỉ dùng các lệnh này)

**Lệnh one-shot — agent dùng (kết thúc và trả exit code):**

| Lệnh | Mục đích |
| --- | --- |
| `npm run test:scope -- <path…>` | Unit test 1 lần **giới hạn path** (vd `src/test/pages/permission`) — **evidence Gate 4 mặc định**: chỉ chạy test file của task |
| `npm run test:run` | Unit test 1 lần toàn repo (`--project unit`) — **chỉ bắt buộc** khi diff chạm file dùng chung nhiều nơi (barrel: `src/api/index.ts`, `src/queries/index.ts`, `src/interfaces/index.ts`…); task thường không cần |
| `npm run test:e2e:run` | Browser test 1 lần (`--project browser`) |
| `npm run test:coverage` | Unit + coverage (`--coverage --project unit`) |
| `npm run test:all` | Toàn bộ test (mọi project) |
| `npm run lint` | ESLint (`eslint .`) |
| `npm run build` | `tsc -b && vite build` |
| `npx tsc -b` | Type-check (build project refs) — **dùng cái này**; `npx tsc --noEmit` ở root là **no-op** (`tsconfig.json` có `files:[]`) |

> **Chống OOM đa-tiến-trình (bắt buộc, đã enforce ở script):** mọi lệnh `test:*` one-shot ở trên chạy qua `scripts/test-locked.mjs` — một **lock toàn máy** đảm bảo **chỉ một** `vitest run` của repo chiếm RAM tại một thời điểm; lần chạy thứ hai (task song song / worktree khác) **tự xếp hàng chờ**, không chạy chồng. Đây là lý do `maxForks` đơn lẻ không đủ: nó chỉ cap *trong* một tiến trình, không cap *giữa* các tiến trình. Agent **không** tự gọi thẳng `vitest run`/`npx vitest` (bỏ qua lock → nguy cơ OOM khi đa-task); luôn qua `npm run test:*`. **Evidence Gate 4 mặc định = `test:scope`** giới hạn đúng test file của task (nhanh, ít RAM). Chỉ nâng lên **một** lần `test:run` full-suite khi diff chạm **barrel dùng chung** (`src/api/index.ts`, `src/queries/index.ts`, `src/interfaces/index.ts`…) — nơi scoped run không bắt được regression lan sang import khác. Task không chạm barrel → **không** chạy full-suite (đỡ thời gian + resource).

**Lệnh watch/server — CHỈ người dùng chạy tay, agent KHÔNG bao giờ chạy** (không tự kết thúc → treo phiên): `npm run dev`, `npm run test`, `npm run test:ui`, `npm run test:e2e`, `npm run preview`.

Quy tắc trung thực: không tuyên bố "pass" khi chưa chạy lệnh thật trong phiên; dán output thật (lệnh, số pass/fail, exit code) vào `08-Test-Evidence.md`; test fail → `status = blocked`, không tắt/skip test để "làm xanh". Không dùng `dotnet`/`pnpm`/`yarn`.

**Tương tác antd trong jsdom — dùng helper, đừng tự mò.** `<Select>` là chỗ ngốn thời gian nhiều nhất khi viết test (một implementer từng mất ~11 phút / 5 lần sửa test cho đúng một dropdown): antd render placeholder thành `<span>` nên `getByPlaceholderText` không thấy, `getByText('<nhãn>')` thường trùng header cột cùng tên, và dropdown chỉ mở ở `mousedown` trên `.ant-select-selector` — `click` không có tác dụng. Dùng [`src/test/helpers/antd.ts`](../../src/test/helpers/antd.ts):

```ts
import { openSelect, selectOptionTitle } from '@/test/helpers/antd'

await act(async () => { openSelect('#status') })       // '#<Form.Item name>' | container | element
await act(async () => { selectOptionTitle('Đã kích hoạt') })
```

Helper có self-check riêng (`src/test/helpers/antd.helper.test.tsx`) nên khi antd đổi class nội bộ thì fail một chỗ, không fail rải rác. Cần idiom antd khác chưa có (DatePicker, Upload, Table row action) → **thêm vào helper đó**, không copy-paste vào file test.

---