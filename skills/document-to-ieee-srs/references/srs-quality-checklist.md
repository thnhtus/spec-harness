# SRS Quality Checklist — ISO/IEC/IEEE 29148:2018

Run before delivering the SRS.

## Structure (§9.6.2)

- Clauses follow 29148 order: Introduction → References → Specific requirements → Verification → Supporting information.
- **References is its own clause**, not folded into the Introduction.
- **Verification clause is present** and mirrors the requirements clause. (Most commonly omitted — check it first.)
- Headings present even when a clause is brief.
- Reads like a specification, not a brainstorm transcript.

## Requirement construct (§5.2.4)

- Each requirement follows `[Condition] [Subject] shall [Action] [Object] [Constraint]`.
- Subject is the **system or a system element** — no "the user shall".
- Modal verbs used correctly: `shall` binding · `should` goal · `may` permission · `will` fact/intent.
- No `must`, `has to`, or bare present tense standing in for `shall`.

## Requirement characteristics (§5.2.5) — each requirement

- **Necessary** — removing it leaves a gap.
- **Appropriate** — right level of abstraction for this document.
- **Unambiguous** — one reading only.
- **Complete** — needs no other text to be understood.
- **Singular** — one requirement per identifier, one `shall`.
- **Feasible** — achievable within known constraints.
- **Verifiable** — a method (Inspection / Analysis / Demonstration / Test) can confirm it.
- **Correct** — accurately represents the source need.
- **Conforming** — follows this document's standard patterns.

## Set characteristics (§5.2.6) — the requirement set

- **Complete** — no known gaps in coverage.
- **Consistent** — no contradictions between requirements.
- **Feasible** — the set as a whole is achievable.
- **Comprehensible** — a reader can grasp it as a whole.
- **Able to be validated** — stakeholders can confirm it captures their need.

## Attributes (§5.2.5)

- Identifier unique and stable; **never reused** after deletion.
- Priority stated where the source supports it.
- Rationale / source traceable to a source artifact.
- **Verification method stated** for every requirement.
- Status recorded when the corpus tracks supersession.

## Language traps (§5.2.7)

Scan for and eliminate:
- Superlatives: `best`, `optimal`, `state-of-the-art`.
- Vague adjectives: `user-friendly`, `fast`, `robust`, `flexible`, `approximately`.
- Open-ended clauses: `etc.`, `and so on`, `including but not limited to`.
- Unverifiable absolutes: `100% reliable`, `never fails`, `always available`.
- Passive voice hiding the actor: "the record shall be updated" — *by what?*

## Coverage

- All major source features represented.
- Key user classes identified.
- Interfaces and dependencies documented.
- Constraints and assumptions captured.
- Missing information surfaced explicitly, never invented.

## Consistency

- Feature names consistent across clauses.
- Terms and acronyms defined or obvious from context.
- No contradictory requirements left unresolved.
- Current-state observations not mixed with future-state requirements.

## Corpus conformance

When appending to an existing corpus:
- Language and binding verb match the corpus (e.g. Vietnamese **"phải"**, not `shall`).
- ID scheme matches the corpus, continuing its sequence.
- **No existing section or ID renumbered** to fit 29148.

## Review readiness

- Open questions isolated in their own section.
- Concise enough for stakeholder review.
- Usable by engineering and QA without major rewriting.
