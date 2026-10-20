import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { CFG, EVIDENCE_RE, REPO_ROOT } from "./config.mjs";
// --- pure text predicates (self-checked below via --self-check) -------------

// "Real evidence": a command was run AND a pass/exit signal was recorded IN A
// FENCED BLOCK. Scanning the whole file was a hole: the 08 template's "Expected"
// column already reads "…/… passed", so an untouched scaffold with one command
// name typed in satisfied Gate 4 with zero output. Pasted output goes in a fence;
// that is the only place the proof can be.
// A bare "4/5" also matches a path like src/test/4/5, which appears in the very
// command being pasted. Require the ratio to be labelled as a count.
export const RESULT_RE =
  /\bpassed\b|exit 0|✓|no error|\d+\s*\/\s*\d+\s*(passed|failed|tests?|specs?|files?|ok\b)|(tests?|specs?|files?)\s*:?\s*\d+\s*\/\s*\d+|#\s*pass\s+[1-9]\d*/i;


// RESULT_RE asks "is the word passed present", not "are the tests green" -- and
// `Tests: 11 passed, 1 failed` satisfies the former. That is precisely what
// Gate 4 exists to stop, so there has to be a separate negative check. FAIL/✗
// are anchored with `^` because they show up mid-prose ("stop on FAIL…");
// `\d+ failed` needs no anchor. `# fail n` is TAP's own spelling of the same
// thing: RESULT_RE learned `# pass n` (#156), so without this a suite that ran
// 0 tests and failed 3 would read as a green result.
export const FAILURE_RE =
  /\b\d+\s+(failed|failing)\b|^\s*(FAIL|✗|✖|×)\s|\bexit (code )?[1-9]\d*\b|\bERR!|\b#\s*fail\s+[1-9]\d*\b/im;


// The escape hatch for a DELIBERATELY red test (fixer reproduce-first: write
// the failing test, then fix). Without it, agents learn not to paste failing
// output -- far worse than a loose gate, because the evidence disappears
// instead of being caught.
export const KNOWN_FAILURE_RE = /<!--\s*known-failure:/i;


// ── attestation (scripts/run-evidence.mjs) ─────────────────────────────────
// Everything above only reads the SHAPE of text, so an agent that ran no command
// still passes by typing `Tests: 12 passed`. The attestation changes the
// question: not "does this look like test output" but "which process ran this
// and what did it exit with".
//
// `evidenceMode: "attested"` in harness.config.json makes it mandatory. The
// default is `"legacy"` because in-flight tasks and repos with hand-written
// evidence must not all go red just from a kernel upgrade -- turn it on once
// ProjectRules §7 uses the wrapper. In legacy mode a present attestation is
// still checked; only a missing one is forgiven.
export const ATTEST_MARK = "--- spec-harness attestation ---";

// No implicit default: "legacy" accepts pasted evidence, i.e. an agent that ran
// no command still passes Gate 4 by typing `Tests: 12 passed`. That is a valid
// choice while migrating, but it has to be a choice that was WRITTEN DOWN --
// inheriting it from an implicit value is how the harness's whole argument
// collapses silently. --self-check demands an explicit declaration; this is
// only a fallback for other entry points.
export const EVIDENCE_MODE = CFG.evidenceMode ?? "legacy";


// #137: the tree the evidence ran against, not just the commit it recorded.
// `gitRev` is parsed but comparing commits is the wrong test: the normal flow is
// to run the tests on a dirty tree and commit the same content afterwards, which
// moves HEAD without changing a byte. The wrapper hashes file CONTENT for this
// reason, and one implementation serves both sides — the validator asks through
// `run-evidence.mjs --fingerprint` rather than keeping a second copy to drift.
// Cached per cwd: one child process per repo, not one per attestation.
export const _fpCache = new Map();


export function fencedText(t) {
  return [...t.matchAll(/```[^\n]*\n([\s\S]*?)```/g)].map((m) => m[1]).join("\n");
}


// ...but it only counts OUTSIDE a fence. The 08 template teaches the marker by
// printing it in a ```-block, so a whole-file test armed the escape hatch in
// every task copied from the template: an attestation with exitCode 1 passed
// Gate 4 untouched. The real declaration sits immediately above the output
// block, never inside it.
export const isKnownFailure = (t) => KNOWN_FAILURE_RE.test(unfencedText(t));


export const unfencedText = (t) => t.replace(/```[^\n]*\n[\s\S]*?```/g, "");


