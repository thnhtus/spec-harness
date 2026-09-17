#!/usr/bin/env node
/**
 * validate-tasks.mjs — spec-harness task validator (project-agnostic).
 *
 * Turns the harness conventions (docs/Agents.md, docs/agents/SharedRules.md,
 * docs/tasks/README.md) into enforceable checks. Dependency-free (Node 20+).
 * Everything project-specific lives in harness.config.json, resolved by walking
 * up from the current working directory.
 *
 * Checks per task folder {tasksDir}/{groupPrefix}{n}/{taskId}-{slug}/:
 *   1. task.agent.json present + valid against task.agent.schema.json
 *   2. docsPath / group number / taskId consistent with folder location
 *   3. Required artifact files present for the reached currentStage
 *   4. Line-count caps (config.lineCaps) + handoff block cap
 *   5. routing field -> implementer role (config.routing)
 *   6. When Gate 4 reached: evidence artifact must contain a real command+result
 *   7. No duplicate tracker taskId across folders
 *   8. AC traceability: every AC-nn declared reaches every config.acTrace.reachedIn doc
 *
 * Exit code: 0 = no errors (warnings allowed), 1 = at least one error.
 * Flags: --json, --no-warn, --quiet, --self-check, --config <path>
 */

import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { join, dirname, relative, resolve, parse as parsePath } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

const argv = process.argv.slice(2);
const args = new Set(argv);
const AS_JSON = args.has("--json");
const NO_WARN = args.has("--no-warn");
const QUIET = args.has("--quiet");

const CONFIG_NAME = "harness.config.json";

// Walk up from `start` looking for harness.config.json. The directory holding it
// is the project root: every path in the config is relative to that, so the
// validator runs identically from the repo root or from a worktree subdir.
function findConfig(start) {
  let dir = resolve(start);
  for (;;) {
    const candidate = join(dir, CONFIG_NAME);
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir || dir === parsePath(dir).root) return null;
    dir = parent;
  }
}

const explicitIdx = argv.indexOf("--config");
const CONFIG_PATH =
  explicitIdx >= 0 && argv[explicitIdx + 1]
    ? resolve(argv[explicitIdx + 1])
    : findConfig(process.cwd()) ?? findConfig(join(__dirname, ".."));

if (!CONFIG_PATH) {
  console.error(
    `✖ ${CONFIG_NAME} not found (searched upward from ${process.cwd()}).\n` +
      `  Copy adapters/example/${CONFIG_NAME} to your project root and edit it.`,
  );
  process.exit(2);
}

let CFG;
try {
  CFG = JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
} catch (e) {
  console.error(`✖ ${CONFIG_PATH} is not valid JSON: ${e.message}`);
  process.exit(2);
}

const REPO_ROOT = dirname(CONFIG_PATH);
const TASKS_DIR = join(REPO_ROOT, CFG.tasksDir ?? "docs/tasks");
const SCHEMA_PATH = join(TASKS_DIR, "_templates", "task.agent.schema.json");

const GROUP_PREFIX = CFG.groupPrefix ?? "sprint-";
const GROUP_FIELD = CFG.groupField ?? "sprintNumber";
const LINE_CAPS = CFG.lineCaps ?? {};
const HANDOFF_BLOCK_CAP = CFG.handoffBlockCap ?? 30;
const STAGE_ORDER = CFG.stages ?? [];
const REQUIRED_AT_STAGE = CFG.requiredAtStage ?? [];
const GATE4_DONE = new Set(CFG.gate4Statuses ?? []);
const ROUTING = CFG.routing ?? { field: "branchType", map: {} };
const GATE4_ARTIFACTS = CFG.gate4Artifacts ?? {};
const AC_TRACE = CFG.acTrace ?? { declaredIn: null, reachedIn: [], since: "9999-12-31" };
const AC_TRACE_SINCE = AC_TRACE.since ?? "9999-12-31";
// Commands that count as a real verification run (project test/lint/build stack).
const EVIDENCE_RE = new RegExp(CFG.evidenceCommandPattern ?? "(?!)");

