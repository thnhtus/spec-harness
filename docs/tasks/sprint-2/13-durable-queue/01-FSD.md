# 01 Functional Specification Document (FSD)
**Feature:** PAO-003-D — Durable Queue (`src/queue/`)
**Sprint:** 2
**Date:** 2026-10-19
**Author:** Technical Planner

---

## 1. Overview & Goal

PAO requires a robust, durable background task queue to reliably buffer, persist, and process asynchronous operational telemetry events (traces, metrics, logs, worker dispatch payloads).

The primary goal of `PAO-003-D` is to implement a local, file-backed SQLite durable queue that guarantees:
- **At-least-once delivery** of queued jobs.
- **Persistence across restarts & crashes** (process crashes do not lose pending or partially processed tasks).
- **Lease/lock mechanisms** to prevent concurrent worker duplicate execution.
- **Configurable retries with exponential backoff & Dead-Letter Queue (DLQ)** support.
- **Minimal overhead** (zero external dependencies like Redis/RabbitMQ; pure SQLite with WAL mode).

---

## 2. Requirements & Traceability

| ID | Requirement Description | Traceability / Criteria |
|---|---|---|
| **REQ-001** | Support enqueueing arbitrary JSON payloads with priority, deduplication keys, and optional delay/scheduling. | FSD §4.1 |
| **REQ-002** | Support atomic worker lease acquisition (`dequeue`) with visibility timeout (`leaseDuration`). | FSD §4.2 |
| **REQ-003** | Support job completion (`ack`), retry scheduling (`nack`), and terminal failure (`fail` / DLQ). | FSD §4.3 |
| **REQ-004** | Recover orphaned/stale tasks (tasks in `processing` state whose lease expired). | FSD §4.4 |
| **REQ-005** | Support FIFO + Priority ordering (`priority` DESC, `created_at` ASC). | FSD §4.1 |
| **REQ-006** | Support task deduplication via optional `dedupKey`. Enqueueing an existing active `dedupKey` returns existing `taskId`. | FSD §4.1 |
| **REQ-007** | Thread-safe & process-safe persistence backed by SQLite in WAL mode. | FSD §5.1 |

---

## 3. Data Architecture & Schema

The queue operates on a single SQLite table inside the state/database path configured for PAO.

```sql
CREATE TABLE IF NOT EXISTS durable_queue (
    id TEXT PRIMARY KEY,
    queue_name TEXT NOT NULL,
    payload TEXT NOT NULL, -- JSON serialized string
    status TEXT NOT NULL DEFAULT 'pending', -- pending, processing, completed, failed
    priority INTEGER NOT NULL DEFAULT 0, -- Higher number = higher priority
    dedup_key TEXT,
    attempts INTEGER NOT NULL DEFAULT 0,
    max_attempts INTEGER NOT NULL DEFAULT 3,
    error_message TEXT,
    scheduled_at INTEGER NOT NULL, -- Unix timestamp (ms)
    processing_until INTEGER, -- Lease expiration timestamp (ms)
    created_at INTEGER NOT NULL, -- Unix timestamp (ms)
    updated_at INTEGER NOT NULL -- Unix timestamp (ms)
);

CREATE INDEX IF NOT EXISTS idx_durable_queue_dequeue 
ON durable_queue (queue_name, status, scheduled_at, priority DESC, created_at ASC);

CREATE UNIQUE INDEX IF NOT EXISTS idx_durable_queue_dedup 
ON durable_queue (queue_name, dedup_key) 
WHERE status IN ('pending', 'processing');
```

---

## 4. Operational Workflows & Mechanics

### 4.1 Enqueueing Jobs (`enqueue`)
1. User provides `queueName`, `payload`, and optional options (`priority`, `delayMs`, `dedupKey`, `maxAttempts`).
2. If `dedupKey` is supplied, query for an existing job in `pending` or `processing` status with the same `dedup_key` in the given `queue_name`.
   - If found, return the existing task ID without creating a duplicate.
3. Compute `scheduled_at = now + (options.delayMs || 0)`.
4. Insert task with `status = 'pending'`.
5. Return generated `taskId` (UUID v4).

### 4.2 Worker Lease Acquisition (`dequeue`)
1. Worker requests up to `batchSize` tasks for a specified `queueName` with a `leaseDurationMs` (default 30,000ms).
2. Query inside an immediate transaction:
   ```sql
   SELECT * FROM durable_queue
   WHERE queue_name = ? 
     AND status = 'pending' 
     AND scheduled_at <= ?
   ORDER BY priority DESC, created_at ASC
   LIMIT ?;
   ```
3. For each selected task, atomically update:
   - `status = 'processing'`
   - `processing_until = now + leaseDurationMs`
   - `attempts = attempts + 1`
   - `updated_at = now`
4. Return the acquired `DurableTask[]` objects to the caller.

### 4.3 Task Settlement (`ack`, `nack`, `fail`)
- **`ack(taskId)`**:
  - Updates task `status = 'completed'`, `updated_at = now`.
  - Optionally deletes completed tasks immediately or relies on periodic purge to keep table size lean.
