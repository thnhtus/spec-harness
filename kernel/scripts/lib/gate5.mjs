import { AC_REACHED, AC_TRACE, CFG, DOC_ENUMS, EVIDENCE_RE, GATE4_ARTIFACTS, HANDOFF_BLOCK_CAP, LINE_CAPS, LINE_WARN, ROLE_STAGE, STAGE_ORDER } from "./config.mjs";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { UPDATE_HEADING, filledRows, staticLayerRows } from "./docs.mjs";
import { EVIDENCE_MODE, attestationsIn, fencedText, hasRealEvidenceIn } from "./evidence.mjs";
import { FSD_SECTIONS } from "./trace.mjs";
export function PREFILTER_SCRIPT() { return "gate5-prefilter.mjs"; }

export function PREFILTER_FAIL_EXIT() { return 78; }

export function evidenceTableDefects(t) {
  const rows = filledRows(t, "Command output", /\|\s*Command \/ Action\s*\|/i);
  if (rows === null) return [];
  return rows.some((c) => EVIDENCE_RE.test(c[1] ?? "")) ? []
    : ["08 `Command output` table has no row with a real §7 command (still `<scoped unit command>`) — the table is what a reviewer reads"];
}

export function adversaryCoverageDefects(t, acs = []) {
  const d = [];
  const rows = filledRows(t, "AC") ?? [];
  const have = new Set(rows.flatMap((c) => c[0].match(/AC-\d+/g) ?? [])); // "AC-01, AC-08" covers both
  const miss = acs.filter((a) => !have.has(a));
  if (miss.length) d.push(`09 "AC — does the test actually assert it" has no row for ${miss.join(", ")} — Gate 5 checks every AC in 02, not a sample (§3.3)`);
  const insp = t.split(/^#{2,3} /m).filter((s) => s.startsWith("What was inspected")).join("\n").split("\n").filter((l) => /^-\s+\S/.test(l) && !/^-\s+…\s*$/.test(l));
  if (!insp.length) d.push('09 "What was inspected" is empty — "found nothing" means nothing without the paths you walked');
  return d;
}


export function adversaryDefects(t, evidenceText = "") {
  const d = [];
  if (!/\bPASS\b|\bFAIL\b|\bUNCERTAIN\b/.test(t.replace(/PASS \| FAIL \| UNCERTAIN/g, "")))
    d.push("09 has no verdict line (PASS / FAIL / UNCERTAIN)");
  if (!hasRealEvidenceIn(t)) d.push("09 has no command+result the adversary ran itself (Gate 5 §3.2)");

  const rows = staticLayerRows(t);
  if (!rows.length)
    d.push('09 "Static layer" table has no command row — Gate 5 is re-running ProjectRules §7, not reading 08 (§3.2)');
  for (const r of rows)
    if (!r.observed)
      d.push(`09 "Static layer": \`${r.cmd}\` has no "Result when you ran it" — that column IS the gate (§3.2)`);

  // A byte-identical fence is indistinguishable from copy-paste. Matching
  // results are the expected outcome, so this is not an error — but it is the
  // one thing worth making the adversary say out loud.
  if (evidenceText && fencedText(t).trim() && fencedText(t).trim() === fencedText(evidenceText).trim())
    d.push(
      "09's pasted output is byte-identical to 08's — indistinguishable from copy-paste; paste YOUR run (timestamps/durations differ) or state under \"Limits\" that you could not re-run",
    );

  // The byte-identical check above is a weak heuristic: one extra line defeats
  // it. When both files carry attestations, something stricter is available --
  // the adversary MUST run after the implementer. A 09 startedAt earlier than
  // 08's means the block was copied from elsewhere, or from 08 and edited.
  // 09 is append-only, so round 1's attestations stay in the file forever;
  // comparing the OLDEST of the whole file failed every Gate 5 round ≥ 2. Only
  // the newest `## Update` block (or the whole file if none) is this round's run.
  const advA = attestationsIn(t.split(new RegExp(UPDATE_HEADING.source, "m")).pop());
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


// #131: Gate 5 in a FRESH process. On a CLI with no subagents the coordinator would otherwise play
// the adversary in the very context that wrote the code. config.adversary.cmd is any headless
// agent command that reads a prompt on stdin (e.g. `claude -p`, `codex exec -`, `gemini -p`).
// The prompt passes PATHS only: the new process reads its own inputs through --pack, so nothing
// the implementer thought is in its context. Same prompt as the shipped --eval, which measured it.
export function adversaryPrompt(task, base) {
  return `You are the \`adversary\` subagent (stage adversarial_review, Gate 5) for the task in \`${task}\`.\n` +
    `First run \`node scripts/validate-tasks.mjs --pack ${task} adversarial_review --base ${base}\` and read its output once: it bundles \`docs/Instructions.md\`, SharedRules §4 §5 §6 §8 §9, \`docs/agents/Adversary.md\`, ProjectRules, the output contract, the task artifacts, the last handoff and the unfiltered git file list. Do not open those files again. ` +
    "Obey the artifact size caps in SharedRules §8. Work only inside the task folder. Write `09-Adversarial-Review.md` in the task folder, " +
    `append your \`## Next Handoff\` block to \`${task}/.agent-memory/adversary.md\`, update \`${task}/task.agent.json\`. ` +
    "Remind: default FAIL, re-run the ProjectRules §7 commands yourself instead of trusting `08`, do not touch `src/`. " +
    "End your final message with: gate verdict (PASS/FAIL), status set, and the one-line reason.\n";
}

// What the run proved. Pure so the self-check covers every branch without spawning an agent.
export function adversaryRunVerdict({ status, timedOut, nineBefore, nineAfter, srcChanged }) {
  if (timedOut) return { exit: 1, why: "adversary process timed out — no verdict; re-run or raise --timeout" };
  if (srcChanged.length) return { exit: 1, why: `adversary changed files outside the task folder: ${srcChanged.join(", ")} — Gate 5 is read-only; revert them` };
  if (!nineAfter || nineAfter === nineBefore) return { exit: 1, why: `adversary process exited ${status} without writing 09-Adversarial-Review.md` };
  return { exit: 0 };
}


// #109: an OPTIONAL early FAIL for Gate 5. The kernel knows no vendor, key or
// endpoint — only that a script named PREFILTER_SCRIPT may exist next to this
// file and answers with an exit code. PREFILTER_FAIL_EXIT = "confident the
// change is broken": --advance exits 1 so the adversary dispatch (54k-132k
// tokens) is skipped. Everything else — no script, exit 0, a crash, a timeout,
// a signal, a spawn error — means "no opinion" and the gate proceeds as before.
// NOT exit 1: an uncaught throw in Node exits 1, so a crashing pre-filter would
// have blocked every task (measured, e2e). 78 = EX_CONFIG-free, never emitted
// by node itself. The pure part, so the fail-open table is asserted cheaply.
// Functions, not consts: the self-check runs above this line, and a const would
// still be in its temporal dead zone there.
// The task's target branch from 00-Metadata (not always main) — the base both the
// pre-filter and --pack take their diff against.
export function targetBranch(text = "") { return /\|\s*Target branch\s*\|\s*`?([^`|\s]+)`?\s*\|/.exec(text)?.[1] ?? "main"; }

export const packBase = (dir) => targetBranch(existsSync(join(dir, "00-Metadata.md")) ? readFileSync(join(dir, "00-Metadata.md"), "utf8") : "");

export function prefilterVerdict(result) {
  if (!result || result.error || result.signal || result.status !== PREFILTER_FAIL_EXIT()) return { block: false };
  return { block: true, why: String(result.stderr ?? "").trim() || "pre-filter says FAIL" };
}


// --contract (#62): what the validator will check on a stage's output, printed
// from the SAME constants the checks read. A real run had roles grep and sed
// this file 25 times to learn the handoff format, the Q/AC row shapes and 09's
// table — every read then paid again on every later turn. Built from the
// constants, so the contract cannot drift from the check.
export function stageContract(stage, { stages = STAGE_ORDER, roleStage = ROLE_STAGE, required = CFG.requiredAtStage ?? [], handoffCap = HANDOFF_BLOCK_CAP } = {}) {
  const i = stages.indexOf(stage);
  if (i < 0 || i === stages.length - 1) return null;
  const next = stages[i + 1];
  const files = required.filter((r) => r.stage === next || (i === 0 && r.stage === stage)).flatMap((r) => r.files);
  if (stage === "adversarial_review" && GATE4_ARTIFACTS.adversarial) files.push(GATE4_ARTIFACTS.adversarial);
  const roles = Object.keys(roleStage).filter((r) => roleStage[r] === stage);
  const q = "`";
  const L = [`# Contract: ${stage} — what validate-tasks.mjs checks on your output (source: its own constants)`, "", "## Files you produce"];
  for (const f of files) {
    const cap = LINE_CAPS[f]
      ? `≤ ${LINE_CAPS[f]} lines (error); on a re-run append ${q}## Update — <date>${q} and the cap applies to the newest block`
      : LINE_WARN[f] ? `soft limit ${LINE_WARN[f]} lines (warning) — never trim pasted output` : "no line cap";
    L.push(`- ${q}${f}${q} — ${cap}`);
  }
  L.push("", "## Handoff",
    `- append to ${q}.agent-memory/${roles.join("|")}.md${q} one block starting ${q}### ${q}, ≤ ${handoffCap} lines (warning)`,
    `- it must contain ${q}Next agent: <role>${q} and ${q}Continue automation: yes|no${q} (error) — the coordinator routes on the LAST block`);
  const R = [];
  if (stage === "fsd_write")
    R.push(`- headings: ${FSD_SECTIONS.join(" · ")} (error if one is missing)`,
      `- ≥1 row ${q}| FSD-<MOD>-01 | <requirement using ${(CFG.fsdModal ?? []).join(" / ")}> | <source> | <status> |${q}; every such row needs a Source (error)`);
  if (AC_TRACE.declaredIn && files.includes(AC_TRACE.declaredIn))
    R.push(`- ${q}${AC_TRACE.declaredIn}${q}: ≥1 AC row opening ${q}| AC-<id> |${q} (AC-nn / AC-ID are placeholders) (error)`,
      `- question rows ${q}| Q-<id> | … |${q}: type ∈ ${(DOC_ENUMS.question?.type ?? []).join("/")}, status ∈ ${(DOC_ENUMS.question?.status ?? []).join("/")} — these exact tokens whatever the doc language (unreadable row = error); ${q}${DOC_ENUMS.question?.blocksOn}${q} + ${q}${DOC_ENUMS.question?.unresolved}${q} blocks the gate`);
  for (const r of AC_REACHED)
    if (r.fromStage ? stages[stages.indexOf(r.fromStage) - 1] === stage : stage === "implementation")
      R.push(`- ${q}${r.doc}${q}: every declared AC id in a table row${r.cell === "first" ? ", as the row's FIRST cell" : ""} (error)`);
  if (stage === "implementation" && GATE4_ARTIFACTS.evidence)
    R.push(`- ${q}${GATE4_ARTIFACTS.evidence}${q}: output pasted inside a ${q.repeat(3)} fence, a command matching /${EVIDENCE_RE.source}/ and a result (passed / exit 0 / n/n tests); a failure line needs ${q}<!-- known-failure: why -->${q} above the fence (error)`,
      `- evidenceMode="${EVIDENCE_MODE}": ${EVIDENCE_MODE === "attested" ? "every command run through" : "an attestation block, when present, must come from"} ${q}node scripts/run-evidence.mjs -- <cmd>${q} — exitCode 0, durationMs > 0, outputHash matching the fence (error)`,
      `- #137: that block's ${q}worktree${q} must still match the tree you are shipping (error, before the push). If you edited code after the command ran, re-run it — a green run under old code proves nothing about new code. Committing identical content does NOT invalidate it: the witness is file content, not the commit.`);
  if (stage === "adversarial_review" && GATE4_ARTIFACTS.adversarial)
    R.push(`- ${q}${GATE4_ARTIFACTS.adversarial}${q}: a verdict PASS / FAIL / UNCERTAIN, and your own fenced run under the same rules as 08 — not byte-identical to 08, an attestation starting after 08's newest (error)`,
      `- a "Static layer" table, one row per command: ${q}| ${q}<cmd>${q} | <what 08 claimed> | <what you got> | ✔/✖ |${q} — the third column is the gate (error if empty)`,
      `- FAIL → status=blocked, keep currentStage=${stage}`);
  if (R.length) L.push("", "## Rules on content", ...R);
  return L.join("\n");
}


