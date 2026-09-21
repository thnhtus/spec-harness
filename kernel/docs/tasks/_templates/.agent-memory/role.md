# {role} — handoff

> The handoff template between stages. Copy it to `.agent-memory/{role}.md` for each participating role (e.g. `orchestrator.md`, `fsd-writer.md`, `fsd-reviewer.md`, `technical-planner.md`, `implementer.md`, `fixer.md`, `adversary.md`). Append-only; prose in `harness.config.json → docLanguage`.

## Next Handoff → {next-role}

- **Inputs**: documents / data read (which doc, which tracker/design field).
- **Decisions**: decisions taken (`D-…` IDs where they exist).
- **Risks**: open risks / assumptions (`R-…` IDs).
- **Changed Files**: files touched (if this is the implementation stage).
- **Evidence**: evidence (link to `08-Test-Evidence.md`, gate results).
- **Blockers**: none | the blocker + who must resolve it.
- **Next agent**: `{next-role}` (or `(none)` when moving to `reviewing`).
- **Continue automation**: yes / no.