- **`nack(taskId, error, delayMs)`**:
  - If `attempts >= max_attempts`: automatically transitions task to `status = 'failed'`, records `error_message`.
  - Else: transitions task to `status = 'pending'`, sets `scheduled_at = now + backoffDelay`, clears `processing_until`.
- **`fail(taskId, error)`**:
  - Immediately transitions task to `status = 'failed'` (Dead Letter Queue), regardless of remaining attempts.

### 4.4 Orphan Recovery (`recoverOrphans`)
1. Periodic scan or startup check:
   ```sql
   SELECT * FROM durable_queue
   WHERE status = 'processing' 
     AND processing_until < ?;
   ```
2. Tasks exceeding lease duration are reset:
   - If `attempts >= max_attempts`: set `status = 'failed'`, `error_message = 'Lease expired (max attempts reached)'`.
   - Else: set `status = 'pending'`, `processing_until = NULL`.

---

## 5. API Surface & Module Interfaces

The queue module will expose a TypeScript interface:

```typescript
export interface QueueOptions {
  priority?: number;
  delayMs?: number;
  dedupKey?: string;
  maxAttempts?: number;
}

export interface DurableTask<T = unknown> {
  id: string;
  queueName: string;
  payload: T;
  status: 'pending' | 'processing' | 'completed' | 'failed';
  priority: number;
  dedupKey?: string;
  attempts: number;
  maxAttempts: number;
  errorMessage?: string;
  scheduledAt: number;
  processingUntil?: number;
  createdAt: number;
  updatedAt: number;
}

export interface IDurableQueue {
  enqueue<T>(queueName: string, payload: T, options?: QueueOptions): Promise<string>;
  dequeue<T>(queueName: string, batchSize?: number, leaseDurationMs?: number): Promise<DurableTask<T>[]>;
  ack(taskId: string): Promise<void>;
  nack(taskId: string, error?: string, delayMs?: number): Promise<void>;
  fail(taskId: string, error: string): Promise<void>;
  recoverOrphans(leaseTimeoutMarginMs?: number): Promise<number>;
  getMetrics(queueName?: string): Promise<{ pending: number; processing: number; failed: number; completed: number }>;
  purgeCompleted(olderThanMs?: number): Promise<number>;
  close(): Promise<void>;
}
```

---

## 6. Slicing & File Mapping

To maintain clean architecture and code boundaries:

| Slice | Components / Modules | Responsibility |
|---|---|---|
| **S1** | `src/queue/types.ts` | Type definitions, interfaces, configuration options. |
| **S2** | `src/queue/sqlite-queue.ts` | Core SQLite durable queue implementation using `better-sqlite3` or `sqlite3` abstraction. |
| **S3** | `src/queue/durable-queue.ts` | High-level facade, orphan recovery triggers, metrics, and lifecycle helpers. |
| **S4** | `tests/durable-queue.test.ts` | Comprehensive unit & integration tests covering concurrency, recovery, dedup, retries. |

---

## 7. Quality & Testing Strategy

1. **Persistence & Crash Recovery:** Test closing database connection midway through processing and verifying that `recoverOrphans()` recovers unfinished tasks upon reopen.
2. **Concurrency Safety:** Simulate multiple concurrent workers invoking `dequeue` simultaneously; verify zero duplicate task assignments.
3. **Deduplication:** Verify that enqueueing the same `dedupKey` multiple times yields the same active `taskId` without creating extra rows.
4. **Exponential Backoff & Retries:** Verify `nack` delays execution and transitions tasks to `failed` once `max_attempts` is reached.

---

## 8. Questions & Clarifications for Gate 2 Review

| Q-ID | Question | Type | Status | Owner | Asked / Answered |
|---|---|---|---|---|---|
| **Q-01** | Should `completed` tasks be automatically pruned immediately on `ack` or kept for audit history until `purgeCompleted` is called? | non-blocking | answered | BA / Tech Lead | Kept until explicit purge / configurable TTL (default keep for audit until purge). |
| **Q-02** | Is `better-sqlite3` or an existing internal SQLite connection instance used across the PAO project? | non-blocking | answered | Architect | Use the existing PAO SQLite connection manager / driver standard. |

---

## 9. Amendment (2026-10-20) — Multi-process concurrency and persistent ACK mappers

### Multi-process locking (Q-01 resolution)
- PAO runs as a single process per queue directory in normal operation.
- To guarantee process isolation when multiple CLI or worker invocations target the same directory:
  - SQLite WAL mode is configured with explicit busy timeouts (`busyTimeout: 5000`).
  - An optional process lock (`.queue.lock` via `mkdir` lock file pattern) prevents simultaneous competing batch writers when strict single-writer process topology is configured.

### Persistent ACK and offset state (Q-02 resolution)
- `ack()` transitions tasks to `completed` state atomically in the queue DB.
- Ack state, offset positions, and processed event sequence bounds (`eventId` maps) are stored atomically in SQLite table state alongside queue tasks, preventing dual-writes and split-brain recovery after crashes.

---

## 10. Amendment 2 (2026-10-20) — Single process lock standard
In alignment with `scripts/lease.mjs`, process-level lock acquisition for multi-worker access uses `mkdir` with a TTL lock file (`.queue.lock`), providing safe lock acquisition and automatic stale lock cleanup across crashed node processes.
