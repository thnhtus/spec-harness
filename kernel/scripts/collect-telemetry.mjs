#!/usr/bin/env node
// Fill telemetry[].inputTokens from the CLI's own session log.
//
//   node scripts/collect-telemetry.mjs <task-folder>        # show what it would write
//   node scripts/collect-telemetry.mjs <task-folder> --write
//   node scripts/collect-telemetry.mjs --self-check
//
// The split of work is deliberate. The coordinator records what it KNOWS —
// stage, tier, startedAt, endedAt — none of which it can get wrong. Token counts
// are what it does not know: it either omits them or invents them, and an
// invented cost number is worse than none, because `--cost` then reports it with
// a straight face.
//
// The numbers already exist. Claude Code writes every API response, usage block
// included, to ~/.claude/projects/<slug>/<session>.jsonl. Nobody was joining the
// two files. That is all this does.
//
// LIMITS, so nobody mistakes the output for a bill:
//   * Claude Code only. Other CLIs write no such log; this exits 0 and writes
//     nothing rather than failing a workflow that was never broken.
//   * The .jsonl shape is Claude Code's private format and can change without
//     notice. Every parse failure is LOUD — a silent 0 would look like a cheap
//     task, which is the one wrong answer that gets believed.
//   * Attribution is (cwd + branch + time window). Two sessions on the same
//     branch and repo at the same time cannot be told apart; the lease stops
//     that for one task, not across tasks.

