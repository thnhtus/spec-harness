---
name: api-docs-sync
description: Use when the user wants to generate, refresh, or sync API reference docs from the backend Swagger/OpenAPI specs into docs/api/ — e.g. "sync the API docs", "update the swagger docs", "regenerate docs/api", "crawl the OpenAPI specs". Fetches each service's OpenAPI JSON, renders one markdown file per resource (AUTOGEN region), and Claude curates the human-owned Overview/Notes.
---

# api-docs-sync

Generates a source-of-truth API reference under `docs/api/` from each backend
service's OpenAPI document. A zero-dependency Node script (`generate.mjs`)
renders the machine part; Claude curates the human part. Re-run any time an API
changes.

**Paths below are relative to the project root.** The
generator lives at `.claude/skills/api-docs-sync/`.

## How it splits work

Each resource file (`docs/api/<resource>.md`) has two zones:

- **AUTOGEN block** (between `<!-- AUTOGEN:START … -->` and `<!-- AUTOGEN:END -->`):
  owned by `generate.mjs`. **Never hand-edit it.** Re-running the script rewrites
  only this region.
- **`## Overview` and `## Notes`**: owned by Claude. The script preserves them
  byte-for-byte. This is where curation goes.

## Prerequisites

Node ≥ 18 (native `fetch`). Verified on this machine:

```bash
node --version   # v26.0.0
```

No `npm install` — the generator has zero dependencies.

## Step 1 — Validate config

`services.json` lists each service and its OpenAPI URL. Check for unfilled
placeholders before generating:

```bash
grep -n REPLACE_ME .claude/skills/api-docs-sync/services.json
```

Any line that prints still has a placeholder URL. Those services are **skipped**
(with a warning) — not an error. To produce real docs, the user must replace
`https://REPLACE_ME/<service>/v3/api-docs` with the real OpenAPI endpoint.

### Supported `url` shapes

The generator auto-detects how the spec is served, so you can paste whichever
URL you have:

| Backend | Put this in `url` | How it's resolved |
|---------|-------------------|-------------------|
| springdoc (Spring Boot) | `…/v3/api-docs` | direct OpenAPI JSON |
| `@nestjs/swagger` (Nest) | the **Swagger UI** page, e.g. `…/<service>-doc/swagger` | the doc is embedded in `swagger-ui-init.js`; the generator follows the page to that script and extracts the inline `swaggerDoc` |
| any | a URL that returns the raw OpenAPI JSON | direct OpenAPI JSON |

In all cases the generator tries, in order: (1) parse the body as OpenAPI JSON,
(2) look for an embedded `"swaggerDoc": { … }` in the body, (3) if the body is
the Swagger UI HTML page, fetch its `swagger-ui-init.js` and extract the embedded
spec. A `#/`-fragment on a UI URL is harmless.

> **Some frameworks (e.g. NestJS) expose no `/v3/api-docs` endpoint** — use the
> Swagger UI URL instead (e.g. `https://<api-host>/<service>-doc/swagger`). Put the
> real URLs in `services.json`; they are project-specific (ProjectRules §1).
> `workflow-service` is already wired this way in `services.json`.

## Step 2 — Generate

From the project root:

```bash
node .claude/skills/api-docs-sync/generate.mjs
```

This fetches every non-placeholder service, groups operations by OpenAPI `tag`
(falling back to the first path segment when an operation has no tag), resolves
local `$ref` schemas, and writes `docs/api/<resource>.md` + `docs/api/README.md`.
It prints a per-service fetch result and an Added/Changed/Unchanged summary.

- Resources are alphabetical; endpoints sorted by path then method — so diffs
  stay minimal across runs.
- Re-running with unchanged specs produces **no diff** inside AUTOGEN blocks.
- Output dir override: `--out <dir>` (default `docs/api`). Config override:
  `--config <path>`.

