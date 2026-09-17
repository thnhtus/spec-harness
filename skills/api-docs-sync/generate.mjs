#!/usr/bin/env node
// api-docs-sync generator (Approach A): zero-dependency Node ESM.
//
// Reads services.json, fetches each service's OpenAPI JSON, groups
// operations by tag, resolves local $refs (with a cycle guard), and
// renders one markdown file per resource under the output directory.
// Only the region between the AUTOGEN markers is rewritten; everything
// else in a file is preserved byte-for-byte.
//
// Usage:
//   node generate.mjs [--config <services.json>] [--out <docs/api>] [--now <ISO>]
//
// Exit code: non-zero only if EVERY configured service fails; zero if at
// least one service produced output (or there was nothing to do).

import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const PLACEHOLDER = 'REPLACE_ME';
const MARKER_START = '<!-- AUTOGEN:START — do not edit by hand; run generate.mjs -->';
const MARKER_END = '<!-- AUTOGEN:END -->';
const AUTOGEN_RE = /<!-- AUTOGEN:START[\s\S]*?-->[\s\S]*?<!-- AUTOGEN:END -->/;
const MAX_DEPTH = 6;

// ---------------------------------------------------------------------------
// String helpers
// ---------------------------------------------------------------------------

export function slugify(s) {
  return String(s)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'untitled';
}

export function titleCase(s) {
  return String(s)
    .replace(/[-_]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\b\w/g, (c) => c.toUpperCase()) || 'Untitled';
}

function refName(ref) {
  return String(ref).split('/').pop();
}

// ---------------------------------------------------------------------------
// $ref resolution with cycle guard
// ---------------------------------------------------------------------------

// Resolve a local JSON pointer like "#/components/schemas/Pet".
function resolvePointer(spec, ref) {
  if (typeof ref !== 'string' || !ref.startsWith('#/')) return undefined;
  const parts = ref.slice(2).split('/').map((p) => p.replace(/~1/g, '/').replace(/~0/g, '~'));
  let cur = spec;
  for (const part of parts) {
    if (cur == null || typeof cur !== 'object') return undefined;
    cur = cur[part];
  }
  return cur;
}

// Follow a chain of $refs to a concrete schema node. `seen` guards cycles
// down a single chain. Returns a sentinel object on cycle/unresolved.
export function deref(schema, spec, seen) {
  let cur = schema;
  let guard = 0;
  while (cur && typeof cur === 'object' && cur.$ref) {
    const ref = cur.$ref;
    if (seen.has(ref)) return { __cycle: refName(ref) };
    seen.add(ref);
    const resolved = resolvePointer(spec, ref);
    if (resolved === undefined) return { __unresolved: ref };
    cur = resolved;
    if (++guard > 100) return { __cycle: refName(ref) };
  }
  return cur || {};
}

// A short human type label for a schema (does not recurse into objects).
export function typeName(schema, spec, seen = new Set()) {
  if (!schema || typeof schema !== 'object') return 'any';
  if (schema.$ref) {
    if (seen.has(schema.$ref)) return refName(schema.$ref);
    return refName(schema.$ref);
  }
  if (Array.isArray(schema.oneOf)) return schema.oneOf.map((s) => typeName(s, spec, seen)).join(' | ');
  if (Array.isArray(schema.anyOf)) return schema.anyOf.map((s) => typeName(s, spec, seen)).join(' | ');
  if (Array.isArray(schema.allOf)) return 'object';
  if (schema.type === 'array') {
    const items = schema.items || {};
    return `${typeName(items, spec, seen)}[]`;
  }
  if (Array.isArray(schema.enum)) {
    const base = schema.type || 'string';
    return `${base} enum`;
  }
  if (schema.type) return schema.type + (schema.format ? ` (${schema.format})` : '');
  if (schema.properties) return 'object';
  return 'any';
}

