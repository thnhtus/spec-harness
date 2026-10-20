#!/usr/bin/env node
// Gate 5 pre-filter (#108) — OPTIONAL, OFF unless an API key is present.
//
//   node adapters/gate5-prefilter/prefilter.mjs <task-folder> [base-branch=main] [stage=adversarial_review]
//
// `stage` is the stage being DISPATCHED (what --advance was asked for), so the
// gate it guards is the one just behind it: technical_plan <- Gate 2 (AC),
// implementation <- Gate 3 (test plan), adversarial_review <- Gate 5. A stage
// not in STAGES exits 0 — an unknown stage is never a block (#113).
//
//   exit 0  skipped (no key, no endpoint, bad response, low confidence, too
//           large) OR the decision was PASS. Either way: run the real adversary.
//   exit 78 the decision model says FAIL with high confidence. The adversary
//           dispatch can be skipped and the task routed straight back to the
//           implementer, saving one 54k-132k-token review.
//
// WHY ONLY ONE DIRECTION BLOCKS. Measured through this CLI over 20 cases (8 eval
// + 12 held-out): 5 of 14 buggy ones were blocked, 0 of 6 clean ones were — so
// a confident FAIL is worth acting on, and the 9 it is unsure about just go on
// to the real adversary. (An earlier 8/14 came from a hand-built state richer
// than what this script collects; that number was not what callers get.) A PASS is different in kind: two real bugs (an off-by-one
// threshold, a rounding error) came back PASS at confidence 0.78 and 0.98,
// because this model reads text and never runs the code. So PASS here means
// "no opinion", never "approved".
//
// WHY IT IS NOT IN kernel/. The kernel decides with exit codes and names no
// vendor (install --self-test enforces both). This is a project-layer adapter:
// delete it and every gate behaves exactly as before.
//
// FAIL-OPEN EVERYWHERE. No key, no network, a 4xx, a schema change, a context
// overflow — all exit 0 with one line on stderr. A missing accelerator must
// never become a missing gate.

import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

// Pinned, never an alias: a moving "latest" silently reshapes the probabilities
// this threshold was tuned against.
const MODEL = process.env.GATE5_PREFILTER_MODEL ?? "jev-1.13.0";
const ENDPOINT = process.env.GATE5_PREFILTER_URL ?? "https://api.typesafe.ai/v1/systemone";
const KEY = process.env.TYPESAFE_API_KEY;
// 0.9: the two false PASSes measured sat at 0.78 and 0.98, so no threshold saves
// a PASS. This one only guards the FAIL side, where the lowest correct FAIL
// confidence measured was 0.84.
const MIN_CONFIDENCE = Number(process.env.GATE5_PREFILTER_MIN_CONFIDENCE ?? 0.9);
const CODE_CHECKS = process.env.GATE5_PREFILTER_CODE_CHECKS === "1";
const MAX_STATE_BYTES = 24000; // model context is 32k tokens; stay well under

const skip = (why) => { console.error(`gate5-prefilter: skipped — ${why}`); process.exit(0); };

export const QUESTIONS = {
  code_violates_ac: { type: "noul", instructions: "Does any function in ## Source return a value that contradicts an acceptance criterion in the AC table for some input the AC names?" },
  test_misses_ac: { type: "noul", instructions: "Is there an AC in the AC table for which no test in ## Tests asserts the exact boundary or example value that AC names?" },
  out_of_scope: { type: "noul", instructions: "Does ## Diff vs base list a file under src/ that is neither in ## Planned files nor declared under ## Plan Deviations?" },
  tests_fail_now: { type: "noul", instructions: "Does ## Fresh test run now show any 'not ok' line or a fail count above 0?" },
  verdict: {
    type: "choice",
    instructions: "Gate 5 adversarial review verdict for this change.",
    criteria: {
      PASS: "Code meets every AC, tests genuinely assert each AC, diff stays inside the plan or declared deviations, tests pass now.",
      FAIL: "At least one AC is violated, a test is vacuous or missing for an AC, an undeclared file is changed, or the tests fail now.",
    },
  },
};

