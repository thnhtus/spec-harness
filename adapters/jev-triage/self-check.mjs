import { spawnSync } from "node:child_process";
import { writeFileSync, unlinkSync } from "node:fs";
import assert from "node:assert/strict";

const run = (env = {}, input = "") => {
  const r = spawnSync(process.execPath, ["adapters/jev-triage/jev-triage.mjs"], { env: { ...process.env, ...env }, input, encoding: "utf8" });
  return { code: r.status, out: r.stdout.trim(), err: r.stderr.trim() };
};

// no key → fail-closed assessment, exit 0
let r = run({ TYPESAFE_API_KEY: "" }, '{"vector":{"scope":1},"counts":{},"questions":[]}');
assert.equal(r.code, 0, "no key → exit 0");
let j = JSON.parse(r.out);
assert.equal(j.confidence, 0, "no key → confidence 0 (fail-closed)");
assert.equal(j.evidenceSufficient, false, "no key → not sufficient");

// invalid JSON input → fail-closed
r = run({ TYPESAFE_API_KEY: "" }, "not json");
assert.equal(r.code, 0);
j = JSON.parse(r.out);
assert.equal(j.confidence, 0, "bad input → fail-closed");

console.log("jev-triage self-check: PASS");