// Collect object fields from a schema, merging allOf. Returns null when the
// schema is not an object (caller renders a type label instead).
export function objectFields(schema, spec, seen) {
  const node = deref(schema, spec, seen);
  if (node.__cycle || node.__unresolved) return null;

  const props = {};
  const required = new Set();

  const absorb = (s) => {
    const n = deref(s, spec, new Set(seen));
    if (!n || typeof n !== 'object') return;
    if (Array.isArray(n.allOf)) n.allOf.forEach(absorb);
    if (Array.isArray(n.required)) n.required.forEach((r) => required.add(r));
    if (n.properties) Object.assign(props, n.properties);
  };
  absorb(node);

  const names = Object.keys(props);
  if (names.length === 0) return null;
  return names.map((name) => ({
    name,
    type: typeName(props[name], spec, seen),
    required: required.has(name),
    description: (deref(props[name], spec, new Set(seen)).description || '').replace(/\s+/g, ' ').trim(),
  }));
}

// ---------------------------------------------------------------------------
// Markdown rendering
// ---------------------------------------------------------------------------

function fieldsTable(fields) {
  const lines = ['| Field | Type | Required | Description |', '| --- | --- | --- | --- |'];
  for (const f of fields) {
    lines.push(`| \`${f.name}\` | ${f.type} | ${f.required ? 'yes' : 'no'} | ${f.description || ''} |`);
  }
  return lines.join('\n');
}

// Render a request/response schema as either a field table or a type line.
function renderSchema(schema, spec, depth = 0) {
  if (!schema) return '_No schema._';
  const seen = new Set();
  const node = deref(schema, spec, seen);
  if (node.__cycle) return `_(recursive reference: \`${node.__cycle}\`)_`;
  if (node.__unresolved) return `\`${refName(node.__unresolved)}\` _(unresolved $ref)_`;
  if (depth > MAX_DEPTH) return '_…(max depth)_';

  if (Array.isArray(node.oneOf) || Array.isArray(node.anyOf)) {
    const alts = node.oneOf || node.anyOf;
    const label = node.oneOf ? 'One of' : 'Any of';
    const items = alts.map((a) => `- \`${typeName(a, spec, seen)}\``).join('\n');
    return `${label}:\n${items}`;
  }

  if (node.type === 'array') {
    const items = node.items || {};
    const itemSeen = new Set();
    const itemNode = deref(items, spec, itemSeen);
    const inner = objectFields(itemNode, spec, itemSeen);
    const head = `Array of \`${typeName(items, spec, seen)}\``;
    return inner ? `${head}\n\n${fieldsTable(inner)}` : head;
  }

  const fields = objectFields(node, spec, seen);
  if (fields) return fieldsTable(fields);

  const tn = typeName(node, spec, seen);
  return `\`${tn}\``;
}

function renderParams(parameters, spec) {
  if (!Array.isArray(parameters) || parameters.length === 0) return '';
  const groups = { path: [], query: [], header: [] };
  for (const raw of parameters) {
    const p = raw && raw.$ref ? deref(raw, spec, new Set()) : raw;
    if (!p || !p.in) continue;
    if (!groups[p.in]) continue; // skip cookie/other
    groups[p.in].push(p);
  }
  const out = [];
  for (const kind of ['path', 'query', 'header']) {
    const list = groups[kind];
    if (list.length === 0) continue;
    const rows = ['| Name | Type | Required | Description |', '| --- | --- | --- | --- |'];
    for (const p of list) {
      const t = typeName(p.schema || {}, spec, new Set());
      const req = kind === 'path' ? true : !!p.required;
      const desc = (p.description || '').replace(/\s+/g, ' ').trim();
      rows.push(`| \`${p.name}\` | ${t} | ${req ? 'yes' : 'no'} | ${desc} |`);
    }
    out.push(`**${titleCase(kind)} parameters**\n\n${rows.join('\n')}`);
  }
  return out.join('\n\n');
}

function jsonContentSchema(content) {
  if (!content || typeof content !== 'object') return undefined;
  if (content['application/json']) return content['application/json'].schema;
  const first = Object.values(content)[0];
  return first ? first.schema : undefined;
}

