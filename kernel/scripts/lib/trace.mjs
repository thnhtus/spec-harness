import { CFG, STAGE_ORDER } from "./config.mjs";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { hasRealEvidenceIn } from "./evidence.mjs";
// Gate 1, with something behind it. Until now Gate 1 checked only that
// 01-FSD.md EXISTS and fits the line cap -- everything the gate actually claims
// (the IEEE skeleton, requirements written as requirements, each traced to a
// source) was the coordinator reading its own output and grading it. Stripping
// every `shall` and deleting §4 outright both passed silently, and the
// emptiness surfaced only at Gate 3, after the planner had worked from it.
//
// The rules below are the template's own "Gate 1 — checklist", verbatim. Prose
// that no check reads is the drift shape docEnums exists to end.
export const FSD_SECTIONS = ["Introduction", "Overall Description", "External Interface", "Functional Requirements"];


// Template scaffolding, never a real AC: "AC-ID" is the table header and
// "AC-nn" is the unfilled placeholder. Templates must use these so an untouched
// copy cannot satisfy the traceability check by accident.
export const AC_PLACEHOLDERS = new Set(["AC-ID", "AC-nn", "AC-NN"]);


export function gate1Defects(text, { modal = CFG.fsdModal } = {}) {
  // Fail closed: no configured modal would silently delete the wording rule.
  if (!Array.isArray(modal) || !modal.length)
    throw new Error("config.fsdModal is required (Gate 1 cannot check requirement wording without it)");
  const out = [];
  // Documentation inside the artifact must not satisfy the check that reads it:
  // the template's instruction blockquote names every section and shows a
  // sample requirement row. Both regexes below anchor at `^`, so a quoted line
  // ("> ## 4. ..." / "> | FSD-...") matches neither -- an explicit blockquote
  // filter was tried here and mutation-testing proved it changed no input.
  const body = text;

  const missing = FSD_SECTIONS.filter((s) => !new RegExp(String.raw`^#{1,3}\s*\d*\.?\s*` + s, "mi").test(body));
  if (missing.length)
    out.push(`01-FSD.md is missing IEEE section(s): ${missing.join(", ")} — Gate 1 requires the skeleton (Agents.md §3)`);

  // A requirement row is "| FSD-... | text | source | status |". The template's
  // own sample row has an EMPTY requirement cell and a `<MOD>` placeholder id,
  // so an untouched file must not count as having a requirement -- that is the
  // exact false green being closed here.
  const rows = body
    .split("\n")
    .map((l) => /^\|\s*(FSD-[A-Za-z0-9<>_-]+-\d+)\s*\|(.*)$/.exec(l))
    .filter(Boolean)
    .map((m) => ({ id: m[1], cells: m[2].split(/(?<!\\)\|/).map((c) => c.trim()) }))
    .filter((r) => !r.id.includes("<"));
  const esc1 = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // Unicode-aware boundaries: \b would not fire on "phải" in most positions.
  const modalRe = new RegExp(`(?:^|[^\\p{L}])(?:${modal.map(esc1).join("|")})(?:[^\\p{L}]|$)`, "iu");
  const written = rows.filter((r) => modalRe.test(r.cells[0] ?? ""));
  if (!written.length)
    out.push(
      `01-FSD.md has no functional requirement written with ${modal.map((m) => `"${m}"`).join(" / ")} (config.fsdModal) — ` +
        "a table of IDs with no requirement text is not a specification (Gate 1 checklist)",
    );

  // A requirement with no Source is where the AC chain starts from nothing.
  const sourceless = written.filter((r) => !(r.cells[1] ?? "").replace(/[`….\s]/g, "").length);
  if (sourceless.length)
    out.push(
      `01-FSD.md requirement(s) with no Source: ${sourceless.map((r) => r.id).join(", ")} — ` +
        "an untraceable requirement is where the AC chain breaks (Gate 1 checklist)",
    );
  return out;
}


// --route: what a pasted tracker link should lead to. The decision is here, not
// in the shell hook, because it reads config, matches a regex and compares task
// state -- three things bash gets wrong quietly. The hook is a thin shell that
// prints whatever this says.
//
// It ADVISES, it does not act: the CLI hook injects one line of context and the
// model decides. There is no tool called "start working on a task", so there is
// nothing to deny -- a PreToolUse gate cannot express this.
// ponytail: advisory only. Upgrade path: if a task is ever started twice in
// practice, move the duplicate check into /start-task step 1 as a hard error.
export function routeForUrl(url, tasks, { urlPattern = CFG.tracker?.urlPattern } = {}) {
  // Fail closed: no pattern means every prompt would look like a task link.
  if (!urlPattern) throw new Error("config.tracker.urlPattern is required (--route cannot recognise a task link without it)");
  if (!new RegExp(urlPattern).test(url ?? "")) return { action: "ignore" };

  const hit = tasks.find((t) => t.trackerUrl === url);
  if (!hit) return { action: "start", url };
  // Already finished: re-running would append a second lifecycle to append-only
  // docs, which is unrecoverable. Worth a louder line than "start".
  if (["done", "mr_created", "reviewing"].includes(hit.status))
    return { action: "done", url, task: hit.taskId, stage: hit.currentStage, status: hit.status, docsPath: hit.docsPath };
  // The case this whole flag exists for: a session died mid-task. The lease TTL
  // detects a dead session but nothing surfaced the abandoned task itself.
  return { action: "resume", url, task: hit.taskId, stage: hit.currentStage, status: hit.status, docsPath: hit.docsPath };
}


// One line of context for the CLI to inject. Kept next to the decision so the
// two cannot drift.
export function routeMessage(r) {
  if (r.action === "ignore") return "";
  if (r.action === "start") return `spec-harness: ${r.url} is a tracker task with no task folder yet — run \`/start-task ${r.url}\` rather than editing code directly.`;
  if (r.action === "resume")
    return `spec-harness: ${r.url} is already task ${r.task} at stage "${r.stage}" (status ${r.status}) in ${r.docsPath} — resume it, do NOT create a second task folder.`;
  return `spec-harness: ${r.url} is task ${r.task}, already ${r.status} (${r.docsPath}) — do not re-run the harness on it; the docs are append-only.`;
}


// Which stages must hold up against Gate 1. `>=`, not `>`: fsd_review is the
// FIRST stage that READS 01-FSD.md, so exempting it would let an empty FSD reach
// the reviewer -- which is the whole failure Gate 1 exists to stop. Same shape
// as the bootstrap/vector exemption fixed in 986e9bd.
export function gate1IsOwed(currentStage, stageOrder = STAGE_ORDER) {
  const i = stageOrder.indexOf(currentStage);
  return i >= 0 && i >= stageOrder.indexOf("fsd_review");
}


// #156: 08 is Gate 4's artifact and `adversarial_review` is the first stage that
// READS it. Validating it only at `status=reviewing` meant postcite #151 carried
// two attestation blocks whose outputHash never verified from round 1 all the way
// to the end of the pipeline -- and the defect surfaced at the one transition that
// cannot dispatch a fixing role. Checked from the stage that consumes it instead.
export function gate4EvidenceOwed(currentStage, stageOrder = STAGE_ORDER) {
  const i = stageOrder.indexOf(currentStage);
  return i >= 0 && i >= stageOrder.indexOf("adversarial_review");
}


// Which stages owe a complexity vector. `bootstrap` is INCLUDED: it is the stage
// that writes the vector, and excluding it left "delete the block" silent at
// exactly the moment it happens -- every later stage then inherits a task whose
// routing (gate weight, model tier, worktree) was never checked. Found by running
// the real validator on a real task folder, not by reading the code.
export function vectorIsOwed(currentStage, stageOrder = STAGE_ORDER) {
  return stageOrder.indexOf(currentStage) >= stageOrder.indexOf("bootstrap");
}


// AC ids declared in the review doc's AC table: rows starting "| AC-xx |".
// Restricted to leading table cells so prose mentions elsewhere don't count.
export function declaredACsIn(text) {
  const ids = new Set();
  for (const line of text.split("\n")) {
    const m = /^\|\s*(AC-[A-Za-z0-9]+)\s*\|/.exec(line);
    if (m && !AC_PLACEHOLDERS.has(m[1])) ids.add(m[1]);
  }
  return [...ids];
}


// An AC is "reached" only when its id appears in a TABLE ROW. Matching anywhere
// in the text was asymmetric with declaredACsIn (which is strict): "AC-01 to be
// done later" in prose, or an HTML comment, used to satisfy the trace.
//
// cell:"first" (#56): the AC must OPEN a row, like declaredACsIn. Without it an
// AC listed in 08's "Covers AC" column satisfied the trace while its own row
// in the AC coverage table -- the one naming the test -- was gone.
export function acsMissingIn(text, acs, cell) {
  const rows = text.split("\n").filter((l) => l.trimStart().startsWith("|"));
  if (cell === "first") {
    const first = new Set(rows.map((l) => /^\s*\|\s*([^|]*?)\s*\|/.exec(l)?.[1]));
    return acs.filter((a) => !first.has(a));
  }
  const joined = rows.join("\n");
  return acs.filter((a) => !new RegExp(`\\b${a}\\b`).test(joined));
}


// #107: an AC that NAMES a value ("`t = 100` → 90") is only guarded if some test
// asserts that value. Reachable ≠ asserted: the 12-case held-out run lost
// boundary / threshold / rounding bugs to green tests that never used the number.
// Literals = numbers in the AC cell (backticks or prose, "vd 99.99" counts); tests = the file part of
// `path::name` cells of 08's AC coverage table.
// STAYS A WARNING. Measured on a real 7-stage run (#108 e2e): of 3 flags on a
// correct task, 2 were false — the ACs spelled out a derivation ("giảm 10% → 90,
// thuế 8% → 97.20") and the test rightly asserted only the final "$97.20". An
// intermediate step reads exactly like a boundary, so this cannot be an error
// without a way to tell them apart. A 3rd real run confirmed it from the other
// side: "t = 100 → 90" (input → expected, BOTH must be tested) and "giảm 10% → 90"
// (a step on the way to the real answer) are the same syntax, so an arrow cannot
// be classified without understanding the sentence. ponytail: ceiling = derivation steps and
// units ("within 3 s") are indistinguishable from boundaries here, and a test
// may build the value indirectly (`1e2`, a constant). Quoted strings in an AC
// ARE checked (same rule, plain substring); booleans, enum members and "sorted
// descending"-style ACs have no literal to anchor on and are NOT covered.
export function acValueGaps(reviewText, evidenceText, readTest) {
  const cellsOf = (l) => l.split("|").slice(1, -1).map((c) => c.trim());
  const lit = new Map();
  for (const l of reviewText.split("\n")) {
    const m = /^\|\s*(AC-[A-Za-z0-9]+)\s*\|/.exec(l);
    if (!m || AC_PLACEHOLDERS.has(m[1])) continue;
    const cells = cellsOf(l);
    // An arithmetic operand (`t * 0.9`) is a formula constant, not a value to feed in.
    const cell = cells[1] ?? "";
    // Quoted literals the AC names: "error: invalid", 'N/A'. Found INSIDE each
    // backtick span (non-greedy so `f("")` does not bridge into the next span),
    // only a double/single-quoted string within it, not the call around it.
    // Booleans and enum members are NOT covered (see ceiling).
    const strs = [...cell.matchAll(/`([^`]*?)`/g)]
      .flatMap((b) => [...b[1].matchAll(/(["'])((?:\\.|(?!\1)[^\\])+)\1/g)])
      .map((m) => m[2]).filter((x) => x.length >= 3);
    const nums = [...cell.matchAll(/(?<![\w.])-?\d+(?:\.\d+)?(?![\w.])/g)]
      // "8%" is a rate; "90 × 1.08" is a derivation (× binds both sides, unlike
      // >=/< where the number right after is the boundary itself, not an
      // operand). Only *, /, % next to a number are stripped as formula noise.
      // A strict bound (`< 0`, `> 5`) is OPEN: no value sits at it, the honest
      // test feeds one past it (-1). `>= 100` / `<= 5` is closed, 100 itself
      // is in range and must be tested — that is the boundary bug (#107).
      .filter((n) => !/(?:[*/×]|[<>](?!=))\s*$/.test(cell.slice(0, n.index)) && !/^\s*[*/%×]/.test(cell.slice(n.index + n[0].length)))
      .map((n) => n[0]);
    if (nums.length || strs.length) lit.set(m[1], [...new Set([...nums, ...strs])]);
  }
  const files = new Map();
  for (const l of evidenceText.split("\n")) {
    const c = cellsOf(l);
    const id = /^AC-[A-Za-z0-9]+$/.exec(c[0] ?? "")?.[0];
    const f = /`([^`:]+)::/.exec(c[1] ?? "")?.[1];
    if (id && f) files.set(id, [...(files.get(id) ?? []), f]);
  }
  const out = [];
  for (const [id, nums] of lit) {
    const fs = files.get(id);
    if (!fs) continue; // no resolvable test file: the traceability rules above already speak
    // Test names and comments say "at 100" without testing it: only code AND
    // string literals count — a value the AC names can legitimately be the
    // expected OUTPUT ("$97.20"), not just an input, so stripping strings
    // whole (as comments must be) would blind this to every string-returning
    // function. Only block comments and // comments are stripped.
    // Test NAMES are stripped too: "AC-06 at 250 gets 10% off" names values it
    // may never assert (measured: the #108 e2e run hid a missing 10 this way).
    const body = fs.map(readTest).filter((x) => x != null).join("\n")
      .replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "")
      .replace(/\b(test|it|describe)(\.\w+)?\(\s*(["'`])(?:\\.|(?!\3)[^\\\n])*\3/g, "$1(");
    if (!body) continue; // unreadable here (other repo / CI checkout): stay silent
    const miss = nums.filter((n) => /^-?\d+(\.\d+)?$/.test(n)
      ? !new RegExp(`(?<![\\w.])${n.replace(".", "\\.")}(?![\\w])`).test(body)
      : !body.includes(n));
    if (miss.length) out.push(`${id} names value(s) ${miss.join(", ")} but ${fs.join(", ")} never uses them — a green test that skips the boundary the AC states (#107)`);
  }
  return out;
}


// --- path wrappers (missing file = nothing reached) -------------------------

export const hasRealEvidence = (f) => existsSync(f) && hasRealEvidenceIn(readFileSync(f, "utf8"));

export const declaredACs = (f) => (existsSync(f) ? declaredACsIn(readFileSync(f, "utf8")) : []);

export const acsMissingFrom = (f, acs, cell) =>
  existsSync(f) ? acsMissingIn(readFileSync(f, "utf8"), acs, cell) : acs;

// ── self-check: moved here with the logic it tests ──────────────────
export async function selfCheck({ assert }) {
  const { GATE4_ARTIFACTS, TASKS_DIR } = await import("./config.mjs");
  const { notesDefects } = await import("./docs.mjs");
  const { adversaryCoverageDefects, evidenceTableDefects } = await import("./gate5.mjs");
  const { adapterGaps } = await import("./wiring.mjs");
  const sample = CFG.evidenceSampleCommand;
  {
    const rev = "| AC-01 | `discount(t)` trả `t * 0.9` khi `t >= 100` — kể cả `t = 100` → 90 | x | confirmed | TC-01 |\n| AC-02 | works for users | x | confirmed | TC-02 |\n| AC-nn | `5` | x | | |";
    const ev = "| AC-01 | `test/a.js::AC-01 x` | PASS |\n| AC-02 | `test/a.js::AC-02 y` | PASS |";
    assert.equal(acValueGaps(rev, ev, () => "assert.equal(discount(250), 225)").length, 1, "AC names 100, test only uses 250 → gap");
    assert.match(acValueGaps(rev, ev, () => "discount(250)")[0], /AC-01 names value\(s\) 100, 90 /, "formula operand 0.9 is not a value, but the boundary 100 and its result 90 are");
    assert.match(acValueGaps(rev, ev, () => 'test("AC-01 at 100", () => assert.equal(discount(250), 90)); // 100')[0] ?? "", /names value\(s\) 100 /, "100 in a test name or comment is not a test of 100");
    assert.deepEqual(acValueGaps("| AC-04 | tax 8% → `f(50)` = 54 | x | confirmed | TC |", "| AC-04 | `t.js::a` | PASS |", () => "assert.equal(f(50), 54)"), [], "a rate (8%) is not a value to feed in");
    assert.deepEqual(acValueGaps("| AC-06 | `f(100)` trả `\"$97.20\"` (90 × 1.08) | x | confirmed | TC |", "| AC-06 | `t.js::a` | PASS |", () => 'assert.equal(f(100), "$97.20")'), [], "a derivation (90 × 1.08) is not a boundary (3rd real run)");
    assert.deepEqual(acValueGaps("| AC-03 | ném lỗi khi `total < 0` | x | confirmed | TC |", "| AC-03 | `t.js::a` | PASS |", () => "assert.throws(() => f(-1))"), [], "the 0 of `< 0` is a threshold, -1 is its honest test");
    assert.match(acValueGaps("| AC-01 | `t >= 100` → giảm | x | confirmed | TC |", "| AC-01 | `t.js::a` | PASS |", () => "f(250)")[0] ?? "", /100/, "…but a >= boundary still has a value AT it, so 100 stays required");
    assert.deepEqual(acValueGaps(rev, ev, () => "discount(100) === 90"), [], "values present → silent");
    assert.deepEqual(acValueGaps(rev, ev, () => "discount(1000)").map((x) => x.slice(0, 5)), ["AC-01"], "100 must not be satisfied by 1000");
    assert.deepEqual(acValueGaps(rev, ev, () => null), [], "test file unreadable here → silent, never a false alarm");
    assert.deepEqual(acValueGaps(rev, ev, () => 'assert.equal(f(100), "$90.00")'), [], "a value inside a string literal (an expected OUTPUT, not a comment) still counts (#108 e2e: AC-04..06 are currency strings)");
    {
      const sRev = '| AC-01 | `f("")` trả `"error: invalid"` | x | confirmed | TC |';
      assert.deepEqual(acValueGaps(sRev, ev, () => 'assert.equal(f(""), "error: invalid")'), [], "quoted string the AC names is asserted → silent");
      assert.match(acValueGaps(sRev, ev, () => 'assert.equal(f(""), "wrong")')[0] ?? "", /error: invalid/, "quoted string the AC names, never asserted → named");
      assert.deepEqual(acValueGaps("| AC-01 | trả `true` khi đã đăng nhập | x | confirmed | TC |", ev, () => "false"), [], "booleans are the documented ceiling, not a silent false positive");
    }
    assert.deepEqual(acValueGaps(rev, "| AC-01 | manual | PASS |", () => "x"), [], "no test file in 08 → other rules speak");
  }
  assert.deepEqual(acsMissingIn("Note: AC-01 to be done later", ["AC-01"]), ["AC-01"], "prose is not coverage");
  assert.deepEqual(acsMissingIn("<!-- TODO AC-01 -->", ["AC-01"]), ["AC-01"], "a comment is not coverage");

  {
    const t = (n) => { const f = join(TASKS_DIR, "_templates", n); return existsSync(f) ? readFileSync(f, "utf8") : null; };
    const n06 = t(GATE4_ARTIFACTS.notes ?? ""), e08 = t(GATE4_ARTIFACTS.evidence ?? ""), a09 = t(GATE4_ARTIFACTS.adversarial ?? "");
    if (n06) {
      assert.equal(notesDefects(n06).length, 1, "06 template's `src/…` row is not a changed file");
      assert.deepEqual(notesDefects(n06.replace("| `src/…` | added / modified | … | AC-… |", "| `src/a.js` | modified | fix | AC-01 |")), [], "one real changed-file row passes");
    }
    if (e08) {
      assert.equal(evidenceTableDefects(e08).length, 1, "08 template's `<scoped unit command>` is not a command");
      assert.deepEqual(evidenceTableDefects(e08.replace("`<scoped unit command>`", `\`${sample}\``)), [], "a real §7 command row passes");
    }
    if (a09) {
      assert.ok(adversaryCoverageDefects(a09, ["AC-01"]).some((x) => x.includes("AC-01")), "09 template has no row for a declared AC");
      assert.ok(adversaryCoverageDefects(a09, []).some((x) => x.includes("What was inspected")), "09 template's `- …` is not an inspection");
      const filled = a09.replace("| AC-nn |  | yes / no | yes / no / not tried | met / not met |", "| AC-01 | t::x | yes | yes | met |").replace(/(## What was inspected[\s\S]*?)\n- …/, "$1\n- src/a.js");
      assert.deepEqual(adversaryCoverageDefects(filled, ["AC-01"]), [], "09 with every AC row + an inspected path passes");
      assert.ok(adversaryCoverageDefects(filled, ["AC-01", "AC-02"]).some((x) => x.includes("AC-02")), "an AC missing from 09 is named");
      assert.deepEqual(adversaryCoverageDefects(filled.replace("| AC-01 |", "| AC-01, AC-02 |"), ["AC-01", "AC-02"]), [], "one row naming two ACs covers both");
      const appended = a09 + "\n## Update — round 2\n\n## AC — does the test actually assert it\n\n| AC | t | a | m | v |\n| --- | --- | --- | --- | --- |\n| AC-01 | t::x | yes | yes | met |\n\n## What was inspected\n\n- src/a.js\n";
      assert.deepEqual(adversaryCoverageDefects(appended, ["AC-01"]), [], "append-only: the table in a later round counts, the untouched top template does not hide it");
      assert.deepEqual(notesDefects(n06 + "\n## Update — r2\n\n### Changed files\n\n| f | t | r | a |\n| --- | --- | --- | --- |\n| `src/a.js` | modified | fix | AC-01 |\n"), [], "append-only 06: a later ### Changed files counts");
      assert.deepEqual(evidenceTableDefects(e08 + `\n## Update — r2\n\nprose\n\n| Verification Type | Command / Action | Covers AC |\n| --- | --- | --- |\n| Unit | \`${sample}\` | AC-01 |\n`), [], "append-only 08: a headless table with the template's header counts");
      assert.equal(evidenceTableDefects(e08 + "\n## Update — r2\n\n| Other | Thing |\n| --- | --- |\n| x | `npm test` |\n").length, 1, "an unrelated table does not count as Command output");
    }
  }
  // #85: unfilled adapter.
  assert.ok(adapterGaps("x\n<!-- NOT-FILLED-IN: y -->", { repos: [] }).errors.length === 1, "NOT-FILLED-IN is an error");
  {
    const P = "^https://app\\.clickup\\.com/t/.+";
    const U = "https://app.clickup.com/t/abc123";
    const t = (o) => ({ taskId: "ABC-1", trackerUrl: U, currentStage: "technical_plan", status: "in_progress", docsPath: "docs/tasks/sprint-1/ABC-1-x", ...o });
    const r = (url, tasks) => routeForUrl(url, tasks, { urlPattern: P });

    assert.equal(r("just a question", []).action, "ignore", "ordinary prompts must not look like task links");
    assert.equal(r("https://example.com/t/1", []).action, "ignore", "another host is not this tracker");
    assert.equal(r(U, []).action, "start", "a known link with no folder starts the harness");
    // The case the flag exists for: a session died mid-task.
    assert.equal(r(U, [t()]).action, "resume", "an unfinished task is resumed, not restarted");
    for (const s of ["reviewing", "mr_created", "done"])
      assert.equal(r(U, [t({ status: s })]).action, "done", `status=${s} must not re-run the harness`);
    // Another task's URL must not match this one.
    assert.equal(r(U, [t({ trackerUrl: U + "9" })]).action, "start", "matching is exact, not prefix");
    // Fail closed: with no pattern every prompt would be a task link.
    assert.throws(() => routeForUrl(U, [], { urlPattern: null }), /urlPattern is required/, "a missing urlPattern cannot silently match nothing");

    // The message is what the model actually reads, so the distinguishing word
    // has to be in it -- an identical string for resume and start would make the
    // whole branch pointless.
    assert.equal(routeMessage(r("hi", [])), "", "ignore prints nothing at all");
    assert.ok(routeMessage(r(U, [])).includes("/start-task"), "the start message names the command");
    assert.ok(routeMessage(r(U, [t()])).includes("do NOT create a second"), "the resume message warns against a second folder");
    assert.ok(routeMessage(r(U, [t()])).includes("technical_plan"), "the resume message says where the task got to");
    assert.ok(!routeMessage(r(U, [t({ status: "done" })])).includes("/start-task"), "a finished task must not be offered /start-task");
    // This repo must ship a pattern the flag can use.
    assert.ok(CFG.tracker?.urlPattern, "harness.config.json must declare tracker.urlPattern");
  }

  // gate1Defects: the four checklist lines the template printed for months while
  // nothing read them. The cases that matter are the false greens -- an
  // untouched template and a header-only file both used to pass.
  {
    const good = [
      "## 1. Introduction", "## 2. Overall Description", "## 3. External Interface Requirements",
      "## 4. Functional Requirements",
      "| FSD ID | Requirement | Source | Status |",
      "| FSD-ROS-001 | The system shall filter the roster by department | `FR-12` | confirmed |",
    ].join("\n");
    const g = (t, o) => gate1Defects(t, { modal: ["shall", "phải"], ...o });
    assert.deepEqual(g(good), [], "a real FSD is silent");

    // The regression: stripping the modal used to pass.
    assert.ok(g(good.replace("shall", "MUST")).some((d) => d.includes("no functional requirement")), "a row with no modal is not a requirement");
    // The other regression: deleting §4 entirely used to pass.
    assert.ok(g(good.replace("## 4. Functional Requirements", "")).some((d) => d.includes("Functional Requirements")), "a missing IEEE section is named");
    // 2, not 3: with no requirement at all there is no requirement to be
    // sourceless. The sourceless rule gets its own case below.
    assert.equal(g("## 1. Introduction").length, 2, "an almost-empty file fails the skeleton and the requirement rule");
    // Filled-in text on a placeholder id is what makes the `<MOD>` filter
    // load-bearing: with the blank cell alone the modal rule fires anyway, so
    // the first version of this assert passed with the filter deleted. Found by
    // mutation-testing, not by reading it.
    assert.ok(
      g(good.replace(/\| FSD-ROS-001 .*/, "| FSD-<MOD>-001 | The system shall filter | `FR-12` | confirmed |")).some((d) =>
        d.includes("no functional requirement"),
      ),
      "a row still carrying the <MOD> placeholder was never filled in, whatever the text says",
    );
    // A requirement with no source is where the AC chain starts from nothing.
    assert.ok(
      g(good.replace("| `FR-12` |", "|  |")).some((d) => d.includes("no Source")),
      "a sourceless requirement is named by id",
    );
    assert.ok(g(good.replace("| `FR-12` |", "| `…` |")).some((d) => d.includes("no Source")), "an ellipsis placeholder is not a source");
    // Documentation inside the artifact must not satisfy the check that reads
    // it -- the template's own instruction blockquote names every section and
    // quotes `shall`, so a header-only file would otherwise pass clean.
    // `> ## X` is already not a heading, so the case that makes the blockquote
    // filter load-bearing is a real skeleton whose ONLY requirement row is
    // quoted -- the template shows a sample row, and documentation inside the
    // artifact must not satisfy the check that reads the artifact.
    const quotedRow = good.replace(/^\| FSD-ROS-001 .*/m, "> | FSD-ROS-001 | The system shall filter | `FR-12` | confirmed |");
    assert.ok(
      g(quotedRow).some((d) => d.includes("no functional requirement")),
      "a requirement row inside an instruction blockquote is documentation, not a requirement",
    );
    // The `^` anchor is what does that, so it needs its own case: a blockquote
    // that quotes every heading must not satisfy the skeleton rule. Without
    // this, dropping the anchor passed silently.
    assert.ok(
      g(FSD_SECTIONS.map((s) => `> ## ${s}`).join("\n")).some((d) => d.includes("missing IEEE section")),
      "quoted headings are prose about the sections, not the sections",
    );
    // docLanguage is not English for every team: the modal comes from config.
    assert.deepEqual(
      g(good.replace("The system shall filter", "Hệ thống phải lọc")),
      [],
      "a configured non-English modal is accepted",
    );
    // Fail closed: no modal must throw, never silently drop the rule.
    assert.throws(() => gate1Defects(good, { modal: [] }), /fsdModal is required/, "an empty fsdModal cannot disable the rule quietly");
    // `undefined` falls through to the CFG default by design, so the real case
    // is a config that never declared it.
    assert.throws(() => gate1Defects(good, { modal: null }), /fsdModal is required/, "an absent fsdModal cannot disable the rule quietly");
    assert.throws(() => gate1Defects(good, { modal: "shall" }), /fsdModal is required/, "a string is rejected, not iterated as characters");
    // This repo must ship a config that can actually run the gate.
    assert.ok(Array.isArray(CFG.fsdModal) && CFG.fsdModal.length, "harness.config.json must declare fsdModal");
    // And the shipped template must pass its own gate once filled in -- except
    // the sample row, which is deliberately blank.
    const tpl = join(TASKS_DIR, "_templates/01-FSD.md");
    if (existsSync(tpl))
      assert.deepEqual(
        gate1Defects(readFileSync(tpl, "utf8")).filter((d) => !d.includes("no functional requirement")),
        [],
        "the shipped template must satisfy every Gate 1 rule it can (only the blank sample row may fail)",
      );
  }

  // gate1IsOwed: fsd_review is the first stage that READS the FSD, so it is the
  // first stage that owes it. Exempting it would hand the reviewer an empty spec.
  {
    assert.ok(gate1IsOwed("fsd_review"), "fsd_review READS 01-FSD.md — exempting it defeats the gate");
    for (const s of STAGE_ORDER.slice(STAGE_ORDER.indexOf("fsd_review"))) assert.ok(gate1IsOwed(s), `stage "${s}" is at or past fsd_review`);
    assert.equal(gate1IsOwed("fsd_write"), false, "the FSD is still being written at fsd_write");
    assert.equal(gate1IsOwed("bootstrap"), false, "no FSD exists at bootstrap");
    assert.equal(gate1IsOwed("typo-stage"), false, "an unknown stage is reported elsewhere, not here");
  }

  // #156: 08 is owed from the stage that READS it. Too early and the implementer is
  // judged on an artifact it has not finished; only at `reviewing` and two bad
  // attestation blocks rode from round 1 to the end of a real task unseen.
  {
    assert.ok(gate4EvidenceOwed("adversarial_review"), "adversarial_review is the first stage that reads 08");
    assert.ok(gate4EvidenceOwed("reviewing"), "reviewing reads it too");
    assert.equal(gate4EvidenceOwed("implementation"), false, "the implementer is still writing 08");
    assert.equal(gate4EvidenceOwed("technical_plan"), false, "08 does not exist yet");
    assert.equal(gate4EvidenceOwed("typo-stage"), false, "an unknown stage is reported elsewhere, not here");
  }

  // vectorIsOwed: the missing-vector rule used to start AFTER bootstrap, which
  // exempted the one stage that writes it -- so `--no-warn` passed a task whose
  // whole §5.1 apparatus had simply been deleted. The bootstrap case is the
  // regression test; the others keep the boundary honest.
  {
    assert.ok(vectorIsOwed("bootstrap"), "bootstrap WRITES the vector — exempting it makes deletion free");
    for (const s of STAGE_ORDER.slice(1)) assert.ok(vectorIsOwed(s), `stage "${s}" inherits the vector and owes it too`);
    // A stage the config does not know is indexOf -1: it must not read as owed,
    // or a typo'd currentStage would produce a second, confusing error.
    assert.equal(vectorIsOwed("typo-stage"), false, "an unknown stage is reported elsewhere, not here");
  }

  // cascade (§5.3.1): the retry must cost more than the attempt it is fixing.
  // Both directions get a case -- a check that never fires is decoration, and a
  // check that fires on a legal escalation would push everyone back to flat tiers.
}

