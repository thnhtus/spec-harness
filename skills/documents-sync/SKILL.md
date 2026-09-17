---
name: documents-sync
description: Use when syncing the tracker's project documentation into the repo's SRS/FSD — e.g. "sync the docs from ClickUp", "update the SRS/FSD from ClickUp", "the requirements doc changed in ClickUp", "pull the latest project docs into docs/srs and docs/fsd". Fetches ClickUp doc pages, detects changes against a sync manifest, then creates new or merges into existing docs/srs + docs/fsd modules in IEEE format.
---

# documents-sync

## Overview

Keeps `docs/srs/` (IEEE SRS) and `docs/fsd/` (FSD) in sync with the tracker's **project documentation**. Each run: fetch ClickUp doc pages → diff against a stored **sync manifest** → for each changed/new page, **create** a new module or **merge** the delta into the existing module, in IEEE format via the `document-to-ieee-srs` skill (**ISO/IEC/IEEE 29148:2018**).

**Core principle:** the manifest is the source of truth for "what changed". Without it, change detection degrades to expensive guessing — so the manifest is read first and written last, every run.

These docs are **fully hand-curated prose with NO AUTOGEN markers** (unlike `docs/api/`). You never machine-overwrite a region; you make **curated, additive edits** and **never renumber existing requirement IDs** (the trace summary and FSD reference them).

## When to use

- ClickUp project docs changed and `docs/srs` / `docs/fsd` need to catch up.
- A new feature/module/use-case was documented in ClickUp and has no SRS/FSD yet.
- Periodic "are our specs still in sync with ClickUp?" check.

**Not for:** API reference docs (`docs/api/` — use `api-docs-sync`); task docs under `docs/tasks/`; committing (leave the tree for the user).

## Prerequisites

- ClickUp MCP connected (`claude mcp list` shows `clickup ✓`).
- Config: `.claude/skills/documents-sync/docs.json` — `{ workspaceId, documents: [{ name, documentId }] }`. Ships with placeholders: fill in the workspace id and the doc ids your SRS/FSD came from before the first run.
- The `document-to-ieee-srs` skill (**ISO/IEC/IEEE 29148:2018** — requirement construct, attributes, quality bar).

## Workflow

```
1. Read manifest  → 2. Fetch ClickUp pages  → 3. Classify each page
   → 4. Create or Merge (per page)  → 5. Write manifest + report
```

### 1. Read the sync manifest

Read `docs/.sync-state/clickup-docs.json` (create the dir/file on first run if missing). Schema:

```json
{
  "lastSyncedAt": "2026-06-02T00:00:00Z",
  "documents": {
    "<doc-id>": {
      "pages": {
        "<pageId>": {
          "name": "TEMPLATE KÝ",
          "dateUpdated": "1780...",
          "contentSha256": "<hash of page content>",
          "contentSnapshot": "<last-synced page markdown, verbatim>",
          "srsFile": "docs/srs/04-eform-signing-template.md",
          "fsdFile": "docs/fsd/04-eform-signing-template.md",
          "idRanges": { "srs": "FR-TMPL-001..037" }
        }
      }
    }
  }
}
```

First run (no manifest): **bootstrap, don't re-merge everything.** Build the page→file map from `docs/srs/20-requirement-trace-summary.md` §8.1 (the existing "ClickUp source page → SRS file → requirement ID range" table) rather than guessing. A page already mapped in §8.1 is **already covered** — seed its hash into the manifest and treat it as unchanged (the current SRS/FSD were generated from these very pages). Only treat a page as **MERGE** if its `date_updated` is clearly after the corpus generation date (see `docs/srs/README.md`), and only treat a page as **NEW** if it's absent from §8.1. This avoids re-scanning the entire corpus on the first run.

### 2. Fetch ClickUp doc pages

The connected `clickup` MCP exposes doc tools whose exact names may be namespaced — confirm against the live tool list before calling. The needed capabilities (typical names shown):
1. **list document pages** (`clickup_list_document_pages(documentId, max_page_depth=-1)`) → full page tree (`id`, `name`, `parent_page_id`, `order_index`).
2. **get document pages** (`clickup_get_document_pages(documentId, page_ids=[...])`) in batches of ~12 → `content` (markdown), `name`, `date_updated`, `archived`, `deleted` per page.

