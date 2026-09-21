---
name: pre-qc-gate
description: Use when a ClickUp ticket is code-complete and the question is "is this ready to hand to QC" — e.g. "pre-qc <id>", "verify task before handing to QC", "AI QC this ticket", "run the gate before moving to QC". Runs build/type/lint/unit, drives the real app in a browser against every acceptance criterion, hunts for bugs the AC didn't name, and returns PASS (ready for QC) or FAIL with evidence. Verifies only — never writes app code.
---

# pre-qc-gate — the verify gate before handing to QC

DEV finishes the ticket → this gate runs → **PASS** moves it to QC, **FAIL** sends it back to DEV with evidence.

**Principle: Playwright answers "right or wrong", you answer "what is worth testing and is this result plausible".**
No assertion that actually ran means no PASS. "Looks right" ≠ pass.

This skill **only verifies**. Found a bug → report it, do not touch `src/`. To fix: `fix-bug` / `quick-task`.

## Already there, do not rebuild it

**This skill is not tied to any language or test runner.** Every command comes from
**ProjectRules §7** of the repo you are running in. The "example" column below is a TypeScript FE —
read it to understand *what is needed*, not to copy the commands.

| Needed | Where to find it in the repo | Example (TS FE) |
| --- | --- | --- |
| One-shot test/lint/build command | **ProjectRules §7** (the normative source) | `npm run test:scope`, `npx tsc -b` |
| Existing integration test harness | `e2e/`, `tests/`, `*_test.go`, `test/integration/`, `conftest.py`, `playwright.config.*`, `*.spec.*` | vitest project `browser` |
| How real login / auth works | the auth helper inside that harness | `helpers/auth.ts` → `loginAs(page)` |
| Credentials + host | the project's environment variables (`.env`, `.env.test`, CI secrets) | `VITE_API`, `E2E_*` |
| Source of AC | tracker MCP; for a task running the harness → `{tasksDir}/*/{taskId}-*/02-FSD-Review.md` | |

**No harness there already means do not build one.** Do not add a dependency, do not create
`playwright.config.*`/`pytest.ini`/`docker-compose.test.yml`, do not stand up a reporting
framework. Write in the evidence that the layer **could not be verified** and why — a clearly
stated limit is worth more than a framework thrown together mid-verification.

## Pick the verify layer by task type

`layer` in `task.agent.json` (or the nature of the repo) decides what step 4 does:

| Type | What the "really run it" layer is | Step 4 reads section |
| --- | --- | --- |
| Has a UI (web FE) | drive a browser | §4a |
| Service/API, CLI, job, library — **no UI** | call its real interface: HTTP request, CLI invocation, public function | §4b |

Forcing a browser open when there is no UI is waste; skipping the really-run-it layer because
"there is no UI" is skipping the gate. Both are wrong.

## Flow

### 1. Get the AC (do not guess)

The tracker MCP's read-task tool (find it among the session's tools — ProjectRules §1) with the id (strip the `#`, `CU-`, URL parts). Read description + comments + parent.
If `docs/tasks/sprint-*/{taskId}-*/02-FSD-Review.md` exists → that is the normative AC (`AC-01`, `AC-02`…), ClickUp is supplementary.

No clear AC found → **ask the user, stop**. A gate with no criteria is a fake gate.

Write out a flat list: one AC per line, with the screen/route that reaches it.

### 2. Test plan — 3 groups

From the AC, produce:

- **critical** — one scenario per AC. Must run, must have an assertion.
- **edge** — what the AC does not mention but devs routinely break: empty input, very long strings, special characters, double-click submit, F5 mid-flow, the Back button, cancelling halfway, duplicate data, insufficient permissions.
- **manual** — what is blocked by an external system (payment gateway, real email, SSO, prod data you cannot create). State the reason; do **not** count it as a pass.

Tell the user this plan before running if the ticket is large (>8 scenarios).

### 3. Static layer

Run **exactly the command set from ProjectRules §7** — do not guess, do not invent commands. Paste the real output.

That set usually covers: type-check (if the language has one) · lint · unit tests scoped to the task ·
build. Command names differ by stack (`npm run`, `go test`, `pytest`, `cargo`, `mvn`,
`dotnet`, `make`) — §7 is the only place that says which command is right for this repo.

Red at this step → **FAIL immediately**, no need to move to the really-run-it layer.

### 4a. Browser layer (task has a UI)

A **separate** dev server, free port — do not trust someone else's already-running server. The
startup command comes from ProjectRules §7 (which also says which commands are forbidden watch-mode ones).

Put the tests next to the existing e2e harness, name them with `preqc-{taskId}`, and carry the **AC's ID**
in each case name so it can be grepped back:

```
it('AC-01 — <user-visible behaviour>', …)      // or: func TestAC01_… / def test_ac01_…
```

Assertions must be specific — **the state after the action**, not "the element exists":
the URL after submit, the newly created value appearing in the list, the button disabled when a field is missing.

**Live backend or intercept?** The AC is about *real data and real business flow* → real login,
real backend. The AC is about *how the UI reacts to a state* (empty, error, 403, over-long string)
→ intercept the request to pin that state.

Write the output to a file then `Read` that file — piping through a shell mangles the box-drawing characters of many runners.

### 4b. Really-run-it layer (service/API, CLI, job, library — no UI)

Same discipline, different surface: make a real call into the interface people actually use.

