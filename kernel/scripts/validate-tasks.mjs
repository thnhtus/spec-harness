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
 *   8. AC traceability per stage: each acTrace.reachedIn doc is checked as soon
 *      as its fromStage is reached (a dropped AC fails at Gate 3, not at review)
 *   9. Handoff present for every role marked done (Next agent + Continue automation)
 *  10. Gate 2: no blocking question left open past fsd_review
 *  11. Stage/status coherence: `reviewing` requires currentStage=reviewing and
 *      every role finished
 *  12. Complexity label matches what the vector derives (Agents.md §5.1.1)
 *
 * Exit code: 0 = no errors (warnings allowed), 1 = at least one error.
 * Flags: --json, --no-warn, --quiet, --self-check, --calibrate, --config <path>,
 *        --staged (only task folders touched by the current git index)
 */

import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join, dirname, relative, resolve, parse as parsePath, sep } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

const argv = process.argv.slice(2);
const args = new Set(argv);
const AS_JSON = args.has("--json");
const NO_WARN = args.has("--no-warn");
const QUIET = args.has("--quiet");
const CALIBRATE = args.has("--calibrate");
// --staged: validate only the task folders this commit touches. A task parked at
// `blocked` waiting on a BA is a legitimate state, but whole-repo validation let
// it block every unrelated commit in the repo — and a gate people routinely
// bypass with --no-verify is decoration. CI stays whole-repo; that is the place
// for the global view.
const STAGED = args.has("--staged");

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
// Files whose size is driven by pasted machine output (test logs, adversary
// re-runs), not by prose the agent chooses to write. A hard cap there would put
// the agent between "paste the whole output" (Instructions §5, non-negotiable)
// and "stay under the cap" — and it would trim the evidence. Warn instead: a
// 400-line 08 usually means the task carries too many AC, which is worth seeing
// but is not something the implementer can fix by writing less.
const LINE_WARN = CFG.lineWarn ?? {};
const HANDOFF_BLOCK_CAP = CFG.handoffBlockCap ?? 30;
const STAGE_ORDER = CFG.stages ?? [];
const REQUIRED_AT_STAGE = CFG.requiredAtStage ?? [];
const GATE4_DONE = new Set(CFG.gate4Statuses ?? []);
const ROUTING = CFG.routing ?? { field: "branchType", map: {} };
const GATE4_ARTIFACTS = CFG.gate4Artifacts ?? {};
const REPOS = CFG.repos ?? [];
const AC_TRACE = CFG.acTrace ?? { declaredIn: null, reachedIn: [], since: "9999-12-31" };
// reachedIn entries may be a bare filename (checked only once Gate 4 is reached,
// the old behaviour) or { doc, fromStage } — checked as soon as that stage is
// reached. The latter is why a dropped AC surfaces at Gate 3 instead of after
// the implementer already wrote code against an incomplete plan.
const AC_REACHED = (AC_TRACE.reachedIn ?? []).map((e) =>
  typeof e === "string" ? { doc: e, fromStage: null } : e,
);
const AC_TRACE_SINCE = AC_TRACE.since ?? "9999-12-31";
// Which stage each role owns, for cross-checking self-reported attempts against
// handoff blocks. Implementers share one stage (routing picks which runs).
const ROLE_STAGE = CFG.roleStage ?? {};
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
    if (schema.maximum !== undefined && data > schema.maximum)
      errs.push(`${path}: above maximum ${schema.maximum}`);
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
function countLinesIn(text) {
  return text.replace(/\n$/, "").split("\n").length;
}

function rel(p) {
  return relative(REPO_ROOT, p);
}

// Gate 2 says a blocking question left open blocks the gate. Rows look like
// "| Q-01 | … | blocking | open | …" — a table scan is enough to catch the case
// the gate exists for, and it is the one a model most often waves through.
function openBlockingQuestions_test(lines) {
  return lines
    .filter((l) => /^\|\s*(Q-[A-Za-z0-9]+)\s*\|/.test(l) && /(?<![\w-])blocking\b/i.test(l) && /\bopen\b/i.test(l))
    .map((l) => /^\|\s*(Q-[A-Za-z0-9]+)\s*\|/.exec(l)[1]);
}

function openBlockingQuestions(file) {
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8")
    .split("\n")
    .filter((l) => /^\|\s*(Q-[A-Za-z0-9]+)\s*\|/.test(l) && /(?<![\w-])blocking\b/i.test(l) && /\bopen\b/i.test(l))
    .map((l) => /^\|\s*(Q-[A-Za-z0-9]+)\s*\|/.exec(l)[1]);
}