Skip `deleted` pages; note `archived` separately. **Container pages** (empty `content`, e.g. "Project Docs", "Quản lý E-Form") are groupings — skip for content, recurse into children. **Empty placeholder** child pages (`content` ≈ 0 chars) → route to `docs/srs/19-assumptions-open-questions.md` as an open question; **never invent requirements** for them.

Optional sanity check when the workspace may hold other docs: `clickup_search(filters={"asset_types":["doc"]})` to confirm the configured doc list is complete.

### 3. Classify each page

Compute `contentSha256` of the fetched `content`. Compare to the manifest entry:

| Manifest state | Classification |
| --- | --- |
| page id absent from manifest **and** name absent from trace table §8.1 | **NEW** (no SRS/FSD yet) |
| page id present, hash unchanged | **unchanged** (skip) |
| page id present, hash changed | **MERGE** (delta into existing module) |
| SRS module exists but parallel `docs/fsd/<same-basename>` missing | **FSD-MISSING** (create FSD only) |

Map page → file in this order: (a) trace table §8.1 lookup by normalized page name; (b) shared `NN-slug.md` / `use-cases/UC-<AREA>-NN-slug.md` convention (SRS and FSD share the basename — **exception:** the intro is `srs/00-introduction-overall-description.md` vs `fsd/00-tong-quan.md`); (c) no match → NEW. Several pages may collapse into one module (e.g. E-Docs) — route the delta to the file the trace table names; flag a genuinely new sub-topic instead of forcing it.

### 4. Create or Merge (per classified page)

Invoke the `document-to-ieee-srs` skill for IEEE structure + requirement language, then:

**CREATE NEW**
- SRS: new `docs/srs/NN-<slug>.md` (use-case → `docs/srs/use-cases/UC-<AREA>-NN-<slug>.md`). For `NN`: feature modules 00–16, cross-cutting 17–20 — **do not silently pick a number**; propose one and surface the choice in the report.
- FSD: parallel `docs/fsd/NN-<slug>.md`, derived from the new SRS module, adding FSD-only sections seen in existing FSD files (Màn hình / Bảng trường / Validation / Máy trạng thái / API I/O / Tiêu chí nghiệm thu Given-When-Then) with `FSD-<MOD>-nnn` IDs (`🆕 FSD-<MOD>-NEW-nnn` for BA additions). No dedicated FSD generator exists — mirror the existing files' shape.
- Update both READMEs' "Bản đồ tài liệu" and trace table §8.1.

**MERGE (curated, additive)**
1. Identify the delta: diff the new page `content` against `contentSnapshot` from the manifest (the last-synced version) to get exactly the added/changed/struck-through source lines. If no snapshot exists (legacy entry), fall back to judging which source bullets aren't yet represented by a requirement ID in the mapped file.
2. Convert each to IEEE requirement language; **append with the next sequential ID** in that module's series (e.g. `…FR-TMPL-037` → new `FR-TMPL-038`). **Never renumber existing IDs.**
3. Superseded/struck-through source rules → record the replaced behavior in `19-assumptions-open-questions.md`; keep only the latest confirmed rule in the module (matches the existing "Ghi chú về độ phủ nguồn" convention).
4. Mirror the same delta into the FSD module; extend §8.1 ID ranges.
5. **Every `🆕 FSD-<MOD>-NEW-nnn` you write must also get an `OQ-nnn` entry** in `19-assumptions-open-questions.md` — see below.

## Open questions must reach the central registry (critical)

A `🆕 FSD-<MOD>-NEW-nnn` is an **unanswered question**, not a requirement. Left only in its FSD module it has no owner, no due date, and nobody sweeping for it — the task harness reads one FSD file per task, so a blocking question two modules away is invisible until a dev hits it mid-implementation.

