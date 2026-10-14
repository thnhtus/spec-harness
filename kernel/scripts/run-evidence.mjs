#!/usr/bin/env node
// Run a check command and record evidence that is NOT cheap to fake.
//
//   node scripts/run-evidence.mjs -- npm run test:scope
//   node scripts/run-evidence.mjs --append docs/tasks/sprint-1/ABC-1-x/08-Test-Evidence.md -- npm run lint
//   node scripts/run-evidence.mjs --self-check
//
// Why this exists: Gate 4/5 used to ask "does this text look like test output"
// — a question a regex can answer, so an agent that never ran a command could
// pass by typing `Tests: 12 passed`. The right question is "did this command
// run and exit 0", and only the process that actually ran it can answer. This
// wrapper runs the command and stamps MACHINE-OBSERVED results into the output.
//
// It cannot stop an agent that deliberately hand-types the whole attestation
// block — nothing can, short of a signing server. It turns that from
// "accidentally slipped through a loose gate" into "deliberate fabrication",
// and leaves `gitRev` + `durationMs` for the adversary to cross-check. That is
// the right level of defence for a harness running on the dev's own machine.

import { spawnSync } from "node:child_process";
import { appendFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";

export const MARK = "--- spec-harness attestation ---";

// outputHash binds the attestation to EXACTLY the output sitting next to it.
//
// Without it the two cheapest fakes both pass: (1) copy a whole attestation
// block from another task and paste it under hand-written output, (2) run it
// for real, then prettify the output inside the fence while keeping the
// attestation. Both have a "valid attestation" under any per-field check.
//
// This is NOT a signature: the hash function is public, and a determined agent
// can compute it. It closes exactly those two holes — the two a lazy agent
// falls into — and leaves something the adversary can verify with one command.
// Stopping a determined faker needs a signing server, which is the wrong price
// for a harness running on a dev machine.
export const hashOutput = (s) => createHash("sha256").update(s, "utf8").digest("hex").slice(0, 16);

// #137: `gitRev` alone cannot say whether the tree this ran against is still the
// tree being shipped. The old check only parsed gitRev and never compared it, so
// running the tests on Monday and rewriting the implementation on Tuesday left
// both gates green.
//
// Comparing commits is the WRONG fix: the normal flow is to run the tests on a
// dirty tree and commit the same content afterwards, which moves HEAD and turns
// `git diff <gitRev>` into a list of files that did not change a byte. What has
// to be witnessed is CONTENT, so this hashes (path, content-sha) of every file
// on disk — staged, unstaged and untracked alike. Committing changes nothing;
// editing one line changes the whole fingerprint.
//
// `docs/tasks/` is excluded on purpose: the attestation is appended to 08 and
// the task status moves after the run, so a witness over its own file would
// invalidate itself the moment it is written.
//
// Returns null (never a fake value) when git cannot answer — no repo, shallow
// clone, unreadable file list. Callers fail open on null, the same ceiling as
// the _stamp.log signatures: an unverifiable tree is not a stale one.
export function worktreeFingerprint(cwd, excludePrefix = "docs/tasks") {
  const git = (...a) => {
    const r = spawnSync("git", ["-C", cwd, ...a], { encoding: "utf8", maxBuffer: 1 << 28 });
    return r.status === 0 ? r.stdout : null;
  };
  const root = git("rev-parse", "--show-toplevel");
  if (root === null) return null;
  const top = root.trim();
  const tracked = git("ls-files");
  if (tracked === null) return null;
  const untracked = git("ls-files", "--others", "--exclude-standard") ?? "";
  const all = [...new Set([...tracked.split("\n"), ...untracked.split("\n")])]
    .filter(Boolean)
    .filter((p) => !excludePrefix || !(p === excludePrefix || p.startsWith(excludePrefix + "/")));
  if (!all.length) return null;
  const present = all.filter((p) => existsSync(join(top, p)));
  const gone = all.filter((p) => !existsSync(join(top, p)));
  // One call for every file: hash-object reads the WORKING TREE, so a staged,
  // unstaged or never-added file all hash to what a reviewer would check out.
  const r = present.length
    ? spawnSync("git", ["-C", top, "hash-object", "--stdin-paths"],
        { input: present.join("\n") + "\n", encoding: "utf8", maxBuffer: 1 << 28 })
    : null;
  if (present.length && r?.status !== 0) return null;
  const shas = r ? r.stdout.split("\n").filter(Boolean) : [];
  if (shas.length !== present.length) return null;
  const lines = [
    ...present.map((p, i) => `${shas[i]} ${p}`),
    // A deletion is a change like any other; `-` can never collide with a sha.
    ...gone.map((p) => `- ${p}`),
  ].sort();
  return createHash("sha256").update(lines.join("\n"), "utf8").digest("hex").slice(0, 16);
}

// The wrapper runs from the project root, so the exclude prefix comes from the
// config that root declares. No config → the same default the kernel uses.
function tasksDirPrefix(cwd) {
  try {
    const cfg = JSON.parse(readFileSync(join(cwd, "harness.config.json"), "utf8"));
    const d = String(cfg.tasksDir ?? "docs/tasks").replace(/^\.\//, "").replace(/\/$/, "");
    return d;
  } catch { return "docs/tasks"; }
}

// Fixed order: the validator matches fields by name, but a human reading a diff
// matches by line — keep it stable so diffing two runs shows only real changes.
export function renderAttestation(a) {
  return [
    MARK,
    `exitCode: ${a.exitCode}`,
    `durationMs: ${a.durationMs}`,
    `gitRev: ${a.gitRev}`,
    `worktree: ${a.worktree}`,
    `startedAt: ${a.startedAt}`,
    `outputHash: ${a.outputHash}`,
  ].join("\n");
}

export function parseAttestation(text) {
  const i = text.lastIndexOf(MARK);
  if (i === -1) return null;
  const body = text.slice(i + MARK.length);
  const get = (k) => {
    const m = new RegExp(`^${k}:\\s*(.+)$`, "m").exec(body);
    return m ? m[1].trim() : null;
  };
  const exitCode = get("exitCode");
  if (exitCode === null) return null;
  return {
    exitCode: Number(exitCode),
    durationMs: Number(get("durationMs") ?? NaN),
    gitRev: get("gitRev"),
    worktree: get("worktree"),
    startedAt: get("startedAt"),
    outputHash: get("outputHash"),
  };
}

const gitRev = () => {
  const r = spawnSync("git", ["rev-parse", "--short", "HEAD"], { encoding: "utf8" });
  return r.status === 0 ? r.stdout.trim() : "unavailable";
};

export function runEvidence(argv) {
  const started = new Date();
  const t0 = Date.now();
  // stdio inherit is unusable: the output has to be captured to write into 08.
  // Still echo it to the terminal, or the dev sees nothing while waiting.
  const r = spawnSync(argv[0], argv.slice(1), { encoding: "utf8", shell: false });
  const out = `${r.stdout ?? ""}${r.stderr ?? ""}`;
  process.stdout.write(out);
  // Nonexistent command: spawn errors, status is null. That is a non-zero exit
  // in meaning — treating it as 0 turns a typo'd command into green evidence.
  const exitCode = r.error ? 127 : (r.status ?? 1);
  // The hash covers exactly the two things people edit: the command and its output.
  const cmdLine = `$ ${argv.join(" ")}`;
  const body = `${cmdLine}\n${out.trimEnd()}`;
  return {
    block: [
      "```",
      body,
      renderAttestation({
        exitCode,
        durationMs: Date.now() - t0,
        gitRev: gitRev(),
        // After the run, not before: the command may write files (snapshots, fixtures),
        // and what the validator re-hashes later is the tree AFTER them.
        worktree: worktreeFingerprint(process.cwd(), tasksDirPrefix(process.cwd())) ?? "unavailable",
        startedAt: started.toISOString(),
        outputHash: hashOutput(body),
      }),
      "```",
    ].join("\n"),
    exitCode,
  };
}

// validate-tasks.mjs cannot import this file (top-level side effects below), so it
// asks the one implementation through a child process: no second copy to drift.
if (process.argv[2] === "--fingerprint") {
  console.log(worktreeFingerprint(process.cwd(), tasksDirPrefix(process.cwd())) ?? "unavailable");
  process.exit(0);
}

// ── self-check ─────────────────────────────────────────────────────────────
if (process.argv[2] === "--self-check") {
  const { strict: assert } = await import("node:assert");

  const ok = runEvidence([process.execPath, "-e", "console.log('Tests: 4 passed')"]);
  assert.equal(ok.exitCode, 0, "a successful command → exit 0");
  const a = parseAttestation(ok.block);
  assert.ok(a, "the block must parse");
  assert.equal(a.exitCode, 0, "the attestation records the real exit code");
  assert.ok(a.durationMs >= 0 && Number.isFinite(a.durationMs), "durationMs is a real number");
  assert.ok(/^\d{4}-\d{2}-\d{2}T/.test(a.startedAt), "startedAt is an ISO timestamp");
  // #137: every block must carry a worktree witness, and it must be the real one
  // for this label — "unavailable" here would make the whole check a no-op.
  assert.ok(a.worktree && a.worktree !== "unavailable", `the block records a real worktree fingerprint (got ${a.worktree})`);

  // The witness must move when a file's CONTENT moves and stay put when only the
  // commit changes — that is the whole difference from comparing gitRev.
  {
    const { mkdtempSync, writeFileSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { execFileSync } = await import("node:child_process");
    const dir = mkdtempSync(join(tmpdir(), "wtfp-"));
    const g = (...a) => execFileSync("git", a, { cwd: dir, stdio: "pipe" });
    try {
      g("init", "-q");
      g("config", "user.email", "t@t");
      g("config", "user.name", "t");
      writeFileSync(join(dir, "a.js"), "export const a = 1\n");
      writeFileSync(join(dir, "docs.txt"), "x\n");
      g("add", "-A");
      g("commit", "-qm", "base");
      const clean = worktreeFingerprint(dir);
      assert.ok(clean, "a clean repo has a fingerprint");
      // committing a change moves the fingerprint
      writeFileSync(join(dir, "a.js"), "export const a = 2\n");
      const edited = worktreeFingerprint(dir);
      assert.notEqual(edited, clean, "editing a tracked file must change the fingerprint");
      g("add", "-A");
      g("commit", "-qm", "the edit");
      assert.equal(worktreeFingerprint(dir), edited,
        "committing the SAME content must not change it — gitRev does move here, which is why gitRev alone is the wrong check");
      // an untracked, non-ignored file is part of the tree a reviewer would see
      writeFileSync(join(dir, "new.js"), "export const n = 1\n");
      assert.notEqual(worktreeFingerprint(dir), edited, "a new untracked file must change the fingerprint");
      // the excluded prefix is excluded: the attestation cannot invalidate itself
      const withAll = worktreeFingerprint(dir), without = worktreeFingerprint(dir, "docs.txt");
      writeFileSync(join(dir, "docs.txt"), "changed\n");
      assert.notEqual(worktreeFingerprint(dir), withAll, "an included file changes it");
      assert.equal(worktreeFingerprint(dir, "docs.txt"), without,
        "the excluded prefix is skipped — otherwise writing the attestation into 08 invalidates the block it is inside");
      // deletions count
      const withDel = worktreeFingerprint(dir, "docs.txt");
      rmSync(join(dir, "new.js"));
      assert.notEqual(worktreeFingerprint(dir, "docs.txt"), withDel, "deleting a file must change the fingerprint");
      // and it fails open, never inventing a value, outside a repo
      assert.equal(worktreeFingerprint(tmpdir()), worktreeFingerprint(join(tmpdir(), "nope-" + Date.now())),
        "outside a repo git cannot answer → null as well (fail open), not a made-up fingerprint");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }

  // This is the case the wrapper exists to catch: the command PRINTS "passed"
  // but exits non-zero. The old regex read "passed" as green; the attestation
  // reads the exit code as red.
  const lying = runEvidence([process.execPath, "-e", "console.log('Tests: 12 passed'); process.exit(1)"]);
  assert.equal(lying.exitCode, 1, "printing passed while exiting 1 is still a failure");
  assert.equal(parseAttestation(lying.block).exitCode, 1, "the attestation trusts the exit code, not the output");

  // A nonexistent command must be a failure, not a silent exit 0.
  assert.equal(runEvidence(["no-such-command-here-123"]).exitCode, 127, "a nonexistent command = failure");

  assert.equal(parseAttestation("no attestation in here"), null, "no marker → null");
  // Appending a second run to the same file: it must read the NEWEST block.
  const two = `${runEvidence([process.execPath, "-e", "process.exit(1)"]).block}\n${ok.block}`;
  assert.equal(parseAttestation(two).exitCode, 0, "reads the newest attestation, not the first");

  // outputHash binds the attestation to the output NEXT TO IT. The two cases
  // below are exactly the cheapest fakes that any per-field check would pass.
  const bodyOf = (blk) => {
    const lines = blk.split("\n");
    return lines.slice(1, lines.indexOf(MARK)).join("\n");
  };
  assert.equal(hashOutput(bodyOf(ok.block)), a.outputHash, "a wrapper-generated block hashes correctly");
  // (1) run it for real, then prettify the output in the fence, keeping the attestation
  const tampered = ok.block.replace("Tests: 4 passed", "Tests: 999 passed");
  assert.notEqual(hashOutput(bodyOf(tampered)), parseAttestation(tampered).outputHash,
    "editing the output while keeping the attestation must break the hash");
  // (2) paste another task's attestation under hand-written output
  const stolen = ["```", "$ npm run test:all", "Tests: 50 passed", renderAttestation(a), "```"].join("\n");
  assert.notEqual(hashOutput(bodyOf(stolen)), parseAttestation(stolen).outputHash,
    "an attestation copied from elsewhere must break the hash");

  console.log("✅ run-evidence self-check passed");
  process.exit(0);
}

const sep = process.argv.indexOf("--");
if (sep === -1 || sep === process.argv.length - 1) {
  console.error("usage: node scripts/run-evidence.mjs [--append <file>] -- <command> [args...]");
  process.exit(2);
}
const appendAt = process.argv.indexOf("--append");
const target = appendAt !== -1 && appendAt < sep ? process.argv[appendAt + 1] : null;
const { block, exitCode } = runEvidence(process.argv.slice(sep + 1));

if (target) {
  if (!existsSync(target)) { console.error(`✖ no such file: ${target}`); process.exit(2); }
  appendFileSync(target, `\n${block}\n`);
  console.error(`→ evidence appended to ${target}`);
} else {
  console.error(`\n→ paste the block below into 08-Test-Evidence.md:\n`);
  console.log(block);
}
process.exit(exitCode);
