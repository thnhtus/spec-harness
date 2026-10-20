# Budget gate

Optional, off unless wired. Hard limits in code; Jev answers only judgment questions.

- `node scripts/budget-gate.mjs <opType> '<json params>'` — gate an expensive op.
  opType ∈ {browser, loop, batch, bigcontext, api}. Exit 0 = allowed (possibly cheaper path), 78 = hard limit exceeded.
- `--report` — spend before/after, runs skipped, skipped runs that should have gone ahead.
- `--record-actual <runId> <cost>` — log actual cost.
- `--feedback <runId> should-have-gone` — mark a skipped run that should have gone ahead.

Prices come from `budget.config.json` (`prices` object) or env; never invented. Hard limits: `BUDGET_PER_RUN`, `BUDGET_PER_DAY`, `BUDGET_MAX_LOOP_TURNS`, `BUDGET_MAX_RETRIES`. Confidence threshold: `BUDGET_CONFIDENCE_THRESHOLD` (default 0.7, one constant).
