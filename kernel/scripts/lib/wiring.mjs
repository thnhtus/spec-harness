import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { CFG } from "./config.mjs";
import { rel } from "./docs.mjs";
import { REQUIRED_ASK, REQUIRED_DENY } from "./guard.mjs";
import { calibrate } from "./lifecycle.mjs";
import { triage } from "./routing.mjs";
// #126: Gate 5 is only adversarial when the adversary runs in its own context. The installer writes
// native role files for the CLIs below; for any other CLI the 7 roles are prose in AGENTS.md and the
// adversary may share the implementer's context. "May": pi dispatches subagents through an extension
// the installer cannot see, so this says "cannot verify", never "is not isolated".
export const ROLE_DIRS = { claude: ".claude/agents", codex: ".codex/agents", cursor: ".claude/agents",
  gemini: ".gemini/agents", qwen: ".qwen/agents", droid: ".factory/droids" };


// #133: who must review a change to the rules that decide every gate. These paths are the gate:
// whoever can edit them without review can turn any gate off.
export const GATE_PATHS = ["harness.config.json", "docs/agents/", "docs/Instructions.md", "scripts/validate-tasks.mjs", ".github/workflows/", "hooks/", ".claude/settings.json"];


// A placeholder URL is worse than a missing one: `https://<git-host>/...` kills
// the CLI with ERR_INVALID_URL at startup, and `example.com` resolves fine while
// answering nothing -- Gate 1 loses its source of AC and the whole trace chain
// becomes invention.
// `example.com` is a placeholder ANYWHERE in the hostname, not just at the
// start: the shipped install has `gitlab.example.com`, and a start-anchored
// regex lets it through -- the kind of check that exists but catches nothing.
export const PLACEHOLDER_HOST = /(?:^<|\bexample\.(?:com|org|net)$|^localhost$|^your-|changeme)/i;


// Secrets do not belong in a committed file. OAuth tokens live in ~/.claude.json
// by design, but .mcp.json is the file people hand-edit, and it is the natural
// place to paste `Authorization: Bearer ...` when a server has no OAuth.
//
// Scan the VALUE, not the field name. Matching on `"authorization":` was wrong
// in both directions: it flagged `"Authorization": "!cmd"` -- the CORRECT way,
// where the token never enters the repo -- and it stayed silent on a real token
// under a header the list does not name (`X-Api-Token`, `PRIVATE-TOKEN`), which
// is the exact case this check exists to stop.