| Type | Real contact is | Assert what |
| --- | --- | --- |
| HTTP API | a real request to the running service (test container / local instance) | status code · response shape · **the state afterwards**: read it back, or query the DB, and see what you just wrote |
| CLI | run the binary/command with real args | exit code · stdout/stderr · the file or DB rows it creates |
| Job / worker | push a real message/record then wait | the side effect: a record, a file, an outgoing message |
| Library | call the public function the way an outside user would | return value · thrown errors · state afterwards |

Backend-specific traps, look hard:

- **Migrations** — do they run both up and down? What happens when data already exists?
- **Transactions** — does a failure halfway roll back cleanly, or leave orphan records?
- **Idempotency** — does the same request twice create two records?
- **Authz** — a user without the permission calls this endpoint: 403, or does it go through?
- **Boundary validation** — empty payload, extra fields, wrong type, negative numbers, over-long strings.
- **N+1 queries** or a missing index on the path the AC goes through.
- **Leaks** — do logs/responses print secrets, PII, or a stack trace to the outside?

The equivalent of the FE's "console error / network 4xx-5xx" is: **new ERROR/WARN logs** and
**silently swallowed exceptions** on the path the AC goes through. Either one is a finding, even if the AC still passes.

### 5. Exploratory + visual layer

Once critical is green, collect along the same AC path you just walked.

**With a UI:** capture console errors, `pageerror`, and responses ≥ 400 in the same browser session. Then check yourself:
does the submit button disable when a required field is missing? is the validation message in the right place? does the layout break at a narrow width?
does pressing Save twice create two records?

**No UI:** capture new ERROR/WARN logs and swallowed exceptions. Then check yourself against the BE trap table in §4b —
double-call, rollback, authz, boundary payloads.

Classify every finding: **BLOCKING** (violates an AC / data loss / JS error / API 5xx) — **NON-BLOCKING** (cosmetic, noted for QC) — **UNCERTAIN** (not sure whether it is wrong → ask the user, do not rule on it yourself).

A console error / API 4xx-5xx on the AC's path = **BLOCKING**, even if the AC still passes.

### 6. Scoring

PASS only when **all** of these hold:

| Item | Condition |
| --- | --- |
| Every ProjectRules §7 command | green, real output |
| Critical scenarios | 100% pass, with real logs |
| AC coverage | every AC → automated pass, or manual with a stated reason |
| Runtime errors | no new errors — console (UI) / ERROR logs (service) |
| Transport-layer errors | no unexpected 4xx/5xx (UI) · no silently swallowed exceptions (service) |
| Exploratory | no BLOCKING finding |

One red cell → **FAIL**. There is no "conditional pass". Do not demote an AC to manual to dodge a red cell.

An **UNCERTAIN** the user has not answered yet → the result is **UNCERTAIN**, not PASS.

### 7. Evidence — ONE file

`docs/tasks/fixes/preqc-{taskId}-{slug}.md`, prose in `harness.config.json → docLanguage`, real output, no sugar-coating:

```markdown
# Pre-QC {taskId} — {task name}

**Verdict: PASS | FAIL | UNCERTAIN**  ·  {date}  ·  really-run-it layer: {browser | api | cli | none — reason}

## AC coverage
| AC | Scenario | Test | Result |
| --- | --- | --- | --- |
| AC-01 | … | `<test file>::AC-01 — …` | PASS |
| AC-04 | … | manual — needs an HR SSO account | MANUAL |

## Static layer
| Command (ProjectRules §7) | Result |
| --- | --- |
| `<type-check command>` | 0 errors |
| `<lint command>` | clean |
| `<scoped unit command>` | 12/12 passed |

## Exploratory
- BLOCKING — {description} · expected: … · actual: … · `/tmp/preqc-*.png`
- NON-BLOCKING — {description}

## Runtime errors
- console / ERROR logs: 0
- network 4xx-5xx / swallowed exceptions: 0

## Conclusion
PASS → READY FOR QC. | FAIL → back to DEV, reason: …
```

A screenshot per finding: save to `/tmp/preqc-{taskId}-{n}.png`, reference the path in the file.

### 8. Reporting back to ClickUp — only when the user asks

Commenting on ClickUp and changing the status is an **outward action**: only do it when the user says so explicitly.
Default: report the result in chat plus the path to the evidence file, and let the user decide.

When asked, call the tracker MCP's add-comment tool with the evidence file's content (condensed), ending with:
`Recommendation: READY FOR QC` or `Recommendation: BACK TO DEV`.

## Boundaries

- **Do not touch `src/`.** Found the root cause? Write it in the evidence and tell the user; fixing is `fix-bug`'s job.
- **Do not delete or edit existing tests** to make things green. An old test going red is a finding, not an obstacle.
- **A real backend means real data.** Every click that creates a ticket is a real record on dev (the UI may have no confirm modal). Create as few as possible, and record the ids you created in the evidence.
- **Do not PASS because the browser walked the whole flow.** Only an assertion can PASS.

## Common mistakes

| Temptation | Reality |
| --- | --- |
| "Integration tests are too slow, units already cover it" | The unit mocks exactly the layer under test → it proves nothing about the real system working. That is precisely the class of bug that reaches QC. |
| "This console error was already there" | Still record it in the evidence as NON-BLOCKING with a note, so QC does not waste time re-investigating it. |
| "AC-04 is hard to test, put it in manual" | Manual is only for things blocked by an external system. Hard ≠ manual. |
| "Only lint is red, just PASS it" | One red cell = FAIL. A gate with exceptions is an open gate. |
| "The screen looks fine to me" / "the response looks right" | Looking is not an assertion. Write the assert or do not count it as verified. |
| "This service has no UI so skip the really-run-it layer" | No UI ≠ cannot be run. Call the HTTP/CLI/public function — §4b. |
