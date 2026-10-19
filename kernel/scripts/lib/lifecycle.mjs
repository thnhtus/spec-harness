import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";
import { AC_TRACE_SINCE, CFG, GROUP_PREFIX, REPO_ROOT, ROLE_STAGE, STAGE_ORDER, TASKS_DIR } from "./config.mjs";
import { vectorInputErrors } from "./routing.mjs";
// --advance (#61): the coordinator's whole per-stage bookkeeping as ONE command,
// run right before dispatching <stage>. A real run spent 16 of the coordinator's
// 39 calls on validate / attempts / lease / telemetry by hand, and the hand-typed
// telemetry windows were invented. Here the script owns every write, so the
// clock is the machine's and the coordinator only routes.
//   exit 0 = dispatch <stage> · 1 = stop (gate FAIL, halted handoff, skipped stage,
//   lease not held) · 2 = bad arguments.
// Pure decision, so --self-check can assert every branch without a filesystem.
// #91: --advance used to refuse "skip a gate" until the coordinator hand-edited
// currentStage + agents.<role>.status -- five JSON edits per task, the sort of
// bookkeeping #64 moved into scripts. When the target is exactly the NEXT stage
// and the previous role's last handoff says `Continue automation: yes`, that
// handoff IS the PASS: promote, then validate (a gate FAIL rolls it back).
export function promotion(data, stage, { stages = STAGE_ORDER, roleStage = ROLE_STAGE, routing = CFG.routing, continues = () => false } = {}) {
  const at = stages.indexOf(stage), cur = stages.indexOf(data.currentStage);
  if (at < 1 || cur < 0 || at !== cur + 1) return null;
  const prev = data.currentStage === "implementation" && routing?.map?.[data[routing.field]]
    ? routing.map[data[routing.field]] : Object.keys(roleStage).find((r) => roleStage[r] === data.currentStage);
  if (!prev || !continues(prev)) return null;
  const last = at === stages.length - 1;
  return { ...data, currentStage: stage, ...(last ? { status: "reviewing" } : {}), agents: { ...data.agents, [prev]: { ...(data.agents?.[prev] ?? {}), status: "done" } } };
}


export function advanceDecision(data, stage, { stages = STAGE_ORDER, roleStage = ROLE_STAGE, routing = CFG.routing, halted = () => false } = {}) {
  const at = stages.indexOf(stage), cur = stages.indexOf(data.currentStage);
  if (at < 1) return { exit: 2, why: `stage "${stage}" is not a dispatchable stage (${stages.slice(1).join(", ")})` };
  if (cur < 0) return { exit: 1, why: `task currentStage "${data.currentStage}" is not in config.stages` };
  if (at > cur) return { exit: 1, why: `task is at "${data.currentStage}" — dispatching "${stage}" would skip a gate` };
  const roleOf = (st) => st === "implementation" && routing?.map?.[data[routing.field]]
    ? routing.map[data[routing.field]] : Object.keys(roleStage).find((r) => roleStage[r] === st);
  // Forward: the previous stage's role just handed over. Back (a Gate 5 FAIL
  // re-route): the role of the stage the task sits at is the one that sent it back.
  const prev = roleOf(at === cur ? stages[at - 1] : data.currentStage);
  if (at === cur && halted(prev)) return { exit: 1, why: `.agent-memory/${prev}.md last handoff says "Continue automation: no" — stop and report`, prev };
  const last = stage === stages[stages.length - 1];
  return { exit: 0, role: last ? null : roleOf(stage), prev, attempt: last ? null : ((data.attempts ?? {})[stage] ?? 0) + 1 };
}


// --bootstrap (#64): stage 1 as a command. In the measured run the orchestrator
// subagent spent 2:34 and 110k tokens copying templates and filling fields the
// coordinator already held, then failed a gate on one of them. Every field here
// is either given (the coordinator read the tracker in step 0) or derived by
// config — nothing to judge, so nothing for a model to do.
//   exit 0 = folder written and it validates · 1 = refused (exists, protected
//   branch, no git user) or the written folder fails the validator · 2 = bad input.
export function isProtected(branch, list = CFG.protectedBranches ?? []) {
  return list.some((p) => new RegExp(`^(?:${p})$`).test(branch));
}


