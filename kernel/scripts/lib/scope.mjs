import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join, matchesGlob } from "node:path";
// The paths in 03's "Files to change" table: first cell of each row, backticks stripped.
export function scopeFiles(plan = "") {
  // `## 3.1 Files to change` / `## 1. Files to change` are real headings in shipped
  // tasks (7 of 28 in one history); matching only the bare title made every file of
  // those tasks look unplanned (#115).
  const sec = plan.split(/^## /m).find((s) => /^[\d.]*\s*Files to change/i.test(s)) ?? "";
  // The path is the backticked span in the first cell; a note after it ("(5 files)",
  // "(new)") is prose, not part of the path, and dropping the whole row over it made
  // every file of that row read as unplanned (#115).
  return sec.split("\n").map((l) => /^\|[^|`]*`([^`]+)`[^|]*\|/.exec(l)?.[1]).filter(Boolean);
}


// #115: scope creep, decided by the two files that already answer it — 03's
// "Files to change" (the plan) and 06's "Plan Deviations" (the declared
// exceptions). Everything else that changed is a finding. Pure so --self-check
// owns the rules; the git read is the caller's.
// ponytail: a deviation "declares" a path by naming it literally (the row/prose
// contains the path). Prose that waves at a file without naming it does not
// count — that is the SR-002-D case, where the handoff said "exactly 4 files".
export function undeclaredFiles({ changed = [], plan = "", notes = "", tasksRel = null }) {
  const allowed = scopeFiles(plan);
  const dev = notes.split(/^## /m).filter((x) => /^[\d.]*\s*Plan Deviations/i.test(x)).join("\n");
  return changed
    // tasksRel is the project's real tasks dir; the literal fallback keeps the self-check's
    // no-arg cases working, but it must not exempt a source file that merely lives under
    // some `docs/tasks/` of its own (#141 review: src/docs/tasks/evil.js was in scope-blind).
    .filter((p) => (tasksRel ? !p.startsWith(tasksRel) : !/(^|\/)docs\/tasks\//.test(p)))
    .filter((p) => !allowed.some((a) => p === a || p.endsWith("/" + a) || (a.includes("*") && matchesGlob(p, a))))
    .filter((p) => !dev.includes(p))
    .sort();
}


// Slices (#67): a high task's implementation is dispatched one slice at a time,
// so no single implementer holds the whole diff in context. The slice set lives
// in 03's "Files to change" table — a `Slice` column (S1, S2, …) — never in
// handoff labels, which the role writes about itself.
//   S1 (#73): the rows' paths hold more than sliceBytes bytes → every row needs a
//   Slice. S2: one slice over sliceBytes. Bytes, not file count: the bench (#72)
//   showed 10 tiny new files forced into slices cost 3.4× and peaked higher —
//   context grows with what the implementer reads, and a new file reads as 0.
//   Measured only when `size` is passed: before the first implementation
//   dispatch, while the files are still the ones being planned against.
//   S3: a Slice cell not shaped S<n> — always, from implementation on.
// ponytail: slices run one after another; parallel dispatch needs disjoint file
// sets, add when a measured implementer is > 40% of API time.
export function planSlices(plan = "", cap = Infinity, size = null) {
  const sec = plan.split(/^## /m).find((s) => /^Files to change/i.test(s)) ?? "";
  const rows = sec.split("\n").filter((l) => /^\|/.test(l)).map((l) => l.split("|").slice(1, -1).map((c) => c.trim()));
  const head = rows[0] ?? [], col = head.findIndex((c) => /^slice$/i.test(c));
  const body = rows.slice(1).filter((r) => !r.every((c) => /^:?-+:?$/.test(c)) && /`[^`]+`/.test(r[0] ?? ""));
  const errors = [], slices = {}, files = {};
  const NO_SLICE = new Set(["", "-", "n/a", "na", "none", "no slice", "no-slice"]);
  for (const r of body) {
    const s = (col < 0 ? "" : r[col] ?? "").trim().toLowerCase();
    if (s && !NO_SLICE.has(s) && !/^s\d+$/.test(s)) errors.push(`03 Files to change: Slice "${r[col]}" for ${r[0]} is not S<n> — use S1, S2, … or remove the Slice column if the task is not sliced (#167)`);
    if (/^s\d+$/i.test(s)) { const S = s.toUpperCase(); (slices[S] ??= []).push(r[0]); (files[S] ??= []).push(...[...r[0].matchAll(/`([^`]+)`/g)].map((m) => m[1])); }
  }
  const bytes = (r) => [...(r[0] ?? "").matchAll(/`([^`]+)`/g)].reduce((n, m) => n + size(m[1]), 0);
  if (size) {
    const total = body.reduce((n, r) => n + bytes(r), 0);
    if (total > cap && (col < 0 || body.some((r) => !/^S\d+$/i.test((r[col] ?? "").trim()))))
      errors.push(`03 Files to change: existing files hold ${total} B (> sliceBytes ${cap}) — every row needs a Slice (S1, S2, …) so no implementer dispatch reads them all`);
    for (const x of Object.keys(slices)) {
      const b = body.filter((r) => (r[col] ?? "").trim().toUpperCase() === x).reduce((n, r) => n + bytes(r), 0);
      if (b > cap) errors.push(`03 slice ${x} holds ${b} B of existing files (> sliceBytes ${cap}) — split it`);
    }
  }
  return { slices: Object.keys(slices).sort((a, b) => a.slice(1) - b.slice(1)), files, errors };
}


// #77: the wall is the model's context window, so the budget sits next to the
// model name: models.<cli>.<tier>.sliceBytes, else the top-level sliceBytes
// (unmeasured models). `from` names the key so an exit 1 says what to re-measure.
export function sliceBudget(cfg, cli, tier) {
  const own = cfg.models?.[cli]?.[tier]?.sliceBytes;
  return Number.isInteger(own) && own >= 1 ? { bytes: own, from: `models.${cli}.${tier}.sliceBytes` } : { bytes: cfg.sliceBytes, from: "sliceBytes" };
}


// #69: a slice with no implementation dispatch by Gate 5 means the diff was built
// in one context after all — the thing slicing exists to prevent. Error, not warning.
export function missingSlices(slices, telemetry = []) {
  const ran = new Set(telemetry.filter((e) => e?.stage === "implementation" && e.slice).map((e) => e.slice));
  return slices.filter((x) => !ran.has(x));
}


// #70: 03 orders slices so a later one only depends on earlier ones. The FIRST
// dispatch of S<n> needs every earlier slice dispatched; a retry is free.
export function sliceOrderError(slices, telemetry = [], slice) {
  const ran = new Set(telemetry.filter((e) => e?.stage === "implementation" && e.slice).map((e) => e.slice));
  if (ran.has(slice)) return null;
  const before = slices.slice(0, slices.indexOf(slice)).filter((x) => !ran.has(x));
  return before.length ? `slice ${slice} before ${before.join(", ")} — 03 orders slices so a later one builds on earlier ones; dispatch ${before[0]} first` : null;
}


// #71: per-slice scope. --advance … --slice S<n> stores what was already dirty
// (path → content hash) on the telemetry entry; the --advance that closes the
// entry lists what changed since, and every path outside S<n>'s 03 rows fails.
//   snap = { head, dirty: { path: hash } }, now = { changed: [path], hash: (p) => hash }
// Pure so --self-check asserts it; the git reads live in sliceSnapshot/sliceChanged.
// ponytail: 03 rows are the only allow-list (06 Plan Deviations is Gate 5's call,
// not this one); a file a slice really needs goes into its 03 rows first.
export function sliceScopeViolations({ snap, changed, hash, allowed, skip = () => false }) {
  const touched = new Set(changed.filter((p) => snap.dirty[p] === undefined || snap.dirty[p] !== hash(p)));
  for (const p of Object.keys(snap.dirty)) if (snap.dirty[p] !== hash(p)) touched.add(p);
  return [...touched].filter((p) => !skip(p) && !allowed.some((s) => p === s || p.endsWith("/" + s))).sort();
}

export function gitAt(cwd, ...a) { const r = spawnSync("git", a, { cwd, encoding: "utf8" }); return r.status === 0 ? r.stdout : null; }

export function fileHash(top) { return (p) => { try { return createHash("sha256").update(readFileSync(join(top, p))).digest("hex").slice(0, 16); } catch { return "-"; } }; }

// #142: `-z` = NUL-separated and never quoted; the line format quotes "sp ace.js" and non-ASCII
// names, which then match no 03 row. A rename/copy entry carries the old path as an extra field.
export function parsePorcelainZ(out = "") {
  const f = out.split("\0"), r = [];
  for (let i = 0; i < f.length; i++) {
    if (f[i].length < 4) continue;
    r.push(f[i].slice(3));
    if (/[RC]/.test(f[i].slice(0, 2))) i++;
  }
  return r;
}

export function dirtyPaths(cwd) { return parsePorcelainZ(gitAt(cwd, "status", "--porcelain", "-z", "--untracked-files=all") ?? ""); }

// #141: gitignored files are invisible to status. Build/dep dirs are noise by definition; anything
// else ignored (a generated src file, a stray script) is a place to hide a change.
// ponytail: fixed noise list, not config; add config.scope.ignoredNoise when a project needs another.
// A function, not a const regex: the self-check runs above this line and a const would be in TDZ.
export function ignoredPaths(cwd) {
  const noise = /(^|\/)(node_modules|dist|build|coverage|target|__pycache__|\.venv|\.next|\.cache|\.turbo|\.git)\/|(^|\/)\.DS_Store$|\.log$/;
  return (gitAt(cwd, "ls-files", "-z", "--others", "--ignored", "--exclude-standard") ?? "").split("\0").filter((p) => p && !noise.test(p));
}

// #140: path → content hash for everything dirty or ignored. Membership alone cannot see a file that
// was already dirty being edited further.
export function contentSnapshot(cwd) {
  const top = gitAt(cwd, "rev-parse", "--show-toplevel")?.trim();
  if (!top) return {};
  const h = fileHash(top);
  return Object.fromEntries([...dirtyPaths(cwd), ...ignoredPaths(cwd)].map((p) => [p, h(p)]));
}

export function changedSince(before, after) {
  return [...new Set([...Object.keys(before), ...Object.keys(after)])].filter((p) => before[p] !== after[p]).sort();
}

export function sliceSnapshot(cwd) {
  const top = gitAt(cwd, "rev-parse", "--show-toplevel")?.trim(), head = gitAt(cwd, "rev-parse", "HEAD")?.trim();
  if (!top || !head) return null;
  const h = fileHash(top);
  return { head, dirty: Object.fromEntries(dirtyPaths(cwd).map((p) => [p, h(p)])) };
}

export function sliceChanged(cwd, snap) {
  const top = gitAt(cwd, "rev-parse", "--show-toplevel")?.trim();
  const diff = top && gitAt(cwd, "diff", "--name-only", snap.head);
  if (diff === null || !top) return null;
  return { top, changed: [...new Set([...diff.split("\n").filter(Boolean), ...dirtyPaths(cwd)])], hash: fileHash(top) };
}

// ── self-check: moved here with the logic it tests ──────────────────
export async function selfCheck({ assert }) {
  const { CFG, STAGE_ORDER } = await import("./config.mjs");
  const { packParts } = await import("./gate5.mjs");
  const { modelsDefects, netFsVerdict, unmeasuredSliceBudgets } = await import("./routing.mjs");
  const { cascadeDefects, contextBleed, stampDefects } = await import("./telemetry.mjs");
  {
    const plan = "## Files to change\n\n| File | Type |\n| --- | --- |\n| `src/a.js` | edit |\n\n## Test plan";
    const un = (changed, notes = "") => undeclaredFiles({ changed, plan, notes });
    assert.deepEqual(scopeFiles("## 3.1 Files to change\n| `src/n.js` | x |\n## 3.2 x"), ["src/n.js"], "a numbered heading is still the table");
    assert.deepEqual(scopeFiles("## 1. Files to change\n| `src/m.js` | x |"), ["src/m.js"], "…also with a trailing dot");
    assert.deepEqual(scopeFiles("## Files to change\n| `tests/f/*.html` (5 files) | new |"), ["tests/f/*.html"], "a note after the path is prose, not part of the row");
    const g = (changed) => undeclaredFiles({ changed, plan: "## Files to change\n| `tests/fixtures/t/*.html` | new |\n## Test plan" });
    assert.deepEqual(g(["tests/fixtures/t/a.html", "tests/fixtures/t/b.html"]), [], "a glob row covers the files it names");
    assert.deepEqual(g(["tests/fixtures/t/sub/a.html", "tests/fixtures/t/a.json"]), ["tests/fixtures/t/a.json", "tests/fixtures/t/sub/a.html"], "…and not a deeper dir or another extension");
    assert.deepEqual(un(["src/a.js"]), [], "a planned file is in scope");
    assert.deepEqual(un(["src/a.js", "test/a.test.js"]), ["test/a.test.js"], "an unplanned file is named");
    assert.deepEqual(un(["test/a.test.js"], "## Plan Deviations\n- added `test/a.test.js` because …\n## Handoff"), [], "declared in 06 → in scope");
    assert.deepEqual(un(["test/a.test.js"], "## Plan Deviations\n- we changed some tests\n## Handoff"), ["test/a.test.js"], "prose that never names the path does not declare it");
    assert.deepEqual(un(["docs/tasks/sprint-1/X/09-Adversarial-Review.md"]), [], "the task's own artifacts are not code changes");
    assert.deepEqual(un([], "## Plan Deviations"), [], "nothing changed → nothing to say");
  }

  // #107: values an AC names must appear in the test it points at.
  {
    // #142 -z parsing: a space, a non-ASCII name and a rename must come back verbatim and unquoted.
    assert.deepEqual(parsePorcelainZ("?? sp ace.js\0?? tên.js\0 M src/a.js\0R  new.js\0old.js\0"), ["sp ace.js", "tên.js", "src/a.js", "new.js"], "-z: no quotes, rename's old path dropped");
    assert.deepEqual(parsePorcelainZ(""), [], "clean tree → nothing");
    // #141 a source file under a nested docs/tasks/ is code, not a task artifact (when tasksRel is known).
    assert.deepEqual(undeclaredFiles({ changed: ["src/docs/tasks/evil.js"], plan: "## Files to change\n| `src/a.js` | x |", tasksRel: "docs/tasks/" }), ["src/docs/tasks/evil.js"], "nested docs/tasks is not exempt once the real tasks dir is known");
    // #140/#141 content snapshots on a real repo: an already-dirty file edited again, and a gitignored file.
    const { mkdtempSync: mk, writeFileSync: wf, mkdirSync: md, rmSync: rm } = await import("node:fs");
    const { tmpdir: td } = await import("node:os");
    const { execFileSync: ex } = await import("node:child_process");
    const d = mk(join(td(), "scope-"));
    const git = (...a) => ex("git", a, { cwd: d, stdio: "pipe" });
    try {
      git("init", "-q"); git("config", "user.email", "t@t"); git("config", "user.name", "t");
      wf(join(d, ".gitignore"), "node_modules/\ngen/\n"); wf(join(d, "a.js"), "1\n");
      git("add", "-A"); git("commit", "-qm", "base");
      wf(join(d, "a.js"), "2\n");                       // dirty BEFORE the adversary ran
      wf(join(d, "sp ace.js"), "x\n");
      const before = contentSnapshot(d);
      assert.ok("sp ace.js" in before, "a spaced name is tracked verbatim");
      wf(join(d, "a.js"), "3\n");                       // already dirty, edited further
      md(join(d, "gen")); wf(join(d, "gen/x.js"), "evil\n");            // ignored, not noise
      md(join(d, "node_modules")); wf(join(d, "node_modules/y.js"), "dep\n"); // ignored, noise
      const moved = changedSince(before, contentSnapshot(d));
      assert.deepEqual(moved, ["a.js", "gen/x.js"], "dirty-edited-again and non-noise ignored files are seen; node_modules is not");
      assert.deepEqual(changedSince(before, before), [], "nothing moved → silent");
    } finally { rm(d, { recursive: true, force: true }); }
  }
  // #139: the matrix must default to UNVERIFIED and must never promote a mechanism to a run.
  {
    const plan = "## Files to change\n\n| File | T |\n| --- | --- |\n| `src/a.js` | new |\n\n## Test plan\n| `npm t` | x |\n";
    assert.deepEqual(scopeFiles(plan), ["src/a.js"], "scopeFiles reads only the Files to change table");
    const docs = { instructions: "I", shared: "## 4. H\nh4\n## 7. X\nx7\n## 9. AC\nac9\n", roleFile: "r.md", role: "R", project: "" };
    const git = { base: "abc", stat: " src/a.js | 1 +\n", status: " M src/a.js\n?? src/evil.js\n?? docs/tasks/T/09.md\n" };
    const p = packParts({ stage: "adversarial_review", role: "adversary", docs, git, scope: ["src/a.js"] });
    for (const l of git.status.split("\n").filter(Boolean)) assert.ok(p.machine.includes(l), `R3b: status line "${l}" missing from the adversary pack`);
    assert.ok(/\?\? src\/evil\.js\s+← not in 03/.test(p.machine) && !/ M src\/a\.js\s+←/.test(p.machine), "R3b: out-of-scope files are marked, in-scope ones are not");
    assert.ok(p.rules.includes("h4") && p.rules.includes("ac9") && !p.rules.includes("x7"), "pack carries SharedRules §4/§9, not §7");
    const ps = packParts({ stage: "adversarial_review", role: "adversary", docs, git, scope: ["src/a.js"], sliceOf: { "src/a.js": "S2" } });
    assert.ok(/ M src\/a\.js\s+\[S2\]/.test(ps.machine) && /\?\? src\/evil\.js\s+← not in 03/.test(ps.machine), "#74: a sliced pack tags in-scope lines with their slice, out-of-scope still marked");
    for (const l of git.status.split("\n").filter(Boolean)) assert.ok(ps.machine.includes(l), `#74 R3b: sliced pack dropped "${l}"`);
    const hist = "first round\n## Update — r2\nsecond\n## Update — r3\nthird";
    const re = packParts({ stage: "implementation", role: "implementer", attempt: 2, docs, artifacts: { "06.md": hist } }).prose;
    assert.ok(re.includes("third") && !re.includes("second") && !re.includes("first round"), "a re-run pack keeps only the newest ## Update block");
    assert.ok(packParts({ stage: "implementation", role: "implementer", attempt: 1, docs, artifacts: { "06.md": hist } }).prose.includes("first round"), "a first run keeps the whole artifact");
    assert.ok(Number.isInteger(CFG.packWarn) && STAGE_ORDER.slice(1, -1).every((st) => Number.isInteger((CFG.packCap ?? {})[st])), "S6: config.packCap.<every dispatched stage> and packWarn are required");
  }

  // planSlices (#67): S1 S2 S3, and S5b on the two telemetry readers.
  {
    const tbl = (rows, slice = true) => "## Files to change\n\n| File | Type" + (slice ? " | Slice" : "") + " |\n| --- | ---" + (slice ? " | ---" : "") + " |\n" +
      rows.map(([f, x]) => `| \`${f}\` | new${slice ? ` | ${x}` : ""} |`).join("\n") + "\n\n## Test plan\n| `npm t` | x |\n";
    const sz = (p) => ({ a: 60, b: 60, c: 60 })[p] ?? 0; // 3 existing files of 60 B; anything else is new
    assert.deepEqual(planSlices(tbl([["a", ""], ["b", ""]], false), 120, sz), { slices: [], files: {}, errors: [] }, "#73: at the byte cap with no Slice column: fine");
    assert.equal(planSlices(tbl([["a"], ["b"], ["c"]], false), 120, sz).errors.length, 1, "#73 S1: existing bytes over sliceBytes with no Slice column is an error");
    assert.deepEqual(planSlices(tbl([["a"], ["n1"], ["n2"], ["n3"], ["n4"], ["n5"], ["n6"], ["n7"], ["n8"], ["n9"]], false), 120, sz).errors, [], "#73: ten files, nine of them new (0 B) — no slicing forced (the #72 fixture)");
    assert.deepEqual(planSlices(tbl([["a"], ["b"], ["c"]], false), 120).errors, [], "#73: without size the budget is not measured (after the first dispatch)");
    assert.equal(planSlices(tbl([["a", "S1"], ["b", "S1"], ["c", ""]]), 120, sz).errors.length, 1, "S1: over sliceBytes, one row without a slice");
    assert.deepEqual(planSlices(tbl([["a", "S2"], ["b", "S10"], ["c", "S1"]]), 120, sz), { slices: ["S1", "S2", "S10"], files: { S2: ["a"], S10: ["b"], S1: ["c"] }, errors: [] }, "slices in numeric order, test-plan rows not counted, files per slice");
    assert.deepEqual(planSlices(tbl([["a"], ["b"]], false).replace("| \`b\` | new |", "| _none else_ | new |"), 1, () => 1).errors, [], "S1 counts backtick paths only, not a note row");
    assert.equal(planSlices(tbl([["a", "S1"], ["b", "S1"], ["c", "S1"]]), 120, sz).errors.length, 1, "#73 S2: one slice over sliceBytes");
    assert.equal(planSlices(tbl([["a", "part 1"]])).errors.length, 1, "S3: a Slice cell not shaped S<n>, measured or not");
    const sl = (x, attempt, tier = "mid", inputTokens) => ({ stage: "implementation", slice: x, attempt, tier, inputTokens });
    assert.deepEqual(cascadeDefects([sl("S1", 1), sl("S2", 1), sl("S3", 1), sl("S4", 1)]), { errors: [], warnings: [] }, "S5b: 4 slices, same tier, attempt 1 — no cascade defect");
    assert.equal(cascadeDefects([sl("S1", 1), sl("S2", 1), sl("S1", 2, "strong"), sl("S2", 2, "cheap")]).errors.length, 1, "S5b: a slice's own retry still may not drop tier");
    const up = (st, n) => ({ stage: st, tier: "mid", inputTokens: n });
    assert.equal(contextBleed([up("a", 5000), sl("S1", 1, "mid", 6000), sl("S2", 1, "mid", 9000), sl("S3", 1, "mid", 14000), sl("S4", 1, "mid", 20000)]), null, "S5b: growing sibling slices are not bleed");
    assert.ok(contextBleed([up("a", 5000), sl("S1", 1, "mid", 9000), up("b", 14000), up("c", 20000)]), "S5b: the first slice still counts as its stage");
    assert.ok(Number.isInteger(CFG.sliceBytes) && CFG.sliceBytes >= 1, "S6: config.sliceBytes (integer ≥ 1) is required");
    const cb = { sliceBytes: 9, models: { claude: { mid: { model: "x", sliceBytes: 5 } }, codex: { mid: { model: "y" } } } };
    assert.deepEqual(sliceBudget(cb, "claude", "mid"), { bytes: 5, from: "models.claude.mid.sliceBytes" }, "#77: the model's own budget wins");
    assert.deepEqual(sliceBudget(cb, "codex", "mid"), { bytes: 9, from: "sliceBytes" }, "#77: unmeasured model → top-level");
    assert.deepEqual(sliceBudget(cb, null, "mid"), { bytes: 9, from: "sliceBytes" }, "#77: no --cli → top-level");
    assert.deepEqual(sliceBudget({ ...cb, models: { claude: { mid: { sliceBytes: 0 } } } }, "claude", "mid").from, "sliceBytes", "#77: a non-positive budget is not used");
    const mb = (v) => modelsDefects({ coordinatorTier: "mid", models: { claude: { cheap: { model: "a" }, mid: { model: "b", sliceBytes: v }, strong: { model: "c" } } } }).errors;
    assert.deepEqual(mb(64000), [], "#77: models.<cli>.<tier>.sliceBytes is a known key");
    assert.equal(mb("64k").length, 1, "#77: a declared sliceBytes that is not an integer ≥ 1 is a config error, not a silent fallback");
    {
      const u = { sliceBytes: 64000, baseTier: { implementer: ["mid", "mid", "strong"] },
        models: { claude: { mid: { model: "s", sliceBytes: 64000 } }, codex: { mid: { model: "g" } } } };
      const w = unmeasuredSliceBudgets(["claude", "codex", "gemini"], u);
      assert.equal(w.length, 1, "#97: only the routed CLI whose implementer tier lacks its own sliceBytes is reported");
      assert.ok(w[0].startsWith("models.codex.mid (g)") && w[0].includes("--find-slice-bytes"), "#97: the warning names the key and the measuring command");
      assert.deepEqual(unmeasuredSliceBudgets(["codex"], { ...u, models: { codex: { mid: { model: "g", sliceBytes: 1 } } } }), [], "#97: a measured budget is silent");
    }
    // #100
    assert.deepEqual(netFsVerdict({ platform: "linux", type: 0x6969, skewMs: 0 }), ["on a nfs filesystem"], "#100: NFS magic on linux is named");
    assert.deepEqual(netFsVerdict({ platform: "darwin", type: 0x6969, skewMs: 0 }), [], "#100: the magic means nothing off Linux");
    assert.deepEqual(netFsVerdict({ platform: "linux", type: 0xef53, skewMs: 0 }), [], "#100: ext4 is not in the map");
    assert.deepEqual(netFsVerdict({ platform: "darwin", type: 0, skewMs: 9000 }), ["its clock is 9s off the local one"], "#100: clock skew is platform-independent");
    assert.deepEqual(netFsVerdict({ platform: "darwin", type: 0, skewMs: 500 }), [], "#100: small skew is noise, not a verdict");
    assert.deepEqual(netFsVerdict({ platform: "linux", type: 0x6969, skewMs: 9000 }), ["on a nfs filesystem", "its clock is 9s off the local one"], "#100: both signals can fire together");
    // #69
    assert.deepEqual(missingSlices(["S1", "S2"], [sl("S2", 1), { stage: "fsd_write", slice: "S1" }]), ["S1"], "#69: a slice with no implementation dispatch is missing");
    assert.deepEqual(missingSlices(["S1", "S2"], [sl("S1", 1), sl("S2", 1)]), [], "#69: every slice dispatched");
    // #70
    assert.ok(sliceOrderError(["S1", "S2", "S3"], [sl("S1", 1)], "S3")?.includes("S2"), "#70: S3 before S2 is refused");
    assert.equal(sliceOrderError(["S1", "S2"], [], "S1"), null, "#70: the first slice needs nothing");
    assert.equal(sliceOrderError(["S1", "S2"], [sl("S1", 1)], "S2"), null, "#70: S2 after S1");
    assert.equal(sliceOrderError(["S1", "S2"], [sl("S2", 1)], "S2"), null, "#70: a retry of an already-run slice is free");
    // #71
    const H = { a: "1", b: "2", x: "9" }, hash = (p) => H[p] ?? "-";
    const V = (o) => sliceScopeViolations({ snap: { head: "h", dirty: {} }, hash, allowed: ["src/a.js"], ...o });
    assert.deepEqual(V({ changed: ["src/a.js"] }), [], "#71: a slice changing its own row is fine");
    assert.deepEqual(V({ changed: ["src/a.js", "src/b.js"] }), ["src/b.js"], "#71: a path outside the slice's rows is a violation");
    assert.deepEqual(V({ changed: ["docs/tasks/t/06.md"], skip: (p) => p.startsWith("docs/tasks/") }), [], "#71: the task folder is skipped");
    assert.deepEqual(V({ changed: ["x"], snap: { head: "h", dirty: { x: "9" } } }), [], "#71: dirty before the dispatch and unchanged since is not this slice's");
    assert.deepEqual(V({ changed: ["x"], snap: { head: "h", dirty: { x: "8" } } }), ["x"], "#71: dirty before but changed since is");
    assert.deepEqual(V({ changed: [], snap: { head: "h", dirty: { x: "8" } } }), ["x"], "#71: a pre-dirty file reverted/committed counts too");
    assert.deepEqual(V({ changed: ["lib/src/a.js"] }), [], "#71: a row path matches as a suffix (monorepo repo.path)");
  }

  // stampDefects (#65): R5 witness, R5b clock order, R5c whole-minute smell.
}

