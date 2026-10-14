# Kiến trúc (#134, tách module #118)

Bản đồ cho người thứ hai đọc code, không phải tổng quan marketing.

| File | Vai trò | Kích thước |
|---|---|---|
| `kernel/scripts/validate-tasks.mjs` | CLI: dispatch lệnh, các lệnh (`--advance`, `--preflight`, `--pack`, …), validator chính, self-check tổng | ~1.8k dòng |
| `kernel/scripts/lib/*.mjs` | logic thuần, tách theo domain (#118) — mỗi module có `selfCheck({ assert })` riêng | ~4.6k dòng |
| `kernel/scripts/capabilities.mjs` | dữ liệu ma trận capability (#139), không import gì, để `install.mjs --self-test` import được | 46 dòng |
| `install.mjs` | cài đặt + `--eval`/`--bench`/`--self-test` (sandbox hoá toàn bộ pipeline để test không cần agent thật) | ~3.1k dòng |

Vì sao tách (thay cho quyết định hoãn ở #118): logic và self-check của nó đi cùng nhau vào từng module, nên đọc một domain không phải cuộn qua 6k dòng của domain khác, mà vẫn giữ được tính chất "assert nằm ngay cạnh hàm" — thứ lý do ban đầu để không tách. `--self-check` gọi `selfCheck()` của từng module theo đúng thứ tự cũ, nên exit code và output không đổi.

## `kernel/scripts/lib/` — module nào sở hữu cái gì

| Module | Sở hữu | Gate/việc |
|---|---|---|
| `config.mjs` | nạp `harness.config.json`, mọi hằng số dẫn xuất (`CFG`, `TASKS_DIR`, `STAGE_ORDER`, `LINE_CAPS`, `EVIDENCE_RE`, `DOC_ENUMS`, `enumRe`…) | nền của tất cả |
| `guard.mjs` | `guardVerdict`, `guardSubjects`, `ASK_FORMATS`, `clineDeny`, `roleWriteVerdict`, `roleBashTargets` | deny-list hook + sandbox role (#53/#57/#105/#143). **Không import config** — `--guard` phải chạy được khi thiếu config |
| `schema.mjs` | `validateSchema` (subset JSON-Schema) | kiểm `task.agent.json` |
| `docs.mjs` | `countLinesIn`, `questionDefects`, `handoffDefects`, `handoffHalted`, `handoffBlockCount`, `filledRows`, `templateRowsBlock`, `shippedBeforeRule`, `notesDefects` | Gate 1–3: artifact, handoff, line cap, template chưa điền |
| `trace.mjs` | `gate1Defects`, `gate1IsOwed`, `vectorIsOwed`, `declaredACsIn`, `acsMissingIn`, `acValueGaps`, `routeForUrl` | Gate 1 + truy vết AC (#107/#110) |
| `evidence.mjs` | `hasRealEvidenceIn`, `attestationsIn`, `attestationDefects`, `currentWorktreeFingerprint`, `treeCtx`, `liteDefects` | Gate 4: evidence thật, `outputHash`, witness cây code (#137) |
| `gate5.mjs` | `adversaryDefects`, `adversaryCoverageDefects`, `evidenceTableDefects`, `adversaryPrompt`, `adversaryRunVerdict`, `prefilterVerdict`, `stageContract`, `packParts` | Gate 5 + `--pack` |
| `routing.mjs` | `resolveTier`, `modelsDefects`, `deriveComplexity`, `triage`, `escapeHatchStats`, `vectorInputErrors`, `vectorDriftSince`, `staleTriageCalls`, `CLI_NAMES` | tier/model, vector, escape hatch, triage |
| `scope.mjs` | `scopeFiles`, `undeclaredFiles`, `planSlices`, `sliceScopeViolations`, `parsePorcelainZ`, `contentSnapshot`, `changedSince` | scope creep (#115), slice (#67–#71), file ignored/dirty (#140–#142) |
| `telemetry.mjs` | `stampLine`/`stampChain`/`stampDefects`, `restampLines`, `dispatchGaps`, `budgetDefect`, `reportRows`, `cascadeDefects`, `contextBleed` | #103/#121: chữ ký `_stamp.log`, budget, retry/cascade |
| `wiring.mjs` | `denyGaps`/`askGaps`, `mcpGaps`, `codeownersGaps`, `adapterGaps`, `statusMissing`, `writeBackDecision`, `unisolatedClis`, `keyStoreAdvice`, `ruleFloor` | `--preflight`: mọi cảnh báo "cài có đúng không", tracker write-back |
| `lifecycle.mjs` | `promotion`, `advanceDecision`, `bootstrapInputErrors`, `backdatedCreatedAt`, `calibrate`, `findTaskFolders`, `strayTaskFolders` | vòng đời task, `--triage`/`--bootstrap`/`--calibrate` |

Quy ước import: module chỉ import từ module ở tầng trên nó. Tên chỉ dùng trong `selfCheck()` được import động (`.wire`/`await import`) để hai module test nhau không tạo chu trình lúc nạp — nếu không, một hằng số ở module B dựng từ `CFG` sẽ nổ `Cannot access 'CFG' before initialization`.

## `kernel/scripts/validate-tasks.mjs` — các khối chính (theo thứ tự trong file)

1. **Guard** (`--guard`, `--guard-role`) — chạy TRƯỚC khi nạp config; `--check-settings`, `--codex-rules` sau đó.
2. **`--self-check`** — gọi `selfCheck()` của từng module (đúng thứ tự lịch sử) + assert tích hợp của chính CLI. Đây là nguồn sự thật duy nhất khi nghi ngờ một hành vi; không đoán, chạy nó.
3. **Telemetry/budget/tracker** (`--report`, `--writeback`, `--key-migrate`) — #121, #120, #132.
4. **`--advance`** — nơi mọi gate thực sự được enforce theo thứ tự: budget (#121) → pre-filter (#109) → scope creep (#115) → pack cap (#116) → lease → stamp (#124) → telemetry. Đọc khối này để hiểu thứ tự ưu tiên khi hai gate cùng muốn chặn.
5. **`--run-adversary`** (#131) — Gate 5 ở tiến trình mới.
6. **`--bootstrap` / `--triage`** — stage 1 không cần subagent.
7. **`--preflight`** — mọi cảnh báo trạng thái cài đặt (guard, CODEOWNERS #133, isolation #126, key #125, branch protection #119) nằm ở đây, cộng dồn, không dừng ở lỗi đầu tiên.
8. **`--capabilities`** (#139) — ma trận per-CLI (guard hook, role file, Gate 5 tiến trình riêng), mặc định `UNVERIFIED`; chỉ một lần chạy thật trên đĩa mới đổi được thành `verified`. Installer self-test khoá phần bằng chứng (file phải tồn tại) và chỉ matrix không được tự nhận `verified` khi mới có file cài.
9. **Validator chính** (cuối file) — duyệt mọi task folder, gọi các `xDefects`, in hoặc trả JSON.

## Ranh giới của attestation (đọc trước khi tin Gate 4)

`run-evidence.mjs` làm Gate 4 đắt hơn để gian lận: `outputHash` gắn attestation với đúng output, `worktree:` gắn với nội dung cây code lúc chạy (#137), `_stamp.log` ký HMAC chuỗi. **Nó không phải chữ ký.** Hàm hash công khai và agent cùng OS user đọc được (key có thể đưa vào Keychain bằng `--key-migrate`, #125/#132). Ba chỗ fail-open: CI, task đã qua `reviewing`, và git không trả lời được.

Nghĩa là: mức phòng thủ này chặn **nhầm lẫn** — dán evidence của task khác, sửa output sau khi chạy, chạy test hôm trước rồi đổi code hôm sau. Nó không chặn **ý định**. Thứ chặn ý định là adversary tự chạy lại lệnh ProjectRules §7 (Gate 5), không phải hash.

## `install.mjs` — các khối chính

1. `installInto(P, clis, coOwner)` — ghi file vào project đích, không đè file đã có (trừ kernel); copy cả `kernel/scripts/lib/` sang `scripts/lib/`.
2. `ADAPTERS` — bảng cấu hình hook cho 13+ CLI khác Claude.
3. `buildBase` / `buildEvalCase` / `evalCases()` — dựng sandbox cài sẵn harness, dùng chung bởi `--eval`, `--bench`, và phần lớn `--self-test`.
4. `--eval` (#123) — chạy agent thật qua các case adversary, ghi `kernel/eval/last-pass.json` khi 100% xanh.
5. `--bench` — đọc token/thời gian từ stream-json (Claude) hoặc rollout (Codex).
6. `--self-test` — cài vào sandbox tạm, assert hành vi thật (không mock `installInto`). Các check đọc "nguồn kernel" dùng `readKernel()` (validate-tasks + mọi file `lib/`), không đọc một file cố định — một check chỉ đọc `validate-tasks.mjs` sẽ im lặng ngừng kiểm ngay khi code chuyển sang module khác.

## Luồng một task (tham chiếu nhanh)

```
--bootstrap → --advance fsd_write → --advance fsd_review → --advance technical_plan
→ --advance implementation [--slice Sn] → --advance adversarial_review (hoặc --run-adversary)
→ --advance reviewing → --writeback
```

Mỗi `--advance` gọi lại chính validator (`--task <dir>`) để chấm gate trước khi cho dispatch tiếp — không có đường tắt nào bỏ qua việc này.

## Khi cần sửa một gate

1. Tìm hàm pure tương ứng trong `kernel/scripts/lib/<domain>.mjs` (ví dụ `budgetDefect` ở `telemetry.mjs`, `writeBackRecordDefect` ở `wiring.mjs`) — sửa ở đó trước.
2. Thêm assert vào `selfCheck()` của CHÍNH module đó, ngay cạnh hàm, không thêm ở cuối `validate-tasks.mjs`.
3. Nếu gate liên quan tới `--advance` hay installer, thêm e2e thật trong `install.mjs --self-test` (sandbox, không mock).
4. `node install.mjs --self-test` phải xanh trước khi coi là xong — nó chạy cả self-check của validator và bản trên tarball đã pack.
