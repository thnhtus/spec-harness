# 04 Test Strategy
**Task:** PAO-003-D — Durable Queue

## 1. Unit & Integration Testing Scope (`tests/durable-queue.test.ts`)

| AC Mapping | Test Scenario | Description / Assertion |
|---|---|---|
| **AC-01** | Basic Enqueue & Dequeue | Enqueue task, dequeue with lease, verify payload, attempts count = 1. |
| **AC-02** | Task Ack & Completion | Enqueue and dequeue task, call `ack(taskId)`, verify task status is `completed` and no longer returned by `dequeue()`. |
| **AC-03** | Task Nack & Exponential Backoff | Call `nack(taskId)`, verify status returns to `pending`, `scheduled_at` is delayed, and attempts incremented. |
| **AC-04** | Deduplication | Enqueue task with `dedupKey`, enqueue second task with same `dedupKey`. Verify return IDs match and only 1 row exists. |
| **AC-05** | Orphan Recovery | Set task `status = 'processing'` with expired `processing_until`. Call `recoverOrphans()`, verify status resets to `pending`. |
| **AC-06** | Concurrency Safety | Run 10 parallel worker `dequeue()` invocations. Assert no worker receives the same task ID. |
| **AC-07** | Max Retries & DLQ | `nack` task until `attempts == maxAttempts`. Verify status transitions to `failed` and task is accessible via `getFailedTasks()`. |

## 2. Test Execution Command
```bash
npx vitest run tests/durable-queue.test.ts
```