function renderEndpoint(ep, spec) {
  const { method, path: p, op } = ep;
  const parts = [];
  parts.push(`#### ${method.toUpperCase()} ${p}`);
  const blurb = (op.summary || op.description || '').replace(/\s+/g, ' ').trim();
  if (blurb) parts.push(blurb);

  const params = renderParams(op.parameters, spec);
  if (params) parts.push(params);

  const bodySchema = op.requestBody && jsonContentSchema(op.requestBody.content);
  if (bodySchema) {
    const reqd = op.requestBody.required ? ' (required)' : '';
    parts.push(`**Request body**${reqd}\n\n${renderSchema(bodySchema, spec)}`);
  }

  if (op.responses && Object.keys(op.responses).length) {
    const codes = Object.keys(op.responses).sort();
    const respParts = ['**Responses**'];
    for (const code of codes) {
      const r = op.responses[code] && op.responses[code].$ref
        ? deref(op.responses[code], spec, new Set())
        : op.responses[code];
      const desc = (r && r.description ? r.description : '').replace(/\s+/g, ' ').trim();
      respParts.push(`- \`${code}\`${desc ? ` — ${desc}` : ''}`);
      const schema = r && jsonContentSchema(r.content);
      if (schema) {
        const rendered = renderSchema(schema, spec)
          .split('\n')
          .map((l) => (l ? `  ${l}` : l))
          .join('\n');
        respParts.push(rendered);
      }
    }
    parts.push(respParts.join('\n'));
  }

  return parts.join('\n\n');
}

// ---------------------------------------------------------------------------
// Grouping
// ---------------------------------------------------------------------------

const HTTP_METHODS = ['get', 'put', 'post', 'delete', 'patch', 'options', 'head', 'trace'];

function firstPathSegment(p) {
  const seg = String(p).split('/').filter((s) => s && !s.startsWith('{'))[0];
  return seg || 'root';
}

// Build a map of resource-key -> { tag, endpoints: [{service, method, path, op}] }
export function collectEndpoints(specsByService) {
  const resources = new Map();
  for (const { name: service, spec } of specsByService) {
    const paths = (spec && spec.paths) || {};
    for (const p of Object.keys(paths)) {
      const item = paths[p] || {};
      for (const method of HTTP_METHODS) {
        const op = item[method];
        if (!op || typeof op !== 'object') continue;
        const tag = Array.isArray(op.tags) && op.tags.length ? op.tags[0] : firstPathSegment(p);
        const key = slugify(tag);
        if (!resources.has(key)) resources.set(key, { tag, slug: key, endpoints: [] });
        resources.get(key).endpoints.push({ service, method, path: p, op, spec });
      }
    }
  }
  return resources;
}

// Render the AUTOGEN inner block (between markers, exclusive) for a resource.
export function renderAutogenBlock(resource) {
  const byService = new Map();
  for (const ep of resource.endpoints) {
    if (!byService.has(ep.service)) byService.set(ep.service, []);
    byService.get(ep.service).push(ep);
  }
  const services = [...byService.keys()].sort();
  const sections = ['## Endpoints'];
  for (const service of services) {
    const eps = byService.get(service).sort((a, b) => {
      if (a.path !== b.path) return a.path < b.path ? -1 : 1;
      return a.method < b.method ? -1 : 1;
    });
    sections.push(`### ${service}`);
    for (const ep of eps) sections.push(renderEndpoint(ep, ep.spec));
  }
  return sections.join('\n\n');
}

// Wrap an inner block in the markers.
function wrapMarkers(inner) {
  return `${MARKER_START}\n${inner}\n${MARKER_END}`;
}

// Replace the AUTOGEN region in existing content. Returns the new content,
// or null if the markers are missing (caller decides to skip).
export function replaceAutogen(existing, inner) {
  if (!AUTOGEN_RE.test(existing)) return null;
  return existing.replace(AUTOGEN_RE, wrapMarkers(inner));
}

// Scaffold a brand-new resource file around the AUTOGEN block.
export function scaffoldFile(resource, inner) {
  return [
    `# ${titleCase(resource.tag)}`,
    '',
    '## Overview',
    '',
    '<!-- Claude-owned: curated summary, when to use, cross-links -->',
    '',
    wrapMarkers(inner),
    '',
    '## Notes',
    '',
    '<!-- Claude-owned: gotchas, auth, related resources -->',
    '',
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Fetching
// ---------------------------------------------------------------------------

// Parse text as JSON and return it only if it looks like an OpenAPI doc.
function tryParseOpenApi(text) {
  try {
    const j = JSON.parse(text);
    return j && typeof j === 'object' && j.paths ? j : null;
  } catch {
    return null;
  }
}

// Return the balanced `{…}` object literal starting at/after `from`, honoring
// strings and escapes. Used to lift an embedded spec out of a JS file.
function extractBalancedObject(text, from) {
  const start = text.indexOf('{', from);
  if (start === -1) return null;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let j = start; j < text.length; j++) {
    const c = text[j];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === '{') depth++;
    else if (c === '}' && --depth === 0) return text.slice(start, j + 1);
  }
  return null;
}

