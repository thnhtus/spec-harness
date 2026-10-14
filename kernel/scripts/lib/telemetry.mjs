import { spawnSync } from "node:child_process";
import { createHmac, randomBytes } from "node:crypto";
import { existsSync, mkdirSync as mkdirP, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { STAGE_ORDER, STAMP_LOG, STAMP_LOG_NAME } from "./config.mjs";
import { TIER_ORDER } from "./routing.mjs";
// #103: every _stamp.log line carries an HMAC (col 8) over cols 1-7, keyed by a per-install
// key OUTSIDE the repo (~/.spec-harness/stamp.key, or $SPEC_HARNESS_KEY_FILE). A line typed
// by an agent that only edits files in the repo has no valid signature. No key on this
// machine (CI, fresh clone) = signatures cannot be checked, so they are skipped, not failed.
// ponytail: an agent with a shell as the same OS user can still read the key and sign.
// Upgrade path: key held by a process the agent cannot read (keychain / CI secret).
export function KEY_FILE() { return process.env.SPEC_HARNESS_KEY_FILE || join(homedir(), ".spec-harness", "stamp.key"); }


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
export function contextBleed(telemetry = [], { minRuns = 4, growth = 2.5 } = {}) {
  // S5b: sibling slices are parallel fresh contexts, not a sequence — only the first
  // slice seen per stage stands for that stage, or 3 growing slices would read as bleed.
  const first = {};
  const t = telemetry.filter((e) => typeof e?.inputTokens === "number" && (!e.slice || (first[e.stage] ??= e.slice) === e.slice));
  // Two points are not a trend, and a CLI that reports no tokens must not be
  // guessed at.
  if (t.length < minRuns) return null;
  for (let i = 1; i < t.length; i++) if (t[i].inputTokens <= t[i - 1].inputTokens) return null;
  const lo = t[0].inputTokens, last = t.at(-1).inputTokens;
  if (!lo || last < lo * growth) return null;
  return { first: lo, last, runs: t.length, from: t[0].stage, to: t.at(-1).stage };
}


export function cascadeDefects(telemetry = []) {
  const errors = [], warnings = [];
  const byStage = {};
  for (const e of telemetry) {
    // session-default means the CLI cannot route per subagent at all -- there is
    // no tier to compare, and demanding one would fail every such run.
    if (!e?.stage || !TIER_ORDER.includes(e.tier)) continue;
    // S5b: slices of one stage are separate dispatches, each with its own retry ladder.
    (byStage[e.slice ? `${e.stage}:${e.slice}` : e.stage] ??= []).push(e);
  }
  for (const [stage, runs] of Object.entries(byStage)) {
    if (runs.length < 2) continue;
    // Without `attempt` the order is whatever the array happens to be, and a
    // cascade violation would be indistinguishable from an out-of-order append.
    if (runs.some((e) => !Number.isInteger(e.attempt))) {
      warnings.push(
        `telemetry for stage "${stage}" has ${runs.length} runs but not every entry has \`attempt\` — ` +
          "the cascade rule (§5.3.1) cannot be checked without it",
      );
      continue;
    }
    const sorted = [...runs].sort((a, b) => a.attempt - b.attempt);
    for (let i = 1; i < sorted.length; i++) {
      const prev = sorted[i - 1], cur = sorted[i];
      if (prev.attempt === cur.attempt) continue;
      const d = TIER_ORDER.indexOf(cur.tier) - TIER_ORDER.indexOf(prev.tier);
      if (d < 0)
        errors.push(
          `"${stage}" attempt ${cur.attempt} ran on "${cur.tier}" after attempt ${prev.attempt} ran on "${prev.tier}" — ` +
            "a retry may not drop tier (§5.3.1); the cheaper model already has the blind spot that caused the bounce",
        );
      else if (d === 0 && prev.tier !== TIER_ORDER.at(-1))
        warnings.push(
          `"${stage}" attempt ${cur.attempt} re-ran on the same tier "${cur.tier}" — ` +
            `§5.3.1 lifts a retry one notch (to "${TIER_ORDER[TIER_ORDER.indexOf(prev.tier) + 1]}"): the same tier has the same blind spots`,
        );
    }
  }
  return { errors, warnings };
}


// #121: per-task token cap. 0/absent = off. Counts fresh input + output as recorded in
// telemetry (collect-telemetry); cache reads bill ~1/10 and are priced apart, so excluded.
// ponytail: only dispatches whose tokens were collected count -- a dispatch with no
// collect-telemetry run is invisible here. Upgrade path: collect inside --advance.
export function budgetConfigError(b) {
  const m = b?.maxTokensPerTask ?? 0;
  return Number.isInteger(m) && m >= 0 ? null : `config.budget.maxTokensPerTask must be a non-negative integer (0 = off), got ${JSON.stringify(m)}`;
}

export function budgetSpent(telemetry = []) {
  return telemetry.reduce((n, e) => n + (typeof e?.inputTokens === "number" ? e.inputTokens + (e.outputTokens ?? 0) : 0), 0);
}

export function budgetDefect(telemetry, max) {
  if (!max) return null;
  const spent = budgetSpent(telemetry);
  return spent >= max ? `task has used ${spent.toLocaleString()} tokens (fresh input + output) ≥ budget.maxTokensPerTask ${max.toLocaleString()}` : null;
}

// Per-group rollup for --report. Pure so the self-check can pin the arithmetic.
export function reportRows(tasks, groupField) {
  const g = new Map();
  for (const t of tasks) {
    const k = String(t[groupField] ?? "-"), r = g.get(k) ?? { group: k, tasks: 0, input: 0, cacheRead: 0, output: 0, retries: 0, uncollected: 0 };
    r.tasks++;
    for (const e of t.telemetry ?? []) {
      if (typeof e.inputTokens === "number") { r.input += e.inputTokens; r.cacheRead += e.cacheReadTokens ?? 0; r.output += e.outputTokens ?? 0; }
      else r.uncollected++;
    }
    for (const n of Object.values(t.attempts ?? {})) r.retries += Math.max(0, n - 1);
    g.set(k, r);
  }
  return [...g.values()].sort((a, b) => a.group.localeCompare(b.group, undefined, { numeric: true }));
}


// #119: is the validator a REQUIRED check on the integration branch? Without it `--no-verify` + a
// direct push skips every gate. Pure: takes what the host returned, so the verdicts are assertable.
// classic = status of GET .../protection/required_status_checks (+ its contexts), rules = names of
// rule types from GET .../rules/branches/<b> (rulesets). null input = could not ask = no opinion.
export function protectionVerdict({ classic, rules }) {
  if (classic == null && rules == null) return { ok: null, why: "could not query the git host" };
  const names = [...(classic?.contexts ?? []), ...(classic?.checks ?? []).map((c) => c.context)];
  if (names.some((n) => /validate-tasks|spec-harness/.test(n))) return { ok: true };
  if ((rules ?? []).includes("required_status_checks")) return { ok: true, note: "ruleset requires status checks (names not verified)" };
  if (names.length) return { ok: false, why: `required checks are ${names.join(", ")} — none is the validator` };
  return { ok: false, why: "no required status check on the integration branch" };
}

// #119: key sources, strongest first. SPEC_HARNESS_KEY (CI secret) and SPEC_HARNESS_KEY_CMD
// (e.g. `security find-generic-password -s spec-harness-stamp -w`, `secret-tool lookup ...`) keep the
// key in a store the agent's file tools cannot read; the file stays the fallback so nothing
// that works today breaks. A CMD that fails or prints nothing is NOT silently downgraded to the
// file: you asked for a keychain, and signing with a different key would fail every verify later.
export function keyFrom({ env = process.env, run = (c) => spawnSync(c, { shell: true, encoding: "utf8", timeout: 10000 }), file = () => readFileSync(KEY_FILE(), "utf8") } = {}) {
  if (env.SPEC_HARNESS_KEY?.trim()) return env.SPEC_HARNESS_KEY.trim();
  if (env.SPEC_HARNESS_KEY_CMD) {
    const r = run(env.SPEC_HARNESS_KEY_CMD), k = (r.stdout ?? "").trim();
    if (r.status !== 0 || !k) throw new Error(`SPEC_HARNESS_KEY_CMD failed (exit ${r.status}) or printed nothing — not falling back to the key file: a different key would fail every signature check`);
    return k;
  }
  try { return file().trim() || null; } catch { return null; }
}

export function stampKey() { return keyFrom(); }

export const platformWhich = () => (process.platform === "win32" ? "where" : "which");

export function stampSig(key, cols) { return createHmac("sha256", key).update(cols.join("\t")).digest("hex"); }

export function stampLine(key, cols, mark = "-", prev) {
  const c = [...cols, mark], sig = stampSig(key, c);
  // #124 col 9: chains this line to the previous one, so a deleted/reordered/truncated line breaks
  // every later link. prev === undefined = no chain (pre-#124 caller); "" = first chained line.
  return `${c.join("\t")}\t${sig}${prev === undefined ? "" : `\t${stampChain(key, prev, sig)}`}\n`;
}


export function stampChain(key, prev, sig) { return createHmac("sha256", key).update(`${prev || "genesis"}\t${sig}`).digest("hex"); }

// The chain value the next appended line must link to: col 9 of the last line, or "" (start a chain).
export function lastChain(text = "") {
  const last = text.split("\n").filter(Boolean).at(-1)?.split("\t");
  return last?.length >= 9 ? last[8] : "";
}

// #124: null = intact. Lines before the first chained one are pre-#124 history and are accepted;
// from there on every line must chain to its predecessor. Truncation of the TAIL is invisible to
// a chain by itself, so the caller also compares against the head recorded in the task (see below).
export function stampChainBreak(text = "", key) {
  if (!key) return null;
  const lines = text.split("\n").filter(Boolean).map((l) => l.split("\t"));
  const first = lines.findIndex((c) => c.length >= 9);
  if (first < 0) return null;
  let prev = "";
  for (let i = first; i < lines.length; i++) {
    const c = lines[i];
    if (c.length < 9) return `line ${i + 1}: no chain column after chaining began at line ${first + 1} — a line was inserted by something other than --advance`;
    if (c[8] !== stampChain(key, prev, c[7])) return `line ${i + 1}: chain broken — a line before it was deleted, reordered or edited (chaining began at line ${first + 1})`;
    prev = c[8];
  }
  return null;
}

// First use creates the key. Lines written before it existed are signed once, here —
// otherwise turning signing on would invalidate every witness already in the log.
export function ensureStampKey() {
  const k = stampKey();
  if (k) return k;
  const f = KEY_FILE(), nk = randomBytes(32).toString("hex");
  mkdirP(dirname(f), { recursive: true });
  writeFileSync(f, nk + "\n", { mode: 0o600 });
  if (existsSync(STAMP_LOG))
    writeFileSync(STAMP_LOG, readFileSync(STAMP_LOG, "utf8").split("\n").filter(Boolean).map((l) => {
      const c = l.split("\t"); return stampLine(nk, c.slice(0, 6), c[6] ?? "-");
    }).join(""));
  return nk;
}


export function stampDefects(telemetry = [], stampText = "", taskId, now = Date.now(), key = null) {
  const errors = [], warnings = [];
  // #84: stampText === null = the FILE is gone, not this task's lines. One error
  // naming that (and who can delete an untracked file) beats N "no line" errors
  // that read as N hand-typed windows. Only the witness check is skipped.
  const gone = stampText === null && telemetry.some((e) => e?.startedAt);
  if (gone) errors.push(`${STAMP_LOG_NAME} is missing entirely (${telemetry.filter((e) => e?.startedAt).length} telemetry window(s) lost their witness) — it is untracked, so a \`git clean\`, a worktree reset or an agent tidying "stray" files deletes it; recover it (backup/other worktree) or re-run the stages (#84)`);
  const seen = new Set((stampText ?? "").split("\n").map((l) => l.split("\t")).filter((c) => c.length >= 6 && c[1] === taskId && (!key || (c.length >= 8 && c[7] === stampSig(key, c.slice(0, 7)))))
      .map(([ts, , stage, attempt, slice, kind]) => `${ts}|${stage}|${attempt}|${slice}|${kind}`));
  for (const e of telemetry) {
    if (!e?.startedAt) continue;
    const s = Date.parse(e.startedAt), en = Date.parse(e.endedAt ?? "");
    if (s > now + 60000) errors.push(`telemetry ${e.stage}#${e.attempt}: startedAt ${e.startedAt} is in the future`);
    if (Number.isFinite(en) && en < s) errors.push(`telemetry ${e.stage}#${e.attempt}: endedAt ${e.endedAt} is before startedAt ${e.startedAt}`);
    for (const [kind, ts] of [["start", e.startedAt], ["end", e.endedAt]])
      if (ts && !gone && !seen.has(`${ts}|${e.stage}|${e.attempt}|${e.slice ?? "-"}|${kind}`))
        errors.push(`telemetry ${e.stage}#${e.attempt}: ${kind === "start" ? "startedAt" : "endedAt"} ${ts} has no ${key ? "validly signed " : ""}_stamp.log line — only \`--advance\` writes telemetry; a hand-typed window is a guess`);
  }
  const timed = telemetry.filter((e) => e?.startedAt);
  if (timed.length >= 2 && timed.every((e) => /:00(\.0+)?Z$/.test(e.startedAt)))
    warnings.push(`every telemetry startedAt is on a whole minute (${timed.length} entries) — a machine clock almost never does that`);
  return { errors, warnings };
}


// #110: the hole stampDefects cannot see. It checks the telemetry windows that
// EXIST; a coordinator that never called `--advance` at all has none, so an
// empty array passed every signature rule and reached `reviewing` on a warning.
// Measured: a real 7-stage run did exactly that — 0 `--advance` calls, task.agent.json
// edited by hand each stage, so the lease was never renewed, no stage was gated,
// and the Gate 5 pre-filter (#109) never ran. `attempts` is the coordinator's own
// claim that a stage ran; every claimed stage must have the machine-written
// entry that goes with it. bootstrap is excluded: it is `--bootstrap`, which
// writes no telemetry by design.
export function dispatchGaps(data, { stages = STAGE_ORDER, soft = false } = {}) {
  const opts = { soft };
  // Judged at the handoff point only. Mid-flight, a stage can legitimately be
  // between its dispatch and its entry, and a fixture hand-built at some stage
  // is a valid object. `reviewing` is the last moment anyone looks, and the
  // moment the claim "all gates ran" is actually made. ponytail: a task
  // abandoned mid-flight keeps its skipped stages unreported — nobody reads it.
  if (data?.currentStage !== stages[stages.length - 1]) return [];
  const ran = Object.keys(data?.attempts ?? {}).filter((st) => st !== stages[0] && stages.includes(st));
  if (!ran.length) return [];
  const have = new Set((data.telemetry ?? []).map((e) => e.stage));
  const miss = ran.filter((st) => !have.has(st));
  if (!miss.length) return [];
  // Measured on 7 real tasks: stages before the FIRST telemetry entry missing
  // while every later stage is stamped = the coordinator joined --advance late
  // (first stage done inline). Hard only when nothing is stamped at all or the
  // hole sits after a stamped stage. ponytail: a coordinator that skips just the
  // first stage stays a warning; add when a real run shows it matters.
  const first = Math.min(...[...have].map((st) => stages.indexOf(st)).filter((i) => i >= 0));
  if (Number.isFinite(first) && miss.every((st) => stages.indexOf(st) < first))
    return opts.soft ? [`attempts claims ${miss.join(", ")} ran, but telemetry starts later — that stage was not dispatched through \`--advance\``] : [];
  if (opts.soft) return [];
  return [`attempts claims ${miss.join(", ")} ran, but telemetry has no entry for ${miss.length > 1 ? "them" : "it"} — only \`--advance\` writes telemetry, so ${miss.length > 1 ? "those stages were" : "that stage was"} never dispatched through the gate (no lease renew, no Gate 5 pre-filter, nothing validated between stages)`];
}


// --restamp (#102): rebuild a lost _stamp.log from telemetry. Re-running every stage is
// the only other recovery. Refuses while the log exists, so live witnesses are never rewritten.
// ponytail: whoever deletes the log and runs this launders hand-typed windows; the 7th
// column "restamp" keeps the rebuilt lines visible in audit. Same ceiling as _triage.log.
export function restampLines(tasks = [], key) {
  let prev = "";
  return tasks.flatMap((j) => (j.telemetry ?? []).flatMap((e) =>
    [["start", e?.startedAt], ["end", e?.endedAt]].filter(([, t]) => t)
      .map(([k, t]) => { const l = stampLine(key, [t, j.taskId, e.stage, e.attempt, e.slice ?? "-", k], "restamp", prev); prev = l.trimEnd().split("\t")[8]; return l; })));
}

// ── self-check: moved here with the logic it tests ──────────────────
export async function selfCheck({ assert }) {
  const { CFG } = await import("./config.mjs");
  const { handoffBlockCount, shippedBeforeRule, templateRowsBlock } = await import("./docs.mjs");
  const { PREFILTER_FAIL_EXIT, prefilterVerdict, targetBranch } = await import("./gate5.mjs");
  const { bootstrapInputErrors } = await import("./lifecycle.mjs");
  const { escapeHatchStats, resolveTier, triage, triageVectorFor } = await import("./routing.mjs");
  const { routeForUrl } = await import("./trace.mjs");
  {
    const S = ["bootstrap", "fsd_write", "implementation", "reviewing"];
    const g = (d) => dispatchGaps(d, { stages: S });
    const at = (o) => ({ currentStage: "reviewing", ...o });
    assert.deepEqual(g(at({ attempts: { bootstrap: 1 } })), [], "bootstrap writes no telemetry by design");
    assert.deepEqual(g(at({ attempts: { fsd_write: 1 }, telemetry: [{ stage: "fsd_write" }] })), [], "dispatched stage is silent");
    assert.match(g(at({ attempts: { fsd_write: 1, implementation: 1 }, telemetry: [] }))[0], /fsd_write, implementation/, "every skipped stage is named");
    assert.match(g(at({ attempts: { implementation: 2 }, telemetry: [{ stage: "fsd_write" }] }))[0], /implementation/, "another stage's entry does not cover it");
    assert.deepEqual(g(at({ attempts: { fsd_write: 1, implementation: 1 }, telemetry: [{ stage: "implementation" }] })), [], "late join: first stage inline is not a hard error");
    assert.match(dispatchGaps(at({ attempts: { fsd_write: 1, implementation: 1 }, telemetry: [{ stage: "implementation" }] }), { stages: S, soft: true })[0], /fsd_write/, "…but it is still a warning");
    assert.match(g(at({ attempts: { fsd_write: 1, implementation: 1 }, telemetry: [{ stage: "fsd_write" }] }))[0], /implementation/, "a hole AFTER a stamped stage stays an error");
    assert.deepEqual(g(at({})), [], "a task that claims nothing is the other rules' business");
    assert.deepEqual(g({ currentStage: "implementation", attempts: { fsd_write: 1 }, telemetry: [] }), [], "mid-flight is not judged: a fixture or a live task may legitimately look like this");
  }

  // #109: the pre-filter may only ever say "stop" by exiting 1; every other outcome is "no opinion".
  assert.deepEqual(prefilterVerdict({ status: PREFILTER_FAIL_EXIT(), stderr: "confident FAIL\n" }), { block: true, why: "confident FAIL" });
  assert.equal(prefilterVerdict({ status: PREFILTER_FAIL_EXIT(), stderr: "" }).why, "pre-filter says FAIL", "an empty reason still blocks");
  for (const [name, r] of [["exit 0", { status: 0 }], ["exit 1 = an uncaught throw in node", { status: 1 }], ["exit 2", { status: 2 }], ["crash", { status: 255 }], ["timeout/signal", { status: null, signal: "SIGTERM" }], ["spawn error", { status: null, error: new Error("ENOENT") }], ["undefined", undefined]])
    assert.equal(prefilterVerdict(r).block, false, `${name} must be fail-open`);
  // #116: the base both --pack and the pre-filter diff against comes from 00, not a guess.
  assert.equal(targetBranch("| Target branch | `develop` |"), "develop");
  assert.equal(targetBranch("| Target branch | release/2.0 |"), "release/2.0");
  assert.equal(targetBranch(""), "main", "no 00-Metadata → main, never a throw");

  // #115: a file changed but in neither 03's Files to change nor 06's Plan Deviations
  // is the scope-creep finding an adversary round used to be spent on.
  {
    const K = "k", row = (i) => ["2026-01-01T00:0" + i + ":00Z", "T-1", "impl", "1", "-", i % 2 ? "end" : "start"];
    const build = (n, legacy = 0) => { let t = "", prev = ""; for (let i = 0; i < n; i++) { const l = i < legacy ? stampLine(K, row(i)) : stampLine(K, row(i), "-", prev); if (i >= legacy) prev = l.trimEnd().split("\t")[8]; t += l; } return t; };
    const good = build(4);
    assert.equal(stampChainBreak(good, K), null, "an intact chain passes");
    assert.equal(lastChain(good), good.trimEnd().split("\n").at(-1).split("\t")[8]);
    const L = good.split("\n").filter(Boolean);
    assert.match(stampChainBreak([L[0], L[2], L[3]].join("\n") + "\n", K), /line 2: chain broken/, "deleting a middle line breaks the next link");
    assert.match(stampChainBreak([L[1], L[0], L[2], L[3]].join("\n") + "\n", K), /chain broken/, "reordering breaks it");
    assert.match(stampChainBreak(good + row(9).join("\t") + "\t-\tsig\n", K), /no chain column/, "an unchained line after chaining began = inserted by hand");
    assert.equal(stampChainBreak(build(5, 2), K), null, "pre-#124 lines (no col 9) before the chain are accepted history");
    assert.equal(stampChainBreak(build(3, 3), K), null, "a fully legacy log is not red");
    assert.equal(stampChainBreak([L[0], L[2]].join("\n"), null), null, "no key = cannot verify = skip, not fail");
    assert.equal(stampChainBreak([L[0], L[1]].join("\n") + "\n", K), null, "truncating the TAIL keeps the chain intact — that is what stampHead is for");
    assert.equal(restampLines([{ taskId: "T", telemetry: [{ stage: "s", attempt: 1, startedAt: "a", endedAt: "b" }, { stage: "s", attempt: 2, startedAt: "c" }] }], K).join("").split("\n").filter(Boolean).length, 3);
    assert.equal(stampChainBreak(restampLines([{ taskId: "T", telemetry: [{ stage: "s", attempt: 1, startedAt: "a", endedAt: "b" }] }], K).join(""), K), null, "--restamp writes a valid chain");
  }
  {
    const tel = [{ inputTokens: 100, outputTokens: 50 }, { stage: "no-count" }, { inputTokens: 10, cacheReadTokens: 9999 }];
    assert.equal(budgetSpent(tel), 160, "fresh input + output only; cache reads and uncollected dispatches add nothing");
    assert.equal(budgetDefect(tel, 160) !== null, true, "at the cap = blocked (>=), the next dispatch would only go past it");
    assert.equal(budgetDefect(tel, 161), null, "under the cap passes");
    assert.equal(budgetDefect(tel, 0), null, "0 = off");
    assert.equal(budgetDefect(tel, undefined), null, "absent = off");
    const rows = reportRows([
      { sprintNumber: 1, attempts: { implementation: 3, fsd_write: 1 }, telemetry: [{ inputTokens: 5, cacheReadTokens: 50, outputTokens: 2 }, { stage: "x" }] },
      { sprintNumber: 1, telemetry: [{ inputTokens: 1, outputTokens: 1 }] },
      { sprintNumber: 10 }, { sprintNumber: 2 },
    ], "sprintNumber");
    assert.deepEqual(rows.map((r) => r.group), ["1", "2", "10"], "numeric group order, not 1,10,2");
    assert.deepEqual(rows[0], { group: "1", tasks: 2, input: 6, cacheRead: 50, output: 3, retries: 2, uncollected: 1 });
  }

  // handoffBlockCount: the independent measure of rework.
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

  // resolveTier: the §5.3 table + the §5.3.1 cascade, as one function. The point
  // is that nobody transcribes a markdown table into a dispatch call any more,
  // so the cases that matter are the ceiling and the refusal to guess.
  {
    const e1 = { stage: "fsd_write", attempt: 1, startedAt: "2026-09-29T01:02:03Z", endedAt: "2026-09-29T01:09:07Z" };
    const log = "2026-09-29T01:02:03Z\tA-1\tfsd_write\t1\t-\tstart\n2026-09-29T01:09:07Z\tA-1\tfsd_write\t1\t-\tend\n";
    const now = Date.parse("2026-09-29T02:00:00Z");
    assert.deepEqual(stampDefects([e1], log, "A-1", now), { errors: [], warnings: [] }, "a witnessed window is clean");
    assert.equal(stampDefects([e1], log.split("\n")[0], "A-1", now).errors.length, 1, "R5: an endedAt with no end line is an error");
    assert.equal(stampDefects([e1], log, "B-2", now).errors.length, 2, "R5: another task's lines witness nothing");
    assert.equal(stampDefects([{ ...e1, attempt: 2 }], log, "A-1", now).errors.length, 2, "R5: the attempt is part of the witness");
    assert.equal(stampDefects([{ ...e1, stage: "fsd_review" }], log, "A-1", now).errors.length, 2, "R5: the stage is part of the witness");
    assert.ok(stampDefects([e1], log, "A-1", Date.parse("2026-09-29T00:00:00Z")).errors.some((x) => /future/.test(x)), "R5b: startedAt in the future");
    assert.ok(stampDefects([{ ...e1, endedAt: "2026-09-29T01:00:00Z" }], log, "A-1", now).errors.some((x) => /before startedAt/.test(x)), "R5b: endedAt before startedAt");
    const round = [{ stage: "a", attempt: 1, startedAt: "2026-09-29T01:02:00Z" }, { stage: "b", attempt: 1, startedAt: "2026-09-29T01:05:00Z" }];
    assert.equal(stampDefects(round, "", "A-1", now).warnings.length, 1, "R5c: all whole minutes is a warning");
    assert.equal(shippedBeforeRule({ status: "done", outcome: { closedAt: "x" } }), true, "done + closed = shipped, Gate 1 is history");
    assert.equal(shippedBeforeRule({ status: "done", outcome: {} }), false, "done without closedAt is not closed");
    assert.equal(shippedBeforeRule({ status: "reviewing", outcome: { closedAt: "x" } }), false, "only done counts");
    const fresh = { createdAt: "2999-01-01" };
    assert.equal(templateRowsBlock(fresh), true, "a new task's template rows block");
    assert.equal(templateRowsBlock({ ...fresh, status: "done", outcome: { closedAt: "x" } }), false, "a shipped + closed task's template rows are history");
    assert.equal(templateRowsBlock({ createdAt: "1999-01-01" }), false, "before acTrace.since stays a warning");
    const gone = stampDefects([e1, { ...e1, attempt: 2 }], null, "A-1", now).errors;
    assert.equal(gone.length, 1, "#84: a missing log is ONE error, not one per window");
    assert.match(gone[0], /missing entirely.*2 telemetry window/, "#84: the error names the file, the count and the cause");
    assert.deepEqual(stampDefects([], null, "A-1", now).errors, [], "#84: no telemetry yet → a missing log is not a defect");
    const K = "k1", signed = restampLines([{ taskId: "A-1", telemetry: [e1] }], K).join("");
    assert.deepEqual(stampDefects([e1], signed, "A-1", now, K).errors, [], "#102/#103: a rebuilt, signed log witnesses every window");
    assert.equal(stampDefects([e1], signed, "A-1", now, "other").errors.length, 2, "#103: a line signed by another key witnesses nothing");
    assert.equal(stampDefects([e1], log, "A-1", now, K).errors.length, 2, "#103: an unsigned (hand-appended) line witnesses nothing once a key exists");
    assert.equal(stampDefects([e1], signed.replace("\tstart\t", "\tend\t"), "A-1", now, K).errors.length, 1, "#103: editing a signed line breaks its signature");
    assert.deepEqual(stampDefects([e1], signed, "A-1", now, null).errors, [], "#103: no key on this machine (CI) → signatures skipped, columns still matched");
    assert.equal(stampDefects([round[0], e1], "", "A-1", now).warnings.length, 0, "R5c: one real second clears it");
    assert.ok(/^\d{4}-\d{2}-\d{2}$/.test(CFG.stampSince ?? ""), "S6: config.stampSince is required (YYYY-MM-DD)");
  }

  // bootstrapInputErrors (#64): R2 — every required field refused on its own.
  {
    const row = (id, v, flag = "-", vec = "-") => `2026-01-01T00:00:00Z\t${id}\t${v}\t${flag}\t${vec}\t\n`;
    const s = (text, o) => escapeHatchStats(text, { minSample: 2, ...o });

    assert.equal(s("").escapes, 0, "an empty log says nothing");
    assert.equal(s(row("A-1", "harness", "-", '{"scope":2}')).escapes, 0, "a harness verdict is not an escape");
    assert.equal(s(row("A-1", "quick-task", "-", '{"scope":0}')).escapes, 1, "quick-task counts as an escape");
    assert.equal(s(row("B-2", "fix-bug", "-", '{"scope":0}')).byVerdict["fix-bug"], 1, "fix-bug counts separately");
    assert.equal(s(row("A-1", "quick-task", "-", '{"scope":0}'), { ran: new Set(["A-1"]) }).escapes, 0, "#88: a task that has a folder ran the harness — not an escape");

    // Re-triaging must not erase the run that actually skipped the gates --
    // same reason triageVectorFor keeps the lowest vector.
    assert.equal(
      s(row("A-1", "quick-task") + row("A-1", "harness", "-", '{"scope":2}')).escapes,
      1,
      "a later harness verdict does not undo the escape that already happened",
    );
    // Two DIFFERENT escape verdicts is what makes first-wins load-bearing: the
    // case above never re-enters the branch, so it passed with the guard
    // deleted. Found by mutation-testing, not by reading it.
    assert.equal(
      s(row("A-1", "quick-task") + row("A-1", "fix-bug")).byVerdict["quick-task"],
      1,
      "the first escape verdict is the one that skipped the gates",
    );

    // Coverage, before any conclusion.
    const none = s(row("A-1", "quick-task") + row("B-2", "quick-task"));
    assert.equal(none.withOutcome, 0, "no outcome rows yet");
    assert.ok(none.findings[0]?.includes("coverage"), "zero coverage is reported before any verdict about riskFloor");

    const clean = s(row("A-1", "quick-task") + row("A-1", "outcome", "clean") + row("B-2", "quick-task") + row("B-2", "outcome", "clean"));
    assert.deepEqual(clean.findings, [], "full coverage and no escaped bug is silence");
    assert.equal(clean.withOutcome, 2, "both outcomes counted");

    const bad = s(row("A-1", "quick-task") + row("A-1", "outcome", "escaped") + row("B-2", "fix-bug") + row("B-2", "outcome", "clean"));
    assert.ok(bad.findings.some((f) => f.includes("shipped a bug")), "an escaped bug is the finding riskFloor exists to prevent");
    assert.ok(bad.findings.some((f) => f.includes("A-1")), "the finding names the task");

    // "escaped" must not be overwritable by a later "clean": that is the
    // cheapest way to make the thresholds look safe.
    assert.equal(
      s(row("A-1", "quick-task") + row("A-1", "outcome", "escaped") + row("A-1", "outcome", "clean")).escapedBugs,
      1,
      "a later clean cannot erase an escaped bug",
    );
    // ...and the honest direction works: clean first, escaped later.
    assert.equal(
      s(row("A-1", "quick-task") + row("A-1", "outcome", "clean") + row("A-1", "outcome", "escaped")).escapedBugs,
      1,
      "a bug found later is recorded",
    );

    // An outcome for a task that never escaped must not invent a denominator.
    // An orphan outcome must not inflate coverage either: counting outcome rows
    // instead of matched escapes would report 1/1 for a log with one unrelated
    // row and one unreported escape.
    const orphan = s(row("A-1", "quick-task") + row("Z-9", "outcome", "clean"));
    assert.equal(orphan.escapes, 1, "an orphan outcome row is not an escape");
    assert.equal(orphan.withOutcome, 0, "an orphan outcome row does not count as coverage");
    // Below minSample, one bad task is not a threshold verdict.
    assert.ok(
      !escapeHatchStats(row("A-1", "quick-task") + row("A-1", "outcome", "escaped"), { minSample: 5 }).findings.some((f) =>
        f.includes("shipped a bug"),
      ),
      "one task is not enough evidence to retune riskFloor",
    );
    // An outcome row must never be read as a triage vector, or a task with only
    // an outcome would look triaged and silence the "no _triage.log entry" warning.
    assert.equal(triageVectorFor("/nonexistent", "A-1"), null, "guard: triageVectorFor on a missing file");
  }

  // routeForUrl: the pasted-link entry point. Every branch gets a case, because
  // the expensive mistake is not "no suggestion" -- it is suggesting a fresh
  // /start-task on a task that already exists, which forks append-only docs.
  {
    const e = (stage, tier, attempt) => ({ stage, tier, attempt });
    const cd = (t) => cascadeDefects(t);

    assert.deepEqual(cd([]), { errors: [], warnings: [] }, "no telemetry: nothing to say");
    assert.deepEqual(
      cd([e("implementation", "mid", 1)]),
      { errors: [], warnings: [] },
      "a single run cannot violate a rule about retries",
    );
    assert.deepEqual(
      cd([e("implementation", "mid", 1), e("implementation", "strong", 2)]),
      { errors: [], warnings: [] },
      "mid -> strong on retry is exactly the rule",
    );
    // The forbidden direction.
    assert.ok(
      cd([e("implementation", "strong", 1), e("implementation", "mid", 2)]).errors[0]?.includes("may not drop tier"),
      "strong -> mid on retry is an error",
    );
    assert.ok(
      cd([e("implementation", "mid", 1), e("implementation", "cheap", 2)]).errors.length === 1,
      "mid -> cheap is the same defect",
    );
    // Flat retry: the blind-spot argument of §5.3, now measurable.
    assert.ok(
      cd([e("fsd_review", "mid", 1), e("fsd_review", "mid", 2)]).warnings[0]?.includes("same tier"),
      "re-running the same tier is a warning",
    );
    // ...but only below the ceiling: strong -> strong is the rule working, not
    // breaking it. Without this, every hard task would warn forever.
    assert.deepEqual(
      cd([e("fsd_review", "strong", 1), e("fsd_review", "strong", 2)]),
      { errors: [], warnings: [] },
      "strong is the ceiling: re-running it is the rule, not a violation",
    );
    // Out-of-order appends must not read as a violation.
    assert.deepEqual(
      cd([e("implementation", "strong", 2), e("implementation", "mid", 1)]),
      { errors: [], warnings: [] },
      "entries are compared by attempt, not by array position",
    );
    // Stages are independent: a cheap fsd_write after a strong implementation is
    // normal, not a downgrade.
    assert.deepEqual(
      cd([e("implementation", "strong", 1), e("adversarial_review", "mid", 1)]),
      { errors: [], warnings: [] },
      "different stages are not a cascade",
    );
    // A CLI with no per-subagent routing has no tier to compare.
    assert.deepEqual(
      cd([e("implementation", "session-default", 1), e("implementation", "session-default", 2)]),
      { errors: [], warnings: [] },
      "session-default is exempt: there is no tier to escalate",
    );
    assert.ok(
      cd([e("implementation", "mid", undefined), e("implementation", "cheap", undefined)]).warnings[0]?.includes("attempt"),
      "without `attempt` the rule is unverifiable and says so instead of guessing",
    );
  }

  // vector evidence: the vector decides model tier, gate weight and worktree, so
  // a vector scored from vibes routes real money. Both directions get a case --
  // demanding counts that contradict the score is as broken as demanding none.
}