// #113: Gates 2 and 3 read only 02/03, so the state is two short tables
// (~0.3-0.8k tokens, 0.2-1.8 s) and the whole call costs less than one dispatch
// of the role it would save. Measured on the real API (jev-1.13.0, 2026-10-11):
//   Gate 2: 11/14 vague-AC sets blocked, 0/20 measurable sets blocked.
//   Gate 3:  2/6 thin plans blocked ("TBD", "verify manually"), 0/3 sound plans.
// Misses are real: a vague AC next to concrete ones ("`total` is computed
// correctly") reads PASS-ish, and a plan that tests the WRONG value (150, not the
// boundary 100) is not seen at all — that is #107's lane. Same one-way rule as
// Gate 5: FAIL >= MIN_CONFIDENCE blocks, PASS never does.
const AC_VAGUE = { type: "noul", instructions: "Is there an acceptance criterion whose pass/fail cannot be decided by a test with a concrete input and an expected value (it uses subjective words like fast, good, friendly, reasonable, appropriate, sufficient)?" };
const PLAN_GAP = { type: "noul", instructions: "Is there an AC in the AC table that appears in neither the Covers AC column of the test plan nor the table of ACs that cannot be automated?" };
const PLAN_PLACEHOLDER = { type: "noul", instructions: "Does any test-plan row have a placeholder instead of a runnable command (TBD, TODO, '...', 'verify manually', 'covered by existing tests')?" };
const verdict = (gate, PASS, FAIL) => ({ type: "choice", instructions: `${gate} verdict.`, criteria: { PASS, FAIL } });

export const STAGES = {
  technical_plan: {
    questions: { ac_vague: AC_VAGUE, verdict: verdict("Gate 2 on these acceptance criteria", "Every AC names a concrete input and an exact expected output or observable state.", "At least one AC is subjective or untestable as written.") },
    state: (task) => ["## AC", section(rd(task, "02-FSD-Review.md"), "## Acceptance criteria", "## BA questions")].join("\n"),
  },
  implementation: {
    questions: { plan_gap: PLAN_GAP, placeholder: PLAN_PLACEHOLDER, verdict: verdict("Gate 3 on this test plan", "Every AC is covered by a runnable one-shot command or is listed as not automatable with an alternative.", "An AC is uncovered, or a covering row is a placeholder rather than a runnable command.") },
    state: (task) => ["## AC", section(rd(task, "02-FSD-Review.md"), "## Acceptance criteria", "## BA questions"), section(rd(task, "03-Technical-Plan.md"), "## Test plan", "## Implementation checklist")].join("\n"),
  },
  adversarial_review: { questions: QUESTIONS, state: (task, base) => collectState(task, base) },
};

const rd = (task, f) => (existsSync(join(task, f)) ? readFileSync(join(task, f), "utf8") : "");

// Section of a markdown file between two headings. Absent section = "", never a
// throw: a task missing an artifact is the gate's business, not this script's.
export function section(text, from, to) {
  const i = text.indexOf(from);
  if (i === -1) return "";
  const j = to ? text.indexOf(to, i + from.length) : -1;
  return text.slice(i, j === -1 ? undefined : j);
}

export function buildState({ review, plan, notes, evidence, diff, sources, tests, testRun, evidenceRev, headRev, commitsAfterEvidence }) {
  return [
    "## AC", section(review, "## Acceptance criteria", "## BA questions"),
    "## Planned files", section(plan, "## Files to change", "## Test plan"),
    "## Plan Deviations", section(notes, "## Plan Deviations", "## Handoff"),
    "## Diff vs base (files)", diff,
    "## Source", sources,
    "## Tests", tests,
    "## 08 evidence", section(evidence, "### AC coverage", "### Output"),
    // Without these three lines "the attested run is older than the code" is
    // invisible and stale evidence reads as a clean PASS. The AC coverage table
    // above says which test covers what; only the revisions say whether that
    // claim was made about the code sitting here now.
    `attested gitRev: ${evidenceRev || "unknown"}`,
    `HEAD: ${headRev || "unknown"}`,
    `commits after the attested run: ${commitsAfterEvidence || "none"}`,
    "## Fresh test run now", testRun,
  ].join("\n");
}