// Some deployments (NestJS @nestjs/swagger) embed the whole OpenAPI document
// inside `swagger-ui-init.js` as `"swaggerDoc": { … }` rather than serving it
// at /v3/api-docs. Extract it when present.
export function extractEmbeddedSpec(text) {
  const m = /["']?swaggerDoc["']?\s*:/.exec(text);
  if (!m) return null;
  const obj = extractBalancedObject(text, m.index + m[0].length);
  return obj ? tryParseOpenApi(obj) : null;
}

// Find the Swagger UI init-script src in an HTML page.
function findInitScriptSrc(html) {
  const m = /<script[^>]*\bsrc=["']([^"']*swagger-ui-init[^"']*)["']/i.exec(html);
  return m ? m[1] : null;
}

// Load an OpenAPI document from an http(s) URL or a local file path. Handles
// three live shapes: (1) a direct OpenAPI JSON endpoint, (2) a Swagger UI
// init-script with an embedded `swaggerDoc`, (3) the Swagger UI HTML page,
// from which the init script is located and its embedded spec extracted.
async function loadSpec(url, configDir) {
  if (/^https?:\/\//i.test(url)) {
    const res = await fetch(url, { headers: { accept: 'application/json,text/html,*/*' } });
    if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
    const finalUrl = res.url || url;
    const body = await res.text();

    const direct = tryParseOpenApi(body);
    if (direct) return direct;

    const embedded = extractEmbeddedSpec(body);
    if (embedded) return embedded;

    const initSrc = findInitScriptSrc(body);
    if (initSrc) {
      const initUrl = new URL(initSrc, finalUrl).href;
      const initRes = await fetch(initUrl, { headers: { accept: 'application/javascript,*/*' } });
      if (initRes.ok) {
        const fromInit = extractEmbeddedSpec(await initRes.text());
        if (fromInit) return fromInit;
      }
    }
    throw new Error('not an OpenAPI document (no JSON spec, no embedded swaggerDoc)');
  }
  // Treat anything else as a local path (relative to the config file).
  const abs = path.isAbsolute(url) ? url : path.resolve(configDir, url);
  const txt = await readFile(abs, 'utf8');
  return tryParseOpenApi(txt) || extractEmbeddedSpec(txt) || JSON.parse(txt);
}

// ---------------------------------------------------------------------------
// README index
// ---------------------------------------------------------------------------

function renderReadme(services, resources, nowISO) {
  const lines = [
    '# API Reference',
    '',
    `> Generated by \`api-docs-sync\`. Last synced: ${nowISO.slice(0, 10)}.`,
    "> The AUTOGEN regions are machine-generated — re-run the skill to refresh them.",
    '',
    '## Services',
    '',
    '| Service | Source | Status |',
    '| --- | --- | --- |',
  ];
  for (const s of services) {
    lines.push(`| ${s.name} | \`${s.url}\` | ${s.status} |`);
  }
  lines.push('', '## Resources', '');
  const slugs = [...resources.keys()].sort();
  if (slugs.length === 0) {
    lines.push('_No resources generated yet._');
  } else {
    for (const slug of slugs) {
      const r = resources.get(slug);
      lines.push(`- [${titleCase(r.tag)}](./${slug}.md) — ${r.endpoints.length} endpoint(s)`);
    }
  }
  lines.push('');
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Main pipeline (also reusable by the self-check)
// ---------------------------------------------------------------------------

export async function run({ configPath, outDir, nowISO, logger = console }) {
  const configDir = path.dirname(path.resolve(configPath));
  const raw = await readFile(configPath, 'utf8');
  const config = JSON.parse(raw);

  const services = [];
  const specsByService = [];
  let attempted = 0;
  let failures = 0;

  for (const entry of config) {
    const { name, url } = entry;
    if (!url || url.includes(PLACEHOLDER)) {
      logger.warn(`⚠️  ${name}: URL is a placeholder (${PLACEHOLDER}); skipping.`);
      services.push({ name, url: url || '(none)', status: 'placeholder — skipped' });
      continue;
    }
    attempted++;
    try {
      const spec = await loadSpec(url, configDir);
      if (!spec || typeof spec !== 'object' || !spec.paths) {
        throw new Error('response is not an OpenAPI document (no `paths`)');
      }
      specsByService.push({ name, spec });
      services.push({ name, url, status: 'ok' });
      logger.log(`✓ ${name}: fetched.`);
    } catch (err) {
      failures++;
      logger.warn(`⚠️  ${name}: ${err.message}; skipping.`);
      services.push({ name, url, status: `failed — ${err.message}` });
    }
  }

  const resources = collectEndpoints(specsByService);
  await mkdir(outDir, { recursive: true });

  const result = { added: [], changed: [], unchanged: [], skipped: [], orphaned: [] };

  const slugs = [...resources.keys()].sort();
  for (const slug of slugs) {
    const resource = resources.get(slug);
    const inner = renderAutogenBlock(resource);
    const file = path.join(outDir, `${slug}.md`);

    if (existsSync(file)) {
      const existing = await readFile(file, 'utf8');
      const replaced = replaceAutogen(existing, inner);
      if (replaced === null) {
        logger.warn(`⚠️  ${slug}.md: AUTOGEN markers missing; left untouched.`);
        result.skipped.push(slug);
        continue;
      }
      if (replaced === existing) {
        result.unchanged.push(slug);
      } else {
        await writeFile(file, replaced);
        result.changed.push(slug);
      }
    } else {
      await writeFile(file, scaffoldFile(resource, inner));
      result.added.push(slug);
    }
  }

  // Report (don't delete) managed files no longer backed by a spec.
  try {
    const entries = await readdir(outDir);
    for (const f of entries) {
      if (!f.endsWith('.md') || f === 'README.md') continue;
      const slug = f.replace(/\.md$/, '');
      if (resources.has(slug)) continue;
      const content = await readFile(path.join(outDir, f), 'utf8');
      if (AUTOGEN_RE.test(content)) result.orphaned.push(slug);
    }
  } catch { /* outDir may be brand new */ }

  // README index.
  await writeFile(path.join(outDir, 'README.md'), renderReadme(services, resources, nowISO));

  return { services, attempted, failures, resources: slugs, result };
}

function parseArgs(argv) {
  const args = { config: null, out: null, now: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--config') args.config = argv[++i];
    else if (a === '--out') args.out = argv[++i];
    else if (a === '--now') args.now = argv[++i];
  }
  return args;
}

async function main() {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const args = parseArgs(process.argv.slice(2));
  const configPath = args.config || path.join(here, 'services.json');
  const outDir = args.out || path.resolve(process.cwd(), 'docs/api');
  const nowISO = args.now || new Date().toISOString();

  const summary = await run({ configPath, outDir, nowISO });

  console.log('\n── Summary ──────────────────────────────');
  console.log(`Output: ${outDir}`);
  console.log(`Added:     ${summary.result.added.join(', ') || '(none)'}`);
  console.log(`Changed:   ${summary.result.changed.join(', ') || '(none)'}`);
  console.log(`Unchanged: ${summary.result.unchanged.join(', ') || '(none)'}`);
  if (summary.result.skipped.length) console.log(`Skipped (no markers): ${summary.result.skipped.join(', ')}`);
  if (summary.result.orphaned.length) console.log(`Orphaned (spec gone): ${summary.result.orphaned.join(', ')}`);
  console.log(`Services: ${summary.attempted} attempted, ${summary.failures} failed.`);

  if (summary.attempted > 0 && summary.failures === summary.attempted) {
    console.error('\n✖ All configured services failed.');
    process.exit(1);
  }
}

// Run main() only when invoked directly (not when imported by the self-check).
if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  main().catch((err) => {
    console.error('✖ Fatal:', err.message);
    process.exit(1);
  });
}
