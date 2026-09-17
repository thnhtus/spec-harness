# spec-harness

Spec-driven agent harness, tách từ một harness đã chạy thật **240 task / 17 sprint** trên một codebase production.

6 role · 4 gate · mọi AC truy vết được từ spec tới test evidence — và gate được enforce bằng **exit code**, không phải bằng lời nhắc trong prompt.

## Kernel vs adapter

```
kernel/                              ← dùng chung, không sửa khi sang project mới
├── docs/Instructions.md             luật toàn cục: repo safety, scope, secret, trung thực test
├── docs/Agents.md                   6 role · lifecycle · 4 gate · routing · skip rule
├── docs/agents/SharedRules.md       §4 handoff · §5 task doc · §6 status · §8 budget · §9 AC trace
├── docs/agents/{Role}.md            quy trình từng role
├── docs/tasks/_templates/           khuôn task doc
└── scripts/validate-tasks.mjs       validator, đọc harness.config.json

adapters/example/                    ← mỗi project tự viết (~110 dòng + 1 file config)
├── harness.config.json              đường dẫn, stage, cap, routing, lệnh evidence
└── docs/agents/ProjectRules.md      §1 nguồn truth · §2 guardrail · §3 nhánh · §7 lệnh
```

Kernel không biết project dùng stack nào, tracker nào, đặt tên nhánh ra sao. Bốn mục đó — và chỉ bốn mục đó — nằm ở `ProjectRules.md`. Số mục giữ nguyên **1/2/3/7** để mọi tham chiếu chéo `SharedRules §n` trong kernel vẫn trỏ đúng.

## Cài vào project mới

```bash
# 1. lấy kernel
cp -R kernel/docs/*           <project>/docs/
cp kernel/scripts/validate-tasks.mjs <project>/scripts/

# 2. viết adapter
cp adapters/example/harness.config.json            <project>/harness.config.json
cp adapters/example/docs/agents/ProjectRules.md    <project>/docs/agents/ProjectRules.md
#    → sửa: tracker MCP, guardrail source, công thức nhánh, lệnh test/lint/build

# 3. cắm gate vào boundary thật  ← BƯỚC QUAN TRỌNG NHẤT
ln -sf ../../hooks/pre-commit .git/hooks/pre-commit
node scripts/validate-tasks.mjs --self-check     # phải xanh trước khi chạy task đầu tiên
```

`--self-check` kiểm tra chính config: stage/routing/artifact có nhất quán không, và `evidenceSampleCommand` có thật sự khớp `evidenceCommandPattern` không. Sai một chỗ thì mọi gate sau đó im lặng no-op — nên nó fail sớm thay vì để bạn phát hiện sau 50 task.

## Vì sao có cái này

Gate bằng văn bản ("agent phải chạy test trước khi báo xong") là gate mà model **chọn** tuân thủ. Gate bằng exit code thì không có chỗ để chọn. Harness gốc mất một thời gian mới học được điều đó; phần đắt nhất ở đây là `validate-tasks.mjs` + chuỗi truy vết AC, không phải mấy file markdown.

Ba thứ validator bắt mà con người hay bỏ sót:

- **AC rơi giữa đường** — `AC-04` có trong review nhưng không ai đưa vào plan, hoặc có trong plan mà không có dòng nào trong test evidence.
- **Evidence giả** — `08` viết "mọi thứ đều pass" nhưng không có lệnh nào được chạy. Phải có **cả** lệnh **và** kết quả mới tính.
- **Template chưa điền** — bản copy nguyên khuôn không được phép thoả mãn traceability (đó là lý do placeholder dùng `AC-nn`, và self-check có regression test cho đúng điều này).

## Cái KHÔNG mang theo được

~40% giá trị của harness gốc là rule sinh từ sự cố thật: cấm `git stash -u` vì nó từng xoá mất một stage hoàn chỉnh · lock toàn máy khi chạy test vì OOM đa tiến trình · copy-on-write `node_modules` thay symlink vì `tsBuildInfoFile` dùng chung gây lỗi type ảo · helper riêng cho dropdown vì nó từng ngốn 11 phút của một implementer.

Không rule nào trong số đó theo sang project khác được. Kernel cho bạn **bộ xương + kỷ luật**; `ProjectRules.md §2/§7` của project mới vẫn phải tự trả giá mà có. Ai bán "universal harness" mà không nói câu này là đang bán vỏ.

## Nguồn gốc

Tách từ harness của `flowhub-studio-fe`. Bản parameterized được kiểm chứng bằng **differential test** trên chính 240 task đó: cùng 240 task, cùng 5 error, cùng 160 warning, diff = 0 so với bản hardcoded.
