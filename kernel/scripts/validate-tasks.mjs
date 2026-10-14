#!/usr/bin/env node
/**
 * validate-tasks.mjs — spec-harness task validator (project-agnostic).
 *
 * Turns the harness conventions (docs/Agents.md, docs/agents/SharedRules.md,
 * docs/tasks/README.md) into enforceable checks. Dependency-free (Node 22+).
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
 * Flags: --json, --no-warn, --quiet, --self-check, --preflight, --report, --writeback, --triage, --calibrate, --lite-check <file>, --config <path>,
 *        --staged (only task folders touched by the current git index),
 *        --task <folder> (only this one task folder — for per-gate use in /start-task)
 */

import { existsSync, mkdirSync as mkdirP, readFileSync, readdirSync, renameSync, rmSync, statSync, statfsSync, writeFileSync } from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
import { dirname, isAbsolute, join, matchesGlob, parse as parsePath, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash, createHmac, randomBytes } from "node:crypto";
import { homedir } from "node:os";
import { CAPABILITIES, CAP_HEADER, CAP_INDIRECT, CAP_PROOF, CAP_SIMULATED, capabilityRows, renderCapabilityMatrix } from "./capabilities.mjs";
import * as capabilities from "./capabilities.mjs";
import * as config from "./lib/config.mjs";
import { AC_REACHED, AC_TRACE, AC_TRACE_SINCE, CFG, CONFIG_FOUND, CONFIG_NAME, CONFIG_PATH, DOC_ENUMS, GATE4_ARTIFACTS, GATE4_DONE, GROUP_FIELD, GROUP_PREFIX, HANDOFF_BLOCK_CAP, LINE_CAPS, LINE_WARN, REPOS, REPO_ROOT, REQUIRED_AT_STAGE, ROLE_STAGE, ROUTING, SCHEMA_PATH, STAGE_ORDER, STAMP_LOG, STAMP_LOG_NAME, STAMP_SINCE, TASKS_DIR, needSliceBytes, needStampSince } from "./lib/config.mjs";
import * as docsMod from "./lib/docs.mjs";
import { UPDATE_HEADING, countLinesIn, handoffBlockCount, handoffDefects, handoffHalted, notesDefects, overBudgetAccepted, oversizedHandoffBlocks, questionDefects, rel, shippedBeforeRule, templateRowsBlock } from "./lib/docs.mjs";
import * as evidence from "./lib/evidence.mjs";
import { EVIDENCE_MODE, attestationDefects, liteDefects, treeCtx } from "./lib/evidence.mjs";
import * as gate5 from "./lib/gate5.mjs";
import { PREFILTER_SCRIPT, adversaryCoverageDefects, adversaryDefects, adversaryPrompt, adversaryRunVerdict, evidenceTableDefects, packBase, packParts, prefilterVerdict, stageContract } from "./lib/gate5.mjs";
import * as guard from "./lib/guard.mjs";
import { ASK_FORMATS, GUARD_MODES, REQUIRED_ASK, REQUIRED_DENY, askRulesFile, clineDeny, guardSubjects, guardVerdict, roleBashTargets, roleWriteVerdict } from "./lib/guard.mjs";
import * as lifecycle from "./lib/lifecycle.mjs";
import { advanceDecision, backdatedCreatedAt, bootstrapInputErrors, calibrate, findTaskFolders, firstCommitDate, isProtected, outcomeIsBlocking, promotion, stagedTaskFolders, strayTaskFolders, taskKeyOf } from "./lib/lifecycle.mjs";
import * as routing from "./lib/routing.mjs";
import { CLI_NAMES, TIER_ORDER, deriveComplexity, escapeHatchStats, netFsVerdict, resolveTier, staleTriageCalls, triage, triageMigrationHint, triageVectorFor, unmeasuredSliceBudgets, unroutedClis, vectorDriftSince, vectorEvidenceDefects, vectorInputErrors } from "./lib/routing.mjs";
import * as schemaMod from "./lib/schema.mjs";
import { validateSchema } from "./lib/schema.mjs";
import * as scope from "./lib/scope.mjs";
import { changedSince, contentSnapshot, dirtyPaths, gitAt, ignoredPaths, missingSlices, planSlices, scopeFiles, sliceBudget, sliceChanged, sliceOrderError, sliceScopeViolations, sliceSnapshot, undeclaredFiles } from "./lib/scope.mjs";
import * as telemetry from "./lib/telemetry.mjs";
import { KEY_FILE, budgetDefect, budgetSpent, cascadeDefects, contextBleed, dispatchGaps, ensureStampKey, lastChain, platformWhich, protectionVerdict, reportRows, restampLines, stampChainBreak, stampDefects, stampKey, stampLine } from "./lib/telemetry.mjs";
import * as trace from "./lib/trace.mjs";
import { acValueGaps, acsMissingFrom, declaredACs, gate1Defects, gate1IsOwed, hasRealEvidence, routeForUrl, routeMessage, vectorIsOwed } from "./lib/trace.mjs";
import * as wiring from "./lib/wiring.mjs";
import { ROLE_DIRS, adapterGaps, askGaps, codeownersGaps, denyGaps, findUpward, isolationWarning, keyMigratePlan, keyStoreAdvice, mcpGaps, ruleFloor, settingsReachable, statusMissing, unisolatedClis, writeBackDecision, writeBackRecordDefect } from "./lib/wiring.mjs";
// #139 lives in its own side-effect-free module: install.mjs --self-test imports it, and importing
// THIS file runs its main against the cwd's config, which a packed tarball does not have.
export { CAPABILITIES, CAP_HEADER, CAP_INDIRECT, CAP_PROOF, CAP_RUNS, CAP_SIMULATED, capState, capabilityRows, renderCapabilityMatrix } from "./capabilities.mjs";

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
// --task: validate EXACTLY ONE task folder. Gates 1-3 only have teeth if they
// can run RIGHT AFTER each stage, and the whole-repo scan is slow and noisy
// (another task sitting `blocked` on the BA would turn this task's gate red).
// Accepts both the full path (`docs/tasks/sprint-1/ABC-1-x`) and the short form
// (`sprint-1/ABC-1-x`) -- the coordinator already has $TASK in the former.
const taskFlagAt = argv.indexOf("--task");
const TASK_ARG = taskFlagAt !== -1 ? argv[taskFlagAt + 1] : null;

if (args.has("--guard")) {
  const cli = argv[argv.indexOf("--guard") + 1];
  const mode = GUARD_MODES[cli];
  // A typo here would otherwise be a guard that allows everything, silently.
  if (!mode) { console.error(`usage: --guard ${Object.keys(GUARD_MODES).join("|")}  (hook payload on stdin)`); process.exit(64); }
  const say = (o) => console.log(JSON.stringify(o));
  const allow = () => {
    if (mode === "cursor") say({});
    if (mode === "cline") say({ cancel: false });
    if (mode === "antigravity") say({ decision: "ask" });
    process.exit(0);
  };
  let input;
  // Fail OPEN on an unreadable payload: it means the CLI changed its hook
  // format, and failing closed there blocks every command until someone
  // disables the hook — the guardrail then stays gone for good.
  // A TTY stdin (run by hand) would block forever.
  try { input = JSON.parse(process.stdin.isTTY ? "" : readFileSync(0, "utf8")); } catch { allow(); }
  const deny = new Set(REQUIRED_DENY);
  const root = [input.cwd, input.workspaceRoots?.[0], input.workspacePaths?.[0], input.working_dir]
    .find((x) => typeof x === "string") ?? process.cwd();
  const settings = findUpward(join(".claude", "settings.json"), root);
  const ask = new Set(REQUIRED_ASK);
  if (settings) try {
    const perms = JSON.parse(readFileSync(settings, "utf8"))?.permissions;
    for (const r of perms?.deny ?? []) deny.add(r);
    for (const r of perms?.ask ?? []) ask.add(r);
  } catch {}
  const s = guardSubjects(input);
  // ponytail: a path key on ANY tool is checked as a read, so writing `.env`
  // is blocked too. Fail-safe on purpose; split by tool name if it bites.
  const hit = s.read.map((p) => guardVerdict("read", p, deny)).find(Boolean)
    ?? s.shell.map((c) => guardVerdict("shell", c, deny)).find(Boolean);
  if (!hit) {
    const q = s.shell.map((c) => guardVerdict("shell", c, ask)).find(Boolean);
    if (!q) allow();
    const why = `needs the user's yes: spec-harness ask rule ${q} (docs/Instructions.md §1) — only after the final gate (status = reviewing)`;
    if (ASK_FORMATS[cli]) { say(ASK_FORMATS[cli](why)); process.exit(0); }
    if (cli === "pi") { console.error(why); process.exit(3); }
    allow(); // no ask verdict in this CLI's schema: AGENTS.md prose holds
  }
  const why = `blocked by spec-harness deny rule ${hit} (docs/Instructions.md §1)`;
  if (mode === "cursor") say({ permission: "deny", user_message: why, agent_message: why });
  if (mode === "cline") { say(clineDeny(input, deny, why)); process.exit(0); }
  if (mode === "antigravity") { say({ decision: "deny", reason: why }); process.exit(0); }
  console.error(why);
  process.exit(2);
}

if (args.has("--guard-role")) {
  let input;
  // Fail open on an unreadable payload, same reason as --guard.
  try { input = JSON.parse(process.stdin.isTTY ? "" : readFileSync(0, "utf8")); } catch { process.exit(0); }
  const ti = input?.tool_input ?? {};
  const cfgAt = (d) => { try { return JSON.parse(readFileSync(join(d, "harness.config.json"), "utf8")); } catch { return null; } };
  const cwd = input?.cwd ?? process.cwd();
  const targets = typeof ti.command === "string" ? roleBashTargets(ti.command, cwd) : [ti.file_path ?? ti.notebook_path];
  for (const target of targets) {
    const why = roleWriteVerdict(target, cwd, cfgAt);
    if (!why) continue;
    console.error(`blocked: role ${input?.agent_type ?? "(read-only)"} writes only inside tasksDir — ${target} is ${why}. Scratch files go under /tmp/adv-<id>/ (spec-harness #53/#57)`);
    process.exit(2);
  }
  process.exit(0);
}

// #118: the config-missing exit lives here — after the two guard commands, which must work with no
// config at all, and before anything that reads one. Same message and exit code as before the split.
if (!CONFIG_FOUND) {
  console.error(
    `✖ ${CONFIG_NAME} not found (searched upward from ${process.cwd()}).\n` +
      `  Copy adapters/example/${CONFIG_NAME} to your project root and edit it.`,
  );
  process.exit(2);
}

// Allows checking a standalone settings.json (used by install.mjs --self-test):
// two places each re-listing the deny rules will drift, and that drift means
// shipping a settings.json that its own preflight calls red.
if (args.has("--check-settings")) {
  const f = argv[argv.indexOf("--check-settings") + 1];
  if (!f) { console.error("usage: --check-settings <settings.json>"); process.exit(2); }
  const t = readFileSync(f, "utf8"), gaps = [...denyGaps(t), ...askGaps(t)];
  gaps.forEach((g) => console.error(`✖ ${g}`));
  process.exit(gaps.length ? 1 : 0);
}

// --codex-rules [settings.json]: render REQUIRED_ASK ∪ the project's permissions.ask
// as a Codex execpolicy .rules file on stdout. install.mjs writes it to
// .codex/rules/; no settings.json arg = REQUIRED_ASK alone (fresh install, #105).
if (args.has("--codex-rules")) {
  const f = argv[argv.indexOf("--codex-rules") + 1];
  const ask = new Set(REQUIRED_ASK);
  if (f) try { for (const r of JSON.parse(readFileSync(f, "utf8"))?.permissions?.ask ?? []) ask.add(r); } catch {}
  process.stdout.write(askRulesFile([...ask]));
  process.exit(0);
}

