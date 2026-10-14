import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CFG } from "./config.mjs";
import { calibrate } from "./lifecycle.mjs";
import { sliceBudget } from "./scope.mjs";
// Model cascade (Agents.md §5.3.1): a retry must not run on the tier that just
// failed. The base tier comes from role x taskComplexity; each extra attempt
// lifts it one notch, capped at `strong`. This is the same asymmetry as §5.1.3
// on the vector -- raising is allowed, lowering is the forbidden direction,
// because a cheaper retry buys rework odds, not savings.
//
// Checked against telemetry rather than a plan, because telemetry is what the
// coordinator actually recorded after each dispatch.
export const TIER_ORDER = ["cheap", "mid", "strong"];


// The §5.3 table, resolved from config instead of read off a markdown table by
// the coordinator. Prose in three files that no check ever read is the same
// drift shape `docEnums` exists to end -- and here the drift silently routes
// money. Returns { tier, model, base } or { error }.
// Every CLI install.mjs --cli knows, plus claude. install --self-test asserts this
// equals install.mjs CLIS: the validator ships alone, it cannot import the installer.
export const CLI_NAMES = ["claude", "codex", "cursor", "gemini", "qwen", "copilot", "droid", "windsurf", "devin", "kiro",
  "antigravity", "cline", "goose", "codewhale", "opencode", "pi", "hermes", "amp"];


// config.models is per CLI: { "<cli>": { cheap|mid|strong: { model, effort? } } }.
// The kernel never names a vendor model; each CLI's names live under its own key,
// so switching CLI is adding a key, not rewriting one shared map.
export const EFFORTS = ["low", "medium", "high"];


// #100: lease.mjs is only sound on a local fs (its KNOWN LIMIT). Two signals,
// both cheap: the Linux statfs magic (other platforms report a vfs index that
// means nothing portable, so they get no verdict from it), and -- the half that
// actually breaks the TTL -- a file just written there carrying a server clock.
// ponytail: NFS on macOS with an in-sync clock passes silently; add mount(8)
// parsing if a lease clash is ever reported from one.
export const NETFS_MAGIC = { 0x6969: "nfs", 0xff534d42: "cifs", 0xfe534d42: "smb2", 0x517b: "smb",
  0x5346414f: "afs", 0x01021997: "9p", 0x65735546: "fuse" };


// Complexity is DERIVED, never asserted: the agent fills the vector, this formula
// decides the label (Agents.md §5.1.1). Risk floors matter because a one-file fix
// in auth middleware is not "trivial" however small the diff is.
export const RANK = ["trivial", "normal", "high"];

export const EFFORT_KEYS = ["scope", "uncertainty", "dependency", "dataImpact", "integration", "testing"];

export const RISK_KEYS = ["blastRadius", "reversibility"];


// The vector is only as good as what it was scored from. Nothing above checks
// that: `scope: 0` derives a label just as validly whether it came from `rg -l`
// or from a feeling, and the cheapest failure in this harness is a vector scored
// from the task description alone — `uncertainty` guessed low is what produces
// `fsd_review` retries, and rework costs more than every model decision combined.
//
// So each soft dimension must name the count it came from. These are the only
// two directions that are actually derivable (a count cannot tell you e2e is
// needed, so `testing: 2` stays the agent's call):
//   filesTouched == 1  ⇒ scope == 0     · filesTouched > 5 ⇒ scope == 2
//   existingTests == 0 ⇒ testing >= 1   (nothing covers it yet, by definition)
// and `questions` makes `uncertainty` answerable: a listed blocker means the
// requirement is not clear, an empty list means it is. Both directions, because
// the loophole is symmetric.
//
// Second rule, same function: a task big enough to be worth splitting must say
// it considered splitting -- at BOOTSTRAP, not after `retryBudget` is spent.
// `status: split` already exists but only as an exit from an exhausted budget,
// by which point the money is gone. Two `normal` tasks run cheaper than one
// `high` task that bounces twice.
export const SPLIT_EFFORT = CFG.splitEffort ?? 9;

export const NON_ANSWER_RE = /^(n\/?a|no|none|nope|-+|\.|tbd|todo|\?)$/i;


// The escape hatches (`quick-task` / `fix-bug`) had no feedback loop. --triage
// logged the verdict, nothing logged what happened next, and --calibrate only
// reads tasks with `outcome.closedAt` -- which an escaped task never has,
// because it has no task folder at all. So the one question that matters about
// the riskFloor thresholds ("are they letting real bugs out?") was unanswerable
// for exactly the tasks that skipped every gate.
//
// Same log file, an extra row shape: verdict column = "outcome", forced column
// = escaped|clean, vector column = "-" so triageVectorFor's JSON.parse skips it
// (a row that parsed would make a task with ONLY an outcome row look triaged).
//
// ponytail: self-reported. Nothing on disk can contradict "clean" -- an escaped
// task leaves no artifact to check. Coverage is therefore reported next to
// every finding, exactly as `outcome.closedAt` coverage is. Upgrade path: when
// a bugfix task carries `regressionOf: <taskId>`, count that instead.
export const ESCAPE_VERDICTS = ["quick-task", "fix-bug"];


