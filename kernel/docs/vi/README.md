# docs/vi/ — bản tiếng Việt của kernel docs

> Bản dịch của `docs/` (kernel). **Bản tiếng Anh là bản gốc** — khi hai bên lệch nhau, bản tiếng Anh thắng.
> `tasks/_templates/` **không** có bản dịch: validator đọc chính các heading/cột trong đó, dịch là gãy gate. Dùng template gốc: [`../tasks/_templates/`](../tasks/_templates/).

| File | Nội dung |
| --- | --- |
| [`Instructions.md`](./Instructions.md) | luật toàn cục (tầng cao nhất) |
| [`Agents.md`](./Agents.md) | 7 role · vòng đời · 5 gate · routing · luật rút gọn |
| [`HarnessSetup.md`](./HarnessSetup.md) | thứ tự nạp · resume task dở |
| [`agents/SharedRules.md`](./agents/SharedRules.md) | handoff §4 · task doc §5 · status §6 · budget §8 · AC trace §9 |
| [`../agents/ProjectRules.md`](../agents/ProjectRules.md) | **adapter** — §1 nguồn sự thật · §2 guardrail · §3 nhánh · §7 lệnh (project tự viết, không dịch sẵn) |
| [`agents/{Role}.md`](./agents/) | quy trình của từng role |
| [`tasks/README.md`](./tasks/README.md) | bố cục task doc + template |
| [`srs/`](./srs/README.md) · [`fsd/`](./fsd/README.md) · [`api/`](./api/README.md) | artifact tham chiếu của project (chỉ đọc, không sửa) |