if (args.has("--self-check")) {
  const { strict: rawAssert } = await import("node:assert");
  // #118: every assert goes through this counter, so a block of asserts that silently disappears in
  // a refactor is visible. The suite still passed while #139's 11 asserts were lost for a day during
  // the split — "it went green" is not the same as "it checked what it used to".
  let assertCount = 0;
  const assert = new Proxy(rawAssert, {
    get: (t, k) => (typeof t[k] === "function" ? (...a) => { assertCount++; return t[k](...a); } : t[k]),
  });
  // #118: a module without tests must not be able to look tested. Each must export selfCheck and must
  // actually run assertions, and every file in kernel/scripts/lib/ must appear below — that is what
  // catches "new module, no selfCheck" and "module quietly dropped off the list".
  // min = asserts that module's selfCheck is expected to run, measured on the maintainer's machine
  // minus 5, so a platform-conditional branch (keychain, git availability) cannot make it flaky. The
  // per-module floor is the point: the total floor below cannot see a dozen asserts deleted from one
  // module, and that is exactly how #139's block went missing.
  const kernels = { capabilities, config, docs: docsMod, evidence, gate5, guard, lifecycle, routing, schema: schemaMod, scope, telemetry, trace, wiring };
  const SC_MIN = { capabilities: 34, config: 13, docs: 120, evidence: 62, gate5: 62, guard: 82, lifecycle: 54, routing: 196, schema: 50, scope: 67, telemetry: 95, trace: 73, wiring: 77 };
  const onDisk = readdirSync(join(__dirname, "lib")).filter((f) => f.endsWith(".mjs")).map((f) => f.replace(".mjs", ""));
  for (const n of onDisk) if (!(n in kernels)) throw new Error(`kernel/scripts/lib/${n}.mjs is not run by --self-check — add it to the list and give it a selfCheck`);
  for (const [name, mod] of Object.entries(kernels)) {
    if (typeof mod.selfCheck !== "function") throw new Error(`kernel module ${name} exports no selfCheck — its asserts are unchecked`);
    const before = assertCount;
    await mod.selfCheck({ assert });
    const ran = assertCount - before;
    if (ran < (SC_MIN[name] ?? 1))
      throw new Error(`kernel module ${name}'s selfCheck ran ${ran} assertions, below its floor ${SC_MIN[name]} — a block of asserts was deleted; lower SC_MIN only with a reason`);
  }

  // Integration asserts live here, not in a leaf module: this one spawns the CLI against itself.
  {
    const r = spawnSync(process.execPath, [fileURLToPath(import.meta.url), "--task", "sprint-9/khong-co-that", "--quiet"],
      { cwd: REPO_ROOT, encoding: "utf8" });
    assert.equal(r.status, 2, "--task on a nonexistent folder must exit 2, never pass");
    assert.ok(/no task folder matching/.test(r.stderr), "and it must say why");
  }

  // Backstop over all modules (1024 on macOS). Stated ceiling: this catches a block or a whole module
  // being dropped, NOT a small block deleted inside one module — SC_MIN above is that one.
  const SC_FLOOR = Number(process.env.SPEC_HARNESS_SC_FLOOR ?? 920);
  if (assertCount < SC_FLOOR)
    throw new Error(`self-check ran only ${assertCount} assertions (floor ${SC_FLOOR}) — a block or a whole module was dropped; raise SPEC_HARNESS_SC_FLOOR only with a reason`);

  console.log("✅ validate-tasks self-check passed");
  process.exit(0);
}

if (args.has("--key-migrate")) {
  const plan = keyMigratePlan(process.platform);
  if (!plan) { console.error(`✖ --key-migrate: no supported keychain CLI on ${process.platform} — use SPEC_HARNESS_KEY from your CI/secret store instead`); process.exit(2); }
  if (process.env.SPEC_HARNESS_KEY || process.env.SPEC_HARNESS_KEY_CMD) { console.log("✔ key is already read from SPEC_HARNESS_KEY / SPEC_HARNESS_KEY_CMD — nothing to migrate"); process.exit(0); }
  let key; try { key = readFileSync(KEY_FILE(), "utf8").trim(); } catch { key = ""; }
  if (!key) { console.error(`✖ --key-migrate: no key file at ${KEY_FILE()} — nothing to migrate (run --advance once to create one)`); process.exit(1); }
  const [bin, a, input] = plan.store(key);
  const st = spawnSync(bin, a, { input, encoding: "utf8" });
  if (st.status !== 0) { console.error(`✖ --key-migrate: ${bin} failed (exit ${st.status}): ${(st.stderr || st.error?.message || "").trim()}\n  the key file was NOT touched`); process.exit(1); }
  const back = spawnSync(plan.readCmd, { shell: true, encoding: "utf8" });
  if (back.status !== 0 || back.stdout.trim() !== key) { console.error(`✖ --key-migrate: stored, but reading it back ${back.status !== 0 ? `failed (exit ${back.status})` : "returned a different value"} — the key file was NOT deleted`); process.exit(1); }
  if (args.has("--keep-file")) console.log(`✔ key stored in ${plan.tool} and verified; ${KEY_FILE()} kept (--keep-file)`);
  else { rmSync(KEY_FILE()); console.log(`✔ key stored in ${plan.tool}, read back identical, ${KEY_FILE()} deleted`); }
  console.log(`  add to your shell profile (and open a new terminal):\n  export SPEC_HARNESS_KEY_CMD='${plan.readCmd}'`);
  process.exit(0);
}

if (args.has("--writeback")) {
  const dir = argv[argv.indexOf("--writeback") + 1];
  const jp = dir && !dir.startsWith("--") ? join(resolve(dir), "task.agent.json") : null;
  if (!jp || !existsSync(jp)) { console.error("usage: validate-tasks.mjs --writeback <task-folder>"); process.exit(2); }
  const dec = writeBackDecision(JSON.parse(readFileSync(jp, "utf8")), CFG.tracker);
  // --statuses '<tracker status-list JSON>': checked before the coordinator moves anything.
  if (dec.do === "status" && argv.includes("--statuses")) {
    let st; try { st = JSON.parse(argv[argv.indexOf("--statuses") + 1]); } catch { console.error("✖ --statuses needs the tracker's status-list response as JSON"); process.exit(2); }
    const miss = statusMissing(st, dec.statusOnReview);
    if (miss) { console.error(`✖ --writeback: ${miss}\n  fix config.tracker.statusOnReview, then re-run — do not move the ticket`); process.exit(1); }
  }
  console.log(JSON.stringify(dec, null, 2));
  process.exit(0);
}

if (args.has("--report")) {
  const tasks = findTaskFolders(null).map((fo) => { try { return JSON.parse(readFileSync(join(fo.path, "task.agent.json"), "utf8")); } catch { return null; } }).filter(Boolean);
  const rows = reportRows(tasks, CFG.groupField ?? "sprintNumber");
  if (AS_JSON) { console.log(JSON.stringify({ tasksScanned: tasks.length, groups: rows }, null, 2)); process.exit(0); }
  const n = (x) => x.toLocaleString().padStart(11);
  console.log(`${(CFG.groupField ?? "group").padEnd(10)} ${"tasks".padStart(5)} ${"input".padStart(11)} ${"output".padStart(11)} ${"cache-read".padStart(11)} ${"retries".padStart(7)} ${"no-count".padStart(8)}`);
  for (const r of rows) console.log(`${r.group.padEnd(10)} ${String(r.tasks).padStart(5)} ${n(r.input)} ${n(r.output)} ${n(r.cacheRead)} ${String(r.retries).padStart(7)} ${String(r.uncollected).padStart(8)}`);
  console.log(`\n${tasks.length} task(s). input = fresh (input + cache-creation); cache-read priced apart. no-count = dispatches never run through collect-telemetry: their cost is NOT in the totals.`);
  process.exit(0);
}

if (args.has("--cost")) {
  // Source repo keeps the kernel under kernel/docs/; an installed project has it
  // at docs/. Same files, two layouts -- reading the wrong one silently reports
  // a 0 KB floor, which looks like good news.
  const docsDir = ["kernel/docs", "docs"]
    .map((d) => join(REPO_ROOT, d))
    .find((d) => existsSync(join(d, "Instructions.md")));
  if (!docsDir) {
    console.error("\u2716 --cost: cannot find Instructions.md under kernel/docs/ or docs/ \u2014 nothing to measure");
    process.exit(2);
  }
  const bytes = (f) => { try { return statSync(join(docsDir, f)).size; } catch { return 0; } };
  const readTask = (fo) => { try { return JSON.parse(readFileSync(join(fo.path, "task.agent.json"), "utf8")); } catch { return null; } };
  const roleDoc = (r) =>
    "agents/" + r.split("-").map((w) => w[0].toUpperCase() + w.slice(1)).join("").replace(/^Fsd/, "FSD") + ".md";
  const fl = ruleFloor({ read: bytes, roleDoc, roles: CFG.roles ?? [], roleStage: CFG.roleStage ?? {} });

  // Real dispatches, if anyone recorded them. This is the half that needs a
  // human to have filled telemetry in -- report it as measured or as absent,
  // never estimate it.
  // null, not the default: --cost reports the whole project, and --staged
  // narrowing it would make the same repo report different costs per commit.
  const tasks = findTaskFolders(null).map(readTask).filter(Boolean);
  const tel = tasks.flatMap((t) => t.telemetry ?? []).filter((e) => typeof e.inputTokens === "number");
  const withTel = tasks.filter((t) => (t.telemetry ?? []).some((e) => typeof e.inputTokens === "number")).length;

  if (AS_JSON) {
    console.log(JSON.stringify({
      floor: { baseBytes: fl.baseBytes, perTaskBytes: fl.perTask, stages: fl.stages, byStage: fl.byStage },
      measured: tel.length
        ? { dispatches: tel.length, tasks: withTel, totalInputTokens: tel.reduce((n, e) => n + e.inputTokens, 0),
            // Kept apart, never summed in: cache reads bill at roughly a tenth
            // and outnumber fresh input ~80:1, so one combined figure is wrong
            // by two orders of magnitude while looking entirely reasonable.
            totalCacheReadTokens: tel.reduce((n, e) => n + (e.cacheReadTokens ?? 0), 0),
            medianPerDispatch: tel.map((e) => e.inputTokens).sort((a, b) => a - b)[Math.floor(tel.length / 2)] }
        : null,
      tasksScanned: tasks.length,
    }, null, 2));
    process.exit(0);
  }

  const kb = (n) => `${(n / 1024).toFixed(1)} KB`;
  console.log(`\n── rule floor (read before any work, every dispatch) ──`);
  for (const b of fl.base) console.log(`  ${b.f.padEnd(24)} ${kb(b.bytes).padStart(9)}`);
  console.log(`  ${"= every dispatch pays".padEnd(24)} ${kb(fl.baseBytes).padStart(9)}\n`);
  for (const s of fl.byStage)
    console.log(`  ${s.stage.padEnd(20)} + ${s.role.padEnd(18)} ${kb(s.total).padStart(9)}`);
  console.log(`\n  ${fl.stages} stage(s) → ${kb(fl.perTask)} per task, before the task's own artifacts.`);
  console.log(`  Bytes, not tokens: tokenisation is vendor-specific and drifts between`);
  console.log(`  model versions. This number is for comparing releases, not for billing.`);

  console.log(`\n── measured (telemetry[].inputTokens) ──`);
  if (!tel.length)
    console.log(`  none in ${tasks.length} task(s). The coordinator records startedAt/endedAt per\n` +
                `  dispatch (/start-task step 6) and \`scripts/collect-telemetry.mjs <task> --write\`\n` +
                `  fills the counts in from the CLI's session log. Without it the floor above is\n` +
                `  the only cost signal, and "the strong tier is worth it" (Agents.md §5.3)\n` +
                `  stays unfalsifiable.`);
  else {
    const tot = tel.reduce((n, e) => n + e.inputTokens, 0);
    const sorted = tel.map((e) => e.inputTokens).sort((a, b) => a - b);
    console.log(`  ${tel.length} dispatch(es) across ${withTel} task(s)`);
    const cache = tel.reduce((n, e) => n + (e.cacheReadTokens ?? 0), 0);
    console.log(`  total ${tot.toLocaleString()} input tokens · median ${sorted[Math.floor(tel.length / 2)].toLocaleString()}/dispatch`);
    // Separate line, not a subtotal: cache reads bill at roughly a tenth, and
    // folding them in makes the number ~80x larger and no less believable.
    if (cache) console.log(`  plus ${cache.toLocaleString()} cache-read tokens (billed at roughly a tenth — priced apart, not added in)`);
    if (withTel < (CFG.calibrateMinSample ?? 5))
      console.log(`  ⚠ ${withTel} task(s) < ${CFG.calibrateMinSample ?? 5} — too few to conclude anything about cost`);
  }
  process.exit(0);
}

// ---------------------------------------------------------------------------
// Skipping the harness is a legitimate call. Skipping it without a trace is not,
// so --force appends the verdict, the vector and the reason to _triage.log.
// ---------------------------------------------------------------------------
// --tier: the one place the base table is read. The coordinator asks instead of
// transcribing a markdown table into a dispatch call -- the transcription step
// is where §5.3 and §5.3.1 were free to disagree with what actually ran.
// --route <url>: called by the UserPromptSubmit hook on every prompt, so it must
// be quiet and fast. Prints one line or nothing; exit 0 either way -- a hook that
// can fail a prompt is a hook people disable.
// --escape-outcome <taskId> <escaped|clean>: close the loop on a task that
// skipped the harness. Without it the riskFloor thresholds (§5.1.1) can never
// be wrong in a way anyone measures: the tasks they waved through leave no
// folder, so --calibrate cannot see them.
if (args.has("--escape-outcome")) {
  const at = argv.indexOf("--escape-outcome");
  const [taskId, result] = argv.slice(at + 1, at + 3);
  if (!taskId || !["escaped", "clean"].includes(result)) {
    console.error('✖ --escape-outcome needs: <taskId> <escaped|clean>');
    console.error("  escaped = a bug from this task reached someone else; clean = it did not");
    process.exit(2);
  }
  const logPath = join(TASKS_DIR, "_triage.log");
  // Refuse to record an outcome for a task that never took an escape hatch:
  // otherwise the denominator is whatever anyone typed, and coverage — the one
  // number that says whether the findings mean anything — becomes fiction.
  const known = existsSync(logPath)
    ? readFileSync(logPath, "utf8").split("\n").some((l) => {
        const c = l.split("\t");
        return c.length >= 5 && c[1] === taskId && ["quick-task", "fix-bug"].includes(c[2]);
      })
    : false;
  if (!known) {
    console.error(`✖ --escape-outcome: ${taskId} has no quick-task/fix-bug verdict in _triage.log — nothing to close the loop on`);
    process.exit(2);
  }
  // R6 (#80): "clean" is a claim about a task nothing else checked, so it has
  // to stand on the one artifact the escape hatch leaves. R7: "escaped" needs
  // nothing -- reporting a bug must never be harder than hiding one.
  if (result === "clean") {
    const dir = join(TASKS_DIR, "fixes");
    const file = existsSync(dir) && readdirSync(dir).find((f) => f.startsWith(`${taskId}-`) && f.endsWith(".md"));
    const d = file ? liteDefects(readFileSync(join(dir, file), "utf8"), treeCtx("reviewing")) : [`no ${relative(REPO_ROOT, dir)}/${taskId}-<slug>.md`];
    if (d.length) {
      console.error(`✖ --escape-outcome ${taskId} clean: the evidence does not pass --lite-check — ${d.join("; ")}`);
      process.exit(2);
    }
  }
  const { appendFileSync, mkdirSync } = await import("node:fs");
  mkdirSync(TASKS_DIR, { recursive: true });
  // vector column is "-" on purpose: triageVectorFor JSON.parses that column,
  // and a parseable value here would make an outcome row look like a triage.
  appendFileSync(logPath, `${new Date().toISOString()}\t${taskId}\toutcome\t${result}\t-\t\n`);
  console.log(`recorded: ${taskId} → ${result}`);
  process.exit(0);
}

