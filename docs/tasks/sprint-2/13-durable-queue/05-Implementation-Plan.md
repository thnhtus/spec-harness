# 05 Implementation Plan
**Task:** PAO-003-D — Durable Queue

## Step 1: Types & Interfaces (`src/queue/types.ts`)
Define `DurableTask`, `QueueOptions`, `IDurableQueue`, `QueueMetrics`.

## Step 2: SQLite Storage Engine (`src/queue/sqlite-queue.ts`)
- Initialize SQLite schema in WAL mode with indexes.
- Prepare optimized statements for `enqueue`, `dequeue` (inside transaction), `ack`, `nack`, `fail`, `recoverOrphans`.

## Step 3: Facade & High-Level Queue (`src/queue/durable-queue.ts`)
- Implement `DurableQueue` class implementing `IDurableQueue`.
- Add exponential backoff calculation for `nack`.
- Export barrel interface from `src/queue/index.ts`.

## Step 4: Unit & Integration Tests (`tests/durable-queue.test.ts`)
- Implement Vitest test suite covering all 7 Acceptance Criteria scenarios.
- Run tests and verify 100% pass rate.