// A finished role must leave a usable handoff: the coordinator routes on
// "Continue automation", and a role that silently skipped its block hands the
// next stage nothing. Checks presence, not prose.
function handoffDefects(memDir, role) {
  const f = join(memDir, `${role}.md`);
  if (!existsSync(f)) return [`.agent-memory/${role}.md missing (SharedRules §4)`];
  const text = readFileSync(f, "utf8");
  const defects = [];
  if (!/^###\s/m.test(text)) defects.push(`.agent-memory/${role}.md has no "### " handoff block`);
  if (!/Continue automation\s*\**\s*:/i.test(text))
    defects.push(`.agent-memory/${role}.md missing "Continue automation" — coordinator routes on it`);
  if (!/Next agent\s*\**\s*:/i.test(text))
    defects.push(`.agent-memory/${role}.md missing "Next agent"`);
  return defects;
}

// The coordinator routes on the LAST handoff block. A role that finished but
// left "Continue automation: no" contradicts a task that moved on — one of the
// two is wrong, and reading only presence never caught it.
function handoffHalted(memDir, role) {
  const f = join(memDir, `${role}.md`);
  if (!existsSync(f)) return false;
  const blocks = readFileSync(f, "utf8").split(/^### /m).slice(1);
  const last = blocks[blocks.length - 1] ?? "";
  return /Continue automation\s*\**\s*:\s*\**\s*no\b/i.test(last);
}

// How many times a role actually ran, measured independently of what the
// coordinator claims. Handoff blocks are append-only (SharedRules §4), so the
// block count is evidence `attempts` is not: the actor that would spin is the
// same one that writes `attempts`, and it will not incriminate itself.
function handoffBlockCount(memDir, role) {
  const f = join(memDir, `${role}.md`);
  if (!existsSync(f)) return 0;
  return (readFileSync(f, "utf8").match(/^### /gm) ?? []).length;
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

// Complexity is DERIVED, never asserted: the agent fills the vector, this formula
// decides the label (Agents.md §5.1.1). Risk floors matter because a one-file fix
// in auth middleware is not "trivial" however small the diff is.
const RANK = ["trivial", "normal", "high"];
const EFFORT_KEYS = ["scope", "uncertainty", "dependency", "dataImpact", "integration", "testing"];

function deriveComplexity(vector) {
  const effort = EFFORT_KEYS.reduce((n, k) => n + (vector[k] ?? 0), 0);
  const base = effort <= 2 ? "trivial" : effort <= 6 ? "normal" : "high";
  const { blastRadius = 0, reversibility = 0 } = vector;
  const riskFloor =
    blastRadius >= 3 || reversibility >= 3 ? "high"
    : blastRadius >= 2 || reversibility >= 2 ? "normal"
    : "trivial";
  return { effort, label: RANK[Math.max(RANK.indexOf(base), RANK.indexOf(riskFloor))] };
}

// --- pure text predicates (self-checked below via --self-check) -------------

// "Real evidence": a command was run AND a pass/exit signal was recorded IN A
// FENCED BLOCK. Scanning the whole file was a hole: the 08 template's "Expected"
// column already reads "…/… passed", so an untouched scaffold with one command
// name typed in satisfied Gate 4 with zero output. Pasted output goes in a fence;
// that is the only place the proof can be.
// A bare "4/5" also matches a path like src/test/4/5, which appears in the very
// command being pasted. Require the ratio to be labelled as a count.
const RESULT_RE =
  /\bpassed\b|exit 0|✓|no error|\d+\s*\/\s*\d+\s*(passed|failed|tests?|specs?|files?|ok\b)|(tests?|specs?|files?)\s*:?\s*\d+\s*\/\s*\d+/i;

function fencedText(t) {
  return [...t.matchAll(/```[^\n]*\n([\s\S]*?)```/g)].map((m) => m[1]).join("\n");
}

function hasRealEvidenceIn(t) {
  return EVIDENCE_RE.test(t) && RESULT_RE.test(fencedText(t));
}

// Gate 5 artifact: the adversary must record a verdict and paste output it ran
// itself. Existence alone let it copy 08 across and call that a review.
//
// Divergent evidence: the whole point of Gate 5 is not trusting 08, so the
// cheapest way to satisfy it — pasting 08's fence into 09 — is exactly what it
// must not accept. We cannot prove a command ran; we can demand the ONE artifact
// a copy cannot produce: the side-by-side table (what 08 claimed | what I got),
// which requires the adversary to have a result of its own to put in column 3.
function staticLayerRows(t) {
  // "| `cmd` | claimed | observed | ✔ |" — the 09 template's first table.
  const rows = [];
  for (const line of t.split("\n")) {
    const cells = line.split("|").map((c) => c.trim());
    if (cells.length < 6) continue; // leading+trailing empties around 4 columns
    const [, cmd, claimed, observed] = cells;
    if (!EVIDENCE_RE.test(cmd)) continue; // header/separator/prose rows
    rows.push({ cmd, claimed, observed });
  }
  return rows;
}

function adversaryDefects(t, evidenceText = "") {
  const d = [];
  if (!/\bPASS\b|\bFAIL\b|\bUNCERTAIN\b/.test(t.replace(/PASS \| FAIL \| UNCERTAIN/g, "")))
    d.push("09 has no verdict line (PASS / FAIL / UNCERTAIN)");
  if (!hasRealEvidenceIn(t)) d.push("09 has no command+result the adversary ran itself (Gate 5 §3.2)");

  const rows = staticLayerRows(t);
  if (!rows.length)
    d.push('09 "Tầng tĩnh" table has no command row — Gate 5 is re-running ProjectRules §7, not reading 08 (§3.2)');
  for (const r of rows)
    if (!r.observed)
      d.push(`09 "Tầng tĩnh": \`${r.cmd}\` has no "Kết quả tự chạy" — that column IS the gate (§3.2)`);

  // A byte-identical fence is indistinguishable from copy-paste. Matching
  // results are the expected outcome, so this is not an error — but it is the
  // one thing worth making the adversary say out loud.
  if (evidenceText && fencedText(t).trim() && fencedText(t).trim() === fencedText(evidenceText).trim())
    d.push(
      "09's pasted output is byte-identical to 08's — indistinguishable from copy-paste; paste YOUR run (timestamps/durations differ) or say in \"Giới hạn\" that you could not re-run",
    );
  return d;
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

// An AC is "reached" only when its id appears in a TABLE ROW. Matching anywhere
// in the text was asymmetric with declaredACsIn (which is strict): "AC-01 sẽ làm
// sau" in prose, or an HTML comment, used to satisfy the trace.
function acsMissingIn(text, acs) {
  const rows = text
    .split("\n")
    .filter((l) => l.trimStart().startsWith("|"))
    .join("\n");
  return acs.filter((a) => !new RegExp(`\\b${a}\\b`).test(rows));
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
  assert.equal(hasRealEvidenceIn("```\n$ " + sample + "\nexit 0\n```"), true, "fenced command + exit 0");
  assert.equal(
    hasRealEvidenceIn("```\n$ npm run test:scope -- src/test/4/5\n```"),
    false,
    'a path like src/test/4/5 is not a "4/5 passed" result',
  );
  assert.equal(hasRealEvidenceIn("```\n$ " + sample + "\nTests: 4/4\n```"), true, "labelled ratio counts");
  assert.equal(hasRealEvidenceIn("```\n$ " + sample + "\nTests 4 passed (4)\n```"), true, "fenced command + passed");
  assert.equal(hasRealEvidenceIn("mọi thứ đều pass"), false, "claim without a command");
  assert.equal(hasRealEvidenceIn("```\n$ " + sample + "\n```"), false, "command without a result");
  assert.equal(
    hasRealEvidenceIn(`| Unit | \`${sample}\` | AC-01 | …/… passed | | |`),
    false,
    'a table row saying "passed" is a plan, not a result — the fence is the proof',
  );
  // Regression: the shipped 08 template, with a command name typed into the
  // table but no output pasted, must NOT pass Gate 4. This is the exact hole
  // the fenced-block rule closes.
  {
    const ev = GATE4_ARTIFACTS.evidence;
    const tplPath = join(TASKS_DIR, "_templates", ev);
    if (existsSync(tplPath)) {
      const raw = readFileSync(tplPath, "utf8");
      assert.equal(hasRealEvidenceIn(raw), false, `${ev} template must not satisfy Gate 4 untouched`);
      assert.equal(
        hasRealEvidenceIn(raw.replace(/`<[^`>]*>`/, `\`${sample}\``)),
        false,
        `${ev} template + a command name but no pasted output must not satisfy Gate 4`,
      );
    }
  }

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
  assert.deepEqual(acsMissingIn("| AC-01 | x |\n| AC-02 | y |", ["AC-01", "AC-03"]), ["AC-03"]);
  assert.deepEqual(acsMissingIn("| AC-10 | x |", ["AC-1"]), ["AC-1"], "AC-1 ≠ AC-10");
  // Prose, comments and "not covered" notes are not coverage. declaredACsIn is
  // strict about table rows; the reached-side must be exactly as strict.
  assert.deepEqual(acsMissingIn("Ghi chú: AC-01 sẽ làm sau", ["AC-01"]), ["AC-01"], "prose is not coverage");
  assert.deepEqual(acsMissingIn("<!-- TODO AC-01 -->", ["AC-01"]), ["AC-01"], "a comment is not coverage");

  // adversaryDefects: verdict + own run + the side-by-side table whose third
  // column only an actual re-run can fill.
  const advOk = [
    "**Kết quả: PASS**",
    `| \`${sample}\` | 4 passed | 4 passed (2.1s) | ✔ |`,
    "```",
    `$ ${sample}`,
    "Tests 4 passed (4) in 2.1s",
    "```",
  ].join("\n");
  assert.deepEqual(adversaryDefects(advOk), [], "verdict + own run + filled table");
  assert.ok(adversaryDefects("**Kết quả: PASS**").length, "verdict without evidence is not a review");

  // The copy attack: 09 whose fence is byte-identical to 08's.
  const ev08 = "```\n$ " + sample + "\nTests 4 passed (4)\n```";
  const adv09 = `**Kết quả: PASS**\n| \`${sample}\` | 4 passed | 4 passed | ✔ |\n` + ev08;
  assert.ok(
    adversaryDefects(adv09, ev08).some((d) => d.includes("byte-identical")),
    "a fence copied verbatim from 08 must be called out",
  );
  assert.deepEqual(
    adversaryDefects(adv09, "```\n$ " + sample + "\nTests 4 passed (4) in 9.7s\n```").filter((d) => d.includes("byte-identical")),
    [],
    "a genuinely different run is not flagged",
  );

  // Third column empty = the adversary read 08 instead of re-running it.
  assert.ok(
    adversaryDefects(`**Kết quả: PASS**\n| \`${sample}\` | 4 passed |  | ? |\n\`\`\`\n$ ${sample}\nexit 0\n\`\`\``)
      .some((d) => d.includes("Kết quả tự chạy")),
    "empty self-run column is the gate failing",
  );
  {
    const advTpl = GATE4_ARTIFACTS.adversarial
      ? join(TASKS_DIR, "_templates", GATE4_ARTIFACTS.adversarial)
      : null;
    if (advTpl && existsSync(advTpl))
      assert.ok(
        adversaryDefects(readFileSync(advTpl, "utf8")).length,
        `${GATE4_ARTIFACTS.adversarial} template must not satisfy Gate 5 untouched`,
      );
  }

  // Regression: an untouched template must NOT satisfy traceability. Templates
  // use "AC-nn" placeholders precisely so a real AC-01 is never pre-covered.
  const tpl = (n) => readFileSync(join(TASKS_DIR, "_templates", n), "utf8");
  if (AC_TRACE.declaredIn)
    assert.deepEqual(
      declaredACsIn(tpl(AC_TRACE.declaredIn)),
      [],
      `${AC_TRACE.declaredIn} template declares no real AC`,
    );
  for (const { doc, fromStage } of AC_REACHED) {
    assert.deepEqual(
      acsMissingIn(tpl(doc), ["AC-01"]),
      ["AC-01"],
      `${doc} template must not pre-cover a real AC`,
    );
    if (fromStage)
      assert.ok(
        STAGE_ORDER.includes(fromStage),
        `acTrace.reachedIn "${doc}": fromStage "${fromStage}" not in config.stages — the check would never fire`,
      );
  }

  // Config wiring: the pieces the kernel reads from harness.config.json must be
  // present and internally consistent, or every later check silently no-ops.
  assert.ok(STAGE_ORDER.length, "config.stages is empty");
  assert.ok(GATE4_DONE.size, "config.gate4Statuses is empty");
  assert.ok(GATE4_ARTIFACTS.evidence, "config.gate4Artifacts.evidence is required");
  if (STAGE_ORDER.includes("adversarial_review"))
    assert.ok(
      GATE4_ARTIFACTS.adversarial,
      'config.stages has "adversarial_review" but gate4Artifacts.adversarial is missing — Gate 5 would never be enforced',
    );
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
  // roleStage powers the retry budget cross-check; a role missing here is a
  // role whose runaway loop nobody counts.
  for (const role of CFG.roles ?? [])
    assert.ok(
      ROLE_STAGE[role],
      `config.roleStage.${role} is missing — its retry budget would never be checked`,
    );
  for (const [role, st] of Object.entries(ROLE_STAGE))
    assert.ok(STAGE_ORDER.includes(st), `config.roleStage.${role}: stage "${st}" not in config.stages`);
  assert.ok((CFG.retryBudget ?? 4) >= 2, "config.retryBudget must be at least 2 (one retry)");

  // handoffBlockCount: the independent measure of rework.
  {
    const { mkdtempSync, writeFileSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const d = mkdtempSync(join(tmpdir(), "sh-rb-"));
    assert.equal(handoffBlockCount(d, "nope"), 0, "no file = never ran");
    writeFileSync(join(d, "r.md"), "### a\nx\n### b\ny\n### c\nz\n");
    assert.equal(handoffBlockCount(d, "r"), 3, "counts append-only blocks");
  }
  // Without a real acTrace.since the default is "9999-12-31", so every AC
  // failure degrades to a warning and pre-commit (--no-warn) blocks nothing.
  // That is the silent no-op this whole self-check exists to prevent.
  assert.ok(
    AC_TRACE.since && !Number.isNaN(Date.parse(AC_TRACE.since)),
    'config.acTrace.since is required (YYYY-MM-DD, the day you switched the harness on) — without it every AC error degrades to a warning and the gate no-ops',
  );
  assert.ok(
    CFG.layers?.length,
    'config.layers is required (e.g. ["frontend"]) — without it any layer value passes',
  );
  // repos: where the CODE lives, relative to the config root. One entry with
  // path "." means harness and code share a repo; several entries mean the
  // harness sits above them (workspace layout) and task docs are NOT inside
  // the repo being edited — which changes how worktrees work (Agents.md §0).
  // models: tier -> whatever the host CLI calls it. The kernel never names a
  // vendor model; a Codex/Gemini user maps the same three tiers to their own.
  // Empty object is legal: it means "let the harness use its default".
  for (const tier of ["cheap", "mid", "strong"])
    if (CFG.models && Object.keys(CFG.models).length)
      assert.ok(CFG.models[tier], `config.models.${tier} is required once config.models is set`);

  assert.ok(CFG.repos?.length, 'config.repos is required (at least one { name, path, layer })');
  for (const r of CFG.repos) {
    assert.ok(r.name && r.path && r.layer, `config.repos entry needs name+path+layer: ${JSON.stringify(r)}`);
    assert.ok(CFG.layers.includes(r.layer), `config.repos "${r.name}": layer "${r.layer}" not in config.layers`);
  }
  assert.equal(
    new Set(CFG.repos.map((r) => r.name)).size,
    CFG.repos.length,
    "config.repos names must be unique (task.agent.json repoName points at one)",
  );
  // docsPath regex is built from tasksDir + groupPrefix: a mismatch here would
  // reject every correctly-placed task folder, so check it against a real path.
  const sampleDocsPath = `${CFG.tasksDir ?? "docs/tasks"}/${GROUP_PREFIX}3/ABC-1-slug`;
  const esc0 = (x) => x.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  assert.ok(
    new RegExp(`^${esc0(CFG.tasksDir ?? "docs/tasks")}/${esc0(GROUP_PREFIX)}.+/.+/?$`).test(sampleDocsPath),
    `docsPath pattern would reject a valid folder like "${sampleDocsPath}"`,
  );

  // lineWarn never blocks: 08/09 hold pasted output, and a cap there buys a
  // shorter file by making the agent paste less — the opposite of what Gate 4
  // and Gate 5 exist for.
  for (const f of Object.keys(LINE_WARN))
    assert.ok(
      !LINE_CAPS[f],
      `${f} is in both lineCaps and lineWarn — a hard cap on pasted output pressures the agent to trim evidence`,
    );

  // Line caps under append-only: the newest block is what the current role
  // controls. Capping the whole file traps a task the gate bounced twice —
  // over the cap, and §5 forbids trimming the history to get back under it.
  {
    const body = (n) => Array.from({ length: n }, (_, i) => `l${i}`).join("\n");
    const oneBlock = body(12);
    const twoRounds = `${body(12)}\n## Cập Nhật — 2026-01-02\n${body(3)}`;
    assert.equal(countLinesIn(oneBlock), 12, "plain count");
    assert.equal(
      countLinesIn("## Cập Nhật — " + twoRounds.split(/^## Cập Nhật — /m).pop()),
      4,
      "newest block is measured alone, not the accumulated file",
    );
  }

  // deriveComplexity: effort thresholds + risk floors. These are the cases the
  // formula exists for — a small diff in a blast-radius-3 area is not trivial.
  const v = (o) => ({ scope: 0, uncertainty: 0, dependency: 0, dataImpact: 0, integration: 0, testing: 0, blastRadius: 0, reversibility: 0, ...o });
  assert.equal(deriveComplexity(v({})).label, "trivial", "all zero → trivial");
  assert.equal(deriveComplexity(v({ scope: 2, testing: 1 })).label, "normal", "effort 3 → normal");
  assert.equal(deriveComplexity(v({ scope: 2, dependency: 2, testing: 2, integration: 1 })).label, "high", "effort 7 → high");
  assert.equal(deriveComplexity(v({ scope: 1, blastRadius: 3 })).label, "high", "tiny diff, system-wide blast → high");
  assert.equal(deriveComplexity(v({ reversibility: 4 })).label, "high", "irreversible → high even at effort 0");
  assert.equal(deriveComplexity(v({ scope: 2, uncertainty: 2, dependency: 2, dataImpact: 2, integration: 2, testing: 2 })).effort, 12, "effort maxes at 12");
  assert.equal(deriveComplexity(v({ blastRadius: 2 })).label, "normal", "feature-wide blast floors at normal");

  // openBlockingQuestions: table row only, both flags on the same row.
  assert.deepEqual(
    openBlockingQuestions_test(["| Q-01 | x | blocking | open |", "| Q-02 | y | blocking | answered |", "| Q-03 | z | non-blocking | open |", "prose blocking open"]),
    ["Q-01"],
  );

  // handoffDefects: presence of the two fields the coordinator routes on.
  {
    const { mkdtempSync, writeFileSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const d = mkdtempSync(join(tmpdir(), "sh-"));
    assert.equal(handoffDefects(d, "x").length, 1, "missing file is one defect");
    writeFileSync(join(d, "x.md"), "### 2026-01-01 — x\n- **Next agent**: y\n- **Continue automation**: yes\n");
    assert.deepEqual(handoffDefects(d, "x"), [], "complete handoff passes");
    writeFileSync(join(d, "y.md"), "### 2026-01-01 — y\n- **Next agent**: z\n");
    assert.equal(handoffDefects(d, "y").length, 1, "missing Continue automation is caught");
    writeFileSync(join(d, "z.md"), "chỉ là văn xuôi, không có block\n");
    assert.equal(handoffDefects(d, "z").length, 3, "no block, no fields");
  }

  // calibrate: the findings are the whole point — a rule that never fires is
  // decoration, and one that fires on noise is worse.
  {
    const t = (o) => ({ taskComplexity: "normal", attempts: {}, outcome: { closedAt: "2026-01-01" }, ...o });
    assert.equal(calibrate([]).tasks, 0, "no closed task → nothing to say");
    assert.equal(calibrate([{ taskComplexity: "high" }]).tasks, 0, "unclosed task is not evidence");

    // One hard task is not a trend. A finding here sends someone to rewrite the
    // §5.1.1 thresholds on a sample of one.
    assert.deepEqual(
      calibrate([t({ attempts: { implementation: 2 } })]).findings,
      [],
      "n=1 is not evidence of a mis-scored dimension",
    );

    // 3 of 5 tasks retried implementation → scope is scored too low
    const retried = calibrate([
      t({ attempts: { implementation: 2 } }),
      t({ attempts: { implementation: 3 } }),
      t({ attempts: { implementation: 2 } }),
      t({}),
      t({}),
    ]);
    assert.ok(
      retried.findings.some((f) => f.includes("scope")),
      "repeated implementation retries should point at scope",
    );

    // a bug escaping a "trivial" task means the risk floors are too loose
    const trivial = (n) => Array.from({ length: n }, () => t({ taskComplexity: "trivial" }));
    const escaped = calibrate([
      t({ taskComplexity: "trivial", outcome: { closedAt: "2026-01-01", escapedBugs: 1 } }),
      ...trivial(4),
    ]);
    assert.ok(escaped.findings.some((f) => f.includes("riskFloor")), "escaped bug from trivial → riskFloor finding");

    // clean, low-retry history must NOT invent a finding
    assert.deepEqual(calibrate([t({}), t({})]).findings, [], "clean history → no finding");

    // telemetry: strong tier burned on tasks that never bounced is cost without
    // benefit — the half of the ROI question `outcome` alone cannot answer.
    const strong = calibrate(
      Array.from({ length: 5 }, () => t({ telemetry: [{ stage: "implementation", tier: "strong" }] })),
    );
    assert.ok(strong.findings.some((f) => f.includes("strong-tier")), "strong tier with no payoff is a finding");

    // inputTokens: averaged per stage, not per task — the rule floor is paid
    // once per dispatch, so that is the unit a kernel diet is measured in.
    const tok = calibrate([
      t({ telemetry: [{ stage: "a", tier: "mid", inputTokens: 6000 }, { stage: "b", tier: "mid", inputTokens: 8000 }] }),
    ]);
    assert.equal(tok.byLabel.normal.tok, 14000, "input tokens summed");
    assert.equal(tok.byLabel.normal.tokRuns, 2, "counted per dispatch, not per task");
    assert.equal(
      calibrate([t({ telemetry: [{ stage: "a", tier: "mid" }] })]).byLabel.normal.tokRuns,
      0,
      "a CLI that reports no tokens must not skew the average",
    );
    assert.deepEqual(
      calibrate(Array.from({ length: 5 }, () => t({ telemetry: [{ stage: "implementation", tier: "mid" }] }))).findings,
      [],
      "cheap tiers running cleanly is not a finding",
    );
  }

  console.log("✅ validate-tasks self-check passed");
  process.exit(0);
}

// ---------------------------------------------------------------------------
// --calibrate: read closed tasks and report where the estimate was wrong.
//
// The vector (§5.1) is a guess made before the work; `attempts` and `outcome`
// are what happened. This compares them. It prints evidence, never edits the
// thresholds: a rule the harness silently rewrote is a rule nobody reviewed.
// ---------------------------------------------------------------------------
function calibrate(tasks) {
  const closed = tasks.filter((t) => t.outcome?.closedAt);
  if (!closed.length) return { tasks: 0, note: "no task has outcome.closedAt yet — nothing to learn from" };

  const byLabel = {};
  for (const t of closed) {
    const l = t.taskComplexity ?? "unknown";
    const b = (byLabel[l] ??= { n: 0, escaped: 0, rework: 0, retries: 0, strongRuns: 0, tok: 0, tokRuns: 0 });
    b.n++;
    b.escaped += t.outcome.escapedBugs ?? 0;
    b.rework += t.outcome.reworkAfterReview ?? 0;
    b.retries += Object.values(t.attempts ?? {}).reduce((n, v) => n + (v - 1), 0);
    // Cost proxy: how often the expensive tier ran. §5.3 claims the strong tier
    // pays for itself; without this the claim has no counter-evidence path.
    b.strongRuns += (t.telemetry ?? []).filter((e) => e.tier === "strong").length;
    // Input tokens: the only way the harness sees its own weight. The rule floor
    // every subagent reads is paid once per stage, per task — a kernel that grows
    // 16% shows up here, or it shows up nowhere.
    for (const e of t.telemetry ?? [])
      if (typeof e.inputTokens === "number") (b.tok += e.inputTokens), b.tokRuns++;
  }

  // A stage that keeps bouncing points at the dimension that feeds it.
  const STAGE_DIM = {
    fsd_review: "uncertainty",
    technical_plan: "uncertainty",
    implementation: "scope",
    adversarial_review: "testing",
  };
  const retriesByStage = {};
  for (const t of closed)
    for (const [stage, n] of Object.entries(t.attempts ?? {}))
      if (n > 1) (retriesByStage[stage] ??= { tasks: 0, extra: 0 }), (retriesByStage[stage].tasks++, retriesByStage[stage].extra += n - 1);

  // A finding sends a human to rewrite the §5.1.1 thresholds. Below this many
  // closed tasks, "100% of tasks retried implementation" means one hard task.
  const MIN_SAMPLE = CFG.calibrateMinSample ?? 5;
  const findings = [];
  for (const [stage, r] of Object.entries(retriesByStage)) {
    const share = r.tasks / closed.length;
    if (closed.length >= MIN_SAMPLE && share >= 0.3 && STAGE_DIM[stage])
      findings.push(
        `${Math.round(share * 100)}% of closed tasks retried "${stage}" (${r.extra} extra runs) — "${STAGE_DIM[stage]}" is likely scored too low at bootstrap`,
      );
  }
  for (const [label, b] of Object.entries(byLabel)) {
    if (label === "trivial" && b.escaped > 0 && b.n >= MIN_SAMPLE)
      findings.push(`${b.escaped} bug(s) escaped from "trivial" tasks — the riskFloor thresholds (§5.1.1) are letting real risk through`);
    if (label === "high" && b.n >= 5 && b.escaped === 0 && b.retries === 0)
      findings.push(`${b.n} "high" tasks closed with no rework and no escaped bugs — the high threshold may be too eager (cost without benefit)`);
    // Same shape of waste, now measurable: the strong tier ran repeatedly on
    // tasks that never needed a second pass.
    if (b.n >= MIN_SAMPLE && b.strongRuns >= b.n && b.escaped === 0 && b.retries === 0)
      findings.push(
        `"${label}": ${b.strongRuns} strong-tier run(s) across ${b.n} task(s) with zero rework and zero escaped bugs — paying the strong tier and buying nothing (Agents.md §5.3)`,
      );
  }

  return { tasks: closed.length, byLabel, retriesByStage, findings };
}

// ---------------------------------------------------------------------------
// Collect task folders
// ---------------------------------------------------------------------------
// Task folders touched by the git index, as paths relative to REPO_ROOT.
// Returns null when git is unavailable — the caller then falls back to the full
// scan rather than silently validating nothing.
function stagedTaskFolders() {
  let out;
  try {
    out = execFileSync("git", ["diff", "--cached", "--name-only", "-z"], {
      cwd: REPO_ROOT,
      encoding: "utf8",
    });
  } catch {
    return null;
  }
  const tasksRel = relative(REPO_ROOT, TASKS_DIR).split(sep).join("/");
  const hit = new Set();
  for (const f of out.split("\0").filter(Boolean)) {
    const p = f.split(sep).join("/");
    if (!p.startsWith(`${tasksRel}/`)) continue;
    // {tasksRel}/{group}/{task}/... → keep the two segments below tasksDir
    const rest = p.slice(tasksRel.length + 1).split("/");
    if (rest.length >= 2) hit.add(`${rest[0]}/${rest[1]}`);
  }
  return hit;
}

function findTaskFolders() {
  const folders = [];
  if (!existsSync(TASKS_DIR)) return folders;
  for (const sprint of readdirSync(TASKS_DIR)) {
    const sprintPath = join(TASKS_DIR, sprint);
    if (!sprint.startsWith(GROUP_PREFIX) || !statSync(sprintPath).isDirectory()) continue;
    for (const task of readdirSync(sprintPath)) {
      const taskPath = join(sprintPath, task);
      if (!statSync(taskPath).isDirectory()) continue;
      if (ONLY && !ONLY.has(`${sprint}/${task}`)) continue;
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
// layer: the kernel ships no fixed value — a FE-only project declares ["frontend"],
// a BE or monorepo project declares its own. Without this the schema would reject
// every non-frontend task.
if (CFG.layers?.length && schema.properties?.layer)
  schema.properties.layer.enum = CFG.layers;
if (schema.properties?.docsPath)
  schema.properties.docsPath.pattern = `^${esc(CFG.tasksDir ?? "docs/tasks")}/${esc(GROUP_PREFIX)}.+/.+/?$`;
const ONLY = STAGED ? stagedTaskFolders() : null;
const folders = findTaskFolders();
const results = []; // {folder, errors:[], warnings:[]}
const allTasks = []; // parsed task.agent.json, for --calibrate
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
    errors.push(
      `task.agent.json invalid JSON: ${e.message} — likely a crash mid-write; ` +
        `write to a temp file in the same dir then mv (SharedRules §6). ` +
        `Recover the stage from .agent-memory/ handoff blocks.`,
    );
    results.push({ folder: folderRel, errors, warnings });
    continue;
  }

  // 1. Schema
  for (const e of validateSchema(data, schema)) errors.push(`schema ${e}`);

  // 2. Consistency: taskId / sprintNumber / docsPath vs folder location
  const sprintNum = Number(sprint.replace(GROUP_PREFIX, ""));
  if (data[GROUP_FIELD] !== sprintNum)
    errors.push(`${GROUP_FIELD}=${data[GROUP_FIELD]} but folder is ${sprint}`);
  // repoName must name a declared repo: in a workspace layout the agent has to
  // know which repo to edit, and a typo here silently points it at nothing.
  if (REPOS.length && data.repoName && !REPOS.some((r) => r.name === data.repoName))
    errors.push(
      `repoName="${data.repoName}" not in config.repos [${REPOS.map((r) => r.name).join(", ")}]`,
    );
  if (data.taskId && !task.startsWith(data.taskId))
    errors.push(`taskId="${data.taskId}" does not match folder "${task}"`);
  // Resume (HarnessSetup §7) and the coordinator locate the task by docsPath.
  // Pointing at the wrong folder sends the next stage to write somewhere else.
  if (data.docsPath && !data.docsPath.includes(`${sprint}/${task}`))
    errors.push(`docsPath "${data.docsPath}" does not point at this folder`);

  // duplicate id tracking (record subTaskKey so shared-id sub-bugs are allowed)
  if (data.taskId) {
    const arr = taskIdMap.get(data.taskId) ?? [];
    arr.push({ folder: folderRel, subTaskKey: data.subTaskKey ?? null });
    taskIdMap.set(data.taskId, arr);
  }

  // 2b. Complexity: the label must match what the vector derives, or the vector
  // is decoration and the model/flow routing downstream is based on a guess.
  if (data.complexity?.vector) {
    const { effort, label } = deriveComplexity(data.complexity.vector);
    if (data.taskComplexity && data.taskComplexity !== label)
      errors.push(
        `taskComplexity="${data.taskComplexity}" but complexity.vector derives "${label}" (effort=${effort}) — Agents.md §5.1.1`,
      );
    if (data.complexity.effort !== undefined && data.complexity.effort !== effort)
      errors.push(`complexity.effort=${data.complexity.effort} but vector sums to ${effort}`);
  } else if (STAGE_ORDER.indexOf(data.currentStage) > STAGE_ORDER.indexOf("bootstrap")) {
    warnings.push("complexity.vector missing — taskComplexity is an unchecked guess (Agents.md §5.1)");
  }

  // 2c. Rework: a stage that ran more than twice means the gate kept bouncing it.
  // Not an error (sometimes the task is just hard) but it is the signal worth
  // reading when tuning prompts or splitting tasks.
  for (const [stage, n] of Object.entries(data.attempts ?? {}))
    if (n >= 3) warnings.push(`stage "${stage}" ran ${n}× — gate kept sending it back; worth a look`);

  // Retry budget with teeth. `attempts` is self-reported by the coordinator —
  // the very actor that loops — so cross-check it against the append-only
  // handoff blocks, and make an exhausted budget an ERROR, not a note. A task
  // that needed five runs of one stage is a task that should have been split.
  const RETRY_BUDGET = CFG.retryBudget ?? 4;
  for (const role of CFG.roles ?? []) {
    const runs = handoffBlockCount(join(path, ".agent-memory"), role);
    const stage = (ROLE_STAGE ?? {})[role];
    const claimed = stage ? (data.attempts ?? {})[stage] : undefined;
    if (claimed !== undefined && runs > claimed)
      warnings.push(
        `attempts["${stage}"]=${claimed} but .agent-memory/${role}.md has ${runs} handoff block(s) — rework is under-reported (Agents.md §5.5)`,
      );
    if (runs >= RETRY_BUDGET)
      errors.push(
        `${role} ran ${runs}× (budget ${RETRY_BUDGET}) — the gate keeps bouncing it; split the task or fix the spec instead of retrying (Agents.md §5.5)`,
      );
  }

  // 3. Required artifacts for reached stage
  const stageIdx = STAGE_ORDER.indexOf(data.currentStage);
  // attempts is the only rework measurement the harness has, and the coordinator
  // increments it by hand. A passed stage with no entry means it silently stopped.
  if (stageIdx > 0)
    for (const st of STAGE_ORDER.slice(1, stageIdx))
      if (!(data.attempts ?? {})[st])
        warnings.push(`attempts["${st}"] missing though the task passed that stage — rework data is incomplete (Agents.md §5.5)`);
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

  // 4. Line caps. Docs are append-only (SharedRules §5) and a bounced task must
  // append "## Cập Nhật — …" on resume (HarnessSetup §7.5) — so a whole-file cap
  // becomes unsatisfiable after two rounds: over the cap, and forbidden to trim.
  // Cap the newest block instead; that is the part the current role writes and
  // the only part it may lawfully shorten.
  for (const [f, cap] of Object.entries(LINE_CAPS)) {
    const fp = join(path, f);
    if (!existsSync(fp)) continue;
    const text = readFileSync(fp, "utf8");
    const updates = text.split(/^## Cập Nhật — /m);
    if (updates.length > 1) {
      const newest = countLinesIn("## Cập Nhật — " + updates[updates.length - 1]);
      if (newest > cap)
        errors.push(
          `${f}: newest "## Cập Nhật" block is ${newest} lines, exceeds cap ${cap} (SharedRules §8)`,
        );
      else if (countLinesIn(text) > cap)
        warnings.push(
          `${f}: ${countLinesIn(text)} lines total over ${updates.length - 1} update round(s) — over the ${cap} cap but append-only; split into an appendix at the next natural break`,
        );
    } else if (countLinesIn(text) > cap) {
      errors.push(`${f}: ${countLinesIn(text)} lines exceeds cap ${cap} (SharedRules §8)`);
    }
  }
  for (const [f, limit] of Object.entries(LINE_WARN)) {
    const fp = join(path, f);
    if (!existsSync(fp)) continue;
    const n = countLinesIn(readFileSync(fp, "utf8"));
    if (n > limit)
      warnings.push(
        `${f}: ${n} lines (soft limit ${limit}) — pasted output is never trimmed to fit; this usually means the task carries too many AC and should be split (SharedRules §8)`,
      );
  }
  for (const o of oversizedHandoffBlocks(join(path, ".agent-memory")))
    warnings.push(`.agent-memory/${o.file}: ${o.lines} lines exceeds ${HANDOFF_BLOCK_CAP}`);

  // 5a. Gate 2: no blocking question may stay open past fsd_review.
  if (AC_TRACE.declaredIn && stageIdx > STAGE_ORDER.indexOf("fsd_review")) {
    const open = openBlockingQuestions(join(path, AC_TRACE.declaredIn));
    if (open.length)
      errors.push(
        `Gate 2: blocking question still open past fsd_review: ${open.join(", ")} — Agents.md §3`,
      );
  }

  // 5c. Stage/status coherence: `reviewing` means every gate ran. Jumping
  // straight there leaves the gates as decoration.
  if (data.status === "reviewing" && data.currentStage !== "reviewing")
    errors.push(`status=reviewing but currentStage="${data.currentStage}" — gates were skipped`);
  if (GATE4_DONE.has(data.status)) {
    const unfinished = (CFG.roles ?? []).filter(
      (r) => ag[r] && !["done", "not_applicable", "skipped"].includes(ag[r].status),
    );
    if (unfinished.length)
      errors.push(
        `status=${data.status} but roles not finished: ${unfinished.map((r) => `${r}=${ag[r].status}`).join(", ")}`,
      );
  }

  // A closed task with no outcome teaches nothing: --calibrate has no ground
  // truth to compare the estimate against. Warning, not error — the work is
  // already shipped, blocking a commit now helps no one.
  if (data.status === "done" && !data.outcome?.closedAt)
    warnings.push("status=done but outcome.closedAt missing — --calibrate cannot learn from this task (Agents.md §5.6)");

  // 5b. Handoff: every role marked done must have left one.
  for (const [role, info] of Object.entries(ag))
    if (info?.status === "done") {
      for (const d of handoffDefects(join(path, ".agent-memory"), role)) errors.push(d);
      if (GATE4_DONE.has(data.status) && handoffHalted(join(path, ".agent-memory"), role))
        errors.push(
          `${role} is done and status=${data.status}, but its last handoff says "Continue automation: no" — one of the two is stale (SharedRules §4)`,
        );
    }

  // 8. AC traceability, checked per stage. An AC that never reached the plan is
  // a Gate 3 failure; waiting for `reviewing` to say so means the implementer
  // already built from a plan missing it.
  const declared = AC_TRACE.declaredIn ? declaredACs(join(path, AC_TRACE.declaredIn)) : [];
  // No AC at all past Gate 2 used to skip the entire trace block: an untouched
  // template walked to `reviewing` clean. Gate 2 already requires ≥1 confirmed
  // AC in prose (FSDReviewer §4.2) — this is that rule with an exit code.
  if (AC_TRACE.declaredIn && !declared.length && stageIdx > STAGE_ORDER.indexOf("fsd_review"))
    errors.push(
      `Gate 2: no AC declared in ${AC_TRACE.declaredIn} but stage is "${data.currentStage}" — the whole AC trace would be vacuous (SharedRules §9.1)`,
    );
  if (declared.length) {
    const sink = (data.updatedAt ?? "") >= AC_TRACE_SINCE ? errors : warnings;
    for (const { doc, fromStage } of AC_REACHED) {
      const due = fromStage
        ? stageIdx >= STAGE_ORDER.indexOf(fromStage)
        : GATE4_DONE.has(data.status);
      if (!due) continue;
      const miss = acsMissingFrom(join(path, doc), declared);
      if (miss.length)
        sink.push(
          `AC not traced into ${doc} (${miss.length}/${declared.length}): ${miss.join(", ")} — SharedRules §9.1`,
        );
    }
  }

  // 6. Gate-4 evidence when implementation is reported complete
  if (GATE4_DONE.has(data.status)) {
    const evName = GATE4_ARTIFACTS.evidence;
    const ev = join(path, evName);
    if (!existsSync(ev)) errors.push(`status=${data.status} but ${evName} missing`);
    else if (!hasRealEvidence(ev))
      errors.push(`${evName} has no real command+result evidence (Gate 4 honesty)`);
    if (GATE4_ARTIFACTS.notes && !existsSync(join(path, GATE4_ARTIFACTS.notes)))
      warnings.push(`status=${data.status} but ${GATE4_ARTIFACTS.notes} missing`);
    // Gate 5: reviewing means the adversary passed it, so its review must exist.
    // Without this, an implementer can jump straight to reviewing and skip the gate.
    if (GATE4_ARTIFACTS.adversarial) {
      const adv = join(path, GATE4_ARTIFACTS.adversarial);
      if (!existsSync(adv))
        errors.push(`status=${data.status} but ${GATE4_ARTIFACTS.adversarial} missing (Gate 5 skipped)`);
      else {
        const evText = existsSync(ev) ? readFileSync(ev, "utf8") : "";
        for (const d of adversaryDefects(readFileSync(adv, "utf8"), evText))
          errors.push(`${GATE4_ARTIFACTS.adversarial}: ${d}`);
      }
    }
  }

  results.push({ folder: folderRel, errors, warnings });
  allTasks.push(data);
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

if (CALIBRATE) {
  const c = calibrate(allTasks);
  if (AS_JSON) console.log(JSON.stringify(c, null, 2));
  else {
    console.log(`\n── calibration · ${c.tasks} closed task(s) ──`);
    if (c.note) console.log(`   ${c.note}`);
    for (const [label, b] of Object.entries(c.byLabel ?? {}))
      console.log(
        `   ${label.padEnd(8)} n=${b.n}  escaped=${b.escaped}  rework=${b.rework}  stage-retries=${b.retries}` +
          `  strong-runs=${b.strongRuns}` +
          (b.tokRuns ? `  avg-in-tok/stage=${Math.round(b.tok / b.tokRuns)}` : ""),
      );
    if (c.findings?.length) {
      console.log("\n   findings:");
      for (const f of c.findings) console.log(`   • ${f}`);
      if (c.findings.some((f) => f.includes("strong-tier")))
        console.log(
          "\n   note: telemetry is self-reported by the coordinator, not measured.\n" +
            "   Check it against your CLI's own usage log before changing a tier.",
        );
    } else if (c.tasks) console.log("\n   no threshold looks wrong yet");
  }
  process.exit(0);
}

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