// --lite-check <file> (#80): the escape hatch's gate, R5.
if (args.has("--lite-check")) {
  const f = argv[argv.indexOf("--lite-check") + 1];
  if (!f || !existsSync(f)) {
    console.error("✖ --lite-check needs an existing file: docs/tasks/fixes/<taskId>-<slug>.md");
    process.exit(2);
  }
  const d = liteDefects(readFileSync(f, "utf8"), treeCtx("reviewing"));
  for (const x of d) console.error(`✖ ${f}: ${x}`);
  if (!d.length) console.log(`✔ ${f}: evidence attested, last run green`);
  process.exit(d.length ? 1 : 0);
}

if (args.has("--route")) {
  const url = argv[argv.indexOf("--route") + 1] ?? "";
  let out = "";
  try {
    const tasks = [];
    if (existsSync(TASKS_DIR))
      for (const group of readdirSync(TASKS_DIR)) {
        const gdir = join(TASKS_DIR, group);
        if (!group.startsWith(GROUP_PREFIX) || !statSync(gdir).isDirectory()) continue;
        for (const folder of readdirSync(gdir)) {
          const f = join(gdir, folder, "task.agent.json");
          if (existsSync(f)) try { tasks.push(JSON.parse(readFileSync(f, "utf8"))); } catch {}
        }
      }
    out = routeMessage(routeForUrl(url, tasks));
  } catch {
    // A broken config or an unreadable folder must not break every prompt in the
    // session. Silence here costs a suggestion; throwing costs the session.
    out = "";
  }
  if (out) console.log(out);
  process.exit(0);
}

if (args.has("--tier")) {
  const at = argv.indexOf("--tier");
  const [role, complexity, attemptArg] = argv.slice(at + 1, at + 4);
  const attempt = attemptArg === undefined || attemptArg.startsWith("--") ? 1 : Number(attemptArg);
  // R1e: the same tier is a different model on each CLI, so the CLI is part of the question.
  const cli = argv.includes("--cli") ? argv[argv.indexOf("--cli") + 1] : null;
  const r = CLI_NAMES.includes(cli) ? resolveTier(role, complexity, attempt, CFG, cli)
    : { error: cli ? `--cli "${cli}" is not one of ${CLI_NAMES.join(", ")}` : "--cli <name> is required (models are declared per CLI)" };
  if (r.error) {
    console.error(`✖ --tier: ${r.error}`);
    console.error("  usage: validate-tasks.mjs --tier <role> <trivial|normal|high> [attempt] --cli <name>");
    process.exit(2);
  }
  // R2 (#81): name the exact key to add, not just that one is missing.
  if (!r.model) console.error(`⚠ --tier: harness.config.json has no models.${cli}.${r.tier}.model — dispatch with no model (session default). Add { "${cli}": { "cheap": { "model": "…" }, "mid": {…}, "strong": {…} } } under "models"`);
  if (AS_JSON) console.log(JSON.stringify({ role, complexity, attempt, ...r }));
  // Bare model name on stdout: the coordinator interpolates it straight into the
  // dispatch. `null` when config.models is empty -- print nothing, so a shell
  // substitution yields an empty flag rather than the string "null".
  else console.log(r.model ?? "");
  process.exit(0);
}

if (args.has("--contract")) {
  const st = argv[argv.indexOf("--contract") + 1];
  const c = stageContract(st);
  if (!c) { console.error(`✖ --contract: "${st}" is not a stage that produces output (${STAGE_ORDER.slice(0, -1).join(", ")})`); process.exit(2); }
  console.log(c);
  process.exit(0);
}

