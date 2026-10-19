// config.mjs — harness.config.json: load + derived constants (#118 split).
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, parse as parsePath, resolve } from "node:path";
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

export let CFG = {};
if (CONFIG_PATH) {
  try {
    CFG = JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
  } catch (e) {
    console.error(`✖ ${CONFIG_PATH} is not valid JSON: ${e.message}`);
    process.exit(2);
  }
}
// Every constant below is derived from the config; with no config CFG is an empty object, so the
// shipped defaults apply — that is the state the guard path sees, and it reads none of them.
const C = CFG;



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
// ── self-check: moved here with the logic it tests ──────────────────
export async function selfCheck({ assert }) {
  const { handoffBlockCount } = await import("./docs.mjs");
  const { trackerConfigError, gitPushConfigError } = await import("./wiring.mjs");
  assert.equal(gitPushConfigError(CFG.git), null, `this repo's own git config is invalid: ${gitPushConfigError(CFG.git)}`);
  {
    const { mkdtempSync, writeFileSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const d = mkdtempSync(join(tmpdir(), "sh-rb-"));
    assert.equal(handoffBlockCount(d, "nope"), 0, "no file = never ran");
    writeFileSync(join(d, "r.md"), "### a\nx\n### b\ny\n### c\nz\n");
    assert.equal(handoffBlockCount(d, "r"), 3, "counts append-only blocks");
    rmSync(d, { recursive: true, force: true });
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
  // (predicate defined at module scope; see trackerConfigError)
  // Tracker write-back. The PM does not read task.agent.json, they read the
  // board -- so a task that reaches `reviewing` while the ticket sits untouched
  // means two sources of truth disagree from week one.
  //
  // The kernel does NOT call a vendor API. ClickUp, Jira and Linear share no
  // status model and no auth, and a client here would be untestable code that
  // only the maintainer's tracker exercises. The coordinator asks the `tracker`
  // MCP server instead: whatever the team already authenticated is what writes.
  //
  // Default `off`, because a harness that silently mutates a ticket on first
  // install is worse than one that does nothing.
  // Checked through the exported predicate, not inline against CFG: an inline
  // assert can only ever see the config this repo happens to ship, so it proves
  // nothing about the config a project will write, and deleting it leaves no
  // trace. The predicate can be fed junk.
  for (const [tracker, want] of [
    [undefined, null],
    [{}, null],
    [{ writeBack: "off" }, null],
    [{ writeBack: "comment" }, null],
    [{ writeBack: "status", statusOnReview: "Ready for QC" }, null],
    [{ writeBack: "yes-please" }, /must be "off", "comment" or "status"/],
    [{ writeBack: "Status" }, /must be "off"/],            // enum is case-sensitive
    [{ writeBack: true }, /must be "off"/],
    // Enabled and pointed at nothing: reads as on in review, moves no ticket.
    // This is the exact failure this file exists to prevent, so it is the one
    // case worth spelling out three ways.
    [{ writeBack: "status" }, /needs tracker.statusOnReview/],
    [{ writeBack: "status", statusOnReview: "" }, /needs tracker.statusOnReview/],
    [{ writeBack: "status", statusOnReview: "   " }, /needs tracker.statusOnReview/],
  ]) {
    const got = trackerConfigError(tracker);
    if (want === null) assert.equal(got, null, `tracker ${JSON.stringify(tracker)} should be accepted, got: ${got}`);
    else assert.ok(got && want.test(got), `tracker ${JSON.stringify(tracker)} should be rejected by ${want}, got: ${got}`);
  }
  assert.equal(trackerConfigError(CFG.tracker), null, `this repo's own tracker config is invalid: ${trackerConfigError(CFG.tracker)}`);

  // repos: where the CODE lives, relative to the config root. One entry with
  // path "." means harness and code share a repo; several entries mean the
  // harness sits above them (workspace layout) and task docs are NOT inside
  // the repo being edited — which changes how worktrees work (Agents.md §0).
  // models: tier -> whatever the host CLI calls it. The kernel never names a
  // vendor model; a Codex/Gemini user maps the same three tiers to their own.
  // Empty object is legal: it means "let the harness use its default".
}

