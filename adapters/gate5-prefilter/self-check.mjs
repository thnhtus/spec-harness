#!/usr/bin/env node
// node adapters/gate5-prefilter/self-check.mjs — no network, no key, no cost.
import assert from "node:assert/strict";
import { section, buildState, decide, QUESTIONS, STAGES } from "./prefilter.mjs";

const reply = (verdict, confidence, noul = {}) => ({
  ok: true, json: async () => ({ answers: { verdict: { type: "choice", choice: verdict, confidence }, ...noul } }),
});
const fetchOf = (r) => async () => r;

// 1. the five questions the measurement was made with must stay atomic + typed
assert.equal(Object.keys(QUESTIONS).length, 5);
assert.equal(QUESTIONS.verdict.type, "choice");
assert.deepEqual(Object.keys(QUESTIONS.verdict.criteria), ["PASS", "FAIL"]);

// 1b. #113: every stage ends in a typed PASS/FAIL verdict, and Gate 2/3 state is
// built from 02/03 alone (no git, no npm — they run before any code exists).
assert.deepEqual(Object.keys(STAGES), ["technical_plan", "implementation", "adversarial_review"]);
for (const [k, st] of Object.entries(STAGES)) {
  assert.equal(st.questions.verdict.type, "choice", k);
  assert.deepEqual(Object.keys(st.questions.verdict.criteria), ["PASS", "FAIL"], k);
}

// 2. section(): a missing heading is "", never a throw
assert.equal(section("## A\nx\n## B\ny", "## A", "## B"), "## A\nx\n");
assert.equal(section("nothing here", "## A", "## B"), "", "absent section is empty, not fatal");
assert.match(buildState({ review: "## Acceptance criteria\n| AC-01 |\n## BA questions", plan: "", notes: "", evidence: "", diff: "d", sources: "s", tests: "t", testRun: "ok 1" }), /AC-01[\s\S]*ok 1/);
// stale evidence is only visible if the revisions travel with the claim
assert.match(buildState({ review: "", plan: "", notes: "", evidence: "", diff: "", sources: "", tests: "", testRun: "", evidenceRev: "aaa1111", headRev: "bbb2222", commitsAfterEvidence: "bbb2222 tidy" }), /attested gitRev: aaa1111[\s\S]*HEAD: bbb2222/);
assert.match(buildState({ review: "", plan: "", notes: "", evidence: "", diff: "", sources: "", tests: "", testRun: "" }), /attested gitRev: unknown/, "missing revisions must not throw");

// 3. fail-open on every bad answer the endpoint can give
for (const [name, res] of [
  ["4xx", { ok: false, status: 429 }],
  ["schema drift", { ok: true, json: async () => ({ answers: {} }) }],
  ["non-string choice", { ok: true, json: async () => ({ answers: { verdict: { choice: 7 } } }) }],
]) assert.ok((await decide("s", { fetchImpl: fetchOf(res) })).skip, `${name} must be skippable, never a verdict`);

// 4. a real verdict is passed through with its confidence
const d = await decide("s", { fetchImpl: fetchOf(reply("FAIL", 0.97)) });
assert.deepEqual([d.choice, d.confidence], ["FAIL", 0.97]);

// 5. End to end through the real CLI against a local fake endpoint: the exit
// code is the only thing a caller reads, so that is what gets asserted.
// THE INVARIANT: PASS never blocks, at any confidence (two real bugs measured
// PASS at 0.78 and 0.98).
import { createServer } from "node:http";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
const CLI = fileURLToPath(new URL("./prefilter.mjs", import.meta.url));
const task = mkdtempSync(`${tmpdir()}/pf-`);
let answer;
const srv = createServer((q, r) => { r.setHeader("content-type", "application/json"); r.end(JSON.stringify(answer)); });
await new Promise((ok) => srv.listen(0, "127.0.0.1", ok));
const url = `http://127.0.0.1:${srv.address().port}/`;
writeFileSync(`${task}/02-FSD-Review.md`, "## Acceptance criteria\n| AC-01 | f() is fast |\n## BA questions\n");
writeFileSync(`${task}/03-Technical-Plan.md`, "## Test plan\n| unit | TBD | AC-01 |\n## Implementation checklist\n");
assert.match(STAGES.technical_plan.state(task), /AC-01 \| f\(\) is fast/);
assert.doesNotMatch(STAGES.technical_plan.state(task), /Test plan/, "Gate 2 must not see the plan");
assert.match(STAGES.implementation.state(task), /AC-01[\s\S]*TBD/);
const run = (env, stage) => new Promise((ok) => {
  // async spawn: the fake server lives in this process, a sync spawn would block it
  import("node:child_process").then(({ spawn }) => {
    const c = spawn(process.execPath, [CLI, task, "main", ...(stage ? [stage] : [])], { cwd: task, env: { PATH: process.env.PATH, GATE5_PREFILTER_URL: url, ...env } });
    let err = ""; c.stderr.on("data", (b) => (err += b)); c.on("close", (code) => ok({ code, err }));
  });
});
const v = (choice, confidence) => ({ answers: { verdict: { type: "choice", choice, confidence }, code_violates_ac: { type: "noul", noul: 0.9 } } });

let r = await run({});
assert.equal(r.code, 0, "no key → exit 0"); assert.match(r.err, /no TYPESAFE_API_KEY/);
answer = v("PASS", 1.0); r = await run({ TYPESAFE_API_KEY: "k" });
assert.equal(r.code, 0, "PASS at confidence 1.0 must NOT block"); assert.match(r.err, /not actionable/);
answer = v("FAIL", 0.97); r = await run({ TYPESAFE_API_KEY: "k" });
assert.equal(r.code, 78, "confident FAIL blocks with the dedicated code, never 1"); assert.match(r.err, /code_violates_ac/);
answer = v("FAIL", 0.5); r = await run({ TYPESAFE_API_KEY: "k" });
assert.equal(r.code, 0, "unsure FAIL → skipped, adversary decides");
answer = { garbage: true }; r = await run({ TYPESAFE_API_KEY: "k" });
assert.equal(r.code, 0, "schema drift → fail-open");
r = await run({ TYPESAFE_API_KEY: "k", GATE5_PREFILTER_URL: "http://127.0.0.1:1/" });
assert.equal(r.code, 0, "endpoint down → fail-open");
// #113: the same one-way rule at every stage. PASS never blocks, a confident FAIL
// blocks with 78, an unknown stage is never a block (and never reaches the network).
for (const stage of ["technical_plan", "implementation", "adversarial_review"]) {
  answer = v("PASS", 1.0); r = await run({ TYPESAFE_API_KEY: "k" }, stage);
  assert.equal(r.code, 0, `${stage}: PASS at 1.0 must NOT block`);
  answer = v("FAIL", 0.97); r = await run({ TYPESAFE_API_KEY: "k" }, stage);
  assert.equal(r.code, 78, `${stage}: confident FAIL blocks`);
  answer = v("FAIL", 0.5); r = await run({ TYPESAFE_API_KEY: "k" }, stage);
  assert.equal(r.code, 0, `${stage}: unsure FAIL → skipped`);
}
answer = v("FAIL", 1.0); r = await run({ TYPESAFE_API_KEY: "k" }, "fsd_review");
assert.equal(r.code, 0, "a stage with no pre-filter is never a block, even if the endpoint would say FAIL"); assert.match(r.err, /no pre-filter for stage/);
srv.close();

console.log("✅ gate5-prefilter self-check passed");
