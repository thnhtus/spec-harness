#!/usr/bin/env node
// Jev triage adapter (#172) — independent second opinion over the complexity vector.
//
//   echo '<complexity-json>' | node adapters/jev-triage/jev-triage.mjs
//   node adapters/jev-triage/jev-triage.mjs <file>
//
// Input: the same complexity object the coding agent produced (vector + counts +
// questions + note). Jev does NOT re-survey the codebase; it judges the
// evidence bundle the agent already gathered.
//
// Output (stdout, JSON): { dataRisk, blastRadiusRisk, irreversibleRisk,
// evidenceSufficient, confidence } — the inputs to the deterministic policy.
// Exit 0 always (fail-open): no key / bad response / timeout → prints a
// fail-closed assessment { ..., confidence: 0, evidenceSufficient: false } so the
// caller's policy routes to "review" rather than "auto". Never blocks.

import { readFileSync } from "node:fs";

const MODEL = process.env.JEV_TRIAGE_MODEL ?? "jev-1.13.0";
const ENDPOINT = process.env.JEV_TRIAGE_URL ?? "https://api.typesafe.ai/v1/systemone";
const KEY = process.env.TYPESAFE_API_KEY;

const FAIL_CLOSED = { dataRisk: 1, blastRadiusRisk: 1, irreversibleRisk: 1, evidenceSufficient: false, confidence: 0 };

const QUESTIONS = {
  data_risk: { type: "score", instructions: "Given the evidence bundle, how likely is this task to alter or destroy data that already exists in production (schema change, migration, delete, overwrite)?" },
  blast_radius_risk: { type: "score", instructions: "How far beyond a single location does a defect in this change reach (callers, contracts, external systems, other modules)?" },
  irreversible_risk: { type: "score", instructions: "If implemented incorrectly, can the change be fully rolled back by reverting a commit or editing again (1 = fully reversible, 0 = not)?" },
  evidence_sufficient: { type: "noul", instructions: "Is the evidence bundle (counts, open questions, diff, tests) sufficient to hand this task to an agent for autonomous execution without further clarification?" },
};

function readInput() {
  const arg = process.argv[2];
  if (arg) return readFileSync(arg, "utf8");
  return readFileSync(0, "utf8");
}

async function decide(state) {
  if (!KEY) return { skip: "no TYPESAFE_API_KEY" };
  const res = await fetch(ENDPOINT, {
    method: "POST",
    headers: { Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model: MODEL, state, questions: QUESTIONS }),
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) return { skip: `endpoint ${res.status}` };
  const body = await res.json();
  const a = body?.answers ?? {};
  const num = (x) => (typeof x === "number" && Number.isFinite(x) ? Math.max(0, Math.min(1, x)) : null);
  const dr = num(a.data_risk?.score);
  const br = num(a.blast_radius_risk?.score);
  const ir = num(a.irreversible_risk?.score);
  const es = a.evidence_sufficient;
  const evSuf = typeof es?.noul === "boolean" ? !es.noul : (typeof es?.choice === "string" ? es.choice.toUpperCase() === "NO" : null);
  const conf = num(a.data_risk?.confidence ?? a.blast_radius_risk?.confidence ?? 0);
  if (dr === null || br === null || ir === null || evSuf === null) return { skip: "unrecognised response shape" };
  return { dataRisk: dr, blastRadiusRisk: br, irreversibleRisk: ir, evidenceSufficient: evSuf, confidence: conf ?? 0 };
}

const main = async () => {
  let raw;
  try { raw = readInput(); } catch (e) { console.log(JSON.stringify(FAIL_CLOSED)); return; }
  let cx;
  try { cx = JSON.parse(raw); } catch { console.log(JSON.stringify(FAIL_CLOSED)); return; }
  // Build a compact state from the bundle — never re-survey.
  const state = [
    "## Complexity vector", JSON.stringify(cx?.vector ?? {}),
    "## Counts", JSON.stringify(cx?.counts ?? {}),
    "## Open questions", JSON.stringify(cx?.questions ?? []),
    "## Note", String(cx?.note ?? ""),
    "## Split evaluated", String(cx?.splitEvaluated ?? ""),
  ].join("\n");

  let r;
  try { r = await decide(state); } catch { r = { skip: "call failed" }; }
  if (r.skip) { console.error(`jev-triage: skipped — ${r.skip}`); console.log(JSON.stringify(FAIL_CLOSED)); return; }
  console.log(JSON.stringify(r));
};

main();
