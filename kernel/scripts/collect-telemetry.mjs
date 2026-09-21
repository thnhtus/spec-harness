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

// Overridable because the default is a guess about someone else's tool: a path
// baked into this file cannot be right for every install, and being wrong about
// it is indistinguishable from "this is not Claude Code".
//
// The distinction matters in exactly one direction. No env var and no directory
// = probably another CLI, stay quiet. Env var set and the directory missing =
// someone told us where it is and it is not there, which is a broken setup and
// must be loud.
const LOG_ENV = "SPEC_HARNESS_SESSION_LOG";
const LOG_ROOT = process.env[LOG_ENV] || join(homedir(), ".claude", "projects");

// input_tokens and cache_read_input_tokens are NOT the same cost — cache reads
// bill at roughly a tenth, and in a real session they outnumber fresh input by
// ~80:1 (measured: 409,295 vs 2 on a single dispatch). Summing them into one
// "inputTokens" produces a number 80x too large that still looks plausible.
// Keep them apart and let whoever reads it apply their own price.
export const USAGE_KEYS = ["input_tokens", "cache_creation_input_tokens", "cache_read_input_tokens", "output_tokens"];

export function tokensOf(usage = {}) {
  return {
    inputTokens: (usage.input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0),
    cacheReadTokens: usage.cache_read_input_tokens ?? 0,
    outputTokens: usage.output_tokens ?? 0,
  };
}