**Rule:** when you write or touch a `FSD-<MOD>-NEW-nnn`, allocate the next `OQ-nnn` in [`docs/srs/19-assumptions-open-questions.md`](../../../docs/srs/19-assumptions-open-questions.md) (append under the relevant `§7.x`, or open a new `§7.x` for a new theme) and cross-link both directions:

- FSD side: `🆕 FSD-TASK-NEW-008 | … | Câu hỏi mở ❓ **OQ-074**`
- SRS side: `- **OQ-074** *(mới YYYY-MM-DD)* **<tiêu đề>** (module NN, FSD-TASK-NEW-008). <câu hỏi + vì sao chặn>. Cần BA chốt: (a) … (b) …`

This is the same shape `OQ-069`…`OQ-073` already use. The SRS registry is the single place a BA reads to know what is still open; a question that never lands there is a question nobody answers.

**Scope:** applies to `NEW-nnn` you create or edit in this sync run. ~193 pre-existing orphans (audited 2026-08-16) stay as-is — pick them up opportunistically when a sync run touches their module, don't backfill in bulk.

**Do not** invent a resolution to close a question yourself. If the source genuinely answers it, cite the source and convert it into a real `FSD-<MOD>-nnn`; otherwise it stays open with an OQ id.

### 5. Write manifest + report

Rewrite `docs/.sync-state/clickup-docs.json` with the fetched pages' ids, names, `date_updated`, fresh `contentSha256`, mapped files, and ID ranges; set `lastSyncedAt`. Then report: pages **created / merged / unchanged / FSD-missing-filled / placeholder→open-question**, files touched, any `NN`-numbering or collapse decisions made, and any pages that need human confirmation. **Do not commit** — leave the tree for the user.

## Language rule (critical)

The existing corpus is **Vietnamese** and uses **"phải"** for binding requirements (not English "shall"). `document-to-ieee-srs` defaults to English "shall" — **follow the existing file's language and convention, not the skill default.** ID prefixes match `docs/srs/README.md`: `FR-<MODULE>-nnn`, `NFR-nnn`, `EXT-nnn`, `DATA-nnn`, `BR-<MODULE>-nnn`.

The 29148 modal distinction still applies, in Vietnamese: **"phải"** = binding (`shall`) · **"nên"** = goal (`should`) · **"có thể"** = permission (`may`). Don't render a source's soft wish as **"phải"** — if BA wrote a preference, it isn't a binding requirement.

## 29148 in this corpus — what carries over, what doesn't

The corpus predates 29148 and is structured on **IEEE 830** (`§4.x` module numbering, `docs/srs/README.md` records the transition). Section skeletons and IDs are load-bearing: the trace table §8.1, ~490 `§` cross-refs, and the parallel FSD all point at them.

**Do NOT** restructure existing modules into 29148 clause order, add a clause-4 Verification section to a module, or renumber `§4.x` — that is a separate migration, not a sync run.

**DO** apply 29148 to the requirement text you write:

