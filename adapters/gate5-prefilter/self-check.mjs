#!/usr/bin/env node
// node adapters/gate5-prefilter/self-check.mjs — no network, no key, no cost.
import assert from "node:assert/strict";
import { section, buildState, decide, QUESTIONS } from "./prefilter.mjs";

const reply = (verdict, confidence, noul = {}) => ({
  ok: true, json: async () => ({ answers: { verdict: { type: "choice", choice: verdict, confidence }, ...noul } }),
});
const fetchOf = (r) => async () => r;

// 1. the five questions the measurement was made with must stay atomic + typed
assert.equal(Object.keys(QUESTIONS).length, 5);
assert.equal(QUESTIONS.verdict.type, "choice");
assert.deepEqual(Object.keys(QUESTIONS.verdict.criteria), ["PASS", "FAIL"]);

// 2. section(): a missing heading is "", never a throw
assert.equal(section("## A\nx\n## B\ny", "## A", "## B"), "## A\nx\n");
assert.equal(section("nothing here", "## A", "## B"), "", "absent section is empty, not fatal");
assert.match(buildState({ review: "## Acceptance criteria\n| AC-01 |\n## BA questions", plan: "", notes: "", evidence: "", diff: "d", sources: "s", tests: "t", testRun: "ok 1" }), /AC-01[\s\S]*ok 1/);

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
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
const CLI = fileURLToPath(new URL("./prefilter.mjs", import.meta.url));
const task = mkdtempSync(`${tmpdir()}/pf-`);
let answer;
const srv = createServer((q, r) => { r.setHeader("content-type", "application/json"); r.end(JSON.stringify(answer)); });
await new Promise((ok) => srv.listen(0, "127.0.0.1", ok));
const url = `http://127.0.0.1:${srv.address().port}/`;
const run = (env) => new Promise((ok) => {
  // async spawn: the fake server lives in this process, a sync spawn would block it
  import("node:child_process").then(({ spawn }) => {
    const c = spawn(process.execPath, [CLI, task], { cwd: task, env: { PATH: process.env.PATH, GATE5_PREFILTER_URL: url, ...env } });
    let err = ""; c.stderr.on("data", (b) => (err += b)); c.on("close", (code) => ok({ code, err }));
  });
});
const v = (choice, confidence) => ({ answers: { verdict: { type: "choice", choice, confidence }, code_violates_ac: { type: "noul", noul: 0.9 } } });

let r = await run({});
assert.equal(r.code, 0, "no key → exit 0"); assert.match(r.err, /no TYPESAFE_API_KEY/);
answer = v("PASS", 1.0); r = await run({ TYPESAFE_API_KEY: "k" });
assert.equal(r.code, 0, "PASS at confidence 1.0 must NOT block"); assert.match(r.err, /not actionable/);
answer = v("FAIL", 0.97); r = await run({ TYPESAFE_API_KEY: "k" });
assert.equal(r.code, 1, "confident FAIL blocks"); assert.match(r.err, /code_violates_ac/);
answer = v("FAIL", 0.5); r = await run({ TYPESAFE_API_KEY: "k" });
assert.equal(r.code, 0, "unsure FAIL → skipped, adversary decides");
answer = { garbage: true }; r = await run({ TYPESAFE_API_KEY: "k" });
assert.equal(r.code, 0, "schema drift → fail-open");
r = await run({ TYPESAFE_API_KEY: "k", GATE5_PREFILTER_URL: "http://127.0.0.1:1/" });
assert.equal(r.code, 0, "endpoint down → fail-open");
srv.close();

console.log("✅ gate5-prefilter self-check passed");
