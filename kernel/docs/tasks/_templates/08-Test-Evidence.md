# 08 — Test Evidence: {taskName}

> Sinh bởi implementer (`implementer` / `fixer`), stage `implementation`, **Gate 4**. Dán **output thật** của lệnh; không claim pass khi chưa chạy. Append-only, tiếng Việt.
> **Evidence mặc định = unit test giới hạn đúng test file của task** (nhanh, ít RAM); full-suite chỉ khi §7 yêu cầu. Danh sách lệnh one-shot hợp lệ: [`../../agents/ProjectRules.md` §7](../../agents/ProjectRules.md).

## Kết quả lệnh

| Verification Type | Command / Action | Covers AC | Expected | Actual | Result | Notes |
| --- | --- | --- | --- | --- | --- | --- |
| Unit (scope) | `<lệnh unit phạm vi task>` | AC-nn, AC-nn | …/… passed | | | evidence Gate 4 mặc định |
| Unit (full) | `<lệnh full-suite>` | — | không regress | | | **chỉ khi** §7 yêu cầu — bỏ trống nếu không cần |
| Type-check | `<lệnh type-check>` | — | 0 lỗi từ diff | | | |
| Lint | `<lệnh lint>` | — | 0 lỗi mới ở file scope | | | |
| Build | `<lệnh build>` | — | success | | | khi plan yêu cầu |
| E2E (nếu áp dụng) | `<lệnh e2e>` | AC-nn | …/… passed | | | |

### AC coverage

Mọi `AC-nn` của `02-FSD-Review.md` phải có **đúng một** dòng ở đây. `manual` chỉ hợp lệ khi AC đó đã nằm ở bảng **AC-manual** của `03-Technical-Plan.md`.

| AC ID | Phủ bởi (test file :: tên `it(...)`) hoặc `manual` | Result |
| --- | --- | --- |
| AC-nn | `src/test/…::<tên test>` | PASS |

### Reproduction Before Fix *(chỉ `fixer`)*

Output cho thấy test tái hiện **fail** trước khi sửa.

Test đỏ ở đây là **có chủ đích**, nhưng Gate 4 chặn mọi output thất bại — nên phải khai, đặt dòng này ngay trên block:

```
<!-- known-failure: AC-nn reproduce trước khi sửa -->
```

Không khai thì gate đỏ; mà nếu vì thế bạn xoá luôn output đỏ đi thì mất đúng bằng chứng reproduce-first cần có.

### Output / Log

Chạy qua wrapper để block tự có attestation (`exitCode`/`durationMs`/`gitRev`/`startedAt`):

```bash
node scripts/run-evidence.mjs --append <task-folder>/08-Test-Evidence.md -- <lệnh ProjectRules §7>
```

```
# output thật + khối attestation sẽ được append vào đây
```

## Gate 4 — checklist

- [ ] Unit test phạm vi task pass — kèm test mới / regression
- [ ] Full-suite — **chỉ** khi §7 yêu cầu (nếu không, đánh dấu N/A)
- [ ] Type-check không lỗi (từ diff)
- [ ] Lint sạch (0 lỗi mới ở file scope)
- [ ] **Bảng AC coverage liệt kê đủ mọi AC của `02`; `manual` khớp bảng AC-manual của `03`**
- [ ] **Không có AC bị hiện thực làm sai lệch** — nếu có, đã append block *Amendment* vào `01`/`02` (SharedRules §9)
- [ ] Diff chỉ trong scope của plan (không đổi ngoài scope)

> Gate 4 fail → `status = blocked`, ghi blocker + `.agent-memory/{role}.md`.