// A runtime instruction is a recipe for fetching the secret, not the secret:
// pi runs `!cmd` and substitutes stdout; `$VAR`/`${VAR}` interpolate the env.
export const RUNTIME_VALUE = /^\s*(!|\$\{?[A-Za-z_])/;


// Known token shapes. Prefix + length, so a header VALUE gives it away whatever
// the header happens to be called.
export const SECRET_SHAPE = /\b(gh[pousr]_[A-Za-z0-9]{16,}|glpat-[A-Za-z0-9_-]{16,}|sk-[A-Za-z0-9-]{16,}|xox[baprs]-[A-Za-z0-9-]{10,})\b/;


// Two classes, one list. The git rules stop a destroyed working tree; the .env
// rules stop the most common secret exfiltration path.
//
// `Read(.env)` alone was a hole with a sign on the wrong door: it denies the
// Read tool, but the agent also has Bash, and the Bash deny list only named
// git. `cat .env` walked straight through.
//
// CEILING, stated so nobody mistakes this for a sandbox: deny matches
// tool + command prefix, so `python3 -c "print(open('.env').read())"` is still
// wide open. This lowers the probability of an accident; it does not stop an
// agent that means it. The real control is not keeping secrets in the repo.
// Matched as a WHOLE RULE, not a substring. `deny.some(d => d.includes(r))` with
// r="env" is satisfied by the unrelated rule `Read(.env)` -- the check would
// report a guardrail that is not there. Each entry is the exact rule text.
// (REQUIRED_DENY itself is declared at the top of the file: --guard runs before
// config load and needs it there.)

// null = fine, string = what is wrong. A predicate rather than an inline assert
// so it can be fed the configs a project might actually write, not just the one
// this repo ships.
export function trackerConfigError(tracker) {
  const wb = tracker?.writeBack ?? "off";
  if (!["off", "comment", "status"].includes(wb))
    return `config.tracker.writeBack must be "off", "comment" or "status" (got ${JSON.stringify(wb)})`;
  if (wb === "status" && !String(tracker?.statusOnReview ?? "").trim())
    return 'config.tracker.writeBack="status" needs tracker.statusOnReview (e.g. "Ready for QC") \u2014 otherwise it looks enabled and moves nothing';
  return null;
}

// #165: `git.push` is the only permission a project may widen. A typo here must be
// reported, not obeyed: `askRulesFor()` fails safe on an unknown value (the ask
// stays), but that means the user believes they turned it off and never finds out
// why the pause is still there -- or, in the other direction, someone reads their
// own config and assumes it applied. Say it out loud.
export function gitPushConfigError(git) {
  const mode = git?.push;
  if (mode === undefined) return null; // unset = the shipped default, "ask"
  if (!["ask", "allow"].includes(mode))
    return `config.git.push must be "ask" or "allow" (got ${JSON.stringify(mode)}) \u2014 unset and every unknown value keep the push confirmation`;
  if (git !== null && typeof git === "object" && Object.keys(git).some((k) => k !== "push" && k !== "_push"))
    return `config.git has unknown keys (${Object.keys(git).filter((k) => k !== "push" && k !== "_push").join(", ")}) \u2014 the only switch is git.push; deny rules (reset --hard, stash, clean) are not configurable`;
  return null;
}


// #120: tracker write-back decision. The harness never calls the tracker (the coordinator does,
// through MCP), so idempotency is two things it CAN own: a marker every comment carries, and a
// decision the coordinator reads instead of re-deriving. The marker is a visible token on purpose —
// hidden HTML comments are stripped by some trackers' editors (Jira ADF), a visible one survives all.
export const writeBackMarker = (taskId) => `[spec-harness:${taskId}]`;

// `existing` = whatever the tracker's comment-list call returned, any shape: searched as text, so
// ClickUp / Jira / Linear need no per-vendor parser.
export const hasWriteBackMarker = (existing, taskId) => JSON.stringify(existing ?? "").includes(writeBackMarker(taskId));

// #120: does the tracker actually have config.tracker.statusOnReview? Preflight cannot ask (no MCP in
// CI); the coordinator can, right before moving the ticket. `statuses` = the tracker's status-list
// response, any shape: every string value is a candidate. Case-insensitive because ClickUp returns
// "ready for qc" for a status the UI shows as "Ready for QC". null = fine.
export function statusMissing(statuses, want) {
  const all = [], walk = (v) => typeof v === "string" ? all.push(v) : v && typeof v === "object" && Object.values(v).forEach(walk);
  walk(statuses);
  const norm = (x) => x.trim().toLowerCase();
  if (all.some((x) => norm(x) === norm(want ?? ""))) return null;
  const near = [...new Set(all.filter((x) => x.length < 40 && /[a-z]/i.test(x) && !/^https?:|^#?[0-9a-f]{6}$/i.test(x)))].slice(0, 12);
  return `tracker has no status "${want}" — moving the ticket would fail or land elsewhere. Seen: ${near.join(", ") || "(no strings in the response)"}`;
}


export function writeBackDecision(data, tracker) {
  const wb = tracker?.writeBack ?? "off", rec = data?.trackerWriteBack, marker = writeBackMarker(data?.taskId);
  if (wb === "off") return { do: "nothing", marker };
  const done = rec && (wb === "comment" || (rec.action === "status" && rec.status === tracker.statusOnReview));
  if (done) return { do: "skip", why: `already recorded at ${rec.at} (${rec.action}${rec.status ? ` → ${rec.status}` : ""})`, marker };
  // A recorded comment with status still owed: do NOT post a second comment.
  return { do: wb, marker, commentAlreadyPosted: rec?.action === "comment", statusOnReview: wb === "status" ? tracker.statusOnReview : undefined };
}

// What a record says versus what config asks, at `reviewing`. null = fine.
export function writeBackRecordDefect(rec, tracker) {
  const wb = tracker?.writeBack ?? "off";
  if (wb === "off" || !rec) return null;
  if (wb === "status" && rec.action !== "status") return `trackerWriteBack.action is "${rec.action}" but config.tracker.writeBack="status" — the ticket was commented, never moved`;
  if (wb === "status" && rec.status !== tracker.statusOnReview) return `trackerWriteBack.status "${rec.status}" ≠ config.tracker.statusOnReview "${tracker.statusOnReview}" — the ticket sits in a status this project does not call "review"`;
  return null;
}

export function unisolatedClis(installed, exists) {
  return [...new Set(installed)].filter((c) => !(ROLE_DIRS[c] && exists(ROLE_DIRS[c])));
}

export const isolationWarning = (c) =>
  `${c}: no native role files installed — cannot verify Gate 5 (adversary) runs in its own context. If it shares the implementer's, it is no longer independent; the exit-code gates (1-4) still hold (#126). Fix: set config.adversary.cmd and run --run-adversary <task> (#131)`;


// #125: the default key lives in a file the agent (same OS user) can read. A keychain is the
// cheap upgrade, so say so — but only when (a) the key IS a file, and (b) this machine really has
// a keychain CLI. Telling a Windows box to run `security` teaches something it cannot do.
// null = nothing to say. `has(cmd)` is injected so the self-check needs no real keychain.
export function keyStoreAdvice({ env = process.env, platform = process.platform, has, keyFileExists }) {
  if (env.SPEC_HARNESS_KEY || env.SPEC_HARNESS_KEY_CMD) return null;          // already out of the file
  if (!keyFileExists) return null;                                           // no key yet: nothing signed with a file key
  if (platform === "darwin" && has("security"))
    return "the stamp key is a file the agent can read — run `node scripts/validate-tasks.mjs --key-migrate` (stores it in the Keychain, verifies, then deletes the file) (#125/#132)";
  if (platform === "linux" && has("secret-tool"))
    return "the stamp key is a file the agent can read — run `node scripts/validate-tasks.mjs --key-migrate` (stores it with secret-tool, verifies, then deletes the file) (#125/#132)";
  return null;
}


// #132: move the stamp key out of the file into the OS keychain, as an explicit command (never at
// install time). Order is the whole safety story: store → read back → compare → only then delete
// the file. A failure at any step leaves the file key in place, so no signature is ever orphaned.
export function keyMigratePlan(platform) {
  if (platform === "darwin") return {
    tool: "security",
    store: (k) => ["security", ["add-generic-password", "-U", "-a", process.env.USER ?? "spec-harness", "-s", "spec-harness-stamp", "-w", k]],
    readCmd: "security find-generic-password -s spec-harness-stamp -w",
  };
  if (platform === "linux") return {
    tool: "secret-tool",
    store: (k) => ["secret-tool", ["store", "--label=spec-harness", "service", "spec-harness"], k],
    readCmd: "secret-tool lookup service spec-harness",
  };
  return null;
}

// A CODEOWNERS owner: @user, @org/team, or an email. The placeholder "@your-org/…" is a SYNTACTICALLY
// valid team, which is exactly why the template can't be installed as-is: GitHub then flags
// "unknown owner" and the file protects nothing.
export function ownerError(o) {
  if (!/^(@[A-Za-z0-9][A-Za-z0-9-]*(\/[A-Za-z0-9._-]+)?|[^@\s]+@[^@\s]+\.[^@\s]+)$/.test(o ?? "")) return `"${o}" is not a CODEOWNERS owner (@user, @org/team, or an email)`;
  if (/your-org|example\.com|changeme|placeholder/i.test(o)) return `"${o}" is a placeholder — it would make GitHub report an unknown owner and protect nothing`;
  return null;
}

export function codeownersText(owner) {
  return "# spec-harness (#133): who must review a change to the rules that decide every gate.\n" +
    "# Only effective with branch protection \"Require review from Code Owners\" (server-side).\n" +
    GATE_PATHS.map((p) => `/${p} ${owner}`).join("\n") + "\n";
}

// Gate paths with NO matching CODEOWNERS rule. Last-match-wins like GitHub; only the simple forms we
// emit and the common hand-written ones (exact path, dir/, *, **) are understood — an unknown
// pattern counts as "does not cover", so the warning errs toward telling you, never toward silence.
export function codeownersGaps(text) {
  const rules = (text ?? "").split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("#")).map((l) => l.split(/\s+/)).filter((c) => c.length >= 2);
  const covers = (pat, path) => {
    const p = pat.replace(/^\//, "");
    if (p === "*" || p === "**" || p === "**/*") return true;
    if (p.endsWith("/")) return path.startsWith(p) || path === p.slice(0, -1);
    return p === path || (p.endsWith("/**") && path.startsWith(p.slice(0, -2)));
  };
  return GATE_PATHS.filter((g) => !rules.some(([pat]) => covers(pat, g)));
}


export function denyGaps(settingsText) {
  let parsed;
  try { parsed = JSON.parse(settingsText); } catch { return ["settings.json is not valid JSON \u2014 the CLI ignores it entirely, so every deny rule is gone"]; }
  const deny = parsed?.permissions?.deny ?? [];
  return REQUIRED_DENY.filter((r) => !deny.includes(r)).map(
    (r) => `.claude/settings.json has no deny rule \`${r}\` \u2014 the guardrail is back to being prose the model may ignore`,
  );
}


// #106: an ask rule is wrong in BOTH directions, and the deny direction is the
// one an upgrade produces: a project installed before push moved to `ask` keeps
// denying it, so the push the user approved can never run -- on Claude and, since
// the guard unions the project's deny list, on every hook CLI too.
//
// #165: `askRules` is the EFFECTIVE list (askRulesFor(config.git.push)), not the
// constant. With git.push = "allow" it is empty: there is then no ask rule to
// require and none to warn about. Deny is still checked -- turning the pause off
// must not also make a deny rule invisible, because deny wins over ask in every
// CLI and the push would silently never run.
export function askGaps(settingsText, askRules = REQUIRED_ASK) {
  let parsed;
  try { parsed = JSON.parse(settingsText); } catch { return []; } // denyGaps already reports unparseable
  const deny = parsed?.permissions?.deny ?? [], ask = parsed?.permissions?.ask ?? [];
  // Deny is checked over REQUIRED_ASK, not askRules: an empty effective list must not skip it.
  const gaps = REQUIRED_ASK.flatMap((r) =>
    deny.includes(r)
      ? [`.claude/settings.json still DENIES \`${r}\` — ${askRules.includes(r) ? "it belongs in permissions.ask" : "harness.config.json sets git.push = \"allow\""}: a push the user approved can never run. Run the installer again to migrate it (#106)`]
      : !askRules.includes(r) || ask.includes(r)
        ? []
        : [`.claude/settings.json has no ask rule \`${r}\` — it runs with no confirmation, so nothing pauses before the last irreversible step`],
  );
  // The reverse drift, now that the list has a config switch: config says "allow"
  // but the rule is still sitting in ask. Not dangerous -- it silently keeps the
  // pause the project just turned off, which is the same class of "gate looks like
  // one thing, acts like another" that askGaps was written for.
  if (!askRules.length)
    for (const r of REQUIRED_ASK.filter((x) => ask.includes(x)))
      gaps.push(`.claude/settings.json still ASKS for \`${r}\` while harness.config.json sets git.push = "allow" — the confirmation is still there. Re-run the installer (or delete the rule) (#165)`);
  return gaps;
}


// Walk every string in the tree: naming the server and field beats one
// "something in this file looks like a credential" with no address.
function* strings(node, path = []) {
  if (typeof node === "string") yield [path, node];
  else if (node && typeof node === "object")
    for (const [k, v] of Object.entries(node)) yield* strings(v, [...path, k]);
}


export function mcpGaps(text) {
  const out = { errors: [], warnings: [] };
  let cfg;
  try { cfg = JSON.parse(text); } catch { return { errors: [".mcp.json is not valid JSON \u2014 the CLI starts with no MCP servers at all"], warnings: [] }; }
  for (const [path, v] of strings(cfg.mcpServers ?? {})) {
    if (RUNTIME_VALUE.test(v) || !SECRET_SHAPE.test(v)) continue;
    out.errors.push(`.mcp.json has a real credential at \`${path.join(".")}\` \u2014 it is committed; use a runtime value (\`!cmd\` runs a command, \`$\{VAR}\` reads the env) or the CLI's own auth store`);
  }
  for (const [name, srv] of Object.entries(cfg.mcpServers ?? {})) {
    if (!srv?.url) continue; // local server: command + args
    let host;
    try { host = new URL(srv.url).hostname; }
    catch { out.errors.push(`.mcp.json server "${name}" has an unparseable url (${srv.url}) \u2014 the CLI dies with ERR_INVALID_URL at startup, before you can fix it`); continue; }
    if (PLACEHOLDER_HOST.test(host))
      out.errors.push(`.mcp.json server "${name}" still points at a placeholder (${host}) \u2014 Gate 1 has no source of AC, so the whole traceability chain is invented`);
  }
  return out;
}


export function adapterGaps(projectRules, cfg = CFG) {
  const out = { errors: [], warnings: [] };
  const ph = (s) => /^<[^>]*>$/.test(String(s ?? "").trim());
  for (const [i, r] of (cfg.repos ?? []).entries())
    for (const k of ["name", "path", "layer"])
      if (ph(r?.[k])) out.errors.push(`config.repos[${i}].${k} is still the placeholder "${r[k]}" — run /init-project-rules (bootstrap records repoName from it)`);
  if (projectRules == null) return out;
  if (projectRules.includes("NOT-FILLED-IN"))
    out.errors.push("docs/agents/ProjectRules.md still carries the NOT-FILLED-IN marker — every role reads §1/§2/§3/§7 from it; run /init-project-rules, then delete the marker");
  else {
    const left = [...new Set(projectRules.split("\n").filter((l) => l.startsWith("|")).flatMap((l) => l.match(/`<[^`>]+>`/g) ?? []))];
    if (left.length) out.warnings.push(`docs/agents/ProjectRules.md table cells still placeholders: ${left.slice(0, 5).join(", ")}${left.length > 5 ? ` (+${left.length - 5})` : ""} — fill them or delete the row`);
  }
  return out;
}


// ---------------------------------------------------------------------------
// --preflight: is this checkout actually wired up? Run once before the first
// task, and from /start-task step 0.
//
// Two install faults only surfaced much later. Opening the CLI one directory
// above the harness leaves .claude/settings.json invisible, so the deny-list on
// `git push` / `git reset --hard` is gone -- broken but looking fine. And a
// self-contradicting config makes every gate a silent no-op, which the README
// admits you notice "after a few dozen tasks". Both are one cheap check away.
// ---------------------------------------------------------------------------

export function findUpward(name, start) {
  let dir = resolve(start);
  for (;;) {
    const hit = join(dir, name);
    if (existsSync(hit)) return hit;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}


// The CLI loads .claude/ by walking UP from cwd, never down. So the project
// settings only load when the directory holding them is cwd or an ancestor of
// it. Layout B puts them in harness/ and invites you to open the parent — then
// they are below cwd, invisible, and the deny-list is silently gone.
//
// Not "does a settings.json exist somewhere up the tree": ~/.claude/settings.json
// almost always does, and it is not the project's.
export function settingsReachable(repoRoot, cwd) {
  if (!existsSync(join(repoRoot, ".claude", "settings.json"))) return "missing";
  const rel = relative(resolve(repoRoot), resolve(cwd));
  const below = rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
  return below ? "ok" : "not-loaded";
}


// ---------------------------------------------------------------------------
// --triage: harness, or escape hatch? Exit code, not prose.
//
//   node scripts/validate-tasks.mjs --triage '{"scope":0,...}' [--branch-type bugfix]
//   ... --force "why I am skipping the harness anyway"
//
// --cost: what the harness costs before any work happens
// ---------------------------------------------------------------------------
// The ROI question has two halves. `--calibrate` answers "was it worth it" from
// `outcome`, but only after tasks close. This half is answerable NOW, because it
// does not depend on anything a run produces: every subagent must read
// Instructions + SharedRules + its role file before it can do anything, and
// those are files on disk. Measure them.
//
// Deliberately NOT a token count. Tokenisation is vendor-specific and drifts
// between model versions; a number that looks exact but is wrong by 30% is worse
// than a ratio nobody mistakes for a bill. Bytes are exact, comparable across
// releases, and that is what "did the kernel get heavier" actually needs.
//
// The number this produces is the FLOOR, not the total: it is paid once per
// stage, per task, before the task's own artifacts are read. A kernel that grows
// 16% shows up here, or it shows up on the monthly bill with no attributable
// cause.
export function ruleFloor({ read, roleDoc, roles, roleStage }) {
  const base = ["Instructions.md", "agents/SharedRules.md"].map((f) => ({ f, bytes: read(f) }));
  const baseBytes = base.reduce((n, x) => n + x.bytes, 0);
  const perRole = roles
    .map((r) => ({ role: r, stage: roleStage?.[r] ?? null, doc: roleDoc(r), bytes: read(roleDoc(r)) }))
    .filter((x) => x.bytes > 0);
  // One dispatch per STAGE, not per role: `implementer` and `fixer` both map to
  // `implementation` and only one of them runs. Counting both inflates the floor
  // by a whole role file and makes every later comparison wrong.
  const stages = [...new Set(perRole.map((x) => x.stage).filter(Boolean))];
  const byStage = stages.map((st) => {
    const rs = perRole.filter((x) => x.stage === st);
    // Worst case within a stage: routing picks one role, and the floor should
    // not shrink because a cheaper role exists next to an expensive one.
    const worst = rs.reduce((a, b) => (b.bytes > a.bytes ? b : a));
    return { stage: st, role: worst.role, roleBytes: worst.bytes, total: baseBytes + worst.bytes };
  });
  return {
    base,
    baseBytes,
    perRole,
    byStage,
    perTask: byStage.reduce((n, x) => n + x.total, 0),
    stages: byStage.length,
  };
}

// ── self-check: moved here with the logic it tests ──────────────────
export async function selfCheck({ assert }) {
  const { guardVerdict } = await import("./guard.mjs");
  const { budgetConfigError } = await import("./telemetry.mjs");
  {
    // Contract fixtures: the SHAPE each tracker's MCP comment-list returns. One decision, three vendors.
    const M = writeBackMarker("PRJ-7");
    const fx = {
      clickup: { comments: [{ id: "1", comment_text: `Done ${M} doc: docs/tasks/x` }] },
      jira: { comments: [{ id: "9", body: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: `Done ${M}` }] }] } }] },
      linear: { data: { issue: { comments: { nodes: [{ body: `Done ${M}\n\nevidence: 08` }] } } } },
    };
    for (const [name, r] of Object.entries(fx)) assert.equal(hasWriteBackMarker(r, "PRJ-7"), true, `${name}: marker found in its own response shape`);
    assert.equal(hasWriteBackMarker(fx.jira, "PRJ-8"), false, "another task's marker must not match");
    assert.equal(hasWriteBackMarker({ comments: [] }, "PRJ-7"), false);
    assert.equal(hasWriteBackMarker(undefined, "PRJ-7"), false, "no response = not posted");
    assert.equal(hasWriteBackMarker({ c: "[spec-harness:PRJ-77]" }, "PRJ-7"), false, "PRJ-77 must not satisfy PRJ-7 (closing bracket is part of the marker)");
    const t = { writeBack: "status", statusOnReview: "Ready for QC" }, d = { taskId: "PRJ-7" };
    assert.equal(writeBackDecision(d, { writeBack: "off" }).do, "nothing");
    assert.equal(writeBackDecision(d, t).do, "status");
    assert.equal(writeBackDecision(d, t).statusOnReview, "Ready for QC");
    assert.equal(writeBackDecision({ ...d, trackerWriteBack: { at: "T", action: "status", status: "Ready for QC" } }, t).do, "skip", "rerun after a recorded success = no-op");
    const half = writeBackDecision({ ...d, trackerWriteBack: { at: "T", action: "comment" } }, t);
    assert.deepEqual([half.do, half.commentAlreadyPosted], ["status", true], "comment done, move still owed: say so, so no second comment is posted");
    assert.equal(writeBackDecision({ ...d, trackerWriteBack: { at: "T", action: "status", status: "Done" } }, t).do, "status", "moved to the WRONG status is not done");
    assert.equal(writeBackDecision({ ...d, trackerWriteBack: { at: "T", action: "comment" } }, { writeBack: "comment" }).do, "skip");
    assert.match(writeBackRecordDefect({ at: "T", action: "comment" }, t), /never moved/);
    assert.match(writeBackRecordDefect({ at: "T", action: "status", status: "Done" }, t), /≠ config/);
    assert.equal(writeBackRecordDefect({ at: "T", action: "status", status: "Ready for QC" }, t), null);
    assert.equal(writeBackRecordDefect(undefined, t), null, "absence is reported elsewhere");
    // statusOnReview vs the tracker's real list, in each vendor's shape
    assert.equal(statusMissing({ statuses: [{ status: "to do" }, { status: "ready for qc", color: "#ff0000" }] }, "Ready for QC"), null, "clickup lowercases statuses");
    assert.equal(statusMissing([{ id: "3", name: "Ready for QC", statusCategory: { key: "indeterminate" } }], "Ready for QC"), null, "jira transitions/statuses");
    assert.equal(statusMissing({ data: { workflowStates: { nodes: [{ name: "In Review", type: "started" }] } } }, "In Review"), null, "linear workflowStates");
    const sm = statusMissing({ statuses: [{ status: "to do", color: "#ff0000" }, { status: "qc" }] }, "Ready for QC");
    assert.match(sm, /no status "Ready for QC"/); assert.match(sm, /to do, qc/); assert.doesNotMatch(sm, /#ff0000/, "colors are not status names");
    assert.match(statusMissing({}, "X"), /no strings/);
  }
  {
    const has = (...d) => (x) => d.includes(x);
    assert.deepEqual(unisolatedClis(["claude", "codex"], has(".claude/agents", ".codex/agents")), [], "native role files = isolated, silent");
    assert.deepEqual(unisolatedClis(["aider", "pi"], () => true), ["aider", "pi"], "no role dir mapped for the CLI = cannot verify, even if some dir exists");
    assert.deepEqual(unisolatedClis(["gemini"], has(".claude/agents")), ["gemini"], "gemini needs ITS OWN dir, not claude's");
    assert.deepEqual(unisolatedClis(["claude", "claude"], () => false), ["claude"], "mapped but files gone = warn once, not twice");
    assert.match(isolationWarning("pi"), /cannot verify/, "wording must stay honest: pi may have extension subagents");
    assert.doesNotMatch(isolationWarning("pi"), /is not isolated/);
  }
  // #140-#143: scope control and the guard, against the bypasses found by probing (4.3).
  {
    const yes = (c) => ["security", "secret-tool"].includes(c), no = () => false, A = (o) => keyStoreAdvice({ env: {}, keyFileExists: true, has: yes, ...o });
    assert.match(A({ platform: "darwin" }), /--key-migrate/);
    assert.match(A({ platform: "linux" }), /secret-tool/);
    assert.equal(A({ platform: "win32" }), null, "no keychain CLI we can name on Windows: say nothing");
    assert.equal(A({ platform: "darwin", has: no }), null, "keychain CLI absent: do not teach a command that cannot run");
    assert.equal(A({ platform: "darwin", env: { SPEC_HARNESS_KEY_CMD: "x" } }), null, "already using a keychain: silent");
    assert.equal(A({ platform: "darwin", env: { SPEC_HARNESS_KEY: "k" } }), null, "CI secret: silent");
    assert.equal(A({ platform: "darwin", keyFileExists: false }), null, "no file key exists: nothing to move");
    assert.equal(A({ platform: "linux", has: (c) => c === "security" }), null, "macOS tool on Linux does not count");
  }
  {
    for (const ok of ["@alice", "@acme/platform", "dev@acme.io"]) assert.equal(ownerError(ok), null, ok);
    for (const bad of ["alice", "@", "@acme/", "", undefined, "a b"]) assert.ok(ownerError(bad), `rejects ${JSON.stringify(bad)}`);
    assert.match(ownerError("@your-org/harness-maintainers"), /placeholder/, "the shipped template handle must never be installed");
    const t = codeownersText("@acme/platform");
    assert.deepEqual(codeownersGaps(t), [], "what we write covers every gate path");
    assert.deepEqual(codeownersGaps("# only comments\n"), GATE_PATHS, "no rules = nothing covered");
    assert.deepEqual(codeownersGaps("/harness.config.json @a\n"), GATE_PATHS.filter((p) => p !== "harness.config.json"), "partial coverage names exactly what is missing");
    assert.deepEqual(codeownersGaps("* @a\n"), [], "a catch-all covers everything");
    assert.deepEqual(codeownersGaps("/docs/ @a\n").filter((p) => p.startsWith("docs/")), [], "a directory rule covers files under it");
    assert.ok(codeownersGaps("/docs/agents/Adversary.md @a\n").includes("docs/agents/"), "one file under docs/agents/ does not cover the directory");
    assert.deepEqual(codeownersGaps(null), GATE_PATHS, "no file = nothing covered");
  }
  assert.equal(budgetConfigError(CFG.budget), null, budgetConfigError(CFG.budget) ?? "");
  assert.ok(budgetConfigError({ maxTokensPerTask: -1 }) && budgetConfigError({ maxTokensPerTask: "9" }) && budgetConfigError({ maxTokensPerTask: 1.5 }), "bad budget values must be rejected");
  {
    const { mkdtempSync, mkdirSync, writeFileSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const root = mkdtempSync(join(tmpdir(), "sh-pf-"));
    const h = join(root, "harness");
    mkdirSync(join(h, ".claude"), { recursive: true });
    mkdirSync(join(h, "sub"), { recursive: true });
    assert.equal(settingsReachable(h, h), "missing", "no settings.json at all");
    writeFileSync(join(h, ".claude", "settings.json"), "{}");
    assert.equal(settingsReachable(h, h), "ok", "cwd = harness root");
    assert.equal(settingsReachable(h, join(h, "sub")), "ok", "cwd below root: the CLI walks up and finds it");
    assert.equal(settingsReachable(h, root), "not-loaded", "cwd ABOVE root: the CLI never walks down (layout B trap)");
    rmSync(root, { recursive: true, force: true });
  }

  // denyGaps: present + loaded is not the same as armed. (That the settings.json
  // we SHIP satisfies these rules is asserted in install.mjs --self-test, which
  // is the only place with the source tree; here we test the predicate.)
  assert.equal(denyGaps('{"permissions":{"deny":[]}}').length, REQUIRED_DENY.length,
    "an empty deny list is every rule missing, not a pass");
  assert.ok(denyGaps("not json").some((d) => /valid JSON/.test(d)),
    "unparseable settings.json means the CLI ignores it — that is worse than missing, not better");
  assert.ok(
    denyGaps('{"permissions":{"deny":["Bash(git reset --hard:*)","Bash(git stash:*)"]}}')
      .some((d) => /git clean/.test(d)),
    "a partial deny list must name the rule that is missing, not just fail",
  );
  // askGaps (#106): both directions, and the upgrade direction loudest.
  assert.match(askGaps('{"permissions":{"deny":["Bash(git push:*)"]}}')[0], /still DENIES/,
    "a pre-#104 settings.json that still denies push must be reported, not silently accepted");
  assert.match(askGaps('{"permissions":{}}')[0], /no ask rule/, "a missing ask rule means push runs with no confirmation");
  assert.deepEqual(askGaps('{"permissions":{"ask":["Bash(git push:*)"]}}'), [], "push in ask is the correct state");
  // #165: with git.push = allow the effective ask list is empty -- no rule required,
  // and no warning about the rule being absent (that would be every install one
  // config line away from red). A DENY rule stays an error: deny beats ask, so the
  // approved push still could not run, on this CLI and every hook CLI that unions it.
  assert.deepEqual(askGaps('{"permissions":{}}', []), [], "git.push = allow: no ask rule wanted");
  assert.match(askGaps('{"permissions":{"deny":["Bash(git push:*)"]}}', [])[0], /still DENIES/,
    "git.push = allow does not hide a deny rule — deny wins over ask everywhere");
  assert.match(askGaps('{"permissions":{"ask":["Bash(git push:*)"]}}', [])[0], /still ASKS/,
    "a rule left in ask after git.push = allow must be reported, not silently kept");
  assert.deepEqual(askGaps("not json", []), [], "unparseable settings.json is denyGaps' error to report, not reported twice");
  // gitPushConfigError (#165): unset and the two legal values pass; anything else is named.
  for (const ok of [undefined, {}, { push: "ask" }, { push: "allow", _push: "why" }]) assert.equal(gitPushConfigError(ok), null, `git ${JSON.stringify(ok)} is valid`);
  assert.match(gitPushConfigError({ push: "Allow" }), /must be "ask" or "allow"/, "case matters — Allow is a typo");
  assert.match(gitPushConfigError({ push: true }), /must be "ask" or "allow"/, "a boolean is not a mode");
  assert.match(gitPushConfigError({ push: "allow", reset: "allow" }), /not configurable/, "no other git rule can be widened");

  // This list used to hold fragments ("git push") matched with
  // `d.includes(r)`, and the moment `env` joined it the check started lying:
  // the unrelated rule `Read(.env)` satisfied the requirement for `Bash(env:*)`,
  // so a settings.json with no Bash guard at all reported zero gaps.
  //
  // The fix is not a smarter matcher, it is the shape of the entries: every one
  // must be a WHOLE rule, so `deny.includes()` is exact and nothing can nest
  // inside anything else. Assert the shape, because that is the invariant a
  // future edit would break.
  for (const r of REQUIRED_DENY)
    assert.ok(/^(Bash|Read|Write|Edit|WebFetch)\(.+\)$/.test(r),
      `REQUIRED_DENY entry ${JSON.stringify(r)} is not a whole rule — a fragment makes the match ambiguous and the check silently passes on rules that are not there`);
  assert.equal(new Set(REQUIRED_DENY).size, REQUIRED_DENY.length, "REQUIRED_DENY has a duplicate");

  // guardVerdict: the deny-list for Codex/Cursor. Each case isolates ONE branch.
  {
    const rd = (r) => `role/${r}.md`;
    const sizes = { "Instructions.md": 1000, "agents/SharedRules.md": 2000, "role/a.md": 300, "role/b.md": 900, "role/c.md": 500 };
    const rf = ruleFloor({
      read: (f) => sizes[f] ?? 0, roleDoc: rd,
      roles: ["a", "b", "c"], roleStage: { a: "impl", b: "impl", c: "review" },
    });
    // Per STAGE, not per role. `implementer` and `fixer` share `implementation`
    // and only one of them runs; counting both inflates the floor by a whole
    // role file, and every release-to-release comparison after that is wrong.
    assert.equal(rf.stages, 2, "two roles on one stage is one dispatch, not two");
    // Within a stage, the worst case: routing picks the role, and the floor must
    // not shrink just because a cheaper role sits next to an expensive one.
    assert.equal(rf.byStage.find((x) => x.stage === "impl").role, "b", "the larger role file sets the floor for its stage");
    assert.equal(rf.perTask, (3000 + 900) + (3000 + 500), "per-task floor = base + worst role, summed over stages");
    // A stage whose role files are ALL missing must vanish from the report, not
    // appear with the base cost and a 0 KB role -- that reads like a cheap stage
    // when in fact the measurement is broken. (One missing role out of several
    // needs no special handling: the max already skips it.)
    const gone = ruleFloor({ read: (f) => (f.startsWith("role/") ? 0 : sizes[f] ?? 0), roleDoc: rd,
      roles: ["a", "b", "c"], roleStage: { a: "impl", b: "impl", c: "review" } });
    assert.equal(gone.stages, 0, "stages with no readable role file must drop out, not report the base cost as if the stage were cheap");
    assert.equal(gone.perTask, 0, "a floor of 0 is the honest answer when nothing could be read");
  }

  // A vendor name in the kernel schema is a project detail that climbed one
  // level up -- same bug as `fe-*` roles and a hardcoded doc language, and it
  // is only ever noticed by the team that uses a different tracker. Config can
  // change the URL *shape* (tracker.urlPattern); it cannot rename a field.
}