export function hasRealEvidenceIn(t) {
  const fenced = fencedText(t);
  // An attestation with exitCode 0 outranks every string RESULT_RE hunts for:
  // those ask whether the text LOOKS green, this one records what the process
  // actually exited with. Without this branch a quiet command (tsc --noEmit,
  // eslint, a build) run through the wrapper is rejected for printing nothing
  // to be pattern-matched -- attested mode would reward pasting by hand, which
  // is backwards. attestationDefects() judges the block itself; here it only
  // has to count as a result.
  const att = attestationsIn(t);
  // A non-zero exit is a failure whatever the text beside it says -- and the
  // string checks below miss it, because FAILURE_RE looks for `exit code 1`
  // while the wrapper writes `exitCode: 1`. Judge it here, before anything
  // reads the prose.
  if (att.length && att.every((a) => a.exitCode !== 0))
    return isKnownFailure(t);
  if (att.some((a) => a.exitCode === 0)) return true;
  if (!EVIDENCE_RE.test(t) || !RESULT_RE.test(fenced)) return false;
  return !FAILURE_RE.test(fenced) || isKnownFailure(t);
}


// It has to keep the output preceding the attestation, not just the fields:
// outputHash is the claim "this attestation belongs to that output", and
// checking it requires having "that".
export const hashOutput = (s) => createHash("sha256").update(s, "utf8").digest("hex").slice(0, 16);


