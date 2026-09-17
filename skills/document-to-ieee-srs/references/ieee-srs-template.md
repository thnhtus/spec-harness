# SRS Template — ISO/IEC/IEEE 29148:2018

Default output skeleton (29148 §9.6.2 SRS outline) unless the user asks for another variant.

29148 replaced IEEE 830-1998 (withdrawn). The visible differences from an 830 skeleton:
top-level clauses are **Introduction / References / Specific requirements / Verification /
Supporting information**; **References is its own clause 2**; **Verification is a required
clause 4** that mirrors clause 3 requirement-for-requirement; and every requirement carries
the 29148 §5.2.5 attributes rather than being a bare sentence.

# Software Requirements Specification

## 1. Introduction

### 1.1 Purpose
State what the system is, why this SRS exists, and what decision or delivery it supports.

### 1.2 Scope
Name the system, summarize the boundary, major capabilities, and major exclusions. State what
the system will and will not do, and its business objectives.

### 1.3 Product overview

#### 1.3.1 Product perspective
Whether the system is new, an enhancement, a replacement, or a component in a larger
ecosystem; its interfaces to adjacent systems.

#### 1.3.2 Product functions
Concise list of main capabilities.

#### 1.3.3 User characteristics
Key user or operator classes, permissions, domain expertise, and frequency of use.

#### 1.3.4 Limitations
Regulatory, architectural, technology, policy, or integration constraints that bound the
solution space.

### 1.4 Definitions
Domain terms, acronyms, and shortened names used later. (29148 merges 830's separate
"Definitions, acronyms and abbreviations" into one clause.)

## 2. References
Source documents, tickets, standards, policies, interviews, and prior specifications used to
derive this SRS. Each entry identifiable and, where possible, dated or versioned.

## 3. Specific requirements

Requirements go here. Every requirement follows the **requirement construct** and carries the
**attributes** below. Group by feature/module, or by the 29148 categories when the source is
organized that way.

### 3.1 External interfaces
User, hardware, software, and communications interfaces. Include only the subclauses the
system actually has.

### 3.2 Functions
Per feature or module:

#### 3.x Feature name
Short description plus priority/business rationale, then atomic requirements:

- **FR-001** The system shall …
- **FR-002** The system shall …

### 3.3 Usability requirements
Effectiveness, efficiency, and satisfaction criteria — measurable, not "user-friendly".

### 3.4 Performance requirements
Numeric, with units and conditions (load, concurrency, percentile).

### 3.5 Logical database requirements
Entities, relationships, integrity and validation rules, retention, migration, reporting.

### 3.6 Design constraints
Constraints imposed on the solution (standards compliance, mandated technology, hardware
limits).

### 3.7 Software system attributes
Reliability, availability, security, maintainability, portability — each stated measurably.

### 3.8 Supporting information
Anything needed to read clause 3 that is not itself a requirement.

## 4. Verification

**Required by 29148 and the clause most often omitted.** For each requirement in clause 3,
state how satisfaction will be verified, using a parallel structure (a §4.x per §3.x, or a
table keyed by requirement ID).

Verification methods: **Inspection**, **Analysis**, **Demonstration**, **Test**.

| Req ID | Method | Verification criteria |
| --- | --- | --- |
| FR-001 | Test | … observable pass/fail condition … |

A requirement whose verification method cannot be stated is not yet verifiable — fix the
requirement, don't leave the cell blank.

## 5. Supporting information
Appendices: assumptions and dependencies, open questions, trace summaries, domain models,
sample payloads, source mappings.

Keep **Assumptions and Open Questions** separate from confirmed requirements.

---

## Requirement construct (29148 §5.2.4)

Write each requirement to this shape:

> **[Condition]** **[Subject]** **shall** **[Action]** **[Object]** **[Constraint of action]**

- *When the SLA elapses (condition), the system (subject) shall (verb) transition (action) the task (object) to Overdue within 60 seconds (constraint).*
- Subject is the system or a system element — never "the user shall", which states a use, not a requirement.
- **shall** = binding requirement. **should** = goal/desirable. **may** = permissible. **will** = statement of fact/intent about another party. Use **shall** for anything binding; never "must", "has to", or bare present tense.

## Requirement attributes (29148 §5.2.5)

Carry these per requirement, inline or in a table, to the extent the source supports:

| Attribute | Purpose |
| --- | --- |
| Identifier | Unique, stable, never reused after deletion |
| Priority | Ranked importance for delivery |
| Rationale / source | Why it exists; which source artifact it came from |
| Verification method | Inspection / Analysis / Demonstration / Test |
| Status | Proposed / approved / superseded |

## Characteristics of a good requirement (29148 §5.2.5–5.2.6)

Each requirement: **necessary**, **appropriate**, **unambiguous**, **complete**, **singular**,
**feasible**, **verifiable**, **correct**, **conforming**.

The requirement **set**: **complete**, **consistent**, **feasible**, **comprehensible**,
**able to be validated**.

## Writing pattern

- Split combined requirements into separate IDs — "singular" is a 29148 characteristic, not a style preference.
- Preserve source facts in neutral prose; put target behavior in requirement statements.
- Keep headings stable so later review cycles diff cleanly.
- Avoid the 29148 §5.2.7 language traps: superlatives ("best"), vague adjectives ("user-friendly", "fast"), open-ended clauses ("etc.", "and so on"), unverifiable absolutes ("100% reliable"), and passive voice that hides the actor.