// --pack (#66): one input bundle per dispatch. A role used to spend its first
// turns Reading Instructions + SharedRules + its role file + each input artifact,
// every Read a turn and every turn re-billed the whole context. The bundle is the
// same reading in one call, sliced to what the preamble names (SharedRules §4 §5
// §6 §8 [+§9]), with re-runs cut to the newest `## Update` block.
//   parts: rules (fixed per kernel) · prose (task artifacts) · machine (git output).
// #155: the evidence file is a LOG, and the log is what a bundle drowns in. On a
// real task (postcite#151) 08 alone was 171 KB of the adversary's 258 KB pack —
// one `npm run test` fence of ~4,600 TAP lines. No role reviews the log: Gate 5
// re-runs ProjectRules §7 itself and reads the result lines. So each long fence
// in the evidence artifact is packed head+tail with the middle marked trimmed,
// and the file named as where the whole output still lives on disk.
// Constants, not config: a new required key would force every existing
// harness.config.json to migrate for a packing detail, and the numbers are a
// property of what a log fence looks like, not of a repo.
export const EVIDENCE_FENCE_KEEP = { head: 25, tail: 15, minLines: 40 };

// Pure: fences shorter than minLines are returned byte-for-byte, so no small
// evidence block (the common case) changes shape.
export function trimEvidenceLog(text, keep = EVIDENCE_FENCE_KEEP) {
  const lines = text.split("\n");
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    if (!/^\s*```/.test(lines[i])) { out.push(lines[i]); continue; }
    let j = i + 1;
    while (j < lines.length && !/^\s*```\s*$/.test(lines[j])) j++;
    const body = lines.slice(i + 1, j);
    if (j >= lines.length || body.length < keep.minLines) { out.push(...lines.slice(i, j + 1)); i = j; continue; }
    const head = Math.max(1, keep.head), tail = Math.max(1, keep.tail);
    const removed = body.length - head - tail;
    if (removed <= 0) { out.push(...lines.slice(i, j + 1)); i = j; continue; }
    out.push(lines[i], ...body.slice(0, head),
      `[… ${removed} lines trimmed by --pack (#155) — this bundle keeps the command and the result lines; the full output is in the file on disk, read it only if you doubt a line here …]`,
      ...body.slice(body.length - tail));
    i = j;
  }
  return out.join("\n");
}