// Everything the decision model sees, gathered by running real commands in cwd.
// Exported so a measurement reads exactly the state the CLI sends.
export function collectState(task, base = "main") {
  const rd1 = (f) => rd(task, f);
  const sh = (cmd, args) => { try { return execFileSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }); } catch (e) { return e.stdout ?? ""; } };
  const files = (dir) => sh("git", ["ls-files", dir]).split("\n").filter(Boolean).map((f) => `### ${f}\n${readFileSync(f, "utf8")}`).join("\n");
  const ev = rd1("08-Test-Evidence.md");
  return buildState({
    review: rd1("02-FSD-Review.md"), plan: rd1("03-Technical-Plan.md"),
    notes: rd1("06-Implementation-Notes.md"), evidence: ev,
    diff: sh("git", ["diff", "--stat", base, "--", "src", "test"]),
    sources: files("src"), tests: files("test"),
    testRun: sh("npm", ["run", "--silent", "test:scope"]),
    evidenceRev: [...ev.matchAll(/gitRev:\s*(\S+)/g)].at(-1)?.[1],
    headRev: sh("git", ["rev-parse", "--short", "HEAD"]).trim(),
    commitsAfterEvidence: sh("git", ["log", "--oneline", "-5"]).trim(),
  });
}

export async function decide(state, { fetchImpl = fetch, questions = QUESTIONS } = {}) {
  const res = await fetchImpl(ENDPOINT, {
    method: "POST",
    headers: { Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model: MODEL, state, questions }),
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) return { skip: `decision endpoint returned ${res.status}` };
  const body = await res.json();
  const v = body?.answers?.verdict;
  if (!v || typeof v.choice !== "string") return { skip: "unrecognised response shape" };
  return { choice: v.choice, confidence: Number(v.confidence ?? 0), answers: body.answers };
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split("/").pop())) {
  const task = process.argv[2];
  if (!task) skip("usage: prefilter.mjs <task-folder> [base-branch]");
  const base = process.argv[3] ?? "main"; // the task's target branch (00-Metadata), not always main
  const stage = STAGES[process.argv[4] ?? "adversarial_review"];
  if (!stage) skip(`no pre-filter for stage "${process.argv[4]}"`);
  if (CODE_CHECKS) {
    // #173: tests_fail_now is answered by running the test command, not by the
    // model. Fail-open on crash/timeout.
    let code = 0, out = "";
    try { out = execFileSync("npm", ["run", "--silent", "test:scope"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }); }
    catch (e) {
      if (typeof e?.status !== "number") skip(`test command crashed/timeout: ${e?.message ?? e}`);
      code = e.status;
      out = e.stdout ?? "";
    }
    if (code !== 0) {
      console.error(`gate5-prefilter: FAIL — tests_fail_now (exit ${code})`);
      console.error("This is a cheap pre-read, not a gate record: the real role still owns the artifact.");
      process.exit(78);
    }
  }
  if (!KEY) skip("no TYPESAFE_API_KEY — the real role runs as usual");
  const questions = CODE_CHECKS
    ? Object.fromEntries(Object.entries(stage.questions).filter(([k]) => k !== "out_of_scope"))
    : stage.questions;
  const state = stage.state(task, base);
  if (Buffer.byteLength(state) > MAX_STATE_BYTES) skip(`state ${Buffer.byteLength(state)}B over ${MAX_STATE_BYTES}B`);

  let r;
  try { r = await decide(state, { questions }); } catch (e) { skip(`decision call failed: ${e.message}`); }
  if (r.skip) skip(r.skip);
  if (r.choice !== "FAIL") skip(`verdict ${r.choice} is not actionable on its own — a PASS here has been measured wrong at confidence 0.98`);
  if (r.confidence < MIN_CONFIDENCE) skip(`FAIL at confidence ${r.confidence.toFixed(2)} < ${MIN_CONFIDENCE}`);
  const why = Object.entries(r.answers).filter(([k, a]) => a.type === "noul" && a.noul >= 0.7).map(([k]) => k);
  console.error(`gate5-prefilter: FAIL (confidence ${r.confidence.toFixed(2)})${why.length ? ` — ${why.join(", ")}` : ""}`);
  console.error("This is a cheap pre-read, not a gate record: the real role still owns the artifact.");
  // 78, not 1: node exits 1 on an uncaught throw, and a crash must never block (#109).
  process.exit(78);
}
