#!/usr/bin/env node
// A lease on one task folder: stops two /start-task sessions running the same task.
//
//   node scripts/lease.mjs acquire <task-folder>    # exit 1 if another session holds it
//   node scripts/lease.mjs renew   <task-folder>    # called at every stage dispatch
//   node scripts/lease.mjs release <task-folder>
//   node scripts/lease.mjs --self-check
//
// A worktree isolates the CODE repo's files. It does not isolate docs/tasks/ —
// in layout C every task shares one harness repo, so two sessions will overwrite
// each other's handoffs without anyone noticing.
//
// Written in Node so it runs from PowerShell/cmd, not just bash: `mkdir -p`,
// `find -mmin`, `hostname` and `$$` do not exist there — and step 0 of
// /start-task runs BEFORE everything else, so breaking it breaks the command.

import { mkdirSync, writeFileSync, readFileSync, statSync, rmSync } from "node:fs";
import { join } from "node:path";
import { hostname, tmpdir } from "node:os";

const TTL_MS = 30 * 60 * 1000; // a lease older than 30' = the previous session hung/Ctrl-C'd

const paths = (taskDir) => {
  const dir = join(taskDir, ".agent-memory", ".lease.d");
  return { dir, owner: join(dir, "owner") };
};

const mtime = (p) => { try { return statSync(p).mtimeMs; } catch { return null; } };

// A lease is dead when — and only when — it is OLD.
//
// Between mkdir and writing owner there is a few-ms window where the directory
// exists but owner does not. Reading "no owner" as "dead" means every session
// landing in that window STEALS a live session's lease (measured on the bash
// version: 20 parallel sessions, 7 successful steals). So a missing owner
// defaults to ALIVE; only when the directory itself is past the TTL is it a
// genuine orphan (the other session died exactly in that window).
function dead({ dir, owner }, now = Date.now()) {
  const t = mtime(owner) ?? mtime(dir);
  return t !== null && now - t > TTL_MS;
}

const stamp = ({ owner }) =>
  writeFileSync(owner, `pid=${process.pid} host=${hostname()} at=${new Date().toISOString()}`);

// mkdir rather than "check then write": the window between check and write is
// exactly the race the lease exists to prevent. mkdir fails-if-exists in ONE syscall.
function acquire(taskDir) {
  const p = paths(taskDir);
  mkdirSync(join(taskDir, ".agent-memory"), { recursive: true });
  try {
    mkdirSync(p.dir); // { recursive: true } would NOT throw when it exists — defeating the point
  } catch (e) {
    if (e.code !== "EEXIST") throw e;
    if (!dead(p)) {
      try { console.error(readFileSync(p.owner, "utf8")); } catch {}
      console.error("→ this task is already running elsewhere. STOP.");
      return 1;
    }
  }
  stamp(p);
  return 0;
}

const release = (taskDir) => (rmSync(paths(taskDir).dir, { recursive: true, force: true }), 0);

// The 30' TTL is designed to detect a DEAD SESSION, but stamp() runs only once
// at acquire — so it ends up covering the whole task lifetime. A `high` task
// running 6 stages on the `strong` model easily exceeds 30', and at that point a
// LIVE lease is treated as an orphan: a second session acquires it, two sessions
// write .agent-memory — exactly the race the lease exists to prevent.
//
// The coordinator calls renew at every stage dispatch (the same place it bumps
// attempts). No timer or background process needed: each stage is a natural
// heartbeat, and the longest stage is still shorter than the TTL.
//
// It must NOT create a lease from nothing — a renew that mkdirs is an acquire
// that skipped the check, i.e. it legitimises the very steal this file prevents.
function renew(taskDir) {
  const p = paths(taskDir);
  if (mtime(p.dir) === null) {
    console.error("→ not holding the lease (never acquired, or already released). Not renewing.");
    return 1;
  }
  stamp(p);
  return 0;
}

// ── self-check ─────────────────────────────────────────────────────────────
if (process.argv[2] === "--self-check") {
  const { strict: assert } = await import("node:assert");
  const { mkdtempSync, utimesSync } = await import("node:fs");
  const t = mkdtempSync(join(tmpdir(), "lease-"));

  assert.equal(acquire(t), 0, "a free lease must be acquirable");
  assert.equal(acquire(t), 1, "a live lease must be refused");

  // stale owner → takeover allowed
  const p = paths(t);
  const old = new Date(Date.now() - TTL_MS - 60_000);
  utimesSync(p.owner, old, old);
  assert.equal(acquire(t), 0, "a lease past its TTL must be takeable");

  // The mkdir→stamp window: fresh directory, no owner yet → must count as ALIVE.
  release(t);
  mkdirSync(p.dir, { recursive: true });
  assert.equal(dead(p), false, "no owner + fresh directory = alive, must not be stolen");
  utimesSync(p.dir, old, old);
  assert.equal(dead(p), true, "no owner + directory past TTL = a genuine orphan");

  // renew: keeps the lease alive past the TTL, otherwise long tasks lose their slot.
  release(t);
  acquire(t);
  utimesSync(p.owner, old, old);
  assert.equal(dead(p), true, "precondition: the lease is past its TTL");
  assert.equal(renew(t), 0, "holding the lease means renew succeeds");
  assert.equal(dead(p), false, "renew must bring the lease back to life");
  assert.equal(acquire(t), 1, "after renew, another session must still be refused");

  release(t);
  assert.equal(renew(t), 1, "not holding the lease means renew must FAIL");
  assert.equal(mtime(p.dir), null, "renew must not create a lease from nothing");

  acquire(t);
  release(t);
  assert.equal(mtime(p.dir), null, "release must remove the lease");
  rmSync(t, { recursive: true, force: true });
  console.log("✅ lease self-check passed");
  process.exit(0);
}

const [cmd, taskDir] = process.argv.slice(2);
const CMDS = { acquire, renew, release };
if (!taskDir || !CMDS[cmd]) {
  console.error("usage: node scripts/lease.mjs acquire|renew|release <task-folder>");
  process.exit(2);
}
process.exit(CMDS[cmd](taskDir));