// The `usage` block is there and parses, but not one of the names we read is in
// it. That is a renamed field, and it is the failure this file is least able to
// notice on its own: every lookup quietly yields 0, the sums are 0, the window
// matched, and 0 gets written down as the cost of the task.
//
// "No usage entries at all" was already loud. This is the same event wearing a
// disguise -- entries present, shape intact, names moved -- so it needs its own
// check rather than trusting the count.
export function unknownUsageShape(entries) {
  const seen = new Set();
  for (const e of entries) for (const k of Object.keys(e?.message?.usage ?? {})) seen.add(k);
  if (!seen.size) return null;
  if (USAGE_KEYS.some((k) => seen.has(k))) return null; // at least one name we know
  return [...seen].sort();
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

// Which half of the match failed. "0 matched" alone leaves the reader to guess
// between a wrong branch, a wrong repo and a wrong clock, and the fix differs
// for each.
export function missReasons(entries, { cwd, branch, startedAt, endedAt }) {
  const from = Date.parse(startedAt), to = Date.parse(endedAt);
  const r = { window: 0, cwd: 0, branch: 0, branchesSeen: new Set(), total: entries.length };
  for (const e of entries) {
    const t = Date.parse(e.timestamp);
    if (!Number.isFinite(t) || !Number.isFinite(from) || !Number.isFinite(to) || t < from || t > to) { r.window++; continue; }
    if (cwd && e.cwd && e.cwd !== cwd) { r.cwd++; continue; }
    if (branch && e.gitBranch && e.gitBranch !== branch) { r.branch++; r.branchesSeen.add(e.gitBranch); }
  }
  return r;
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
// A session log is append-only, so its mtime is the last time anything was
// written to it: a file untouched since before the earliest dispatch cannot hold
// an entry inside any window. Measured on this machine: 641 MB across 538 files
// to recover one window a few minutes wide -- 2.5s, growing with history. With
// this, 533 files are never opened and the same answer arrives in 0.08s.
//
// `since = 0` means "read everything", which is what the caller passes when no
// dispatch has a usable startedAt: no lower bound is knowable, so skipping on
// one would drop files that might well match. No guard needed for it -- an mtime
// is never below zero, and a NaN bound compares false too, so both degrade to
// "read it" on their own.
export function skipByMtime(mtimeMs, since) {
  return mtimeMs < since;
}

function loadEntries(root = LOG_ROOT, since = 0) {
  if (!existsSync(root)) return null; // not Claude Code — caller decides
  const out = [];
  let read = 0, skipped = 0, bytes = 0;
  for (const dir of readdirSync(root)) {
    const dp = join(root, dir);
    let st;
    try { st = statSync(dp); } catch { continue; }
    if (!st.isDirectory()) continue;
    for (const f of readdirSync(dp).filter((x) => x.endsWith(".jsonl"))) {
      const fp = join(dp, f);
      // A session log is append-only: its mtime is when it was last written, so
      // a file untouched since before the earliest dispatch cannot contain an
      // entry inside any window. Measured here: 641 MB / 538 files of history to
      // recover one window a few minutes wide. Skipping on mtime reads ~1% of it
      // for the same answer, and the history only grows.
      try {
        const fst = statSync(fp);
        if (skipByMtime(fst.mtimeMs, since)) { skipped++; continue; }
        bytes += fst.size;
      } catch { continue; }
      read++;
      let text;
      try { text = readFileSync(fp, "utf8"); } catch { continue; }
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
  out.stats = { read, skipped, bytes };
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

  // A renamed field is the one failure this script cannot feel: the usage block
  // is there, it parses, the window matches, every lookup returns 0, and 0 is
  // written down as the cost of the task.
  {
    const real = [{ message: { usage: { input_tokens: 2, cache_read_input_tokens: 9, output_tokens: 1 } } }];
    assert.equal(unknownUsageShape(real), null, "the format we ship against must not be flagged");
    assert.equal(unknownUsageShape([]), null, "no entries is a different failure, reported elsewhere");
    assert.equal(unknownUsageShape([{ message: { usage: {} } }]), null, "an empty usage block is a quiet turn, not a rename");
    // One known name surviving is enough: a partial rename still sums something
    // real, and refusing to write would lose data we can actually account for.
    assert.equal(unknownUsageShape([{ message: { usage: { input_tokens: 1, cacheReadTokens: 9 } } }]), null,
      "a partial rename still has a name we read — sum what is there rather than refusing everything");
    assert.deepEqual(unknownUsageShape([{ message: { usage: { inputTokens: 5, cacheReadTokens: 9 } } }]),
      ["cacheReadTokens", "inputTokens"],
      "a full rename must be caught and the names it moved to reported, or we silently write 0");
  }

  // Why a match failed. The fix for a wrong branch and a wrong clock are not
  // the same, so "0 matched" alone costs the reader a guess.
  {
    const mk = (ts, cwd, br) => ({ timestamp: ts, cwd, gitBranch: br, message: { usage: {} } });
    const w = { cwd: "/r", branch: "b", startedAt: "2026-01-01T00:00:00Z", endedAt: "2026-01-01T00:10:00Z" };
    const r = missReasons([
      // Wrong on all three counts at once. An entry that only fails the window
      // while matching cwd and branch cannot detect double counting -- the later
      // branches never fire on it -- so the fixture has to be wrong everywhere
      // for the "one reason each" assert below to mean anything.
      mk("2025-01-01T00:00:00Z", "/other", "feat/x"),
      mk("2026-01-01T00:05:00Z", "/other", "feat/z"),  // wrong cwd AND branch
      mk("2026-01-01T00:05:00Z", "/r", "feat/y"),
    ], w);
    assert.equal(r.window, 1); assert.equal(r.cwd, 1); assert.equal(r.branch, 1);
    // feat/x is out of the window, so it never reaches the branch check: only
    // branches that genuinely lost on branch are worth naming.
    assert.deepEqual([...r.branchesSeen].sort(), ["feat/y"], "name the branches actually in the log — that is the fix");
    // Each entry counted once, against the first thing that ruled it out;
    // double-counting would make the totals argue with the entry count.
    assert.equal(r.window + r.cwd + r.branch, r.total, "an entry is ruled out by one reason, not several");
  }

  // Skipping files by mtime is what keeps this from reading the whole history
  // every run. It must never skip something that could match.
  {
    const t = Date.parse("2026-01-01T00:00:00Z");
    assert.equal(skipByMtime(t - 1, t), true, "written before the earliest dispatch — cannot contain it");
    assert.equal(skipByMtime(t, t), false, "written exactly at the boundary is still in play");
    assert.equal(skipByMtime(t + 1, t), false, "written after — must be read");
    // No lower bound knowable = read everything. Treating 0 as a real bound
    // would skip every file whose mtime is positive, i.e. all of them.
    assert.equal(skipByMtime(1, 0), false, "since=0 means no bound is known, so nothing may be skipped");
    assert.equal(skipByMtime(0, 0), false, "since=0 never skips, whatever the mtime");
    // A bound we could not parse must degrade to reading, not to skipping.
    assert.equal(skipByMtime(t, NaN), false, "an unparseable bound reads everything rather than silently skipping everything");
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

// Earliest dispatch we still need a count for: nothing written before it can
// matter, so nothing before it gets read.
const since = Math.min(
  ...tel.filter((e) => typeof e.inputTokens !== "number" && e.startedAt)
    .map((e) => Date.parse(e.startedAt)).filter(Number.isFinite),
);
const entries = loadEntries(LOG_ROOT, Number.isFinite(since) ? since : 0);
if (entries === null) {
  if (process.env[LOG_ENV]) {
    console.error(`✖ ${LOG_ENV}=${LOG_ROOT} does not exist — you said where the log is and it is not there`);
    process.exit(1);
  }
  // Not Claude Code. Exiting 0: a workflow that never had this data is not
  // broken, and failing here would block every non-Claude CLI from committing.
  console.log(`ℹ no ${LOG_ROOT} — token counts come from Claude Code's session log; nothing to collect`);
  console.log(`  (set ${LOG_ENV} if your CLI writes the same JSONL somewhere else)`);
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

// Entries exist and parse, but none of the names we sum are in them. Checked
// BEFORE writing anything: every lookup would return 0, and 0 is the one wrong
// answer nobody questions.
{
  const moved = unknownUsageShape(entries);
  if (moved) {
    console.error(
      `✖ ${entries.length} usage block(s) found, but none carry a field this script reads.\n` +
        `  expected one of: ${USAGE_KEYS.join(", ")}\n` +
        `  actually present: ${moved.slice(0, 8).join(", ")}${moved.length > 8 ? ", …" : ""}\n` +
        `  The CLI log format changed. Not writing zeros — a zero here reads as a cheap task.`,
    );
    process.exit(1);
  }
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
  // Which half failed. Guessing between a wrong branch, a wrong repo and a wrong
  // clock costs more than counting them.
  const pending = tel.filter((e) => typeof e.inputTokens !== "number" && e.startedAt && e.endedAt)[0];
  console.log(`\nNothing matched (cwd=${cwd}, branch=${branch}).`);
  if (pending) {
    const r = missReasons(entries, { cwd, branch, startedAt: pending.startedAt, endedAt: pending.endedAt });
    console.log(`  of ${r.total} entr(ies): ${r.window} outside the window, ${r.cwd} other cwd, ${r.branch} other branch`);
    if (r.branchesSeen.size) console.log(`  branches in the log: ${[...r.branchesSeen].slice(0, 5).join(", ")}`);
    const worst = [["the time window", r.window], ["cwd (run this from the repo root)", r.cwd], ["branch", r.branch]]
      .sort((a, b) => b[1] - a[1])[0];
    if (worst[1]) console.log(`  → ${worst[0]} ruled out the most`);
  }
  if (entries.stats?.skipped)
    console.log(`  (${entries.stats.skipped} log file(s) skipped as older than the earliest dispatch)`);
  process.exit(0);
}
if (WRITE) {
  writeFileSync(jsonPath, JSON.stringify(task, null, 2) + "\n");
  console.log(`\n✅ wrote ${jsonPath}`);
} else {
  console.log(`\n(dry run — re-run with --write to save)`);
}
