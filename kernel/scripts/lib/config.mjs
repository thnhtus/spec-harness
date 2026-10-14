// config.mjs — harness.config.json: load + derived constants (#118 split).
import { readFileSync, existsSync } from "node:fs";
import { join, dirname, resolve, parse as parsePath } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);

export const CONFIG_NAME = "harness.config.json";

export const explicitIdx = argv.indexOf("--config");
export const CONFIG_PATH =
  explicitIdx >= 0 && argv[explicitIdx + 1]
    ? resolve(argv[explicitIdx + 1])
    : findConfig(process.cwd()) ?? findConfig(join(HERE, "..", ".."));

// #118: a missing config is NOT fatal here. `--guard` / `--guard-role` run BEFORE config load on
// purpose: a hook that exits 2 because harness.config.json is missing blocks every shell command in
// the session. validate-tasks.mjs does the exit check right after those two, with the same message.
export const CONFIG_FOUND = !!CONFIG_PATH;

export let CFG = null;
if (CONFIG_PATH) {
  try {
    CFG = JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
  } catch (e) {
    console.error(`✖ ${CONFIG_PATH} is not valid JSON: ${e.message}`);
    process.exit(2);
  }
}
// Every constant below is derived from the config; with no config they take the shipped defaults,
// which is what the guard path sees (it reads none of them).
const C = CFG ?? {};



export const REPO_ROOT = CONFIG_PATH ? dirname(CONFIG_PATH) : process.cwd();

export const TASKS_DIR = join(REPO_ROOT, C.tasksDir ?? "docs/tasks");

export const SCHEMA_PATH = join(TASKS_DIR, "_templates", "task.agent.schema.json");


export const GROUP_PREFIX = C.groupPrefix ?? "sprint-";

export const GROUP_FIELD = C.groupField ?? "sprintNumber";

export const LINE_CAPS = C.lineCaps ?? {};

// Files whose size is driven by pasted machine output (test logs, adversary
// re-runs), not by prose the agent chooses to write. A hard cap there would put
// the agent between "paste the whole output" (Instructions §5, non-negotiable)
// and "stay under the cap" — and it would trim the evidence. Warn instead: a
// 400-line 08 usually means the task carries too many AC, which is worth seeing
// but is not something the implementer can fix by writing less.
export const LINE_WARN = C.lineWarn ?? {};

export const HANDOFF_BLOCK_CAP = C.handoffBlockCap ?? 30;

export const STAGE_ORDER = C.stages ?? [];

export const REQUIRED_AT_STAGE = C.requiredAtStage ?? [];

export const GATE4_DONE = new Set(C.gate4Statuses ?? []);

export const ROUTING = C.routing ?? { field: "branchType", map: {} };

export const GATE4_ARTIFACTS = C.gate4Artifacts ?? {};

export const REPOS = C.repos ?? [];

export const AC_TRACE = C.acTrace ?? { declaredIn: null, reachedIn: [], since: "9999-12-31" };

// reachedIn entries may be a bare filename (checked only once Gate 4 is reached,
// the old behaviour) or { doc, fromStage } — checked as soon as that stage is
// reached. The latter is why a dropped AC surfaces at Gate 3 instead of after
// the implementer already wrote code against an incomplete plan.
export const AC_REACHED = (AC_TRACE.reachedIn ?? []).map((e) =>
  typeof e === "string" ? { doc: e, fromStage: null } : e,
);

export const AC_TRACE_SINCE = AC_TRACE.since ?? "9999-12-31";

// S6: no default. A missing cutoff would silently turn every R5 error into a warning.
export const STAMP_SINCE = C.stampSince;

export const STAMP_LOG_NAME = "_stamp.log";

export const STAMP_LOG = join(TASKS_DIR, STAMP_LOG_NAME);

export const SLICE_BYTES = C.sliceBytes;

// Which stage each role owns, for cross-checking self-reported attempts against
// handoff blocks. Implementers share one stage (routing picks which runs).
export const ROLE_STAGE = C.roleStage ?? {};

// Commands that count as a real verification run (project test/lint/build stack).
export const EVIDENCE_RE = new RegExp(C.evidenceCommandPattern ?? "(?!)");


// ENUMs that live in MARKDOWN TABLES, not in task.agent.json.
//
// task.agent.json has had a schema from day one: `status: "chưa xong"` is
// rejected outright. The doc tables never had one -- their legal values existed
// only as prose in a column header (FSDReviewer §3) and were RETYPED by hand
// into a regex here. Two copies, nothing forcing them to agree, so they drifted:
// the template shipped `clarification / contradiction` as the Question Type for
// a long time, all-English, and Gate 2 could never match it. An agent filling
// the template in correctly still got a gate that saw nothing.
//
// That is the structural crack, and docLanguage merely made it easy to hit. So
// the list lives in config now, exactly like the schema's: the validator reads
// it, the template is checked against it, and prose that contradicts it is an
// error. One source of truth, or it drifts again.
export const DOC_ENUMS = C.docEnums ?? {};

export const enumAlt = (vals) => (vals ?? []).map((v) => v.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");

// Longest-first so `non-blocking` is not shadowed by `blocking`; the lookbehind
// keeps `non-blocking` from being read as a bare `blocking`.
export const enumRe = (vals) =>
  vals?.length ? new RegExp(`(?<![\\w-])(?:${enumAlt([...vals].sort((a, b) => b.length - a.length))})(?![\\w-])`, "i") : /(?!)/;


// Walk up from `start` looking for harness.config.json. The directory holding it
// is the project root: every path in the config is relative to that, so the
// validator runs identically from the repo root or from a worktree subdir.
export function findConfig(start) {
  let dir = resolve(start);
  for (;;) {
    const candidate = join(dir, CONFIG_NAME);
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir || dir === parsePath(dir).root) return null;
    dir = parent;
  }
}

export const needSliceBytes = (who) => {
  if (Number.isInteger(SLICE_BYTES) && SLICE_BYTES >= 1) return;
  console.error(`✖ ${who}: config.sliceBytes (integer ≥ 1) is required — the bytes of existing files in 03 above which implementation must be split into slices${C.sliceFiles !== undefined ? " (config.sliceFiles was replaced by sliceBytes in #73 — rename it; 64000 is the shipped value, measured in #76)" : ""}`);
  process.exit(2);
};

export const needStampSince = (who) => {
  if (/^\d{4}-\d{2}-\d{2}$/.test(STAMP_SINCE ?? "")) return;
  console.error(`✖ ${who}: config.stampSince (YYYY-MM-DD) is required — tasks created from that date must have every telemetry window witnessed in _stamp.log`);
  process.exit(2);
};