// #85: an unfilled adapter. The template carries a NOT-FILLED-IN marker and
// `<…>` cells; only install's self-test read the marker, so a repo whose .mcp.json
// was tidied passed preflight with ProjectRules still the empty skeleton -- every
// role then reads `<lint command>` as its §7. Config placeholders are errors (they
// route: repoName is looked up by name); ProjectRules cells left as `<…>` are
// warnings, because /init-project-rules is told to leave an honest `<…> TODO:`.
// 0.12 (#88): --triage takes {vector,counts,questions}. The installer rewrites
// the one line it shipped; a caller the user wrote (CI script, Makefile, own
// skill) still passes a bare vector and exits 2 on its first run. Find it here.
// Literal callers only — `--triage "$VEC"` is caught at run time by triageMigrationHint.
export const STALE_TRIAGE = /--triage\s+(?:['"]<vector|['"]?\{\s*\\?"(?:scope|uncertainty|dependency|dataImpact|integration|testing|blastRadius|reversibility)\\?"\s*:)/;


// The vector triage was answered with, if it left a trace.
//
// Triage runs BEFORE task.agent.json exists, so unlike deriveComplexity (which
// the validator recomputes from the stored vector) nothing could check it. An
// agent wanting to skip the harness only had to score `scope: 0` instead of 1.
//
// This does not make anyone honest. It makes scoring low to dodge the harness
// leave a trace -- the same level of defence run-evidence.mjs settled on: move
// it from "slipped through" to "deliberate, and logged".
export function triageVectorFor(logPath, taskId) {
  if (!existsSync(logPath)) return null;
  let found = null;
  for (const line of readFileSync(logPath, "utf8").split("\n")) {
    const col = line.split("\t");
    if (col.length < 5 || col[1] !== taskId) continue;
    let v;
    try { v = JSON.parse(col[4]); } catch { continue; } // a corrupt line must not fabricate a finding
    if (v === null || typeof v !== "object" || Array.isArray(v)) continue;
    // The LOWEST score ever entered, per dimension -- not the last one.
    // "Last entry wins" handed back the dodge it was built to catch: score low,
    // get `quick-task`, then re-run --triage with the honest vector and the
    // drift check compares the stored vector against itself. The number that
    // decided whether this task needed the harness is the smallest one typed.
    found ??= {};
    for (const [k, n] of Object.entries(v))
      if (Number.isInteger(n) && (!(k in found) || n < found[k])) found[k] = n;
  }
  return found;
}


// How the stored vector differs from the one triage was answered with.
//
// Both directions are worth a word, for opposite reasons. UP is expected --
// §5.1.3 says a Glob/Grep pass sees less than bootstrap does -- but the lower
// number is what decided whether this task needed the harness at all. DOWN is
// the one §5.1.3 forbids outright ("only raise, never lower"): lowering a dimension
// buys a lighter gate and a cheaper model tier, which is exactly the incentive
// the rule exists to remove. Nothing used to check it.
export function vectorDriftSince(triaged, stored) {
  if (!triaged || !stored) return { raised: [], lowered: [] };
  const fmt = (k) => `${k} ${triaged[k] ?? 0}→${stored[k]}`;
  const keys = Object.keys(stored);
  return {
    raised: keys.filter((k) => (stored[k] ?? 0) > (triaged[k] ?? 0)).map(fmt),
    lowered: keys.filter((k) => (stored[k] ?? 0) < (triaged[k] ?? 0)).map(fmt),
  };
}

export function modelsDefects(cfg = CFG) {
  const errors = [], warnings = [];
  const m = cfg.models ?? {};
  if (!TIER_ORDER.includes(cfg.coordinatorTier))
    errors.push(`config.coordinatorTier must be one of ${TIER_ORDER.join("/")}, got ${JSON.stringify(cfg.coordinatorTier)} — add "coordinatorTier": "mid" to harness.config.json`);
  if ((cfg.baseTier ?? {}).coordinator)
    errors.push("config.baseTier.coordinator: the coordinator's model is fixed when the session opens, before complexity exists — use config.coordinatorTier");
  if (Object.values(m).some((v) => typeof v === "string")) {
    warnings.push('config.models is the old flat { cheap: "…" } map — re-declare it per CLI: { "<cli>": { "cheap": { "model": "…" }, … } }. Until then nothing is routed.');
    return { errors, warnings };
  }
  for (const [cli, tiers] of Object.entries(m)) {
    if (!CLI_NAMES.includes(cli)) { errors.push(`config.models.${cli}: not a known CLI (${CLI_NAMES.join(", ")})`); continue; }
    for (const k of Object.keys(tiers ?? {})) if (!TIER_ORDER.includes(k)) errors.push(`config.models.${cli}.${k}: not a tier`);
    for (const t of TIER_ORDER) {
      const e = tiers?.[t];
      if (!e || typeof e.model !== "string" || !e.model) { errors.push(`config.models.${cli}.${t}.model is required once models.${cli} is set`); continue; }
      for (const k of Object.keys(e)) if (!["model", "effort", "sliceBytes"].includes(k)) errors.push(`config.models.${cli}.${t}.${k}: unknown key (model, effort, sliceBytes)`);
      // #77: a budget that is present but unusable would silently fall back to the top-level one.
      if ("sliceBytes" in e && !(Number.isInteger(e.sliceBytes) && e.sliceBytes >= 1)) errors.push(`config.models.${cli}.${t}.sliceBytes must be an integer ≥ 1, got ${JSON.stringify(e.sliceBytes)}`);
      // The subset every CLI that has the knob accepts (Claude adds xhigh/max, Codex ultra) —
      // a value one CLI rejects must not pass here and fail at dispatch.
      if ("effort" in e && !EFFORTS.includes(e.effort)) errors.push(`config.models.${cli}.${t}.effort must be one of ${EFFORTS.join("/")}, got ${JSON.stringify(e.effort)}`);
    }
  }
  return { errors, warnings };
}

export function netFsVerdict({ platform, type, skewMs }) {
  const out = [];
  const name = platform === "linux" ? NETFS_MAGIC[type] : undefined;
  if (name) out.push(`on a ${name} filesystem`);
  if (Math.abs(skewMs) > 5000) out.push(`its clock is ${Math.round(skewMs / 1000)}s off the local one`);
  return out;
}


// R1 (#81): an installed CLI layer with no models.<cli> runs every role on the
// session model. Legal (a warning, not an error), but it used to be silent:
// the cascade and per-tier budgets simply did not exist there and nothing said so.
export function unroutedClis(installed, cfg = CFG) {
  return [...new Set(installed)].filter((c) => c !== "claude" && !(cfg.models ?? {})[c]);
}


// #97: the same silence, one field over. sliceBudget() falls back to the
// top-level sliceBytes when a model has none of its own -- legal, and the only
// thing it can do, but that fallback was measured on one specific model (#76;
// see config.sliceBytes). Routed to a different model it is a guess, and the
// first sign of a wrong guess is an auto-compact mid-implementation, which looks
// like the implementer forgetting rather than a config that was never measured.
// Only the tier that actually dispatches implementation is checked: a budget on
// a tier no implementer run uses would be measured for nothing.
export function unmeasuredSliceBudgets(installed, cfg = CFG) {
  const tier = (cfg.baseTier ?? {}).implementer?.[1]; // normal column = the base tier
  if (!tier) return [];
  return [...new Set(installed)]
    .filter((c) => (cfg.models ?? {})[c]?.[tier]?.model && sliceBudget(cfg, c, tier).from === "sliceBytes")
    .map((c) => `models.${c}.${tier} (${cfg.models[c][tier].model}) has no sliceBytes — implementation falls back to the top-level ${cfg.sliceBytes}, measured on a different model (#76, see config). Measure yours:\n` +
      `    node install.mjs --bench --stage implementation --unsliced --find-slice-bytes --agent '<your ${c} command>'`);
}


export function resolveTier(role, complexity, attempt = 1, cfg = CFG, cli = null) {
  const RANKS = ["trivial", "normal", "high"];
  const row = (cfg.baseTier ?? {})[role];
  if (!row) return { error: `config.baseTier has no row for role "${role}" (§5.3)` };
  const i = RANKS.indexOf(complexity);
  if (i < 0) return { error: `taskComplexity "${complexity}" is not one of ${RANKS.join("/")}` };
  const base = row[i];
  if (!TIER_ORDER.includes(base)) return { error: `config.baseTier.${role}[${i}] = "${base}" is not a tier` };
  if (!Number.isInteger(attempt) || attempt < 1) return { error: `attempt must be an integer >= 1, got ${attempt}` };
  // §5.3.1: each extra attempt lifts one notch, capped at strong.
  const tier = TIER_ORDER[Math.min(TIER_ORDER.length - 1, TIER_ORDER.indexOf(base) + attempt - 1)];
  // No entry for this CLI = it routes nothing; say so rather than inventing a name.
  const e = (cfg.models ?? {})[cli]?.[tier];
  const model = typeof e === "object" && e?.model ? e.model : null;
  return { tier, model, base };
}


// --triage runs BEFORE task.agent.json exists, so it is the one entry point the
// schema never sees -- and it is the gate that decides whether the harness runs
// at all. Unchecked it accepted `{}` (→ quick-task), `"junk"` (→ quick-task),
// `{"scope":"2"}` (string concat: "effort 0200000") and `null` (stack trace).
// A routing decision taken from rubbish is worse than no routing decision.
export function vectorInputErrors(v) {
  if (v === null || typeof v !== "object" || Array.isArray(v))
    return ["the vector must be a JSON object with all 8 dimensions (Agents.md §5.1.2)"];
  const out = [];
  for (const [keys, max] of [[EFFORT_KEYS, 2], [RISK_KEYS, 4]])
    for (const k of keys) {
      const n = v[k];
      if (n === undefined) out.push(`${k} missing — score it, do not omit it (0–${max})`);
      else if (!Number.isInteger(n) || n < 0 || n > max) out.push(`${k}=${JSON.stringify(n)} — must be an integer 0–${max}`);
    }
  const extra = Object.keys(v).filter((k) => !EFFORT_KEYS.includes(k) && !RISK_KEYS.includes(k));
  if (extra.length) out.push(`unknown dimension(s): ${extra.join(", ")} — a typo here scores 0 silently`);
  if (out.length) return out; // ranges first: coherence on rubbish says nothing
  return vectorCoherenceDefects(v);
}


// `blastRadius` and `reversibility` are the strongest dimensions (riskFloor
// alone drags trivial → high) and the only two with nothing to check them
// against — §5.1 says so and declines to invent a fake count. Fair. But the
// effort dimensions ARE scored from evidence, and some combinations are simply
// incoherent: a schema migration that is "revert a commit" to undo, a new
// external contract whose failure reaches nobody. That is not a measurement,
// it is arithmetic on what the agent already wrote down — and it closes the
// cheapest dodge there is, since scoring blastRadius 1 instead of 3 skips every
// other rule in §5.1 at once.
export function vectorCoherenceDefects(v) {
  const out = [];
  if ((v.dataImpact ?? 0) === 2 && (v.reversibility ?? 0) < 2)
    out.push(`dataImpact=2 but reversibility=${v.reversibility ?? 0} — a schema change/migration cannot be undone by editing again or reverting a commit (Agents.md §5.1)`);
  if ((v.integration ?? 0) === 2 && (v.blastRadius ?? 0) < 1)
    out.push(`integration=2 but blastRadius=${v.blastRadius ?? 0} — a new/changed contract or an external system reaches past one spot by definition (Agents.md §5.1)`);
  return out;
}


export function deriveComplexity(vector) {
  const effort = EFFORT_KEYS.reduce((n, k) => n + (vector[k] ?? 0), 0);
  const base = effort <= 2 ? "trivial" : effort <= 6 ? "normal" : "high";
  const { blastRadius = 0, reversibility = 0 } = vector;
  const riskFloor =
    blastRadius >= 3 || reversibility >= 3 ? "high"
    : blastRadius >= 2 || reversibility >= 2 ? "normal"
    : "trivial";
  return { effort, label: RANK[Math.max(RANK.indexOf(base), RANK.indexOf(riskFloor))] };
}


export function vectorEvidenceDefects(complexity) {
  const v = complexity?.vector;
  if (!v) return [];
  const out = [];
  const c = complexity.counts ?? {};
  const num = (k) => (Number.isInteger(c[k]) ? c[k] : null);

  // Which symbol was grepped is a free parameter that picks the answer: a rare
  // helper returns 1 file (scope 0), a common one returns 20 (scope 2). Naming
  // it does not remove the choice, it makes the choice reviewable.
  // >=3 chars, no whitespace: "a" or "the resolver" is not something anyone can
  // re-run `rg` with, and a symbol nobody can re-run is not evidence.
  const sym = String(c.symbol ?? "").trim();
  if (!sym)
    out.push("complexity.counts.symbol missing — name the symbol filesTouched was grepped for; picking the symbol picks the scope (Agents.md §5.1)");
  else if (sym.length < 3 || /\s/.test(sym))
    out.push(`complexity.counts.symbol="${sym}" — must be a greppable identifier (≥3 chars, no spaces): the point is that a reviewer can re-run the same rg`);

  const files = num("filesTouched");
  if (files === null)
    out.push("complexity.counts.filesTouched missing — `scope` scored from the task description is the cheapest way to under-estimate a task (Agents.md §5.1)");
  // 0 matched nothing, which means either a brand-new file or a grep that
  // missed. Those score differently and the count cannot tell them apart, so
  // it falls through every rule below — say which one it is.
  else if (files === 0 && !String(complexity.note ?? "").trim())
    out.push("counts.filesTouched=0 matched nothing — complexity.note must say whether this is a new file or the grep missed (Agents.md §5.1)");
  else if (files === 1 && v.scope !== 0)
    out.push(`counts.filesTouched=1 but scope=${v.scope} — one file is scope 0`);
  // 2..5 used to be a free-for-all: `filesTouched: 4, scope: 0` passed clean,
  // which is the whole under-scoring move with the count sitting right there
  // contradicting it. The scale says scope 0 is "1 file" -- so 2 is not 0.
  else if (files >= 2 && files <= 5 && v.scope === 0)
    out.push(`counts.filesTouched=${files} but scope=0 — scope 0 is one file; several files is at least 1`);
  else if (files > 5 && v.scope !== 2)
    out.push(`counts.filesTouched=${files} but scope=${v.scope} — more than 5 files is scope 2`);

  const tests = num("existingTests");
  if (tests === null)
    out.push("complexity.counts.existingTests missing — `testing` needs to know whether anything covers this code today (Agents.md §5.1)");
  else if (tests === 0 && (v.testing ?? 0) < 1)
    out.push("counts.existingTests=0 but testing=0 — nothing covers this yet, so it cannot be 'covered by existing tests'");

  const q = complexity.questions;
  if (!Array.isArray(q))
    out.push("complexity.questions missing — `uncertainty` is the dimension most often scored low, and the check is concrete: write the list of things you cannot build without knowing (Agents.md §5.1)");
  else {
    // [""] satisfied "non-empty" while saying nothing. Count only entries that
    // are actually a question someone could answer.
    const real = q.filter((s) => typeof s === "string" && s.trim().length >= 10);
    if (real.length < q.length)
      out.push(`complexity.questions has ${q.length - real.length} blank/stub entry(ies) — an empty string is not an open question; write it out or drop it`);
    if (real.length === 0 && (v.uncertainty ?? 0) > 0)
      out.push(`uncertainty=${v.uncertainty} but complexity.questions is empty — name what is unclear or score it 0`);
    else if (real.length > 0 && (v.uncertainty ?? 0) === 0)
      out.push(`complexity.questions lists ${real.length} open question(s) but uncertainty=0`);
  }

  const { effort } = deriveComplexity(v);
  const oversized = effort >= SPLIT_EFFORT || ((v.scope ?? 0) === 2 && (v.uncertainty ?? 0) === 2);
  const split = String(complexity.splitEvaluated ?? "").trim();
  if (oversized && !split)
    out.push(
      `effort=${effort} scope=${v.scope} uncertainty=${v.uncertainty} — a task this size must record complexity.splitEvaluated: either the child task IDs, or why it cannot ship in parts (Agents.md §5.1.4)`,
    );
  // "n/a" / "no" is the field being closed, not answered. §5.1.4 wants the split
  // QUESTION answered while the answer is still cheap; a two-letter dismissal is
  // the same as leaving it blank, and blank is already an error.
  else if (oversized && (NON_ANSWER_RE.test(split) || split.length < 20))
    out.push(
      `complexity.splitEvaluated="${split}" is a dismissal, not an answer — give the child task IDs, or the reason the parts cannot ship separately (Agents.md §5.1.4)`,
    );

  out.push(...vectorCoherenceDefects(v));
  return out;
}


// Which road a task takes: the full harness, or the quick-task / fix-bug escape
// hatch. That boundary used to be prose ("a small bug", "when the user is clear"), so it
// failed both ways -- overuse turns the harness into scenery, underuse charges
// 7 stages for a copy change.
//
// It reuses the vector and the risk floors rather than inventing a second set of
// thresholds: any risk dimension >= 2 already means `normal`, and a task that is
// not trivial has no business skipping the gates however small the diff looks.
export function triage(vector, branchType) {
  const { label, effort } = deriveComplexity(vector);
  const { blastRadius = 0, reversibility = 0 } = vector;
  if (label !== "trivial")
    return { verdict: "harness", why: `taskComplexity=${label} (effort ${effort}, blast ${blastRadius}, rev ${reversibility})` };
  // deriveComplexity already forces `normal` at >= 2, so reaching here means
  // both are <= 1. Stated explicitly: this is the rule someone will come read.
  if (blastRadius > 1 || reversibility > 1)
    return { verdict: "harness", why: `risk too high (blast ${blastRadius}, rev ${reversibility})` };
  return {
    verdict: branchType === "bugfix" ? "fix-bug" : "quick-task",
    why: `trivial (effort ${effort}, blast ${blastRadius}, rev ${reversibility})`,
  };
}


export function escapeHatchStats(logText = "", { minSample = CFG.calibrateMinSample ?? 5, ran = new Set() } = {}) {
  const verdict = new Map(); // taskId -> escape verdict
  const outcome = new Map(); // taskId -> "escaped" | "clean"
  for (const line of logText.split("\n")) {
    const col = line.split("\t");
    if (col.length < 5) continue;
    const [, taskId, v, flag] = col;
    // #88: a task with a folder ran the harness, whatever an earlier triage said.
    if (!taskId || ran.has(taskId)) continue;
    // A task triaged twice keeps the FIRST escape verdict, for the same reason
    // triageVectorFor keeps the lowest vector: re-running --triage must not
    // erase the run that actually skipped the gates.
    if (ESCAPE_VERDICTS.includes(v) && !verdict.has(taskId)) verdict.set(taskId, v);
    // "escaped" wins over "clean": a task reported clean and later found to
    // have shipped a bug is an escape, not a coin flip.
    if (v === "outcome" && (flag === "escaped" || flag === "clean"))
      if (flag === "escaped" || !outcome.has(taskId)) outcome.set(taskId, flag);
  }
  const ids = [...verdict.keys()];
  const withOutcome = ids.filter((id) => outcome.has(id));
  const escaped = withOutcome.filter((id) => outcome.get(id) === "escaped");
  const stats = {
    escapes: ids.length,
    byVerdict: ESCAPE_VERDICTS.reduce((a, v) => ((a[v] = ids.filter((id) => verdict.get(id) === v).length), a), {}),
    withOutcome: withOutcome.length,
    escapedBugs: escaped.length,
    findings: [],
  };
  if (!ids.length) return stats;
  // Coverage first, same as the shipped/closed ratio: a finding computed over a
  // quarter of the escapes describes a biased slice, and someone is about to
  // retune riskFloor with it.
  if (withOutcome.length / ids.length < 0.8)
    stats.findings.push(
      `escape-hatch outcome coverage ${withOutcome.length}/${ids.length} (<80%) — most quick-task/fix-bug runs never reported back, so nothing below can be trusted to retune riskFloor (§5.1.1)`,
    );
  if (escaped.length && ids.length >= minSample)
    stats.findings.push(
      `${escaped.length}/${withOutcome.length} escape-hatch task(s) shipped a bug (${escaped.join(", ")}) — the riskFloor thresholds are letting real risk skip all 5 gates (§5.1.1)`,
    );
  return stats;
}

// The runtime half of the same migration: a caller preflight cannot see
// (`--triage "$VEC"`, an untracked script) gets its own vector back, wrapped,
// so the fix is "fill counts" not "re-read the docs".
export function triageMigrationHint(cx) {
  const bare = cx !== null && typeof cx === "object" && !Array.isArray(cx);
  const wrapped = JSON.stringify({ vector: bare ? cx : "{…8 dims}", counts: { symbol: "<grep target>", filesTouched: "<n>", existingTests: "<n>" }, questions: [] });
  return `✖ --triage takes the complexity object, not a bare vector (0.12, Agents.md §5.1) — the counts are what keep the vector honest. Yours, wrapped:\n  '${wrapped}'`;
}


export function staleTriageCalls(grepOut) {
  return String(grepOut ?? "").split("\n").filter((l) => STALE_TRIAGE.test(l))
    .map((l) => `${l.split(":").slice(0, 2).join(":")} still calls --triage with a bare vector — 0.12 takes '{"vector":{…},"counts":{…},"questions":[…]}' (exits 2 otherwise)`);
}

// ── self-check: moved here with the logic it tests ──────────────────
export async function selfCheck({ assert }) {
  const { AC_REACHED, AC_TRACE, EVIDENCE_RE, GATE4_ARTIFACTS, GATE4_DONE, GROUP_PREFIX, LINE_CAPS, LINE_WARN, REQUIRED_AT_STAGE, ROLE_STAGE, ROUTING, STAGE_ORDER, TASKS_DIR } = await import("./config.mjs");
  const { overBudgetAccepted } = await import("./docs.mjs");
  const { stageContract } = await import("./gate5.mjs");
  const { advanceDecision, bootstrapInputErrors } = await import("./lifecycle.mjs");
  const { contextBleed } = await import("./telemetry.mjs");
  const { acsMissingIn, declaredACsIn } = await import("./trace.mjs");
  const { adapterGaps } = await import("./wiring.mjs");
  {
    const st = (l) => staleTriageCalls(l).length;
    assert.equal(st(`ci.sh:3:node scripts/validate-tasks.mjs --triage '{"scope":1,"testing":0}' --task-id X`), 1, "a bare vector caller is found");
    assert.equal(st(`Makefile:9:\tnode v.mjs --triage "{\\"testing\\":1}"`), 1, "an escaped bare vector is found");
    assert.equal(st(`a.md:1:--triage '<vector JSON>' --task-id X`), 1, "the old shipped placeholder is found");
    assert.equal(st(`a.md:1:--triage '{"vector":{"scope":1},"counts":{}}'`), 0, "the complexity object is fine");
    assert.equal(st(`a.md:1:re-running \`--triage\` does not overwrite`), 0, "prose mentioning --triage is fine");
    assert.match(staleTriageCalls(`ci.sh:3:--triage '{"scope":1}'`)[0], /^ci\.sh:3 /, "the finding names file:line");
    const h = triageMigrationHint({ scope: 1, testing: 0 });
    assert.deepEqual(JSON.parse(h.split("'")[1]).vector, { scope: 1, testing: 0 }, "the hint hands back the caller's own vector, wrapped");
    assert.ok(/"counts"/.test(h) && /0\.12/.test(triageMigrationHint(null)), "the hint names counts and the version, even for a non-object");
  }
  assert.ok(adapterGaps(null, { repos: [{ name: "<repo-name>", path: "." }] }).errors.some((e) => e.includes("repos[0].name")), "<repo-name> is an error");
  assert.equal(adapterGaps("| `<lint command>` | x |", { repos: [{ name: "a", path: "." }] }).warnings.length, 1, "a leftover <…> cell warns");
  assert.deepEqual(adapterGaps("| `npm run lint` | x |", { repos: [{ name: "a", path: "." }] }), { errors: [], warnings: [] }, "filled adapter is clean");

  // Regression: an untouched template must NOT satisfy traceability. Templates
  // use "AC-nn" placeholders precisely so a real AC-01 is never pre-covered.
  const tpl = (n) => readFileSync(join(TASKS_DIR, "_templates", n), "utf8");
  if (AC_TRACE.declaredIn)
    assert.deepEqual(
      declaredACsIn(tpl(AC_TRACE.declaredIn)),
      [],
      `${AC_TRACE.declaredIn} template declares no real AC`,
    );
  for (const { doc, fromStage, cell } of AC_REACHED) {
    assert.ok(cell === undefined || cell === "first", `acTrace.reachedIn "${doc}": cell must be "first" or absent, got ${JSON.stringify(cell)}`);
    assert.deepEqual(
      acsMissingIn(tpl(doc), ["AC-01"], cell),
      ["AC-01"],
      `${doc} template must not pre-cover a real AC`,
    );
    if (fromStage)
      assert.ok(
        STAGE_ORDER.includes(fromStage),
        `acTrace.reachedIn "${doc}": fromStage "${fromStage}" not in config.stages — the check would never fire`,
      );
  }

  // Config wiring: the pieces the kernel reads from harness.config.json must be
  // present and internally consistent, or every later check silently no-ops.
  assert.ok(STAGE_ORDER.length, "config.stages is empty");
  assert.ok(GATE4_DONE.size, "config.gate4Statuses is empty");
  assert.ok(GATE4_ARTIFACTS.evidence, "config.gate4Artifacts.evidence is required");
  if (STAGE_ORDER.includes("adversarial_review"))
    assert.ok(
      GATE4_ARTIFACTS.adversarial,
      'config.stages has "adversarial_review" but gate4Artifacts.adversarial is missing — Gate 5 would never be enforced',
    );
  for (const r of REQUIRED_AT_STAGE)
    assert.ok(STAGE_ORDER.includes(r.stage), `requiredAtStage stage "${r.stage}" not in config.stages`);
  assert.ok(STAGE_ORDER.includes("implementation"), 'config.stages must contain "implementation"');
  for (const role of Object.values(ROUTING.map ?? {}))
    assert.ok((CFG.roles ?? []).includes(role), `routing target "${role}" missing from config.roles`);
  assert.ok(
    EVIDENCE_RE.source !== "(?!)",
    "config.evidenceCommandPattern missing — no command would ever count as evidence",
  );
  assert.ok(CFG.tracker?.urlPattern, "config.tracker.urlPattern is required (task URL shape)");
  // roleStage powers the retry budget cross-check; a role missing here is a
  // role whose runaway loop nobody counts.
  for (const role of CFG.roles ?? [])
    assert.ok(
      ROLE_STAGE[role],
      `config.roleStage.${role} is missing — its retry budget would never be checked`,
    );
  for (const [role, st] of Object.entries(ROLE_STAGE))
    assert.ok(STAGE_ORDER.includes(st), `config.roleStage.${role}: stage "${st}" not in config.stages`);
  assert.ok((CFG.retryBudget ?? 4) >= 2, "config.retryBudget must be at least 2 (one retry)");
  {
    const md = modelsDefects();
    assert.ok(!md.errors.length, md.errors.join("\n"));
    for (const w of md.warnings) console.warn(`⚠ ${w}`);
  }

  assert.ok(CFG.repos?.length, 'config.repos is required (at least one { name, path, layer })');
  for (const r of CFG.repos) {
    assert.ok(r.name && r.path && r.layer, `config.repos entry needs name+path+layer: ${JSON.stringify(r)}`);
    assert.ok(CFG.layers.includes(r.layer), `config.repos "${r.name}": layer "${r.layer}" not in config.layers`);
  }
  assert.equal(
    new Set(CFG.repos.map((r) => r.name)).size,
    CFG.repos.length,
    "config.repos names must be unique (task.agent.json repoName points at one)",
  );
  // docsPath regex is built from tasksDir + groupPrefix: a mismatch here would
  // reject every correctly-placed task folder, so check it against a real path.
  const sampleDocsPath = `${CFG.tasksDir ?? "docs/tasks"}/${GROUP_PREFIX}3/ABC-1-slug`;
  const esc0 = (x) => x.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  assert.ok(
    new RegExp(`^${esc0(CFG.tasksDir ?? "docs/tasks")}/${esc0(GROUP_PREFIX)}.+/.+/?$`).test(sampleDocsPath),
    `docsPath pattern would reject a valid folder like "${sampleDocsPath}"`,
  );

  // lineWarn never blocks: 08/09 hold pasted output, and a cap there buys a
  // shorter file by making the agent paste less — the opposite of what Gate 4
  // and Gate 5 exist for.
  for (const f of Object.keys(LINE_WARN))
    assert.ok(
      !LINE_CAPS[f],
      `${f} is in both lineCaps and lineWarn — a hard cap on pasted output pressures the agent to trim evidence`,
    );

  // Line caps under append-only: the newest block is what the current role
  // controls. Capping the whole file traps a task the gate bounced twice —
  // over the cap, and §5 forbids trimming the history to get back under it.
  {
    const { mkdtempSync, writeFileSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const d = mkdtempSync(join(tmpdir(), "sh-tr-"));
    const log = join(d, "_triage.log");
    assert.equal(triageVectorFor(log, "A-1"), null, "no log file → nothing to compare");
    writeFileSync(
      log,
      `2026-01-01\tA-1\tquick-task\t-\t{"scope":0}\t\n` +
        `2026-01-01\tB-2\tharness\tforced\t{"scope":2}\twhy\n` +
        `rubbish line\n` +
        `2026-01-02\tA-1\tquick-task\t-\t{"scope":1}\t\n`,
    );
    // The LOWEST entry, not the last: "last wins" meant one re-run of --triage
    // with the honest vector erased the low score that bought the escape hatch.
    assert.deepEqual(triageVectorFor(log, "A-1"), { scope: 0 }, "lowest entry wins: re-triaging cannot erase the low score");
    assert.deepEqual(triageVectorFor(log, "B-2"), { scope: 2 }, "finds the right task");
    assert.equal(triageVectorFor(log, "C-3"), null, "task not in the log → no finding");
    // Per dimension, not per entry: raising one and lowering another in the same
    // re-triage must keep both floors.
    writeFileSync(
      join(d, "mix.log"),
      `2026-01-01\tM-1\tharness\t-\t{"scope":2,"testing":0}\t\n` +
        `2026-01-02\tM-1\tharness\t-\t{"scope":0,"testing":2}\t\n`,
    );
    assert.deepEqual(triageVectorFor(join(d, "mix.log"), "M-1"), { scope: 0, testing: 0 }, "floors are per dimension");
    writeFileSync(join(d, "junk.log"), `2026-01-01\tJ-1\tharness\t-\t"nope"\t\n`);
    assert.equal(triageVectorFor(join(d, "junk.log"), "J-1"), null, "a JSON string is not a vector");

    assert.deepEqual(vectorDriftSince({ scope: 0 }, { scope: 2, testing: 1 }).raised, ["scope 0→2", "testing 0→1"], "names each raised dimension");
    assert.deepEqual(vectorDriftSince({ scope: 2 }, { scope: 2 }), { raised: [], lowered: [] }, "unchanged → silent");
    // §5.1.3 is "only raise, never lower" -- the forbidden direction must be the one
    // that is actually reported, or the rule has no teeth anywhere.
    assert.deepEqual(vectorDriftSince({ scope: 2 }, { scope: 1 }).lowered, ["scope 2→1"], "lowered is the direction §5.1.3 forbids");
    assert.deepEqual(vectorDriftSince({ scope: 2 }, { scope: 1 }).raised, [], "a lowered dimension is not also 'raised'");
    assert.deepEqual(vectorDriftSince(null, { scope: 2 }), { raised: [], lowered: [] }, "never triaged → nothing to compare");
    rmSync(d, { recursive: true, force: true });
  }

  // --triage input: the one entry point the schema never sees, and the one that
  // decides whether the harness runs at all. Every case below used to produce a
  // confident verdict from rubbish.
  {
    const full = { scope: 0, uncertainty: 0, dependency: 0, dataImpact: 0, integration: 0, testing: 0, blastRadius: 0, reversibility: 0 };
    assert.deepEqual(vectorInputErrors(full), [], "a complete zero vector is valid input");
    assert.ok(vectorInputErrors(null)[0].includes("8 dimensions"), "null is not a vector");
    assert.ok(vectorInputErrors("junk")[0].includes("8 dimensions"), "a string is not a vector");
    assert.ok(vectorInputErrors([])[0].includes("8 dimensions"), "an array is not a vector");
    assert.equal(vectorInputErrors({}).length, 8, "an empty object is 8 missing dimensions, not a trivial task");
    assert.ok(vectorInputErrors({ ...full, scope: "2" })[0].includes("integer"), "a string digit concatenates instead of summing");
    assert.ok(vectorInputErrors({ ...full, blastRadius: -4 })[0].includes("integer"), "negative is rejected");
    assert.ok(vectorInputErrors({ ...full, scope: 3 })[0].includes("0–2"), "effort dimensions cap at 2");
    assert.ok(vectorInputErrors({ ...full, blastRadius: 4 }).length === 0, "risk dimensions go to 4");
    assert.ok(vectorInputErrors({ ...full, blastRadius: 5 })[0].includes("0–4"), "risk dimensions cap at 4");
    assert.ok(vectorInputErrors({ ...full, scop: 2 })[0].includes("unknown"), "a typo'd key would score 0 in silence");

    // Cross-dimension coherence: the two risk dimensions have no measurement,
    // but they cannot contradict the effort dimensions that do.
    assert.ok(
      vectorInputErrors({ ...full, dataImpact: 2, reversibility: 1 })[0].includes("reversibility"),
      "a migration is not undone by reverting a commit",
    );
    assert.deepEqual(vectorInputErrors({ ...full, dataImpact: 2, reversibility: 2 }), [], "dataImpact 2 with a real rollback cost is fine");
    assert.ok(
      vectorInputErrors({ ...full, integration: 2, blastRadius: 0 })[0].includes("blastRadius"),
      "a new external contract reaches past one spot",
    );
    assert.deepEqual(vectorInputErrors({ ...full, integration: 2, blastRadius: 1 }), [], "integration 2 with module-wide blast is fine");
    assert.deepEqual(vectorInputErrors({ ...full, dataImpact: 1, reversibility: 0 }), [], "dataImpact 1 carries no floor");
    // Range errors must not be buried under coherence noise computed from junk.
    assert.ok(
      vectorInputErrors({ ...full, dataImpact: 9 }).every((e) => e.includes("0–2")),
      "out-of-range reports the range, not a coherence guess",
    );
  }

  // createdAt: the master switch for every since-cutoff in this file. Unchecked,
  // one string turned §5.1 and §5.6 back into warnings -- and --no-warn eats those.
  {
    const why = "5 rounds: 3 real defects, then a spec question answered via FSD";
    const ok = { status: "done", outcome: { closedAt: "2026-09-22", overBudget: why } };
    assert.equal(overBudgetAccepted(ok), true, "shipped + closed + reason is accepted");
    assert.equal(overBudgetAccepted({ ...ok, status: "implementing" }), false, "not shipped -> split is the exit, not this");
    assert.equal(overBudgetAccepted({ ...ok, outcome: { overBudget: why } }), false, "no closedAt -> not closed");
    assert.equal(overBudgetAccepted({ ...ok, outcome: { closedAt: "2026-09-22" } }), false, "no reason -> still an error");
    for (const dodge of ["n/a", "TBD", "retried a lot"])
      assert.equal(overBudgetAccepted({ ...ok, outcome: { closedAt: "x", overBudget: dodge } }), false, `"${dodge}" is not a reason`);
  }

  // contextBleed: the /clear rule with a measurement behind it. False positives
  // are the real risk here -- it is a warning on self-reported data, so the
  // negative cases matter more than the positive one.
  {
    const M = (a, b, c) => ({ cheap: { model: a }, mid: { model: b }, strong: { model: c } });
    const cfg = { coordinatorTier: "mid", baseTier: { implementer: ["mid", "mid", "strong"], "fsd-writer": ["cheap", "mid", "mid"] }, models: { claude: M("h", "s", "o"), codex: M("x", "y", "z") } };
    const rt = (r, c, a) => resolveTier(r, c, a, cfg, "claude");
    assert.equal(rt("implementer", "normal", 1).tier, "mid", "attempt 1 is the base tier");
    assert.equal(rt("implementer", "normal", 2).tier, "strong", "attempt 2 lifts one notch");
    assert.equal(rt("implementer", "normal", 9).tier, "strong", "the cascade is capped at strong, it does not run off the end");
    assert.equal(rt("fsd-writer", "trivial", 2).tier, "mid", "cheap -> mid on retry");
    assert.equal(rt("fsd-writer", "trivial", 3).tier, "strong", "two bounces reach the ceiling");
    assert.equal(rt("implementer", "high", 1).model, "o", "the tier is mapped through config.models.<cli>");
    assert.equal(resolveTier("implementer", "high", 1, cfg, "codex").model, "z", "another CLI resolves through its own key");
    assert.equal(resolveTier("implementer", "high", 1, cfg, "gemini").model, null, "a CLI with no models key routes nothing");
    // #81 R1: that silence is named. claude is exempt: it has .claude/ always, and its key is the example's.
    assert.deepEqual(unroutedClis(["codex", "gemini", "gemini", "claude"], cfg), ["gemini"], "R1: installed CLI with no models key is reported once; a routed one is not");
    assert.equal(resolveTier("implementer", "high", 1, { ...cfg, models: { cheap: "h", mid: "s", strong: "o" } }, "claude").model, null, "the flat legacy map is never mapped to a vendor");
    // modelsDefects: R1a/R1a'/R1c are errors, R1d a warning.
    const md = (c) => modelsDefects({ ...cfg, ...c });
    assert.deepEqual(md({}), { errors: [], warnings: [] }, "a well-formed per-CLI config is clean");
    assert.ok(md({ coordinatorTier: undefined }).errors.length, "R1a: missing coordinatorTier is an error");
    assert.ok(md({ coordinatorTier: "huge" }).errors.length, "R1a: a coordinatorTier outside the tiers is an error");
    assert.ok(md({ baseTier: { ...cfg.baseTier, coordinator: ["mid", "mid", "mid"] } }).errors.length, "R1a': baseTier.coordinator is an error");
    assert.ok(md({ models: { vscode: M("a", "b", "c") } }).errors.length, "R1c: an unknown CLI key is an error");
    assert.ok(md({ models: { claude: { cheap: { model: "a" }, mid: { model: "b" } } } }).errors.length, "R1c: a missing tier is an error");
    assert.ok(md({ models: { claude: { ...M("a", "b", "c"), huge: { model: "d" } } } }).errors.length, "R1c: an unknown tier key is an error");
    assert.ok(md({ models: { claude: { ...M("a", "b", "c"), mid: { model: "b", temp: 1 } } } }).errors.length, "R1c: an unknown entry key is an error");
    assert.deepEqual(md({ models: { claude: { ...M("a", "b", "c"), mid: { model: "b", effort: "low" } } } }).errors, [], "#63: effort low/medium/high is accepted");
    assert.ok(md({ models: { claude: { ...M("a", "b", "c"), mid: { model: "b", effort: "max" } } } }).errors.length, "#63: an effort outside low/medium/high is an error");
    const flat = md({ models: { cheap: "h", mid: "s", strong: "o" } });
    assert.ok(!flat.errors.length && flat.warnings.length, "R1d: the flat legacy map is a warning, not an error");
    assert.equal(rt("implementer", "normal", 1).base, "mid", "base is reported separately from the escalated tier");
    // A CLI that routes nothing must not be handed an invented model name.
    assert.equal(resolveTier("implementer", "normal", 1, { ...cfg, models: {} }, "claude").model, null, "empty config.models resolves to no model");
    // Refusals: every one of these used to be a silent wrong dispatch.
    assert.ok(rt("nobody", "normal", 1).error, "an unknown role is an error, not a default tier");
    assert.ok(rt("implementer", "medium", 1).error, "a taskComplexity outside the three ranks is rejected");
    assert.ok(rt("implementer", "normal", 0).error, "attempt 0 is rejected");
    assert.ok(rt("implementer", "normal", 1.5).error, "a non-integer attempt is rejected");
    // This repo's own config must actually resolve, or --tier is broken on ship.
    for (const role of CFG.roles ?? [])
      for (const c of ["trivial", "normal", "high"])
        assert.ok(!resolveTier(role, c, 1).error, `config.baseTier cannot resolve ${role}/${c}: ${resolveTier(role, c, 1).error}`);
  }

  // stageContract (#62): every constant a check reads must reach the contract of
  // the stage that produces it — otherwise the role learns it by grepping this file.
  {
    const v = { scope: 0, uncertainty: 0, dependency: 0, dataImpact: 0, integration: 0, testing: 0, blastRadius: 0, reversibility: 0 };
    const ok = { taskId: "A-1", taskName: "x", slug: "a-b", trackerUrl: "https://t/1", branchType: "feature", branch: "feature/A-1-a-b", sprintNumber: 1, complexity: { vector: v } };
    const be = (o, x = {}) => bootstrapInputErrors(o, { repos: [{ name: "r" }], branchTypes: ["feature", "bugfix"], urlPattern: "^https://t/", ...x });
    assert.deepEqual(be(ok), [], "a complete input is accepted");
    for (const k of ["taskId", "taskName", "slug", "trackerUrl", "branchType", "branch", "sprintNumber", "complexity"]) {
      const o = { ...ok }; delete o[k];
      assert.ok(be(o).length, `R2: missing ${k} is refused`);
    }
    assert.ok(be({ ...ok, slug: "Giảm-giá" }).length, "a slug with diacritics is refused");
    assert.ok(be({ ...ok, branchType: "chore" }).length, "a branchType outside routing is refused");
    assert.ok(be({ ...ok, trackerUrl: "https://evil/1" }).length, "a trackerUrl outside tracker.urlPattern is refused");
    assert.ok(be({ ...ok, sprintNumber: 0 }).length, "sprintNumber 0 is refused");
    assert.ok(be({ ...ok, complexity: { vector: { ...v, scope: 3 } } }).length, "an out-of-range vector is refused");
    assert.ok(be(ok, { repos: [{ name: "r" }, { name: "s" }] }).length, "two repos and no repoName: ask, do not guess");
    assert.deepEqual(be({ ...ok, repoName: "s" }, { repos: [{ name: "r" }, { name: "s" }] }), [], "a named repo from config.repos is accepted");
    assert.ok(be({ ...ok, repoName: "zz" }).length, "a repoName outside config.repos is refused");
    assert.ok(be(null).length && be([]).length, "a non-object is refused");
  }

  // advanceDecision (#61): every exit of --advance, without a filesystem.
  {
    const ok = {
      vector: { scope: 1, uncertainty: 0, dependency: 0, dataImpact: 0, integration: 0, testing: 1, blastRadius: 0, reversibility: 0 },
      counts: { symbol: "useRoster", filesTouched: 3, existingTests: 0 },
      questions: [],
    };
    const d = (o) => vectorEvidenceDefects(o);
    // Which symbol was grepped picks the scope, so it has to be on the record.
    assert.ok(
      d({ ...ok, counts: { filesTouched: 3, existingTests: 0 } })[0].includes("symbol"),
      "an unnamed grep symbol lets the scorer choose the answer",
    );
    // 0 matches falls through every count rule; new file vs missed grep score
    // differently and only a human can say which.
    assert.ok(
      d({ ...ok, counts: { ...ok.counts, filesTouched: 0 } }).some((x) => x.includes("matched nothing")),
      "filesTouched=0 must be explained, not silently accepted",
    );
    assert.deepEqual(
      d({ ...ok, counts: { ...ok.counts, filesTouched: 0 }, note: "new file: src/x.tsx" }),
      [],
      "a note explaining the zero clears it",
    );
    assert.deepEqual(d(ok), [], "a fully evidenced vector is silent");
    assert.deepEqual(d(undefined), [], "no complexity block at all is handled elsewhere (§5.1 warning)");
    assert.deepEqual(d({ counts: ok.counts, questions: [] }), [], "counts without a vector: nothing to cross-check");

    assert.ok(d({ ...ok, counts: { symbol: "useRoster", existingTests: 0 } }).some((x) => x.includes("filesTouched")), "missing filesTouched is named");
    assert.ok(d({ ...ok, counts: { symbol: "useRoster", filesTouched: 3 } }).some((x) => x.includes("existingTests")), "missing existingTests is named");
    assert.ok(d({ vector: ok.vector, counts: ok.counts }).some((x) => x.includes("questions")), "missing questions is named");

    // counts must actually constrain the score, or they are decoration.
    assert.ok(
      d({ ...ok, counts: { symbol: "useRoster", filesTouched: 1, existingTests: 0 } }).some((x) => x.includes("one file is scope 0")),
      "1 file cannot be scope 1",
    );
    assert.ok(
      d({ ...ok, counts: { symbol: "useRoster", filesTouched: 9, existingTests: 0 } }).some((x) => x.includes("more than 5 files")),
      "9 files cannot be scope 1",
    );
    // 2..5 used to be unconstrained in both directions: the count sat in the
    // file contradicting `scope: 0` and nothing said a word.
    assert.ok(
      d({ vector: { ...ok.vector, scope: 0 }, counts: { symbol: "useRoster", filesTouched: 4, existingTests: 0 }, questions: [] })
        .some((x) => x.includes("scope 0 is one file")),
      "4 files cannot be scope 0",
    );
    assert.ok(
      d({ vector: { ...ok.vector, scope: 0 }, counts: { symbol: "useRoster", filesTouched: 2, existingTests: 0 }, questions: [] })
        .some((x) => x.includes("scope 0 is one file")),
      "the floor starts at 2, not at 3",
    );
    assert.deepEqual(
      d({ vector: { ...ok.vector, scope: 2 }, counts: { symbol: "useRoster", filesTouched: 4, existingTests: 0 }, questions: [] }),
      [],
      "4 files at scope 2 is a judgement call, not a contradiction",
    );
    // The symbol has to be something a reviewer can paste back into rg.
    assert.ok(d({ ...ok, counts: { ...ok.counts, symbol: "s" } })[0].includes("greppable"), "one letter is not a symbol");
    assert.ok(d({ ...ok, counts: { ...ok.counts, symbol: "the roster hook" } })[0].includes("greppable"), "a phrase is not a symbol");
    assert.deepEqual(
      d({ vector: { ...ok.vector, scope: 2 }, counts: { symbol: "useRoster", filesTouched: 9, existingTests: 0 }, questions: [] }),
      [],
      "9 files with scope 2 is consistent",
    );
    assert.ok(
      d({ vector: { ...ok.vector, testing: 0 }, counts: { symbol: "useRoster", filesTouched: 3, existingTests: 0 }, questions: [] })
        .some((x) => x.includes("existingTests=0")),
      "no test covers it ⇒ testing cannot be 0",
    );
    assert.deepEqual(
      d({ vector: { ...ok.vector, testing: 0 }, counts: { symbol: "useRoster", filesTouched: 3, existingTests: 4 }, questions: [] }),
      [],
      "existing tests cover it ⇒ testing 0 is fine",
    );

    // uncertainty is the expensive one, so it is checked in both directions.
    assert.ok(
      d({ vector: { ...ok.vector, uncertainty: 2 }, counts: ok.counts, questions: [] }).some((x) => x.includes("empty")),
      "uncertainty>0 with no listed question",
    );
    assert.ok(
      d({ ...ok, questions: ["which role sees the button?"] }).some((x) => x.includes("uncertainty=0")),
      "a listed blocker contradicts uncertainty 0",
    );
    // [""] satisfied "non-empty" and said nothing -- the cheapest way to score
    // uncertainty 2 without having looked, or to dodge the empty-list error.
    assert.ok(
      d({ vector: { ...ok.vector, uncertainty: 2 }, counts: ok.counts, questions: [""] }).some((x) => x.includes("blank/stub")),
      "an empty string is not an open question",
    );
    assert.ok(
      d({ vector: { ...ok.vector, uncertainty: 2 }, counts: ok.counts, questions: [""] }).some((x) => x.includes("empty")),
      "and with nothing real left, uncertainty 2 is still unbacked",
    );
    assert.ok(
      d({ vector: { ...ok.vector, uncertainty: 2 }, counts: ok.counts, questions: ["who?"] }).some((x) => x.includes("blank/stub")),
      "a 4-char stub is the same dodge",
    );
    assert.deepEqual(
      d({ vector: { ...ok.vector, uncertainty: 1 }, counts: ok.counts, questions: ["which roles keep access after the move?"] }),
      [],
      "a real question backs a real score",
    );

    // split-before-spend: the point is to fire at bootstrap, not after retries.
    const big = { scope: 2, uncertainty: 2, dependency: 2, dataImpact: 2, integration: 1, testing: 1, blastRadius: 1, reversibility: 2 };
    const bigOk = { vector: big, counts: { symbol: "useRoster", filesTouched: 9, existingTests: 0 }, questions: ["which roles keep access after the move?"] };
    assert.ok(d(bigOk).some((x) => x.includes("splitEvaluated")), "effort 10 must record a split decision");
    assert.deepEqual(
      d({ ...bigOk, splitEvaluated: "cannot split: one migration, one deploy" }),
      [],
      "an answered split decision clears it",
    );
    assert.ok(d({ ...bigOk, splitEvaluated: "   " }).some((x) => x.includes("splitEvaluated")), "blank is not an answer");
    // Blank was already an error, so the escape became a two-letter dismissal:
    // same information, green gate. §5.1.4 wants the question ANSWERED.
    for (const dodge of ["n/a", "N/A", "no", "none", "-", "TBD", "?", "cannot"])
      assert.ok(
        d({ ...bigOk, splitEvaluated: dodge }).some((x) => x.includes("dismissal")),
        `"${dodge}" closes the split question instead of answering it`,
      );
    assert.ok(
      d({
        vector: { scope: 2, uncertainty: 2, dependency: 0, dataImpact: 0, integration: 0, testing: 0, blastRadius: 0, reversibility: 0 },
        counts: { symbol: "useRoster", filesTouched: 9, existingTests: 0 },
        questions: ["which roles keep access after the move?"],
      }).some((x) => x.includes("splitEvaluated")),
      "wide AND unclear at effort 4 still asks the question",
    );
    assert.deepEqual(d(ok), [], "a small task is never asked to split");
  }

  // triage: which road a task takes. The failure this guards is symmetric --
  // overusing the escape hatch makes the harness scenery, underusing it charges
  // 7 stages for a copy change -- so both directions get a case.
  {
    const z = { scope: 0, uncertainty: 0, dependency: 0, dataImpact: 0, integration: 0, testing: 0, blastRadius: 0, reversibility: 0 };
    assert.equal(triage({ ...z }, "feature").verdict, "quick-task", "all zero → escape hatch");
    assert.equal(triage({ ...z }, "bugfix").verdict, "fix-bug", "same size, bug branch → fix-bug");
    assert.equal(triage({ ...z, scope: 2, testing: 1 }, "feature").verdict, "harness", "effort 3 is no longer trivial");
    // The whole point of riskFloor: size and risk are different questions.
    assert.equal(triage({ ...z, scope: 1, blastRadius: 3 }, "bugfix").verdict, "harness", "one-file fix, service-wide blast → harness");
    assert.equal(triage({ ...z, reversibility: 2 }, "feature").verdict, "harness", "needs a redeploy to undo → harness");
    assert.equal(triage({ ...z, blastRadius: 1, reversibility: 1 }, "feature").verdict, "quick-task", "low risk stays on the hatch");
  }

  // preflight: the CLI walks UP from cwd for .claude/, never down. Layout B puts
  // settings.json in harness/ and invites you to open the parent -- below cwd,
  // invisible, deny-list silently gone. A "found it" that actually matched
  // ~/.claude/settings.json is the same failure wearing a green tick.
}