| 29148 concept | How it lands here |
| --- | --- |
| Requirement construct §5.2.4 | `[Điều kiện] [Chủ thể] phải [Hành động] [Đối tượng] [Ràng buộc]` — subject is **"Hệ thống"** / a screen / a component, never "người dùng phải" (that's a use, not a requirement) |
| Singular §5.2.5 | One `phải` per ID. A source bullet bundling 3 behaviors → 3 IDs, not one paragraph |
| Verifiable §5.2.5 | If you cannot name how it'd be checked, it's not a requirement yet → open question, not a vague FR |
| Verification clause §9.6.2 | Lives in the **FSD** as `Tiêu chí nghiệm thu` (Given-When-Then), not as an SRS clause 4. Writing the Gherkin *is* the verification pass |
| Attributes §5.2.5 | Identifier (the FR ID) + source (the `> Nguồn:` blockquote naming the ClickUp page) are mandatory; priority via the module's `Độ ưu tiên` |
| Never reuse IDs §5.2.5 | Already the rule here — superseded requirements stay in place, marked, and the ID is retired, never recycled |
| Language traps §5.2.7 | Don't launder BA vagueness into requirement voice. "Giao diện thân thiện", "xử lý nhanh", "v.v." in the source → either pin it down or log it as an OQ. Copying vagueness into a `phải` sentence makes it look specified when it isn't |

## § must be a link (critical)

**`§` means "section" — so every `§` you write MUST resolve by clicking.** A `§4.13.6` the reader has to hunt for by scrolling is a broken cross-reference wearing a typographic mark. Two cases:

**Cross-document** (`FSD 08 §3.8`, `SRS 13 §4.13.5`, `module 14 §4.14.6`) → markdown link with **file path + `#anchor`**:

```markdown
[FSD 08 §3.8](./08-eflow-node-catalog.md#38-ký-số--ký-nháy-fr-node-029030)
[SRS 19 §7.12b](../srs/19-assumptions-open-questions.md#712b-xác-định-chứng-thư-số-theo-pháp-nhân-module-13-bổ-sung-30072026)
```

Relative paths: within `docs/fsd/` use `./file.md`; FSD → SRS uses `../srs/file.md` (and vice versa).

**Same-file** (`xem §6`, `chi tiết ở §10`) → anchor-only link: `[§6](#6-validation--quy-tắc-nghiệp-vụ)`.

### Deriving the anchor (GitHub slug rule)

From the target's heading text: lowercase → delete all punctuation **except** `-` and `_` → spaces to `-`. Vietnamese diacritics are **kept as-is** (`ký` stays `ký`, never `ky`). Deleted punctuation between two words leaves a **double hyphen** — `Ký số & Ký nháy` → `ký-số--ký-nháy` (the `&` vanishes, both its spaces become hyphens).

**Never guess the anchor — read the target file's actual heading first.** Then verify every anchor you wrote resolves:

```bash
python3 - <<'PY'
import re, io, glob, os
def slug(h):
    s = re.sub(r'[^\w\s-]', '', h.strip().lower(), flags=re.UNICODE)
    return re.sub(r'\s', '-', s)
heads = {os.path.normpath(f): {slug(m.group(2)) for m in
         re.finditer(r'^(#{1,6})\s+(.*)$', io.open(f, encoding='utf-8').read(), re.M)}
         for f in glob.glob('docs/srs/**/*.md', recursive=True) + glob.glob('docs/fsd/**/*.md', recursive=True)}
bad = 0
for f, hs in heads.items():
    txt = io.open(f, encoding='utf-8').read()
    for m in re.finditer(r'\[[^\]]*\]\(([^)#]*)#([^)]+)\)', txt):
        tgt = os.path.normpath(os.path.join(os.path.dirname(f), m.group(1))) if m.group(1) else f
        if m.group(2) not in heads.get(tgt, hs if not m.group(1) else set()):
            print('BROKEN', f, '->', m.group(1) + '#' + m.group(2)); bad += 1
print('broken anchors:', bad)
PY
```

### Two carve-outs

1. **A `§` that names no target section is not a cross-reference** — leave it alone. `docs/srs/20-requirement-trace-summary.md` §8.1 headings and prose like "ghi nhận tại §8.1 của chính tài liệu này" describing the current file's own structure need no link.
2. **Don't retrofit the whole corpus.** ~490 legacy `§` refs predate this rule (mostly `FSD 08 §4`, `FSD 11 §4`). Linking them all is a separate cleanup task, not part of a sync run. The rule binds **every `§` in a line you add or edit** — if you touch a line, its `§` gets linked.

## Common mistakes

| Mistake | Reality / fix |
| --- | --- |
| Diffing by re-reading SRS prose vs ClickUp each run | SRS is a *rewritten normalization*, not a copy — byte/semantic diff is unreliable & token-heavy. Use the manifest hash. |
| Overwriting/regenerating a whole module file | No AUTOGEN markers here — merge additively, preserve hand-edits and IDs. |
| Renumbering requirement IDs while merging | IDs are referenced by the trace table + FSD. Only append the next sequential ID. |
| Emitting English "shall" | Existing corpus is Vietnamese ("phải"). Match the file. |
| Restructuring a module into 29148 clause order (or adding a clause-4 Verification) mid-sync | Corpus is 830-shaped `§4.x` and load-bearing. Apply 29148 to the **requirement text**, not the skeleton. |
| Rendering a BA preference as **"phải"** | 29148 modals: "phải"=shall, "nên"=should, "có thể"=may. A wish is not binding. |
| One `phải` sentence bundling 3 behaviors | **Singular** (§5.2.5) — split into 3 IDs. |
| Appending a new §, but leaving the **scope/intro** statement it contradicts | Adding a CRUD screen to a module whose §1 says "chỉ-đọc từ HCM" makes the module contradict itself. Update the scope line too. |
| Appending a new §, but leaving stale **enumerations** elsewhere in the file | New status → the tab list in FSD §3.x; new field → the popup summary in §3.x *and* the field table in §4; new node behavior → the node action matrix. Grep the file for the list you just invalidated. |
| Trusting your own cross-refs ("mở rộng bộ tab của FR-TASK-001") | Open the target ID and confirm it says what you claim. Cite the ID that actually holds the tabs. |
| Inventing requirements for empty placeholder pages | Route to `19-assumptions-open-questions.md`. |
| Writing a `🆕 FSD-<MOD>-NEW-nnn` and stopping there | It's an open question, not a requirement — allocate an `OQ-nnn` in `19-assumptions-open-questions.md` and cross-link. A question only in an FSD module has no owner and blocks a dev later. |
| Skipping FSD because SRS was handled | FSD can drift (e.g. UC-EDOC-02 exists in SRS, missing in FSD). Check the parallel FSD file every time. |
| Auto-mapping a source page to FSD `11.1`–`11.11` per-node files | Those are BA-elaborated, no 1:1 ClickUp page — don't touch them from a single page unless a node-specific page appears. |
| Picking a new module `NN` silently | Propose it and surface in the report. |
| Writing a bare `§4.13.6` in a line you author | `§` = "section" ⇒ must be clickable. Link it with file + `#anchor`. |
| Guessing an anchor from the section *number* (`#4136`) | Anchor comes from the **heading text** slug, not the number. Read the target heading. |
| Stripping Vietnamese diacritics in an anchor (`#ky-so`) | GitHub slugs keep diacritics — `#ký-số`. |
| Forgetting to write the manifest | Next run can't diff. Always write it last. |

## Red flags — STOP

- About to overwrite an existing srs/fsd module wholesale → merge instead.
- About to renumber existing `FR-`/`NFR-`/`FSD-` IDs → append only.
- Writing English "shall" into a Vietnamese file → use "phải".
- Finished SRS without checking the parallel FSD file → check it.
- About to leave a `§` you just wrote unlinked → link it (file + `#anchor`), then run the anchor check.
- About to renumber `§4.x` or add a clause-4 Verification "to conform to 29148" → stop; that's a separate migration.
- Finished a merge without re-reading the module's **scope statement** and the **lists** your delta invalidated (tabs, field tables, action matrices, state machines) → re-read them.
- Cited another requirement ID from memory → open it and verify it says what you claim.
- Run ending without rewriting the manifest → write it.

## Self-review before reporting

A merge is not done when the new section is written. Before reporting, re-read your own diff and check:

1. **Cross-refs resolve *and* are true** — every `FR-…`/`FSD-…` you cited exists, and says what your sentence claims it says.
2. **ID ranges you wrote match reality** — a cited `FR-MD-031…035` when the range is `…037` is wrong the moment it's written.
3. **Nothing the delta invalidated is stale** — scope/intro statements, tab lists, field tables, node/action matrices, state machines, `Actor & quyền`.
4. **Anchors** — run the checker; 0 broken (excluding known pre-existing refs outside `docs/srs`+`docs/fsd`).
5. **No ID renumbered or removed** — `git diff -U0 docs/ | grep -E '^-.*\*\*(FR|BR|NFR|DATA|EXT)-'` must be empty.

Report defects you found in your own work rather than only the happy path.
