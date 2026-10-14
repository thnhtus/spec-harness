// guard.mjs — the deny-list guard and role sandbox (#118 split).
// No config import on purpose: --guard runs BEFORE config load, so a missing harness.config.json
// must not stop a hook from answering.
import { resolve, relative, isAbsolute, join, dirname, sep } from "node:path";

// Declared here, not next to denyGaps(): --guard below runs BEFORE config load.
// `git push` is deliberately NOT in REQUIRED_DENY: it is the last step of a task,
// not an accident. It is REQUIRED_ASK: pause, show the command, run it on the
// user's yes. Claude gets that from `permissions.ask` in settings.json; every
// other CLI gets it from --guard below, in whatever shape its hook schema has.
// Deny wins over ask.
export const REQUIRED_ASK = ["Bash(git push:*)"];

export const REQUIRED_DENY = [
  "Bash(git reset --hard:*)", "Bash(git stash:*)", "Bash(git clean:*)",
  "Bash(cat .env:*)", "Bash(env:*)", "Bash(printenv:*)", "Read(.env)",
];


// ---------------------------------------------------------------------------
// --guard codex|cursor: the deny-list for CLIs that do not read
// `.claude/settings.json → permissions.deny`. Wired as Codex `PreToolUse` and
// Cursor `beforeShellExecution` / `beforeReadFile` by install.mjs --cli.
//
// ONE list: REQUIRED_DENY ∪ the project's settings.json deny rules, parsed with
// Claude's own syntax. A second copy of the list per CLI would drift, and a
// drifted guard is a guardrail that looks armed.
//
// Runs before config load on purpose: a hook that exits 2 because
// harness.config.json is missing blocks EVERY shell command in the session.
//
// ponytail: prefix match per `&&`/`;`/`|` segment after guardNorm (#143: strips `VAR=x `,
// `(`/`$(`, a leading `./`; any common reader of .env counts as `cat .env`). Same ceiling as
// Claude's deny — `bash -c "git push"`, `git -C x push`, `python -c open('.env')` pass.
// It stops accidents, not intent. Upgrade path: a real shell parser, if a
// bypass ever shows up in telemetry.
// ---------------------------------------------------------------------------
// #143: what a shell would run, not what was typed. Drops leading `VAR=val ` assignments and
// `(`/`{` groupers, and a `./` in front of an operand. Still no parser: `sh -c`, `git -C` stay open.
export const guardNorm = (s) => s.trim().replace(/^(?:\$\()?[({\s`]*/, "").replace(/^(?:[A-Za-z_]\w*=\S*\s+)+/, "")
  .replace(/\s+/g, " ").replace(/ \.\//g, " ").replace(/[)}]+$/, "").trim();

// Readers other than `cat` that dump a file's content; a Bash(cat .env) rule means "read .env".
export const READERS = /^(?:cat|head|tail|less|more|tac|nl|od|xxd|strings|bat|sed|awk|grep|rg|cut|sort|uniq|base64)\b/;


// Every CLI names the same two things differently (command / command_line /
// CommandLine, file_path / path / AbsolutePath…) and nests them differently
// (tool_input, toolArgs as a JSON string, toolCall.args, preToolUse.parameters).
// Cline 3.x batches: run_commands {commands: ["a", {command, args}]} — one
// subject per element; exec form {command:"git", args:["push"]} is joined.
// So: walk the payload, collect by KEY, never by position. Only these keys are
// read — a `content` string that merely mentions `git push` is not a push.
export const GUARD_CMD_KEYS = new Set(["command", "command_line", "CommandLine"]);

export const GUARD_PATH_KEYS = new Set(["file_path", "path", "absolute_path", "AbsolutePath", "filePath"]);


// How each CLI reads an answer. "exit" = exit 2 + stderr denies, exit 0 and
// silence allows. The JSON modes MUST print on allow too: Cursor denies on
// invalid JSON, Cline requires `cancel`, Antigravity requires `decision`.
// Antigravity allow is "ask", not "allow": "allow" would auto-approve every
// command the guard does not know about, i.e. the guard would LOOSEN the CLI.
// Cursor allow is `{}` for the same reason (#45): `permission` is optional in
// both schemas (cursor-agent 2026.09 validators), "allow" may skip Cursor's own
// approval, and "ask" is NOT in beforeReadFile's schema — an invalid answer
// there blocks every read.
// Cline deny (#46): `cancel` stops the whole task, so the two tools seen e2e get
// `overrideInput` that fails with the reason instead; other tools keep cancel.
export const GUARD_MODES = {
  codex: "exit", gemini: "exit", qwen: "exit", copilot: "exit", droid: "exit", windsurf: "exit", devin: "exit", kiro: "exit",
  goose: "exit", hermes: "exit", opencode: "exit", pi: "exit",
  cursor: "cursor", antigravity: "antigravity", cline: "cline",
};


// A real "ask" verdict, per CLI schema (survey in #104). A CLI missing here has
// none, so an ask hit is ALLOWED and AGENTS.md prose holds -- never turned into a
// deny, that would make a user-approved push impossible.
//   exit-3  pi: the extension turns it into ctx.ui.confirm().
//   codex   hook parses permissionDecision "ask" but marks the run failed (openai/codex#28437); ask goes through .codex/rules instead (#105, --codex-rules).
//   cline   cancel / overrideInput only. kiro, windsurf, devin, goose, opencode: exit code only.
// ponytail: gemini's `decision:"ask"` is implemented (PR #21146 upstream) but
// undocumented (#28046). Cursor ask is shell-only: beforeReadFile has none, and an
// invalid answer there blocks every read (#45) -- REQUIRED_ASK is Bash-only so
// reads never reach this. qwen/copilot/antigravity: headless or cloud ask -> deny, theirs.
export const hso = (why) => ({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "ask", permissionDecisionReason: why } });

export const ASK_FORMATS = {
  cursor: (why) => ({ permission: "ask", user_message: why, agent_message: why }),
  copilot: (why) => ({ permissionDecision: "ask", permissionDecisionReason: why }),
  droid: hso, qwen: hso,
  gemini: (why) => ({ decision: "ask", reason: why }),
  antigravity: (why) => ({ decision: "ask", reason: why }),
};


export const WRITES_ALL = new Set(["tee", "rm", "rmdir", "touch", "truncate", "mkdir", "shred"]);

export const WRITES_LAST = new Set(["cp", "mv", "install", "ln", "rsync"]);

export const PREFIX = new Set(["sudo", "env", "command", "nohup", "time", "exec"]);


// #105: Codex hooks cannot answer "ask" (openai/codex#28437), but Codex has its
// own native prompt mechanism -- execpolicy rules. Render REQUIRED_ASK ∪ the
// project's permissions.ask into THAT format, one list, no hand-kept copy.
// Bash-only: a Codex rule has no concept of a file read, same split as the hook.
export function askRulesFile(askRules) {
  const lines = ["# spec-harness: prompt before these — generated by install.mjs, overwritten on upgrade.\n"];
  for (const r of askRules) {
    const m = /^Bash\((.+?)(:\*)?\)$/.exec(r);
    if (!m) continue; // Read()/Write() etc have no Codex rule equivalent
    const pattern = m[1].trim().split(/\s+/);
    const sample = pattern.join(" "), J = JSON.stringify; // JSON strings are valid Starlark strings
    lines.push(
      `prefix_rule(\n` +
      `    pattern = ${J(pattern)},\n` +
      `    decision = "prompt",\n` +
      `    justification = ${J(`spec-harness ask rule ${r} (docs/Instructions.md §1): only after the final gate, on the user's yes`)},\n` +
      // Codex's own inline tests, checked at load: a wrong pattern = parse error, not a silent no-op.
      `    match = ${J(m[2] ? [sample, `${sample} x`] : [sample])},\n` +
      // `<first>x` can never match a prefix starting with `<first>`, whatever rule a project adds.
      `    not_match = ${J([`${pattern[0]}x`])},\n` +
      `)\n`,
    );
  }
  return lines.join("\n");
}

export function guardVerdict(kind, subject, deny) {
  const toRe = (glob) => new RegExp(`^${glob.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*")}$`);
  for (const rule of deny) {
    const m = /^(Bash|Read)\((.+)\)$/.exec(rule);
    if (!m) continue;
    if (kind === "shell" && m[1] === "Bash") {
      const prefix = m[2].replace(/:\*$/, "");
      const open = m[2].endsWith(":*");
      for (const seg of String(subject).split(/&&|\|\||[;|\n]/).map(guardNorm))
        if (seg === prefix || (open && seg.startsWith(prefix + " "))) return rule;
      // `cat .env` rule → any common reader whose operand is .env / .env.*  (#143)
      const cat = /^cat (\S+)$/.exec(prefix);
      if (cat && open) for (const seg of String(subject).split(/&&|\|\||[;|\n]/).map(guardNorm))
        if (READERS.test(seg) && seg.split(" ").slice(1).some((a) => a === cat[1] || a.startsWith(cat[1] + "."))) return rule;
    }
    if (kind === "read" && m[1] === "Read") {
      const base = String(subject).split(/[\\/]/).pop();
      if (toRe(m[2]).test(base)) return rule;
    }
  }
  return null;
}

export function guardSubjects(payload) {
  const out = { shell: [], read: [] };
  const walk = (v, depth) => {
    if (depth > 6 || v == null || typeof v !== "object") return;
    for (const [k, x] of Object.entries(v)) {
      if (GUARD_CMD_KEYS.has(k) && (typeof x === "string" || Array.isArray(x)))
        out.shell.push([x, Array.isArray(v.args) ? v.args : []].flat().join(" "));
      else if (k === "commands" && Array.isArray(x)) { for (const c of x) typeof c === "string" ? out.shell.push(c) : walk(c, depth + 1); }
      else if (GUARD_PATH_KEYS.has(k) && typeof x === "string") out.read.push(x);
      else if (typeof x === "string" && /^(toolArgs|tool_args|arguments|files)$/.test(k)) { try { walk(JSON.parse(x), depth + 1); } catch {} }
      else walk(x, depth + 1);
    }
  };
  walk(payload, 0);
  return out;
}


// Cline 3.x: replace ONLY the denied entries of the batch with ones that fail
// carrying the reason; allowed entries still run and the task goes on.
// ponytail: /dev/null/<reason> fails with ENOTDIR on POSIX only; on Windows the
// read just fails with a less readable error. Unknown tool or shape → cancel.
export function clineDeny(input, deny, why) {
  const tool = input?.preToolUse?.toolName, raw = input?.tool_call?.input;
  const hit = (kind, x) => guardSubjects(kind === "shell" ? { commands: [x] } : { path: x })[kind]
    .some((s) => guardVerdict(kind, s, deny));
  let n = 0;
  const swap = (x, bad, repl) => (bad ? (n++, repl) : x);
  let out;
  if (tool === "run_commands" && Array.isArray(raw?.commands))
    out = { ...raw, commands: raw.commands.map((c) =>
      swap(c, hit("shell", c), `echo '${why.replaceAll("'", "'\\''")}' >&2; exit 1`)) };
  if (tool === "read_files" && Array.isArray(raw?.files))
    out = { ...raw, files: raw.files.map((f) => {
      const p = typeof f === "string" ? f : f?.path, q = `/dev/null/${why}`;
      return swap(f, hit("read", p), typeof f === "string" ? q : { ...f, path: q });
    }) };
  // Nothing replaced = the hit came from somewhere we cannot rewrite: never let it run.
  return out && n ? { overrideInput: out } : { cancel: true, errorMessage: why };
}


// ---------------------------------------------------------------------------
// --guard-role: the read-only roles (adversary, fsd-reviewer) may only WRITE
// inside tasksDir (#53). "Does not touch src/" was prose; this is a PreToolUse
// hook in their Claude frontmatter, so it only fires while that subagent runs.
// Not `disallowedTools: Edit, Write`: both roles must write 09 / 02 /
// .agent-memory / task.agent.json.
//
// A target with no harness.config.json above it (the code repo in layout C) is
// outside every tasksDir by definition → deny.
// Bash (#57): roleBashTargets pulls the write targets out of the command line
// (redirects, tee/rm/touch/…, sed -i/perl -i, cp/mv dest) and each one goes
// through the same verdict.
// ponytail: an interpreter writing by itself (`node -e`, `python -c`, `git
// apply`), `$(…)` and `$VAR` paths other than $PWD/$HOME pass unseen.
// Backstop: `--eval` scores "src unchanged" per case. Upgrade path: a
// post-hoc `git status` check at SubagentStop, if eval shows a role doing it.
// ---------------------------------------------------------------------------
export function roleWriteVerdict(target, cwd, cfgAt) {
  if (typeof target !== "string" || !target) return null;
  const abs = resolve(cwd, target);
  // Adversary-Mutation.md: the throwaway `git worktree add --detach /tmp/adv-$$`
  // is where the adversary IS allowed to change a constant.
  if (/^(\/private)?\/tmp\/adv-[^/]+(\/|$)/.test(abs)) return null;
  let dir = dirname(abs);
  for (;;) {
    const cfg = cfgAt(dir);
    if (cfg) {
      const tasks = resolve(dir, cfg.tasksDir ?? "docs/tasks");
      return abs.startsWith(tasks + sep) ? null : `outside ${relative(dir, tasks) || tasks}/`;
    }
    const up = dirname(dir);
    if (up === dir) return "no harness.config.json above it";
    dir = up;
  }
}


// Shell words + operators, quote-aware. Heredoc bodies are skipped: `a > b`
// inside `<<EOF` is text, not a redirect.
export function shellTokens(cmd) {
  const out = [];
  let w = null, q = null, heredocs = [];
  const flush = () => { if (w !== null) out.push({ w }); w = null; };
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i];
    if (q) {
      if (c === q) q = null;
      else if (c === "\\" && q === '"' && i + 1 < cmd.length) w += cmd[++i];
      else w += c;
      continue;
    }
    if (c === "'" || c === '"') { q = c; w ??= ""; continue; }
    if (c === "\\" && i + 1 < cmd.length) { w = (w ?? "") + cmd[++i]; continue; }
    if (c === "\n") {
      flush(); out.push({ op: ";" });
      for (const d of heredocs) {
        for (;;) {
          const end = cmd.indexOf("\n", i + 1);
          const line = cmd.slice(i + 1, end < 0 ? cmd.length : end);
          i = end < 0 ? cmd.length : end;
          if (line.replace(/^\t+/, "") === d || end < 0) break;
        }
      }
      heredocs = [];
      continue;
    }
    if (/\s/.test(c)) { flush(); continue; }
    if (c === "<" && cmd[i + 1] === "<") {
      flush();
      const m = /^<<-?\s*(['"]?)([A-Za-z0-9_]+)\1/.exec(cmd.slice(i));
      if (m) { heredocs.push(m[2]); i += m[0].length - 1; continue; }
    }
    const op = /^(&&|\|\||&>>?|>>|>&|>\||>|[;|()&])/.exec(cmd.slice(i))?.[0];
    if (op) {
      // "2>" / "2>>": the fd digit belongs to the redirect, not to the words
      if (op[0] === ">" && w !== null && /^\d+$/.test(w)) w = null;
      flush(); out.push({ op }); i += op.length - 1; continue;
    }
    w = (w ?? "") + c;
  }
  flush();
  return out;
}


// Every path a Bash command line would write, resolved against its cwd
// (tracking `cd`, scoped by subshell parens).
export function roleBashTargets(cmd, cwd, home = process.env.HOME ?? "/") {
  const targets = [];
  const stack = [];
  const expand = (p, dir) => {
    const v = p.replace(/^~(?=\/|$)/, home).replace(/\$\{?PWD\}?/g, dir).replace(/\$\{?HOME\}?/g, home);
    return v.includes("$") && !/^(\/private)?\/tmp\/adv-/.test(v) ? null : resolve(dir, v);
  };
  let words = [], redirect = false;
  const end = () => {
    let a = words;
    while (a.length && (PREFIX.has(a[0]) || /^[A-Za-z_]\w*=/.test(a[0]))) a = a.slice(1);
    const [name, ...rest] = a;
    const args = rest.filter((x) => !x.startsWith("-"));
    const add = (xs) => { for (const x of xs) { const p = x && expand(x, cwd); if (p) targets.push(p); } };
    if (name === "cd") cwd = expand(rest[0] ?? home, cwd) ?? cwd;
    else if (WRITES_ALL.has(name)) add(args);
    else if (WRITES_LAST.has(name)) add(args.slice(-1));
    else if ((name === "sed" || name === "perl") && rest.some((x) => /^-[A-Za-z]*i/.test(x) || x.startsWith("--in-place")))
      add(args.filter(Boolean).slice(1)); // first non-option is the script
    words = [];
  };
  for (const t of shellTokens(cmd)) {
    if (t.w !== undefined) {
      if (redirect) {
        redirect = false;
        if (!/^&?\d*$/.test(t.w) && !/^\/dev\/(null|stdout|stderr|tty)$/.test(t.w)) {
          const p = expand(t.w, cwd);
          if (p) targets.push(p);
        }
      } else words.push(t.w);
    } else if (t.op.includes(">")) redirect = true;
    else {
      end();
      if (t.op === "(") stack.push(cwd);
      else if (t.op === ")") cwd = stack.pop() ?? cwd;
    }
  }
  end();
  return targets;
}

// ── self-check: moved here with the logic it tests ──────────────────
export async function selfCheck({ assert }) {
  {
    const cfgAt = (d) => (d === "/h" ? { tasksDir: "docs/tasks" } : null);
    assert.equal(roleWriteVerdict("docs/tasks/sprint-1/A-1/09-Adversarial-Review.md", "/h", cfgAt), null, "09 inside tasksDir is allowed");
    assert.equal(roleWriteVerdict("/h/docs/tasks/sprint-1/A-1/.agent-memory/adversary.md", "/x", cfgAt), null, "absolute path inside tasksDir is allowed");
    assert.ok(roleWriteVerdict("src/app.ts", "/h", cfgAt), "src/ is denied");
    assert.ok(roleWriteVerdict("docs/tasks-evil/x.md", "/h", cfgAt), "a sibling sharing the prefix is not inside tasksDir");
    assert.ok(roleWriteVerdict("/code/src/a.ts", "/h", cfgAt), "no config above the target (layout C code repo) is denied");
    assert.equal(roleWriteVerdict(undefined, "/h", cfgAt), null, "no path in the payload is not a write");
    assert.equal(roleWriteVerdict("/tmp/adv-123/src/a.ts", "/h", cfgAt), null, "the mutation worktree (Adversary-Mutation.md) is allowed");
    assert.ok(roleWriteVerdict("/tmp/advx/src/a.ts", "/h", cfgAt), "only the adv-<pid> worktree, not any /tmp path");

    // roleBashTargets (#57): one assert per write form, and the look-alikes that are not writes
    const T = (c) => roleBashTargets(c, "/h", "/home/u");
    assert.deepEqual(T("echo x > src/a.js"), ["/h/src/a.js"], "redirect");
    assert.deepEqual(T("npm test 2>> log.txt"), ["/h/log.txt"], "fd redirect, append");
    assert.deepEqual(T("npm test &> out"), ["/h/out"], "&> redirect");
    assert.deepEqual(T("npm test 2>&1 | tee -a r.txt"), ["/h/r.txt"], "2>&1 is a dup, tee writes");
    assert.deepEqual(T("npm test >/dev/null 2>&1"), [], "/dev/null is not a write");
    assert.deepEqual(T("sed -i '' 's/>/</' src/a.js"), ["/h/src/a.js"], "BSD sed -i: script dropped, quoted > is text");
    assert.deepEqual(T("sed -i.bak -e s/a/b/ src/a.js"), ["/h/src/a.js"], "GNU sed -i with -e");
    assert.deepEqual(T("sed -n 1,5p src/a.js"), [], "sed without -i reads");
    assert.deepEqual(T("perl -pi -e 's/a/b/' src/a.js"), ["/h/src/a.js"], "perl -pi");
    assert.deepEqual(T("cp -r a b/c"), ["/h/b/c"], "cp: destination only");
    assert.deepEqual(T("rm -f x y"), ["/h/x", "/h/y"], "rm: every arg");
    assert.deepEqual(T("sudo FOO=1 touch z"), ["/h/z"], "prefix + assignment stripped");
    assert.deepEqual(T("cd src && echo 1 > a.js"), ["/h/src/a.js"], "cd is tracked");
    assert.deepEqual(T("(cd /tmp/adv-1 && sed -i s/1/2/ src/a.js); echo > b"), ["/tmp/adv-1/src/a.js", "/h/b"], "subshell cd does not leak");
    assert.deepEqual(T("echo \"a > b\" 'c > d'"), [], "> inside quotes is text");
    assert.deepEqual(T("cat > $PWD/x <<'EOF'\nfoo > src/a.js\nEOF\necho y > z"), ["/h/x", "/h/z"], "heredoc body skipped, command after it still parsed");
    assert.deepEqual(T("echo > ~/x; echo > $TASK/09.md"), ["/home/u/x"], "~ expanded; unknown $VAR skipped (ponytail)");
    assert.deepEqual(T("git diff main -- src | grep x"), [], "a read-only pipeline writes nothing");
    assert.equal(roleWriteVerdict(T("rm -rf /tmp/adv-$")[0], "/h", cfgAt), null, "removing the mutation worktree itself is allowed");
    assert.deepEqual(T("cat <<EOF > a\nx\ny > src/b.js\nEOF"), ["/h/a"], "heredoc body runs to its terminator, not one line");
    assert.deepEqual(T("touch a 2>/dev/null"), ["/h/a"], "the fd digit is not an argument");
    assert.deepEqual(T("echo a \\> b"), [], "an escaped > is text");
  }

  // strayTaskFolders (#54): a task the group scan skips must be reported, a
  // non-task dir and the group dirs themselves must not.
  {
    const g = (k, s) => guardVerdict(k, s, REQUIRED_DENY);
    assert.equal(g("shell", "git push origin main"), null, "guard: push is NOT hard-denied");
    const ga = (c) => guardVerdict("shell", c, REQUIRED_ASK);
    assert.equal(ga("npm test && git push origin main"), "Bash(git push:*)", "ask: push after && must ask");
    assert.equal(ga("git pushx"), null, "ask: a prefix is a whole word");
    assert.equal(ga("git status"), null, "ask: an ordinary command passes");
    for (const [cli, f] of Object.entries(ASK_FORMATS)) {
      const o = f("WHY"), t = JSON.stringify(o);
      assert.ok(/"ask"/.test(t) && !/deny/.test(t), `ASK_FORMATS.${cli} must say ask, never deny`);
    }
    assert.equal(ASK_FORMATS.cursor("W").permission, "ask", "cursor: flat permission field");
    // #105: codex execpolicy rendering.
    const cr = askRulesFile(["Bash(git push:*)", "Read(.env)", "Bash(npm publish)"]);
    assert.equal((cr.match(/prefix_rule\(/g) ?? []).length, 2, "codex rules: one per Bash rule, Read() has no Codex equivalent");
    assert.match(cr, /pattern = \["git","push"\],\n    decision = "prompt"/, "codex rules: git push → prompt");
    assert.match(cr, /match = \["npm publish"\]/, "codex rules: an exact rule (no :*) gets no extra-args example");
    assert.doesNotMatch(cr, /forbidden|"allow"/, "codex rules: ask never renders as forbidden/allow");
    assert.equal(ASK_FORMATS.qwen("W").hookSpecificOutput.permissionDecision, "ask", "qwen/droid: hookSpecificOutput shape");
    assert.equal(g("shell", "git reset --hard"), "Bash(git reset --hard:*)", "guard: bare prefix (no args) must block");
    assert.equal(g("shell", "npm test && git reset --hard HEAD"), "Bash(git reset --hard:*)", "guard: a denied command after && must block");
    assert.equal(g("shell", "ls; git  stash"), "Bash(git stash:*)", "guard: after ; with doubled space must block");
    assert.equal(g("shell", "git stashx"), null, "guard: a prefix is a whole word, `git stashx` is not `git stash`");
    assert.equal(g("shell", "git status"), null, "guard: an allowed command must pass");
    assert.equal(g("read", "/repo/.env"), "Read(.env)", "guard: reading .env must block");
    assert.equal(g("read", "/repo/src/env.ts"), null, "guard: a file merely named like env must pass");
    assert.equal(guardVerdict("read", "C:\\repo\\.env.local", ["Read(.env.*)"]), "Read(.env.*)", "guard: glob rule + Windows path must block");
    assert.equal(g("read", "/repo/.git/push"), null, "guard: a Bash rule never matches a read");
    // guardSubjects: one shape per branch.
    assert.deepEqual(guardSubjects({ toolCall: { args: { CommandLine: "git push" } } }).shell, ["git push"], "guard walker: nested CommandLine");
    assert.deepEqual(guardSubjects({ toolArgs: '{"command":"git push"}' }).shell, ["git push"], "guard walker: toolArgs as a JSON string");
    assert.deepEqual(guardSubjects({ tool_input: { command: ["git", "push"] } }).shell, ["git push"], "guard walker: argv array");
    // Cline 3.x run_commands (observed e2e, cline 3.0.65): a batch, each element its own subject.
    assert.deepEqual(guardSubjects({ parameters: { commands: ["ls", "git push"] } }).shell, ["ls", "git push"], "guard walker: commands[] batch");
    assert.deepEqual(guardSubjects({ commands: [{ command: "git", args: ["push"] }] }).shell, ["git push"], "guard walker: exec form {command,args}");
    assert.deepEqual(guardSubjects({ preToolUse: { toolName: "read_files", parameters: { files: '[{"path":"/r/.env"}]' } } }).read, ["/r/.env"], "guard walker: read_files JSON-string files");
    assert.deepEqual(guardSubjects({ preToolUse: { parameters: { path: ".env" } } }).read, [".env"], "guard walker: nested path");
    assert.deepEqual(guardSubjects({ tool_input: { file_path: "a.md", content: "git push; cat .env" } }),
      { shell: [], read: ["a.md"] }, "guard walker: file CONTENT mentioning git push is not a push");
    // clineDeny (#46): rewrite only the denied entries, keep the task alive.
    const D = ["Bash(git push:*)", "Read(.env)"];
    const cl = (tool, input) => clineDeny({ preToolUse: { toolName: tool }, tool_call: { input } }, D, "WHY");
    const rc = cl("run_commands", { commands: ["ls", "git push"] });
    assert.equal(rc.cancel, undefined, "clineDeny: run_commands hit must not cancel the task");
    assert.equal(rc.overrideInput.commands[0], "ls", "clineDeny: allowed entry of the batch unchanged");
    assert.match(rc.overrideInput.commands[1], /^echo 'WHY' >&2; exit 1$/, "clineDeny: denied entry fails with the reason");
    const rf = cl("read_files", { files: [{ path: "/r/.env", start_line: null }, { path: "/r/a.md" }] });
    assert.deepEqual(rf.overrideInput.files, [{ path: "/dev/null/WHY", start_line: null }, { path: "/r/a.md" }], "clineDeny: denied read points at an unreadable path");
    assert.deepEqual(cl("apply_patch", { path: ".env" }), { cancel: true, errorMessage: "WHY" }, "clineDeny: unknown tool falls back to cancel");
    assert.equal(cl("run_commands", { commands: [{ command: "git", args: ["push"] }] }).cancel, undefined, "clineDeny: exec-form entry rewritten");
    assert.equal(cl("run_commands", "git push").cancel, true, "clineDeny: unexpected shape falls back to cancel");
    // The guard hit elsewhere in the payload but no entry matches: rewriting nothing would let it run.
    assert.equal(cl("read_files", { files: [{ path: "/r/a.md" }] }).cancel, true, "clineDeny: nothing rewritten -> cancel, never a silent allow");
  }

  // ruleFloor: the cost half that does not need anyone to fill telemetry in.
}

