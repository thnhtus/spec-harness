#!/usr/bin/env node
// Gate 5 pre-filter (#108) — OPTIONAL, OFF unless an API key is present.
//
//   node adapters/gate5-prefilter/prefilter.mjs <task-folder> [base-branch=main]
//
//   exit 0  skipped (no key, no endpoint, bad response, low confidence, too
//           large) OR the decision was PASS. Either way: run the real adversary.
//   exit 1  the decision model says FAIL with high confidence. The adversary
//           dispatch can be skipped and the task routed straight back to the
//           implementer, saving one 54k-132k-token review.
//
// WHY ONLY ONE DIRECTION BLOCKS. Measured over 20 cases (8 eval + 12 held-out):
// 8 of 14 buggy ones were blocked here, 0 of 6 clean ones were — so a confident
// FAIL is worth acting on, and the 6 it is unsure about just go on to the real
// adversary. A PASS is different in kind: two real bugs (an off-by-one
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

// Pinned, never an alias: a moving "latest" silently reshapes the probabilities
// this threshold was tuned against.
const MODEL = process.env.GATE5_PREFILTER_MODEL ?? "jev-1.13.0";
const ENDPOINT = process.env.GATE5_PREFILTER_URL ?? "https://api.typesafe.ai/v1/systemone";
const KEY = process.env.TYPESAFE_API_KEY;
// 0.9: the two false PASSes measured sat at 0.78 and 0.98, so no threshold saves
// a PASS. This one only guards the FAIL side, where the lowest correct FAIL
// confidence measured was 0.84.
const MIN_CONFIDENCE = Number(process.env.GATE5_PREFILTER_MIN_CONFIDENCE ?? 0.9);
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

// Section of a markdown file between two headings. Absent section = "", never a
// throw: a task missing an artifact is the gate's business, not this script's.
export function section(text, from, to) {
  const i = text.indexOf(from);
  if (i === -1) return "";
  const j = to ? text.indexOf(to, i + from.length) : -1;
  return text.slice(i, j === -1 ? undefined : j);
}

export function buildState({ review, plan, notes, evidence, diff, sources, tests, testRun }) {
  return [
    "## AC", section(review, "## Acceptance criteria", "## BA questions"),
    "## Planned files", section(plan, "## Files to change", "## Test plan"),
    "## Plan Deviations", section(notes, "## Plan Deviations", "## Handoff"),
    "## Diff vs base (files)", diff,
    "## Source", sources,
    "## Tests", tests,
    "## 08 evidence", section(evidence, "### AC coverage", "### Output"),
    "## Fresh test run now", testRun,
  ].join("\n");
}

export async function decide(state, { fetchImpl = fetch } = {}) {
  const res = await fetchImpl(ENDPOINT, {
    method: "POST",
    headers: { Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model: MODEL, state, questions: QUESTIONS }),
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
  if (!KEY) skip("no TYPESAFE_API_KEY — the adversary runs as usual");
  const rd = (f) => (existsSync(join(task, f)) ? readFileSync(join(task, f), "utf8") : "");
  const { execFileSync } = await import("node:child_process");
  const sh = (cmd, args) => { try { return execFileSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }); } catch (e) { return e.stdout ?? ""; } };

  const state = buildState({
    review: rd("02-FSD-Review.md"), plan: rd("03-Technical-Plan.md"),
    notes: rd("06-Implementation-Notes.md"), evidence: rd("08-Test-Evidence.md"),
    diff: sh("git", ["diff", "--stat", base, "--", "src", "test"]),
    sources: sh("git", ["ls-files", "src"]).split("\n").filter(Boolean).map((f) => `### ${f}\n${readFileSync(f, "utf8")}`).join("\n"),
    tests: sh("git", ["ls-files", "test"]).split("\n").filter(Boolean).map((f) => `### ${f}\n${readFileSync(f, "utf8")}`).join("\n"),
    testRun: sh("npm", ["run", "--silent", "test:scope"]),
  });
  if (Buffer.byteLength(state) > MAX_STATE_BYTES) skip(`state ${Buffer.byteLength(state)}B over ${MAX_STATE_BYTES}B`);

  let r;
  try { r = await decide(state); } catch (e) { skip(`decision call failed: ${e.message}`); }
  if (r.skip) skip(r.skip);
  if (r.choice !== "FAIL") skip(`verdict ${r.choice} is not actionable on its own — a PASS here has been measured wrong at confidence 0.98`);
  if (r.confidence < MIN_CONFIDENCE) skip(`FAIL at confidence ${r.confidence.toFixed(2)} < ${MIN_CONFIDENCE}`);
  const why = Object.entries(r.answers).filter(([k, a]) => a.type === "noul" && a.noul >= 0.7).map(([k]) => k);
  console.error(`gate5-prefilter: FAIL (confidence ${r.confidence.toFixed(2)})${why.length ? ` — ${why.join(", ")}` : ""}`);
  console.error("This is a cheap pre-read, not the Gate 5 record: the adversary still owns 09.");
  process.exit(1);
}
