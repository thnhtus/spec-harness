#!/usr/bin/env node
import assert from "node:assert/strict";
import { estimate, LIMITS, CONFIDENCE_THRESHOLD } from "./budget-gate.mjs";

assert.equal(typeof LIMITS.perRun, "number");
assert.equal(typeof CONFIDENCE_THRESHOLD, "number");

const e = estimate("loop", { turns: 10, tokensPerTurn: 1000 });
assert.equal(typeof e.cost, "number");
assert.ok(e.detail.includes("10 turns"));

import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
const CLI = fileURLToPath(new URL("./budget-gate.mjs", import.meta.url));

let r = spawnSync(process.execPath, [CLI, "api", JSON.stringify({ calls: 1 })], { encoding: "utf8", env: { PATH: process.env.PATH } });
assert.equal(r.status, 0, "no key → exit 0");

r = spawnSync(process.execPath, [CLI, "loop", JSON.stringify({ turns: 1000, tokensPerTurn: 1000 })], { encoding: "utf8", env: { PATH: process.env.PATH, BUDGET_MAX_LOOP_TURNS: "5" } });
assert.equal(r.status, 78, "over max loop turns → 78");

r = spawnSync(process.execPath, [CLI, "--report"], { encoding: "utf8", env: { PATH: process.env.PATH, BUDGET_LOG_FILE: "/tmp/bg-test.log" } });
assert.equal(r.status, 0);

console.log("✅ budget-gate self-check passed");