export function bootstrapInputErrors(o, { repos = CFG.repos ?? [], branchTypes = Object.keys(CFG.routing?.map ?? {}), urlPattern = CFG.tracker?.urlPattern } = {}) {
  if (o === null || typeof o !== "object" || Array.isArray(o)) return ["input must be a JSON object"];
  const out = [];
  for (const k of ["taskId", "taskName", "slug", "trackerUrl", "branchType", "branch"])
    if (typeof o[k] !== "string" || !o[k].trim()) out.push(`${k} is required (a non-empty string)`);
  if (!Number.isInteger(o.sprintNumber) || o.sprintNumber < 1) out.push("sprintNumber is required (an integer ≥ 1)");
  if (o.trackerUrl && urlPattern && !new RegExp(urlPattern).test(o.trackerUrl)) out.push(`trackerUrl does not match config.tracker.urlPattern /${urlPattern}/`);
  if (o.slug && !/^[a-z0-9]+(-[a-z0-9]+)*$/.test(o.slug)) out.push(`slug "${o.slug}" must be kebab-case a-z0-9 (no diacritics)`);
  if (o.branchType && !branchTypes.includes(o.branchType)) out.push(`branchType "${o.branchType}" is not one of ${branchTypes.join("/")}`);
  if (o.repoName === undefined && repos.length !== 1) out.push(`repoName is required when config.repos has ${repos.length} entries — ask, do not guess`);
  else if (o.repoName !== undefined && !repos.some((r) => r.name === o.repoName)) out.push(`repoName "${o.repoName}" is not in config.repos`);
  const c = o.complexity;
  if (!c || typeof c !== "object") out.push("complexity { vector, counts, questions } is required — the step 0 measurements");
  else out.push(...vectorInputErrors(c.vector).map((e) => `complexity.vector: ${e}`));
  return out;
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
export function outcomeIsBlocking(data, since = AC_TRACE_SINCE) {
  return (data.createdAt ?? "") >= since;
}


// `createdAt` is the master switch for every since-cutoff in this file: the
// complexity block, the AC trace and `outcome.closedAt` all degrade to warnings
// below it, and pre-commit runs --no-warn. So one self-declared string, checked
// nowhere and typed `minLength: 1` in the schema, turned off more rules than any
// other field -- including "delete the complexity block", which is the exact
// opt-out §5.1 was rewritten to close.
//
// Two things it must survive:
//   1. a shape that is not a date at all ("yesterday", "1") -- sorts below every
//      ISO string, so it reads as "predates the harness" forever;
//   2. an honest-looking date that is simply older than the truth.
// (2) cannot be proven, but it can be contradicted: git knows when the task
// folder first appeared. A folder whose first commit lands after the cutoff did
// not exist before it.
export function backdatedCreatedAt(createdAt, firstCommit, since = AC_TRACE_SINCE) {
  if (!/^\d{4}-\d{2}-\d{2}/.test(createdAt ?? ""))
    return `createdAt=${JSON.stringify(createdAt ?? null)} is not a date (YYYY-MM-DD) — it decides whether §5.1/§5.6 are errors or warnings, and anything unparseable sorts below the cutoff forever`;
  if (createdAt >= since) return null; // claims nothing, gets nothing
  // Claims to predate the harness. git is the only witness that does not come
  // from the same file -- but no git means no witness, and a check that
  // convicts on missing evidence is worse than no check.
  if (firstCommit === undefined) return null;
  // No history yet (folder never committed) is not proof on its own -- but a
  // brand-new folder cannot be older than the switch-on date either, so both
  // branches land in the same place. Deliberately falsy-tested, not `=== null`:
  // that makes the guard above load-bearing rather than decorative, so deleting
  // it turns the "no git = no witness" case red instead of passing by accident.
  if (!firstCommit)
    return `createdAt=${createdAt} predates acTrace.since=${since} (which downgrades §5.1/§5.6 errors to warnings) but this folder has no commit yet — a task the harness never saw cannot claim the grandfather clause`;
  if (firstCommit >= since)
    return `createdAt=${createdAt} predates acTrace.since=${since}, but the folder first appears in git on ${firstCommit} — it was created under the harness, so §5.1/§5.6 apply in full`;
  return null;
}


// Oldest commit date (YYYY-MM-DD) touching a path.
// null = git works, path has no history. undefined = no git, no opinion.
export function firstCommitDate(path) {
  try {
    const out = execFileSync("git", ["log", "--format=%cs", "--", path], {
      cwd: REPO_ROOT,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    })
      .trim()
      .split("\n")
      .filter(Boolean);
    return out.length ? out[out.length - 1] : null;
  } catch {
    return undefined;
  }
}


export function calibrate(tasks) {
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

  // #114: `attempts` counts dispatches, and not every dispatch is a round of
  // work. In a real 28-task history 6 of 145 dispatches lasted under 30 s and 7
  // were handoff-logged as "telemetry backfill" — all of them counted as retries,
  // which is how "fsd_write retries most" got into a report.
  // attempts is NOT corrected: lowering it would hand every agent a way to reset
  // its retry budget by dispatching twice in a second. The count is reported
  // beside the retry numbers so a reader can see how much of it is real.
  const SHORT = (CFG.calibrateShortDispatchSeconds ?? 30) * 1000;
  const shortRuns = { n: 0, byStage: {} };
  for (const t of closed)
    for (const e of t.telemetry ?? []) {
      if (!e.startedAt || !e.endedAt) continue;
      const ms = Date.parse(e.endedAt) - Date.parse(e.startedAt);
      if (Number.isFinite(ms) && ms >= 0 && ms < SHORT) (shortRuns.n++, shortRuns.byStage[e.stage] = (shortRuns.byStage[e.stage] ?? 0) + 1);
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

  // Loud, and ahead of the stage findings it undermines: a reader who acts on
  // "stage X retries most" without knowing a third of those runs took 2 seconds
  // is retuning thresholds against bookkeeping.
  if (shortRuns.n)
    findings.unshift(
      `${shortRuns.n} dispatch(es) under ${SHORT / 1000}s (${Object.entries(shortRuns.byStage).map(([k, v]) => `${k} ${v}`).join(", ")}) — too short to be a round of work (backfill, a re-stamp, an aborted run); they still count in attempts, so treat the stage retry numbers above as an upper bound (#114)`,
    );

  return { tasks: closed.length, coverage, splits, byLabel, retriesByStage, shortRuns, findings };
}


// ---------------------------------------------------------------------------
// Collect task folders
// ---------------------------------------------------------------------------
// Task folders touched by the git index, as paths relative to REPO_ROOT.
// Returns null when git is unavailable — the caller then falls back to the full
// scan rather than silently validating nothing.
export function stagedTaskFolders() {
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
// → "sprint-1/ABC-1-x". The last two segments are the key; anything before is tasksDir.
export function taskKeyOf(arg) {
  const parts = arg.split(/[/\\]/).filter((x) => x && x !== ".");
  return parts.slice(-2).join("/");
}


// `only` is the CLI's task filter, passed IN: null = every task, a Set = just those keys.
// It used to be a default parameter reading the kernel's module-level ONLY, which after the
// split lives in the CLI — a cross-module default is the TDZ trap this avoids.
export function findTaskFolders(only = null) {
  const folders = [];
  if (!existsSync(TASKS_DIR)) return folders;
  for (const sprint of readdirSync(TASKS_DIR)) {
    const sprintPath = join(TASKS_DIR, sprint);
    if (!sprint.startsWith(GROUP_PREFIX) || !statSync(sprintPath).isDirectory()) continue;
    for (const task of readdirSync(sprintPath)) {
      const taskPath = join(sprintPath, task);
      if (!statSync(taskPath).isDirectory()) continue;
      if (only && !only.has(`${sprint}/${task}`)) continue;
      folders.push({ sprint, task, path: taskPath });
    }
  }
  return folders;
}


// A task folder the scan above cannot see: `docs/tasks/ABC-1/task.agent.json`
// (no group dir) is skipped by findTaskFolders, so whole-repo validation says
// "0 errors" about a task it never looked at (#54). Only dirs holding a
// task.agent.json count — an `archive/` of plain notes is not a task.
export function strayTaskFolders(tasksDir, groupPrefix) {
  if (!existsSync(tasksDir)) return [];
  return readdirSync(tasksDir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && !d.name.startsWith("_") && !d.name.startsWith(groupPrefix))
    .filter((d) => existsSync(join(tasksDir, d.name, "task.agent.json")))
    .map((d) => d.name);
}

// ── self-check: moved here with the logic it tests ──────────────────
export async function selfCheck({ assert }) {
  const { GATE4_DONE } = await import("./config.mjs");
  const { handoffDefects } = await import("./docs.mjs");
  const { escapeHatchStats } = await import("./routing.mjs");
  {
    const { mkdtempSync, writeFileSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const d = mkdtempSync(join(tmpdir(), "sh-"));
    assert.equal(handoffDefects(d, "x").length, 1, "missing file is one defect");
    writeFileSync(join(d, "x.md"), "### 2026-01-01 — x\n- **Next agent**: y\n- **Continue automation**: yes\n");
    assert.deepEqual(handoffDefects(d, "x"), [], "complete handoff passes");
    writeFileSync(join(d, "y.md"), "### 2026-01-01 — y\n- **Next agent**: z\n");
    assert.equal(handoffDefects(d, "y").length, 1, "missing Continue automation is caught");
    writeFileSync(join(d, "z.md"), "just prose, no blocks\n");
    assert.equal(handoffDefects(d, "z").length, 3, "no block, no fields");
    rmSync(d, { recursive: true, force: true });
  }

  // calibrate: the findings are the whole point — a rule that never fires is
  // decoration, and one that fires on noise is worse.
  {
    const t = (o) => ({ taskComplexity: "normal", attempts: {}, outcome: { closedAt: "2026-01-01" }, ...o });
    assert.equal(calibrate([]).tasks, 0, "no closed task → nothing to say");
    assert.equal(calibrate([{ taskComplexity: "high" }]).tasks, 0, "unclosed task is not evidence");

    // #114: a 2-second dispatch is bookkeeping, not a retry. It is reported, never
    // subtracted — attempts is the retry budget and must not be gameable.
    {
      const run = (s, e, stage = "fsd_write") => ({ stage, startedAt: `2026-01-01T00:00:${s}Z`, endedAt: `2026-01-01T00:00:${e}Z` });
      const c0 = calibrate([t({ attempts: { fsd_write: 3 }, telemetry: [run("00", "02"), run("02", "04"), { stage: "fsd_write", startedAt: "2026-01-01T00:00:00Z", endedAt: "2026-01-01T00:09:00Z" }] })]);
      assert.equal(c0.shortRuns.n, 2, "two sub-30s dispatches are named");
      assert.deepEqual(c0.shortRuns.byStage, { fsd_write: 2 });
      assert.match(c0.findings[0], /2 dispatch\(es\) under 30s/, "reported first — it qualifies every stage finding below");
      assert.equal(c0.byLabel.normal.retries, 2, "attempts is NOT corrected: that would let an agent reset its own budget");
      assert.equal(calibrate([t({ telemetry: [{ stage: "x", startedAt: "2026-01-01T00:00:00Z" }, { stage: "x" }] })]).shortRuns.n, 0, "an open or stamp-less entry has no duration to judge");
      assert.equal(calibrate([t({ telemetry: [run("05", "00")] })]).shortRuns.n, 0, "a negative duration is a clock problem, not a short run");
    }

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
  // This is the case the wrapper exists to catch, and the case every
  // regex-based check loses: output printing "passed" with a non-zero exit.
  {
    const since = "2026-07-28";
    const b = (c, g) => backdatedCreatedAt(c, g, since);
    assert.equal(b("2026-09-01", null), null, "a date after the cutoff claims nothing");
    assert.equal(b("2026-01-01", "2026-01-05"), null, "genuinely old task, git agrees → keeps the grandfather clause");
    assert.ok(b("2026-01-01", "2026-09-01").includes("first appears in git"), "git contradicts the backdate");
    assert.ok(b("2026-01-01", null).includes("no commit yet"), "predating the harness with no history at all is not credible");
    assert.equal(b("2026-01-01", undefined), null, "no git = no witness; a check must not convict on missing evidence");
    assert.ok(b("yesterday", null).includes("not a date"), "unparseable sorts below every cutoff forever");
    assert.ok(b(undefined, null).includes("not a date"), "missing is the same hole as unparseable");
    assert.ok(b("1", null).includes("not a date"), "a bare number is not a date");
    assert.equal(b("2026-07-28", null), null, "the cutoff day itself is inside the harness");
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

  // over budget but shipped: the exit split cannot give. Every half matters --
  // a reason without shipping, or shipping without a reason, stays an error.
  {
    const o = { stages: ["bootstrap", "fsd_write", "implementation", "adversarial_review", "reviewing"],
      roleStage: { orchestrator: "bootstrap", "fsd-writer": "fsd_write", implementer: "implementation", fixer: "implementation", adversary: "adversarial_review" },
      routing: { field: "branchType", map: { feature: "implementer", bugfix: "fixer" } } };
    const ad = (data, st, x = {}) => advanceDecision({ branchType: "feature", ...data }, st, { ...o, ...x });
    const fwd = ad({ currentStage: "implementation", attempts: { fsd_write: 1 } }, "implementation");
    assert.deepEqual(fwd, { exit: 0, role: "implementer", prev: "fsd-writer", attempt: 1 }, "forward: dispatch the stage's role, first attempt");
    assert.equal(ad({ currentStage: "implementation", branchType: "bugfix" }, "implementation").role, "fixer", "routing picks fixer for bugfix");
    assert.equal(ad({ currentStage: "implementation", attempts: { implementation: 2 } }, "implementation").attempt, 3, "attempt = attempts[stage] + 1");
    // Gate 5 FAIL keeps currentStage at adversarial_review; the re-route is back to implementation.
    const back = ad({ currentStage: "adversarial_review", attempts: { implementation: 1 } }, "implementation", { halted: (r) => r === "adversary" });
    assert.deepEqual([back.exit, back.attempt, back.prev], [0, 2, "adversary"], "back: a FAIL re-route is allowed and shows the adversary's findings");
    assert.equal(ad({ currentStage: "fsd_write" }, "implementation").exit, 1, "skipping a stage is refused");
    assert.equal(ad({ currentStage: "implementation" }, "implementation", { halted: (r) => r === "fsd-writer" }).exit, 1, "a halted handoff stops the next dispatch");
    assert.equal(ad({ currentStage: "implementation" }, "bootstrap").exit, 2, "bootstrap is not dispatched through --advance");
    assert.equal(ad({ currentStage: "implementation" }, "nope").exit, 2, "an unknown stage is a usage error");
    assert.equal(ad({ currentStage: "weird" }, "implementation").exit, 1, "a task at an unknown stage is not dispatched");
    const end = ad({ currentStage: "reviewing" }, "reviewing");
    assert.deepEqual([end.exit, end.role, end.attempt, end.prev], [0, null, null, "adversary"], "the last stage dispatches nothing");
    // #91 promotion: next stage + a continuing handoff moves the task; anything else does not.
    const pr = (data, st, c) => promotion({ branchType: "feature", agents: {}, ...data }, st, { ...o, continues: (r) => r === c });
    const p1 = pr({ currentStage: "fsd_write" }, "implementation", "fsd-writer");
    assert.deepEqual([p1?.currentStage, p1?.agents["fsd-writer"].status], ["implementation", "done"], "next stage + Continue: yes → promoted, previous role done");
    assert.equal(pr({ currentStage: "fsd_write" }, "implementation", "nobody"), null, "no continuing handoff → not promoted");
    assert.equal(pr({ currentStage: "fsd_write" }, "adversarial_review", "fsd-writer"), null, "two stages ahead is still a skip");
    assert.equal(pr({ currentStage: "implementation", branchType: "bugfix" }, "adversarial_review", "fixer")?.agents.fixer.status, "done", "routing: the fixer's handoff promotes a bugfix");
    assert.equal(pr({ currentStage: "adversarial_review" }, "reviewing", "adversary")?.status, "reviewing", "promotion into the last stage sets status=reviewing");
  }

  // #157: stagedTaskFolders() shipped a ReferenceError in 0.17.0 (`sep` was used
  // on the pre-commit path, never imported), which blocked every commit in every
  // project that had installed it. An import-walk cannot catch that — only
  // CALLING the function can. It returns a Set, or null where git is absent (the
  // publish workflow runs this self-test inside an unpacked tarball), never a throw.
  {
    const staged = stagedTaskFolders();
    assert.ok(staged === null || staged instanceof Set, "stagedTaskFolders returns a Set, or null without git — it must never throw");
  }

  // escapeHatchStats: the feedback loop for tasks that skipped every gate. The
  // cases that matter are the two dodges -- re-triaging to erase an escape, and
  // overwriting an "escaped" with a later "clean".
}