// Pure over its inputs so --self-check can assert the adversary's unfiltered view.
export function packParts({ stage, role, attempt = 1, docs, artifacts = {}, handoff = "", git = null, scope = [], contract = "", sliceOf = {} }) {
  const sections = (t, want) => t.split(/^(?=## )/m).filter((s) => want.some((n) => s.startsWith(`## ${n}.`))).join("");
  // The evidence artifact is named by config, not guessed from the filename.
  const evidenceFile = GATE4_ARTIFACTS.evidence;
  const rules = [
    `# Pack: ${stage} · role ${role} · attempt ${attempt}`,
    "Everything the preamble told you to read is below — do not open these files again.",
    "", "## ⟪docs/Instructions.md⟫", docs.instructions,
    "", "## ⟪docs/agents/SharedRules.md §4 §5 §6 §8 §9⟫", sections(docs.shared, [4, 5, 6, 8, 9]),
    "", `## ⟪${docs.roleFile}⟫`, docs.role,
    ...(docs.project ? ["", "## ⟪docs/agents/ProjectRules.md⟫", docs.project] : []),
    "", contract,
  ].join("\n");
  const newest = (t) => { const u = t.split(UPDATE_HEADING); return u.length > 1 ? "## Update — " + u.at(-1) : t; };
  const prose = [
    ...Object.entries(artifacts).map(([f, t]) => {
      const newestOnly = (attempt > 1 || CFG.packTrim === true) && t.split(UPDATE_HEADING).length > 1;
      const body = newestOnly ? newest(t) : t;
      const note = newestOnly ? " (newest update block only — earlier rounds are distilled in the handoff)" : "";
      // #155: only the evidence log is trimmed; every other artifact is verbatim.
      const packed = f === evidenceFile ? trimEvidenceLog(body) : body;
      return `\n## ⟪${f}⟫${note}\n${packed}`;
    }),
    ...(handoff ? ["\n## ⟪last handoff⟫", handoff] : []),
  ].join("\n");
  let machine = "";
  if (git) {
    // Gate 5 reads the diff, not a description of it: NOTHING is filtered here.
    // A file outside the Gate 3 list is marked, never dropped — dropping it is
    // exactly the finding the adversary exists to make.
    // #74: a sliced task keeps ONE adversary (cross-slice findings need the whole
    // diff; one per slice pays the ~40k floor each, #72) — each line says its slice.
    const hit = (p) => scope.find((s) => p === s || p.endsWith("/" + s));
    const mark = (p) => (hit(p) ? (sliceOf[hit(p)] ? `   [${sliceOf[hit(p)]}]` : "") : "   ← not in 03 Files to change: a finding unless 06 Plan Deviations declares it");
    const lines = (t) => t.split("\n").filter(Boolean);
    machine = [
      `\n## ⟪git diff --stat ${git.base}⟫ (committed + uncommitted)`, "```", git.stat.trimEnd(), "```",
      "\n## ⟪git status --porcelain --untracked-files=all⟫ (?? = untracked, never in the diff above)", "```",
      ...lines(git.status).map((l) => l + mark(l.slice(3).split(" -> ").at(-1))), "```",
      "Still re-run the ProjectRules §7 commands yourself and read the hunks you doubt — this is the file list, not the review.",
    ].join("\n");
  }
  return { rules, prose, machine };
}

// ── self-check: moved here with the logic it tests ──────────────────
export async function selfCheck({ assert }) {
  const { TASKS_DIR } = await import("./config.mjs");
  const { keyFrom, protectionVerdict } = await import("./telemetry.mjs");
  const sample = CFG.evidenceSampleCommand;
  // adversaryDefects: verdict + own run + the side-by-side table whose third
  // column only an actual re-run can fill.
  const advOk = [
    "**Verdict: PASS**",
    `| \`${sample}\` | 4 passed | 4 passed (2.1s) | ✔ |`,
    "```",
    `$ ${sample}`,
    "Tests 4 passed (4) in 2.1s",
    "```",
  ].join("\n");
  assert.deepEqual(adversaryDefects(advOk), [], "verdict + own run + filled table");
  assert.ok(adversaryDefects("**Verdict: PASS**").length, "verdict without evidence is not a review");

  // The copy attack: 09 whose fence is byte-identical to 08's.
  const ev08 = "```\n$ " + sample + "\nTests 4 passed (4)\n```";
  const adv09 = `**Verdict: PASS**\n| \`${sample}\` | 4 passed | 4 passed | ✔ |\n` + ev08;
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
    adversaryDefects(`**Verdict: PASS**\n| \`${sample}\` | 4 passed |  | ? |\n\`\`\`\n$ ${sample}\nexit 0\n\`\`\``)
      .some((d) => d.includes("Result when you ran it")),
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

  // #86/#87: untouched templates fail, a filled row passes -- per check, one rule each.
  {
    const okRun = (o, st = 0) => () => ({ status: st, stdout: o }), nofile = () => { throw new Error("ENOENT"); };
    assert.equal(keyFrom({ env: { SPEC_HARNESS_KEY: " abc " }, file: () => "file" }), "abc", "CI secret wins over the file");
    assert.equal(keyFrom({ env: { SPEC_HARNESS_KEY_CMD: "x" }, run: okRun("kc\n"), file: () => "file" }), "kc", "keychain command wins over the file");
    assert.equal(keyFrom({ env: {}, file: () => "file\n" }), "file", "no env = today's behaviour");
    assert.equal(keyFrom({ env: {}, file: nofile }), null, "nothing configured = no key (signature checks skipped, not failed)");
    assert.throws(() => keyFrom({ env: { SPEC_HARNESS_KEY_CMD: "x" }, run: okRun("", 1), file: () => "file" }), /not falling back/, "failing keychain must NOT downgrade to the file key");
    assert.throws(() => keyFrom({ env: { SPEC_HARNESS_KEY_CMD: "x" }, run: okRun("  \n"), file: () => "file" }), /printed nothing/, "empty keychain output is a failure, not a blank key");
    const L = (a) => protectionVerdict(a).ok;
    assert.equal(L({}), null, "no answer from the host = no opinion (warn, never red)");
    assert.equal(L({ classic: { contexts: ["validate-tasks"] } }), true);
    assert.equal(L({ classic: { checks: [{ context: "spec-harness / validate-tasks" }] } }), true);
    assert.equal(L({ classic: { contexts: ["lint"] } }), false, "a required check that is not the validator does not count");
    assert.equal(L({ classic: null, rules: ["required_status_checks"] }), true, "rulesets count");
    assert.equal(L({ classic: null, rules: [] }), false, "classic 404 + empty ruleset = unprotected");
    assert.equal(L({ classic: { contexts: [] }, rules: ["deletion"] }), false);
  }
  {
    const V = (o) => adversaryRunVerdict({ status: 0, timedOut: false, nineBefore: null, nineAfter: "# 09\nFAIL", srcChanged: [], ...o });
    assert.equal(V({}).exit, 0, "wrote 09, touched nothing = ran");
    assert.match(V({ timedOut: true }).why, /timed out/);
    assert.match(V({ nineAfter: null }).why, /without writing 09/);
    assert.match(V({ nineBefore: "same", nineAfter: "same" }).why, /without writing 09/, "an unchanged 09 from an earlier round is not a new verdict");
    assert.match(V({ srcChanged: ["src/a.js"] }).why, /outside the task folder: src\/a\.js/, "Gate 5 is read-only");
    assert.equal(V({ status: 1 }).exit, 0, "the agent CLI's own exit code is not the verdict; 09 + the validator are");
    const pr = adversaryPrompt("docs/tasks/s/T", "develop");
    assert.match(pr, /--pack docs\/tasks\/s\/T adversarial_review --base develop/, "base branch from 00-Metadata, not hardcoded main");
    assert.doesNotMatch(pr, /06-Implementation-Notes|implementer said/, "paths only — no implementer content in the prompt");
  }
  {
    const all = STAGE_ORDER.slice(0, -1).map((st) => stageContract(st));
    assert.ok(all.every(Boolean), "every producing stage has a contract");
    assert.equal(stageContract(STAGE_ORDER.at(-1)), null, "the last stage produces nothing");
    assert.equal(stageContract("nope"), null, "an unknown stage has no contract");
    const joined = all.join("\n");
    for (const f of (CFG.requiredAtStage ?? []).flatMap((r) => r.files))
      assert.ok(joined.includes("`" + f + "`"), `requiredAtStage file ${f} is in some contract`);
    for (const [f, cap] of Object.entries(LINE_CAPS)) assert.ok(joined.includes(`${f}\` — ≤ ${cap} lines`), `lineCaps ${f}=${cap} reaches the contract`);
    for (const [f, n] of Object.entries(LINE_WARN)) assert.ok(joined.includes(`${f}\` — soft limit ${n}`), `lineWarn ${f}=${n} reaches the contract`);
    for (const r of Object.keys(ROLE_STAGE)) assert.ok(joined.includes(r), `role ${r} has a handoff line`);
    assert.ok(stageContract("fsd_write", { handoffCap: 7 }).includes("≤ 7 lines"), "handoffBlockCap reaches the contract");
    const fsd = stageContract("fsd_write");
    for (const x of [...FSD_SECTIONS, ...CFG.fsdModal]) assert.ok(fsd.includes(x), `fsd_write contract names ${x}`);
    const rev = stageContract("fsd_review");
    for (const x of [...DOC_ENUMS.question.type, ...DOC_ENUMS.question.status]) assert.ok(rev.includes(x), `fsd_review contract names question enum ${x}`);
    // ...and the stage BEFORE fromStage, the one writing the doc — not the one it is checked at.
    for (const r of AC_REACHED) assert.ok(stageContract(r.fromStage ? STAGE_ORDER[STAGE_ORDER.indexOf(r.fromStage) - 1] : "implementation").includes(`${r.doc}\`: every declared AC`), `acTrace.reachedIn ${r.doc} reaches the contract of the stage writing it`);
    assert.ok(stageContract("implementation").includes(EVIDENCE_RE.source), "evidenceCommandPattern reaches the implementation contract");
    assert.ok(stageContract("adversarial_review").includes(GATE4_ARTIFACTS.adversarial), "09 reaches the adversary contract");
  }

  // #155: an evidence LOG is packed head+tail; every other artifact stays verbatim.
  {
    const long = (n) => Array.from({ length: n }, (_, i) => `ok ${i} - test ${i}`).join("\n");
    const big = `## Command output\n\n\`\`\`\n$ npm run test\n${long(200)}\nTests 200 passed (200)\n\`\`\`\n`;
    const small = "```\n$ npm run test\nTests 4 passed (4)\n```\n";
    assert.equal(trimEvidenceLog(small), small, "a fence under the threshold is byte-for-byte unchanged");
    assert.equal(trimEvidenceLog("no fences here"), "no fences here", "a file with no fence is untouched");
    const cut = trimEvidenceLog(big);
    assert.ok(cut.length < big.length / 2, "the log fence is cut, not nudged");
    assert.match(cut, /\$ npm run test/, "the command line survives — it is what the reader matches against ProjectRules §7");
    assert.match(cut, /Tests 200 passed \(200\)/, "the result lines survive — they are the claim 08 makes");
    assert.match(cut, /\[… 162 lines trimmed by --pack \(#155\)/, "the trim says how many lines it removed");
    assert.match(cut, /^```$/m, "the closing fence survives, so the markdown still parses");
    const keep = (f, t) => packParts({ stage: "adversarial_review", role: "adversary", docs: { instructions: "", shared: "", roleFile: "r.md", role: "" }, artifacts: { [f]: t } }).prose;
    assert.ok(!keep(GATE4_ARTIFACTS.evidence, big).includes("ok 100 - test 100"), "the evidence file's middle is not in the bundle");
    assert.ok(keep("01-FSD.md", big).includes("ok 100 - test 100"), "only the evidence artifact is trimmed — 01 keeps every line");
  }

  // packParts / scopeFiles (#66): R3b — the adversary's view is unfiltered.
}

