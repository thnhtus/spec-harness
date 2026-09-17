---
name: pre-qc-gate
description: Use when a ClickUp ticket is code-complete and the question is "đã sẵn sàng đẩy QC chưa" — e.g. "pre-qc <id>", "verify task trước khi giao QC", "AI QC ticket này", "chạy gate trước khi chuyển QC". Runs build/type/lint/unit, drives the real app in a browser against every acceptance criterion, hunts for bugs the AC didn't name, and returns PASS (ready for QC) or FAIL with evidence. Verifies only — never writes app code.
---

# pre-qc-gate — cổng verify trước khi giao QC

DEV xong ticket → cổng này chạy → **PASS** mới chuyển QC, **FAIL** trả lại DEV kèm evidence.

**Nguyên tắc: Playwright trả lời "đúng hay sai", bạn trả lời "nên test gì và kết quả có hợp lý không".**
Không có assertion chạy thật thì không có PASS. "Nhìn có vẻ đúng" ≠ pass.

Skill này **chỉ verify**. Thấy bug → báo cáo, không sửa `src/`. Muốn sửa: `fix-bug` / `quick-task`.

## Đã có sẵn, đừng dựng lại

**Skill này không gắn với ngôn ngữ hay test runner nào.** Mọi lệnh lấy từ
**ProjectRules §7** của repo đang chạy. Cột "ví dụ" dưới đây là một FE TypeScript —
đọc để hiểu *cần gì*, không phải để copy lệnh.

| Cần | Tìm ở đâu trong repo | Ví dụ (FE TS) |
| --- | --- | --- |
| Lệnh test/lint/build one-shot | **ProjectRules §7** (nguồn chuẩn) | `npm run test:scope`, `npx tsc -b` |
| Harness kiểm tích hợp sẵn có | `e2e/`, `tests/`, `*_test.go`, `test/integration/`, `conftest.py`, `playwright.config.*`, `*.spec.*` | vitest project `browser` |
| Cách login / auth thật | helper auth trong harness đó | `helpers/auth.ts` → `loginAs(page)` |
| Credentials + host | biến môi trường của project (`.env`, `.env.test`, secret CI) | `VITE_API`, `E2E_*` |
| Nguồn AC | tracker MCP; task chạy harness → `{tasksDir}/*/{taskId}-*/02-FSD-Review.md` | |

**Không có harness sẵn thì không dựng mới.** Không thêm dependency, không tạo
`playwright.config.*`/`pytest.ini`/`docker-compose.test.yml`, không dựng framework
report. Ghi vào evidence là tầng đó **không kiểm được** và vì sao — giới hạn ghi rõ
đáng tin hơn một framework dựng vội trong lúc verify.

## Chọn tầng verify theo loại task

`layer` trong `task.agent.json` (hoặc bản chất repo) quyết định bước 4 làm gì:

| Loại | Tầng "chạy thật" là gì | Bước 4 đọc mục |
| --- | --- | --- |
| Có UI (web FE) | drive browser | §4a |
| Service/API, CLI, job, library — **không có UI** | gọi thật vào interface của nó: HTTP request, CLI invocation, hàm public | §4b |

Không có UI mà vẫn cố mở browser là lãng phí; bỏ qua tầng chạy thật vì "không có UI"
là bỏ gate. Cả hai đều sai.

## Flow

### 1. Lấy AC (đừng đoán)

Tool đọc task của tracker MCP (tự tìm trong tool của phiên — ProjectRules §1) với id (bỏ tiền tố `#`, `CU-`, phần URL). Đọc description + comment + parent.
Có `docs/tasks/sprint-*/{taskId}-*/02-FSD-Review.md` → đó là AC chuẩn (`AC-01`, `AC-02`…), ClickUp là bổ sung.

Không tìm ra AC rõ ràng → **hỏi user, dừng**. Gate không có tiêu chí là gate giả.

Ghi ra danh sách phẳng: mỗi AC một dòng, kèm màn hình/route để chạm tới nó.

### 2. Test plan — 3 nhóm

Từ AC sinh ra:

- **critical** — mỗi AC một scenario. Bắt buộc chạy, bắt buộc có assertion.
- **edge** — thứ AC không nói nhưng dev hay làm vỡ: input rỗng, string rất dài, ký tự đặc biệt, double-click submit, F5 giữa flow, nút Back, cancel giữa chừng, trùng dữ liệu, quyền không đủ.
- **manual** — cái chặn bởi hệ thống ngoài (gateway thanh toán, email thật, SSO, dữ liệu prod không tạo được). Ghi rõ lý do; **không** đếm là pass.