export function attestationsIn(text) {
  const out = [];
  for (const m of text.matchAll(/--- spec-harness attestation ---\n([\s\S]*?)(?:```|$)/g)) {
    const get = (k) => {
      const hit = new RegExp(`^${k}:\\s*(.+)$`, "m").exec(m[1]);
      return hit ? hit[1].trim() : null;
    };
    const code = get("exitCode");
    if (code === null) continue;
    // The body = from after the opening fence line to just before the marker.
    // With no opening fence (a bare pasted block) body = null → the hash cannot
    // be checked, and that case is already caught by durationMs/missing fields.
    const before = text.slice(0, m.index);
    const fenceAt = before.lastIndexOf("```");
    const body = fenceAt === -1
      ? null
      : before.slice(before.indexOf("\n", fenceAt) + 1, before.length - 1);
    out.push({
      exitCode: Number(code),
      durationMs: Number(get("durationMs") ?? NaN),
      gitRev: get("gitRev"),
      worktree: get("worktree"),
      startedAt: get("startedAt"),
      outputHash: get("outputHash"),
      body,
    });
  }
  return out;
}

export function currentWorktreeFingerprint(cwd) {
  if (_fpCache.has(cwd)) return _fpCache.get(cwd);
  // #154: one level UP from lib/. The #118 split moved this function into
  // kernel/scripts/lib/ and left the path relative to itself, so it spawned
  // lib/run-evidence.mjs — a file that does not exist. Every fingerprint came back
  // null, and null fails open, so the #137 stale-tree comparison silently compared
  // nothing from #118 until now. Assert the resolution in the self-check below.
  const r = spawnSync(process.execPath, [join(dirname(fileURLToPath(import.meta.url)), "..", "run-evidence.mjs"), "--fingerprint"],
    { cwd, encoding: "utf8", timeout: 20000 });
  // null = git could not answer (no repo, shallow clone, run-evidence missing).
  // Callers fail OPEN on null, like the _stamp.log signatures: an unverifiable
  // tree is not a stale one, and a gate that reds every task on a repo without
  // git is a gate people switch off.
  const v = r.status === 0 ? (r.stdout ?? "").trim() : "";
  const fp = v && v !== "unavailable" ? v : null;
  _fpCache.set(cwd, fp);
  return fp;
}


// Blocks that start on/after this date must witness the tree they tested. Older
// blocks were written by kernels that did not record a fingerprint, and re-requiring
// it today would turn other repos' in-flight tasks red for a rule they never ran
// under (the same shape as AC_TRACE_SINCE: a new rule applies to work started after
// it, not retroactively).
export const FINGERPRINT_SINCE = "2026-10-19";

// Where the stale-tree check applies. NOT in CI: a PR is checked out as a merge
// with the base branch, so its tree legitimately differs from the one the dev ran
// the tests on. And not for a task past `reviewing`: its evidence describes the
// repo of the day it shipped, and the repo has moved on since — checking it would
// turn every merged task red forever. The dev machine, before the push, is where
// "I changed code after the tests" can still be acted on.
//
// #154: `requireWorktree` used to be reachable only from the self-check, so the
// asymmetry the field allows — "a block with no fingerprint is fine" — was the
// production default. A read-only role on a CLI with no hook enforcement mutated
// the real tree, died, and left the mutation in place; its 09 then described code
// that no longer existed, and nothing went red (postcite #151). From
// FINGERPRINT_SINCE on, the transition that accepts the verdict demands the
// witness: the evidence must name the tree being shipped.
// The policy on its own — no I/O, no environment. Split out because treeCtx()
// short-circuits in CI (a PR is checked out as a merge, so its tree legitimately
// differs), and an assert written against treeCtx() therefore passes on a laptop
// and throws in CI. The self-check asserts THIS, and it is the part that decides.
function shippedSignal(status, outcome) {
  if (status === "done") return true;
  if (outcome && typeof outcome === "object" && outcome.closedAt) return true;
  if (typeof outcome === "string" && outcome) return true;
  return false;
}

// Accept either (status, outcome) or a task-shaped object (#168): a task is
// "shipped" when status === "done" OR outcome.closedAt is set, even while it
// still sits at status "reviewing".
export function treeCtxPolicy(statusOrTask, outcome) {
  let status = statusOrTask;
  let oc = outcome;
  if (statusOrTask && typeof statusOrTask === "object") {
    status = statusOrTask.status;
    oc = statusOrTask.outcome ?? statusOrTask;
  }
  if (shippedSignal(status, oc)) return {};
  return status === "reviewing" ? { requireWorktree: true, since: FINGERPRINT_SINCE } : {};
}

export function treeCtx(statusOrTask, outcome) {
  const policy = treeCtxPolicy(statusOrTask, outcome);
  if (!Object.keys(policy).length || process.env.CI || process.env.GITHUB_ACTIONS) return {};
  return { ...policy, current: currentWorktreeFingerprint(REPO_ROOT) };
}


// Returns the list of defects. Empty = the attestation says nothing wrong.
export function attestationDefects(text, label, mode = EVIDENCE_MODE, ctx = {}) {
  const found = attestationsIn(text);
  if (!found.length) {
    if (mode !== "attested") return [];
    return [
      `${label}: evidenceMode="attested" but there is no attestation block — run the command through \`node scripts/run-evidence.mjs -- <command>\` instead of pasting output by hand`,
    ];
  }
  const d = [];
  for (const a of found) {
    // This is why the wrapper exists: output printing "passed" with a non-zero exit.
    if (a.exitCode !== 0 && !isKnownFailure(text))
      d.push(`${label}: the attestation records exitCode ${a.exitCode} — the command FAILED, whatever the output says`);
    // durationMs 0 means no process actually ran; NaN means the block was typed
    // by hand and is missing a field. Both are untrustworthy attestations.
    if (!Number.isFinite(a.durationMs) || a.durationMs <= 0)
      d.push(`${label}: the attestation has an invalid durationMs ("${a.durationMs}") — this block did not come from run-evidence.mjs`);
    // outputHash binds the attestation to the output next to it. A missing field
    // or a mismatched hash are the two cheapest fakes: copying a block from
    // another task, or running it for real then prettifying the output. Both
    // pass every per-field check.
    if (a.body !== null) {
      if (!a.outputHash)
        d.push(`${label}: the attestation has no outputHash — an old or hand-typed block; re-run it through \`node scripts/run-evidence.mjs\``);
      else if (hashOutput(a.body) !== a.outputHash)
        d.push(`${label}: outputHash does not match the output in the fence — the output was edited after the run, or the attestation was copied from elsewhere`);
    }
    // #137: the code the evidence ran against. outputHash binds the block to its
    // own output; nothing bound it to the tree being shipped, so running the
    // tests before the last edit passed both gates. A block with no `worktree`
    // field predates this check (or was hand-typed): only the newer rules block,
    // so in-flight evidence written before the kernel upgrade stays a warning.
    if (!a.worktree) {
      // #154: a block written by a kernel that did not fingerprint the tree cannot
      // witness what it tested. Only blocks from FINGERPRINT_SINCE on are held to
      // it — see the constant for why.
      const owed = ctx.requireWorktree && (!ctx.since || (a.startedAt ?? "") >= ctx.since);
      if (owed) d.push(`${label}: the attestation records no worktree fingerprint — re-run it through \`node scripts/run-evidence.mjs\` so it witnesses the code it tested (#137/#154); if the field never appears, this project's \`scripts/run-evidence.mjs\` is older than the kernel — re-run the installer`);
    } else if (ctx.current !== null && ctx.current !== undefined && a.worktree !== "unavailable" && a.worktree !== ctx.current) {
      d.push(`${label}: the evidence ran against a different tree (worktree ${a.worktree}, now ${ctx.current}) — the code changed after this command ran; re-run it through \`node scripts/run-evidence.mjs\` (#137)`);
    }
  }
  return d;
}


// R5 (#80): the escape hatch's one gate. quick-task / fix-bug write ONE file,
// docs/tasks/fixes/<id>-<slug>.md; before this it was prose nobody read, and
// `--escape-outcome clean` was a claim with nothing behind it. An attestation
// is required whatever evidenceMode says (the !found.length line): this path has no Gate 4/5 to fall
// back on, so hand-pasted output would be the whole proof. The LAST attestation
// must be green -- the repro run before the fix is red on purpose (known-failure),
// but a file ending red means the fix never went green.
export function liteDefects(text, ctx = {}) {
  if (!/^##\s+Evidence\b/m.test(text)) return ["no `## Evidence` section"];
  const found = attestationsIn(text);
  if (!found.length)
    return ["no run-evidence attestation — run the ProjectRules §7 commands through `node scripts/run-evidence.mjs --append <this file> -- <command>`"];
  const d = attestationDefects(text, "evidence", EVIDENCE_MODE, ctx);
  if (found.at(-1).exitCode !== 0) d.push(`the last attestation exits ${found.at(-1).exitCode} — the fix never went green`);
  return [...new Set(d)];
}

// ── self-check: moved here with the logic it tests ──────────────────
export async function selfCheck({ assert }) {
  const { adversaryDefects } = await import("./gate5.mjs");
  const { taskKeyOf } = await import("./lifecycle.mjs");

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
  // no real test/lint/build command is called `dev` or `start`. Every package
  // manager, both spellings: `yarn dev` and `yarn run dev` are the same script,
  // and a pattern anchored on "npm run" only would wave the other three through.
  const runners = ["npm run", "yarn", "yarn run", "pnpm", "pnpm run", "bun", "bun run"];
  for (const neg of runners.flatMap((r) => [`${r} dev`, `${r} start`]))
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
  assert.equal(hasRealEvidenceIn("everything passes"), false, "claim without a command");
  assert.equal(hasRealEvidenceIn("```\n$ " + sample + "\n```"), false, "command without a result");
  // #156: TAP writes `# tests 56` / `# pass 55` / `# fail 0` and never the words
  // RESULT_RE hunted for, so a real `node --test` run pasted into 09 was rejected
  // as "no command+result". TAP's own counters count -- but `# pass 0` must not,
  // and FAILURE_RE has to learn `# fail n` or the new branch becomes a way in.
  assert.equal(hasRealEvidenceIn("```\n$ " + sample + "\n# tests 56\n# pass 55\n# fail 0\n```"), true, "TAP counters count as a result");
  assert.equal(hasRealEvidenceIn("```\n$ " + sample + "\n# pass 0\n# fail 3\n```"), false, "zero passed with failures is not a result");
  assert.equal(
    hasRealEvidenceIn(`| Unit | \`${sample}\` | AC-01 | …/… passed | | |`),
    false,
    'a table row saying "passed" is a plan, not a result — the fence is the proof',
  );
  // Gate 4 must ask "are the tests green", not "is the word passed present".
  // Output with both passed and failed used to SLIP THROUGH — the exact case
  // the gate exists to stop.
  assert.equal(
    hasRealEvidenceIn("```\n$ " + sample + "\nTests: 11 passed, 1 failed\n```"),
    false,
    "output containing a failing test must NOT pass Gate 4 just for saying passed",
  );
  assert.equal(
    hasRealEvidenceIn("```\n$ " + sample + "\nFAIL src/a.spec.ts\n4 passed\n```"),
    false,
    "a FAIL line in the output blocks Gate 4",
  );
  assert.equal(
    hasRealEvidenceIn("```\n$ " + sample + "\n2 passed\nexit 1\n```"),
    false,
    "a non-zero exit code blocks Gate 4",
  );
  // The escape hatch: a deliberately red test (fixer reproduce-first) can still be declared.
  assert.equal(
    hasRealEvidenceIn(
      "<!-- known-failure: AC-03 reproduce -->\n```\n$ " + sample + "\nTests: 3 passed, 1 failed\n```",
    ),
    true,
    "a declared known-failure is still valid evidence",
  );
  // "FAIL" in prose (outside a fence) must not block — the fence is the evidence.
  assert.equal(
    hasRealEvidenceIn("Stop on FAIL.\n```\n$ " + sample + "\nTests: 4 passed\n```"),
    true,
    "the word FAIL in prose is not a run result",
  );
  // Regression: the shipped 08 template, with a command name typed into the
  // table but no output pasted, must NOT pass Gate 4. This is the exact hole
  // the fenced-block rule closes.
  {
    // Build the block exactly as run-evidence.mjs does, outputHash included —
    // otherwise every case below only tests "hash missing" and nothing else.
    const att = (code, dur = 12, at = "2026-09-18T09:00:00Z", out = "Tests: 12 passed", wt = "beef1234beef1234") => {
      const body = `$ ${sample}\n${out}`;
      return ["```", body, ATTEST_MARK, `exitCode: ${code}`, `durationMs: ${dur}`,
              "gitRev: a3f9c1e", ...(wt ? [`worktree: ${wt}`] : []), `startedAt: ${at}`, `outputHash: ${hashOutput(body)}`, "```"].join("\n");
    };

    // #137: evidence that ran against a DIFFERENT tree than the one being shipped.
    // Every other fake above is caught by a field inside the block; this one is
    // only visible by comparing the block to the repo, and before this check the
    // whole flow "run the tests → keep editing → ship" was green. gitRev was
    // parsed and never compared, so it caught nothing.
    assert.deepEqual(attestationDefects(att(0), "08", "attested", { current: "beef1234beef1234" }), [],
      "evidence whose worktree matches the tree on disk is clean");
    assert.ok(
      attestationDefects(att(0), "08", "attested", { current: "0000ffff0000ffff" })
        .some((d) => /ran against a different tree/.test(d)),
      "code edited after the command ran must be caught — this is the one fake outputHash cannot see",
    );
    // Fail open, never fail closed, when the tree cannot be fingerprinted: no git,
    // shallow clone, a repo that is not one. A gate that reds every such task is
    // a gate that gets switched off, and an unverifiable tree is not a stale one.
    assert.deepEqual(attestationDefects(att(0), "08", "attested", { current: null }), [],
      "no fingerprint available (no git / CI) → the check is skipped, not failed");
    assert.deepEqual(attestationDefects(att(0), "08", "attested", {}), [],
      "no context passed at all → skipped, so every other entry point keeps working");
    assert.deepEqual(attestationDefects(att(0, 12, "2026-09-18T09:00:00Z", "Tests: 12 passed", "unavailable"), "08", "attested", { current: "beef1234beef1234" }), [],
      'a block whose wrapper could not read git records "unavailable" — that is honest, not stale');
    // A block from before this field existed stays a warning: an in-flight task
    // must not go red purely from a kernel upgrade, same rule as evidenceMode.
    assert.deepEqual(attestationDefects(att(0, 12, "2026-09-18T09:00:00Z", "Tests: 12 passed", null), "08", "attested", { current: "beef1234beef1234" }), [],
      "an attestation predating #137 has no worktree field and is not failed for it");
    assert.ok(
      attestationDefects(att(0, 12, "2026-09-18T09:00:00Z", "Tests: 12 passed", null), "08", "attested", { current: "x", requireWorktree: true })
        .some((d) => /no worktree fingerprint/.test(d)),
      "once requireWorktree is on, a block with no witness is rejected",
    );
    // #154: the Gate-5 window is a read-only role's window too, and the kernel now
    // demands the witness there — but only from FINGERPRINT_SINCE on, so a repo that
    // upgrades mid-task does not go red for blocks it wrote under the old rule.
    const gate = { current: "beef1234beef1234", requireWorktree: true, since: FINGERPRINT_SINCE };
    assert.ok(
      attestationDefects(att(0, 12, FINGERPRINT_SINCE + "T08:00:00Z", "Tests: 12 passed", null), "08", "attested", gate)
        .some((d) => /no worktree fingerprint/.test(d)),
      "a block from the day the rule starts must name the tree it tested",
    );
    assert.deepEqual(
      attestationDefects(att(0, 12, "2026-01-02T08:00:00Z", "Tests: 12 passed", null), "08", "attested", gate).filter((d) => /worktree/.test(d)),
      [],
      "a block older than the rule is not failed for a field its kernel never wrote",
    );
    assert.equal(Object.keys(treeCtxPolicy("done")).length, 0, "a shipped task is never re-fingerprinted");
    assert.equal(Object.keys(treeCtxPolicy("in_progress")).length, 0, "while the code is still moving there is nothing to witness");
    assert.equal(treeCtxPolicy("reviewing").requireWorktree, true,
      "#154: the transition that accepts the verdict demands the witness — a block with no fingerprint is not enough");
    assert.equal(treeCtxPolicy("reviewing").since, FINGERPRINT_SINCE, "the cutoff travels with the requirement");
    // CI is the one place treeCtx() must stay inert (the merge checkout differs by
    // design), so the two branches assert different things — both are honest.
    if (process.env.CI || process.env.GITHUB_ACTIONS) assert.deepEqual(treeCtx("reviewing"), {}, "in CI the tree is a merge checkout: no witness to demand");
    else assert.equal(treeCtx("reviewing").current, currentWorktreeFingerprint(REPO_ROOT), "off CI the policy carries the tree's fingerprint (null when git cannot answer)");
    // #154: the subprocess path is the difference between "the tree matches" and
    // "nothing was compared". The #118 split broke it for four releases: the spawn
    // pointed at lib/run-evidence.mjs, every result was null, and null fails open.
    assert.ok(existsSync(join(dirname(fileURLToPath(import.meta.url)), "..", "run-evidence.mjs")),
      "the fingerprint wrapper must be found one level up — a wrong path silently disables #137/#154");

    assert.deepEqual(attestationDefects(att(0), "08"), [], "an exit-0 attestation is clean");

    // A quiet command is the normal case for tsc/eslint/build: exit 0 and no
    // output at all. RESULT_RE finds nothing to match, so before this branch
    // the wrapper's own evidence was REJECTED while hand-pasted "Tests: 12
    // passed" sailed through -- attested mode rewarding the thing it forbids.
    assert.ok(hasRealEvidenceIn(att(0, 12, "2026-09-18T09:00:00Z", "")),
      "a quiet exit-0 command run through the wrapper is evidence; the exit code is the result");
    // The other direction, or the branch above becomes a way in: a non-zero
    // attestation must NOT pass just because it carries an attestation, no
    // matter how green the text next to it reads.
    assert.ok(!hasRealEvidenceIn(att(1, 12, "2026-09-18T09:00:00Z", "Tests: 12 passed")),
      "exitCode 1 is a failure however green the pasted output looks");
    // The 08 template PRINTS the known-failure marker inside a fence to teach
    // it. A whole-file test therefore armed the escape hatch in every task
    // copied from the template -- exitCode 1 passed Gate 4 with nobody typing
    // anything. The declaration only counts outside a fence.
    assert.ok(
      !hasRealEvidenceIn("```\n<!-- known-failure: AC-01 -->\n```\n" + att(1)),
      "a known-failure marker quoted inside a fence must not arm the escape hatch",
    );
    assert.ok(
      hasRealEvidenceIn("<!-- known-failure: AC-01 -->\n" + att(1)),
      "a real declaration above the block still allows a deliberate red test",
    );
    assert.deepEqual(
      attestationDefects("```\n<!-- known-failure: AC-01 -->\n```\n" + att(1), "08")
        .filter((d) => /exitCode 1/.test(d)).length,
      1,
      "the fenced marker must not silence attestationDefects either",
    );
    // outputHash: the two cheapest fakes that per-field checks let through.
    assert.ok(
      attestationDefects(att(0).replace("Tests: 12 passed", "Tests: 99 passed"), "08")
        .some((d) => /outputHash does not match/.test(d)),
      "editing the output after the run while keeping the attestation must be caught",
    );
    assert.ok(
      attestationDefects(att(0).replace(/outputHash: .+/, ""), "08").some((d) => /no outputHash/.test(d)),
      "an attestation without outputHash is a hand-typed or outdated block",
    );
    assert.ok(
      attestationDefects(att(1), "08").some((d) => /exitCode 1/.test(d)),
      "printing passed with exitCode 1 must be caught — a regex never sees this",
    );
    // durationMs 0 = no process ran; a missing field = a hand-typed block.
    assert.ok(
      attestationDefects(att(0, 0), "08").some((d) => /durationMs/.test(d)),
      "durationMs 0 means no command actually ran",
    );
    assert.ok(
      attestationDefects(ATTEST_MARK + "\nexitCode: 0\n", "08").some((d) => /durationMs/.test(d)),
      "an attestation missing durationMs is untrustworthy",
    );
    // known-failure is still a valid escape hatch, as with FAILURE_RE.
    assert.deepEqual(
      attestationDefects("<!-- known-failure: AC-03 -->\n" + att(1), "08"),
      [],
      "a declared deliberately-red test makes a non-zero exitCode legitimate",
    );
    // Both modes must be tested EXPLICITLY, not by reading whatever config is
    // active: a test of "is a missing attestation an error" that depends on the
    // source repo's evidenceMode loses half its coverage to a one-line change.
    assert.deepEqual(attestationDefects("no attestation here", "08", "legacy"), [],
      'legacy: a migrating repo must not go all red from a kernel upgrade');
    assert.ok(
      attestationDefects("```\n$ " + sample + "\nTests: 12 passed\n```", "08", "attested")
        .some((d) => /attestation/.test(d)),
      'attested: hand-typed output with no attestation must be blocked — that is why this mode exists',
    );

    // liteDefects (#80 R5): one case per branch, each isolating one rule.
    const ev = (...blocks) => "# X-1\n\n## Evidence\n" + blocks.join("\n");
    assert.deepEqual(liteDefects(ev(att(0))), [], "lite: an attested green run passes");
    assert.ok(liteDefects("# X-1\n" + att(0)).some((d) => /## Evidence/.test(d)), "lite: no Evidence section fails");
    assert.ok(liteDefects(ev("```\n$ " + sample + "\nTests: 12 passed\n```")).some((d) => /no run-evidence/.test(d)),
      "lite: hand-pasted output fails even in legacy mode — no later gate backs it up");
    assert.ok(liteDefects(ev(att(0).replace("Tests: 12 passed", "Tests: 99 passed"))).some((d) => /outputHash/.test(d)),
      "lite: edited output fails");
    assert.deepEqual(liteDefects("<!-- known-failure: repro -->\n" + ev(att(1), att(0))), [],
      "lite: red repro then green fix, declared, passes");
    assert.ok(liteDefects("<!-- known-failure: repro -->\n" + ev(att(0), att(1))).some((d) => /last attestation/.test(d)),
      "lite: ending red means the fix never went green, known-failure or not");

    // Gate 5 must run AFTER the implementer. An earlier startedAt = a copied block.
    const evNew = att(0, 12, "2026-09-18T10:00:00Z");
    const advOld = att(0, 12, "2026-09-18T09:00:00Z");
    assert.ok(
      adversaryDefects(advOld + "\nPASS\n| `" + sample + "` | ok |", evNew).some((d) => /BEFORE/.test(d)),
      "a 09 attestation older than 08's = the adversary did not run it",
    );
    const advNew = att(0, 12, "2026-09-18T11:00:00Z");
    assert.ok(
      !adversaryDefects(advNew + "\nPASS\n| `" + sample + "` | ok |", evNew).some((d) => /BEFORE/.test(d)),
      "running afterwards is not flagged",
    );
    assert.ok(
      !adversaryDefects(advOld + "\n## Update — round 2\n" + advNew + "\nPASS\n| `" + sample + "` | ok |", evNew).some((d) => /BEFORE/.test(d)),
      "round 1's old attestation kept by append-only must not fail round 2",
    );
    assert.ok(
      adversaryDefects(advNew + "\n## Update — round 2\n" + advOld + "\nPASS\n| `" + sample + "` | ok |", evNew).some((d) => /BEFORE/.test(d)),
      "a stale attestation in the NEWEST block is still flagged",
    );
  }

  // --task: the key is the last two segments, accepting every form the
  // coordinator might hold.
  assert.equal(taskKeyOf("docs/tasks/sprint-1/ABC-1-x"), "sprint-1/ABC-1-x", "full path");
  assert.equal(taskKeyOf("sprint-1/ABC-1-x"), "sprint-1/ABC-1-x", "short form");
  assert.equal(taskKeyOf("./docs/tasks/sprint-1/ABC-1-x/"), "sprint-1/ABC-1-x", "leading ./ and trailing /");
  assert.equal(taskKeyOf("docs\\tasks\\sprint-1\\ABC-1-x"), "sprint-1/ABC-1-x", "Windows \\ separators");
}