if (args.has("--pack")) {
  const at = argv.indexOf("--pack");
  const [taskArg, stage] = argv.slice(at + 1, at + 3);
  const flag = (n) => (argv.includes(n) ? argv[argv.indexOf(n) + 1] : null);
  const usage = (m) => { console.error(`✖ --pack: ${m}\n  usage: validate-tasks.mjs --pack <task-folder> <stage> [--base <ref>] [--slice S<n>]`); process.exit(2); };
  if (!taskArg || !stage || stage.startsWith("--")) usage("task folder and stage are required");
  const cap = (CFG.packCap ?? {})[stage], warn = CFG.packWarn;
  if (!Number.isInteger(cap) || !Number.isInteger(warn)) usage(`config.packCap.${stage} and config.packWarn (bytes) are required — no default`);
  const dir = resolve(taskArg), jp = join(dir, "task.agent.json");
  if (!existsSync(jp)) usage(`${jp} does not exist`);
  const data = JSON.parse(readFileSync(jp, "utf8"));
  const i = STAGE_ORDER.indexOf(stage);
  // implementation has two roles; routing picks one by branchType (feature → implementer, bugfix → fixer).
  const roleOf = (st) => (st === "implementation" ? CFG.routing?.map?.[data[CFG.routing.field]] : Object.keys(ROLE_STAGE).find((r) => ROLE_STAGE[r] === st));
  const role = roleOf(stage);
  // No pack for bootstrap: before it there is no task.agent.json to pack from.
  if (!role) usage(`"${stage}" is not a dispatched stage`);
  const D = join(REPO_ROOT, "docs"), rd = (p) => readFileSync(p, "utf8");
  const roleFile = readdirSync(join(D, "agents")).find((f) => f.endsWith(".md") && new RegExp("— role `" + role + "`").test(rd(join(D, "agents", f))));
  if (!roleFile) usage(`no docs/agents/*.md declares role \`${role}\``);
  const heavy = ["implementation", "adversarial_review"].includes(stage);
  const docs = { instructions: rd(join(D, "Instructions.md")), shared: rd(join(D, "agents/SharedRules.md")), roleFile: `docs/agents/${roleFile}`, role: rd(join(D, "agents", roleFile)),
    project: heavy && existsSync(join(D, "agents/ProjectRules.md")) ? rd(join(D, "agents/ProjectRules.md")) : "" };
  // Inputs = every file required up to this stage, minus the state file (the role edits it, not reads it whole).
  const artifacts = {};
  for (const r of REQUIRED_AT_STAGE) if (STAGE_ORDER.indexOf(r.stage) <= i) for (const f of r.files)
    if (f !== "task.agent.json" && existsSync(join(dir, f))) artifacts[f] = rd(join(dir, f));
  const prev = roleOf(STAGE_ORDER[i - 1]);
  let handoff = "";
  try { handoff = "### " + rd(join(dir, ".agent-memory", `${prev}.md`)).split(/^### /m).slice(1).pop(); } catch {}
  let git = null;
  if (stage === "adversarial_review") {
    const base = flag("--base");
    if (!base) usage("adversarial_review needs --base <target-branch> (the merge-base is taken against it)");
    const g = (...a) => { const r = spawnSync("git", a, { cwd: REPO_ROOT, encoding: "utf8" }); if (r.status !== 0) usage(`git ${a.join(" ")}: ${r.stderr.trim()}`); return r.stdout; };
    const mb = g("merge-base", base, "HEAD").trim();
    git = { base: mb.slice(0, 12), stat: g("diff", "--stat", mb), status: g("status", "--porcelain", "--untracked-files=all") };
  }
  // #67: a sliced implementation pack names the one slice this dispatch builds.
  const slice = flag("--slice");
  const packSlices = stage === "implementation" ? planSlices(artifacts["03-Technical-Plan.md"] ?? "").slices : [];
  // #68: a sliced plan packed whole is the one context slicing exists to prevent.
  if (!slice && packSlices.length) usage(`03 is sliced (${packSlices.join(", ")}) — pass --slice <one of them>`);
  if (slice) {
    const slices = packSlices;
    if (stage !== "implementation" || !slices.includes(slice)) usage(`--slice ${slice}: not a slice of 03 at implementation (${slices.join(", ") || "03 has no Slice column"})`);
    artifacts["03-Technical-Plan.md"] += `\n\n> **This dispatch builds slice ${slice} only** — the rows marked ${slice} above. Other slices are separate dispatches; do not touch their files.\n`;
  }
  const sliceOf = Object.fromEntries(Object.entries(planSlices(artifacts["03-Technical-Plan.md"] ?? "").files).flatMap(([x, fs]) => fs.map((f) => [f, x])));
  const p = packParts({ stage, role, attempt: (data.attempts ?? {})[stage] ?? 1, docs, artifacts, handoff, git, scope: scopeFiles(artifacts["03-Technical-Plan.md"]), contract: stageContract(stage) ?? "", sliceOf });
  const B = (s) => Buffer.byteLength(s);
  process.stdout.write(p.rules + "\n" + p.prose + "\n" + p.machine + "\n");
  console.error(`ℹ pack ${stage}: rules+prose ${B(p.rules) + B(p.prose)} B (cap ${cap}) · machine ${B(p.machine)} B (warn ${warn})`);
  if (B(p.machine) > warn) console.error(`⚠ --pack: machine part ${B(p.machine)} B > packWarn ${warn} — a diff this wide usually means the task should be split`);
  if (B(p.rules) + B(p.prose) > cap) { console.error(`✖ --pack: rules+prose ${B(p.rules) + B(p.prose)} B > packCap.${stage} ${cap} — the kernel or the artifacts grew; that is what this cap exists to catch`); process.exit(1); }
  process.exit(0);
}

// #103: a done task is shipped history — rebuilding its witness is exactly how a fake window
// would be laundered after the fact. Skipped unless --include-done says so out loud.
if (args.has("--restamp")) {
  if (existsSync(STAMP_LOG)) { console.error(`✖ --restamp: ${STAMP_LOG_NAME} exists — refusing to rewrite live witnesses (delete it yourself only if it is corrupt)`); process.exit(1); }
  const tasks = [], skipped = [], tasksFiles = [];
  if (existsSync(TASKS_DIR))
    for (const g of readdirSync(TASKS_DIR)) {
      const gd = join(TASKS_DIR, g);
      if (!g.startsWith(GROUP_PREFIX) || !statSync(gd).isDirectory()) continue;
      for (const f of readdirSync(gd)) {
        const jp = join(gd, f, "task.agent.json");
        if (!existsSync(jp)) continue;
        try {
          const j = JSON.parse(readFileSync(jp, "utf8"));
          if (j.status === "done" && !args.has("--include-done")) skipped.push(j.taskId); else { tasks.push(j); tasksFiles.push(jp); }
        } catch {}
      }
    }
  const text = restampLines(tasks, ensureStampKey());
  writeFileSync(STAMP_LOG, text.join(""));
  // #124: each rebuilt task's head is its LAST rebuilt line — otherwise the old head, which is in
  // a log that no longer exists, reads as "truncated" on every rebuilt task.
  for (const [i, jp] of tasksFiles.entries()) {
    const mine = text.filter((l) => l.split("\t")[1] === tasks[i].taskId);
    if (!mine.length) continue;
    const j = JSON.parse(readFileSync(jp, "utf8")); j.stampHead = mine.at(-1).trimEnd().split("\t")[8];
    writeFileSync(jp, JSON.stringify(j, null, 2) + "\n");
  }
  console.log(`✔ --restamp: ${text.length} line(s) from ${tasks.length} task(s) → ${rel(STAMP_LOG)} (col 7 "restamp", col 8 HMAC)`);
  if (skipped.length) console.log(`  skipped done task(s): ${skipped.join(", ")} — their windows stay unwitnessed; pass --include-done to rebuild them too`);
  process.exit(0);
}

if (args.has("--bootstrap")) {
  const raw = argv[argv.indexOf("--bootstrap") + 1];
  let o;
  try { o = JSON.parse(raw ?? ""); } catch { o = undefined; }
  const bad = o === undefined ? ["--bootstrap needs one JSON object argument"] : bootstrapInputErrors(o);
  if (bad.length) { console.error(`✖ --bootstrap rejected:\n  ${bad.join("\n  ")}`); process.exit(2); }
  const repo = (CFG.repos ?? []).find((r) => r.name === (o.repoName ?? CFG.repos[0].name));
  const git = (...a) => spawnSync("git", a, { cwd: resolve(REPO_ROOT, repo.path ?? "."), encoding: "utf8" }).stdout?.trim() ?? "";
  // #89: input wins, git is the fallback; neither → say which, instead of the schema's "too short".
  const developer = String(o.developer ?? "").trim() || git("config", "user.name");
  if (!developer) { console.error('✖ --bootstrap: no developer — pass "developer" in the JSON or set `git config user.name`'); process.exit(2); }
  const head = git("symbolic-ref", "--short", "HEAD"); // not rev-parse: that prints "HEAD" before the first commit
  // #92: ProjectRules §3 names the protected branches; config holds them as data, no default.
  if (!Array.isArray(CFG.protectedBranches) || !CFG.protectedBranches.length) { console.error("✖ --bootstrap: config.protectedBranches (regex list, e.g. [\"main\",\"develop\",\"release/.*\"]) is required — ProjectRules §3 as data"); process.exit(2); }
  if (isProtected(head)) { console.error(`✖ --bootstrap: the task repo is on protected branch "${head}" (config.protectedBranches) — branch off first (Orchestrator §2 #3)`); process.exit(1); }
  const rel = `${CFG.tasksDir ?? "docs/tasks"}/${GROUP_PREFIX}${o.sprintNumber}/${o.taskId}-${o.slug}/`;
  const dir = join(REPO_ROOT, rel), jp = join(dir, "task.agent.json");
  // Never clobber: the lease (step 0b) may already have created the folder, not the state file.
  if (existsSync(jp)) { console.error(`✖ --bootstrap: ${rel}task.agent.json already exists — resume the task, do not re-bootstrap it`); process.exit(1); }
  const { mkdirSync } = await import("node:fs");
  mkdirSync(join(dir, ".agent-memory"), { recursive: true });
  const complexity = deriveComplexity(o.complexity.vector).label;
  const now = new Date().toISOString().replace(/\.\d+Z$/, "Z");
  const fill = { taskId: o.taskId, taskName: o.taskName, trackerUrl: o.trackerUrl, sprintNumber: o.sprintNumber, developer, branchType: o.branchType, layer: repo.layer, taskComplexity: complexity };
  const tpl = join(TASKS_DIR, "_templates"), made = [];
  for (const f of readdirSync(tpl).filter((n) => /^\d\d-.*\.md$/.test(n)))
    if (!existsSync(join(dir, f)) && made.push(join(dir, f)))
      writeFileSync(join(dir, f), readFileSync(join(tpl, f), "utf8").replace(/\{(\w+)\}/g, (m, k) => (k in fill ? String(fill[k]) : m)).replaceAll("<repo>", repo.name));
  const routed = CFG.routing?.map?.[o.branchType];
  const impl = new Set(Object.values(CFG.routing?.map ?? {}));
  const data = {
    ...JSON.parse(readFileSync(join(tpl, "task.agent.json"), "utf8")),
    ...fill, repoName: repo.name, currentStage: STAGE_ORDER[1], status: "in_progress",
    branch: o.branch, branchActual: o.branchActual ?? (head && head !== o.branch ? head : ""), parentTaskId: o.parentTaskId ?? "",
    docsPath: rel,
    agents: Object.fromEntries((CFG.roles ?? []).map((r) => [r, { status: ROLE_STAGE[r] === STAGE_ORDER[0] ? "skipped" : impl.has(r) && r !== routed ? "not_applicable" : "pending" }])),
    attempts: { [STAGE_ORDER[0]]: 1 },
    complexity: { ...o.complexity, assessedAt: STAGE_ORDER[0] },
    createdAt: now.slice(0, 10), updatedAt: now,
  };
  writeFileSync(jp + ".tmp", JSON.stringify(data, null, 2) + "\n");
  renameSync(jp + ".tmp", jp);
  made.push(jp);
  const next = Object.keys(ROLE_STAGE).find((r) => ROLE_STAGE[r] === STAGE_ORDER[1]);
  const role = Object.keys(ROLE_STAGE).find((r) => ROLE_STAGE[r] === STAGE_ORDER[0]);
  const v = spawnSync(process.execPath, [fileURLToPath(import.meta.url), "--quiet", "--task", dir, "--config", CONFIG_PATH], { encoding: "utf8" });
  process.stdout.write(v.stdout);
  if (v.status !== 0) {
    // Roll back what THIS run wrote, so a re-run is not refused as "already exists".
    // .agent-memory stays: it may hold the lease.
    for (const p of made) rmSync(p, { force: true });
    process.stderr.write(v.stderr);
    console.error(`✖ --bootstrap: the folder it wrote does not validate — rolled back ${made.length} file(s); fix the input and re-run`);
    process.exit(1);
  }
  // After the verdict: a rolled-back run must not leave a handoff behind.
  writeFileSync(join(dir, ".agent-memory", `${role}.md`),
    `### ${now} — bootstrap (validate-tasks.mjs --bootstrap, no subagent)\n\n` +
    `- Inputs: tracker ${o.trackerUrl} · repo ${repo.name} on \`${head}\` · developer ${developer}\n` +
    `- Decisions: taskComplexity=${complexity} (derived from the vector) · branchType=${o.branchType} → ${routed}\n` +
    `- Files touched: ${rel} (templates, task.agent.json)\n` +
    `- Next agent: ${next}\n- Continue automation: yes\n`, { flag: "a" });

  console.log(`✔ bootstrapped ${rel} · taskComplexity=${complexity} · next: ${next}`);
  process.exit(0);
}

if (args.has("--run-adversary")) {
  const dir0 = argv[argv.indexOf("--run-adversary") + 1];
  const cmd = CFG.adversary?.cmd;
  if (!dir0 || dir0.startsWith("--")) { console.error("usage: validate-tasks.mjs --run-adversary <task-folder> [--timeout <s>]"); process.exit(2); }
  if (!cmd) { console.error('✖ --run-adversary: config.adversary.cmd is not set — e.g. "claude -p --agent adversary --permission-mode bypassPermissions" or "codex exec --dangerously-bypass-approvals-and-sandbox -"'); process.exit(2); }
  const dir = resolve(dir0), task = relative(REPO_ROOT, dir).split(sep).join("/");
  if (!existsSync(join(dir, "task.agent.json"))) { console.error(`✖ --run-adversary: no task.agent.json in ${dir0}`); process.exit(2); }
  const nineP = join(dir, "09-Adversarial-Review.md"), before = existsSync(nineP) ? readFileSync(nineP, "utf8") : null;
  const repo0 = resolve(REPO_ROOT, (REPOS[0] ?? {}).path ?? ".");
  const snapBefore = contentSnapshot(repo0);
  const t = Number(argv.includes("--timeout") ? argv[argv.indexOf("--timeout") + 1] : 1500) * 1000;
  console.log(`▶ Gate 5 in a fresh process: ${cmd}`);
  const r = spawnSync(cmd, { cwd: REPO_ROOT, shell: true, input: adversaryPrompt(task, packBase(dir)), encoding: "utf8", timeout: t, maxBuffer: 64 << 20, stdio: ["pipe", "inherit", "inherit"] });
  const tasksRel = relative(repo0, TASKS_DIR).split(sep).join("/") + "/";
  const srcChanged = changedSince(snapBefore, contentSnapshot(repo0)).filter((p) => !p.startsWith(tasksRel));
  const v = adversaryRunVerdict({ status: r.status, timedOut: r.error?.code === "ETIMEDOUT", nineBefore: before, nineAfter: existsSync(nineP) ? readFileSync(nineP, "utf8") : null, srcChanged });
  if (v.exit) { console.error(`✖ --run-adversary: ${v.why}`); process.exit(1); }
  // The verdict itself is the validator's job, as for every other role: Gate 5 reads 09.
  const g = spawnSync(process.execPath, [fileURLToPath(import.meta.url), "--task", dir, "--config", CONFIG_PATH], { encoding: "utf8" });
  process.stdout.write(g.stdout); process.stderr.write(g.stderr);
  console.log(`${g.status === 0 ? "✔" : "✖"} Gate 5 ran isolated (fresh process, paths-only prompt); validator exit ${g.status}`);
  process.exit(g.status ?? 1);
}

if (args.has("--advance")) {
  const at = argv.indexOf("--advance");
  const [taskArg, stage] = argv.slice(at + 1, at + 3);
  const cli = argv.includes("--cli") ? argv[argv.indexOf("--cli") + 1] : null;
  const usage = () => { console.error("  usage: validate-tasks.mjs --advance <task-folder> <stage> [--slice S<n>] [--cli <name>]"); process.exit(2); };
  if (!taskArg || !stage || taskArg.startsWith("--") || stage.startsWith("--")) { console.error("✖ --advance: task folder and stage are required"); usage(); }
  if (cli && !CLI_NAMES.includes(cli)) { console.error(`✖ --advance: --cli "${cli}" is not one of ${CLI_NAMES.join(", ")}`); usage(); }
  const dir = resolve(taskArg), jp = join(dir, "task.agent.json");
  // A path matching no task folder: the validator itself exits 2 (usage, below).
  // The gate: the same validator run the coordinator used to type by hand.
  const mem = join(dir, ".agent-memory");
  if (!existsSync(jp)) { console.error(`✖ --advance: no task.agent.json in ${taskArg}`); usage(); }
  const before = readFileSync(jp, "utf8");
  const continues = (r) => { try { return /Continue automation\s*\**\s*:\s*\**\s*yes\b/i.test(readFileSync(join(mem, `${r}.md`), "utf8").split(/^### /m).slice(1).pop() ?? ""); } catch { return false; } };
  const promoted = promotion(JSON.parse(before), stage, { continues });
  // Any non-zero exit below (gate FAIL, lease, slice budget…) rolls the promotion back.
  if (promoted) { writeFileSync(jp, JSON.stringify(promoted, null, 2) + "\n"); process.on("exit", (c) => { if (c !== 0) writeFileSync(jp, before); }); }
  const v = spawnSync(process.execPath, [fileURLToPath(import.meta.url), "--quiet", "--no-warn", "--task", dir, "--config", CONFIG_PATH], { encoding: "utf8" });
  if (v.status === 2) { process.stderr.write(v.stderr); usage(); }
  const data = JSON.parse(readFileSync(jp, "utf8"));
  const d = v.status === 1 ? { exit: 1, why: "validator: gate FAIL" }
    : advanceDecision(data, stage, { halted: (r) => handoffHalted(mem, r) });
  if (d.exit === 2) { console.error(`✖ --advance: ${d.why}`); usage(); }
  if (d.exit === 1) { if (v.stdout.trim()) process.stdout.write(v.stdout); console.error(`✖ --advance ${stage}: ${d.why}`); process.exit(1); }
  // #121: budget cap — first, before the pre-filter spends a paid call. Only a dispatch can overspend; a going-back re-run (no attempt) is already counted.
  const bud = d.attempt ? budgetDefect(data.telemetry, CFG.budget?.maxTokensPerTask) : null;
  const accept = argv.includes("--accept-over-budget") ? (argv[argv.indexOf("--accept-over-budget") + 1] ?? "") : null;
  if (bud && accept === null) { console.error(`✖ --advance ${stage}: ${bud}\n  a human decides: raise the cap in config, split the task, or re-run with --accept-over-budget "<reason>" (recorded in task.agent.json, valid for this one dispatch)`); process.exit(1); }
  if (bud && (!accept.trim() || accept.startsWith("--"))) { console.error("✖ --advance: --accept-over-budget needs a reason — an unexplained overrun is not reviewable"); process.exit(2); }
  // #109/#113: any dispatch, never a re-run that is going back. The script decides
  // per stage whether it has an opinion (unknown stage = exit 0); the kernel only
  // names the stage and reads the exit code.
  const slicePre = argv.includes("--slice") ? argv[argv.indexOf("--slice") + 1] : null;
  if (d.attempt && existsSync(join(__dirname, PREFILTER_SCRIPT()))) {
    const pf = prefilterVerdict(spawnSync(process.execPath, [join(__dirname, PREFILTER_SCRIPT()), dir, packBase(dir), stage], { cwd: REPO_ROOT, encoding: "utf8", timeout: 30000 }));
    if (pf.block) { console.error(`✖ --advance ${stage}: pre-filter FAIL (#109/#113) — ${stage} is not dispatched; send the task back to ${d.prev ?? "the previous role"}\n  ${pf.why.replace(/\n/g, "\n  ")}`); process.exit(1); }
  }
  // #115: Gate 5 is about to spend an adversary on a question a diff answers.
  // SR-002-D was sent back for a config change that was in neither 03 nor 06 —
  // finding F-01 was a set difference, not a judgement. Only when it is a first
  // dispatch of the stage (a re-run that is going back is already past this), and
  // only with real git: no git → no witness, no finding (fail-open, like #71).
  if (stage === "adversarial_review" && d.attempt && cli && unisolatedClis([cli], (x) => existsSync(join(REPO_ROOT, x))).length) console.error(`⚠ --advance: ${isolationWarning(cli)}`);
  if (stage === "adversarial_review" && d.attempt) {
    const repo0 = resolve(REPO_ROOT, (REPOS.find((x) => x.name === data.repoName) ?? REPOS[0] ?? {}).path ?? ".");
    const top = gitAt(repo0, "rev-parse", "--show-toplevel")?.trim();
    const mb = top && gitAt(repo0, "merge-base", packBase(dir), "HEAD")?.trim();
    if (top && mb) {
      const changed = [...new Set([...(gitAt(repo0, "diff", "--name-only", mb) ?? "").split("\n"), ...dirtyPaths(repo0), ...ignoredPaths(repo0)])].filter(Boolean);
      const rd0 = (f) => (existsSync(join(dir, f)) ? readFileSync(join(dir, f), "utf8") : "");
      const bad = undeclaredFiles({ changed, plan: rd0("03-Technical-Plan.md"), notes: rd0("06-Implementation-Notes.md"), tasksRel: relative(top, TASKS_DIR).split(sep).join("/") + "/" });
      if (bad.length) { console.error(`✖ --advance adversarial_review: changed but in neither 03 "Files to change" nor 06 "Plan Deviations": ${bad.join(", ")}\n  add each to 03 or declare it in 06 (name the path), or revert it — the adversary is not dispatched (#115)`); process.exit(1); }
    }
  }
  // #116: the pack cap is a gate, and it was only read when a role ran --pack.
  // Two real Gate 5 FAILs were "rules+prose over the cap", found AFTER a 54k-132k
  // token adversary round — and the second time the cap was raised to get past it.
  // Checking it here costs local file reads and fails before anything is written.
  // Only exit 1 (over the cap) blocks: exit 2 is --pack's own usage error and the
  // dispatch-shape checks above already own those cases.
  if (d.attempt) {
    const pk = spawnSync(process.execPath, [fileURLToPath(import.meta.url), "--pack", dir, stage, "--config", CONFIG_PATH,
      ...(stage === "adversarial_review" ? ["--base", packBase(dir)] : []), ...(slicePre ? ["--slice", slicePre] : [])],
      { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
    if (pk.status === 1) { process.stderr.write(pk.stderr); console.error(`✖ --advance ${stage}: the pack is over packCap.${stage} — split the task or trim the artifacts; raising the cap is how this became a Gate 5 FAIL twice (#116)`); process.exit(1); }
  }
  if (d.attempt) {
    const lease = spawnSync(process.execPath, [join(__dirname, "lease.mjs"), "renew", dir], { encoding: "utf8" });
    if (lease.status !== 0) { console.error(`✖ --advance: lease renew failed — ${lease.stderr.trim()} (step 0b acquires it)`); process.exit(1); }
  }
  const now = new Date().toISOString().replace(/\.\d+Z$/, "Z");
  needStampSince("--advance");
  const { appendFileSync } = await import("node:fs");
  const skey = ensureStampKey();
  const stamp = (e, kind) => {
    const line = stampLine(skey, [now, data.taskId, e.stage, e.attempt, e.slice ?? "-", kind], "-", lastChain(existsSync(STAMP_LOG) ? readFileSync(STAMP_LOG, "utf8") : ""));
    appendFileSync(STAMP_LOG, line);
    data.stampHead = line.trimEnd().split("\t")[8]; // #124: lets truncation of the tail be seen
  };
  data.telemetry ??= [];
  if (bud) (data.budgetAccepted ??= []).push({ at: now, stage, spent: budgetSpent(data.telemetry), reason: accept.trim() });
  // #71: closing a slice entry checks what that dispatch changed — before anything is written.
  const repoDir = resolve(REPO_ROOT, (REPOS.find((x) => x.name === data.repoName) ?? REPOS[0] ?? {}).path ?? ".");
  for (const e of data.telemetry) if (e.startedAt && !e.endedAt && e.slice && e.scopeSnap) {
    const now2 = sliceChanged(repoDir, e.scopeSnap);
    if (!now2) { console.error(`✖ --advance: cannot read git in ${repoDir} to check slice ${e.slice}'s scope`); process.exit(1); }
    const p3 = join(dir, "03-Technical-Plan.md");
    const allowed = planSlices(existsSync(p3) ? readFileSync(p3, "utf8") : "").files[e.slice] ?? [];
    const tasksRel = relative(now2.top, TASKS_DIR).split(sep).join("/") + "/";
    const bad = sliceScopeViolations({ snap: e.scopeSnap, changed: now2.changed, hash: now2.hash, allowed, skip: (p) => p.startsWith(tasksRel) });
    if (bad.length) {
      console.error(`✖ --advance: slice ${e.slice} changed files outside its 03 rows: ${bad.join(", ")}\n  add them to slice ${e.slice} in 03 Files to change, or revert them — nothing was written`);
      process.exit(1);
    }
  }
  for (const e of data.telemetry) if (e.startedAt && !e.endedAt) { e.endedAt = now; stamp(e, "end"); }
  let r = {};
  // S5c: a sliced plan dispatches implementation once per slice, and the slice is named.
  const slice = argv.includes("--slice") ? argv[argv.indexOf("--slice") + 1] : null;
  if (d.attempt && stage === "implementation") {
    needSliceBytes("--advance");
    const plan = join(dir, "03-Technical-Plan.md");
    const planText = existsSync(plan) ? readFileSync(plan, "utf8") : "";
    const { slices } = planSlices(planText);
    // #73/#77: bytes measured once, before the first implementation dispatch —
    // after that the files grow as they are built. Nothing is written on exit 1.
    if (!(data.telemetry ?? []).some((e) => e.stage === "implementation")) {
      const b = sliceBudget(CFG, cli, resolveTier(d.role, data.taskComplexity, 1, CFG, cli).tier);
      const code = resolve(REPO_ROOT, (REPOS.find((x) => x.name === data.repoName) ?? REPOS[0] ?? {}).path ?? ".");
      const over = planSlices(planText, b.bytes, (p) => { try { return statSync(join(code, p)).size; } catch { return 0; } }).errors.filter((x) => /sliceBytes/.test(x));
      if (over.length) { console.error(`✖ --advance implementation: budget ${b.bytes} B from ${b.from}${cli ? "" : " (no --cli: the per-model budget is not read)"}\n  ${over.join("\n  ")}\n  nothing was written`); process.exit(1); }
    }
    if (slices.length && !slices.includes(slice)) { console.error(`✖ --advance implementation: 03 is sliced (${slices.join(", ")}) — pass --slice <one of them>`); usage(); }
    if (!slices.length && slice) { console.error("✖ --advance: --slice given but 03 has no Slice column"); usage(); }
    // A slice's attempt = its earlier dispatches in telemetry (machine-written, witnessed by _stamp.log).
    if (slice) d.attempt = (data.telemetry ?? []).filter((e) => e.stage === "implementation" && e.slice === slice).length + 1;
    const order = slice && sliceOrderError(slices, data.telemetry, slice);
    if (order) { console.error(`✖ --advance implementation: ${order}`); process.exit(1); }
  } else if (slice) { console.error("✖ --advance: --slice only applies to implementation"); usage(); }
  // #69: Gate 5 (or step 7) with a slice never built is the whole diff in one context.
  if (STAGE_ORDER.indexOf(stage) > STAGE_ORDER.indexOf("implementation")) {
    const p3 = join(dir, "03-Technical-Plan.md");
    const miss = missingSlices(planSlices(existsSync(p3) ? readFileSync(p3, "utf8") : "").slices, data.telemetry);
    if (miss.length) { console.error(`✖ --advance ${stage}: 03 slice(s) ${miss.join(", ")} never dispatched — run --advance … implementation --slice ${miss[0]} first`); process.exit(1); }
  }
  if (d.attempt) {
    // Sliced: attempts.implementation = the worst slice's run count, so rework
    // readers (2c, --calibrate) see retries, not the planned one-run-per-slice.
    (data.attempts ??= {})[stage] = slice ? Math.max(data.attempts[stage] ?? 0, d.attempt) : d.attempt;
    r = resolveTier(d.role, data.taskComplexity, d.attempt, CFG, cli);
    if (r.error) { console.error(`✖ --advance: ${r.error}`); process.exit(2); }
    const scopeSnap = slice ? sliceSnapshot(repoDir) : null;
    if (slice && !scopeSnap) { console.error(`✖ --advance: cannot read git in ${repoDir} — a slice needs a scope snapshot`); process.exit(1); }
    data.telemetry.push({ stage, ...(slice ? { slice, scopeSnap } : {}), tier: r.model ? r.tier : "session-default", ...(r.model ? { model: r.model } : {}), attempt: d.attempt, startedAt: now });
    stamp(data.telemetry.at(-1), "start");
  }
  data.updatedAt = now;
  // SharedRules §6: temp file in the same dir, then rename — a crash never leaves half a JSON.
  writeFileSync(jp + ".tmp", JSON.stringify(data, null, 2) + "\n");
  renameSync(jp + ".tmp", jp);
  let handoff = "";
  try { handoff = "### " + readFileSync(join(mem, `${d.prev}.md`), "utf8").split(/^### /m).slice(1).pop(); } catch {}
  if (AS_JSON) console.log(JSON.stringify({ stage, role: d.role, attempt: d.attempt, tier: r.tier ?? null, model: r.model ?? null, handoff }));
  else {
    console.log(d.attempt ? `✔ dispatch ${stage}${slice ? ` ${slice}` : ""} → ${d.role} · attempt ${d.attempt} · ${r.tier}${r.model ? ` · model ${r.model}` : " · session model"}` : `✔ ${stage}: all gates passed`);
    if (handoff) console.log(`--- last handoff: .agent-memory/${d.prev}.md ---\n${handoff.trim()}`);
  }
  process.exit(0);
}

if (args.has("--triage")) {
  const at = argv.indexOf("--triage");
  let cx;
  try {
    cx = JSON.parse(argv[at + 1] ?? "");
  } catch {
    console.error("✖ --triage needs the complexity object as JSON: {vector, counts, questions} (Agents.md §5.1.2)");
    process.exit(2);
  }
  // #88: the same object --bootstrap takes, checked by the same rules. A bare
  // vector skipped the counts check, so triage could score scope 1 for one file;
  // bootstrap then forbade both the honest 0 (lower than triage) and the 1 (one
  // file), and the only way out was a re-triage that logged a harness task as an
  // escape hatch.
  if (cx === null || typeof cx !== "object" || !("vector" in cx)) {
    console.error(triageMigrationHint(cx));
    process.exit(2);
  }
  const vector = cx.vector;
  const flagVal = (name) => {
    const i = argv.indexOf(name);
    return i >= 0 ? argv[i + 1] : null;
  };
  const bad = vectorInputErrors(vector);
  if (!bad.length) bad.push(...vectorEvidenceDefects(cx).filter((d) => !/splitEvaluated/.test(d)));
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

if (args.has("--capabilities")) {
  // In an installed project the guard manifest is the honest source of what was written;
  // --guard <cli> in the file is the same literal string preflight checks.
  let manifest = {};
  try { manifest = JSON.parse(readFileSync(join(REPO_ROOT, ".agents/spec-harness-guards.json"), "utf8")); } catch {}
  // Same detection as --preflight: codex/cursor are installed outside the manifest.
  const installed = [...new Set([...Object.keys(manifest),
    ...["codex", "cursor"].filter((c) => existsSync(join(REPO_ROOT, `.${c}`))),
    ...(existsSync(join(REPO_ROOT, ".claude/agents")) ? ["claude"] : [])])];
  // What is ARMED on disk, per capability. Each flag answers "is the mechanism there", never "did
  // it work" — capState decides whether an armed mechanism is also simulated by the self-test.
  //   guardArmed   the hook file runs `--guard <cli>` — the deny-list (reset --hard, .env, git push)
  //   roleGuard    the role files carry the `--guard-role` hook — the out-of-scope WRITE sandbox.
  //                Different control, different wiring: it lives in `.claude/agents/*.md` front
  //                matter, which is Claude Code's own agent format. Codex gets its roles as
  //                developer_instructions in .toml with no hook field, so on Codex the "roles may
  //                only write inside tasksDir" rule is prose — the review asked exactly this kind of
  //                question, so it must not be answered by the deny-list's `armed` flag.
  //   roles        the CLI has its own native role files (ROLE_DIRS)
  // gateFailure/resumeAfterFail/roleDispatch are kernel-side (the validator and the stage→role
  // mapping, not the CLI), so they are armed wherever the kernel is installed. mcp has no
  // installable mechanism at all: the harness installs no MCP server — .mcp.json is the project's.
  const mechanisms = Object.fromEntries(installed.map((c) => {
    let guardArmed = false;
    try { guardArmed = !!manifest[c] && readFileSync(join(REPO_ROOT, manifest[c]), "utf8").includes(`--guard ${c}`); } catch {}
    if (["codex", "cursor", "claude"].includes(c)) guardArmed ||= existsSync(join(REPO_ROOT, `.${c === "claude" ? "claude" : c}`));
    const roles = !!(ROLE_DIRS[c] && existsSync(join(REPO_ROOT, ROLE_DIRS[c])));
    let roleGuard = false;
    try {
      roleGuard = readdirSync(join(REPO_ROOT, ".claude/agents")).filter((f) => f.endsWith(".md"))
        .some((f) => readFileSync(join(REPO_ROOT, ".claude/agents", f), "utf8").includes("--guard-role"));
    } catch {}
    return [c, {
      roleLoading: roles,
      dangerousCommand: guardArmed,
      outOfScopeWrite: c === "claude" && roleGuard,
      roleDispatch: Object.keys(ROLE_STAGE).length > 0, // the stage→role mapping is the mechanism
      gateFailure: true,
      resumeAfterFail: true,
      freshAdversary: !!CFG.adversary?.cmd,
      mcp: false,
    }];
  }));
  const rows = capabilityRows(CLI_NAMES, mechanisms);
  if (AS_JSON) { console.log(JSON.stringify({ rows, proof: CAP_PROOF, simulated: CAP_SIMULATED, indirect: CAP_INDIRECT }, null, 2)); process.exit(0); }
  console.log(`\n── capability matrix (${installed.length} CLI installed of ${CLI_NAMES.length} known) ──`);
  console.log(renderCapabilityMatrix(rows));
  console.log(`
  verified    a run against the REAL CLI is recorded on disk
  sim         install.mjs --self-test exercises the real code path with a synthetic payload or a
              fake agent — the harness side holds, the CLI side is untested
  mech        the file is installed and armed; nothing has ever been run against it
  UNVERIFIED  nothing to go on. This is the default. It is not a failure, and it is not a pass.`);
  console.log(`\n  What each cell would need to read "verified":`);
  for (const c of CAPABILITIES) console.log(`    ${CAP_HEADER[c].padEnd(12)} ${CAP_PROOF[c]}`);
  const foot = rows.filter((r) => r.indirect);
  if (foot.length) {
    console.log(`\n  Recorded runs that are real, but do not prove the cell's own claim:`);
    for (const r of foot) for (const [c, why] of Object.entries(r.indirect)) console.log(`    ${r.cli}/${CAP_HEADER[c]}: ${why}`);
  }
  console.log(`\n  Not installed here: ${CLI_NAMES.filter((c) => !installed.includes(c)).join(", ") || "—"} (UNVERIFIED, not broken).`);
  process.exit(0);
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
    errs.push(`${join(REPO_ROOT, ".claude/settings.json")} does not exist — re-run install.mjs; the deny-list on reset --hard / stash / clean is not installed`);
  else if (reach === "not-loaded")
    errs.push(
      `.claude/settings.json lives in ${REPO_ROOT} but the CLI is running in ${process.cwd()} — the CLI only walks UP, so it is not loaded and the deny-list on reset --hard / stash / clean and the push confirmation are gone.\n` +
        `    Open the CLI in ${REPO_ROOT}, or symlink .claude up (docs/advanced.md "B: cạnh các repo code").`,
    );
  // Present and loaded still says nothing about armed.
  const st = reach === "ok" ? readFileSync(join(REPO_ROOT, ".claude/settings.json"), "utf8") : "";
  if (reach === "ok")
    for (const gap of [...denyGaps(st), ...askGaps(st)]) errs.push(gap);

  // Codex/Cursor do not read permissions.deny: their deny-list is a hook. A CLI
  // layer present with the hook gone is the same failure as a missing settings.json.
  for (const [dir, file, flag] of [[".codex", ".codex/hooks.json", "--guard codex"], [".cursor", ".cursor/hooks.json", "--guard cursor"]]) {
    if (!existsSync(join(REPO_ROOT, dir))) continue;
    let t = ""; try { t = readFileSync(join(REPO_ROOT, file), "utf8"); } catch {}
    if (!t.includes(flag))
      errs.push(`${dir}/ exists but ${file} does not run \`validate-tasks.mjs ${flag}\` — on that CLI the deny-list on git push / reset --hard / .env is gone. Re-run the installer with --cli ${flag.split(" ")[1]}`);
  }
  // Every other CLI layer: install.mjs records cli → hook file. null = the CLI
  // has no project hook (hermes, amp) — nothing to check, by design.
  {
    let guards = {};
    try { guards = JSON.parse(readFileSync(join(REPO_ROOT, ".agents/spec-harness-guards.json"), "utf8")); } catch {}
    const installed = [...Object.keys(guards), ...["codex", "cursor"].filter((c) => existsSync(join(REPO_ROOT, `.${c}`)))];
    for (const c of unroutedClis(installed))
      warns.push(`${c} is installed but harness.config.json has no models.${c} — every role runs the session model on ${c}, no tier cascade on retry (Agents.md §5.3)`);
    // claude: .claude/ is always installed, so it never shows up in guards.json.
    for (const w of unmeasuredSliceBudgets(["claude", ...installed])) warns.push(w);
    {
      const has = (c) => spawnSync(platformWhich(), [c], { encoding: "utf8" }).status === 0;
      const adv = keyStoreAdvice({ has, keyFileExists: existsSync(KEY_FILE()) });
      if (adv) warns.push(adv);
    }
    if (!isSourceRepo) {
      const cf = [".github/CODEOWNERS", "CODEOWNERS", "docs/CODEOWNERS"].map((f) => join(REPO_ROOT, f)).find(existsSync);
      if (!cf) warns.push("no CODEOWNERS — anyone who can merge can edit harness.config.json / the validator / the CI workflow, i.e. turn any gate off. Install: `npx spec-harness --codeowners @your-team` (#133)");
      else { const gaps = codeownersGaps(readFileSync(cf, "utf8")); if (gaps.length) warns.push(`CODEOWNERS does not cover gate paths: ${gaps.join(", ")} — a change there needs no review (#133)`); }
    }
    for (const c of unisolatedClis(installed, (d) => existsSync(join(REPO_ROOT, d)))) warns.push(isolationWarning(c));
    for (const [cli, file] of Object.entries(guards)) {
      if (!file) continue;
      let t = ""; try { t = readFileSync(join(REPO_ROOT, file), "utf8"); } catch {}
      if (!t.includes(`--guard ${cli}`))
        errs.push(`${file} does not run \`validate-tasks.mjs --guard ${cli}\` — on ${cli} the deny-list on git push / reset --hard / .env is gone. Re-run the installer with --cli ${cli}`);
    }
  }

  // .mcp.json: a placeholder URL kills the CLI at startup, and a credential in
  // there is committed. Neither shows up until it is expensive.
  {
    const mcpPath = join(REPO_ROOT, ".mcp.json");
    if (isSourceRepo) {
      /* the source repo ships the template; it never runs against a tracker */
    } else if (!existsSync(mcpPath))
      warns.push(".mcp.json missing — no tracker MCP means Gate 1 has no source of AC (docs/advanced.md \"MCP server\")");
    else {
      const g = mcpGaps(readFileSync(mcpPath, "utf8"));
      errs.push(...g.errors);
      warns.push(...g.warnings);
    }
  }

  // #85: the adapter itself. The source repo ships the template, so it is exempt.
  if (!isSourceRepo) {
    const prp = join(REPO_ROOT, "docs/agents/ProjectRules.md");
    const g = adapterGaps(existsSync(prp) ? readFileSync(prp, "utf8") : null);
    if (!existsSync(prp)) errs.push("docs/agents/ProjectRules.md missing — re-run the installer, then /init-project-rules");
    errs.push(...g.errors);
    warns.push(...g.warnings);
    const gr = spawnSync("git", ["grep", "-n", "-I", "-e", "--triage", "--", ":!scripts/validate-tasks.mjs", ":!scripts/lib", ":!scripts/capabilities.mjs", ":!node_modules"], { cwd: REPO_ROOT, encoding: "utf8" });
    errs.push(...staleTriageCalls(gr.stdout));
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
    // Not under --json: this line is for a human reading the terminal, and
    // printing it before the JSON body makes the whole output unparseable --
    // which is exactly how a tool consuming --preflight --json finds out, at
    // the worst moment.
    else if (!QUIET && !AS_JSON) console.log(`ℹ kernel ${readFileSync(stamp, "utf8").split("\n")[0].trim()}`);
  }

  // #53, observed e2e (claude 2.1): an untrusted folder SKIPS subagent
  // frontmatter hooks, logged only to the debug log — the read-only roles then
  // write anywhere. Warning: ~/.claude.json is user state, not the repo's.
  {
    const { realpathSync } = await import("node:fs");
    const cj = join(homedir(), ".claude.json");
    if (!isSourceRepo && existsSync(join(REPO_ROOT, ".claude/agents/adversary.md")) && existsSync(cj)) {
      let trusted = null, seen = false;
      try {
        const p = JSON.parse(readFileSync(cj, "utf8")).projects ?? {};
        const ds = [REPO_ROOT, realpathSync(REPO_ROOT)];
        trusted = ds.some((d) => p[d]?.hasTrustDialogAccepted);
        seen = ds.some((d) => p[d]);
      } catch {}
      // #93: Claude never opened here + another CLI layer installed = probably not
      // a Claude user. Say it once as info, not a warning on every run.
      // ponytail: still a guess from ~/.claude.json; a pi user who later opens claude gets the warning then.
      const others = existsSync(join(REPO_ROOT, ".agents/spec-harness-guards.json")) || existsSync(join(REPO_ROOT, ".codex")) || existsSync(join(REPO_ROOT, ".cursor"));
      if (trusted === false && !seen && others) {
        if (!QUIET && !AS_JSON) console.log("ℹ Claude Code has never opened this folder — if you use it, accept the trust dialog once (adversary/fsd-reviewer write guard, #53)");
      } else if (trusted === false)
        warns.push("Claude Code has not trusted this folder — it silently skips the adversary/fsd-reviewer write guard (#53). Open `claude` here once and accept the trust dialog");
    }
  }

  if (!existsSync(TASKS_DIR)) errs.push(`tasksDir "${CFG.tasksDir}" does not exist (resolved: ${TASKS_DIR})`);
  else {
    // #100: probe, don't assume. Both reads are best-effort -- an unwritable or
    // exotic tasksDir must not turn preflight red over a diagnostic.
    let type, skewMs = 0;
    try { type = statfsSync(TASKS_DIR).type; } catch {}
    const probe = join(TASKS_DIR, `.fsprobe-${process.pid}`);
    try { writeFileSync(probe, ""); skewMs = statSync(probe).mtimeMs - Date.now(); } catch {}
    finally { try { rmSync(probe, { force: true }); } catch {} }
    const why = netFsVerdict({ platform: process.platform, type, skewMs });
    if (why.length)
      warns.push(
        `tasksDir is ${why.join(" and ")} — scripts/lease.mjs is only sound on a local filesystem (mkdir atomicity, mtime against the local clock).\n` +
          "    Two /start-task sessions on one task can both hold the lease and overwrite each other's handoff. Move tasksDir to a local disk.",
      );
  }
  for (const r of REPOS)
    if (!existsSync(resolve(REPO_ROOT, r.path)))
      errs.push(`repos[].path "${r.path}" does not resolve (tried ${resolve(REPO_ROOT, r.path)}) — agents cannot reach that repo`);

  // Optional layers: the README is explicit that both are optional, so these
  // stay warnings. They still cost you the gate that runs without being asked.
  const gitDir = findUpward(".git", REPO_ROOT);
  if (!gitDir) warns.push("not a git repo — no pre-commit hook, no CI, no history for task docs (docs/advanced.md \"Ghi chú cài đặt\")");
  else {
    const hookPath = spawnSync("git", ["rev-parse", "--git-path", "hooks/pre-commit"], { cwd: REPO_ROOT, encoding: "utf8" });
    const hook = hookPath.status === 0 ? resolve(REPO_ROOT, hookPath.stdout.trim()) : null;
    if (!hook || !existsSync(hook)) warns.push("no pre-commit hook — gates only run in CI, you find out later. Installed before `git init`? Re-run `npx spec-harness` to wire it");

    // CI is not optional, and calling it optional is how the gate ends up
    // running nowhere. The hook is deliberately --staged, so it cannot see a
    // broken task this commit does not touch, and `--no-verify` bypasses it
    // entirely. CI is the backstop both of those rely on; with no CI the
    // designed hole has nothing behind it.
    // Look for the validator in either CI system. The default MCP config points
    // at GitLab and build-and-mr is written for merge requests, so checking only
    // .github/workflows would report "no CI" to exactly the teams the harness
    // ships configured for -- and they would learn to ignore the error.
    const wfDir = join(REPO_ROOT, ".github/workflows");
    const ciFiles = [
      ...(existsSync(wfDir)
        ? readdirSync(wfDir).filter((f) => /\.ya?ml$/.test(f)).map((f) => join(wfDir, f))
        : []),
      join(REPO_ROOT, ".gitlab-ci.yml"),
    ];
    const runsValidator = ciFiles.some(
      (f) => existsSync(f) && readFileSync(f, "utf8").includes("validate-tasks.mjs"),
    );
    if (!runsValidator)
      errs.push(
        "no CI workflow runs validate-tasks.mjs \u2014 the pre-commit hook is --staged (blind to tasks this commit does not touch) and `--no-verify` skips it, so CI is the only gate left.\n" +
          "    GitHub: cp adapters/ci/validate-tasks.yml .github/workflows/\n" +
          "    GitLab: cp adapters/ci/.gitlab-ci.yml .",
      );
  }

  // #119: server-side gate. Asked through `gh` when it exists and origin is a GitHub repo; any
  // failure (no gh, no token, offline, other host) is "no opinion" -> a warning that says what to check.
  if (!isSourceRepo && !process.env.SPEC_HARNESS_NO_NET) {
    const url = spawnSync("git", ["remote", "get-url", "origin"], { cwd: REPO_ROOT, encoding: "utf8" }).stdout?.trim() ?? "";
    const m = /github\.com[:/]([^/]+\/[^/.]+?)(?:\.git)?$/.exec(url);
    if (m) {
      const gh = (path) => { const r = spawnSync("gh", ["api", path], { encoding: "utf8", timeout: 10000 }); return r.status === 0 ? r.stdout : r.error ? undefined : (/404/.test(r.stderr) ? null : undefined); };
      const head = spawnSync("git", ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"], { cwd: REPO_ROOT, encoding: "utf8" }).stdout?.trim().replace(/^origin\//, "") || "main";
      const c = gh(`repos/${m[1]}/branches/${head}/protection/required_status_checks`);
      const rl = gh(`repos/${m[1]}/rules/branches/${head}`);
      const parse = (t) => { try { return JSON.parse(t); } catch { return undefined; } };
      const classic = c === undefined ? undefined : c === null ? { contexts: [] } : parse(c);
      const rules = rl === undefined ? undefined : (parse(rl) ?? []).map((x) => x.type);
      const v = protectionVerdict({ classic: classic === undefined && rules === undefined ? null : classic, rules });
      if (v.ok === false) warns.push(`${m[1]}@${head}: ${v.why} — \`git commit --no-verify\` + a direct push skips every gate. Settings → Branches → require the validator check before merge (#119)`);
      else if (v.ok === null) warns.push(`could not verify branch protection on ${m[1]}@${head} (${v.why}) — check by hand that the validator is a required status check (#119)`);
    }
  }

  // docEnums is only a single source of truth if the places a human reads are
  // checked against it. They were not, and that is the whole reason the
  // template could teach `clarification / contradiction` for months while Gate 2
  // matched something else: nothing compared the two. Cheap to close now.
  for (const [file, label] of [
    [join(TASKS_DIR, "_templates/02-FSD-Review.md"), "template"],
    [join(REPO_ROOT, "docs/agents/FSDReviewer.md"), "FSDReviewer §3"],
    [join(REPO_ROOT, "kernel/docs/agents/FSDReviewer.md"), "FSDReviewer §3"],
  ]) {
    if (!existsSync(file)) continue;
    const text = readFileSync(file, "utf8");
    for (const [table, fields] of Object.entries(DOC_ENUMS))
      for (const [field, vals] of Object.entries(fields)) {
        if (!Array.isArray(vals)) continue; // blocksOn/unresolved are scalars
        const missing = vals.filter((v) => !new RegExp(`\`${v}\``).test(text));
        if (missing.length === vals.length) continue; // that table is not documented here
        if (missing.length)
          errs.push(
            `${rel(file)} (${label}) documents docEnums.${table}.${field} but omits ${missing.map((v) => `\`${v}\``).join(", ")} — a value an agent never sees is a value the gate will reject`,
          );
      }

    // Prose above the table is not what gets copied -- the EXAMPLE ROW is, and
    // that is exactly how `clarification / contradiction` survived: the note
    // said one thing, the row an agent fills in taught another. So check the
    // row's own choice-lists, independently of the surrounding words.
    const known = new Set(Object.values(DOC_ENUMS).flatMap((f) => Object.values(f).flat()));
    for (const line of text.split("\n")) {
      if (!/^\|\s*(?:AC|Q|R)-[A-Za-z0-9]+\s*\|/.test(line)) continue;
      // Split on UNESCAPED pipes only. Splitting on every "|" first would tear
      // `a \| b` into two cells and leave one alternative each, so nothing ever
      // looked like a choice-list and the whole check silently passed -- the
      // exact failure shape this check exists to catch.
      for (const cell of line.split(/(?<!\\)\|/).slice(1, -1)) {
        // Only cells written as "a \| b" or "a / b": those teach "pick one of".
        // A free-text or empty cell claims nothing and is left alone.
        const parts = cell.split(/\\\||\//).map((p) => p.trim().replace(/^`|`$/g, ""));
        if (parts.length < 2 || parts.some((p) => !/^[a-z][a-z-]*$/.test(p))) continue;
        const bad = parts.filter((p) => !known.has(p));
        if (bad.length)
          errs.push(
            `${rel(file)} (${label}) example row offers ${bad.map((v) => `\`${v}\``).join(", ")}, which is in no docEnums list — an agent copying this row writes a value the gate cannot read`,
          );
      }
    }
  }

  // Same lesson as docEnums, one field over: config.baseTier is only a single
  // source of truth if the tables a human (and an agent) reads are checked
  // against it. These tables route money -- a doc that says `cheap` where the
  // config says `mid` sends the coordinator to dispatch the wrong model, and
  // nothing downstream can tell the difference from a deliberate choice.
  for (const file of [
    join(REPO_ROOT, "kernel/docs/Agents.md"),
    join(REPO_ROOT, "kernel/docs/vi/Agents.md"),
    join(REPO_ROOT, "docs/Agents.md"),
    join(REPO_ROOT, "docs/vi/Agents.md"),
    join(REPO_ROOT, "commands/start-task.md"),
    join(REPO_ROOT, ".claude/commands/start-task.md"),
  ]) {
    if (!existsSync(file)) continue;
    for (const line of readFileSync(file, "utf8").split("\n")) {
      // A row is "| `role` | t | t | t |" -- the shape of the §5.3 table. Other
      // tables in these files do not have three tier words in a row, so an
      // accidental match cannot happen quietly.
      const m = /^\|\s*`?([a-z-]+)`?\s*\|([^|]+)\|([^|]+)\|([^|]+)\|/.exec(line);
      if (!m) continue;
      const row = (CFG.baseTier ?? {})[m[1]];
      if (!row) continue;
      const cells = [m[2], m[3], m[4]].map((c) => c.trim().replace(/`/g, ""));
      if (!cells.every((c) => TIER_ORDER.includes(c))) continue; // not the tier table
      if (cells.join(",") !== row.join(","))
        errs.push(
          `${rel(file)} §5.3 table says ${m[1]} = ${cells.join("/")} but config.baseTier says ${row.join("/")} — ` +
            "the doc is what a human reads and `--tier` is what dispatches; they cannot disagree",
        );
    }
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
// Main
// ---------------------------------------------------------------------------
// The schema ships without project-specific patterns; they are injected here so
// the shipped file stays generic and config stays the single source of truth.
const schema = JSON.parse(readFileSync(SCHEMA_PATH, "utf8"));
const esc = (x) => x.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
if (CFG.tracker?.urlPattern && schema.properties?.trackerUrl)
  schema.properties.trackerUrl.pattern = CFG.tracker.urlPattern;
// layer: the kernel ships no fixed value — a FE-only project declares ["frontend"],
// a BE or monorepo project declares its own. Without this the schema would reject
// every non-frontend task.
if (CFG.layers?.length && schema.properties?.layer)
  schema.properties.layer.enum = CFG.layers;
if (schema.properties?.docsPath)
  schema.properties.docsPath.pattern = `^${esc(CFG.tasksDir ?? "docs/tasks")}/${esc(GROUP_PREFIX)}.+/.+/?$`;
const ONLY = TASK_ARG ? new Set([taskKeyOf(TASK_ARG)]) : STAGED ? stagedTaskFolders() : null;
const folders = findTaskFolders(ONLY);

// A typo'd --task path matches no folder → "0 tasks, 0 errors" → a GREEN gate.
// A gate that silently passes because it found nothing to check is worse than
// no gate: it reports safety. --staged is different; empty there is legitimate
// (the commit touched no task).
if (TASK_ARG && !folders.length) {
  console.error(`✖ --task "${TASK_ARG}": no task folder matching "${taskKeyOf(TASK_ARG)}" under ${rel(TASKS_DIR)}`);
  console.error(`  expected layout: ${rel(TASKS_DIR)}/${GROUP_PREFIX}<n>/<taskId>-<slug>/`);
  const leaf = taskKeyOf(TASK_ARG).split("/").pop();
  const near = findTaskFolders(null).filter((f) => f.task.startsWith(leaf) || leaf.startsWith(f.task)).map((f) => rel(f.path));
  const stray = strayTaskFolders(TASKS_DIR, GROUP_PREFIX).filter((s) => s === leaf).map((s) => `${rel(TASKS_DIR)}/${s} (not under ${GROUP_PREFIX}<n>/ — move it)`);
  for (const n of [...near, ...stray]) console.error(`  did you mean: ${n}`);
  process.exit(2);
}
needStampSince("validate");
needSliceBytes("validate");
const results = []; // {folder, errors:[], warnings:[]}
if (!ONLY)
  for (const s of strayTaskFolders(TASKS_DIR, GROUP_PREFIX))
    results.push({ folder: rel(join(TASKS_DIR, s)), warnings: [], errors: [
      `task folder outside ${GROUP_PREFIX}<n>/ — no gate ever checks it. Move it to ${rel(TASKS_DIR)}/${GROUP_PREFIX}<n>/${s}/`] });
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

  // The field was called `clickupUrl` until 0.1.2 -- a vendor name baked into
  // the kernel schema, the same class of leak as `fe-*` roles and a hardcoded
  // doc language. Renaming it outright would fail every task file already on
  // disk, so accept the old name for one version and say so once per task.
  // Delete this block (and the alias) in 0.2.
  if (data.clickupUrl !== undefined && data.trackerUrl === undefined) {
    data.trackerUrl = data.clickupUrl;
    warnings.push(
      'task.agent.json uses `clickupUrl`, renamed to `trackerUrl` in 0.1.2 \u2014 ' +
        'still accepted, but dropped in 0.2. Rename the field (the value is unchanged).',
    );
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

  // 2a. createdAt: the switch that decides whether §5.1/§5.6 are errors or
  // warnings. Checked against git, because the field checks itself otherwise.
  {
    const bad = backdatedCreatedAt(data.createdAt, firstCommitDate(path));
    if (bad) errors.push(bad);
  }

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

    const triaged = triageVectorFor(join(TASKS_DIR, "_triage.log"), data.taskId);
    // No entry at all is not "nothing to compare" -- the whole cross-check is a
    // no-op then, and _triage.log is untracked, so deleting it was the cheapest
    // way to erase the comparison. Say it out loud instead of going quiet.
    if (!triaged && outcomeIsBlocking(data))
      warnings.push(existsSync(join(TASKS_DIR, "_triage.log"))
        ? `no _triage.log entry for ${data.taskId} — step 0 triage never ran for it, so the bootstrap vector has nothing to be cross-checked against (§5.1.3)`
        : `_triage.log is missing entirely — it is untracked, so a \`git clean\`, a worktree reset or an agent tidying "stray" files deletes it; ${data.taskId}'s bootstrap vector has nothing to be cross-checked against (§5.1.3, #84)`);
    const drift = vectorDriftSince(triaged, data.complexity.vector);
    if (drift.raised.length)
      warnings.push(
        `vector scored higher at bootstrap than at triage (${drift.raised.join(", ")}) — the lower score is what decided whether this task needed the harness (§5.1.3)`,
      );
    // Lowering is the direction §5.1.3 forbids: it buys a lighter gate and a
    // cheaper tier. "Only raise, never lower" — want it lower, go needs_clarification.
    if (drift.lowered.length)
      sink.push(
        `vector scored LOWER than at triage (${drift.lowered.join(", ")}) — §5.1.3 allows raising only; a lighter score buys a lighter gate and a cheaper tier. To lower it, go through needs_clarification`,
      );

    for (const d of vectorEvidenceDefects(data.complexity)) sink.push(d);

    // §5.1.3 makes the planner re-check the vector after surveying src/. When
    // the vector does not change, nothing on disk shows the re-check happened —
    // so the stage that most often finds the task is wider than advertised was
    // also the one stage nobody could tell had been skipped.
    if (
      STAGE_ORDER.indexOf(data.currentStage) > STAGE_ORDER.indexOf("technical_plan") &&
      (data.complexity.assessedAt ?? "bootstrap") === "bootstrap"
    )
      warnings.push(
        "complexity.assessedAt is still \"bootstrap\" past technical_plan — §5.1.3 requires the planner to re-check the vector against the src/ survey; set assessedAt:\"technical_plan\" once it has (raising only)",
      );
  } else if (vectorIsOwed(data.currentStage)) {
    (outcomeIsBlocking(data) ? errors : warnings).push(
      "complexity.vector missing — taskComplexity is an unchecked guess, and every downstream routing decision (gate weight, model tier, worktree) rests on it (Agents.md §5.1)",
    );
  }

  // 2c. Rework: a stage that ran more than twice means the gate kept bouncing it.
  // Not an error (sometimes the task is just hard) but it is the signal worth
  // reading when tuning prompts or splitting tasks.
  for (const [stage, n] of Object.entries(data.attempts ?? {}))
    if (n >= 3) warnings.push(`stage "${stage}" ran ${n}× — gate kept sending it back; worth a look`);

  // A schema field nobody fills is a field that does not exist. `telemetry` is
  // the only record of what a task COST, and by the time it reaches `reviewing`
  // every dispatch that could have been recorded has already happened -- there
  // is no later moment to catch it.
  //
  // Warning, not error: `tier`/`model` need a CLI that routes per subagent, and
  // `inputTokens` needs one that reports usage. Neither is universal, so a task
  // with no telemetry is incomplete, not invalid. But it is the reason
  // `--calibrate` and `--cost` have nothing to say, and that should be said out
  // loud once per task rather than discovered a quarter later.
  // writeBack enabled but nothing recorded = a setting that reads as on and does
  // nothing. The coordinator is the only actor that can call the tracker MCP, so
  // it is also the only one that can attest it did -- and `reviewing` is the last
  // moment anyone looks.
  if (data.currentStage === "reviewing" && (CFG.tracker?.writeBack ?? "off") !== "off" && !data.trackerWriteBack)
    warnings.push(
      `config.tracker.writeBack="${CFG.tracker.writeBack}" but task.agent.json has no \`trackerWriteBack\` record — ` +
        "the ticket was probably never updated, so the board and this folder disagree " +
        "(/start-task step 7 writes it after calling the tracker MCP)",
    );

  if (data.currentStage === "reviewing" && data.trackerWriteBack) {
    const wd = writeBackRecordDefect(data.trackerWriteBack, CFG.tracker);
    if (wd) warnings.push(wd);
  }

  if (data.currentStage === "reviewing" && !(data.telemetry ?? []).length)
    warnings.push(
      'telemetry is empty at stage "reviewing" — the coordinator appends one entry per dispatch ' +
        "(/start-task step 6). Without it `--calibrate` cannot weigh the strong tier against outcome, " +
        "and `--cost` sees only the static rule floor.",
    );

  // An entry without a window can never be costed: collect-telemetry.mjs matches
  // on cwd + branch + [startedAt, endedAt], and refuses to attribute anything
  // without one rather than billing a whole session to one stage. Say so while
  // the run is still fresh enough to fix.
  {
    const blind = (data.telemetry ?? []).filter(
      (e) => typeof e?.inputTokens !== "number" && !(e?.startedAt && e?.endedAt),
    );
    if (blind.length)
      warnings.push(
        `${blind.length} telemetry entr${blind.length === 1 ? "y has" : "ies have"} no startedAt/endedAt ` +
          `(${blind.map((e) => e.stage ?? "?").join(", ")}) — scripts/collect-telemetry.mjs matches on that window, ` +
          "so their cost can never be recovered",
      );
  }

  // R5/R5b/R5c (#65): a telemetry window with no _stamp.log witness was typed by hand.
  {
    const stText = existsSync(STAMP_LOG) ? readFileSync(STAMP_LOG, "utf8") : null;
    const sk = (() => { try { return stampKey(); } catch (e) { errors.push(e.message); return null; } })();
    const st = stampDefects(data.telemetry, stText, data.taskId, Date.now(), sk);
    // #124: the chain is a property of the whole log; reported per task that relies on it.
    if (stText !== null && sk && data.stampHead) {
      const br = stampChainBreak(stText, sk);
      if (br) errors.push(`${STAMP_LOG_NAME} ${br} (#124)`);
      // A chain alone cannot see the tail cut off; the head this task last wrote must still be in it.
      else if (!stText.includes(`\t${data.stampHead}\n`) && !stText.endsWith(`\t${data.stampHead}`))
        errors.push(`${STAMP_LOG_NAME} no longer contains the line this task last wrote (stampHead ${data.stampHead.slice(0, 12)}…) — the log was truncated or replaced (#124)`);
    }
    const witnessed = (data.createdAt ?? "") >= STAMP_SINCE;
    for (const e of st.errors) (witnessed || !/_stamp\.log/.test(e) ? errors : warnings).push(e);
    warnings.push(...st.warnings);
    // #110: …and the case with no windows to check at all.
    for (const g of dispatchGaps(data)) (witnessed ? errors : warnings).push(g);
    warnings.push(...dispatchGaps(data, { soft: true }));
  }

  // Model cascade: a retry that re-ran on a cheaper tier than the attempt it is
  // fixing. Errors here, because it is the same forbidden direction as lowering
  // the vector (§5.1.3) -- both make the next run cheaper by making it worse.
  {
    const c = cascadeDefects(data.telemetry);
    errors.push(...c.errors);
    warnings.push(...c.warnings);
  }

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
  const shippedOver = overBudgetAccepted(data);
  if (data.status === "split" && !splitAccepted)
    errors.push(
      `status=split requires splitInto with >=2 task IDs — a split with no children is just a rename for giving up (Agents.md §5.5)`,
    );
  const RETRY_BUDGET = CFG.retryBudget ?? 4;
  // S1–S5 (#67): the slice set comes from 03, the stage that owns the plan.
  const planP = join(path, "03-Technical-Plan.md");
  // #77: the byte budget is the dispatching model's, so --advance implementation
  // measures it (it knows --cli and the tier); here only the shape of the Slice column.
  const implTel = (data.telemetry ?? []).filter((e) => e?.stage === "implementation");
  const sliced = STAGE_ORDER.indexOf(data.currentStage) >= STAGE_ORDER.indexOf("implementation") && existsSync(planP)
    ? planSlices(readFileSync(planP, "utf8")) : { slices: [], files: {}, errors: [] };
  errors.push(...sliced.errors);
  // #73: slices dispatched, then the Slice column removed from 03 — the plan no longer says what was built where.
  if (!sliced.slices.length && implTel.some((e) => e.slice) && existsSync(planP))
    errors.push("implementation telemetry has slice dispatches but 03 no longer declares a Slice column — restore it; the per-slice scope and order checks read it");
  if (sliced.slices.length && STAGE_ORDER.indexOf(data.currentStage) >= STAGE_ORDER.indexOf("adversarial_review")) {
    // #69: the last-built slice's implementer moves currentStage on (its Gate 4 is
    // green), so before Gate 5 is dispatched a missing slice is still owed, not
    // skipped — warning. Once a later stage ran, it was skipped — error.
    const missing = missingSlices(sliced.slices, data.telemetry);
    const pastImpl = (data.telemetry ?? []).some((e) => STAGE_ORDER.indexOf(e?.stage) > STAGE_ORDER.indexOf("implementation"));
    if (missing.length) (pastImpl ? errors : warnings).push(`03 has slices ${sliced.slices.join(", ")} but implementation telemetry has no dispatch for ${missing.join(", ")} — ${pastImpl ? "a later stage already ran, so the diff was built in one context after all" : "dispatch it before adversarial_review"} (--advance … implementation --slice S<n>)`);
  }
  for (const role of CFG.roles ?? []) {
    const runs = handoffBlockCount(join(path, ".agent-memory"), role);
    const stage = (ROLE_STAGE ?? {})[role];
    // S5: sliced, the implementer writes one block per slice run — compare with
    // the slice dispatches in telemetry, and budget the worst single slice.
    const sliceTel = (data.telemetry ?? []).filter((e) => e.stage === "implementation" && e.slice);
    const sliceRuns = stage === "implementation" && sliced.slices.length ? sliceTel.length : null;
    const claimed = stage ? sliceRuns ?? (data.attempts ?? {})[stage] : undefined;
    if (claimed !== undefined && runs > claimed)
      warnings.push(
        `attempts["${stage}"]=${claimed} but .agent-memory/${role}.md has ${runs} handoff block(s) — rework is under-reported (Agents.md §5.5)`,
      );
    // S5: sliced, one implementer block per slice is the plan, not rework — the
    // budget is per slice, read from attempts["implementation:S<n>"].
    const perSlice = sliceRuns === null ? null : Math.max(0, ...sliced.slices.map((x) => sliceTel.filter((e) => e.slice === x).length));
    if ((perSlice ?? runs) >= RETRY_BUDGET)
      // status=split is that advice taken. Keeping it an error would leave the
      // task wedged -- append-only docs mean the blocks cannot be removed, and a
      // gate whose only exit is --no-verify is a gate on its way out.
      (splitAccepted || shippedOver ? warnings : errors).push(
        `${role} ran ${perSlice ?? runs}×${perSlice !== null ? " on one slice" : ""} (budget ${RETRY_BUDGET}) — ` +
          (splitAccepted
            ? `kept as history: this task was split into ${data.splitInto.join(", ")}`
            : shippedOver
              ? `kept as history: shipped over budget — ${data.outcome.overBudget}`
              : `the gate keeps bouncing it; split the task or fix the spec instead of retrying, or once shipped+closed write outcome.overBudget (Agents.md §5.5)`),
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
    const { open, unparsed } = questionDefects(join(path, AC_TRACE.declaredIn));
    if (unparsed.length)
      errors.push(
        `Gate 2: BA question row(s) ${unparsed.join(", ")} have a Type/Status the gate cannot read — it needs \`blocking\`/\`non-blocking\` + \`open\`/\`answered\`/\`deferred\` verbatim (docLanguage is prose only, SharedRules §5). Unreadable rows are invisible to Gate 2`,
      );
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

  // Gate 1, enforced. Same shape as the Gate 2 rule below: the artifact only
  // has to hold up once the stage that consumes it has started. `>=`, not `>`
  // -- fsd_review is the FIRST stage that reads 01-FSD.md, and exempting it
  // would let an empty FSD reach the reviewer, which is the whole failure.
  {
    const fsd = join(path, "01-FSD.md");
    if (existsSync(fsd) && gate1IsOwed(data.currentStage))
      for (const d of gate1Defects(readFileSync(fsd, "utf8"))) (shippedBeforeRule(data) ? warnings : errors).push(shippedBeforeRule(data) ? `${d} — kept as history: shipped before Gate 1 was enforced` : d);
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
    for (const { doc, fromStage, cell } of AC_REACHED) {
      const due = fromStage
        ? stageIdx >= STAGE_ORDER.indexOf(fromStage)
        : GATE4_DONE.has(data.status);
      if (!due) continue;
      const miss = acsMissingFrom(join(path, doc), declared, cell);
      if (miss.length)
        sink.push(
          `AC not traced into ${doc} (${miss.length}/${declared.length}): ${miss.join(", ")} — SharedRules §9.1`,
        );
    }
  }

  // #107: values the AC names must be asserted by its test (warning).
  if (declared.length && GATE4_DONE.has(data.status) && AC_TRACE.declaredIn && existsSync(join(path, GATE4_ARTIFACTS.evidence))) {
    const rd = (f) => { try { return readFileSync(resolve(REPO_ROOT, f), "utf8"); } catch { return null; } };
    for (const g of acValueGaps(readFileSync(join(path, AC_TRACE.declaredIn), "utf8"), readFileSync(join(path, GATE4_ARTIFACTS.evidence), "utf8"), rd)) warnings.push(g);
  }

  // #86/#87: unfilled template rows, checked from the first stage that READS the
  // artifact (06/08 at adversarial_review, 09 at reviewing). Tasks created before
  // acTrace.since stay warnings, like every other content rule added later.
  {
    const sink = templateRowsBlock(data) ? errors : warnings;
    const read = (n) => (n && existsSync(join(path, n)) ? readFileSync(join(path, n), "utf8") : null);
    if (stageIdx >= STAGE_ORDER.indexOf("adversarial_review") && STAGE_ORDER.includes("adversarial_review")) {
      const notes = read(GATE4_ARTIFACTS.notes), ev = read(GATE4_ARTIFACTS.evidence);
      if (notes !== null) for (const x of notesDefects(notes)) sink.push(`${GATE4_ARTIFACTS.notes}: ${x}`);
      if (ev !== null) for (const x of evidenceTableDefects(ev)) sink.push(`${GATE4_ARTIFACTS.evidence}: ${x}`);
    }
    const adv = GATE4_DONE.has(data.status) ? read(GATE4_ARTIFACTS.adversarial) : null;
    if (adv !== null) for (const x of adversaryCoverageDefects(adv, declared)) sink.push(`${GATE4_ARTIFACTS.adversarial}: ${x}`);
  }

  // 6. Gate-4 evidence when implementation is reported complete
  if (GATE4_DONE.has(data.status)) {
    const evName = GATE4_ARTIFACTS.evidence;
    const ev = join(path, evName);
    if (!existsSync(ev)) errors.push(`status=${data.status} but ${evName} missing`);
    else if (!hasRealEvidence(ev))
      errors.push(`${evName} has no real command+result evidence (Gate 4 honesty)`);
    if (existsSync(ev))
      for (const d of attestationDefects(readFileSync(ev, "utf8"), evName, EVIDENCE_MODE, treeCtx(data.status))) errors.push(d);
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
        // Gate 5 RE-RUNS the commands, so it must be attested too — otherwise the
        // adversary can still invent its own output and both gates go blind.
        for (const d of attestationDefects(advText, GATE4_ARTIFACTS.adversarial, EVIDENCE_MODE, treeCtx(data.status))) errors.push(d);
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
  // The escape hatches are half the routing decision, and until now --calibrate
  // was blind to them: a task waved through as quick-task has no folder, so it
  // is in neither the numerator nor the denominator above. A threshold can only
  // be wrong in a way someone notices if both branches report back.
  const esc = escapeHatchStats(existsSync(join(TASKS_DIR, "_triage.log")) ? readFileSync(join(TASKS_DIR, "_triage.log"), "utf8") : "", { ran: new Set(allTasks.map((t) => t.taskId)) });
  c.escapeHatch = esc;
  if (AS_JSON) console.log(JSON.stringify(c, null, 2));
  else {
    console.log(`\n── calibration · ${c.tasks} closed task(s) ──`);
    console.log(`   outcome coverage: ${c.coverage.withOutcome}/${c.coverage.shipped} shipped task(s)`);
    if (c.shortRuns?.n) console.log(`   short dispatches (<${(CFG.calibrateShortDispatchSeconds ?? 30)}s): ${c.shortRuns.n} — counted in attempts, probably not work (#114)`);
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

    if (esc.escapes) {
      console.log(`\n── escape hatches · ${esc.escapes} task(s) skipped the harness ──`);
      console.log(`   quick-task=${esc.byVerdict["quick-task"]}  fix-bug=${esc.byVerdict["fix-bug"]}`);
      console.log(`   outcome reported: ${esc.withOutcome}/${esc.escapes}  ·  shipped a bug: ${esc.escapedBugs}`);
      for (const f of esc.findings) console.log(`   • ${f}`);
      // "looks safe" must not be printed over a reported bug just because the
      // sample is too small to conclude from -- that is the sentence someone
      // quotes while raising the thresholds. Say which of the two it is.
      if (!esc.findings.length && esc.withOutcome)
        console.log(
          esc.escapedBugs
            ? `   ${esc.escapedBugs} bug(s) reported, but ${esc.escapes} escape(s) < ${CFG.calibrateMinSample ?? 5} — too few to conclude anything about riskFloor`
            : "   riskFloor looks safe so far",
        );
      console.log("\n   note: self-reported via `--escape-outcome <taskId> <escaped|clean>`.\n" +
        "   An escaped task leaves no artifact, so nothing on disk can contradict \"clean\".");
    }
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

// #129: NOT process.exit() — on a pipe stdout is async, and exit() drops whatever is still
// buffered. Measured at 500 tasks: `--json | …` arrived truncated at 65536 bytes (one pipe
// buffer) while `> file` wrote all 1.7 MB. exitCode lets Node flush, then leave.
process.exitCode = totalErr > 0 ? 1 : 0;