Nói với user plan này trước khi chạy nếu ticket lớn (>8 scenario).

### 3. Tầng tĩnh

Chạy **đúng bộ lệnh của ProjectRules §7** — không đoán, không tự chế lệnh. Dán output thật.

Bộ đó thường gồm: type-check (nếu ngôn ngữ có) · lint · unit test giới hạn scope của task ·
build. Tên lệnh khác nhau theo stack (`npm run`, `go test`, `pytest`, `cargo`, `mvn`,
`dotnet`, `make`) — §7 là nơi duy nhất nói lệnh nào đúng cho repo này.

Đỏ ở bước này → **FAIL ngay**, không cần sang tầng chạy thật.

### 4a. Tầng browser (task có UI)

Dev server **riêng**, port tự do — đừng tin server đang chạy sẵn của người khác. Lệnh
khởi động lấy từ ProjectRules §7 (nó cũng nói lệnh nào là watch-mode bị cấm).

Test đặt cạnh harness e2e sẵn có, tên chứa `preqc-{taskId}`, mỗi case mang **ID của AC**
trong tên để grep ngược được:

```
it('AC-01 — <hành vi người dùng>', …)      // hoặc: func TestAC01_… / def test_ac01_…
```

Assertion phải cụ thể — **trạng thái sau hành động**, không phải "element tồn tại":
URL sau khi submit, giá trị vừa tạo xuất hiện trong danh sách, nút bị disable khi thiếu field.

**Live backend hay intercept?** AC nói về *dữ liệu và luồng nghiệp vụ thật* → login thật,
backend thật. AC nói về *cách UI phản ứng với một state* (rỗng, lỗi, 403, chuỗi quá dài)
→ intercept request để ghim state đó.

Ghi output ra file rồi `Read` file đó — pipe qua shell làm hỏng ký tự khung của nhiều runner.

### 4b. Tầng chạy thật (service/API, CLI, job, library — không có UI)

Cùng kỷ luật, khác bề mặt: gọi thật vào interface mà người dùng thật sự dùng.

| Loại | Chạm thật là | Assert cái gì |
| --- | --- | --- |
| HTTP API | request thật tới service đang chạy (test container / instance local) | status code · shape response · **state sau đó**: đọc lại, hoặc query DB, thấy đúng thứ vừa ghi |
| CLI | chạy binary/lệnh với arg thật | exit code · stdout/stderr · file hoặc DB nó tạo ra |
| Job / worker | đẩy một message/record thật rồi chờ | side effect: bản ghi, file, message ra |
| Library | gọi hàm public như người dùng ngoài | giá trị trả về · lỗi ném ra · trạng thái sau |

Bẫy riêng của BE, soi kỹ:

- **Migration** chạy được cả chiều lên và xuống? Có dữ liệu sẵn thì sao?
- **Transaction** — lỗi giữa chừng có rollback sạch không, hay để lại bản ghi mồ côi?
- **Idempotency** — gọi cùng request hai lần có tạo hai bản ghi không?
- **Authz** — user thiếu quyền gọi endpoint này: 403 hay lọt?
- **Validate ở biên** — payload rỗng, field thừa, type sai, số âm, chuỗi quá dài.
- **N+1 query** hoặc thiếu index trên đường AC đi qua.
- **Rò rỉ** — log/response có in secret, PII, stack trace ra ngoài không?

Tương đương "console error / network 4xx-5xx" của FE là: **log ERROR/WARN mới** và
**exception nuốt im lặng** trên đường AC đi qua. Có là finding, kể cả khi AC vẫn pass.

### 5. Tầng exploratory + visual

Sau khi critical đã xanh, thu thập trên chính đường AC vừa đi.

**Có UI:** bắt console error, `pageerror`, và response ≥ 400 trong cùng phiên browser. Rồi tự kiểm:
nút submit có disable khi thiếu field bắt buộc? message validate có đúng chỗ? layout vỡ ở màn hẹp?
bấm Lưu hai lần có tạo hai bản ghi?

**Không UI:** bắt log ERROR/WARN mới và exception bị nuốt. Rồi tự kiểm theo bảng bẫy BE ở §4b —
double-call, rollback, authz, payload biên.

Mỗi phát hiện phân loại: **BLOCKING** (sai AC / mất dữ liệu / lỗi JS / API 5xx) — **NON-BLOCKING** (cosmetic, ghi nhận cho QC) — **UNCERTAIN** (không chắc đúng sai → hỏi user, đừng tự phán).

