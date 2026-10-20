# 03 Files to Change
**Task:** PAO-003-D — Durable Queue

| Path | Slice | Action | Description |
|---|---|---|---|
| `src/queue/types.ts` | S1 | Create | Queue interface, payload types, metrics, task model. |
| `src/queue/sqlite-queue.ts` | S2 | Create | SQLite storage layer, WAL configuration, transactions, queries. |
| `src/queue/durable-queue.ts` | S3 | Create | High-level DurableQueue class facade, orphan recovery, backoff logic. |
| `src/queue/index.ts` | S3 | Create | Public barrel export for the queue module. |
| `tests/durable-queue.test.ts` | S4 | Create | Unit and integration test suite covering queue operations, recovery, backoff, and concurrency. |
