---
name: document-to-ieee-srs
description: Convert source documents into a Software Requirements Specification conforming to ISO/IEC/IEEE 29148:2018. Use when Codex needs to read a BRD, PRD, meeting notes, scope document, policy file, legacy SRS, feature list, DOCX, PDF export, Markdown spec, or mixed requirement notes and produce a structured, review-ready SRS with clear functional and non-functional requirements, verification criteria, assumptions, interfaces, constraints, and acceptance-ready wording.
---

# Document To IEEE SRS

Read the source material, normalize it into an **ISO/IEC/IEEE 29148:2018** SRS structure, and
produce a review-ready specification that distinguishes sourced facts from inferred assumptions.

## Standard

Target **ISO/IEC/IEEE 29148:2018** (*Systems and software engineering — Life cycle processes —
Requirements engineering*), which **superseded and withdrew IEEE 830-1998**. If a user or an
existing corpus asks for "IEEE 830", produce 29148 and note the supersession — unless the
corpus's existing structure must be preserved (see *Working with an existing corpus*).

What 29148 changes versus an 830-style draft:

| | IEEE 830-1998 | ISO/IEC/IEEE 29148:2018 |
| --- | --- | --- |
| Top-level clauses | Introduction / Overall description / Specific requirements | **Introduction / References / Specific requirements / Verification / Supporting information** |
| References | Buried in §1 | **Own clause 2** |
| Verification | Absent | **Required clause 4**, mirroring clause 3 |
| Requirement form | "shall" sentence | **Construct** (§5.2.4) + **attributes** (§5.2.5) |
| Quality bar | Informal | **9 requirement characteristics + 5 set characteristics** |

## Workflow

1. **Read the source artifact.**
Accept DOCX export, PDF export, Markdown, plain text, spreadsheet extracts, tickets, workshop
notes, legacy specifications, or pasted requirements. When the source spans multiple artifacts,
merge them into one requirement set before drafting.

2. **Identify the document baseline.**
Determine: product/system name; intended users and stakeholder groups; business goal; major
features or modules; interfaces and dependencies; constraints, assumptions, and open questions.

If the source lacks enough information for a clause, keep the clause but mark assumptions
explicitly instead of inventing unsupported detail.

3. **Build the requirement inventory.**
Extract every explicit requirement and normalize it into concise, verifiable language. Separate:
functional requirements; non-functional requirements (usability, performance, software system
attributes); external interface requirements; data/logical database requirements; business rules;
constraints and assumptions.

When IDs are missing, synthesize stable IDs such as `FR-001`, `NFR-001`, `EXT-001`, `DATA-001`.
**Never reuse an identifier** after a requirement is deleted (29148 §5.2.5).

4. **Draft the SRS in 29148 clause order.**
Use `references/ieee-srs-template.md` unless the user asks for a variant. Preserve the flow:
Introduction → References → Specific requirements → **Verification** → Supporting information.

5. **Write requirements to the 29148 construct.**

> **[Condition]** **[Subject]** **shall** **[Action]** **[Object]** **[Constraint of action]**

Subject is the system or a system element — *never* "the user shall", which states a use, not a
requirement. Keep each requirement **singular** (one `shall` per ID), observable, and verifiable.
Split overloaded statements.

Modal verbs are not interchangeable: **shall** = binding requirement · **should** = goal ·
**may** = permission · **will** = fact or intent about another party. Never "must", "has to", or
bare present tense for a binding requirement.

6. **Attach requirement attributes** (§5.2.5) to the extent the source supports: identifier,
priority, rationale/source, **verification method**, status. Inline or in a table — but a
requirement with no derivable verification method is not verifiable yet; fix it or log it as an
open question.

7. **Write the Verification clause.**
This is the clause most often skipped, and 29148 requires it. For each requirement in clause 3,
state the method — **Inspection / Analysis / Demonstration / Test** — and the observable
pass/fail criteria, in a structure parallel to clause 3.

8. **Surface gaps instead of hiding them.**
When the source is ambiguous, incomplete, or contradictory: add `Assumptions and Open Questions`
under Supporting information; keep unresolved points separate from confirmed requirements; do not
silently fill major business-logic gaps.

9. **Perform a completeness pass.**
Verify against `references/srs-quality-checklist.md`: every source requirement represented; IDs
unique and stable; functional vs non-functional separated; interfaces called out; every
requirement verifiable with a stated method; terms and acronyms defined; the result reads like a
specification, not meeting notes.

## Output Rules

Produce output in this order unless the user asks for another format:

1. `# Software Requirements Specification`
2. Short document control block (version, date, status, standard) when useful
3. 29148 clauses following `references/ieee-srs-template.md`
4. `## Verification` — required whenever clause 3 has requirements
5. `## Assumptions and Open Questions` when needed
6. `## Requirement Trace Summary` when the source is fragmented or heavily inferred

Keep prose concise. Prefer bullet lists for characteristics and identified requirements for
enforceable statements.

## Requirement Writing Rules

- Use `shall` for binding requirements; avoid vague verbs like `supports`, `handles`, or `allows` unless clarified.
- One requirement per identifier — **singular** is a 29148 characteristic, not a style preference.
- Name features consistently across clauses.
- Convert informal user wishes into system-facing requirement statements.
- Distinguish current-state facts from future-state requirements.
- Keep acceptance-relevant detail *in* the requirement, not buried in surrounding prose.
- Convert UI expectations into interface or functional requirements, not loose design notes.
- Avoid the §5.2.7 language traps: superlatives (`best`, `optimal`), vague adjectives (`user-friendly`, `fast`, `robust`), open-ended clauses (`etc.`, `and so on`), unverifiable absolutes (`100% reliable`, `never fails`), and passive voice that hides the actor.

## Quality Bar (29148 §5.2.5–5.2.6)

Each **requirement**: necessary · appropriate · unambiguous · complete · singular · feasible ·
verifiable · correct · conforming.

The requirement **set**: complete · consistent · feasible · comprehensible · able to be validated.

## Clause Guidance

- `1. Introduction`: purpose, scope, product overview (perspective, functions, user characteristics, limitations), definitions.
- `2. References`: every source artifact, identifiable and dated/versioned where possible.
- `3. Specific requirements`: external interfaces; functions (by feature/module); usability; performance; logical database; design constraints; software system attributes.
- `4. Verification`: method + criteria per requirement, parallel to clause 3.
- `5. Supporting information`: assumptions, dependencies, open questions, trace summaries, appendices.

## Working with an existing corpus

When adding to a corpus that already exists, **the corpus's conventions win over this skill's
defaults.** Match its language (a Vietnamese corpus binds with **"phải"**, not `shall`), its ID
scheme, and its existing clause numbering. Do **not** renumber existing sections or IDs to fit
29148 — that breaks cross-references, trace tables, and downstream documents. Apply 29148 to
*new* material: the requirement construct, verification thinking, and the quality bar carry over
even when the section skeleton cannot change.

## Resources

Read these before generating the final SRS:
- [references/ieee-srs-template.md](references/ieee-srs-template.md) — 29148 clause structure, requirement construct, attributes.
- [references/srs-quality-checklist.md](references/srs-quality-checklist.md) — final review pass.