Console error / API 4xx-5xx trên đường đi của AC = **BLOCKING**, kể cả khi AC vẫn pass.

### 6. Chấm điểm

PASS chỉ khi **tất cả** đúng:

| Hạng mục | Điều kiện |
| --- | --- |
| Toàn bộ lệnh ProjectRules §7 | xanh, output thật |
| Critical scenario | 100% pass, có log thật |
| AC coverage | mọi AC → automated pass, hoặc manual có lý do rõ |
| Lỗi runtime | không error mới — console (UI) / log ERROR (service) |
| Lỗi tầng giao tiếp | không 4xx/5xx ngoài dự kiến (UI) · không exception nuốt im lặng (service) |
| Exploratory | không có finding BLOCKING |

Một ô đỏ → **FAIL**. Không có "pass với điều kiện". Không tự hạ AC xuống manual để né đỏ.

Còn **UNCERTAIN** chưa được user trả lời → kết quả là **UNCERTAIN**, không phải PASS.

### 7. Evidence — MỘT file

`docs/tasks/fixes/preqc-{taskId}-{slug}.md`, tiếng Việt, output thật, không tô hồng:

```markdown
# Pre-QC {taskId} — {tên task}

**Kết quả: PASS | FAIL | UNCERTAIN**  ·  {ngày}  ·  tầng chạy thật: {browser | api | cli | none — lý do}

## AC coverage
| AC | Scenario | Test | Kết quả |
| --- | --- | --- | --- |
| AC-01 | … | `<test file>::AC-01 — …` | PASS |
| AC-04 | … | manual — cần SSO tài khoản HR | MANUAL |

## Tầng tĩnh
| Lệnh (ProjectRules §7) | Kết quả |
| --- | --- |
| `<lệnh type-check>` | 0 lỗi |
| `<lệnh lint>` | sạch |
| `<lệnh unit scope>` | 12/12 passed |

## Exploratory
- BLOCKING — {mô tả} · expected: … · actual: … · `/tmp/preqc-*.png`
- NON-BLOCKING — {mô tả}

## Lỗi runtime
- console / log ERROR: 0
- network 4xx-5xx / exception nuốt: 0

## Kết luận
PASS → READY FOR QC. | FAIL → trả DEV, lý do: …
```

Screenshot của mỗi finding: lưu `/tmp/preqc-{taskId}-{n}.png`, trỏ đường dẫn trong file.

### 8. Báo về ClickUp — chỉ khi user yêu cầu

Comment vào ClickUp và đổi status là **hành động ra ngoài**: chỉ làm khi user nói rõ.
Mặc định: báo kết quả trong chat + đường dẫn file evidence, để user quyết.

Khi được yêu cầu, gọi tool thêm bình luận của tracker MCP với đúng nội dung file evidence (rút gọn), kèm câu cuối:
`Recommendation: READY FOR QC` hoặc `Recommendation: BACK TO DEV`.

## Ranh giới

- **Không sửa `src/`.** Thấy root cause thì viết vào evidence và nói với user; sửa là việc của `fix-bug`.
- **Không xoá/sửa test có sẵn** để cho xanh. Test cũ đỏ là finding, không phải chướng ngại.
- **Backend thật = dữ liệu thật.** Mỗi lần click tạo ticket là một bản ghi có thật trên dev (UI có thể không có modal confirm). Tạo ít nhất có thể, ghi lại id đã tạo trong evidence.
- **Không PASS vì browser chạy hết luồng.** Chỉ assertion mới PASS được.

## Sai lầm hay gặp

| Cám dỗ | Thực tế |
| --- | --- |
| "Test tích hợp chậm quá, unit phủ rồi" | Unit mock đúng lớp đang cần kiểm → không chứng minh được hệ thống thật hoạt động. Đó chính là loại bug lọt QC. |
| "Console error này có sẵn từ trước" | Vẫn ghi vào evidence là NON-BLOCKING kèm ghi chú, để QC không mất thời gian điều tra lại. |
| "AC-04 khó test, cho vào manual" | Manual chỉ dành cho chặn bởi hệ thống ngoài. Khó ≠ manual. |
| "Chỉ còn mỗi lint đỏ, PASS đi" | Một ô đỏ = FAIL. Cổng có ngoại lệ là cổng mở. |
| "Tôi thấy màn hình ổn" / "response nhìn đúng rồi" | Nhìn không phải assertion. Viết assert hoặc đừng tính là verified. |
| "Service này không có UI nên bỏ tầng chạy thật" | Không UI ≠ không chạy được. Gọi HTTP/CLI/hàm public — §4b. |
