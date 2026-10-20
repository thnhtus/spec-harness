#!/usr/bin/env node
// Budget gate (#budget-gate) — optional, off unless wired. Hard limits in code;
// Jev (typesafe.ai) answers only the judgment questions (Choice/Noul/Score).
//
//   node adapters/budget-gate/budget-gate.mjs <opType> '<json params>'
//   node adapters/budget-gate/budget-gate.mjs --report
//   node adapters/budget-gate/budget-gate.mjs --record-actual <runId> <cost>
//   node adapters/budget-gate/budget-gate.mjs --feedback <runId> <note>
//
// opType ∈ {browser, loop, batch, bigcontext, api}
//
// Exit codes: 0 = allowed (run may proceed, possibly on cheaper path — see stdout JSON);
//            78 = hard limit exceeded, do not run.
// FAIL-OPEN: no key / no network / bad response → exit 0 with a skip line.

import { readFileSync, existsSync, appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";

export const LIMITS = {
  perRun: Number(process.env.BUDGET_PER_RUN ?? 10),
  perDay: Number(process.env.BUDGET_PER_DAY ?? 50),
  maxLoopTurns: Number(process.env.BUDGET_MAX_LOOP_TURNS ?? 50),
  maxRetries: Number(process.env.BUDGET_MAX_RETRIES ?? 3),
};
export const CONFIDENCE_THRESHOLD = Number(process.env.BUDGET_CONFIDENCE_THRESHOLD ?? 0.7);

const MODEL = process.env.BUDGET_GATE_MODEL ?? "jev-1.13.0";
const ENDPOINT = process.env.BUDGET_GATE_URL ?? "https://api.typesafe.ai/v1/systemone";
const KEY = process.env.TYPESAFE_API_KEY;

const HOME = homedir();
const LOG_DIR = process.env.BUDGET_LOG_DIR ?? join(HOME, ".spec-harness");
const LOG_FILE = process.env.BUDGET_LOG_FILE ?? join(LOG_DIR, "budget.log");

export function skip(why) { console.error(`budget-gate: skipped — ${why}`); process.exit(0); }
export function block(why) { console.error(`budget-gate: BLOCKED — ${why}`); process.exit(78); }

function loadConfig() {
  const candidates = [
    process.env.BUDGET_CONFIG,
    join(process.cwd(), "budget.config.json"),
    join(LOG_DIR, "budget.config.json"),
  ].filter(Boolean);
  for (const c of candidates) {
    if (c && existsSync(c)) {
      try { return JSON.parse(readFileSync(c, "utf8")); } catch {}
    }
  }
  return {};
}
const CONFIG = loadConfig();
const prices = CONFIG.prices ?? {};

function ensureLogDir() { try { mkdirSync(LOG_DIR, { recursive: true }); } catch {} }

export function readLog() {
  if (!existsSync(LOG_FILE)) return [];
  return readFileSync(LOG_FILE, "utf8").split("\n").filter(Boolean).map((l) => {
    try { return JSON.parse(l); } catch { return null; }
  }).filter(Boolean);
}
function appendLog(entry) { ensureLogDir(); appendFileSync(LOG_FILE, JSON.stringify(entry) + "\n"); }

export function estimate(op, params) {
  switch (op) {
    case "browser": {
      const pages = Number(params.pages ?? 1);
      const secondsPerPage = Number(params.secondsPerPage ?? prices.browserSecondsPerPage ?? 5);
      const ratePerSecond = Number(prices.browserRatePerSecond ?? 0);
      return { cost: pages * secondsPerPage * ratePerSecond, unit: "usd", detail: `${pages} pages x ${secondsPerPage}s x ${ratePerSecond}/s` };
    }
    case "loop": {
      const turns = Number(params.turns ?? params.maxTurns ?? 1);
      const tokensPerTurn = Number(params.tokensPerTurn ?? prices.loopTokensPerTurn ?? 0);
      const pricePerToken = Number(prices.loopPricePerToken ?? 0);
      return { cost: turns * tokensPerTurn * pricePerToken, unit: "usd", detail: `${turns} turns x ${tokensPerTurn} tok x ${pricePerToken}/tok` };
    }
    case "batch": {
      const items = Number(params.items ?? 1);
      const costPerItem = Number(params.costPerItem ?? prices.batchCostPerItem ?? 0);
      return { cost: items * costPerItem, unit: "usd", detail: `${items} items x ${costPerItem}/item` };
    }
    case "bigcontext": {
      const tokens = Number(params.tokens ?? 0);
      const pricePerToken = Number(prices.bigContextPricePerToken ?? 0);
      return { cost: tokens * pricePerToken, unit: "usd", detail: `${tokens} tok x ${pricePerToken}/tok` };
    }
    case "api": {
      const calls = Number(params.calls ?? 1);
      const ratePerCall = Number(params.ratePerCall ?? prices.apiRatePerCall ?? 0);
      return { cost: calls * ratePerCall, unit: "usd", detail: `${calls} calls x ${ratePerCall}/call` };
    }
    default:
      return { cost: 0, unit: "usd", detail: "unknown op" };
  }
}

function todayCost() {
  const start = new Date(); start.setHours(0,0,0,0);
  return readLog()
    .filter((e) => e.ts && new Date(e.ts) >= start)
    .reduce((s, e) => s + Number(e.estimated ?? 0), 0);
}

function recentTaskLog(n = 20) {
  return readLog().slice(-n).map((e) => JSON.stringify(e)).join("\n");
}

async function askJev(state) {
  const res = await fetch(ENDPOINT, {
    method: "POST",
    headers: { Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model: MODEL, state, questions: {
      choice: { type: "choice", instructions: "What is enough for this request?", criteria: {
        CHEAP_PATH: "Search, cached data, or a small model — enough for most requests.",
        FULL_RUN: "Run the expensive operation in full.",
        ASK_USER: "Pause and ask the user before spending.",
      }},
      noul: { type: "noul", instructions: "Was this same task already done in this session? Answer based on the recent task log provided as state." },
      score: { type: "score", instructions: "How much would the answer change if we skip the expensive step? 0 not at all, 1 a little, 2 a lot, 3 it cannot be answered without it." },
    } }),
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) return { skip: `decision endpoint returned ${res.status}` };
  return await res.json();
}

function pickAnswer(body, key) {
  const a = body?.answers?.[key];
  if (!a) return null;
  if (a.choice !== undefined) return { kind: "choice", value: a.choice, confidence: Number(a.confidence ?? 0) };
  if (a.noul !== undefined) return { kind: "noul", value: a.noul, confidence: Number(a.confidence ?? 1) };
  if (a.score !== undefined) return { kind: "score", value: a.score, confidence: Number(a.confidence ?? 1) };
  if (a.value !== undefined) return { kind: key, value: a.value, confidence: Number(a.confidence ?? 1) };
  return null;
}

async function main() {
  const args = process.argv.slice(2);

  if (args[0] === "--report") {
    const log = readLog();
    const totalEst = log.reduce((s, e) => s + Number(e.estimated ?? 0), 0);
    const totalAct = log.reduce((s, e) => s + Number(e.actual ?? 0), 0);
    const byRoute = {};
    for (const e of log) byRoute[e.route ?? "unknown"] = (byRoute[e.route ?? "unknown"] || 0) + 1;
    const skipped = log.filter((e) => e.route === "CHEAP_PATH" || e.route === "skipped");
    const shouldHave = log.filter((e) => e.feedback === "should-have-gone");
    process.stdout.write(JSON.stringify({
      runs: log.length,
      totalEstimated: totalEst,
      totalActual: totalAct,
      byRoute,
      skippedRuns: skipped.map((e) => ({ runId: e.runId, op: e.op, reason: e.reason })),
      skippedShouldHaveGone: shouldHave.map((e) => ({ runId: e.runId, op: e.op })),
    }, null, 2) + "\n");
    process.exit(0);
  }

  if (args[0] === "--record-actual") {
    const runId = args[1];
    const actual = Number(args[2]);
    appendLog({ ts: new Date().toISOString(), type: "actual", runId, actual });
    console.error(`recorded actual ${actual} for ${runId}`);
    process.exit(0);
  }

  if (args[0] === "--feedback") {
    const runId = args[1];
    const note = args.slice(2).join(" ");
    appendLog({ ts: new Date().toISOString(), type: "feedback", runId, feedback: note.includes("should-have-gone") ? "should-have-gone" : note });
    console.error(`recorded feedback for ${runId}`);
    process.exit(0);
  }

  const op = args[0];
  if (!op) { skip("usage: budget-gate.mjs <opType> '<json params>' | --report | --record-actual | --feedback"); return; }

  let params = {};
  try { params = args[1] ? JSON.parse(args[1]) : {}; } catch { skip("bad params JSON"); return; }

  const est = estimate(op, params);
  if (est.cost > LIMITS.perRun) { block(`per-run ${est.cost} > ${LIMITS.perRun}`); return; }
  if (todayCost() + est.cost > LIMITS.perDay) { block(`per-day ${todayCost() + est.cost} > ${LIMITS.perDay}`); return; }
  if (op === "loop") {
    const turns = Number(params.turns ?? params.maxTurns ?? 0);
    if (turns > LIMITS.maxLoopTurns) { block(`max loop turns ${turns} > ${LIMITS.maxLoopTurns}`); return; }
  }
  if (params.retries !== undefined && Number(params.retries) > LIMITS.maxRetries) { block(`max retries ${params.retries} > ${LIMITS.maxRetries}`); return; }

  const runId = randomUUID();

  if (!KEY) {
    appendLog({ ts: new Date().toISOString(), runId, op, params, estimated: est.cost, unit: est.unit, detail: est.detail, route: "FULL_RUN", reason: "no TYPESAFE_API_KEY — Jev not consulted", confidence: null });
    process.stdout.write(JSON.stringify({ runId, route: "FULL_RUN", estimated: est.cost, reason: "no key, skipped Jev" }) + "\n");
    process.exit(0);
  }

  const state = [
    "## Operation", op,
    "## Params", JSON.stringify(params),
    "## Estimated cost", `${est.cost} ${est.unit} (${est.detail})`,
    "## Recent task log", recentTaskLog(),
  ].join("\n");

  let body;
  try { body = await askJev(state); } catch (e) { skip(`decision call failed: ${e.message}`); return; }
  if (body?.skip) { skip(body.skip); return; }

  const choiceAns = pickAnswer(body, "choice");
  const noulAns = pickAnswer(body, "noul");
  const scoreAns = pickAnswer(body, "score");

  let route = "FULL_RUN";
  let reason = "";
  const alreadyDone = noulAns && (noulAns.value === true || noulAns.value === 1 || noulAns.value === "yes" || Number(noulAns.value) >= 0.7);
  const scoreVal = scoreAns ? Number(scoreAns.value) : 3;
  const confident = choiceAns && choiceAns.confidence >= CONFIDENCE_THRESHOLD;

  if (alreadyDone) { route = "CHEAP_PATH"; reason = "noul: already done this session"; }
  else if (scoreVal <= 1) { route = "CHEAP_PATH"; reason = `score ${scoreVal}: skipping won't change answer much`; }
  else if (!confident) { route = "CHEAP_PATH"; reason = `Jev confidence ${choiceAns?.confidence ?? 0} < ${CONFIDENCE_THRESHOLD}`; }
  else { route = choiceAns.value; }

  if (route === "ASK_USER") { route = "CHEAP_PATH"; reason = "Jev: ASK_USER → defaulting to cheaper path"; }

  const cheap = route === "CHEAP_PATH";
  appendLog({ ts: new Date().toISOString(), runId, op, params, estimated: est.cost, unit: est.unit, detail: est.detail, route, reason, confidence: choiceAns?.confidence ?? null, noul: noulAns?.value ?? null, score: scoreVal });
  process.stdout.write(JSON.stringify({ runId, route, estimated: est.cost, reason, skipped: cheap ? "expensive step skipped" : null }));
  process.exit(0);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