import { readFileSync, writeFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const LOG_ROOT = join(homedir(), ".claude", "projects");

// input_tokens and cache_read_input_tokens are NOT the same cost — cache reads
// bill at roughly a tenth, and in a real session they outnumber fresh input by
// ~80:1 (measured: 409,295 vs 2 on a single dispatch). Summing them into one
// "inputTokens" produces a number 80x too large that still looks plausible.
// Keep them apart and let whoever reads it apply their own price.
export function tokensOf(usage = {}) {
  return {
    inputTokens: (usage.input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0),
    cacheReadTokens: usage.cache_read_input_tokens ?? 0,
    outputTokens: usage.output_tokens ?? 0,
  };
}

// Entries that belong to this task: same repo, same branch, inside the window a
// dispatch actually ran. Branch matters — cwd alone merges every task in the
// repo into one bill.
export function entriesInWindow(entries, { cwd, branch, startedAt, endedAt }) {
  const from = Date.parse(startedAt), to = Date.parse(endedAt);
  if (!Number.isFinite(from) || !Number.isFinite(to)) return [];
  return entries.filter((e) => {
    const t = Date.parse(e.timestamp);
    if (!Number.isFinite(t) || t < from || t > to) return false;
    if (cwd && e.cwd && e.cwd !== cwd) return false;
    // A missing branch in the log is not a mismatch — older entries lack it.
    if (branch && e.gitBranch && e.gitBranch !== branch) return false;
    return true;
  });
}

export function sumTokens(entries) {
  return entries.reduce(
    (a, e) => {
      const t = tokensOf(e.message?.usage);
      return {
        inputTokens: a.inputTokens + t.inputTokens,
        cacheReadTokens: a.cacheReadTokens + t.cacheReadTokens,
        outputTokens: a.outputTokens + t.outputTokens,
        dispatches: a.dispatches + 1,
      };
    },
    { inputTokens: 0, cacheReadTokens: 0, outputTokens: 0, dispatches: 0 },
  );
}

// Every usage-bearing entry from every session log, flattened. Reading all of
// them is cheap next to guessing which slug matches a cwd: the slug is derived
// from the path by rules that are not ours and have changed before, while `cwd`
// inside the entry is the CLI's own answer to the same question.
function loadEntries(root = LOG_ROOT) {
  if (!existsSync(root)) return null; // not Claude Code — caller decides
  const out = [];
  for (const dir of readdirSync(root)) {
    const dp = join(root, dir);
    let st;
    try { st = statSync(dp); } catch { continue; }
    if (!st.isDirectory()) continue;
    for (const f of readdirSync(dp).filter((x) => x.endsWith(".jsonl"))) {
      let text;
      try { text = readFileSync(join(dp, f), "utf8"); } catch { continue; }
      for (const line of text.split("\n")) {
        if (!line.includes('"usage"')) continue;
        let e;
        // A malformed line is a truncated write, not a format change — skip it.
        // A format change shows up as zero matches overall, which is reported.
        try { e = JSON.parse(line); } catch { continue; }
        if (e?.message?.usage) out.push(e);
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// self-check
// ---------------------------------------------------------------------------
if (process.argv.includes("--self-check")) {
  const assert = await import("node:assert/strict").then((m) => m.default);

  // The whole reason this file exists: one number, not two added together.
  {
    const t = tokensOf({ input_tokens: 2, cache_creation_input_tokens: 5005, cache_read_input_tokens: 409295, output_tokens: 575 });
    assert.equal(t.inputTokens, 5007, "fresh input = input + cache creation; both are billed at full rate");
    assert.equal(t.cacheReadTokens, 409295, "cache reads stay separate — they bill at roughly a tenth");
    assert.notEqual(t.inputTokens, 414302, "summing cache reads into inputTokens inflates the number ~80x and it still looks plausible");
    assert.deepEqual(tokensOf(), { inputTokens: 0, cacheReadTokens: 0, outputTokens: 0 }, "no usage block = zero, not a crash");
  }

  // Window matching. The boundaries are inclusive: a dispatch that starts at
  // exactly startedAt is part of that dispatch.
  {
    const mk = (ts, extra = {}) => ({ timestamp: ts, cwd: "/r", gitBranch: "b", message: { usage: { input_tokens: 1 } }, ...extra });
    const all = [mk("2026-01-01T00:00:00Z"), mk("2026-01-01T00:05:00Z"), mk("2026-01-01T00:20:00Z")];
    const w = { cwd: "/r", branch: "b", startedAt: "2026-01-01T00:00:00Z", endedAt: "2026-01-01T00:10:00Z" };
    assert.equal(entriesInWindow(all, w).length, 2, "inclusive window, and nothing outside it");
    // Branch is what keeps two tasks in one repo from being billed as one.
    assert.equal(entriesInWindow([mk("2026-01-01T00:05:00Z", { gitBranch: "other" })], w).length, 0,
      "a different branch is a different task — cwd alone merges every task in the repo into one bill");
    assert.equal(entriesInWindow([mk("2026-01-01T00:05:00Z", { cwd: "/elsewhere" })], w).length, 0, "a different repo is not this task");
    // Older entries have no gitBranch. Treating absent as mismatch would drop
    // every one of them and silently report a cheaper task.
    assert.equal(entriesInWindow([mk("2026-01-01T00:05:00Z", { gitBranch: undefined })], w).length, 1,
      "a log entry with no branch recorded must not be dropped — absent is unknown, not different");
    // A telemetry entry with no timestamps cannot be attributed to anything.
    // Returning everything here would bill the whole session to one stage.
    assert.equal(entriesInWindow(all, { cwd: "/r", branch: "b" }).length, 0, "no window = no attribution, not all of it");
    assert.equal(entriesInWindow(all, { ...w, endedAt: "nonsense" }).length, 0, "an unparseable timestamp attributes nothing");
  }

  {
    const s = sumTokens([
      { message: { usage: { input_tokens: 10, cache_read_input_tokens: 100, output_tokens: 5 } } },
      { message: { usage: { input_tokens: 20, cache_read_input_tokens: 200, output_tokens: 7 } } },
    ]);
    assert.deepEqual(s, { inputTokens: 30, cacheReadTokens: 300, outputTokens: 12, dispatches: 2 });
    assert.equal(sumTokens([]).dispatches, 0, "no entries = no dispatches");
  }

  console.log("✅ collect-telemetry self-check passed");
  process.exit(0);
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------
const argv = process.argv.slice(2);
const WRITE = argv.includes("--write");
const folder = argv.find((a) => !a.startsWith("--"));
if (!folder) {
  console.error("usage: collect-telemetry.mjs <task-folder> [--write]");
  process.exit(2);
}

const jsonPath = join(folder, "task.agent.json");
if (!existsSync(jsonPath)) {
  console.error(`✖ ${jsonPath} not found`);
  process.exit(2);
}
const task = JSON.parse(readFileSync(jsonPath, "utf8"));
const tel = task.telemetry ?? [];
if (!tel.length) {
  console.error(
    `✖ telemetry is empty — this script fills in token counts, it cannot invent the dispatches.\n` +
      `  The coordinator appends one entry per stage with startedAt/endedAt (/start-task step 6).`,
  );
  process.exit(1);
}

const entries = loadEntries();
if (entries === null) {
  // Not Claude Code. Exiting 0: a workflow that never had this data is not
  // broken, and failing here would block every non-Claude CLI from committing.
  console.log(`ℹ no ${LOG_ROOT} — token counts come from Claude Code's session log; nothing to collect`);
  process.exit(0);
}
if (!entries.length) {
  // The directory exists but nothing parsed. That is a format change or an empty
  // history, and both need a human — not a silent zero that reads as "cheap".
  console.error(
    `✖ ${LOG_ROOT} exists but no usage entries parsed out of it.\n` +
      `  Either there is no session history yet, or the CLI's log format changed.\n` +
      `  Not writing zeros: a zero here looks like a cheap task and gets believed.`,
  );
  process.exit(1);
}

const cwd = process.cwd();
const branch = task.branchActual || task.branch;
let filled = 0, skipped = 0;
for (const e of tel) {
  if (typeof e.inputTokens === "number") { skipped++; continue; } // already recorded, never overwrite
  const hit = entriesInWindow(entries, { cwd, branch, startedAt: e.startedAt, endedAt: e.endedAt });
  if (!hit.length) continue;
  const s = sumTokens(hit);
  Object.assign(e, { inputTokens: s.inputTokens, cacheReadTokens: s.cacheReadTokens, outputTokens: s.outputTokens });
  filled++;
}

const total = tel.reduce((n, e) => n + (e.inputTokens ?? 0), 0);
const cache = tel.reduce((n, e) => n + (e.cacheReadTokens ?? 0), 0);
console.log(`${filled} of ${tel.length} dispatch(es) filled${skipped ? `, ${skipped} already had counts` : ""}`);
for (const e of tel)
  console.log(
    `  ${String(e.stage).padEnd(20)} ${e.inputTokens === undefined ? "—".padStart(10) : e.inputTokens.toLocaleString().padStart(10)}` +
      ` input${e.cacheReadTokens !== undefined ? ` · ${e.cacheReadTokens.toLocaleString()} cache-read` : ""}`,
  );
console.log(`  ${"= task".padEnd(20)} ${total.toLocaleString().padStart(10)} input · ${cache.toLocaleString()} cache-read`);
console.log(`  Cache reads are listed apart because they bill at roughly a tenth; adding them in`);
console.log(`  makes the number ~80x larger and no less plausible-looking.`);

if (!filled) {
  console.log(`\nNothing matched (cwd=${cwd}, branch=${branch}). Attribution is cwd + branch + the`);
  console.log(`startedAt/endedAt window — check the coordinator recorded those.`);
  process.exit(0);
}
if (WRITE) {
  writeFileSync(jsonPath, JSON.stringify(task, null, 2) + "\n");
  console.log(`\n✅ wrote ${jsonPath}`);
} else {
  console.log(`\n(dry run — re-run with --write to save)`);
}
