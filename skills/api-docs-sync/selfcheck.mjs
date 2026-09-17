#!/usr/bin/env node
// Dependency-free self-check for the api-docs-sync generator.
// Run: node .claude/skills/api-docs-sync/selfcheck.mjs
//
// Asserts the four guarantees from the design spec §9:
//   1. Expected endpoint markdown (method, params, resolved schema fields).
//   2. Idempotency: running twice yields an identical AUTOGEN block.
//   3. Preservation: Claude-owned Overview/Notes survive a second run.
//   4. A $ref cycle does not hang (cycle guard works).

import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { run, slugify, titleCase, typeName } from './generate.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = path.join(here, 'fixtures', 'sample-openapi.json');
const NOW = '2026-05-30T00:00:00.000Z';

const silent = { log() {}, warn() {}, error() {} };

function ok(label) {
  console.log(`  ✓ ${label}`);
}

async function withTempDir(fn) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'api-docs-selfcheck-'));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function autogenBlock(content) {
  const m = content.match(/<!-- AUTOGEN:START[\s\S]*?-->([\s\S]*?)<!-- AUTOGEN:END -->/);
  assert.ok(m, 'AUTOGEN markers present');
  return m[1];
}

async function main() {
  console.log('api-docs-sync self-check');

  // --- Pure-function sanity --------------------------------------------
  console.log('\n[unit] helpers');
  assert.equal(slugify('Workflow Tasks'), 'workflow-tasks');
  assert.equal(slugify('e-Docs/v2'), 'e-docs-v2');
  assert.equal(titleCase('workflow-tasks'), 'Workflow Tasks');
  assert.equal(typeName({ type: 'string', format: 'date-time' }), 'string (date-time)');
  assert.equal(typeName({ type: 'array', items: { type: 'string' } }), 'string[]');
  ok('slugify / titleCase / typeName');

  await withTempDir(async (tmp) => {
    const outDir = path.join(tmp, 'docs', 'api');
    const configPath = path.join(tmp, 'services.json');
    // Local-path URL — loadSpec resolves it relative to the config file.
    await writeFile(
      configPath,
      JSON.stringify([{ name: 'sample-service', url: fixture }], null, 2),
    );

    // --- Run #1 --------------------------------------------------------
    console.log('\n[run 1] generate from fixture');
    const t0 = Date.now();
    const r1 = await run({ configPath, outDir, nowISO: NOW, logger: silent });
    const elapsed = Date.now() - t0;

    // (4) Cycle guard: the recursive TreeNode schema must not hang.
    assert.ok(elapsed < 5000, `generation finished promptly (${elapsed}ms) — cycle guard works`);
    ok(`no hang on recursive $ref (${elapsed}ms)`);

    assert.deepEqual(r1.resources.sort(), ['trees', 'widgets']);
    assert.equal(r1.failures, 0);
    ok('grouped into resources: trees, widgets');

    const widgets = await readFile(path.join(outDir, 'widgets.md'), 'utf8');

    // (1) Expected endpoint markdown.
    console.log('\n[assert] endpoint markdown');
    assert.match(widgets, /#### GET \/widgets\b/, 'GET /widgets heading');
    assert.match(widgets, /#### POST \/widgets\b/, 'POST /widgets heading');
    assert.match(widgets, /#### GET \/widgets\/\{id\}/, 'GET /widgets/{id} heading');
    assert.match(widgets, /### sample-service/, 'service sub-heading');
    // Path param present and forced required.
    assert.match(widgets, /\| `id` \| string \| yes \| Widget identifier \|/, 'path param row');
    // Query params present.
    assert.match(widgets, /\| `status` \| string enum \| no \| Filter by status \|/, 'query param row');
    assert.match(widgets, /\| `limit` \| integer \(int32\) \| no \|/, 'query param row 2');
    // allOf-merged request body fields (WidgetCreate = WidgetBase + quantity).
    assert.match(widgets, /\*\*Request body\*\* \(required\)/, 'request body marked required');
    assert.match(widgets, /\| `name` \| string \| yes \|/, 'merged required field from allOf base');
    assert.match(widgets, /\| `quantity` \| integer \(int32\) \| no \|/, 'field from allOf extension');
    // Response codes + resolved array-of-ref.
    assert.match(widgets, /- `200`/, 'response 200 listed');
    assert.match(widgets, /- `400`/, 'response 400 listed');
    assert.match(widgets, /Array of `Widget`/, 'array response type resolved');
    assert.match(widgets, /- `201`/, 'response 201 listed');
    assert.match(widgets, /- `404`/, 'response 404 listed');
    ok('method, params, request body (allOf merge), responses all rendered');

    // (4b) Recursive schema rendered without exploding.
    const trees = await readFile(path.join(outDir, 'trees.md'), 'utf8');
    assert.match(trees, /#### GET \/trees\b/, 'GET /trees heading');
    assert.match(trees, /recursive reference|TreeNode/, 'recursive ref noted, not infinite');
    ok('recursive TreeNode rendered with cycle note');

    // README index.
    const readme = await readFile(path.join(outDir, 'README.md'), 'utf8');
    assert.match(readme, /\[Widgets\]\(\.\/widgets\.md\)/, 'README links widgets');
    assert.match(readme, /\[Trees\]\(\.\/trees\.md\)/, 'README links trees');
    assert.match(readme, /Last synced: 2026-05-30/, 'README shows synced date');
    ok('README index generated with links + synced date');

    // --- Preservation: edit Claude-owned regions ----------------------
    console.log('\n[edit] inject Claude-owned content');
    const SENTINEL_OVERVIEW = 'CLAUDE_OVERVIEW_SENTINEL_42';
    const SENTINEL_NOTES = 'CLAUDE_NOTES_SENTINEL_99';
    const edited = widgets
      .replace('<!-- Claude-owned: curated summary, when to use, cross-links -->', SENTINEL_OVERVIEW)
      .replace('<!-- Claude-owned: gotchas, auth, related resources -->', SENTINEL_NOTES);
    assert.notEqual(edited, widgets, 'edit actually changed the file');
    await writeFile(path.join(outDir, 'widgets.md'), edited);

    const block1 = autogenBlock(widgets);

    // --- Run #2 --------------------------------------------------------
    console.log('\n[run 2] regenerate over edited file');
    const r2 = await run({ configPath, outDir, nowISO: NOW, logger: silent });
    const widgets2 = await readFile(path.join(outDir, 'widgets.md'), 'utf8');

    // (3) Preservation.
    console.log('\n[assert] preservation + idempotency');
    assert.match(widgets2, new RegExp(SENTINEL_OVERVIEW), 'Overview sentinel survived');
    assert.match(widgets2, new RegExp(SENTINEL_NOTES), 'Notes sentinel survived');
    ok('Claude-owned Overview/Notes preserved across regeneration');

    // (2) Idempotency of the AUTOGEN block.
    const block2 = autogenBlock(widgets2);
    assert.equal(block2, block1, 'AUTOGEN block identical across runs');
    // And widgets.md unchanged on the second run (only sentinels differ from run-1 raw).
    assert.ok(r2.result.unchanged.includes('widgets'), 'widgets reported unchanged on run 2');
    ok('AUTOGEN block byte-identical on re-run (idempotent)');

    // --- Missing markers: skip, do not clobber ------------------------
    console.log('\n[assert] missing-marker safety');
    const handCrafted = '# Widgets\n\nHand-written, no markers here.\n';
    await writeFile(path.join(outDir, 'widgets.md'), handCrafted);
    const r3 = await run({ configPath, outDir, nowISO: NOW, logger: silent });
    const after = await readFile(path.join(outDir, 'widgets.md'), 'utf8');
    assert.equal(after, handCrafted, 'file without markers left untouched');
    assert.ok(r3.result.skipped.includes('widgets'), 'reported as skipped');
    ok('file lacking AUTOGEN markers is skipped, not clobbered');

    // --- Placeholder URL: skipped, exit-zero semantics ----------------
    console.log('\n[assert] placeholder handling');
    const phConfig = path.join(tmp, 'placeholder.json');
    await writeFile(phConfig, JSON.stringify([{ name: 'auth', url: 'https://REPLACE_ME/auth/v3/api-docs' }]));
    const r4 = await run({ configPath: phConfig, outDir: path.join(tmp, 'out2'), nowISO: NOW, logger: silent });
    assert.equal(r4.attempted, 0, 'placeholder not attempted');
    assert.equal(r4.failures, 0, 'placeholder is not a failure');
    ok('placeholder URL skipped without counting as failure');
  });

  console.log('\n✓ ALL CHECKS PASSED');
}

main().catch((err) => {
  console.error('\n✖ SELF-CHECK FAILED');
  console.error(err);
  process.exit(1);
});