**Exit code:** zero if at least one service succeeds (or there was nothing to
do); non-zero only if **every** attempted service fails.

## Step 3 — Polish (Claude's job)

For each **added or changed** resource file (from the summary), fill or refresh
**only** the `## Overview` and `## Notes` sections:

- **Overview**: one-paragraph "what this resource is and when the frontend uses
  it", plus cross-links to related resources (`[Documents](./documents.md)`).
- **Notes**: gotchas, auth requirements, pagination quirks, related endpoints.

Do **not** touch anything between the AUTOGEN markers. If you need a fact that
only lives in the AUTOGEN block, read it — don't copy it out.

## Step 4 — Update the index & summarize

`generate.mjs` already rewrites `docs/api/README.md` (service table + resource
links + synced date). Then report to the user:

- Resources **added / changed / unchanged**.
- Any services **skipped** (placeholder) or that **failed to fetch**, with the
  reason.
- Any resource files **skipped because they lack AUTOGEN markers**, or any
  **orphaned** files (a managed file whose backing spec/tag disappeared) — the
  script reports these; it never deletes them. Resolve by hand.

## Stop point — no commit

This skill does **not** run git. Leave the working tree changed for the user to
review and commit themselves.

## Self-check (optional, for changes to the generator)

If you modify `generate.mjs`, run the dependency-free self-check. It asserts
endpoint rendering, idempotency, Overview/Notes preservation, the `$ref` cycle
guard, missing-marker safety, and placeholder handling:

```bash
node .claude/skills/api-docs-sync/selfcheck.mjs
```

Expected tail: `✓ ALL CHECKS PASSED` (exit 0).

You can also dry-run the generator against the bundled fixture without touching
`docs/api/` — point `--config` at a tiny config whose `url` is the fixture file
(local paths are resolved relative to the config) and send output to a temp dir:

```bash
TMP=$(mktemp -d)
printf '[{"name":"sample","url":"%s/.claude/skills/api-docs-sync/fixtures/sample-openapi.json"}]\n' "$PWD" > "$TMP/services.json"
node .claude/skills/api-docs-sync/generate.mjs --config "$TMP/services.json" --out "$TMP/api"
ls "$TMP/api"        # README.md  trees.md  widgets.md
rm -rf "$TMP"
```

## Gotchas

- **`fetch failed` with no HTTP status** means the host/port was unreachable
  (DNS, connection refused, TLS) — the request never got a response. A reachable
  endpoint that returns an error shows up as `HTTP <code>` instead.
- **`not an OpenAPI document (no JSON spec, no embedded swaggerDoc)`** means the
  URL responded `200` but the generator found neither raw OpenAPI JSON, an inline
  `swaggerDoc`, nor a Swagger-UI init script with one. Usually the wrong URL (a
  login page, an app shell) — open it in a browser and find the actual Swagger UI
  or `/v3/api-docs` link.
- **NestJS services have no `/v3/api-docs`.** Point `url` at the Swagger UI page
  (`…/<service>-doc/swagger`); the generator extracts the embedded spec from
  `swagger-ui-init.js` automatically.
- **Tag collisions across services merge into one resource file**, with a
  per-service `### <service>` sub-heading inside the AUTOGEN block. That
  sub-heading is regenerated — don't treat it as hand-maintained.
- **Recursive schemas** (a `$ref` cycle) render as `_(recursive reference: …)_`
  rather than expanding forever; resolution is also depth-capped.
- **Files without AUTOGEN markers are never overwritten.** If you hand-create a
  resource file, the script will skip it until you add the marker block.

## Files

```
.claude/skills/api-docs-sync/
├── SKILL.md                     # this file
├── generate.mjs                 # zero-dep generator (run this)
├── services.json                # service → OpenAPI URL list (edit URLs here)
├── selfcheck.mjs                # node-only self-test for the generator
└── fixtures/
    └── sample-openapi.json      # spec used by the self-check / dry-run
```
