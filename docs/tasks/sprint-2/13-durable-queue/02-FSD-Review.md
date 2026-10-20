# 02 Functional Specification Document Review (FSD Review)
**Feature:** PAO-003-D — Durable Queue
**Sprint:** 2
**Reviewer:** FSD Reviewer / Architect
**Date:** 2026-10-20

---

## 1. Acceptance Criteria (AC)

| AC-ID | Description | Verification Method |
|---|---|---|
| **AC-01** | `enqueue()` correctly inserts task with priority, payload, delay, and max_attempts. | Unit Test (`tests/durable-queue.test.ts`) |
| **AC-02** | `dequeue()` retrieves tasks in priority DESC, scheduled_at ASC order and sets processing lock. | Unit Test (`tests/durable-queue.test.ts`) |
| **AC-03** | `ack()` marks task as completed; completed tasks are excluded from subsequent `dequeue()` calls. | Unit Test (`tests/durable-queue.test.ts`) |
| **AC-04** | `nack()` resets task to pending with exponential backoff calculation until max_attempts is reached. | Unit Test (`tests/durable-queue.test.ts`) |
| **AC-05** | Deduplication via `dedupKey` prevents duplicate active task insertion and returns existing task ID. | Unit Test (`tests/durable-queue.test.ts`) |
| **AC-06** | `recoverOrphans()` identifies expired leases and resets tasks to pending or failed. | Integration Test (`tests/durable-queue.test.ts`) |
| **AC-07** | Concurrent workers do not receive duplicate tasks when dequeuing simultaneously. | Stress Test (`tests/durable-queue.test.ts`) |

---

## 2. Risk Assessment

| Risk-ID | Risk Description | Impact | Mitigation Strategy |
|---|---|---|---|
| **R-01** | SQLite database locking contention under high concurrent worker polling. | Medium | Use SQLite WAL mode, set `busyTimeout` to 5000ms, and wrap `dequeue()` operations in immediate transactions. |
| **R-02** | Unbounded growth of `completed` and `failed` task rows degraded SQLite query performance. | Low | Provide `purgeCompleted()` and `purgeFailed()` maintenance APIs with index-backed query execution. |

---

## 3. Review Amendments & Clarifications
- Confirmed single-process lock model via `.queue.lock` (`mkdir` pattern) following `scripts/lease.mjs` conventions.
- Atomic state persistence within SQLite transaction guarantees exact-once ACK recording without external offset tracking files.

---

## 4. Gate 2 Verification
**Gate 2 Status:** PASS