// ---------------------------------------------------------------------------
// Minimal JSON-Schema validator (covers the subset used by the schema)
// ---------------------------------------------------------------------------
function validateSchema(data, schema, path = "") {
  const errs = [];
  const t = schema.type;
  const typeOf = (v) =>
    Array.isArray(v) ? "array" : v === null ? "null" : typeof v === "number" && Number.isInteger(v) ? "integer" : typeof v;

  if (t) {
    const actual = typeOf(data);
    const want = Array.isArray(t) ? t : [t];
    const ok = want.some((w) => (w === "integer" ? actual === "integer" : w === "number" ? actual === "integer" || actual === "number" : actual === w));
    if (!ok) {
      errs.push(`${path || "(root)"}: expected type ${want.join("|")}, got ${actual}`);
      return errs; // type mismatch: stop deeper checks
    }
  }
  if (schema.const !== undefined && data !== schema.const)
    errs.push(`${path}: must equal "${schema.const}" (got "${data}")`);
  if (schema.enum && !schema.enum.includes(data))
    errs.push(`${path}: "${data}" not in [${schema.enum.join(", ")}]`);
  if (typeof data === "string") {
    if (schema.minLength !== undefined && data.length < schema.minLength)
      errs.push(`${path}: too short (min ${schema.minLength})`);
    if (schema.pattern && !new RegExp(schema.pattern).test(data))
      errs.push(`${path}: does not match pattern ${schema.pattern}`);
  }
  if (typeof data === "number") {
    if (schema.minimum !== undefined && data < schema.minimum)
      errs.push(`${path}: below minimum ${schema.minimum}`);
  }
  if (schema.type === "object" || (schema.properties && typeof data === "object" && data !== null && !Array.isArray(data))) {
    for (const req of schema.required ?? [])
      if (!(req in data)) errs.push(`${path}/${req}: required field missing`);
    for (const [k, v] of Object.entries(data)) {
      const sub = schema.properties?.[k];
      if (sub) errs.push(...validateSchema(v, sub, `${path}/${k}`));
      else if (schema.additionalProperties && typeof schema.additionalProperties === "object")
        errs.push(...validateSchema(v, schema.additionalProperties, `${path}/${k}`));
    }
  }
  // allOf / if-then (only the bugfix routing rule we declared)
  for (const sub of schema.allOf ?? []) {
    if (sub.if) {
      const condErrs = validateSchema(data, sub.if, path);
      if (condErrs.length === 0 && sub.then)
        errs.push(...validateSchema(data, sub.then, path));
    } else {
      errs.push(...validateSchema(data, sub, path));
    }
  }
  return errs;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function countLines(file) {
  return readFileSync(file, "utf8").replace(/\n$/, "").split("\n").length;
}

function rel(p) {
  return relative(REPO_ROOT, p);
}

// Returns array of {file, lines} for handoff blocks exceeding the cap.
function oversizedHandoffBlocks(memDir) {
  const offenders = [];
  if (!existsSync(memDir)) return offenders;
  for (const f of readdirSync(memDir).filter((x) => x.endsWith(".md"))) {
    const text = readFileSync(join(memDir, f), "utf8");
    // Blocks delimited by headings starting "### " (per SharedRules §4).
    const parts = text.split(/^### /m).slice(1);
    parts.forEach((block, i) => {
      const lines = block.replace(/\n$/, "").split("\n").length;
      if (lines > HANDOFF_BLOCK_CAP)
        offenders.push({ file: `${f} (block ${i + 1})`, lines });
    });
  }
  return offenders;
}

// --- pure text predicates (self-checked below via --self-check) -------------

// "Real evidence": a command was run AND a pass/exit signal recorded.
// Command list comes from config.evidenceCommandPattern (project test stack).
function hasRealEvidenceIn(t) {
  const hasCommand = EVIDENCE_RE.test(t);
  const hasResult = /\bpassed\b|exit 0|✓|no error|\d+\s*\/\s*\d+/i.test(t);
  return hasCommand && hasResult;
}

// Template scaffolding, never a real AC: "AC-ID" is the table header and
// "AC-nn" is the unfilled placeholder. Templates must use these so an untouched
// copy cannot satisfy the traceability check by accident.
const AC_PLACEHOLDERS = new Set(["AC-ID", "AC-nn", "AC-NN"]);

// AC ids declared in the review doc's AC table: rows starting "| AC-xx |".
// Restricted to leading table cells so prose mentions elsewhere don't count.
function declaredACsIn(text) {
  const ids = new Set();
  for (const line of text.split("\n")) {
    const m = /^\|\s*(AC-[A-Za-z0-9]+)\s*\|/.exec(line);
    if (m && !AC_PLACEHOLDERS.has(m[1])) ids.add(m[1]);
  }
  return [...ids];
}

// An AC is "reached" in a doc if its id appears anywhere in that doc's text.
function acsMissingIn(text, acs) {
  return acs.filter((a) => !new RegExp(`\\b${a}\\b`).test(text));
}

// --- path wrappers (missing file = nothing reached) -------------------------

const hasRealEvidence = (f) => existsSync(f) && hasRealEvidenceIn(readFileSync(f, "utf8"));
const declaredACs = (f) => (existsSync(f) ? declaredACsIn(readFileSync(f, "utf8")) : []);
const acsMissingFrom = (f, acs) =>
  existsSync(f) ? acsMissingIn(readFileSync(f, "utf8"), acs) : acs;

// ---------------------------------------------------------------------------
// Self-check: node scripts/validate-tasks.mjs --self-check
// ---------------------------------------------------------------------------
if (args.has("--self-check")) {
  const { strict: assert } = await import("node:assert");

  // hasRealEvidenceIn: a real command + a result counts; either alone does not.
  // The sample command comes from config so this stays a real test of THIS
  // project's evidenceCommandPattern, not of a hardcoded npm/vitest stack.
  const sample = CFG.evidenceSampleCommand;
  assert.ok(sample, "config.evidenceSampleCommand is required (a command your pattern must match)");
  assert.ok(
    EVIDENCE_RE.test(sample),
    `config.evidenceSampleCommand ("${sample}") does not match evidenceCommandPattern — one of the two is wrong`,
  );
  assert.equal(hasRealEvidenceIn(`$ ${sample}\nexit 0`), true, "command + exit 0");
  assert.equal(hasRealEvidenceIn(`$ ${sample}\nTests 4 passed (4)`), true, "command + passed");
  assert.equal(hasRealEvidenceIn("mọi thứ đều pass"), false, "claim without a command");
  assert.equal(hasRealEvidenceIn(`$ ${sample}`), false, "command without a result");

  // declaredACsIn: table rows only, placeholders excluded, deduped.
  assert.deepEqual(
    declaredACsIn(
      ["| AC-ID | Tiêu chí |", "| AC-01 | x |", "| AC-01 | trùng |", "| AC-02 | y |", "nhắc AC-99 trong prose"].join("\n"),
    ),
    ["AC-01", "AC-02"],
    "AC ids from table rows",
  );
  assert.deepEqual(declaredACsIn("| AC-nn |  | open |"), [], "unfilled placeholder is not an AC");

  // acsMissingIn: word-boundary, so AC-1 must not be satisfied by AC-10.
  assert.deepEqual(acsMissingIn("phủ bởi AC-01 và AC-02", ["AC-01", "AC-03"]), ["AC-03"]);
  assert.deepEqual(acsMissingIn("chỉ có AC-10", ["AC-1"]), ["AC-1"], "AC-1 ≠ AC-10");

  // Regression: an untouched template must NOT satisfy traceability. Templates
  // use "AC-nn" placeholders precisely so a real AC-01 is never pre-covered.
  const tpl = (n) => readFileSync(join(TASKS_DIR, "_templates", n), "utf8");
  if (AC_TRACE.declaredIn)
    assert.deepEqual(
      declaredACsIn(tpl(AC_TRACE.declaredIn)),
      [],
      `${AC_TRACE.declaredIn} template declares no real AC`,
    );
  for (const n of AC_TRACE.reachedIn ?? [])
    assert.deepEqual(
      acsMissingIn(tpl(n), ["AC-01"]),
      ["AC-01"],
      `${n} template must not pre-cover a real AC`,
    );

  // Config wiring: the pieces the kernel reads from harness.config.json must be
  // present and internally consistent, or every later check silently no-ops.
  assert.ok(STAGE_ORDER.length, "config.stages is empty");
  assert.ok(GATE4_DONE.size, "config.gate4Statuses is empty");
  assert.ok(GATE4_ARTIFACTS.evidence, "config.gate4Artifacts.evidence is required");
  for (const r of REQUIRED_AT_STAGE)
    assert.ok(STAGE_ORDER.includes(r.stage), `requiredAtStage stage "${r.stage}" not in config.stages`);
  assert.ok(STAGE_ORDER.includes("implementation"), 'config.stages must contain "implementation"');
  for (const role of Object.values(ROUTING.map ?? {}))
    assert.ok((CFG.roles ?? []).includes(role), `routing target "${role}" missing from config.roles`);
  assert.ok(
    EVIDENCE_RE.source !== "(?!)",
    "config.evidenceCommandPattern missing — no command would ever count as evidence",
  );
  assert.ok(CFG.tracker?.urlPattern, "config.tracker.urlPattern is required (task URL shape)");
  // docsPath regex is built from tasksDir + groupPrefix: a mismatch here would
  // reject every correctly-placed task folder, so check it against a real path.
  const sampleDocsPath = `${CFG.tasksDir ?? "docs/tasks"}/${GROUP_PREFIX}3/ABC-1-slug`;
  const esc0 = (x) => x.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  assert.ok(
    new RegExp(`^${esc0(CFG.tasksDir ?? "docs/tasks")}/${esc0(GROUP_PREFIX)}.+/.+/?$`).test(sampleDocsPath),
    `docsPath pattern would reject a valid folder like "${sampleDocsPath}"`,
  );

  console.log("✅ validate-tasks self-check passed");
  process.exit(0);
}

// ---------------------------------------------------------------------------
// Collect task folders
// ---------------------------------------------------------------------------
function findTaskFolders() {
  const folders = [];
  if (!existsSync(TASKS_DIR)) return folders;
  for (const sprint of readdirSync(TASKS_DIR)) {
    const sprintPath = join(TASKS_DIR, sprint);
    if (!sprint.startsWith(GROUP_PREFIX) || !statSync(sprintPath).isDirectory()) continue;
    for (const task of readdirSync(sprintPath)) {
      const taskPath = join(sprintPath, task);
      if (!statSync(taskPath).isDirectory()) continue;
      folders.push({ sprint, task, path: taskPath });
    }
  }
  return folders;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
// The schema ships without project-specific patterns; they are injected here so
// the shipped file stays generic and config stays the single source of truth.
const schema = JSON.parse(readFileSync(SCHEMA_PATH, "utf8"));
const esc = (x) => x.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
if (CFG.tracker?.urlPattern && schema.properties?.clickupUrl)
  schema.properties.clickupUrl.pattern = CFG.tracker.urlPattern;
if (schema.properties?.docsPath)
  schema.properties.docsPath.pattern = `^${esc(CFG.tasksDir ?? "docs/tasks")}/${esc(GROUP_PREFIX)}.+/.+/?$`;
const folders = findTaskFolders();
const results = []; // {folder, errors:[], warnings:[]}
const taskIdMap = new Map(); // taskId -> [folder rel paths]

for (const { sprint, task, path } of folders) {
  const errors = [];
  const warnings = [];
  const folderRel = rel(path);
  const jsonPath = join(path, "task.agent.json");

  if (!existsSync(jsonPath)) {
    errors.push("task.agent.json missing");
    results.push({ folder: folderRel, errors, warnings });
    continue;
  }

  let data;
  try {
    data = JSON.parse(readFileSync(jsonPath, "utf8"));
  } catch (e) {
    errors.push(`task.agent.json invalid JSON: ${e.message}`);
    results.push({ folder: folderRel, errors, warnings });
    continue;
  }

  // 1. Schema
  for (const e of validateSchema(data, schema)) errors.push(`schema ${e}`);

  // 2. Consistency: taskId / sprintNumber / docsPath vs folder location
  const sprintNum = Number(sprint.replace(GROUP_PREFIX, ""));
  if (data[GROUP_FIELD] !== sprintNum)
    errors.push(`${GROUP_FIELD}=${data[GROUP_FIELD]} but folder is ${sprint}`);
  if (data.taskId && !task.startsWith(data.taskId))
    errors.push(`taskId="${data.taskId}" does not match folder "${task}"`);
  if (data.docsPath && !data.docsPath.includes(`${sprint}/${task}`))
    warnings.push(`docsPath "${data.docsPath}" does not point at this folder`);

  // duplicate id tracking (record subTaskKey so shared-id sub-bugs are allowed)
  if (data.taskId) {
    const arr = taskIdMap.get(data.taskId) ?? [];
    arr.push({ folder: folderRel, subTaskKey: data.subTaskKey ?? null });
    taskIdMap.set(data.taskId, arr);
  }

  // 3. Required artifacts for reached stage
  const stageIdx = STAGE_ORDER.indexOf(data.currentStage);
  for (const rule of REQUIRED_AT_STAGE) {
    if (stageIdx >= STAGE_ORDER.indexOf(rule.stage)) {
      for (const f of rule.files)
        if (!existsSync(join(path, f)))
          errors.push(`required file "${f}" missing (stage=${data.currentStage})`);
    }
  }

  // 5. routing field → implementer role (config.routing): every other
  // implementer in the map must be marked not_applicable once we reach it.
  const ag = data.agents ?? {};
  const expected = ROUTING.map[data[ROUTING.field]];
  if (expected && stageIdx >= STAGE_ORDER.indexOf("implementation")) {
    const implementers = new Set(Object.values(ROUTING.map));
    for (const role of implementers) {
      if (role === expected) continue;
      if (ag[role]?.status !== "not_applicable")
        warnings.push(
          `${data[ROUTING.field]} task: ${role} should be "not_applicable" (got "${ag[role]?.status}")`,
        );
    }
  }

  // 4. Line caps
  for (const [f, cap] of Object.entries(LINE_CAPS)) {
    const fp = join(path, f);
    if (existsSync(fp)) {
      const n = countLines(fp);
      if (n > cap) errors.push(`${f}: ${n} lines exceeds cap ${cap} (SharedRules §8)`);
    }
  }
  for (const o of oversizedHandoffBlocks(join(path, ".agent-memory")))
    warnings.push(`.agent-memory/${o.file}: ${o.lines} lines exceeds ${HANDOFF_BLOCK_CAP}`);

  // 6. Gate-4 evidence when implementation is reported complete
  if (GATE4_DONE.has(data.status)) {
    const evName = GATE4_ARTIFACTS.evidence;
    const ev = join(path, evName);
    if (!existsSync(ev)) errors.push(`status=${data.status} but ${evName} missing`);
    else if (!hasRealEvidence(ev))
      errors.push(`${evName} has no real command+result evidence (Gate 4 honesty)`);
    if (GATE4_ARTIFACTS.notes && !existsSync(join(path, GATE4_ARTIFACTS.notes)))
      warnings.push(`status=${data.status} but ${GATE4_ARTIFACTS.notes} missing`);

    // 8. AC traceability: declaredIn → every doc in reachedIn
    const acs = AC_TRACE.declaredIn ? declaredACs(join(path, AC_TRACE.declaredIn)) : [];
    if (acs.length) {
      const sink = (data.updatedAt ?? "") >= AC_TRACE_SINCE ? errors : warnings;
      for (const doc of AC_TRACE.reachedIn ?? []) {
        const miss = acsMissingFrom(join(path, doc), acs);
        if (miss.length)
          sink.push(
            `AC not traced into ${doc} (${miss.length}/${acs.length}): ${miss.join(", ")} — SharedRules §9.1`,
          );
      }
    }
  }

  results.push({ folder: folderRel, errors, warnings });
}

// 7. Duplicate task ids (post-pass)
// A shared tracker taskId across folders is ALLOWED only when every folder
// declares a DISTINCT, non-empty subTaskKey (sub-bugs of one tracker item).
// Otherwise it is an error (accidental duplicate / copy-paste drift).
for (const [id, entries] of taskIdMap) {
  if (entries.length <= 1) continue;
  const keys = entries.map((e) => e.subTaskKey);
  const allHaveKey = keys.every((k) => k && k.length);
  const allDistinct = new Set(keys).size === keys.length;
  if (allHaveKey && allDistinct) continue; // legitimate sub-tasks → OK
  for (const e of entries) {
    const r = results.find((x) => x.folder === e.folder);
    const others = entries.filter((q) => q.folder !== e.folder).map((q) => q.folder);
    const hint = allHaveKey
      ? `subTaskKey values not distinct (${keys.join(", ")})`
      : `add a distinct "subTaskKey" to each folder if these are separate sub-bugs`;
    r.errors.push(`duplicate tracker taskId "${id}" also used by: ${others.join(", ")} — ${hint}`);
  }
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------
const totalErr = results.reduce((s, r) => s + r.errors.length, 0);
const totalWarn = results.reduce((s, r) => s + r.warnings.length, 0);

if (AS_JSON) {
  console.log(JSON.stringify({ tasks: results.length, totalErr, totalWarn, results }, null, 2));
} else {
  for (const r of results) {
    const show = r.errors.length || (!NO_WARN && r.warnings.length);
    if (!show) {
      if (!QUIET) console.log(`✅ ${r.folder}`);
      continue;
    }
    console.log(`\n📁 ${r.folder}`);
    for (const e of r.errors) console.log(`   ❌ ${e}`);
    if (!NO_WARN) for (const w of r.warnings) console.log(`   ⚠️  ${w}`);
  }
  console.log(
    `\n── ${results.length} task(s) · ${totalErr} error(s) · ${totalWarn} warning(s) ──`
  );
}

process.exit(totalErr > 0 ? 1 : 0);
