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
 * Flags: --json, --no-warn, --quiet, --self-check, --preflight, --triage, --calibrate, --config <path>,
 *        --staged (only task folders touched by the current git index),
 *        --task <folder> (only this one task folder — for per-gate use in /start-task)
 */

import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
import { join, dirname, relative, resolve, isAbsolute, parse as parsePath, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";

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
// --task: validate ĐÚNG MỘT task folder. Gate 1–3 chỉ có răng nếu chạy được
// NGAY SAU mỗi stage, mà bản quét-toàn-repo thì chậm và ồn (một task khác đang
// `blocked` chờ BA sẽ làm gate của task này đỏ). Nhận cả đường dẫn đầy đủ
// (`docs/tasks/sprint-1/ABC-1-x`) lẫn dạng rút gọn (`sprint-1/ABC-1-x`) —
// coordinator có sẵn biến $TASK ở dạng đầu.
const taskFlagAt = argv.indexOf("--task");
const TASK_ARG = taskFlagAt !== -1 ? argv[taskFlagAt + 1] : null;

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

// The vector triage was answered with, if it left a trace.
//
// Triage runs BEFORE task.agent.json exists, so unlike deriveComplexity (which
// the validator recomputes from the stored vector) nothing could check it. An
// agent wanting to skip the harness only had to score `scope: 0` instead of 1.
//
// This does not make anyone honest. It makes scoring low to dodge the harness
// leave a trace -- the same level of defence run-evidence.mjs settled on: move
// it from "slipped through" to "deliberate, and logged".
export function triageVectorFor(logPath, taskId) {
  if (!existsSync(logPath)) return null;
  let found = null;
  for (const line of readFileSync(logPath, "utf8").split("\n")) {
    const col = line.split("\t");
    if (col.length < 5 || col[1] !== taskId) continue;
    try { found = JSON.parse(col[4]); } catch { /* a corrupt line must not fabricate a finding */ }
  }
  return found; // last entry wins: a re-triage supersedes the earlier answer
}

// How the stored vector differs from the one triage was answered with.
//
// Both directions are worth a word, for opposite reasons. UP is expected --
// §5.1.3 says a Glob/Grep pass sees less than bootstrap does -- but the lower
// number is what decided whether this task needed the harness at all. DOWN is
// the one §5.1.3 forbids outright ("chỉ nâng, không hạ"): lowering a dimension
// buys a lighter gate and a cheaper model tier, which is exactly the incentive
// the rule exists to remove. Nothing used to check it.
export function vectorDriftSince(triaged, stored) {
  if (!triaged || !stored) return { raised: [], lowered: [] };
  const fmt = (k) => `${k} ${triaged[k] ?? 0}→${stored[k]}`;
  const keys = Object.keys(stored);
  return {
    raised: keys.filter((k) => (stored[k] ?? 0) > (triaged[k] ?? 0)).map(fmt),
    lowered: keys.filter((k) => (stored[k] ?? 0) < (triaged[k] ?? 0)).map(fmt),
  };
}

// Did the coordinator actually clear context between stages?
//
// start-task.md requires it and calls skipping it "a known failure of this
// harness (context runs out, it hangs mid-way)" -- but the rule was prose, so
// nothing caught it, and the symptom only shows at stage 5 after 40 minutes.
//
// The signal: each stage reads ITS OWN artifacts (03 reads 02, not 01), so
// inputTokens should wobble around a level. Carried-over conversation history
// accumulates instead -- every stage strictly larger than the last.
//
// Warning, not error: a genuinely hard task can grow too, and 08 pasting machine
// output is legitimately big. Monotonic AND a large total gap is the shape that
// is hard to explain any other way.
function contextBleed(telemetry = [], { minRuns = 4, growth = 2.5 } = {}) {
  const t = telemetry.filter((e) => typeof e?.inputTokens === "number");
  // Two points are not a trend, and a CLI that reports no tokens must not be
  // guessed at.
  if (t.length < minRuns) return null;
  for (let i = 1; i < t.length; i++) if (t[i].inputTokens <= t[i - 1].inputTokens) return null;
  const first = t[0].inputTokens, last = t.at(-1).inputTokens;
  if (!first || last < first * growth) return null;
  return { first, last, runs: t.length, from: t[0].stage, to: t.at(-1).stage };
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
const RISK_KEYS = ["blastRadius", "reversibility"];

// --triage runs BEFORE task.agent.json exists, so it is the one entry point the
// schema never sees -- and it is the gate that decides whether the harness runs
// at all. Unchecked it accepted `{}` (→ quick-task), `"junk"` (→ quick-task),
// `{"scope":"2"}` (string concat: "effort 0200000") and `null` (stack trace).
// A routing decision taken from rubbish is worse than no routing decision.
export function vectorInputErrors(v) {
  if (v === null || typeof v !== "object" || Array.isArray(v))
    return ["the vector must be a JSON object with all 8 dimensions (Agents.md §5.1.2)"];
  const out = [];
  for (const [keys, max] of [[EFFORT_KEYS, 2], [RISK_KEYS, 4]])
    for (const k of keys) {
      const n = v[k];
      if (n === undefined) out.push(`${k} missing — score it, do not omit it (0–${max})`);
      else if (!Number.isInteger(n) || n < 0 || n > max) out.push(`${k}=${JSON.stringify(n)} — must be an integer 0–${max}`);
    }
  const extra = Object.keys(v).filter((k) => !EFFORT_KEYS.includes(k) && !RISK_KEYS.includes(k));
  if (extra.length) out.push(`unknown dimension(s): ${extra.join(", ")} — a typo here scores 0 silently`);
  return out;
}

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

// The vector is only as good as what it was scored from. Nothing above checks
// that: `scope: 0` derives a label just as validly whether it came from `rg -l`
// or from a feeling, and the cheapest failure in this harness is a vector scored
// from the task description alone — `uncertainty` guessed low is what produces
// `fsd_review` retries, and rework costs more than every model decision combined.
//
// So each soft dimension must name the count it came from. These are the only
// two directions that are actually derivable (a count cannot tell you e2e is
// needed, so `testing: 2` stays the agent's call):
//   filesTouched == 1  ⇒ scope == 0     · filesTouched > 5 ⇒ scope == 2
//   existingTests == 0 ⇒ testing >= 1   (nothing covers it yet, by definition)
// and `questions` makes `uncertainty` answerable: a listed blocker means the
// requirement is not clear, an empty list means it is. Both directions, because
// the loophole is symmetric.
//
// Second rule, same function: a task big enough to be worth splitting must say
// it considered splitting -- at BOOTSTRAP, not after `retryBudget` is spent.
// `status: split` already exists but only as an exit from an exhausted budget,
// by which point the money is gone. Two `normal` tasks run cheaper than one
// `high` task that bounces twice.
const SPLIT_EFFORT = CFG.splitEffort ?? 9;

export function vectorEvidenceDefects(complexity) {
  const v = complexity?.vector;
  if (!v) return [];
  const out = [];
  const c = complexity.counts ?? {};
  const num = (k) => (Number.isInteger(c[k]) ? c[k] : null);

  // Which symbol was grepped is a free parameter that picks the answer: a rare
  // helper returns 1 file (scope 0), a common one returns 20 (scope 2). Naming
  // it does not remove the choice, it makes the choice reviewable.
  if (!String(c.symbol ?? "").trim())
    out.push("complexity.counts.symbol missing — name the symbol filesTouched was grepped for; picking the symbol picks the scope (Agents.md §5.1)");

  const files = num("filesTouched");
  if (files === null)
    out.push("complexity.counts.filesTouched missing — `scope` scored from the task description is the cheapest way to under-estimate a task (Agents.md §5.1)");
  // 0 matched nothing, which means either a brand-new file or a grep that
  // missed. Those score differently and the count cannot tell them apart, so
  // it falls through every rule below — say which one it is.
  else if (files === 0 && !String(complexity.note ?? "").trim())
    out.push("counts.filesTouched=0 matched nothing — complexity.note must say whether this is a new file or the grep missed (Agents.md §5.1)");
  else if (files === 1 && v.scope !== 0)
    out.push(`counts.filesTouched=1 but scope=${v.scope} — one file is scope 0`);
  else if (files > 5 && v.scope !== 2)
    out.push(`counts.filesTouched=${files} but scope=${v.scope} — more than 5 files is scope 2`);

  const tests = num("existingTests");
  if (tests === null)
    out.push("complexity.counts.existingTests missing — `testing` needs to know whether anything covers this code today (Agents.md §5.1)");
  else if (tests === 0 && (v.testing ?? 0) < 1)
    out.push("counts.existingTests=0 but testing=0 — nothing covers this yet, so it cannot be 'test sẵn phủ được'");

  const q = complexity.questions;
  if (!Array.isArray(q))
    out.push("complexity.questions missing — `uncertainty` is the dimension most often scored low, and the check is concrete: write the list of things you cannot build without knowing (Agents.md §5.1)");
  else if (q.length === 0 && (v.uncertainty ?? 0) > 0)
    out.push(`uncertainty=${v.uncertainty} but complexity.questions is empty — name what is unclear or score it 0`);
  else if (q.length > 0 && (v.uncertainty ?? 0) === 0)
    out.push(`complexity.questions lists ${q.length} open question(s) but uncertainty=0`);

  const { effort } = deriveComplexity(v);
  const oversized = effort >= SPLIT_EFFORT || ((v.scope ?? 0) === 2 && (v.uncertainty ?? 0) === 2);
  if (oversized && !String(complexity.splitEvaluated ?? "").trim())
    out.push(
      `effort=${effort} scope=${v.scope} uncertainty=${v.uncertainty} — a task this size must record complexity.splitEvaluated: either the child task IDs, or why it cannot ship in parts (Agents.md §5.1.4)`,
    );

  return out;
}

// Which road a task takes: the full harness, or the quick-task / fix-bug escape
// hatch. That boundary used to be prose ("bug nhỏ", "khi user nói rõ"), so it
// failed both ways -- overuse turns the harness into scenery, underuse charges
// 7 stages for a copy change.
//
// It reuses the vector and the risk floors rather than inventing a second set of
// thresholds: any risk dimension >= 2 already means `normal`, and a task that is
// not trivial has no business skipping the gates however small the diff looks.
function triage(vector, branchType) {
  const { label, effort } = deriveComplexity(vector);
  const { blastRadius = 0, reversibility = 0 } = vector;
  if (label !== "trivial")
    return { verdict: "harness", why: `taskComplexity=${label} (effort ${effort}, blast ${blastRadius}, rev ${reversibility})` };
  // deriveComplexity already forces `normal` at >= 2, so reaching here means
  // both are <= 1. Stated explicitly: this is the rule someone will come read.
  if (blastRadius > 1 || reversibility > 1)
    return { verdict: "harness", why: `risk too high (blast ${blastRadius}, rev ${reversibility})` };
  return {
    verdict: branchType === "bugfix" ? "fix-bug" : "quick-task",
    why: `trivial (effort ${effort}, blast ${blastRadius}, rev ${reversibility})`,
  };
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

// RESULT_RE hỏi "có chữ passed không", không hỏi "test có xanh không" — mà
// `Tests: 11 passed, 1 failed` thoả vế đầu. Đó đúng là thứ Gate 4 sinh ra để
// chặn, nên phải có vế phủ định riêng. Anchor `^` cho FAIL/✗ vì chúng hay xuất
// hiện giữa câu văn xuôi ("nếu FAIL thì…"); `\d+ failed` thì không cần.
const FAILURE_RE =
  /\b\d+\s+(failed|failing)\b|^\s*(FAIL|✗|✖|×)\s|\bexit (code )?[1-9]\d*\b|\bERR!/im;

// Lối thoát cho test đỏ CÓ CHỦ ĐÍCH (fixer reproduce-first: viết test đỏ
// trước, sửa sau). Không có nó thì agent học cách không dán output fail —
// tệ hơn hẳn việc gate lỏng, vì lúc đó bằng chứng biến mất thay vì bị bắt.
const KNOWN_FAILURE_RE = /<!--\s*known-failure:/i;

function hasRealEvidenceIn(t) {
  const fenced = fencedText(t);
  if (!EVIDENCE_RE.test(t) || !RESULT_RE.test(fenced)) return false;
  return !FAILURE_RE.test(fenced) || KNOWN_FAILURE_RE.test(t);
}

// ── attestation (scripts/run-evidence.mjs) ─────────────────────────────────
// Mọi thứ ở trên chỉ đọc HÌNH DẠNG chữ, nên một agent chưa chạy lệnh nào vẫn qua
// được bằng cách gõ ra `Tests: 12 passed`. Attestation đổi câu hỏi: không phải
// "có giống output test không" mà "tiến trình nào đã chạy và exit bao nhiêu".
//
// `evidenceMode: "attested"` trong harness.config.json bật thành bắt buộc. Mặc
// định `"legacy"` vì task đang chạy dở và repo đã có evidence viết tay không
// được đỏ hết chỉ vì nâng kernel — bật khi bạn đã chuyển ProjectRules §7 sang
// wrapper. Ở chế độ legacy, có attestation vẫn được kiểm; chỉ "thiếu" mới tha.
const ATTEST_MARK = "--- spec-harness attestation ---";
// Không có mặc định ngầm: "legacy" nhận evidence dán tay, tức là một agent chưa
// chạy lệnh nào vẫn qua Gate 4 bằng cách gõ `Tests: 12 passed`. Đó là một lựa chọn
// hợp lệ khi đang di trú, nhưng phải là lựa chọn được VIẾT RA — thừa kế nó từ một
// giá trị ngầm là cách toàn bộ luận điểm của harness sụp trong im lặng.
// --self-check đòi khai tường minh; chỗ này chỉ là fallback cho đường chạy khác.
const EVIDENCE_MODE = CFG.evidenceMode ?? "legacy";

// Phải giữ được CẢ output đứng trước attestation, không chỉ các field: outputHash
// là lời khai "attestation này thuộc về output kia", và kiểm nó thì phải có "kia".
const hashOutput = (s) => createHash("sha256").update(s, "utf8").digest("hex").slice(0, 16);

function attestationsIn(text) {
  const out = [];
  for (const m of text.matchAll(/--- spec-harness attestation ---\n([\s\S]*?)(?:```|$)/g)) {
    const get = (k) => {
      const hit = new RegExp(`^${k}:\\s*(.+)$`, "m").exec(m[1]);
      return hit ? hit[1].trim() : null;
    };
    const code = get("exitCode");
    if (code === null) continue;
    // Thân block = từ sau dòng mở fence tới ngay trước marker. Không có fence mở
    // (khối dán trần) thì body = null → không kiểm hash được, và điều đó tự nó
    // đã bị durationMs/thiếu-field bắt.
    const before = text.slice(0, m.index);
    const fenceAt = before.lastIndexOf("```");
    const body = fenceAt === -1
      ? null
      : before.slice(before.indexOf("\n", fenceAt) + 1, before.length - 1);
    out.push({
      exitCode: Number(code),
      durationMs: Number(get("durationMs") ?? NaN),
      gitRev: get("gitRev"),
      startedAt: get("startedAt"),
      outputHash: get("outputHash"),
      body,
    });
  }
  return out;
}

// Trả về danh sách defect. Rỗng = attestation không nói gì sai.
function attestationDefects(text, label, mode = EVIDENCE_MODE) {
  const found = attestationsIn(text);
  if (!found.length) {
    if (mode !== "attested") return [];
    return [
      `${label}: evidenceMode="attested" nhưng không có khối attestation nào — chạy lệnh qua \`node scripts/run-evidence.mjs -- <lệnh>\` thay vì dán output bằng tay`,
    ];
  }
  const d = [];
  for (const a of found) {
    // Đây là lý do wrapper tồn tại: output in ra "passed" mà exit khác 0.
    if (a.exitCode !== 0 && !KNOWN_FAILURE_RE.test(text))
      d.push(`${label}: attestation ghi exitCode ${a.exitCode} — lệnh THẤT BẠI, bất kể output nói gì`);
    // durationMs 0 nghĩa là không có tiến trình nào thật sự chạy; NaN nghĩa là
    // khối được gõ tay thiếu field. Cả hai đều là attestation không đáng tin.
    if (!Number.isFinite(a.durationMs) || a.durationMs <= 0)
      d.push(`${label}: attestation có durationMs không hợp lệ ("${a.durationMs}") — khối này không do run-evidence.mjs sinh ra`);
    // outputHash buộc attestation vào output nằm cạnh nó. Thiếu field hoặc lệch
    // hash = hai ca bịa rẻ nhất: chép khối từ task khác, hoặc chạy thật rồi sửa
    // output cho đẹp. Cả hai đều qua được mọi kiểm tra theo field.
    if (a.body !== null) {
      if (!a.outputHash)
        d.push(`${label}: attestation thiếu outputHash — khối cũ hoặc gõ tay; chạy lại qua \`node scripts/run-evidence.mjs\``);
      else if (hashOutput(a.body) !== a.outputHash)
        d.push(`${label}: outputHash không khớp output trong fence — output đã bị sửa sau khi chạy, hoặc attestation chép từ nơi khác`);
    }
  }
  return d;
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

  // Kiểm byte-identical ở trên là heuristic yếu: thêm một dòng là qua. Khi cả
  // hai file có attestation thì so được thứ chặt hơn — adversary PHẢI chạy sau
  // implementer. startedAt của 09 sớm hơn 08 nghĩa là khối đó chép từ nơi khác,
  // hoặc chép từ chính 08 rồi sửa vài chữ.
  const advA = attestationsIn(t);
  const evA = evidenceText ? attestationsIn(evidenceText) : [];
  if (advA.length && evA.length) {
    const newestEv = Math.max(...evA.map((a) => Date.parse(a.startedAt ?? "")).filter(Number.isFinite));
    const oldestAdv = Math.min(...advA.map((a) => Date.parse(a.startedAt ?? "")).filter(Number.isFinite));
    if (Number.isFinite(newestEv) && Number.isFinite(oldestAdv) && oldestAdv < newestEv)
      d.push(
        "09's attestation started BEFORE 08's newest run — Gate 5 must re-run after the implementer, so this block did not come from your own run (§3.2)",
      );
  }
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
// Reachable is not the same as armed. The file can be present, loaded, and
// empty -- every deny rule gone, preflight still green. These are the rules the
// harness relies on: Instructions.md forbids them in prose, and prose is what
// a model chooses to follow.
export // The resume heading is a STRUCTURAL MARKER the validator splits on, so it must
// not follow config.docLanguage: a team setting docLanguage="English" would
// otherwise turn off newest-block cap enforcement without any warning. Accept
// either spelling; the docs use whichever matches their prose.
const UPDATE_HEADING = /^## (?:Cập Nhật|Update) — /m;

const REQUIRED_DENY = ["git push", "git reset --hard", "git stash", "git clean"];

export function denyGaps(settingsText) {
  let parsed;
  try { parsed = JSON.parse(settingsText); } catch { return ["settings.json is not valid JSON \u2014 the CLI ignores it entirely, so every deny rule is gone"]; }
  const deny = parsed?.permissions?.deny ?? [];
  return REQUIRED_DENY.filter((r) => !deny.some((d) => d.includes(r))).map(
    (r) => `.claude/settings.json has no deny rule for \`${r}\` \u2014 the guardrail is back to being prose the model may ignore`,
  );
}

// A placeholder URL is worse than a missing one: `https://<git-host>/...` kills
// the CLI with ERR_INVALID_URL at startup, and `example.com` resolves fine while
// answering nothing -- Gate 1 loses its source of AC and the whole trace chain
// becomes invention.
// `example.com` là placeholder ở BẤT KỲ đâu trong hostname, không chỉ đầu chuỗi:
// bản cài ra có `gitlab.example.com`, và một regex neo đầu chuỗi sẽ cho nó qua —
// đúng kiểu check tồn tại mà không bắt được gì.
const PLACEHOLDER_HOST = /(?:^<|\bexample\.(?:com|org|net)$|^localhost$|^your-|changeme)/i;

// Secrets do not belong in a committed file. OAuth tokens live in ~/.claude.json
// by design, but .mcp.json is the file people hand-edit, and it is the natural
// place to paste `Authorization: Bearer ...` when a server has no OAuth.
const SECRETISH = /"(authorization|token|api[_-]?key|secret|password|bearer)"\s*:/i;

export function mcpGaps(text) {
  const out = { errors: [], warnings: [] };
  let cfg;
  try { cfg = JSON.parse(text); } catch { return { errors: [".mcp.json is not valid JSON \u2014 the CLI starts with no MCP servers at all"], warnings: [] }; }
  if (SECRETISH.test(text))
    out.errors.push(".mcp.json contains what looks like a credential field \u2014 it is committed; move it to an env var or the CLI's own auth store");
  for (const [name, srv] of Object.entries(cfg.mcpServers ?? {})) {
    if (!srv?.url) continue; // local server: command + args
    let host;
    try { host = new URL(srv.url).hostname; }
    catch { out.errors.push(`.mcp.json server "${name}" has an unparseable url (${srv.url}) \u2014 the CLI dies with ERR_INVALID_URL at startup, before you can fix it`); continue; }
    if (PLACEHOLDER_HOST.test(host))
      out.errors.push(`.mcp.json server "${name}" still points at a placeholder (${host}) \u2014 Gate 1 has no source of AC, so the whole traceability chain is invented`);
  }
  return out;
}

// Cho phép kiểm một settings.json rời (install.mjs --self-test dùng): hai nơi
// tự liệt kê lại danh sách deny thì chúng sẽ lệch, và lệch kiểu đó nghĩa là
// ship ra một settings.json mà chính preflight của nó báo đỏ.
if (args.has("--check-settings")) {
  const f = argv[argv.indexOf("--check-settings") + 1];
  if (!f) { console.error("dùng: --check-settings <settings.json>"); process.exit(2); }
  const gaps = denyGaps(readFileSync(f, "utf8"));
  gaps.forEach((g) => console.error(`✖ ${g}`));
  process.exit(gaps.length ? 1 : 0);
}

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
  // The other direction. A pattern only had to ACCEPT the sample, so `npm run .*`
  // passed self-check green while Gate 4 took `npm run dev` as proof a test ran.
  // A gate that accepts everything is a gate with no teeth, and this is exactly
  // the silent no-op --self-check exists to catch.
  const negatives = CFG.evidenceNegativeSamples ?? [];
  assert.ok(
    negatives.length >= 2,
    "config.evidenceNegativeSamples needs >= 2 commands that must NOT count as evidence (e.g. [\"npm run dev\", \"npm run start\"]) — without them a too-broad pattern passes",
  );
  for (const neg of negatives)
    assert.equal(
      EVIDENCE_RE.test(neg),
      false,
      `config.evidenceCommandPattern matches "${neg}", which is declared a non-evidence command — the pattern is too broad`,
    );
  // Backstop for a config that declares narrow negatives but a wide pattern:
  // no real test/lint/build command is called `dev` or `start`.
  for (const neg of ["npm run dev", "npm run start", "yarn dev", "pnpm dev"])
    assert.equal(
      EVIDENCE_RE.test(neg),
      false,
      `config.evidenceCommandPattern matches "${neg}" — a dev server is not test evidence`,
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
  // Gate 4 phải hỏi "test có xanh không", không phải "có chữ passed không".
  // Output có cả passed lẫn failed từng LỌT — đúng ca gate tồn tại để chặn.
  assert.equal(
    hasRealEvidenceIn("```\n$ " + sample + "\nTests: 11 passed, 1 failed\n```"),
    false,
    "output có test fail KHÔNG được qua Gate 4 chỉ vì có chữ passed",
  );
  assert.equal(
    hasRealEvidenceIn("```\n$ " + sample + "\nFAIL src/a.spec.ts\n4 passed\n```"),
    false,
    "dòng FAIL trong output chặn Gate 4",
  );
  assert.equal(
    hasRealEvidenceIn("```\n$ " + sample + "\n2 passed\nexit 1\n```"),
    false,
    "exit code khác 0 chặn Gate 4",
  );
  // Lối thoát: test đỏ có chủ đích (fixer reproduce-first) vẫn khai được.
  assert.equal(
    hasRealEvidenceIn(
      "<!-- known-failure: AC-03 reproduce -->\n```\n$ " + sample + "\nTests: 3 passed, 1 failed\n```",
    ),
    true,
    "known-failure đã khai thì vẫn là evidence hợp lệ",
  );
  // "FAIL" trong văn xuôi (ngoài fence) không được chặn nhầm — fence mới là bằng chứng.
  assert.equal(
    hasRealEvidenceIn("Nếu FAIL thì dừng.\n```\n$ " + sample + "\nTests: 4 passed\n```"),
    true,
    "chữ FAIL trong văn xuôi không phải kết quả chạy",
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
  // evidenceMode has no safe default. "legacy" accepts hand-pasted evidence, so
  // an agent that ran nothing still clears Gate 4 by typing `Tests: 12 passed`.
  // Inheriting that from an unset field is how the product's whole claim fails
  // silently — so the field is required, and choosing legacy has to be a choice
  // someone typed.
  // Prose language is a project choice, not a kernel constant. Welding it in is
  // the same bug as naming the roles fe-*: an English-speaking team installs
  // this and gets told to write task docs in Vietnamese.
  assert.ok(
    typeof CFG.docLanguage === "string" && CFG.docLanguage.trim(),
    'config.docLanguage is required (e.g. "English", "Tiếng Việt") — the kernel does not pick a prose language for you',
  );
  assert.ok(
    ["attested", "legacy"].includes(CFG.evidenceMode),
    `config.evidenceMode must be "attested" or "legacy" (got ${JSON.stringify(CFG.evidenceMode)}) — there is no default: "legacy" lets Gate 4 accept evidence no process ever produced`,
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
  // Same doc, English heading: the cap must behave identically, or docLanguage
  // silently disables it.
  const twoRoundsEn = `${body(12)}\n## Update — 2026-01-02\n${body(3)}`;
  assert.equal(
    twoRoundsEn.split(UPDATE_HEADING).length,
    twoRounds.split(UPDATE_HEADING).length,
    "the update marker must be language-independent — it is structure, not prose",
  );
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

    // outcome coverage: findings are computed over tasks that HAVE an outcome,
    // so a holed sample must say so before anyone retunes a threshold from it.
    const holed = calibrate([
      ...Array.from({ length: 2 }, () => t({ status: "done" })),
      ...Array.from({ length: 8 }, () => ({ taskComplexity: "normal", status: "done", attempts: {} })),
    ]);
    assert.equal(holed.coverage.shipped, 10, "denominator is every shipped task");
    assert.equal(holed.coverage.withOutcome, 2, "numerator is tasks with an outcome");
    assert.ok(holed.findings.some((f) => f.includes("coverage")), "20% coverage must warn about the sample");
    assert.deepEqual(
      calibrate(Array.from({ length: 5 }, () => t({ status: "done" }))).findings,
      [],
      "full coverage must not warn",
    );

    // outcome.closedAt: warning for tasks older than the harness, error for
    // tasks started under it — pre-commit runs --no-warn, so a warning here
    // never blocked anything and the learning loop could die green.
    assert.equal(outcomeIsBlocking({ createdAt: "2026-09-01" }, "2026-07-28"), true, "created after since → error");
    assert.equal(outcomeIsBlocking({ createdAt: "2026-01-01" }, "2026-07-28"), false, "predates the harness → warning");
    assert.equal(outcomeIsBlocking({}, "2026-07-28"), false, "no createdAt must not invent an error");

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

  // ── attestation ──────────────────────────────────────────────────────────
  // Đây là ca wrapper sinh ra để bắt, và là ca mọi kiểm-bằng-regex đều thua:
  // output in ra "passed" nhưng lệnh exit khác 0.
  {
    // Dựng block y như run-evidence.mjs dựng, gồm cả outputHash — nếu không thì
    // mọi ca dưới đây chỉ test được vế "thiếu hash", không test được vế nào khác.
    const att = (code, dur = 12, at = "2026-09-18T09:00:00Z", out = "Tests: 12 passed") => {
      const body = `$ ${sample}\n${out}`;
      return ["```", body, ATTEST_MARK, `exitCode: ${code}`, `durationMs: ${dur}`,
              "gitRev: a3f9c1e", `startedAt: ${at}`, `outputHash: ${hashOutput(body)}`, "```"].join("\n");
    };

    assert.deepEqual(attestationDefects(att(0), "08"), [], "attestation exit 0 là sạch");
    // outputHash: hai ca bịa rẻ nhất mà kiểm-theo-field cho qua hết.
    assert.ok(
      attestationDefects(att(0).replace("Tests: 12 passed", "Tests: 99 passed"), "08")
        .some((d) => /outputHash không khớp/.test(d)),
      "sửa output sau khi chạy mà giữ attestation phải bị bắt",
    );
    assert.ok(
      attestationDefects(att(0).replace(/outputHash: .+/, ""), "08").some((d) => /thiếu outputHash/.test(d)),
      "attestation không có outputHash là khối gõ tay hoặc bản cũ",
    );
    assert.ok(
      attestationDefects(att(1), "08").some((d) => /exitCode 1/.test(d)),
      "in ra passed mà exitCode 1 phải bị bắt — regex không bao giờ thấy được điều này",
    );
    // durationMs 0 = không tiến trình nào chạy; thiếu field = khối gõ tay.
    assert.ok(
      attestationDefects(att(0, 0), "08").some((d) => /durationMs/.test(d)),
      "durationMs 0 nghĩa là không có lệnh nào thật sự chạy",
    );
    assert.ok(
      attestationDefects(ATTEST_MARK + "\nexitCode: 0\n", "08").some((d) => /durationMs/.test(d)),
      "attestation thiếu durationMs không đáng tin",
    );
    // known-failure vẫn là lối thoát hợp lệ, y như với FAILURE_RE.
    assert.deepEqual(
      attestationDefects("<!-- known-failure: AC-03 -->\n" + att(1), "08"),
      [],
      "test đỏ có chủ đích đã khai thì exitCode khác 0 vẫn hợp lệ",
    );
    // Hai mode phải được kiểm TƯỜNG MINH, không đọc ké config đang bật: bài test
    // "thiếu attestation có phải lỗi không" mà phụ thuộc evidenceMode của repo
    // nguồn thì đổi một dòng config là mất luôn một nửa vế.
    assert.deepEqual(attestationDefects("không có attestation", "08", "legacy"), [],
      'legacy: repo đang di trú không được đỏ hết chỉ vì nâng kernel');
    assert.ok(
      attestationDefects("```\n$ " + sample + "\nTests: 12 passed\n```", "08", "attested")
        .some((d) => /attestation/.test(d)),
      'attested: output gõ tay không có attestation phải bị chặn — đó là lý do mode này tồn tại',
    );

    // Gate 5 phải chạy SAU implementer. startedAt sớm hơn = khối chép từ nơi khác.
    const evNew = att(0, 12, "2026-09-18T10:00:00Z");
    const advOld = att(0, 12, "2026-09-18T09:00:00Z");
    assert.ok(
      adversaryDefects(advOld + "\nPASS\n| `" + sample + "` | ok |", evNew).some((d) => /BEFORE/.test(d)),
      "attestation của 09 sớm hơn 08 = adversary không tự chạy",
    );
    const advNew = att(0, 12, "2026-09-18T11:00:00Z");
    assert.ok(
      !adversaryDefects(advNew + "\nPASS\n| `" + sample + "` | ok |", evNew).some((d) => /BEFORE/.test(d)),
      "chạy sau thì không bị bắt",
    );
  }

  // --task: khoá rút ra từ hai segment cuối, chấp nhận mọi dạng coordinator có.
  assert.equal(taskKeyOf("docs/tasks/sprint-1/ABC-1-x"), "sprint-1/ABC-1-x", "đường dẫn đầy đủ");
  assert.equal(taskKeyOf("sprint-1/ABC-1-x"), "sprint-1/ABC-1-x", "dạng rút gọn");
  assert.equal(taskKeyOf("./docs/tasks/sprint-1/ABC-1-x/"), "sprint-1/ABC-1-x", "có ./ và / cuối");
  assert.equal(taskKeyOf("docs\\tasks\\sprint-1\\ABC-1-x"), "sprint-1/ABC-1-x", "dấu \\ của Windows");

  // --task trỏ folder không có thật phải THOÁT LỖI, không phải "0 task, 0 error".
  // Gate xanh vì không tìm thấy gì để kiểm là gate tệ hơn không có gate.
  {
    const r = spawnSync(process.execPath, [fileURLToPath(import.meta.url), "--task", "sprint-9/khong-co-that", "--quiet"],
      { cwd: REPO_ROOT, encoding: "utf8" });
    assert.equal(r.status, 2, "--task trỏ folder không tồn tại phải exit 2, không được cho qua");
    assert.ok(/không thấy task folder/.test(r.stderr), "và phải nói rõ vì sao");
  }

  // triage log: closing the one loophole --triage still had. The parser must be
  // strict about what it accepts -- a finding invented from a corrupt line sends
  // someone hunting a dishonesty that never happened.
  {
    const { mkdtempSync, writeFileSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const d = mkdtempSync(join(tmpdir(), "sh-tr-"));
    const log = join(d, "_triage.log");
    assert.equal(triageVectorFor(log, "A-1"), null, "no log file → nothing to compare");
    writeFileSync(
      log,
      `2026-01-01\tA-1\tquick-task\t-\t{"scope":0}\t\n` +
        `2026-01-01\tB-2\tharness\tforced\t{"scope":2}\twhy\n` +
        `rubbish line\n` +
        `2026-01-02\tA-1\tquick-task\t-\t{"scope":1}\t\n`,
    );
    assert.deepEqual(triageVectorFor(log, "A-1"), { scope: 1 }, "last entry wins: a re-triage supersedes");
    assert.deepEqual(triageVectorFor(log, "B-2"), { scope: 2 }, "finds the right task");
    assert.equal(triageVectorFor(log, "C-3"), null, "task not in the log → no finding");

    assert.deepEqual(vectorDriftSince({ scope: 0 }, { scope: 2, testing: 1 }).raised, ["scope 0→2", "testing 0→1"], "names each raised dimension");
    assert.deepEqual(vectorDriftSince({ scope: 2 }, { scope: 2 }), { raised: [], lowered: [] }, "unchanged → silent");
    // §5.1.3 is "chỉ nâng, không hạ" -- the forbidden direction must be the one
    // that is actually reported, or the rule has no teeth anywhere.
    assert.deepEqual(vectorDriftSince({ scope: 2 }, { scope: 1 }).lowered, ["scope 2→1"], "lowered is the direction §5.1.3 forbids");
    assert.deepEqual(vectorDriftSince({ scope: 2 }, { scope: 1 }).raised, [], "a lowered dimension is not also 'raised'");
    assert.deepEqual(vectorDriftSince(null, { scope: 2 }), { raised: [], lowered: [] }, "never triaged → nothing to compare");
  }

  // --triage input: the one entry point the schema never sees, and the one that
  // decides whether the harness runs at all. Every case below used to produce a
  // confident verdict from rubbish.
  {
    const full = { scope: 0, uncertainty: 0, dependency: 0, dataImpact: 0, integration: 0, testing: 0, blastRadius: 0, reversibility: 0 };
    assert.deepEqual(vectorInputErrors(full), [], "a complete zero vector is valid input");
    assert.ok(vectorInputErrors(null)[0].includes("8 dimensions"), "null is not a vector");
    assert.ok(vectorInputErrors("junk")[0].includes("8 dimensions"), "a string is not a vector");
    assert.ok(vectorInputErrors([])[0].includes("8 dimensions"), "an array is not a vector");
    assert.equal(vectorInputErrors({}).length, 8, "an empty object is 8 missing dimensions, not a trivial task");
    assert.ok(vectorInputErrors({ ...full, scope: "2" })[0].includes("integer"), "a string digit concatenates instead of summing");
    assert.ok(vectorInputErrors({ ...full, blastRadius: -4 })[0].includes("integer"), "negative is rejected");
    assert.ok(vectorInputErrors({ ...full, scope: 3 })[0].includes("0–2"), "effort dimensions cap at 2");
    assert.ok(vectorInputErrors({ ...full, blastRadius: 4 }).length === 0, "risk dimensions go to 4");
    assert.ok(vectorInputErrors({ ...full, blastRadius: 5 })[0].includes("0–4"), "risk dimensions cap at 4");
    assert.ok(vectorInputErrors({ ...full, scop: 2 })[0].includes("unknown"), "a typo'd key would score 0 in silence");
  }

  // split: the named exit from an exhausted retry budget. Both halves matter --
  // without children it must stay an error, or "split" is just a bypass.
  {
    const accepted = (d) => d.status === "split" && (d.splitInto ?? []).length >= 2;
    assert.equal(accepted({ status: "split", splitInto: ["A-1", "A-2"] }), true, "split with 2 children is accepted");
    assert.equal(accepted({ status: "split", splitInto: ["A-1"] }), false, "one child is not a split");
    assert.equal(accepted({ status: "split" }), false, "split with no children is a rename for giving up");
    assert.equal(accepted({ status: "blocked", splitInto: ["A-1", "A-2"] }), false, "splitInto alone does not grant the exemption");
    // A split never shipped, so Gate 4/5 must not demand evidence from it.
    assert.equal(GATE4_DONE.has("split"), false, "split is not a gate4 status — it never shipped");
    assert.equal(
      calibrate([{ status: "split" }, { status: "split" }]).splits,
      2,
      "splits are counted even though they have no outcome",
    );
    assert.ok(
      calibrate([{ status: "split" }, { taskComplexity: "normal", status: "done", attempts: {}, outcome: { closedAt: "2026-01-01" } }])
        .findings.some((f) => f.includes("split")),
      "a split is a finding: the retry budget ran out before anyone cut the task up",
    );
  }

  // contextBleed: the /clear rule with a measurement behind it. False positives
  // are the real risk here -- it is a warning on self-reported data, so the
  // negative cases matter more than the positive one.
  {
    const tel = (...n) => n.map((inputTokens, i) => ({ stage: `s${i}`, tier: "mid", inputTokens }));
    assert.ok(contextBleed(tel(6000, 11000, 19000, 31000)), "monotonic 5x growth over 4 dispatches");
    assert.equal(contextBleed(tel(6000, 19000, 9000, 31000)), null, "wobble is normal even when the total is big");
    assert.equal(contextBleed(tel(6000, 31000)), null, "2 points are not a trend");
    assert.equal(contextBleed(tel(6000, 7000, 8000, 9000)), null, "monotonic but mild: stages do differ in size");
    assert.equal(contextBleed([{ stage: "a", tier: "mid" }, { stage: "b", tier: "mid" }]), null, "no tokens reported → no guess");
    assert.equal(contextBleed([]), null, "no telemetry at all");
    assert.equal(contextBleed(tel(0, 0, 0, 9000)), null, "a zero first reading must not divide into a finding");
  }

  // vector evidence: the vector decides model tier, gate weight and worktree, so
  // a vector scored from vibes routes real money. Both directions get a case --
  // demanding counts that contradict the score is as broken as demanding none.
  {
    const ok = {
      vector: { scope: 1, uncertainty: 0, dependency: 0, dataImpact: 0, integration: 0, testing: 1, blastRadius: 0, reversibility: 0 },
      counts: { symbol: "useRoster", filesTouched: 3, existingTests: 0 },
      questions: [],
    };
    const d = (o) => vectorEvidenceDefects(o);
    // Which symbol was grepped picks the scope, so it has to be on the record.
    assert.ok(
      d({ ...ok, counts: { filesTouched: 3, existingTests: 0 } })[0].includes("symbol"),
      "an unnamed grep symbol lets the scorer choose the answer",
    );
    // 0 matches falls through every count rule; new file vs missed grep score
    // differently and only a human can say which.
    assert.ok(
      d({ ...ok, counts: { ...ok.counts, filesTouched: 0 } }).some((x) => x.includes("matched nothing")),
      "filesTouched=0 must be explained, not silently accepted",
    );
    assert.deepEqual(
      d({ ...ok, counts: { ...ok.counts, filesTouched: 0 }, note: "new file: src/x.tsx" }),
      [],
      "a note explaining the zero clears it",
    );
    assert.deepEqual(d(ok), [], "a fully evidenced vector is silent");
    assert.deepEqual(d(undefined), [], "no complexity block at all is handled elsewhere (§5.1 warning)");
    assert.deepEqual(d({ counts: ok.counts, questions: [] }), [], "counts without a vector: nothing to cross-check");

    assert.ok(d({ ...ok, counts: { symbol: "s", existingTests: 0 } }).some((x) => x.includes("filesTouched")), "missing filesTouched is named");
    assert.ok(d({ ...ok, counts: { symbol: "s", filesTouched: 3 } }).some((x) => x.includes("existingTests")), "missing existingTests is named");
    assert.ok(d({ vector: ok.vector, counts: ok.counts }).some((x) => x.includes("questions")), "missing questions is named");

    // counts must actually constrain the score, or they are decoration.
    assert.ok(
      d({ ...ok, counts: { symbol: "s", filesTouched: 1, existingTests: 0 } }).some((x) => x.includes("one file is scope 0")),
      "1 file cannot be scope 1",
    );
    assert.ok(
      d({ ...ok, counts: { symbol: "s", filesTouched: 9, existingTests: 0 } }).some((x) => x.includes("more than 5 files")),
      "9 files cannot be scope 1",
    );
    assert.deepEqual(
      d({ vector: { ...ok.vector, scope: 2 }, counts: { symbol: "s", filesTouched: 9, existingTests: 0 }, questions: [] }),
      [],
      "9 files with scope 2 is consistent",
    );
    assert.ok(
      d({ vector: { ...ok.vector, testing: 0 }, counts: { symbol: "s", filesTouched: 3, existingTests: 0 }, questions: [] })
        .some((x) => x.includes("existingTests=0")),
      "no test covers it ⇒ testing cannot be 0",
    );
    assert.deepEqual(
      d({ vector: { ...ok.vector, testing: 0 }, counts: { symbol: "s", filesTouched: 3, existingTests: 4 }, questions: [] }),
      [],
      "existing tests cover it ⇒ testing 0 is fine",
    );

    // uncertainty is the expensive one, so it is checked in both directions.
    assert.ok(
      d({ vector: { ...ok.vector, uncertainty: 2 }, counts: ok.counts, questions: [] }).some((x) => x.includes("empty")),
      "uncertainty>0 with no listed question",
    );
    assert.ok(
      d({ ...ok, questions: ["which role sees the button?"] }).some((x) => x.includes("uncertainty=0")),
      "a listed blocker contradicts uncertainty 0",
    );

    // split-before-spend: the point is to fire at bootstrap, not after retries.
    const big = { scope: 2, uncertainty: 2, dependency: 2, dataImpact: 2, integration: 1, testing: 1, blastRadius: 1, reversibility: 1 };
    const bigOk = { vector: big, counts: { symbol: "s", filesTouched: 9, existingTests: 0 }, questions: ["q"] };
    assert.ok(d(bigOk).some((x) => x.includes("splitEvaluated")), "effort 10 must record a split decision");
    assert.deepEqual(
      d({ ...bigOk, splitEvaluated: "cannot split: one migration, one deploy" }),
      [],
      "an answered split decision clears it",
    );
    assert.ok(d({ ...bigOk, splitEvaluated: "   " }).some((x) => x.includes("splitEvaluated")), "blank is not an answer");
    assert.ok(
      d({
        vector: { scope: 2, uncertainty: 2, dependency: 0, dataImpact: 0, integration: 0, testing: 0, blastRadius: 0, reversibility: 0 },
        counts: { symbol: "s", filesTouched: 9, existingTests: 0 },
        questions: ["q"],
      }).some((x) => x.includes("splitEvaluated")),
      "wide AND unclear at effort 4 still asks the question",
    );
    assert.deepEqual(d(ok), [], "a small task is never asked to split");
  }

  // triage: which road a task takes. The failure this guards is symmetric --
  // overusing the escape hatch makes the harness scenery, underusing it charges
  // 7 stages for a copy change -- so both directions get a case.
  {
    const z = { scope: 0, uncertainty: 0, dependency: 0, dataImpact: 0, integration: 0, testing: 0, blastRadius: 0, reversibility: 0 };
    assert.equal(triage({ ...z }, "feature").verdict, "quick-task", "all zero → escape hatch");
    assert.equal(triage({ ...z }, "bugfix").verdict, "fix-bug", "same size, bug branch → fix-bug");
    assert.equal(triage({ ...z, scope: 2, testing: 1 }, "feature").verdict, "harness", "effort 3 is no longer trivial");
    // The whole point of riskFloor: size and risk are different questions.
    assert.equal(triage({ ...z, scope: 1, blastRadius: 3 }, "bugfix").verdict, "harness", "one-file fix, service-wide blast → harness");
    assert.equal(triage({ ...z, reversibility: 2 }, "feature").verdict, "harness", "needs a redeploy to undo → harness");
    assert.equal(triage({ ...z, blastRadius: 1, reversibility: 1 }, "feature").verdict, "quick-task", "low risk stays on the hatch");
  }

  // preflight: the CLI walks UP from cwd for .claude/, never down. Layout B puts
  // settings.json in harness/ and invites you to open the parent -- below cwd,
  // invisible, deny-list silently gone. A "found it" that actually matched
  // ~/.claude/settings.json is the same failure wearing a green tick.
  {
    const { mkdtempSync, mkdirSync, writeFileSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const root = mkdtempSync(join(tmpdir(), "sh-pf-"));
    const h = join(root, "harness");
    mkdirSync(join(h, ".claude"), { recursive: true });
    mkdirSync(join(h, "sub"), { recursive: true });
    assert.equal(settingsReachable(h, h), "missing", "no settings.json at all");
    writeFileSync(join(h, ".claude", "settings.json"), "{}");
    assert.equal(settingsReachable(h, h), "ok", "cwd = harness root");
    assert.equal(settingsReachable(h, join(h, "sub")), "ok", "cwd below root: the CLI walks up and finds it");
    assert.equal(settingsReachable(h, root), "not-loaded", "cwd ABOVE root: the CLI never walks down (layout B trap)");
  }

  // denyGaps: present + loaded is not the same as armed. (That the settings.json
  // we SHIP satisfies these rules is asserted in install.mjs --self-test, which
  // is the only place with the source tree; here we test the predicate.)
  assert.equal(denyGaps('{"permissions":{"deny":[]}}').length, REQUIRED_DENY.length,
    "an empty deny list is every rule missing, not a pass");
  assert.ok(denyGaps("not json").some((d) => /valid JSON/.test(d)),
    "unparseable settings.json means the CLI ignores it — that is worse than missing, not better");
  assert.ok(
    denyGaps('{"permissions":{"deny":["Bash(git push:*)","Bash(git reset --hard:*)","Bash(git stash:*)"]}}')
      .some((d) => /git clean/.test(d)),
    "a partial deny list must name the rule that is missing, not just fail",
  );

  // mcpGaps: a placeholder URL kills the CLI at startup; a credential is committed.
  assert.deepEqual(mcpGaps('{"mcpServers":{"tracker":{"type":"http","url":"https://mcp.clickup.com/mcp"}}}').errors, [],
    "a real URL is fine");
  assert.deepEqual(mcpGaps('{"mcpServers":{"browser":{"command":"npx","args":["-y","x"]}}}').errors, [],
    "a local server has no url and must not be flagged");
  assert.ok(mcpGaps('{"mcpServers":{"g":{"url":"https://<git-host>/api"}}}').errors.some((e) => /ERR_INVALID_URL/.test(e)),
    "angle brackets are not a valid hostname — the CLI dies before you can fix it");
  assert.ok(mcpGaps('{"mcpServers":{"t":{"url":"https://example.com/mcp"}}}').errors.some((e) => /placeholder/.test(e)),
    "example.com parses fine and answers nothing — Gate 1 loses its source of AC");
  // The shipped template uses `gitlab.example.com`; an anchored regex would wave
  // it through, which is a check that exists without catching anything.
  assert.ok(mcpGaps('{"mcpServers":{"g":{"url":"https://gitlab.example.com/api/v4/mcp"}}}').errors
      .some((e) => /placeholder/.test(e)),
    "a placeholder subdomain is still a placeholder");
  assert.deepEqual(mcpGaps('{"mcpServers":{"t":{"url":"https://gitlab.acme-corp.com/api/v4/mcp"}}}').errors, [],
    "a real self-hosted host must not be flagged");
  assert.ok(mcpGaps('{"mcpServers":{"t":{"url":"https://x.com","headers":{"Authorization":"Bearer sk-1"}}}}').errors
      .some((e) => /credential/.test(e)),
    ".mcp.json is committed; a bearer token in it is a leak");

  console.log("✅ validate-tasks self-check passed");
  process.exit(0);
}

// ---------------------------------------------------------------------------
// --preflight: is this checkout actually wired up? Run once before the first
// task, and from /start-task step 0.
//
// Two install faults only surfaced much later. Opening the CLI one directory
// above the harness leaves .claude/settings.json invisible, so the deny-list on
// `git push` / `git reset --hard` is gone -- broken but looking fine. And a
// self-contradicting config makes every gate a silent no-op, which the README
// admits you notice "after a few dozen tasks". Both are one cheap check away.
// ---------------------------------------------------------------------------

export function findUpward(name, start) {
  let dir = resolve(start);
  for (;;) {
    const hit = join(dir, name);
    if (existsSync(hit)) return hit;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

// The CLI loads .claude/ by walking UP from cwd, never down. So the project
// settings only load when the directory holding them is cwd or an ancestor of
// it. Layout B puts them in harness/ and invites you to open the parent — then
// they are below cwd, invisible, and the deny-list is silently gone.
//
// Not "does a settings.json exist somewhere up the tree": ~/.claude/settings.json
// almost always does, and it is not the project's.
export function settingsReachable(repoRoot, cwd) {
  if (!existsSync(join(repoRoot, ".claude", "settings.json"))) return "missing";
  const rel = relative(resolve(repoRoot), resolve(cwd));
  const below = rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
  return below ? "ok" : "not-loaded";
}

// ---------------------------------------------------------------------------
// --triage: harness, or escape hatch? Exit code, not prose.
//
//   node scripts/validate-tasks.mjs --triage '{"scope":0,...}' [--branch-type bugfix]
//   ... --force "why I am skipping the harness anyway"
//
// Skipping the harness is a legitimate call. Skipping it without a trace is not,
// so --force appends the verdict, the vector and the reason to _triage.log.
// ---------------------------------------------------------------------------
if (args.has("--triage")) {
  const at = argv.indexOf("--triage");
  let vector;
  try {
    vector = JSON.parse(argv[at + 1] ?? "");
  } catch {
    console.error("✖ --triage needs the complexity vector as JSON (Agents.md §5.1.2)");
    process.exit(2);
  }
  const flagVal = (name) => {
    const i = argv.indexOf(name);
    return i >= 0 ? argv[i + 1] : null;
  };
  const bad = vectorInputErrors(vector);
  if (bad.length) {
    console.error(`✖ --triage vector rejected (Agents.md §5.1.2):\n  ${bad.join("\n  ")}`);
    process.exit(2);
  }
  const r = triage(vector, flagVal("--branch-type"));
  const force = flagVal("--force");

  if (args.has("--force") && !force) {
    console.error("✖ --force needs a reason — skipping the harness is a decision, and a decision with no trace is not reviewable");
    process.exit(2);
  }
  // Log EVERY run, not just forced ones. Logging only the forced case records
  // exactly the decision that was already confessed, and misses the quiet one:
  // scoring `scope: 0` instead of `1` to make the verdict come out "quick-task".
  // The vector is scored again at bootstrap, so a low score here becomes
  // checkable against the one that lands in task.agent.json.
  const taskId = flagVal("--task-id");
  if (!taskId) {
    console.error("✖ --triage needs --task-id: an unattributable verdict cannot be cross-checked against the bootstrap vector (Agents.md §5.1.3)");
    process.exit(2);
  }
  {
    const { appendFileSync, mkdirSync } = await import("node:fs");
    mkdirSync(TASKS_DIR, { recursive: true });
    appendFileSync(
      join(TASKS_DIR, "_triage.log"),
      `${new Date().toISOString()}\t${taskId}\t${r.verdict}\t${force ? "forced" : "-"}\t${JSON.stringify(vector)}\t${force ?? ""}\n`,
    );
  }

  if (AS_JSON) console.log(JSON.stringify({ ...r, forced: force ?? null }));
  else console.log(`${r.verdict}  —  ${r.why}${force ? `\n(forced: ${force} — logged to ${join(CFG.tasksDir ?? "docs/tasks", "_triage.log")})` : ""}`);
  // 10, not 1: "run the harness" is a routing answer, not a validator failure.
  process.exit(force || r.verdict !== "harness" ? 0 : 10);
}

if (args.has("--preflight")) {
  const errs = [];
  const warns = [];

  // The guardrail layer. Without it the deny-list is gone and nothing says so.
  // The spec-harness source repo is not an installed project: install.mjs at the
  // root means .claude/ is a thing this repo SHIPS, not a thing it runs under.
  const isSourceRepo = existsSync(join(REPO_ROOT, "install.mjs")) && existsSync(join(REPO_ROOT, "kernel"));
  const reach = isSourceRepo ? "source-repo" : settingsReachable(REPO_ROOT, process.cwd());
  if (reach === "source-repo") warns.push("spec-harness source repo — skipping the .claude/settings.json check");
  else if (reach === "missing")
    errs.push(`${join(REPO_ROOT, ".claude/settings.json")} does not exist — re-run install.mjs; the deny-list on git push / reset --hard is not installed`);
  else if (reach === "not-loaded")
    errs.push(
      `.claude/settings.json lives in ${REPO_ROOT} but the CLI is running in ${process.cwd()} — the CLI only walks UP, so it is not loaded and the deny-list on git push / reset --hard is gone.\n` +
        `    Open the CLI in ${REPO_ROOT}, or symlink .claude up (README "Trường hợp B").`,
    );
  // Present and loaded still says nothing about armed.
  if (reach === "ok")
    for (const gap of denyGaps(readFileSync(join(REPO_ROOT, ".claude/settings.json"), "utf8"))) errs.push(gap);

  // .mcp.json: a placeholder URL kills the CLI at startup, and a credential in
  // there is committed. Neither shows up until it is expensive.
  {
    const mcpPath = join(REPO_ROOT, ".mcp.json");
    if (isSourceRepo) {
      /* the source repo ships the template; it never runs against a tracker */
    } else if (!existsSync(mcpPath))
      warns.push(".mcp.json missing — no tracker MCP means Gate 1 has no source of AC (README \"MCP server\")");
    else {
      const g = mcpGaps(readFileSync(mcpPath, "utf8"));
      errs.push(...g.errors);
      warns.push(...g.warnings);
    }
  }

  // Config coherence: run the real thing, don't reimplement it.
  {
    const r = spawnSync(process.execPath, [fileURLToPath(import.meta.url), "--self-check", "--config", CONFIG_PATH], {
      encoding: "utf8",
    });
    if (r.status !== 0)
      errs.push(`--self-check failed — every gate below it silently no-ops:\n    ${(r.stderr || r.stdout).trim().split("\n")[0]}`);
  }

  // Legacy mode is legal, but it is the one setting that turns every evidence
  // gate back into honour-system. Silence here is how a team runs 40 tasks
  // believing Gate 4 checked something.
  if (EVIDENCE_MODE !== "attested")
    warns.push(
      'evidenceMode="legacy" — Gate 4/5 accept hand-pasted evidence, so an agent that ran nothing passes by typing "Tests: 12 passed".\n' +
        "    Switch ProjectRules §7 to `node scripts/run-evidence.mjs -- <cmd>` and set evidenceMode=\"attested\".",
    );

  // Which kernel is this? Without the stamp, "this gate used to let it through"
  // is unanswerable and there is nothing to roll back to.
  {
    const stamp = join(REPO_ROOT, "docs/.kernel-version");
    if (isSourceRepo) {
      /* the source repo IS the kernel; nothing to stamp */
    } else if (!existsSync(stamp))
      warns.push("docs/.kernel-version missing — installed before stamping, or hand-copied. Re-run the installer so upgrades are traceable");
    else if (!QUIET) console.log(`ℹ kernel ${readFileSync(stamp, "utf8").split("\n")[0].trim()}`);
  }

  if (!existsSync(TASKS_DIR)) errs.push(`tasksDir "${CFG.tasksDir}" does not exist (resolved: ${TASKS_DIR})`);
  for (const r of REPOS)
    if (!existsSync(resolve(REPO_ROOT, r.path)))
      errs.push(`repos[].path "${r.path}" does not resolve (tried ${resolve(REPO_ROOT, r.path)}) — agents cannot reach that repo`);

  // Optional layers: the README is explicit that both are optional, so these
  // stay warnings. They still cost you the gate that runs without being asked.
  const gitDir = findUpward(".git", REPO_ROOT);
  if (!gitDir) warns.push("not a git repo — no pre-commit hook, no CI, no history for task docs (README \"Có cần git init\")");
  else {
    const hookPath = spawnSync("git", ["rev-parse", "--git-path", "hooks/pre-commit"], { cwd: REPO_ROOT, encoding: "utf8" });
    const hook = hookPath.status === 0 ? resolve(REPO_ROOT, hookPath.stdout.trim()) : null;
    if (!hook || !existsSync(hook)) warns.push("no pre-commit hook — gates only run in CI, you find out later");

    // CI is not optional, and calling it optional is how the gate ends up
    // running nowhere. The hook is deliberately --staged, so it cannot see a
    // broken task this commit does not touch, and `--no-verify` bypasses it
    // entirely. CI is the backstop both of those rely on; with no CI the
    // designed hole has nothing behind it.
    const wfDir = join(REPO_ROOT, ".github/workflows");
    const runsValidator =
      existsSync(wfDir) &&
      readdirSync(wfDir)
        .filter((f) => /\.ya?ml$/.test(f))
        .some((f) => readFileSync(join(wfDir, f), "utf8").includes("validate-tasks.mjs"));
    if (!runsValidator)
      errs.push(
        "no CI workflow runs validate-tasks.mjs — the pre-commit hook is --staged (blind to tasks this commit does not touch) and `--no-verify` skips it, so CI is the only gate left.\n" +
          "    Install it: cp adapters/ci/validate-tasks.yml .github/workflows/  (or re-run the installer)",
      );
  }

  if (AS_JSON) console.log(JSON.stringify({ errors: errs, warnings: warns }, null, 2));
  else {
    for (const w of warns) console.log(`⚠ ${w}`);
    for (const e of errs) console.error(`✖ ${e}`);
    console.log(errs.length ? `\n✖ preflight: ${errs.length} error(s) — fix before the first task` : "✅ preflight passed");
  }
  process.exit(errs.length ? 1 : 0);
}

// ---------------------------------------------------------------------------
// --calibrate: read closed tasks and report where the estimate was wrong.
//
// The vector (§5.1) is a guess made before the work; `attempts` and `outcome`
// are what happened. This compares them. It prints evidence, never edits the
// thresholds: a rule the harness silently rewrote is a rule nobody reviewed.
// ---------------------------------------------------------------------------
// A task shipped under the harness must leave ground truth behind; one that
// predates it cannot be expected to. Same since-cutoff as the AC trace.
function outcomeIsBlocking(data, since = AC_TRACE_SINCE) {
  return (data.createdAt ?? "") >= since;
}

function calibrate(tasks) {
  const closed = tasks.filter((t) => t.outcome?.closedAt);
  // Coverage: shipped tasks are the denominator, tasks with an outcome are the
  // numerator. Findings below are computed only over the numerator, so a low
  // ratio means they describe a biased slice — and someone is about to rewrite
  // the §5.1.1 thresholds using it.
  const shipped = tasks.filter((t) => t.status === "done").length;
  const coverage = { shipped, withOutcome: closed.length };
  // A split is the loudest possible statement that bootstrap under-scored the
  // task: the gate bounced it until someone gave up and cut it in two.
  const splits = tasks.filter((t) => t.status === "split").length;
  if (!closed.length)
    return { tasks: 0, coverage, splits, note: "no task has outcome.closedAt yet — nothing to learn from" };

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

  if (shipped && closed.length / shipped < 0.8)
    findings.unshift(
      `outcome coverage ${closed.length}/${shipped} shipped tasks (<80%) — the findings below rest on a holed sample; fill outcome before retuning any threshold`,
    );

  if (splits)
    findings.push(
      `${splits} task(s) ended in status=split — each one exhausted the retry budget before being cut up; that is "scope" scored too low at bootstrap (§5.1.1)`,
    );

  return { tasks: closed.length, coverage, splits, byLabel, retriesByStage, findings };
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

// "docs/tasks/sprint-1/ABC-1-x", "sprint-1/ABC-1-x", "./docs/tasks/sprint-1/ABC-1-x/"
// → "sprint-1/ABC-1-x". Hai segment cuối là khoá; mọi thứ trước đó là tasksDir.
function taskKeyOf(arg) {
  const parts = arg.split(/[/\\]/).filter((x) => x && x !== ".");
  return parts.slice(-2).join("/");
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
const ONLY = TASK_ARG ? new Set([taskKeyOf(TASK_ARG)]) : STAGED ? stagedTaskFolders() : null;
const folders = findTaskFolders();

// Gõ sai đường dẫn --task thì không có folder nào khớp → "0 task, 0 error" →
// gate XANH. Một cổng im lặng cho qua vì không tìm thấy gì để kiểm là cổng
// tệ hơn không có cổng: nó báo an toàn. --staged khác hẳn, rỗng ở đó là hợp lệ
// (commit không đụng task nào).
if (TASK_ARG && !folders.length) {
  console.error(`✖ --task "${TASK_ARG}": không thấy task folder nào khớp "${taskKeyOf(TASK_ARG)}" trong ${rel(TASKS_DIR)}`);
  process.exit(2);
}
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

    // Was this task scored lighter at triage than at bootstrap? Warning, not
    // error: the honest reason (a quick Glob/Grep saw less than bootstrap did)
    // is common and legitimate -- §5.1.3 explicitly expects the vector to be
    // revised upward. What is worth surfacing is that the lower score is what
    // answered "does this need the harness at all".
    // Same since-cutoff as outcome/AC trace: tasks started under the harness owe
    // the evidence, tasks that predate it stay warnings.
    const sink = outcomeIsBlocking(data) ? errors : warnings;

    const drift = vectorDriftSince(
      triageVectorFor(join(TASKS_DIR, "_triage.log"), data.taskId),
      data.complexity.vector,
    );
    if (drift.raised.length)
      warnings.push(
        `vector scored higher at bootstrap than at triage (${drift.raised.join(", ")}) — the lower score is what decided whether this task needed the harness (§5.1.3)`,
      );
    // Lowering is the direction §5.1.3 forbids: it buys a lighter gate and a
    // cheaper tier. "Chỉ nâng, không hạ" — want it lower, go needs_clarification.
    if (drift.lowered.length)
      sink.push(
        `vector scored LOWER than at triage (${drift.lowered.join(", ")}) — §5.1.3 allows raising only; a lighter score buys a lighter gate and a cheaper tier. To lower it, go through needs_clarification`,
      );

    for (const d of vectorEvidenceDefects(data.complexity)) sink.push(d);
  } else if (STAGE_ORDER.indexOf(data.currentStage) > STAGE_ORDER.indexOf("bootstrap")) {
    // Omitting the block used to be cheaper than filling it in wrong: a missing
    // vector was a warning, and pre-commit runs --no-warn. So the whole §5.1
    // apparatus was opt-out by deletion. Same since-cutoff as everything else.
    (outcomeIsBlocking(data) ? errors : warnings).push(
      "complexity.vector missing — taskComplexity is an unchecked guess, and every downstream routing decision (gate weight, model tier, worktree) rests on it (Agents.md §5.1)",
    );
  }

  // 2c. Rework: a stage that ran more than twice means the gate kept bouncing it.
  // Not an error (sometimes the task is just hard) but it is the signal worth
  // reading when tuning prompts or splitting tasks.
  for (const [stage, n] of Object.entries(data.attempts ?? {}))
    if (n >= 3) warnings.push(`stage "${stage}" ran ${n}× — gate kept sending it back; worth a look`);

  // 2d. Context bleed: the /clear-between-stages rule, with something behind it.
  {
    const bleed = contextBleed(data.telemetry);
    if (bleed)
      warnings.push(
        `inputTokens grew monotonically across ${bleed.runs} dispatches (${bleed.from} ${bleed.first} → ${bleed.to} ${bleed.last}) — ` +
          `looks like context was not cleared between stages; each stage should read only its own artifacts (start-task.md "you are the COORDINATOR")`,
      );
  }

  // Retry budget with teeth. `attempts` is self-reported by the coordinator —
  // the very actor that loops — so cross-check it against the append-only
  // handoff blocks, and make an exhausted budget an ERROR, not a note. A task
  // that needed five runs of one stage is a task that should have been split.
  //
  // "Should have been split" needs a way to actually say so. status=split is the
  // named exit: the task is acknowledged as too big and has real children, so it
  // stays as history instead of reddening every commit that touches it. Split
  // with no children is a rename for giving up, so that stays an error.
  const splitAccepted = data.status === "split" && (data.splitInto ?? []).length >= 2;
  if (data.status === "split" && !splitAccepted)
    errors.push(
      `status=split requires splitInto with >=2 task IDs — a split with no children is just a rename for giving up (Agents.md §5.5)`,
    );
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
      // status=split is that advice taken. Keeping it an error would leave the
      // task wedged -- append-only docs mean the blocks cannot be removed, and a
      // gate whose only exit is --no-verify is a gate on its way out.
      (splitAccepted ? warnings : errors).push(
        `${role} ran ${runs}× (budget ${RETRY_BUDGET}) — ` +
          (splitAccepted
            ? `kept as history: this task was split into ${data.splitInto.join(", ")}`
            : `the gate keeps bouncing it; split the task or fix the spec instead of retrying (Agents.md §5.5)`),
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
  // append an update heading on resume (HarnessSetup §7.5) — so a whole-file cap
  // becomes unsatisfiable after two rounds: over the cap, and forbidden to trim.
  // Cap the newest block instead; that is the part the current role writes and
  // the only part it may lawfully shorten.
  for (const [f, cap] of Object.entries(LINE_CAPS)) {
    const fp = join(path, f);
    if (!existsSync(fp)) continue;
    const text = readFileSync(fp, "utf8");
    const updates = text.split(UPDATE_HEADING);
    if (updates.length > 1) {
      const newest = countLinesIn("## Update — " + updates[updates.length - 1]);
      if (newest > cap)
        errors.push(
          `${f}: newest update block is ${newest} lines, exceeds cap ${cap} (SharedRules §8)`,
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
  // truth to compare the estimate against. This used to be a warning, so
  // pre-commit (--no-warn) never blocked on it — and the learning loop could die
  // silently while every gate stayed green. Same since-cutoff as the AC trace:
  // tasks that predate the harness stay warnings, tasks started under it do not.
  if (data.status === "done" && !data.outcome?.closedAt)
    (outcomeIsBlocking(data) ? errors : warnings).push(
      "status=done but outcome.closedAt missing — --calibrate cannot learn from this task (Agents.md §5.6)",
    );

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
    if (existsSync(ev))
      for (const d of attestationDefects(readFileSync(ev, "utf8"), evName)) errors.push(d);
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
        const advText = readFileSync(adv, "utf8");
        for (const d of adversaryDefects(advText, evText))
          errors.push(`${GATE4_ARTIFACTS.adversarial}: ${d}`);
        // Gate 5 chạy LẠI lệnh, nên nó cũng phải đóng dấu — nếu không, adversary
        // vẫn bịa được output của chính nó và cả hai gate cùng mù.
        for (const d of attestationDefects(advText, GATE4_ARTIFACTS.adversarial)) errors.push(d);
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
    console.log(`   outcome coverage: ${c.coverage.withOutcome}/${c.coverage.shipped} shipped task(s)`);
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
