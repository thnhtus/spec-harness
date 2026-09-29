#!/usr/bin/env node
// spec-harness installer — cài kernel + adapter + agent + gate vào một project.
//
// Chạy được từ MỌI shell (PowerShell, cmd, bash, zsh, WSL):
//   node install.mjs [project-root]   # thiếu = "."; hỏi xác nhận trước khi ghi
//   node install.mjs . --yes          # bỏ hỏi (CI, script)
//   node install.mjs --self-test      # cài thử vào repo tạm rồi kiểm, không đụng gì
//
// Viết bằng Node chứ không phải bash là có chủ đích: Node 20+ vốn đã bắt buộc
// (validator cần), nên bỏ bash đi không thêm phụ thuộc nào — mà xoá được ba thứ
// cùng lúc: `bash` không chắc có trên PATH của PowerShell (Git for Windows chỉ
// đưa cmd/ vào PATH, không đưa bin/), `python3` trong self-test, và cả lớp lỗi
// CRLF (bash chết bằng "set: pipefail: invalid option name", không gợi gì).
//
// Chạy lại được: file bạn đã sửa (harness.config.json, ProjectRules.md,
// .claude/commands/start-task.md, .mcp.json) KHÔNG bị đè — nâng kernel không mất adapter.

import {
  cpSync, mkdirSync, existsSync, readFileSync, writeFileSync, rmSync, readdirSync,
  symlinkSync, lstatSync, statSync, unlinkSync, chmodSync, mkdtempSync, realpathSync,
} from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync, spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { createInterface } from "node:readline/promises";

const REPO = process.env.SPEC_HARNESS_REPO || "thnhtus/spec-harness";
const REF = process.env.SPEC_HARNESS_REF || "master";

const die = (...m) => { console.error(...m); process.exit(1); };

// Đang chạy bằng chính node này, nên chỉ còn ca "node quá cũ" — ca "không có
// node" đã do shell báo trước khi script kịp chạy.
if (Number(process.versions.node.split(".")[0]) < 20)
  die(`✖ node v${process.versions.node} quá cũ — validator cần Node 20+.`);

// ── nguồn: thư mục cạnh script, hoặc tarball tải về ────────────────────────
let SRC = dirname(fileURLToPath(import.meta.url));

if (!existsSync(join(SRC, "kernel"))) {
  // Chạy kiểu tải-lẻ-mỗi-installer (curl … | bash, hoặc tải install.mjs rồi gọi)
  // thì không có kernel/ để copy. Lấy tarball về tmp và cài từ đó.
  const tmp = mkdtempSync(join(tmpdir(), "spec-harness-"));
  process.on("exit", () => rmSync(tmp, { recursive: true, force: true }));
  console.log(`→ tải ${REPO}@${REF} …`);
  let ok = false;
  for (const kind of ["heads", "tags"]) {
    const res = await fetch(`https://codeload.github.com/${REPO}/tar.gz/refs/${kind}/${REF}`);
    if (!res.ok) continue;
    writeFileSync(join(tmp, "src.tgz"), Buffer.from(await res.arrayBuffer()));
    // tar: có sẵn trên Windows 10 1803+ (bsdtar), macOS, Linux. Không dùng thư
    // viện tar của npm vì installer phải chạy được trước khi có node_modules.
    const r = spawnSync("tar", ["xzf", join(tmp, "src.tgz"), "-C", tmp], { stdio: "ignore" });
    if (r.error) die("✖ không tìm thấy `tar` — cài nó, hoặc clone repo rồi chạy install.mjs trong đó");
    if (r.status === 0) { ok = true; break; }
  }
  if (!ok) die(`✖ không tải được ${REPO}@${REF} (repo private? sai ref?) — clone rồi chạy install.mjs trong đó`);
  const dir = readdirSync(tmp).find((n) => existsSync(join(tmp, n, "kernel")));
  if (!dir) die("✖ tarball không có kernel/ — sai repo?");
  SRC = join(tmp, dir);
}

// ── helpers ────────────────────────────────────────────────────────────────
function* walk(dir) {
  let ents;
  try { ents = readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of ents) {
    const p = join(dir, e.name);
    if (e.isDirectory()) yield* walk(p);
    else if (e.isFile()) yield p;
  }
}

const read = (p) => readFileSync(p, "utf8");

// Pre-commit hook là TUỲ CHỌN — một chỗ cắm gate, không phải điều kiện chạy.
// Trả về lý do bỏ qua (string), hoặc null nếu cắm được.
function installHook(P) {
  let h;
  // Hỏi git đường dẫn hook (tôn trọng core.hooksPath của husky/lefthook), không đoán ".git/".
  try {
    h = execFileSync("git", ["rev-parse", "--path-format=absolute", "--git-path", "hooks/pre-commit"],
      { cwd: P, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch { return "không nằm trong git repo"; }
  if (!h) return "không nằm trong git repo";

  const ours = join(P, "hooks", "pre-commit");

  // `--path-format=absolute` RESOLVE symlink: sau lần cài đầu, git trả về chính
  // `hooks/pre-commit` của harness chứ không phải `.git/hooks/pre-commit`. Không
  // bắt ca này thì lần cài thứ hai sẽ unlink file gốc rồi symlink nó vào chính
  // nó — ELOOP, hook biến mất trong im lặng, commit hỏng lọt qua.
  try { if (realpathSync(h) === realpathSync(ours)) return null; } catch {}

  let st = null;
  try { st = lstatSync(h); } catch {}

  // File thật, không phải bản của harness → hook riêng của project, không đè.
  // Nhận diện bằng marker trong nội dung: bản copy (Windows không symlink được)
  // vẫn phải được refresh khi nâng kernel, nên không thể chỉ dựa vào "là symlink".
  if (st && !st.isSymbolicLink() && !read(h).includes("spec-harness gate"))
    return "project đã có pre-commit riêng — không đè";

  mkdirSync(dirname(h), { recursive: true });
  if (st) unlinkSync(h);
  try {
    symlinkSync(ours, h);
  } catch {
    // Windows chỉ cho symlink khi bật Developer Mode / chạy admin. Copy vẫn cắm
    // được gate; giá phải trả là nâng kernel thì phải chạy lại installer.
    cpSync(ours, h);
  }
  try { chmodSync(h, 0o755); } catch {}
  return null;
}

// Những file kernel SẼ đè, tính trước khi ghi một byte nào — để hỏi user trước
// chứ không báo sau. Trùng logic với over() bên dưới, nên self-test khoá hai
// bên phải ra cùng kết quả (drift là im lặng và chỉ lộ ra khi đã đè mất file).
function wouldClobber(P) {
  const out = [];
  const chk = (src, dst) => {
    try { if (existsSync(dst) && read(src) !== read(dst)) out.push(dst.slice(P.length + 1)); } catch {}
  };
  for (const f of readdirSync(join(SRC, "kernel/docs"), { withFileTypes: true }))
    if (f.isFile()) chk(join(SRC, "kernel/docs", f.name), join(P, "docs", f.name));
  for (const f of ["validate-tasks.mjs", "lease.mjs", "run-evidence.mjs", "collect-telemetry.mjs"])
    chk(join(SRC, "kernel/scripts", f), join(P, "scripts", f));
  chk(join(SRC, "hooks/pre-commit"), join(P, "hooks/pre-commit"));
  chk(join(SRC, "adapters/claude-code/prompt-submit"), join(P, "hooks/prompt-submit"));
  return out;
}

// Version của kernel đang cài. Đọc từ package.json của NGUỒN, không hardcode —
// hai chỗ khai số thì chúng sẽ lệch, và đó đúng là bug đã có (plugin.json 0.1.0
// vs package.json 0.1.1).
function kernelVersion() {
  try { return JSON.parse(read(join(SRC, "package.json"))).version; } catch { return null; }
}

// ── multi-CLI (#43) ────────────────────────────────────────────────────────────────────
// `.claude/` is always installed: it is the base layer, and Cursor reads
// `.claude/agents`, `.claude/skills` and the hooks in `.claude/settings.json`
// natively. The per-CLI layer only fills what that CLI cannot read from there.
const CLIS = ["claude", "codex", "cursor", "gemini", "qwen", "copilot", "droid", "windsurf", "devin", "kiro",
  "antigravity", "cline", "goose", "codewhale", "opencode", "pi", "hermes", "amp"];

// What is already installed — so re-running without --cli refreshes every CLI
// layer instead of silently leaving a stale one behind.
function installedClis(P) {
  const out = [];
  if (existsSync(join(P, ".codex/agents/orchestrator.toml"))) out.push("codex");
  try { if (read(join(P, ".cursor/hooks.json")).includes("--guard cursor")) out.push("cursor"); } catch {}
  try { out.push(...Object.keys(JSON.parse(read(join(P, GUARDS))))); } catch {}
  return out;
}

// A command file → a skill. Codex deprecated repo-less custom prompts in favour
// of skills; Cursor invokes skills with `/`. Generated from the INSTALLED
// command (start-task.md is the user's, kept across upgrades), so one source.
function commandAsSkill(P, name) {
  const src = read(join(P, ".claude/commands", `${name}.md`));
  const m = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(src);
  const desc = (m ? /^description:\s*(.*)$/m.exec(m[1])?.[1] : null) ?? name;
  const body = (m ? m[2] : src)
    .replaceAll("$ARGUMENTS", "the task URL or id the user gave")
    // one level deeper than .claude/commands/
    .replaceAll("](../../", "](../../../");
  const d = join(P, ".agents/skills", name);
  mkdirSync(d, { recursive: true });
  writeFileSync(join(d, "SKILL.md"), `---\nname: ${name}\ndescription: ${JSON.stringify(desc)}\n---\n${body}`);
}

// JSON string literals are valid TOML basic strings (same escapes), so
// JSON.stringify is a correct TOML string emitter — no TOML dependency.
const toml = (v) => JSON.stringify(v);

function installCodex(P, keep) {
  mkdirSync(join(P, ".codex/agents"), { recursive: true });
  for (const f of readdirSync(join(SRC, "agents")).filter((n) => n.endsWith(".md"))) {
    const src = read(join(SRC, "agents", f));
    const name = /^name:\s*(.+)$/m.exec(src)[1].trim();
    const desc = JSON.parse(/^description:\s*(.+)$/m.exec(src)[1].trim());
    const body = src.replace(/^---\n[\s\S]*?\n---\n/, "");
    writeFileSync(join(P, ".codex/agents", `${name}.toml`),
      `# spec-harness role — generated by install.mjs, overwritten on upgrade.\n` +
      `name = ${toml(name)}\ndescription = ${toml(desc)}\ndeveloper_instructions = ${toml(body)}\n`);
  }
  // PreToolUse(Bash) = the deny-list; Codex has no Read tool, it reads files
  // through the shell, so `cat .env` is covered by Bash(cat .env:*).
  // Git root, not a relative path: Codex may start in a subdirectory.
  // ponytail: POSIX-shell commands only; Windows needs `commandWindows`.
  const hooksPath = join(P, ".codex/hooks.json");
  if (!existsSync(hooksPath))
    writeFileSync(hooksPath, JSON.stringify({
      description: "spec-harness: deny-list guard + paste-a-task-link routing. Trust these in /hooks.",
      hooks: {
        PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command",
          command: 'node "$(git rev-parse --show-toplevel)/scripts/validate-tasks.mjs" --guard codex',
          statusMessage: "spec-harness guard" }] }],
        UserPromptSubmit: [{ hooks: [{ type: "command",
          command: '"$(git rev-parse --show-toplevel)/hooks/prompt-submit"' }] }],
      },
    }, null, 2) + "\n");
  else keep(null, hooksPath);
  // MCP: Codex reads config.toml, not .mcp.json. Generated from the project's
  // .mcp.json (already filled in by then on a re-install), kept once written.
  const cfgPath = join(P, ".codex/config.toml");
  if (existsSync(cfgPath)) keep(null, cfgPath);
  else {
    let servers = {};
    try { servers = JSON.parse(read(join(P, ".mcp.json"))).mcpServers ?? {}; } catch {}
    let t = "# spec-harness: MCP servers mirrored from .mcp.json — edit here for Codex.\n";
    for (const [k, v] of Object.entries(servers)) {
      t += `\n[mcp_servers.${toml(k)}]\n`;
      if (v.url) t += `url = ${toml(v.url)}\n`;
      if (v.command) t += `command = ${toml(v.command)}\n`;
      if (v.args) t += `args = ${JSON.stringify(v.args)}\n`;
    }
    writeFileSync(cfgPath, t);
  }
}

function installCursor(P, keep) {
  mkdirSync(join(P, ".cursor"), { recursive: true });
  // Cursor does not apply `.claude/settings.json → permissions.deny`, so the
  // deny-list is re-armed as permission hooks. Project hooks run from the
  // project root, so a relative path is correct here.
  const hooksPath = join(P, ".cursor/hooks.json");
  const guard = { command: "node scripts/validate-tasks.mjs --guard cursor" };
  if (!existsSync(hooksPath))
    writeFileSync(hooksPath, JSON.stringify({ version: 1, hooks: {
      beforeShellExecution: [guard], beforeReadFile: [guard] } }, null, 2) + "\n");
  else keep(null, hooksPath);
  keep(join(P, ".mcp.json"), join(P, ".cursor/mcp.json"));
}

// One entry per hook-capable CLI. `json` is deep-merged into a possibly shared
// file (settings.json that also holds the user's own config); `text` is a file
// we own. Every command runs `--guard <cli>` — that string is also how
// installedClis and preflight recognise the layer, so it must stay literal.
// cwd per CLI: gemini/qwen/droid export the project dir; copilot, windsurf,
// kiro run hooks from the workspace root (relative path); antigravity from .agents/;
// cline/goose/opencode/pi locate the script from their own file.
const V = "scripts/validate-tasks.mjs", g = (cli) => `${V} --guard ${cli}`;
// cli → hook file (null = no project hook). preflight reads THIS, so the
// adapter table lives in one place and a deleted hook file is still noticed.
const GUARDS = ".agents/spec-harness-guards.json";
const ADAPTERS = {
  gemini: { file: ".gemini/settings.json", roles: ".gemini/agents", json: {
    context: { fileName: ["AGENTS.md", "GEMINI.md"] },
    hooks: { BeforeTool: [{ matcher: "run_shell_command|read_file", hooks: [{ type: "command", name: "spec-harness-guard",
      command: `node "$GEMINI_PROJECT_DIR/${V}" --guard gemini` }] }] } } },
  qwen: { file: ".qwen/settings.json", roles: ".qwen/agents", json: {
    context: { fileName: ["AGENTS.md", "QWEN.md"] },
    hooks: { PreToolUse: [{ matcher: "run_shell_command|read_file", hooks: [{ type: "command", name: "spec-harness-guard",
      command: `node "$QWEN_PROJECT_DIR/${V}" --guard qwen` }] }] } } },
  // Copilot fails CLOSED on a crashed hook: no `git rev-parse` that dies outside a repo.
  copilot: { file: ".github/hooks/spec-harness.json", json: { version: 1, hooks: { preToolUse: [
    { type: "command", bash: `node ${g("copilot")}`, powershell: `node ${g("copilot")}`, timeoutSec: 30 }] } } },
  droid: { file: ".factory/hooks.json", roles: ".factory/droids", json: { PreToolUse: [{ matcher: "Execute|Read",
    hooks: [{ type: "command", command: `node "$FACTORY_PROJECT_DIR"/${g("droid")}`, timeout: 30 }] }] } },
  // #47: Devin Desktop (ex-Windsurf) reads .devin/hooks.json and falls back to
  // .windsurf/hooks.json ONLY when the new file is absent or empty — a user's own
  // .devin/hooks.json would silently drop a guard that lives only in the legacy one.
  windsurf: { file: ".devin/hooks.json", legacy: ".windsurf/hooks.json", json: { hooks: {
    pre_run_command: [{ command: `node ${g("windsurf")}`, show_output: true }],
    pre_read_code: [{ command: `node ${g("windsurf")}`, show_output: true }] } } },
  // Devin CLI (Windsurf's successor) ignores .windsurf/hooks.json; this is the shape
  // `devin migrate hooks` itself emits (devin 3000.10.27), Claude-style exit 2 = deny.
  devin: { file: ".devin/hooks.v1.json", json: { PreToolUse: [{ matcher: "^(exec|read|notebook_read)$",
    hooks: [{ type: "command", command: `node ${g("devin")}`, timeout: 30 }] }] } },
  // ponytail: Kiro tool names are undocumented, so no matcher — the guard sees every tool.
  kiro: { file: ".kiro/hooks/spec-harness.json", json: { version: "v1", hooks: [{ name: "spec-harness-guard",
    trigger: "PreToolUse", action: { type: "command", command: `node ${g("kiro")}` }, timeout: 30 }] } },
  antigravity: { file: ".agents/hooks.json", json: { "spec-harness-guard": { PreToolUse: [{ matcher: "run_command|view_file",
    hooks: [{ type: "command", command: `node ../${V} --guard antigravity`, timeout: 30 }] }] } } },
  cline: { file: ".clinerules/hooks/PreToolUse", exec: true,
    text: `#!/bin/sh\n# spec-harness deny-list guard. Enable hooks in Cline settings.\nexec node "$(dirname "$0")/../../${V}" --guard cline\n` },
  goose: { file: ".agents/plugins/spec-harness/hooks/hooks.json", json: { hooks: { PreToolUse: [{ matcher: "shell|developer__shell",
    hooks: [{ type: "command", command: `node "\${PLUGIN_ROOT}/../../../${V}" --guard goose` }] }] } },
    also: [[".agents/plugins/spec-harness/plugin.json", JSON.stringify({ name: "spec-harness", version: "1.0.0",
      description: "spec-harness deny-list guard (git push / reset --hard / .env)" }, null, 2) + "\n"]] },
  opencode: { file: ".opencode/plugins/spec-harness.js", own: true, text: pluginSrc("opencode") },
  pi: { file: ".pi/extensions/spec-harness.js", own: true, text: pluginSrc("pi") },
};

// OpenCode and pi take an in-process JS plugin, not a command: the plugin
// spawns the SAME guard so there is still one deny list.
function pluginSrc(cli) {
  const run = `const r = spawnSync("node", [fileURLToPath(new URL("../../scripts/validate-tasks.mjs", import.meta.url)), "--guard", "${cli}"],
      { input: JSON.stringify(payload), encoding: "utf8" });`;
  // The literal `--guard <cli>` line is how preflight recognises the layer.
  const head = `// spec-harness deny-list guard (validate-tasks.mjs --guard ${cli}) — generated by install.mjs.\n` +
    `import { spawnSync } from "node:child_process";\nimport { fileURLToPath } from "node:url";\n`;
  return cli === "pi"
    ? head + `export default function (pi) {\n  pi.on("tool_call", (event, ctx) => {\n    const payload = { tool_input: event.input, cwd: ctx.cwd };\n    ${run}\n` +
      `    if (r.status === 2) return { block: true, reason: r.stderr.trim() };\n  });\n}\n`
    : head + `export const SpecHarness = async () => ({\n  "tool.execute.before": async (input, output) => {\n    const payload = { tool_input: output.args };\n    ${run}\n` +
      `    if (r.status === 2) throw new Error(r.stderr.trim());\n  },\n});\n`;
}

// Shared config files hold the user's own settings: merge, never replace.
// Already wired (flag present) = leave it exactly as the user left it.
function mergeJson(p, ours, flag, keep) {
  if (!existsSync(p)) { mkdirSync(dirname(p), { recursive: true }); return writeFileSync(p, JSON.stringify(ours, null, 2) + "\n"); }
  const t = read(p);
  if (t.includes(flag)) return keep(null, p);
  let cur; try { cur = JSON.parse(t); } catch { return console.warn(`⚠️  ${p} không phải JSON hợp lệ — không đụng, tự thêm guard ${flag}`); }
  const deep = (a, b) => {
    // Gemini/Qwen accept context.fileName as a string OR a list.
    if (typeof a === "string" && Array.isArray(b)) a = [a];
    if (Array.isArray(a) && Array.isArray(b)) return [...a, ...b.filter((x) => !a.some((y) => JSON.stringify(y) === JSON.stringify(x)))];
    if (a && b && typeof a === "object" && typeof b === "object" && !Array.isArray(a) && !Array.isArray(b)) {
      const o = { ...a }; for (const k of Object.keys(b)) o[k] = k in a ? deep(a[k], b[k]) : b[k]; return o;
    }
    return a; // the user's scalar wins
  };
  writeFileSync(p, JSON.stringify(deep(cur, ours), null, 2) + "\n");
}

function installAdapter(P, cli, keep) {
  const a = ADAPTERS[cli], p = join(P, a.file), flag = `--guard ${cli}`;
  if (a.json) mergeJson(p, a.json, flag, keep);
  if (a.legacy) mergeJson(join(P, a.legacy), a.json, flag, keep);
  else if (a.own || !existsSync(p)) { mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, a.text); if (a.exec) chmodSync(p, 0o755); }
  else if (!read(p).includes(flag)) console.warn(`⚠️  ${a.file} đã có sẵn, không đè — tự thêm guard:\n${a.text}`);
  else keep(null, p);
  for (const [f, t] of a.also ?? []) writeFileSync(join(P, f), t);
  // Role files only where the format IS Claude's (name/description frontmatter + body).
  // `hooks:` is Claude-only frontmatter (#53) — another CLI may reject the unknown
  // key or, worse, run a hook whose payload the guard does not understand.
  if (a.roles) {
    mkdirSync(join(P, a.roles), { recursive: true });
    for (const f of readdirSync(join(SRC, "agents")).filter((n) => n.endsWith(".md")))
      writeFileSync(join(P, a.roles, f), read(join(SRC, "agents", f)).replace(/^hooks:\n(?:[ \t]+.*\n)+/m, ""));
  }
}

// #60: a subagent's model is a file field on every CLI that has subagents, so its
// base tier (the normal column of baseTier) is rendered into each CLI's own role
// files from models.<cli>. The coordinator's model only on Claude: the one CLI with
// a per-command `model` field — and it lasts for the current turn only.
// ponytail: the retry cascade reaches only CLIs whose dispatch takes a model
// parameter (Claude's Agent tool); elsewhere a retry reruns the rendered base tier.
// Upgrade path: one role file per tier, once a CLI's dispatch is shown to pick by name.
function renderModels(P, clis) {
  let cfg; try { cfg = JSON.parse(read(join(P, "harness.config.json"))); } catch { return; }
  const entry = (cli, tier) => { const e = cfg.models?.[cli]?.[tier]; return e && typeof e === "object" && e.model ? e : null; };
  const pick = (cli, tier) => entry(cli, tier)?.model ?? null;
  // One `model:` line (+ `effort:` for Claude) in the frontmatter; role files are
  // re-copied each install, so only the command can hold an old `model:`.
  // effort is a documented Claude subagent field; gemini/qwen/droid get model only (#63).
  const setFm = (file, e, withEffort) => {
    const t = read(file), m = /^---\n([\s\S]*?)\n---\n/.exec(t);
    if (!m) return;
    const fm = m[1].split("\n").filter((l) => !/^model:/.test(l));
    const add = [`model: ${e.model}`, ...(withEffort && e.effort ? [`effort: ${e.effort}`] : [])];
    writeFileSync(file, `---\n${[...fm, ...add].join("\n")}\n---\n` + t.slice(m[0].length));
  };
  const dirs = { claude: ".claude/agents", ...Object.fromEntries(Object.entries(ADAPTERS).filter(([, a]) => a.roles).map(([c, a]) => [c, a.roles])) };
  for (const cli of ["claude", ...clis]) {
    for (const f of readdirSync(join(SRC, "agents")).filter((n) => n.endsWith(".md"))) {
      const role = f.slice(0, -3), e = entry(cli, cfg.baseTier?.[role]?.[1]);
      if (!e) continue;
      if (cli === "codex") {
        const p = join(P, ".codex/agents", `${role}.toml`);
        // installCodex rewrote this file just above, so there is no old model line to drop.
        const eff = e.effort ? `model_reasoning_effort = ${toml(e.effort)}\n` : "";
        if (existsSync(p)) writeFileSync(p, read(p).replace(/^(description = .*\n)/m, (d) => `${d}model = ${toml(e.model)}\n${eff}`));
      } else if (dirs[cli] && existsSync(join(P, dirs[cli], f))) setFm(join(P, dirs[cli], f), e, cli === "claude");
    }
  }
  const coord = entry("claude", cfg.coordinatorTier), cmd = join(P, ".claude/commands/start-task.md");
  if (coord && existsSync(cmd)) setFm(cmd, coord, false); // effort in command frontmatter is undocumented
  if (clis.some((c) => c !== "claude"))
    console.log(`ℹ coordinator (/start-task) chạy model của session trên CLI không phải Claude — mở session bằng model hạng "${cfg.coordinatorTier}"`);
}

// R1b (#60): lines of `text` naming a vendor model. A fenced block right after an
// `<!-- example -->` line is exempt — docs may SHOW a config, not ship one.
function vendorLeaks(text, tokens) {
  const re = new RegExp(`(?<![\\w-])(?:${tokens.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})`, "i");
  const out = [];
  let armed = false, exempt = false;
  text.split("\n").forEach((l, i) => {
    if (/^\s*```/.test(l)) { if (exempt) { exempt = false; return; } if (armed) { exempt = true; armed = false; return; } }
    armed = /<!--\s*example\s*-->/.test(l) || (armed && !l.trim());
    if (!exempt && re.test(l)) out.push(i + 1);
  });
  return out;
}

function installAgentsLayer(P, keep) {
  // Codex reads skills only from .agents/skills. Cursor also reads it, so the
  // two command-skills live here for both.
  // ponytail: with Cursor, skills are visible twice (.claude/skills and
  // .agents/skills, same content). Split per CLI if Cursor ever complains.
  cpSync(join(SRC, "skills"), join(P, ".agents/skills"), { recursive: true });
  for (const c of ["start-task", "init-project-rules"]) commandAsSkill(P, c);
  keep(join(SRC, "adapters/AGENTS.template.md"), join(P, "AGENTS.md"));
}

function installInto(P, clis = []) {
  // Nguồn thiếu folder = bản phát hành hỏng (package.json `files:` quên khai,
  // hoặc tarball cắt sai). Không bắt sớm thì lỗi rơi ra dưới dạng stack trace
  // ENOENT của cpSync — đúng nguyên nhân nhưng không ai đọc ra là lỗi đóng gói.
  for (const d of ["kernel", "agents", "skills", "adapters", "commands", "hooks"])
    if (!existsSync(join(SRC, d)))
      die(`✖ nguồn thiếu "${d}/" — bản phát hành hỏng (package.json files: thiếu mục?), không cài nửa vời`);

  // Chụp TRƯỚC khi ghi bất cứ gì: rỗng = harness đứng riêng (bố cục B).
  // `.git` không tính — README khuyến nghị `git init` cho bố cục đó.
  const wasEmpty = readdirSync(P).filter((n) => n !== ".git").length === 0;

  const kept = [];
  // Copy chỉ khi đích chưa có. Đây là thứ giữ adapter sống qua lần cài lại.
  const keep = (src, dst) => existsSync(dst) ? kept.push(dst) : cpSync(src, dst);

  for (const d of ["docs", "scripts", "hooks", ".claude/agents", ".claude/commands", ".claude/skills"])
    mkdirSync(join(P, d), { recursive: true });

  // Bố cục A cài ĐÈ LÊN repo code đang có, nên kernel có thể trùng tên với file
  // của project: `docs/README.md` là ca thường gặp nhất, `scripts/` và
  // `hooks/pre-commit` cũng có. Kernel vẫn phải đè (nâng phiên bản mà giữ bản cũ
  // là hỏng kiểu khó tìm hơn), nhưng đè trong im lặng thì user chỉ phát hiện lúc
  // `git diff` — hoặc không bao giờ. Nên: ghi nhận rồi báo, chỉ file đã tồn tại
  // và thực sự khác nội dung.
  const clobbered = [];
  const over = (src, dst) => {
    try { if (existsSync(dst) && read(src) !== read(dst)) clobbered.push(dst.slice(P.length + 1)); } catch {}
    cpSync(src, dst);
  };

  // kernel — luôn ghi đè, đây là phần dùng chung
  for (const f of readdirSync(join(SRC, "kernel/docs"), { withFileTypes: true })) {
    if (f.isFile()) over(join(SRC, "kernel/docs", f.name), join(P, "docs", f.name));
    else cpSync(join(SRC, "kernel/docs", f.name), join(P, "docs", f.name), { recursive: true });
  }
  for (const f of ["validate-tasks.mjs", "lease.mjs", "run-evidence.mjs", "collect-telemetry.mjs"])
    over(join(SRC, "kernel/scripts", f), join(P, "scripts", f));
  for (const f of readdirSync(join(SRC, "agents")).filter((n) => n.endsWith(".md")))
    cpSync(join(SRC, "agents", f), join(P, ".claude/agents", f));
  over(join(SRC, "hooks/pre-commit"), join(P, "hooks/pre-commit"));
  try { chmodSync(join(P, "hooks/pre-commit"), 0o755); } catch {}
  // Hook CLI-specific: dán link task → chèn một dòng context. Nằm ở adapters/
  // vì `UserPromptSubmit` là API của MỘT CLI; CLI khác không bao giờ gọi tới.
  // Vẫn `over` như pre-commit: đây là kernel logic mỏng, không phải adapter của
  // user — phần user chỉnh là khối `hooks` trong settings.json (giữ bằng keep).
  over(join(SRC, "adapters/claude-code/prompt-submit"), join(P, "hooks/prompt-submit"));
  try { chmodSync(join(P, "hooks/prompt-submit"), 0o755); } catch {}
  // skill fsd-writer gọi ở Gate 1 — thiếu nó thì stage fsd_write gọi hụt
  cpSync(join(SRC, "skills"), join(P, ".claude/skills"), { recursive: true });

  // adapter + command — của user, không đè
  keep(join(SRC, "adapters/example/.mcp.json"), join(P, ".mcp.json"));
  // Guardrail tầng permission. Instructions.md §1 cấm push/reset --hard/stash
  // bằng văn bản; văn bản là thứ model chọn tuân thủ, deny thì không.
  keep(join(SRC, "adapters/example/settings.json"), join(P, ".claude/settings.json"));
  keep(join(SRC, "adapters/example/harness.config.json"), join(P, "harness.config.json"));
  keep(join(SRC, "adapters/ProjectRules.template.md"), join(P, "docs/agents/ProjectRules.md"));
  keep(join(SRC, "commands/start-task.md"), join(P, ".claude/commands/start-task.md"));
  cpSync(join(SRC, "commands/init-project-rules.md"), join(P, ".claude/commands/init-project-rules.md"));

  // CI: hook ở máy dev bypass được bằng --no-verify. Workflow thì không.
  //
  // Cài theo remote, không cài cả hai: một .github/workflows/ nằm trong repo
  // GitLab là lưới GIẢ — preflight thấy file nên im lặng, còn CI thì không
  // bao giờ chạy nó. Không đọc được remote thì mặc định GitHub và nói ra.
  const remote = spawnSync("git", ["remote", "get-url", "origin"], { cwd: P, encoding: "utf8" });
  const isGitlab = remote.status === 0 && /gitlab/i.test(remote.stdout);
  if (isGitlab) {
    keep(join(SRC, "adapters/ci/.gitlab-ci.yml"), join(P, ".gitlab-ci.yml"));
  } else {
    mkdirSync(join(P, ".github/workflows"), { recursive: true });
    keep(join(SRC, "adapters/ci/validate-tasks.yml"), join(P, ".github/workflows/spec-harness.yml"));
    if (remote.status !== 0)
      console.log("ℹ chưa có remote origin — cài CI cho GitHub. Repo GitLab thì: cp adapters/ci/.gitlab-ci.yml .");
  }

  // Dấu phiên bản. Installer ghi ĐÈ mọi lần, nên nếu không ghi lại số thì sau
  // khi nâng kernel không ai biết project đang chạy bản nào: không debug được
  // "gate này hồi trước đâu có chặn", không rollback được về đúng bản.
  const ver = kernelVersion();
  if (ver)
    writeFileSync(join(P, "docs/.kernel-version"),
      `${ver}\n# spec-harness kernel đã cài. Do install.mjs ghi, đừng sửa tay.\n# Nâng: chạy lại installer. So sánh: npm view spec-harness version\n`);

  // CLI layers, after .mcp.json and the commands exist (both are read above).
  const want = [...new Set([...clis, ...installedClis(P)])];
  if (want.some((c) => c !== "claude")) installAgentsLayer(P, keep);
  if (want.includes("codex")) installCodex(P, keep);
  if (want.includes("cursor")) installCursor(P, keep);
  for (const c of want) if (ADAPTERS[c]) installAdapter(P, c, keep);
  const layers = want.filter((c) => ADAPTERS[c] || ["hermes", "amp", "codewhale"].includes(c));
  if (layers.length) writeFileSync(join(P, GUARDS),
    JSON.stringify(Object.fromEntries(layers.map((c) => [c, ADAPTERS[c]?.file ?? null])), null, 2) + "\n");

  renderModels(P, want);
  const hookSkipped = installHook(P);
  const signpost = installSignpost(P, wasEmpty);

  execFileSync(process.execPath, ["scripts/validate-tasks.mjs", "--self-check"], { cwd: P, stdio: "inherit" });
  return { kept, hookSkipped, signpost, clobbered, clis: want };
}

// Bố cục B (harness/ đứng cạnh fe/ be/): CLI chỉ đọc .claude/ ở cwd và các thư
// mục CHA, không quét xuống con. Mở CLI ở my-workspace/ thì harness/.claude/
// vô hình — mất skills, mất /start-task, và (nguy hiểm nhất) mất deny
// git push/reset --hard trong settings.json. `--add-dir harness` KHÔNG cứu
// được: nó nạp skills + commands nhưng BỎ QUA settings.json, tức là chạy có vẻ
// bình thường trong khi guardrail đã biến mất — im lặng, đúng kiểu hỏng tệ nhất.
// Nên đặt biển báo ở thư mục cha: CLAUDE.md ở cwd luôn được nạp, nên đây là chỗ
// duy nhất bắt được lỗi ĐÚNG LÚC nó xảy ra.
// Trả về đường dẫn đã ghi, hoặc null nếu bỏ qua.
function installSignpost(P, wasEmpty) {
  const parent = dirname(P);
  const stale = join(parent, "CLAUDE.md");

  // Cha đã có .claude (user cố ý symlink sang harness/ để mở CLI ở đó) → mở ở
  // cha là ĐÚNG, biển báo thành báo động giả. Xoá bản cũ của chính mình, đừng
  // để nâng kernel giữ lại cảnh báo sai giữa bố cục đang chạy đúng.
  if (existsSync(join(parent, ".claude"))) {
    try { if (read(stale).includes("spec-harness cài ở")) unlinkSync(stale); } catch {}
    return null;
  }
  // Chỉ bố cục B mới cần biển báo. Nhận diện: đích RỖNG trước khi cài — bố cục B
  // là `mkdir harness && cd harness`, bố cục A là repo code đã đầy file.
  // KHÔNG dùng `.git` (README khuyến nghị `git init` cho cả B → không phân biệt
  // được), cũng KHÔNG dùng `repos` (lúc cài nó còn là template `path: "."`).
  // Cài lại thì đích không còn rỗng → không tái tạo, nhưng cũng không xoá nhầm
  // biển báo đang đúng.
  if (!wasEmpty) return null;
  if (existsSync(stale)) return null; // của user, không đè
  const f = stale;
  const here = P.slice(parent.length + 1);
  writeFileSync(f, `# Sai thư mục

spec-harness cài ở \`${here}/\`, không phải ở đây.

\`.claude/\` của nó nằm trong \`${here}/\` — CLI không quét xuống thư mục con,
nên mở ở đây là mất skills, mất \`/start-task\`, và mất cả guardrail deny
\`git push\` / \`git reset --hard\` trong settings.json.

**Thoát và mở lại ở đúng chỗ:**

\`\`\`bash
cd ${here}
claude
\`\`\`

Từ trong đó vẫn sửa được repo anh em: \`/add-dir ../fe ../be\`.

Đừng dùng \`--add-dir ${here}\` từ đây: nó nạp skills và commands nhưng BỎ QUA
settings.json, nên guardrail biến mất trong im lặng.
`);
  return f;
}

// ── self-test ──────────────────────────────────────────────────────────────
const args = process.argv.slice(2);

// ── --eval: đo chính lớp LLM, không chỉ validator (#52) ──────────────────────────
// Validator chỉ chấm HÌNH 09 (có verdict, có lệnh tự chạy). Nó không thể biết
// adversary có TÌM RA bug không — câu đó chỉ trả lời được bằng task có bug
// cài sẵn và đáp án biết trước. Mỗi case: sandbox cài sạch, task ở stage
// adversarial_review với 08 do run-evidence.mjs thật ký, rồi gọi --agent.
//   node install.mjs --eval --agent 'claude -p --model sonnet --agent adversary --permission-mode bypassPermissions --strict-mcp-config'
// --strict-mcp-config: eval đầu tiên chết vì 105 tool MCP user-level làm tràn
// context — đo máy người chạy chứ không đo harness. ponytail: hook user-level
// vẫn chạy (--setting-sources bỏ chúng thì mất luôn login); máy "sạch" thật cần
// một CLAUDE_CONFIG_DIR riêng đã login, thêm khi eval chạy trên máy CI.
// Prompt đi qua stdin, cwd = sandbox. Tốn tiền model → chạy trước release,
// không chạy trong CI.
const EVAL = join(SRC, "kernel/eval/adversary");
const EVAL_PROMPT = (task) =>
  `You are the \`adversary\` subagent (stage adversarial_review, Gate 5) for the task in \`${task}\`.\n` +
  `First run \`node scripts/validate-tasks.mjs --pack ${task} adversarial_review --base main\` and read its output once: it bundles \`docs/Instructions.md\`, SharedRules §4 §5 §6 §8 §9, \`docs/agents/Adversary.md\`, ProjectRules, the output contract, the task artifacts, the last handoff and the unfiltered git file list. Do not open those files again. ` +
  "Obey the artifact size caps in SharedRules §8. Work only inside the task folder. Write `09-Adversarial-Review.md` in the task folder, " +
  `append your \`## Next Handoff\` block to \`${task}/.agent-memory/adversary.md\`, update \`${task}/task.agent.json\`. ` +
  "Remind: default FAIL, re-run the ProjectRules §7 commands yourself instead of trusting `08`, do not touch `src/`. " +
  "End your final message with: gate verdict (PASS/FAIL), status set, and the one-line reason.\n";

function evalCases() {
  const j = JSON.parse(read(join(EVAL, "cases.json")));
  return j.cases;
}

// Case → sandbox repo ở đúng điểm bàn giao cho adversary. Tên case KHÔNG đi vào
// sandbox (tên thư mục, branch, commit message đều trung tính) — "out-of-scope"
// nằm trong path là đưa đáp án cho model.
// Repo đã cài harness + điền ProjectRules/config, commit "base" — trước task đầu.
function buildBase(root) {
  const P = join(root, "shop");
  mkdirSync(P, { recursive: true });
  const git = (...a) => {
    const r = spawnSync("git", ["-c", "user.email=eval@x", "-c", "user.name=eval", ...a], { cwd: P, encoding: "utf8" });
    if (r.status !== 0) die(`✖ eval: git ${a.join(" ")}: ${r.stderr}`);
    return r.stdout.trim();
  };
  git("init", "-q", "-b", "main");
  cpSync(join(EVAL, "main"), P, { recursive: true });
  const quiet = console.log; console.log = () => {};
  try { installInto(P); } finally { console.log = quiet; }
  // ProjectRules §7 + config: thứ một repo thật đã điền xong trước task đầu tiên.
  const cfg = JSON.parse(read(join(P, "harness.config.json")));
  cfg.repos = [{ name: "shop", path: ".", layer: cfg.layers[0] }];
  cfg.tracker.urlPattern = "^https://tracker\\.example/t/.+";
  writeFileSync(join(P, "harness.config.json"), JSON.stringify(cfg, null, 2) + "\n");
  const pr = join(P, "docs/agents/ProjectRules.md");
  writeFileSync(pr, read(pr)
    .replace("| `<path-scoped unit test command>` |", "| `npm run test:scope` |")
    .replace(/\| `<whole-repo unit test command>` \|.*\n\| `<type-check command>` \|.*\n\| `<lint command>` \|.*\n\| `<build command>` \|.*\n/, "")
    .replace("`<dev server, test watch, preview…>`", "none")
    .replace("`<browser | api | cli | none>`", "`cli` (call the exported function)")
    .replace("`<path, e.g. e2e/ or test/integration/>`", "none"));
  git("add", "-A"); git("commit", "--no-verify", "-qm", "base");
  return { P, git };
}

function buildEvalCase(c, root) {
  const { P, git } = buildBase(root);
  const put = (files) => { for (const [f, s] of Object.entries(files ?? {})) { if (s === null) { rmSync(join(P, f)); continue; } mkdirSync(dirname(join(P, f)), { recursive: true }); writeFileSync(join(P, f), s); } };
  const base = git("rev-parse", "--short", "HEAD");

  // step 0 thật: _triage.log là thứ validator đối chiếu vector bootstrap
  const vec = JSON.parse(read(join(EVAL, "task/task.agent.json"))).complexity.vector;
  spawnSync(process.execPath, ["scripts/validate-tasks.mjs", "--triage", JSON.stringify(vec), "--branch-type", "feature", "--task-id", "SHOP-7"], { cwd: P, stdio: "ignore" });
  git("switch", "-qc", "feature/SHOP-7-discount");
  cpSync(join(EVAL, "feature"), P, { recursive: true });
  put(c.feature);
  const T = "docs/tasks/sprint-1/SHOP-7-discount";
  const t = join(P, T);
  cpSync(join(EVAL, "task"), t, { recursive: true });
  cpSync(join(P, "docs/tasks/_templates/task.agent.schema.json"), join(t, "task.agent.schema.json"));
  const dev = c.deviation ?? "None — the diff matches the 03 file list.";
  writeFileSync(join(t, "06-Implementation-Notes.md"), read(join(t, "06-Implementation-Notes.md")).replace("{deviation}", dev).replace("{base}", base));
  git("add", "-A"); git("commit", "--no-verify", "-qm", "SHOP-7 discount");
  // 08 do wrapper thật ký trên đúng code đã commit — không dán tay.
  const ev = spawnSync(process.execPath, ["scripts/run-evidence.mjs", "--append", `${T}/08-Test-Evidence.md`, "--", "npm", "run", "test:scope"], { cwd: P, encoding: "utf8" });
  if (ev.status !== 0) die(`✖ eval: evidence run failed on the base fixture:\n${ev.stdout}${ev.stderr}`);
  git("add", "-A"); git("commit", "--no-verify", "-qm", "SHOP-7 evidence");
  if (c.afterEvidence) { put(c.afterEvidence); git("add", "-A"); git("commit", "--no-verify", "-qm", "SHOP-7 tidy"); }
  return { P, T };
}

// #72: fixture chia slice — SHOP-8, 10 file (S1: 4 module + test, S2: checkout
// + test), dừng ở implementation. Đo lợi ích thật của slice: --bench --stage
// implementation chạy mỗi slice 1 lần agent (--unsliced: 1 lần cho cả plan, 03
// bỏ cột Slice) và so peak context của turn lớn nhất.
const SLICED = join(SRC, "kernel/eval/sliced");
function buildSlicedCase(root, { unsliced = false } = {}) {
  const { P, git } = buildBase(root);
  const vec = JSON.parse(read(join(SLICED, "task/task.agent.json"))).complexity.vector;
  spawnSync(process.execPath, ["scripts/validate-tasks.mjs", "--triage", JSON.stringify(vec), "--branch-type", "feature", "--task-id", "SHOP-8"], { cwd: P, stdio: "ignore" });
  git("switch", "-qc", "feature/SHOP-8-cart");
  const T = "docs/tasks/sprint-1/SHOP-8-cart", t = join(P, T);
  cpSync(join(SLICED, "task"), t, { recursive: true });
  cpSync(join(P, "docs/tasks/_templates/task.agent.schema.json"), join(t, "task.agent.schema.json"));
  if (unsliced) {
    // Cả plan một context: bỏ cột Slice và nâng sliceFiles lên để validator không đòi slice.
    const pl = join(t, "03-Technical-Plan.md");
    writeFileSync(pl, read(pl).replace(/ Slice \|\n/, "\n").replace(/ --- \| --- \| --- \| --- \| --- \|/, " --- | --- | --- | --- |").replace(/ S\d+ \|\n/g, "\n"));
    const cp = join(P, "harness.config.json"), cfg = JSON.parse(read(cp));
    writeFileSync(cp, JSON.stringify({ ...cfg, sliceFiles: 99 }, null, 2) + "\n");
  }
  git("add", "-A"); git("commit", "--no-verify", "-qm", "SHOP-8 plan");
  spawnSync(process.execPath, ["scripts/lease.mjs", "acquire", T], { cwd: P });
  return { P, T };
}
const IMPL_PROMPT = (task, slice) =>
  `You are the \`implementer\` subagent (stage implementation, Gate 4) for the task in \`${task}\`${slice ? `, building slice ${slice} only` : ""}.\n` +
  `First run \`node scripts/validate-tasks.mjs --pack ${task} implementation${slice ? ` --slice ${slice}` : ""}\` and read its output once. Do not open those files again, and do not read \`scripts/validate-tasks.mjs\`. ` +
  "Build the files in 03, run the ProjectRules §7 commands through `scripts/run-evidence.mjs --append` into 08, write/extend 06, append your `## Next Handoff` block, update task.agent.json. Do not stop to ask anything.\n";

// Verdict: `status` role đã set là thứ coordinator THẬT SỰ route theo (blocked =
// FAIL, reviewing = PASS) nên nó thắng. Chưa set (timeout, quên) → dòng
// Result/Verdict trong 09, trên chính dòng đó hoặc dòng không rỗng kế tiếp — eval
// thật cho thấy `## Verdict\n\n**Gate 5: FAIL.**`. Dòng template chưa điền không tính.
function verdictOf(nine, status) {
  if (status === "blocked") return "FAIL";
  if (status === "reviewing") return "PASS";
  const lines = (nine ?? "").split("\n").filter((l) => l.trim() && !/PASS \| FAIL/.test(l));
  for (let i = 0; i < lines.length; i++)
    if (/\b(?:Result|Verdict)\b/i.test(lines[i]))
      for (const l of [lines[i], lines[i + 1] ?? ""]) {
        const m = /\b(PASS|FAIL|UNCERTAIN)\b/.exec(l.replace(/^[^:]*\b(?:Result|Verdict)\b/i, ""));
        if (m) return m[1];
      }
  return null;
}
function scoreAdversary(c, nine, srcChanged, status) {
  const out = [];
  const got = verdictOf(nine, status);
  if (!got) out.push(nine == null ? "no 09 written" : "no verdict: status not set and no Result/Verdict line in 09");
  // UNCERTAIN trên một task có bug vẫn chặn merge → đếm là bắt được. Trên task
  // sạch thì không: một adversary luôn nói "không chắc" là một gate không ai qua.
  else if (c.expect === "PASS" ? got !== "PASS" : got === "PASS") out.push(`verdict ${got}, expected ${c.expect}`);
  if (got && got !== "PASS")
    for (const s of c.mustMention ?? []) if (!(nine ?? "").includes(s)) out.push(`09 does not mention "${s}"`);
  if (srcChanged.length) out.push(`role edited outside the task folder: ${srcChanged.join(", ")}`);
  return out;
}

if (args[0] === "--eval") {
  const at = args.indexOf("--agent"), cmd = at === -1 ? null : args[at + 1];
  const only = args.includes("--case") ? args[args.indexOf("--case") + 1] : null;
  const perCase = Number(args.includes("--timeout") ? args[args.indexOf("--timeout") + 1] : 1500) * 1000;
  const cases = evalCases().filter((c) => !only || c.id === only);
  if (!cmd || !cases.length) die("dùng: node install.mjs --eval --agent '<lệnh đọc prompt từ stdin>' [--case <id>] [--timeout <giây>] [--keep]");
  const rows = [];
  for (const c of cases) {
    const root = mkdtempSync(join(tmpdir(), "sh-eval-"));
    const { P, T } = buildEvalCase(c, root);
    const r = spawnSync(cmd, { cwd: P, shell: true, input: EVAL_PROMPT(T), encoding: "utf8", timeout: perCase, maxBuffer: 64 << 20 });
    const nineP = join(P, T, "09-Adversarial-Review.md");
    const nine = existsSync(nineP) ? read(nineP) : null;
    const changed = spawnSync("git", ["status", "--porcelain", "--untracked-files=all"], { cwd: P, encoding: "utf8" }).stdout
      .split("\n").filter(Boolean).map((l) => l.slice(3)).filter((f) => !f.startsWith(T + "/"));
    let status; try { status = JSON.parse(read(join(P, T, "task.agent.json"))).status; } catch {}
    // timeout vẫn chấm: 09 đã ghi thì verdict đã có, chỉ thiếu bước cập nhật trạng thái
    const defects = scoreAdversary(c, nine, changed, status);
    if (r.error) defects.push(`agent: ${r.error.code ?? r.error.message}`);
    writeFileSync(join(root, "agent.log"), `${r.stdout ?? ""}\n--- stderr ---\n${r.stderr ?? ""}`);
    rows.push({ id: c.id, expect: c.expect, ok: !defects.length, defects });
    console.log(`${defects.length ? "✖" : "✔"} ${c.id.padEnd(20)} expect ${c.expect.padEnd(4)} ${defects.join("; ")}`);
    if (args.includes("--keep")) console.log(`    sandbox: ${P}  (agent log: ../agent.log)`); else rmSync(root, { recursive: true, force: true });
  }
  const bad = rows.filter((r) => !r.ok).length;
  console.log(`\n${bad ? "✖" : "✅"} eval: ${rows.length - bad}/${rows.length} correct`);
  process.exit(bad ? 1 : 0);
}

// --bench (#59): thời gian/token của MỘT lần chạy thật, đọc từ stream-json của
// agent CLI — không phải wall clock (một lần chạy thật: 8.6h wall, 37' API, phần
// chênh là 503 retry). Thuần, để self-test chạy được trên fixture đóng hộp.
// ponytail: chỉ hiểu stream-json của Claude Code (event "result" + <usage> trong
// tool_result của subagent). CLI khác → "no result event", exit 1, không đoán số.
function benchStats(text) {
  const agents = new Map();
  let result = null, tools = 0, peak = 0;
  for (const l of text.split("\n")) {
    let e; try { e = JSON.parse(l.slice(l.indexOf("{"))); } catch { continue; }
    if (e.type === "result") result = e;
    // #72 peak: the biggest context one main-thread turn carried (subagent turns excluded).
    const u = e.type === "assistant" && !e.parent_tool_use_id && e.message?.usage;
    if (u) peak = Math.max(peak, (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0));
    for (const c of e.message?.content ?? []) {
      if (c.type === "tool_use") {
        tools++;
        if (c.name === "Agent" || c.name === "Task")
          agents.set(c.id, { type: c.input?.subagent_type ?? "?", model: c.input?.model ?? "" });
      }
      if (c.type === "tool_result" && agents.has(c.tool_use_id)) {
        const u = /<usage>([\s\S]*?)<\/usage>/.exec(JSON.stringify(c.content ?? "").replace(/\\n/g, "\n"));
        const n = (k) => Number(new RegExp(k + ":\\s*(\\d+)").exec(u?.[1] ?? "")?.[1] ?? NaN);
        Object.assign(agents.get(c.tool_use_id), { tokens: n("subagent_tokens"), tools: n("tool_uses"), ms: n("duration_ms") });
      }
    }
  }
  if (!result) return null;
  const models = Object.fromEntries(Object.entries(result.modelUsage ?? {}).map(([m, u]) => [m, {
    in: u.inputTokens, out: u.outputTokens, cacheRead: u.cacheReadInputTokens, cacheWrite: u.cacheCreationInputTokens,
    thinking: u.thinkingTokens ?? 0, cost: u.costUSD }]));
  return { apiMs: result.duration_api_ms, costUsd: result.total_cost_usd, turns: result.num_turns, tools, peak, models, agents: [...agents.values()] };
}

if (args[0] === "--bench") {
  const opt = (k, d) => (args.includes(k) ? args[args.indexOf(k) + 1] : d);
  const cmd = opt("--agent", null), stage = opt("--stage", "adversary"), runs = Number(opt("--runs", 1));
  const perRun = Number(opt("--timeout", 3600)) * 1000;
  const bench = JSON.parse(read(join(EVAL, "cases.json"))).benchTask;
  if (!cmd || !["adversary", "full", "implementation"].includes(stage) || !(runs >= 1))
    { console.error("dùng: node install.mjs --bench --agent '<lệnh in stream-json, đọc prompt từ stdin>' [--stage adversary|full|implementation [--unsliced]] [--runs n] [--timeout <giây>] [--keep]"); process.exit(2); }
  if (stage === "implementation") {
    // #72: một lần chạy = mọi slice nối tiếp (mỗi slice 1 agent mới, qua --advance thật);
    // --unsliced = 1 agent cho cả plan. peak = context lớn nhất của 1 turn — con số
    // slice sinh ra để hạ. Đúng khi mọi slice chạy xong và Gate 4 còn lại xanh.
    const unsliced = args.includes("--unsliced"), rowsI = [];
    for (let i = 0; i < runs; i++) {
      const root = mkdtempSync(join(tmpdir(), "sh-bench-"));
      const { P, T } = buildSlicedCase(root, { unsliced });
      const parts = [], log = [];
      for (const sl of unsliced ? [null] : ["S1", "S2"]) {
        const a = spawnSync(process.execPath, ["scripts/validate-tasks.mjs", "--advance", T, "implementation", ...(sl ? ["--slice", sl] : [])], { cwd: P, encoding: "utf8" });
        if (a.status !== 0) { log.push(`advance ${sl}: ${a.stderr}`); parts.push(null); break; }
        const r = spawnSync(cmd, { cwd: P, shell: true, input: IMPL_PROMPT(T, sl), encoding: "utf8", timeout: perRun, maxBuffer: 256 << 20 });
        log.push(`--- ${sl ?? "all"} ---\n${r.stdout ?? ""}\n--- stderr ---\n${r.stderr ?? ""}`);
        parts.push(benchStats(r.stdout ?? ""));
      }
      writeFileSync(join(root, "agent.log"), log.join("\n"));
      const ok = parts.every(Boolean) && parts.length === (unsliced ? 1 : 2);
      const sum = ok && { apiMs: parts.reduce((n, p) => n + p.apiMs, 0), costUsd: parts.reduce((n, p) => n + p.costUsd, 0), turns: parts.reduce((n, p) => n + p.turns, 0), peak: Math.max(...parts.map((p) => p.peak)) };
      rowsI.push(sum);
      if (!sum) console.log(`✖ run ${i + 1}: ${log.at(-1).slice(0, 300)}`);
      else console.log(`✔ run ${i + 1} ${unsliced ? "unsliced" : "sliced S1+S2"}: peak ${sum.peak} tok · api ${(sum.apiMs / 60000).toFixed(1)}' · $${sum.costUsd.toFixed(2)} · ${sum.turns} turns · per dispatch peak ${parts.map((p) => p.peak).join(" / ")}`);
      if (args.includes("--keep")) console.log(`    sandbox: ${P}  (agent log: ../agent.log)`); else rmSync(root, { recursive: true, force: true });
    }
    const okI = rowsI.filter(Boolean), medI = (k) => okI.map((r) => r[k]).sort((a, b) => a - b)[(okI.length - 1) >> 1];
    if (okI.length) console.log(`\nmedian of ${okI.length}: ` + JSON.stringify({ stage, unsliced, peak: medI("peak"), apiMs: medI("apiMs"), costUsd: medI("costUsd"), turns: medI("turns") }));
    process.exit(okI.length === rowsI.length ? 0 : 1);
  }
  const rows = [];
  for (let i = 0; i < runs; i++) {
    const root = mkdtempSync(join(tmpdir(), "sh-bench-"));
    let P, prompt;
    if (stage === "adversary") { const b = buildEvalCase(evalCases().find((c) => c.id === "clean"), root); P = b.P; prompt = EVAL_PROMPT(b.T); }
    else { P = buildBase(root).P; prompt = bench; }
    const r = spawnSync(cmd, { cwd: P, shell: true, input: prompt, encoding: "utf8", timeout: perRun, maxBuffer: 256 << 20 });
    writeFileSync(join(root, "agent.log"), `${r.stdout ?? ""}\n--- stderr ---\n${r.stderr ?? ""}`);
    const st = benchStats(r.stdout ?? "");
    rows.push(st);
    if (!st) console.log(`✖ run ${i + 1}: no result event — --bench reads Claude stream-json (--output-format stream-json --verbose)${r.error ? "; " + (r.error.code ?? r.error.message) : ""}`);
    else {
      console.log(`✔ run ${i + 1}: api ${(st.apiMs / 60000).toFixed(1)}' · $${st.costUsd.toFixed(2)} · ${st.turns} turns · ${st.tools} tool calls`);
      for (const [m, u] of Object.entries(st.models)) console.log(`    ${m.padEnd(34)} out ${u.out} (think ${u.thinking}) · cacheW ${u.cacheWrite} · $${u.cost.toFixed(2)}`);
      for (const a of st.agents) console.log(`    ▸ ${a.type.padEnd(18)} ${(a.model || "-").padEnd(7)} ${a.tokens} tok · ${a.tools} tools · ${(a.ms / 1000).toFixed(0)}s`);
    }
    if (args.includes("--keep")) console.log(`    sandbox: ${P}  (agent log: ../agent.log)`); else rmSync(root, { recursive: true, force: true });
  }
  const ok = rows.filter(Boolean);
  const med = (k) => { const v = ok.map((r) => r[k]).sort((a, b) => a - b); return v[(v.length - 1) >> 1]; };
  if (ok.length) console.log(`\nmedian of ${ok.length}: ` + JSON.stringify({ stage, apiMs: med("apiMs"), costUsd: med("costUsd"), turns: med("turns"), tools: med("tools") }));
  process.exit(ok.length === rows.length ? 0 : 1);
}

if (args[0] === "--self-test") {
  const fail = (m, extra) => { console.error(`✖ self-test: ${m}`); if (extra) console.error(extra); process.exit(1); };
  // --bench (#59): parser đọc đúng stream-json đóng hộp — số sai thì mọi so sánh trước/sau đều sai.
  {
    const ev = (o) => JSON.stringify(o);
    const canned = [
      "12:00:00 " + ev({ type: "assistant", message: { usage: { input_tokens: 10, cache_read_input_tokens: 900, cache_creation_input_tokens: 90 }, content: [{ type: "tool_use", id: "t1", name: "Agent", input: { subagent_type: "adversary", model: "mid" } }, { type: "tool_use", id: "t2", name: "Read", input: {} }] } }),
      ev({ type: "assistant", parent_tool_use_id: "t1", message: { usage: { input_tokens: 99999 }, content: [] } }),
      ev({ type: "assistant", message: { usage: { input_tokens: 5, cache_read_input_tokens: 400 }, content: [] } }),
      ev({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t1", content: [{ type: "text", text: "done\n<usage>subagent_tokens: 1200\ntool_uses: 7\nduration_ms: 9000</usage>" }] }] } }),
      "not json",
      ev({ type: "result", duration_api_ms: 60000, total_cost_usd: 0.5, num_turns: 3, modelUsage: { m: { inputTokens: 1, outputTokens: 2, cacheReadInputTokens: 3, cacheCreationInputTokens: 4, thinkingTokens: 5, costUSD: 0.5 } } }),
    ].join("\n");
    const b = benchStats(canned);
    const want = { apiMs: 60000, costUsd: 0.5, turns: 3, tools: 2, peak: 1000, models: { m: { in: 1, out: 2, cacheRead: 3, cacheWrite: 4, thinking: 5, cost: 0.5 } },
      agents: [{ type: "adversary", model: "mid", tokens: 1200, tools: 7, ms: 9000 }] };
    if (JSON.stringify(b) !== JSON.stringify(want)) fail("benchStats đọc sai stream-json đóng hộp", JSON.stringify(b));
    if (benchStats(canned.split("\n").slice(0, 5).join("\n")) !== null) fail("benchStats: không có event result mà vẫn ra số");
    const u = spawnSync(process.execPath, [join(SRC, "install.mjs"), "--bench"], { encoding: "utf8" });
    if (u.status !== 2) fail(`--bench không --agent phải exit 2, được ${u.status}`);
    if (!JSON.parse(read(join(EVAL, "cases.json"))).benchTask?.startsWith("/start-task ")) fail("cases.json thiếu benchTask cho --bench --stage full");
  }
  // #72: fixture chia slice là điểm bàn giao cho implementer thật — validator xanh,
  // 03 có đúng S1/S2 và cả plan vượt sliceFiles; bản --unsliced cũng xanh và không có slice.
  for (const unsliced of [false, true]) {
    const root = mkdtempSync(join(tmpdir(), "sh-sliced-"));
    const { P, T } = buildSlicedCase(root, { unsliced });
    const v = spawnSync(process.execPath, ["scripts/validate-tasks.mjs", "--json", "--task", T], { cwd: P, encoding: "utf8" });
    const res = JSON.parse(v.stdout).results[0];
    if (res.errors.length) fail(`#72: fixture sliced${unsliced ? " (--unsliced)" : ""} không qua validator`, res.errors.join("\n"));
    const pk = spawnSync(process.execPath, ["scripts/validate-tasks.mjs", "--pack", T, "implementation", ...(unsliced ? [] : ["--slice", "S1"])], { cwd: P, encoding: "utf8" });
    if (pk.status !== 0 || unsliced === pk.stdout.includes("builds slice S1 only")) fail(`#72: --pack trên fixture sliced${unsliced ? " (--unsliced)" : ""} sai`, pk.stderr);
    const a = spawnSync(process.execPath, ["scripts/validate-tasks.mjs", "--advance", T, "implementation", ...(unsliced ? [] : ["--slice", "S1"])], { cwd: P, encoding: "utf8" });
    if (a.status !== 0) fail(`#72: --advance trên fixture sliced${unsliced ? " (--unsliced)" : ""} không exit 0`, a.stderr);
    rmSync(root, { recursive: true, force: true });
  }
  const git = (cwd, ...a) => spawnSync("git", a, { cwd, stdio: "ignore" });
  const mkrepo = (name) => {
    const d = join(mkdtempSync(join(tmpdir(), "sh-")), name);
    mkdirSync(d, { recursive: true });
    git(d, "init", "-q");
    return d;
  };
  const brokenTask = (P) => {
    const t = join(P, "docs/tasks/sprint-1/A-1-x");
    mkdirSync(t, { recursive: true });
    writeFileSync(join(t, "task.agent.json"),
      read(join(P, "docs/tasks/_templates/task.agent.json"))
        .replace('"currentStage": "bootstrap"', '"currentStage": "implementation"'));
  };
  const validator = (P, ...a) =>
    spawnSync(process.execPath, ["scripts/validate-tasks.mjs", ...a], { cwd: P, stdio: "ignore" }).status;
  const commit = (P) =>
    git(P, "add", "-A").status === 0 &&
    spawnSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-m", "x"],
      { cwd: P, stdio: "ignore" }).status === 0;

  const T = mkrepo("p");
  installInto(T);

  // gate phải CHẶN task hỏng
  brokenTask(T);
  if (validator(T, "--quiet") === 0) fail("validator ĐÁNG LẼ phải fail task thiếu artifact");

  if (!existsSync(join(T, ".claude/agents/orchestrator.md"))) fail("thiếu subagent");
  // /start-task step 0b gọi lease TRƯỚC mọi thứ khác — thiếu nó là hỏng cả lệnh,
  // và hai phiên cùng task sẽ ghi đè handoff của nhau trong im lặng.
  if (spawnSync(process.execPath, ["scripts/lease.mjs", "--self-check"],
      { cwd: T, stdio: "ignore" }).status !== 0) fail("lease.mjs thiếu hoặc self-check đỏ");
  // Gate 4/5 ở evidenceMode "attested" gọi wrapper này. Thiếu nó thì evidence
  // quay về kiểu dán tay — gate vẫn xanh, chỉ là không còn kiểm được gì.
  if (spawnSync(process.execPath, ["scripts/run-evidence.mjs", "--self-check"],
      { cwd: T, stdio: "ignore" }).status !== 0) fail("run-evidence.mjs thiếu hoặc self-check đỏ");
  // Không có nó thì telemetry phụ thuộc coordinator nhớ gõ số token vào — và
  // một con số bịa còn tệ hơn không có, vì `--cost` sẽ in nó ra với vẻ mặt tỉnh bơ.
  if (spawnSync(process.execPath, ["scripts/collect-telemetry.mjs", "--self-check"],
      { cwd: T, stdio: "ignore" }).status !== 0) fail("collect-telemetry.mjs thiếu hoặc self-check đỏ");
  if (!existsSync(join(T, ".mcp.json"))) fail("thiếu .mcp.json");

  // Lệnh phá working tree phải bị chặn ở tầng permission, không chỉ ở văn bản.
  let settings;
  try { settings = read(join(T, ".claude/settings.json")); JSON.parse(settings); }
  catch { fail("settings.json không phải JSON hợp lệ"); }
  // Dùng chính predicate của validator, không tự liệt kê lại danh sách ở đây:
  // hai danh sách rời nhau thì thêm một rule vào preflight mà quên bên này là
  // ship ra một settings.json mà chính preflight của nó sẽ báo đỏ.
  {
    const r = spawnSync(process.execPath,
      ["scripts/validate-tasks.mjs", "--check-settings", ".claude/settings.json"],
      { cwd: T, encoding: "utf8" });
    if (r.status !== 0)
      fail("settings.json cài ra không thoả deny-list mà preflight đòi:", (r.stderr || r.stdout).trim());
  }

  if (!existsSync(join(T, ".github/workflows/spec-harness.yml")))
    fail("thiếu CI workflow — gate chỉ tồn tại ở máy dev");

  // Repo GitLab phải nhận file GitLab. Cài nhầm .github/workflows/ vào đó là
  // lưới GIẢ: preflight thấy file nên xanh, CI không bao giờ chạy nó — tệ hơn
  // là không có CI, vì không có CI thì ít nhất preflight còn báo đỏ.
  {
    const G = mkrepo("gl");
    git(G, "remote", "add", "origin", "https://gitlab.example.com/x/y.git");
    spawnSync(process.execPath, [join(SRC, "install.mjs"), "--yes", G], { stdio: "ignore" });
    if (!existsSync(join(G, ".gitlab-ci.yml")))
      fail("cài vào repo có remote GitLab mà không sinh .gitlab-ci.yml — CI không chạy gate nào");
    if (existsSync(join(G, ".github/workflows")))
      fail("cài vào repo GitLab mà vẫn sinh .github/workflows/ — preflight xanh nhờ file không bao giờ chạy");
    rmSync(G, { recursive: true, force: true });
  }

  // Mặc định của harness là MCP GitLab + skill build-and-mr viết cho MR, nên
  // chỉ ship file GitHub nghĩa là đúng nhóm người dùng harness nhắm tới lại
  // không có lưới cuối. Preflight phải nhận CẢ HAI, và bài kiểm rẻ nhất là
  // chạy nó trên một cây chỉ có .gitlab-ci.yml.
  {
    const gl = join(SRC, "adapters/ci/.gitlab-ci.yml");
    if (!existsSync(gl)) fail("thiếu adapters/ci/.gitlab-ci.yml — team GitLab cài xong mất lưới CI mà không biết");
    const wf = join(T, ".github/workflows");
    const saved = readdirSync(wf).map((f) => [f, read(join(wf, f))]);
    rmSync(wf, { recursive: true, force: true });
    cpSync(gl, join(T, ".gitlab-ci.yml"));
    const r = spawnSync(process.execPath, ["scripts/validate-tasks.mjs", "--preflight", "--json"],
      { cwd: T, encoding: "utf8" });
    // Parse, không regex trên stdout: `--json` mà lẫn một dòng cho người đọc
    // thì output hỏng với MỌI tool tiêu thụ nó, và grep sẽ không thấy điều đó.
    let errs;
    try { errs = JSON.parse(r.stdout).errors ?? []; }
    catch { fail("`--preflight --json` không trả JSON parse được:", r.stdout.trim().slice(0, 300)); }
    if (errs.some((e) => /no CI workflow/.test(e)))
      fail("preflight báo 'no CI workflow' trên cây có .gitlab-ci.yml chạy validator — nó chỉ nhìn .github/workflows");
    rmSync(join(T, ".gitlab-ci.yml"));
    mkdirSync(wf, { recursive: true });
    for (const [f, c] of saved) writeFileSync(join(wf, f), c);
  }

  // Kernel/adapter chia đôi mọi thứ, và hai nửa trông GIỐNG NHAU — nên `cp` từ
  // bên này sang bên kia luôn trông như đồng bộ hoá. Một lần như vậy đã làm
  // chết CI của repo này (adapter gọi `scripts/`, repo nguồn cần `kernel/scripts/`
  // → MODULE_NOT_FOUND). Đó là MẮU lỗi, không phải ca đơn lẻ: thêm cặp mới là
  // thêm một dòng ở đây, không phải viết lại một khối if.
  for (const pair of [
    {
      name: "CI workflow",
      adapter: "adapters/ci/validate-tasks.yml",
      own: ".github/workflows/validate-tasks.yml",
      adapterMustNot: "kernel/scripts/",
      ownMustHave: "kernel/scripts/validate-tasks.mjs",
      why: "adapter chạy ở project đã cài (validator ở scripts/), bản của repo nguồn chạy ở đây (kernel/scripts/)",
    },
    {
      name: "harness.config.json",
      adapter: "adapters/example/harness.config.json",
      own: "harness.config.json",
      adapterMustNot: '"kernel/docs/tasks"',
      ownMustHave: '"kernel/docs/tasks"',
      why: "tasksDir của repo nguồn trỏ vào kernel/ để --self-check kiểm đúng thứ được ship; project đã cài dùng docs/tasks",
    },
    {
      name: "ProjectRules",
      adapter: "adapters/ProjectRules.template.md",
      own: "adapters/example/docs/agents/ProjectRules.md",
      adapterMustHave: "NOT-FILLED-IN",
      ownMustNot: "NOT-FILLED-IN",
      why: "template là khung rỗng cho /init-project-rules điền; bản mẫu là ví dụ ĐÃ điền — đổi chỗ thì /init-project-rules không còn gì để điền",
    },
  ]) {
    const a = join(SRC, pair.adapter);
    const o = join(SRC, pair.own);
    if (!existsSync(a)) fail(`${pair.name}: thiếu ${pair.adapter}`);
    if (!existsSync(o)) continue; // bản cài đặt không có file "own" — không phải lỗi
    const at = read(a), ot = read(o);
    if (at === ot)
      fail(`${pair.name}: ${pair.adapter} và ${pair.own} giống hệt nhau — ${pair.why}`);
    const bad =
      (pair.adapterMustNot && at.includes(pair.adapterMustNot) && [pair.adapter, `không được chứa ${pair.adapterMustNot}`]) ||
      (pair.adapterMustHave && !at.includes(pair.adapterMustHave) && [pair.adapter, `phải chứa ${pair.adapterMustHave}`]) ||
      (pair.ownMustHave && !ot.includes(pair.ownMustHave) && [pair.own, `phải chứa ${pair.ownMustHave}`]) ||
      (pair.ownMustNot && ot.includes(pair.ownMustNot) && [pair.own, `không được chứa ${pair.ownMustNot}`]);
    if (bad)
      fail(
        `${pair.name}: ${bad[0]} ${bad[1]} — bị chép đè từ nửa kia?\n` +
          `  ${pair.why}\n` +
          `  Sửa: khôi phục ${bad[0]} từ git (git checkout -- ${bad[0]}), đừng đồng bộ hai file này`,
      );
  }

  // Cùng một mẫu, chiều khác: thêm field vào một bên mà quên bên kia thì
  // --self-check vẫn xanh ở cả hai, và project tiếp theo cài ra một config
  // thiếu gác chắn mà không ai biết.
  // Chỉ chạy được từ cây repo: `harness.config.json` của repo nguồn KHÔNG nằm
  // trong tarball (project cài ra tự sinh config riêng). Self-test chạy trên
  // tarball thì bỏ qua — đúng kiểu lỗi mà bước tarball sinh ra để bắt, và nó
  // đã bắt thật một lần.
  if (existsSync(join(SRC, "harness.config.json"))) {
    const keys = (p) => Object.keys(JSON.parse(read(join(SRC, p)))).filter((k) => !k.startsWith("_")).sort();
    const ownK = keys("harness.config.json"), exK = keys("adapters/example/harness.config.json");
    const missing = ownK.filter((k) => !exK.includes(k));
    const extra = exK.filter((k) => !ownK.includes(k));
    if (missing.length || extra.length)
      fail(
        `harness.config.json và adapters/example/ lệch tập key — thêm field một bên mà quên bên kia:\n` +
          (missing.length ? `  chỉ có ở repo gốc: ${missing.join(", ")}\n` : "") +
          (extra.length ? `  chỉ có ở example:  ${extra.join(", ")}\n` : "") +
          `  Sửa: thêm field thiếu vào bên kia (giá trị có thể khác, key thì không)`,
      );
  }
  if (!existsSync(join(T, ".claude/commands/init-project-rules.md"))) fail("thiếu lệnh /init-project-rules");

  // #55: coordinator nạp start-task.md ở MỌI task — file đắt nhất mà §8 không cap.
  // Lý do + nhánh điều kiện nằm ở StartTask-Appendix.md; mọi link/anchor sang đó
  // phải resolve trên bản cài, nếu không tách file = xóa nội dung.
  const checkAppendix = (T) => {
    const cap = 20 * 1024, size = statSync(join(SRC, "commands/start-task.md")).size;
    if (size > cap) fail(`commands/start-task.md ${size} B > ${cap} B — dời lý do sang docs/agents/StartTask-Appendix.md (#55)`);
    const slug = (h) => h.trim().toLowerCase().replace(/[^\p{L}\p{N}\s-]/gu, "").replace(/\s/g, "-");
    for (const f of [".claude/commands/start-task.md", ".agents/skills/start-task/SKILL.md"]) {
      const p = join(T, f);
      if (!existsSync(p)) continue; // .agents/ chỉ có khi cài --cli
      const links = [...read(p).matchAll(/\]\(([^)#]*StartTask-Appendix\.md)(#[^)]*)?\)/g)];
      if (!links.length) fail(`${f} không còn link nào sang StartTask-Appendix.md — nội dung dời đi đã mồ côi`);
      for (const [, href, anchor] of links) {
        const tgt = join(dirname(p), href);
        if (!existsSync(tgt)) fail(`${f}: link ${href} không resolve trên bản cài (${tgt})`);
        const anchors = new Set(read(tgt).split("\n").filter((l) => /^#+ /.test(l)).map((l) => "#" + slug(l.replace(/^#+ /, ""))));
        if (anchor && !anchors.has(anchor)) fail(`${f}: anchor ${anchor} không có trong StartTask-Appendix.md`);
      }
    }
  };
  checkAppendix(T);

  // Mọi check ở trên đọc config và template RỜI NHAU, nên chúng đều xanh khi hai
  // bên nói về hai bộ file khác nhau. Đó là cách `06-FE-Implementation-Notes.md`
  // sống sót trong adapter sau khi template đã đổi tên: config đòi một file
  // không bao giờ tồn tại, và mọi task trên MỌI bản cài mới đều đỏ ngay từ task
  // đầu tiên. Ba tầng CI không thấy vì không tầng nào chạy validator lên một
  // task folder thật.
  //
  // Cách duy nhất bắt được là dựng đúng thứ user sẽ có: task copy từ
  // `_templates/`, chấm bằng `harness.config.json` cài ra. Ta không đòi task
  // này PASS — nó chưa có evidence nên phải đỏ. Ta đòi nó đỏ VÌ LÝ DO ĐÚNG:
  // không được có lỗi "required file … missing", vì mọi file bắt buộc đều vừa
  // được copy từ template ra.
  {
    const cfg = JSON.parse(read(join(T, "harness.config.json")));
    const dir = join(T, "docs/tasks/sprint-1/SH-1-self-test");
    cpSync(join(T, "docs/tasks/_templates"), dir, { recursive: true });
    const task = JSON.parse(read(join(dir, "task.agent.json")));
    Object.assign(task, {
      taskId: "SH-1", taskName: "self test", repoName: cfg.repos[0].name,
      sprintNumber: 1, developer: "self-test", branch: "feature/SH-1-self-test",
      layer: cfg.layers[0], docsPath: "docs/tasks/sprint-1/SH-1-self-test/",
      currentStage: "reviewing", status: "reviewing",
      createdAt: "2026-01-01", updatedAt: "2026-01-01",
    });
    for (const r of Object.keys(task.agents)) task.agents[r] = { status: "done" };
    writeFileSync(join(dir, "task.agent.json"), JSON.stringify(task, null, 2));

    const r = spawnSync(process.execPath, ["scripts/validate-tasks.mjs", "--json"],
      { cwd: T, encoding: "utf8" });
    let report;
    try { report = JSON.parse(r.stdout); }
    catch { fail("validator không trả JSON đọc được trên task dựng từ template:", (r.stderr || r.stdout).trim().slice(0, 400)); }
    // CHỈ task vừa dựng. Các check khác trong self-test cố tình để lại task hỏng
    // (brokenTask) — gom cả chúng vào đây thì assert luôn đỏ vì lý do khác, và
    // ca này không còn đo gì.
    const mine = report.results.find((t) => t.folder.endsWith("SH-1-self-test"));
    if (!mine) fail("validator không thấy task vừa dựng từ template — tasksDir của config trỏ sai chỗ?");
    const errs = mine.errors;
    // "required file … missing" = config và template đang nói về hai bộ file khác
    // nhau. Không sửa được bằng cách điền task cho đúng hơn.
    const ghost = errs.filter((e) => /required file .* missing/.test(e));
    if (ghost.length)
      fail(
        `harness.config.json đòi file mà docs/tasks/_templates/ không ship:\n` +
          ghost.map((e) => `  ${e}`).join("\n") +
          `\n  Mọi task trên mọi bản cài mới sẽ đỏ vì file này. Sửa: đồng bộ tên file` +
          `\n  giữa adapters/example/harness.config.json và kernel/docs/tasks/_templates/`,
      );
    // Vế đối: task rỗng KHÔNG có evidence mà validator im lặng thì check trên
    // vô nghĩa — nó sẽ xanh cả khi validator không chấm gì cả.
    //
    // Từng vế phải được đòi RIÊNG. Gộp thành một regex `/evidence|attestation/`
    // là đủ để Gate 4 tắt hẳn mà self-test vẫn xanh: lỗi attestation một mình
    // đã thoả vế gộp. Mutation test bắt đúng ca đó.
    for (const [what, re] of [
      ["Gate 4 đòi command+result thật", /no real command\+result evidence/],
      ["attestation (evidenceMode=attested)", /no attestation block/],
      ["Gate 5 đòi adversary tự chạy", /adversary ran itself/],
      ["Gate 2 đòi có AC", /no AC declared/],
    ])
      if (!errs.some((e) => re.test(e)))
        fail(`task \`reviewing\` rỗng mà validator không báo: ${what} — gate đó rỗng ruột trên bản cài ra`);
    // telemetry rỗng ở `reviewing` = không bao giờ đo được task này tốn gì, và
    // đến đây thì mọi dispatch đã chạy xong — không còn lúc nào để bắt nữa.
    // Warning chứ không error (CLI không phải cái nào cũng báo token), nhưng
    // phải được NÓI RA, nếu không thì schema có field mà không ai điền.
    if (!mine.warnings.some((w) => /telemetry is empty/.test(w)))
      fail("task ở `reviewing` không có telemetry mà validator im lặng — `--calibrate`/`--cost` sẽ không bao giờ có dữ liệu và không ai biết vì sao");

    // --cost với task THẬT trên đĩa. Chạy nó lúc 0 task không chứng minh gì: cả
    // một lỗi TDZ (findTaskFolders đọc ONLY trước khi khai báo) vẫn xanh, vì
    // vòng lặp chưa chạy tới dòng đó. Bug đó có thật, và đây là ca bắt được nó.
    {
      const c = spawnSync(process.execPath, ["scripts/validate-tasks.mjs", "--cost", "--json"],
        { cwd: T, encoding: "utf8" });
      if (c.status !== 0) fail(`--cost đỏ khi có task thật: ${(c.stderr || "").split("\n")[0]}`);
      let cost; try { cost = JSON.parse(c.stdout); }
      catch { fail("--cost --json không ra JSON parse được"); }
      if (!(cost.floor?.perTaskBytes > 0) || !(cost.floor?.stages > 0))
        fail("--cost báo sàn 0 — đọc nhầm layout docs/ thì số 0 trông như tin mừng");
      if (cost.tasksScanned < 1) fail("--cost không thấy task nào dù task tồn tại trên đĩa");
    }

    // Xoá ĐÚNG folder vừa dựng: brokenTask() cũng nằm trong sprint-1, và các
    // check phía sau cần nó để chứng minh hook chặn được commit hỏng.
    rmSync(dir, { recursive: true, force: true });
  }

  // Mọi thứ install.mjs đọc từ SRC phải nằm trong `files` của package.json.
  // Cây repo luôn có đủ, nên self-test ở đây xanh trong khi tarball thiếu file
  // và người cài qua npx ăn ENOENT — đúng cách 0.1.4 lọt ra ngoài với
  // `.claude-plugin/` không được đóng gói.
  //
  // Đọc path từ chính source thay vì chép tay một danh sách: danh sách chép tay
  // là chỗ thứ hai phải nhớ sửa, và nó sẽ không được sửa.
  {
    const src = read(join(SRC, "install.mjs"));
    const pkg = JSON.parse(read(join(SRC, "package.json")));
    const shipped = new Set(pkg.files.map((f) => f.replace(/\/$/, "")));
    // package.json luôn có trong tarball dù không khai trong files (npm ép).
    shipped.add("package.json");
    const missing = new Set();
    // `existsSync(join(SRC, ...))` = chỗ đã biết file có thể vắng và xử lý được
    // (ví dụ harness.config.json của repo gốc, cố ý không đóng gói). Đọc thẳng
    // không guard mới là chỗ tarball thiếu file thì nổ.
    for (const m of src.matchAll(/(existsSync\(\s*)?join\(SRC,\s*"([^"]+)"/g)) {
      if (m[1]) continue;
      const top = m[2].split("/")[0];
      if (!shipped.has(top)) missing.add(top);
    }
    if (missing.size)
      fail(`install.mjs đọc ${[...missing].join(", ")} nhưng package.json "files" không đóng gói — ` +
           `cây repo có nên self-test xanh, tarball thiếu nên npx hỏng`);
  }

  // Hai chỗ khai version thì chúng SẼ lệch — đã lệch một lần (plugin.json 0.1.0
  // vs package.json 0.1.1) và không có gì bắt được. `npm version` chỉ đụng
  // package.json, nên vế còn lại phải được assert chứ không thể trông cậy vào
  // trí nhớ lúc phát hành.
  {
    const pkg = JSON.parse(read(join(SRC, "package.json"))).version;
    const plug = JSON.parse(read(join(SRC, ".claude-plugin/plugin.json"))).version;
    if (pkg !== plug)
      fail(`version lệch: package.json=${pkg} nhưng .claude-plugin/plugin.json=${plug} — \`npm version\` chỉ sửa cái đầu, sửa nốt cái sau`);
    const stampPath = join(T, "docs/.kernel-version");
    if (!existsSync(stampPath)) fail("bản cài ra không có docs/.kernel-version — nâng kernel xong không ai biết đang chạy bản nào");
    if (read(stampPath).split("\n")[0].trim() !== pkg)
      fail(`docs/.kernel-version ghi "${read(stampPath).split("\n")[0].trim()}", package.json khai "${pkg}"`);
  }

  // Bản cài ra phải đi kèm evidence thật. "legacy" cho project MỚI nghĩa là Gate
  // 4/5 nhận văn bản dán tay ngay từ task đầu tiên — không có evidence cũ nào để
  // bảo vệ, chỉ có một gate rỗng ruột mà không ai biết.
  {
    const cfgPath = join(T, "harness.config.json");
    const cfg = JSON.parse(read(cfgPath));
    if (cfg.evidenceMode !== "attested")
      fail(`bản cài ra có evidenceMode="${cfg.evidenceMode}" — project mới phải là "attested", legacy chỉ dành cho di trú`);
    // … và không được có mặc định ngầm: xoá field đi phải đỏ, không được âm
    // thầm rơi về legacy.
    delete cfg.evidenceMode;
    writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));
    if (validator(T, "--self-check") === 0) fail("thiếu evidenceMode mà --self-check vẫn xanh — mặc định ngầm đã quay lại");
    writeFileSync(cfgPath, JSON.stringify({ ...cfg, evidenceMode: "attested" }, null, 2));
  }

  // Kernel/skill không được hardcode tên tool MCP: khoá harness vào đúng một
  // tracker, project dùng Jira/Linear là agent gọi hụt trong im lặng.
  const hard = [];
  for (const d of ["docs", ".claude/skills", ".claude/agents"])
    for (const f of walk(join(T, d)))
      read(f).split("\n").forEach((l, i) => {
        if (/mcp__[a-z]/.test(l) && !l.includes("mcp__<server>__<tool>")) hard.push(`    ${f}:${i + 1}: ${l.trim()}`);
      });
  if (hard.length) fail("còn tên tool MCP hardcode:", hard.join("\n"));

  // Kernel không được khoá vào một layer. Role tên `fe-*` (và doc/template đi
  // kèm) là cách khoá đó len vào lần trước: validator vốn đã đọc roles/routing
  // từ config, nhưng TÊN trong kernel docs nói ngược lại — team BE đọc xong
  // tưởng phải tự viết harness khác. Layer là dữ liệu của `repos[].layer`,
  // không phải chữ trong kernel.
  const layerLock = [];
  for (const d of ["docs", ".claude/agents"])
    for (const f of walk(join(T, d)))
      read(f).split("\n").forEach((l, i) => {
        if (/\b(fe|be)-(implementer|fix|fixer)\b|FEImplementer|FEFix/.test(l))
          layerLock.push(`    ${f}:${i + 1}: ${l.trim()}`);
      });
  if (layerLock.length)
    fail("kernel khoá vào một layer (role tên theo layer) — dùng `implementer`/`fixer`:", layerLock.join("\n"));

  // Cùng một bug, khác trục: ngôn ngữ văn xuôi của task doc là lựa chọn của
  // project. Hàn "tiếng Việt" vào kernel nghĩa là một team nói tiếng Anh cài
  // harness này rồi bị bảo viết task doc bằng tiếng Việt. Nó thuộc về
  // harness.config.json → docLanguage.
  // `docs/vi/` là BẢN DỊCH của kernel docs (cùng nội dung, tiếng Việt) — nó nói
  // về chính nó chứ không ép task doc phải viết tiếng Việt. Quét nó thì assert
  // bắt đúng thứ nó sinh ra để phục vụ.
  const langLock = [];
  for (const d of ["docs", ".claude/agents"])
    for (const f of walk(join(T, d)))
      read(f).split("\n").forEach((l, i) => {
        if (f.includes("/docs/vi/")) return;
        if (/(ti|Ti)ếng Việt/.test(l) && !l.includes("docLanguage"))
          langLock.push(`    ${f}:${i + 1}: ${l.trim().slice(0, 100)}`);
      });
  if (langLock.length)
    fail("kernel hardcode ngôn ngữ task doc — trỏ về `harness.config.json → docLanguage`:", langLock.join("\n"));

  // … và chứng minh bằng một config BACKEND thật, không chỉ bằng việc vắng chữ
  // "fe". Một project BE thuần phải qua được --self-check mà không sửa kernel.
  {
    const cfgPath = join(T, "harness.config.json");
    const orig = read(cfgPath);
    const be = JSON.parse(orig);
    be.layers = ["backend"];
    be.repos = [{ name: "api", path: ".", layer: "backend" }];
    writeFileSync(cfgPath, JSON.stringify(be, null, 2));
    const r = spawnSync(process.execPath, ["scripts/validate-tasks.mjs", "--self-check"], { cwd: T, encoding: "utf8" });
    writeFileSync(cfgPath, orig);
    if (r.status !== 0) fail("config backend thuần không qua được --self-check — kernel vẫn khoá layer", r.stderr || r.stdout);
  }

  // kernel gọi skill nào thì skill đó phải được cài kèm
  for (const f of walk(join(SRC, "kernel/docs")))
    for (const [, sk] of read(f).matchAll(/skill `([a-z0-9-]+)`/g))
      if (!existsSync(join(T, ".claude/skills", sk, "SKILL.md")))
        fail(`kernel gọi skill '${sk}' nhưng không cài kèm`);

  // Kernel đã dịch xong (#13) nhưng ĐƯỜNG CHẠY thì chưa: commands/ và skills/
  // vẫn tiếng Việt, và start-task.md — file điều phối cả 7 stage — là file dài
  // nhất trong đó. Một team không đọc tiếng Việt cài harness này thì không
  // audit được logic dispatch, dù kernel toàn tiếng Anh.
  //
  // Nhận diện bằng DẤU THANH sau khi tách tổ hợp (NFD): huyền/sắc/hỏi/ngã/nặng
  // + `đ`. Không quét cả dải \u00C0-\u1EF9 vì `×` (U+00D7) và các ký tự toán
  // học nằm trong đó — quét rộng thì assert kêu sai chỗ rồi bị gỡ.
  {
    const VN = /[\u0300\u0301\u0303\u0309\u0323\u0111\u0110]/;
    // Allowlist theo THƯ MỤC SKILL, không theo file: skill còn có references/
    // và các file phụ cùng lý do, liệt kê từng file thì lần thêm file sau lại
    // đỏ và người ta sẽ nới assert thay vì nới allowlist.
    const allow = [
      // Hai skill này SINH ra tài liệu cho một corpus tiếng Việt: chúng ánh xạ
      // modal 29148 sang `phải`/`nên`/`có thể`, và anchor GitHub phải khớp byte
      // với heading tiếng Việt có sẵn. Chuỗi tiếng Việt ở đây là DỮ LIỆU đặc
      // tả — dịch đi là skill sinh ra heading không khớp corpus.
      "skills/documents-sync/",
      "skills/document-to-ieee-srs/",
    ];
    // `## Cập Nhật` là MARKER cấu trúc validator split trên đó, nhận cả hai
    // ngôn ngữ (UPDATE_HEADING) — nó là cấu trúc, không phải prose.
    const marker = /Cập Nhật/;
    const hits = [];
    for (const r of ["commands", "skills", "adapters/ProjectRules.template.md"]) {
      const abs = join(SRC, r);
      if (!existsSync(abs)) continue;
      for (const f of statSync(abs).isDirectory() ? walk(abs) : [abs]) {
        const relp = f.slice(SRC.length + 1);
        if (allow.some((a) => relp.startsWith(a)) || !/\.md$/.test(f)) continue;
        read(f).split("\n").forEach((l, i) => {
          if (VN.test(l.normalize("NFD")) && !marker.test(l))
            hits.push(`  ${relp}:${i + 1}: ${l.trim().slice(0, 90)}`);
        });
      }
    }
    if (hits.length)
      fail(
        `còn ${hits.length} dòng tiếng Việt trong đường chạy (commands/ + skills/) — kernel dịch rồi mà chỗ THỰC SỰ CHẠY thì chưa:\n` +
          hits.slice(0, 12).join("\n") +
          (hits.length > 12 ? `\n  … và ${hits.length - 12} dòng nữa` : "") +
          `\n  Ngoại lệ có lý do thì thêm vào allowlist ngay trên, kèm lý do`,
      );
  }

  // #60: models.<cli> → the base tier lands in each CLI's role file, the
  // coordinator tier only in Claude's command; a CLI with no key gets no model.
  {
    const R = mkrepo("models");
    installInto(R);
    const fm = (p) => (read(join(R, p)).match(/^model: (.*)$/gm) ?? []);
    if (fm(".claude/agents/adversary.md").join() !== "model: sonnet") fail("models.claude.mid không render vào .claude/agents/adversary.md", fm(".claude/agents/adversary.md").join());
    if (fm(".claude/agents/orchestrator.md").join() !== "model: haiku") fail("orchestrator (normal = cheap) phải render models.claude.cheap");
    if (fm(".claude/commands/start-task.md").join() !== "model: sonnet") fail("coordinatorTier không render vào frontmatter /start-task");
    const cfgP = join(R, "harness.config.json"), cfg = JSON.parse(read(cfgP));
    cfg.models.codex = { cheap: { model: "c-lo" }, mid: { model: "c-mid", effort: "high" }, strong: { model: "c-hi" } };
    cfg.models.claude.mid = { model: "m2", effort: "low" };
    cfg.models.gemini = { cheap: { model: "g1", effort: "low" }, mid: { model: "g2", effort: "low" }, strong: { model: "g3" } };
    writeFileSync(cfgP, JSON.stringify(cfg));
    installInto(R, ["codex", "gemini"]);
    if (fm(".claude/agents/adversary.md").join() !== "model: m2") fail("cài lại không thay model cũ — hoặc ghi 2 dòng model:", fm(".claude/agents/adversary.md").join());
    if (fm(".claude/commands/start-task.md").join() !== "model: m2") fail("cài lại không thay model trong /start-task");
    const tomlM = read(join(R, ".codex/agents/adversary.toml")).match(/^model = .*$/gm) ?? [];
    if (tomlM.join() !== 'model = "c-mid"') fail("models.codex không render vào .codex/agents/adversary.toml", tomlM.join());
    const eff = (p) => read(join(R, p)).match(/^(effort: .*|model_reasoning_effort = .*)$/gm) ?? [];
    if (eff(".codex/agents/adversary.toml").join() !== 'model_reasoning_effort = "high"') fail("#63: models.codex.mid.effort không render thành model_reasoning_effort", eff(".codex/agents/adversary.toml").join());
    if (eff(".claude/agents/adversary.md").join() !== "effort: low") fail("#63: models.claude.mid.effort không render vào frontmatter subagent", eff(".claude/agents/adversary.md").join());
    if (eff(".claude/commands/start-task.md").length) fail("#63: effort ghi vào frontmatter command — field đó không có trong docs");
    if (fm(".gemini/agents/adversary.md").join() !== "model: g2" || eff(".gemini/agents/adversary.md").length) fail("#63: gemini nhận model, không nhận effort (không có field)", read(join(R, ".gemini/agents/adversary.md")).slice(0, 200));
    delete cfg.models.claude.mid.effort; delete cfg.models.gemini;
    writeFileSync(cfgP, JSON.stringify(cfg));
    installInto(R, ["codex", "gemini"]);
    if (eff(".claude/agents/adversary.md").length) fail("#63: bỏ effort khỏi config mà dòng effort: cũ vẫn còn");
    if (fm(".gemini/agents/adversary.md").length) fail("gemini không có models.gemini mà vẫn nhận model — đoán tên model của vendor khác");
    rmSync(dirname(R), { recursive: true, force: true });
  }

  // #60 R1b: the kernel names tiers, never a vendor model — "what if I don't use
  // Claude?" must be answered by config, not by editing prose in five files.
  {
    const tokens = JSON.parse(read(join(SRC, "adapters/example/harness.config.json"))).vendorModelTokens;
    if (!Array.isArray(tokens) || !tokens.length) fail("adapters/example/harness.config.json thiếu vendorModelTokens — R1b không có gì để quét");
    const hits = [];
    for (const r of ["commands", "agents", "kernel"]) for (const f of walk(join(SRC, r)))
      for (const n of vendorLeaks(read(f), tokens)) hits.push(`${f.slice(SRC.length + 1)}:${n}`);
    if (hits.length) fail(`tên model vendor trong kernel — chỉ harness.config.json → models.<cli> được gọi tên model (R1b):\n  ${hits.join("\n  ")}`);
    const t = ["opus", "gpt-"];
    if (vendorLeaks("a\nuse opus here", t).join() !== "2") fail("vendorLeaks bỏ sót dòng có tên model");
    if (vendorLeaks("corpus\nmy-opus", t).length) fail("vendorLeaks bắt nhầm giữa từ");
    if (vendorLeaks("<!-- example -->\n```json\ngpt-5\n```\ngpt-5", t).join() !== "5") fail("vendorLeaks: fence <!-- example --> phải miễn, dòng sau fence thì không");
    if (vendorLeaks("```json\ngpt-5\n```", t).join() !== "2") fail("vendorLeaks: fence không có marker không được miễn");
    // The validator ships alone and cannot import CLIS; the two lists must not drift.
    const vs = read(join(SRC, "kernel/scripts/validate-tasks.mjs"));
    const vc = JSON.parse(/export const CLI_NAMES = (\[[\s\S]*?\]);/.exec(vs)[1].replace(/\s+/g, " "));
    if (vc.join() !== CLIS.join()) fail(`validate-tasks CLI_NAMES lệch install.mjs CLIS: [${vc}] vs [${CLIS}]`);
  }

  // #49: Node is the only runtime the installer checks for. A python step in a
  // command/skill fails on a machine that passed every install check.
  {
    const py = [];
    for (const r of ["commands", "skills"]) for (const f of walk(join(SRC, r))) {
      const relp = f.slice(SRC.length + 1);
      if (f.endsWith(".py")) py.push(relp);
      else read(f).split("\n").forEach((l, i) => { if (/\bpython3?\b/.test(l)) py.push(`${relp}:${i + 1}`); });
    }
    if (py.length) fail(`python trong đường chạy — Node là runtime duy nhất installer kiểm tra:\n  ${py.join("\n  ")}`);
  }

  const pr = read(join(T, "docs/agents/ProjectRules.md"));
  if (!pr.includes("NOT-FILLED-IN")) fail("ProjectRules không phải template rỗng");
  if (!/^## 7\./m.test(pr)) fail("template mất mục §7 (kernel trỏ chéo bằng số)");

  // Một URL không parse được làm CLI chết bằng ERR_INVALID_URL ngay lúc khởi
  // động — trước cả khi user kịp sửa. Placeholder phải là hostname hợp lệ.
  let mcp;
  try { mcp = JSON.parse(read(join(T, ".mcp.json"))); } catch { fail(".mcp.json không phải JSON hợp lệ"); }
  for (const [k, v] of Object.entries(mcp.mcpServers || {})) {
    if (!v.url) continue; // server chạy local: command + args, không có url
    try { new URL(v.url); }
    catch { fail(`.mcp.json có URL không parse được (ERR_INVALID_URL khi CLI khởi động)`, `    ${k}: ${v.url}`); }
  }

  if (!existsSync(join(T, ".git/hooks/pre-commit"))) fail("repo trống mà không cắm được hook");

  // cài lại lần 2: adapter phải được giữ
  writeFileSync(join(T, "docs/agents/ProjectRules.md"), pr + "\nMARKER\n");
  installInto(T);
  if (!read(join(T, "docs/agents/ProjectRules.md")).includes("MARKER")) fail("cài lại đè mất adapter");

  // gate phải CHẶN commit thật — không chỉ "symlink có tồn tại"
  if (commit(T)) fail("gate KHÔNG chặn commit task hỏng");

  // core.hooksPath (husky/lefthook): cắm vào .git/hooks là cắm vào hư không
  const H2 = mkrepo("h");
  mkdirSync(join(H2, ".husky"), { recursive: true });
  git(H2, "config", "core.hooksPath", ".husky");
  installInto(H2);
  if (!existsSync(join(H2, ".husky/pre-commit"))) fail("bỏ qua core.hooksPath → gate no-op");
  brokenTask(H2);
  if (commit(H2)) fail("core.hooksPath — gate không chặn");
  rmSync(dirname(H2), { recursive: true, force: true });

  // hook là tuỳ chọn: không phải git repo vẫn phải cài được, validator vẫn chạy
  const NG = join(mkdtempSync(join(tmpdir(), "sh-")), "ng");
  mkdirSync(NG, { recursive: true });
  try { installInto(NG); } catch { fail("non-git repo đáng lẽ vẫn cài được"); }
  if (validator(NG, "--quiet") !== 0) fail("validator không chạy được khi không có hook");
  // bố cục B: biển báo ở cha, và phải chỉ đúng tên thư mục vừa cài
  if (!existsSync(join(dirname(NG), "CLAUDE.md"))) fail("bố cục B thiếu biển báo ở thư mục cha");
  if (!read(join(dirname(NG), "CLAUDE.md")).includes("cd ng")) fail("biển báo không chỉ đúng thư mục");
  // user đã symlink .claude lên cha (cố ý mở CLI ở đó) → biển báo phải TỰ RÚT,
  // không thì nâng kernel lại dựng cảnh báo sai lên giữa bố cục đang chạy đúng.
  symlinkSync(join(NG, ".claude"), join(dirname(NG), ".claude"));
  installInto(NG);
  if (existsSync(join(dirname(NG), "CLAUDE.md"))) fail("có .claude ở cha mà biển báo vẫn còn");
  rmSync(dirname(NG), { recursive: true, force: true });

  // bố cục B CÓ `git init` (README khuyến nghị) vẫn phải có biển báo — `.git`
  // không phân biệt được A với B, đây là ca đã regress một lần.
  const BG = join(mkdtempSync(join(tmpdir(), "sh-")), "bg");
  mkdirSync(BG, { recursive: true });
  git(BG, "init", "-q");
  installInto(BG);
  if (!existsSync(join(dirname(BG), "CLAUDE.md"))) fail("bố cục B + git init mất biển báo");
  rmSync(dirname(BG), { recursive: true, force: true });

  // bố cục A (cài vào chính repo code): KHÔNG được rải CLAUDE.md ra ~/code
  const A = mkrepo("a");
  writeFileSync(join(A, "package.json"), "{}"); // repo code có sẵn file
  // docs/README.md là ca va chạm thường gặp nhất ở bố cục A — kernel PHẢI đè
  // (giữ bản cũ thì nâng phiên bản không có tác dụng), nhưng phải BÁO, không
  // thì user chỉ biết lúc `git diff`, hoặc không bao giờ.
  mkdirSync(join(A, "docs"), { recursive: true });
  writeFileSync(join(A, "docs/README.md"), "# docs của project tôi");
  // wouldClobber() (hỏi trước) và over() (báo sau) là hai cài đặt rời của cùng
  // một câu hỏi. Lệch nhau = xác nhận giấu mất file sắp bị đè.
  const pre = wouldClobber(A);
  const rA = installInto(A);
  if (pre.sort().join() !== rA.clobbered.slice().sort().join())
    fail(`wouldClobber lệch over(): [${pre}] vs [${rA.clobbered}]`);
  if (!rA.clobbered.includes("docs/README.md")) fail("đè file project mà không báo");
  if (read(join(A, "docs/README.md")).includes("project tôi")) fail("kernel docs đáng lẽ phải đè");
  // cài lại: nội dung đã giống nhau → không được báo nhầm
  if (installInto(A).clobbered.length) fail("cài lại báo đè dù nội dung không đổi");
  if (existsSync(join(dirname(A), "CLAUDE.md"))) fail("bố cục A không được ghi CLAUDE.md ra thư mục cha");
  // CLAUDE.md sẵn có của user không bị đè
  const B2 = join(mkdtempSync(join(tmpdir(), "sh-")), "b2");
  mkdirSync(B2, { recursive: true });
  writeFileSync(join(dirname(B2), "CLAUDE.md"), "USER CONTENT");
  installInto(B2);
  if (read(join(dirname(B2), "CLAUDE.md")) !== "USER CONTENT") fail("đè mất CLAUDE.md của user");
  rmSync(dirname(A), { recursive: true, force: true });
  rmSync(dirname(B2), { recursive: true, force: true });

  // ── đường CLI ────────────────────────────────────────────────────────────
  // Mọi thứ ở trên gọi thẳng installInto(). Nhưng rào chắn chống ghi đè KHÔNG
  // nằm trong installInto — nó nằm ở đoạn arg-parsing + hỏi [y/N] phía dưới,
  // và đoạn đó chưa từng được chạy trong test. Đó là đoạn quyết định có xoá
  // file của người ta hay không, nên nó phải được chạy thật: spawn chính
  // installer như user gõ, không mô phỏng.
  {
    const self = fileURLToPath(import.meta.url);
    const run = (cwd, args, opts = {}) =>
      spawnSync(process.execPath, [self, ...args], { cwd, encoding: "utf8", ...opts });

    // Không TTY + không --yes trên thư mục có file: phải DỪNG, không được tự
    // đồng ý. Đây là ca readline trả EOF ngay — rào chắn biến mất trong im lặng.
    const C = mkrepo("cli");
    writeFileSync(join(C, "keep.txt"), "của user");
    mkdirSync(join(C, "docs"), { recursive: true });
    writeFileSync(join(C, "docs/README.md"), "docs của project tôi");
    const noTty = run(C, [], { stdio: ["pipe", "pipe", "pipe"] });
    if (noTty.status === 0) fail("không TTY mà vẫn cài — rào chắn xác nhận đã tự đồng ý");
    if (!/TTY/.test(noTty.stderr)) fail("dừng vì không TTY nhưng không nói lý do", noTty.stderr);
    if (existsSync(join(C, "scripts/validate-tasks.mjs"))) fail("đã từ chối mà vẫn ghi file");
    if (read(join(C, "docs/README.md")) !== "docs của project tôi") fail("đã từ chối mà vẫn đè docs/README.md");

    // Liệt kê file sắp đè TRƯỚC khi ghi byte nào: nếu không, "xác nhận" chỉ là
    // một câu hỏi chung chung và người ta bấm y mà không biết mất gì.
    if (!noTty.stdout.includes("docs/README.md")) fail("không liệt kê file sắp bị đè trước khi hỏi");

    // --yes bỏ qua câu hỏi và cài thật.
    const y = run(C, ["--yes"]);
    if (y.status !== 0) fail("--yes phải cài được mà không cần TTY", y.stderr);
    if (!existsSync(join(C, "scripts/validate-tasks.mjs"))) fail("--yes chạy xong mà không có validator");
    if (!existsSync(join(C, "keep.txt"))) fail("cài đè làm mất file không liên quan của project");

    // Đối số thư mục + thư mục không tồn tại + thừa đối số.
    const P2 = mkrepo("argdir");
    const viaArg = run(dirname(P2), [P2, "--yes"]);
    if (viaArg.status !== 0) fail("cài bằng đối số thư mục phải chạy được", viaArg.stderr);
    if (!existsSync(join(P2, "scripts/validate-tasks.mjs"))) fail("đối số thư mục bị bỏ qua — cài nhầm chỗ");

    // "Không exit 0" là ngưỡng quá thấp: một stack trace ENOENT cũng thoả, mà
    // với user thì crash và lời từ chối là hai chuyện khác hẳn. Đòi cả message.
    const ghost = run(C, ["/khong-co-thu-muc-nay-dau-123", "--yes"]);
    if (ghost.status === 0) fail("thư mục không tồn tại mà vẫn exit 0");
    if (!/không có thư mục/.test(ghost.stderr)) fail("thư mục không tồn tại: chết bằng stack trace thay vì nói lý do", ghost.stderr);

    // Đối số đầu phải TỒN TẠI, không thì test này pass vì lý do sai (die ở
    // bước kiểm thư mục) và vế "thừa đối số" không bao giờ được chạy.
    const extra = run(C, [P2, "b", "--yes"]);
    if (extra.status === 0) fail("thừa đối số mà vẫn chạy");
    if (!/dùng: node install\.mjs/.test(extra.stderr)) fail("thừa đối số: không in cách dùng", extra.stderr);

    rmSync(dirname(C), { recursive: true, force: true });
    rmSync(dirname(P2), { recursive: true, force: true });
  }

  // ── multi-CLI (#43) — each check runs the REAL artifact, not a mirror of it ──
  {
    // R7: the default install adds no CLI layer.
    for (const d of [".codex", ".cursor", ".agents", "AGENTS.md", ".gemini", ".qwen", ".factory", ".windsurf", ".devin", ".kiro", ".clinerules", ".opencode", ".pi", ".github/hooks"])
      if (existsSync(join(T, d))) fail(`cài mặc định (không --cli) mà vẫn sinh ${d}`);

    const self = fileURLToPath(import.meta.url);
    const M = mkrepo("multi");
    const r = spawnSync(process.execPath, [self, M, "--yes", "--cli", "codex,cursor"], { encoding: "utf8" });
    if (r.status !== 0) fail("--cli codex,cursor cài hỏng", r.stderr);
    if (spawnSync(process.execPath, [self, M, "--yes", "--cli", "vscode"], { stdio: "ignore" }).status === 0)
      fail("--cli nhận tên CLI không hỗ trợ mà vẫn exit 0");

    // Codex roles: 7 files, each line `key = <string>` parses — we emit TOML via
    // JSON.stringify, so JSON.parse is an exact check of what we emitted.
    const roles = readdirSync(join(SRC, "agents")).filter((n) => n.endsWith(".md")).length;
    const tomls = readdirSync(join(M, ".codex/agents"));
    if (tomls.length !== roles) fail(`.codex/agents có ${tomls.length}/${roles} role — thiếu adversary là mất Gate 5 trong im lặng`);
    for (const f of tomls) {
      const kv = {};
      for (const l of read(join(M, ".codex/agents", f)).split("\n").filter((l) => l && !l.startsWith("#"))) {
        const m = /^(\w+) = (.*)$/.exec(l);
        try { kv[m[1]] = JSON.parse(m[2]); } catch { fail(`${f}: dòng TOML không hợp lệ: ${l.slice(0, 80)}`); }
      }
      for (const k of ["name", "description", "developer_instructions"])
        if (!kv[k]) fail(`${f}: thiếu field bắt buộc \`${k}\` — Codex bỏ qua custom agent này`);
      if (!kv.developer_instructions.includes("docs/agents/")) fail(`${f}: developer_instructions không trỏ về docs/agents/`);
    }

    // Command → skill: no unexpanded $ARGUMENTS, every relative link resolves.
    for (const c of ["start-task", "init-project-rules"]) {
      const p = join(M, ".agents/skills", c, "SKILL.md");
      if (!existsSync(p)) fail(`thiếu skill ${c} cho Codex/Cursor — không có đường vào harness`);
      const s = read(p);
      if (s.includes("$ARGUMENTS")) fail(`${c}: còn $ARGUMENTS — cú pháp riêng của Claude, CLI khác in nguyên chữ`);
      for (const [, href] of s.matchAll(/\]\((\.\.\/[^)#]+)/g))
        if (!existsSync(join(dirname(p), href))) fail(`${c}: link ${href} trỏ vào hư không từ .agents/skills/${c}/`);
    }
    if (!existsSync(join(M, ".agents/skills/fix-bug/SKILL.md"))) fail("Codex không thấy skills — thiếu .agents/skills/");
    if (!existsSync(join(M, "AGENTS.md"))) fail("thiếu AGENTS.md — Codex/Cursor không biết repo này chạy harness");
    // #48: AGENTS.md is read by tier B/C CLIs too, which have NO hook.
    if (/(^|\. )A hook blocks/m.test(read(join(M, "AGENTS.md"))))
      fail("AGENTS.md hứa 'A hook blocks' vô điều kiện — sai trên CLI không có hook (tier B/C)");
    if (!/\[mcp_servers\."tracker"\]/.test(read(join(M, ".codex/config.toml")))) fail(".codex/config.toml không mirror MCP từ .mcp.json");
    if (!existsSync(join(M, ".cursor/mcp.json"))) fail("thiếu .cursor/mcp.json");

    // Run the hook command EXACTLY as written in hooks.json, from a subdir
    // (Codex may start there). This is what proves the wiring, not a grep.
    const hookRun = (cmd, payload, cwd) =>
      spawnSync("sh", ["-c", cmd], { cwd, input: JSON.stringify(payload), encoding: "utf8" });
    mkdirSync(join(M, "src"), { recursive: true });
    const cx = JSON.parse(read(join(M, ".codex/hooks.json"))).hooks.PreToolUse[0].hooks[0].command;
    const bash = (c) => ({ tool_name: "Bash", tool_input: { command: c }, cwd: join(M, "src") });
    if (hookRun(cx, bash("npm test && git push origin main"), join(M, "src")).status !== 2) fail("Codex PreToolUse không chặn `git push` sau &&");
    if (hookRun(cx, bash("git status"), join(M, "src")).status !== 0) fail("Codex guard chặn cả lệnh hợp lệ — hook sẽ bị tắt");

    const cu = JSON.parse(read(join(M, ".cursor/hooks.json"))).hooks;
    for (const ev of ["beforeShellExecution", "beforeReadFile"]) if (!cu[ev]?.[0]?.command) fail(`.cursor/hooks.json thiếu ${ev}`);
    // R3: Cursor treats invalid JSON from a permission hook as DENY, so the allow
    // path must print valid JSON — silence would block every command.
    const ok = hookRun(cu.beforeShellExecution[0].command, { command: "git status", cwd: M }, M);
    let okJ; try { okJ = JSON.parse(ok.stdout); } catch {}
    // #45: allow = `{}`: "allow" may skip Cursor's own approval, "ask" breaks beforeReadFile's schema.
    if (ok.status !== 0 || !okJ || typeof okJ !== "object" || "permission" in okJ)
      fail("Cursor guard: lệnh hợp lệ phải ra `{}` — JSON hỏng thì Cursor chặn MỌI lệnh, `allow` thì guard nới lỏng Cursor", ok.stdout + ok.stderr);
    const no = hookRun(cu.beforeReadFile[0].command, { file_path: join(M, ".env") }, M);
    if (no.status !== 2 || JSON.parse(no.stdout).permission !== "deny") fail("Cursor beforeReadFile không chặn đọc .env");
    // R1: the project's own deny rules count too — one list, not a copy.
    const sp = join(M, ".claude/settings.json");
    const st = JSON.parse(read(sp)); st.permissions.deny.push("Bash(rm -rf:*)"); writeFileSync(sp, JSON.stringify(st));
    if (hookRun(cu.beforeShellExecution[0].command, { command: "rm -rf build", cwd: M }, M).status !== 2)
      fail("guard bỏ qua deny rule project thêm vào .claude/settings.json — hai danh sách đã tách");

    // R4: no harness.config.json above cwd → guard still answers, never blocks everything.
    const bare = mkdtempSync(join(tmpdir(), "sh-bare-"));
    const b = spawnSync(process.execPath, [join(M, "scripts/validate-tasks.mjs"), "--guard", "cursor"],
      { cwd: bare, input: JSON.stringify({ command: "ls", cwd: bare }), encoding: "utf8" });
    if (b.status !== 0) fail("--guard phụ thuộc harness.config.json — thiếu config là chặn mọi lệnh", b.stderr);
    rmSync(bare, { recursive: true, force: true });

    // R5: preflight must see a CLI layer whose guard is unwired.
    const cxPath = join(M, ".codex/hooks.json"), saved = read(cxPath);
    writeFileSync(cxPath, '{"hooks":{}}');
    const pf = spawnSync(process.execPath, ["scripts/validate-tasks.mjs", "--preflight", "--json"], { cwd: M, encoding: "utf8" });
    if (!(JSON.parse(pf.stdout).errors ?? []).some((e) => /--guard codex/.test(e)))
      fail("preflight im lặng khi .codex/hooks.json không còn guard — deny-list Codex mất mà không ai biết");
    writeFileSync(cxPath, saved);

    // R6: re-install WITHOUT --cli refreshes the existing CLI layers.
    rmSync(join(M, ".codex/agents/adversary.toml"));
    spawnSync(process.execPath, [self, M, "--yes"], { stdio: "ignore" });
    if (!existsSync(join(M, ".codex/agents/adversary.toml"))) fail("cài lại không --cli bỏ rơi lớp Codex — nâng kernel xong role Codex cũ/thiếu");
    rmSync(dirname(M), { recursive: true, force: true });
  }

  // ── #44: every adapter, hook run EXACTLY as written with that CLI's payload ──
  {
    const self = fileURLToPath(import.meta.url);
    const A = mkrepo("every");
    // M5: a shared settings file keeps the user's own keys.
    mkdirSync(join(A, ".gemini"), { recursive: true });
    writeFileSync(join(A, ".gemini/settings.json"), JSON.stringify({ theme: "mine", context: { fileName: "MINE.md" } }));
    // #47: a user's own .devin/hooks.json is exactly what disables the legacy file.
    mkdirSync(join(A, ".devin"), { recursive: true });
    writeFileSync(join(A, ".devin/hooks.json"), JSON.stringify({ hooks: { post_write_code: [{ command: "mine-fmt" }] } }));
    { const f = join(A, "m.json"); writeFileSync(f, '{"v":1}'); mergeJson(f, { v: 2, w: 3 }, "--x", () => {});
      const m = JSON.parse(read(f)); rmSync(f);
      if (m.v !== 1 || m.w !== 3) fail("mergeJson: giá trị của user bị đè hoặc key mới không vào", JSON.stringify(m)); }
    if (spawnSync(process.execPath, [join(SRC, "kernel/scripts/validate-tasks.mjs"), "--guard", "cursorr"], { input: "{}" }).status !== 64)
      fail("--guard nhận tên CLI gõ sai — hook trỏ nhầm tên thành guard cho qua hết");
    const all = Object.keys(ADAPTERS).concat("hermes", "amp", "codewhale").join(",");
    const r = spawnSync(process.execPath, [self, A, "--yes", "--cli", all], { encoding: "utf8" });
    if (r.status !== 0) fail(`--cli ${all} cài hỏng`, r.stderr);
    if (!existsSync(join(A, ".agents/skills/start-task/SKILL.md"))) fail("--cli không sinh skill start-task");
    checkAppendix(A);
    const gem = JSON.parse(read(join(A, ".gemini/settings.json")));
    if (gem.theme !== "mine" || !gem.context.fileName.includes("MINE.md") || !gem.context.fileName.includes("AGENTS.md"))
      fail(".gemini/settings.json: merge làm mất cấu hình của user hoặc không thêm AGENTS.md", JSON.stringify(gem));
    const dv = JSON.parse(read(join(A, ".devin/hooks.json"))).hooks;
    if (dv.post_write_code?.[0]?.command !== "mine-fmt" || !JSON.stringify(dv.pre_run_command ?? "").includes("--guard windsurf"))
      fail(".devin/hooks.json: mất hook của user hoặc thiếu guard — Devin Desktop bỏ qua .windsurf/hooks.json khi file này có hook", JSON.stringify(dv));
    if (!read(join(A, ".windsurf/hooks.json")).includes("--guard windsurf")) fail(".windsurf/hooks.json (bản IDE cũ) mất guard");
    for (const f of [".gemini/agents/adversary.md", ".qwen/agents/adversary.md", ".factory/droids/adversary.md"])
      if (!existsSync(join(A, f))) fail(`thiếu ${f} — CLI đó mất role adversary, Gate 5 không còn độc lập`);
      else if (/^hooks:/m.test(read(join(A, f)))) fail(`${f} còn block hooks: của Claude — CLI khác không hiểu payload đó (#53)`);

    // #53: read-only role = hook ghi-file trong frontmatter Claude, chạy ĐÚNG lệnh
    // đã khai trong file role (không gọi thẳng validator — lệnh sai path là guard tắt).
    for (const r of ["adversary", "fsd-reviewer"]) {
      const cmd = /command:\s*(.+--guard-role)\s*$/m.exec(read(join(A, ".claude/agents", `${r}.md`)))?.[1];
      if (!cmd) fail(`.claude/agents/${r}.md không có hook --guard-role — "không sửa code" lại chỉ là prose`);
      const run = (tool_name, tool_input) => spawnSync("sh", ["-c", cmd], { cwd: A, env: { ...process.env, CLAUDE_PROJECT_DIR: A },
        input: JSON.stringify({ cwd: A, agent_type: r, tool_name, tool_input }), encoding: "utf8" }).status;
      if (run("Edit", { file_path: join(A, "src/app.ts") }) !== 2) fail(`${r}: Edit src/app.ts không bị chặn`);
      if (run("Edit", { file_path: join(A, "docs/tasks/sprint-1/A-1/09-Adversarial-Review.md") }) !== 0) fail(`${r}: ghi task doc bị chặn — role không làm được việc`);
      // #57: matcher phải có Bash, và hook phải đọc tool_input.command
      if (!/matcher:.*\bBash\b/.test(read(join(A, ".claude/agents", `${r}.md`)))) fail(`${r}: matcher thiếu Bash — sed -i src/ lọt qua (#57)`);
      if (run("Bash", { command: "sed -i '' s/a/b/ src/app.ts" }) !== 2) fail(`${r}: Bash sed -i src/app.ts không bị chặn (#57)`);
      if (run("Bash", { command: "npm test 2>&1 | tee docs/tasks/sprint-1/A-1/run.log" }) !== 0) fail(`${r}: Bash ghi log vào task folder bị chặn (#57)`);
    }

    const J = (f) => JSON.parse(read(join(A, f)));
    const sub = join(A, "src"); mkdirSync(sub, { recursive: true });
    const env = { ...process.env, GEMINI_PROJECT_DIR: A, QWEN_PROJECT_DIR: A, FACTORY_PROJECT_DIR: A,
      PLUGIN_ROOT: join(A, ".agents/plugins/spec-harness") };
    const sh = (cmd, cwd) => (p) => spawnSync("sh", ["-c", cmd], { cwd, env, input: JSON.stringify(p), encoding: "utf8" });
    const PUSH = "npm test && git push origin main", ENV = join(A, ".env");
    // [cli, runner, shell payload(cmd), read payload(path), how a DENY looks, how an ALLOW looks]
    const exitDeny = (x) => x.status === 2, exitAllow = (x) => x.status === 0 && !x.stdout.trim();
    const jsonIs = (k, v) => (x) => { try { return x.status === 0 && JSON.parse(x.stdout)[k] === v; } catch { return false; } };
    const cases = [
      ["gemini", sh(J(".gemini/settings.json").hooks.BeforeTool[0].hooks[0].command, sub),
        (c) => ({ tool_name: "run_shell_command", tool_input: { command: c } }), (p) => ({ tool_name: "read_file", tool_input: { file_path: p } }), exitDeny, exitAllow],
      ["qwen", sh(J(".qwen/settings.json").hooks.PreToolUse[0].hooks[0].command, sub),
        (c) => ({ tool_name: "run_shell_command", tool_input: { command: c } }), (p) => ({ tool_name: "read_file", tool_input: { absolute_path: p } }), exitDeny, exitAllow],
      ["copilot", sh(J(".github/hooks/spec-harness.json").hooks.preToolUse[0].bash, A),
        (c) => ({ toolName: "bash", toolArgs: JSON.stringify({ command: c }) }), (p) => ({ toolName: "view", toolArgs: JSON.stringify({ path: p }) }), exitDeny, exitAllow],
      ["droid", sh(J(".factory/hooks.json").PreToolUse[0].hooks[0].command, sub),
        (c) => ({ tool_name: "Execute", tool_input: { command: c } }), (p) => ({ tool_name: "Read", tool_input: { file_path: p } }), exitDeny, exitAllow],
      ["windsurf", sh(J(".devin/hooks.json").hooks.pre_run_command[0].command, A),
        (c) => ({ tool_info: { command_line: c } }), (p) => ({ tool_info: { file_path: p } }), exitDeny, exitAllow],
      ["devin", sh(J(".devin/hooks.v1.json").PreToolUse[0].hooks[0].command, A),
        (c) => ({ hook_event_name: "PreToolUse", tool_name: "exec", tool_input: { command: c } }), (p) => ({ hook_event_name: "PreToolUse", tool_name: "read", tool_input: { file_path: p } }), exitDeny, exitAllow],
      ["kiro", sh(J(".kiro/hooks/spec-harness.json").hooks[0].action.command, A),
        (c) => ({ tool_name: "shell", tool_input: { command: c } }), (p) => ({ tool_name: "read", tool_input: { path: p } }), exitDeny, exitAllow],
      // cwd = the dir holding hooks.json (observed e2e, agy 1.2.12), not the workspace root.
      ["antigravity", sh(J(".agents/hooks.json")["spec-harness-guard"].PreToolUse[0].hooks[0].command, join(A, ".agents")),
        (c) => ({ toolCall: { name: "run_command", args: { CommandLine: c } }, workspacePaths: [A] }),
        (p) => ({ toolCall: { name: "view_file", args: { AbsolutePath: p } }, workspacePaths: [A] }), jsonIs("decision", "deny"), jsonIs("decision", "ask")],
      // cline 3.0.65 shapes, observed e2e: run_commands{commands[]}, read_files{files: JSON string}.
      ["cline", sh(join(A, ".clinerules/hooks/PreToolUse"), sub),
        (c) => ({ hookName: "tool_call", workspaceRoots: [A], tool_call: { name: "run_commands", input: { commands: ["ls", c] } },
          preToolUse: { toolName: "run_commands", parameters: { commands: JSON.stringify(["ls", c]) } } }),
        (p) => ({ hookName: "tool_call", workspaceRoots: [A], tool_call: { name: "read_files", input: { files: [{ path: p, start_line: null }] } },
          preToolUse: { toolName: "read_files", parameters: { files: JSON.stringify([{ path: p, start_line: null }]) } } }),
        // #46: deny rewrites the denied entry (task keeps running), never cancels.
        (x) => { try { const o = JSON.parse(x.stdout), e = o.overrideInput?.commands ?? o.overrideInput?.files;
          return x.status === 0 && !o.cancel && JSON.stringify(e).includes("blocked by spec-harness"); } catch { return false; } },
        jsonIs("cancel", false)],
      ["goose", sh(J(".agents/plugins/spec-harness/hooks/hooks.json").hooks.PreToolUse[0].hooks[0].command, sub),
        (c) => ({ event: "PreToolUse", tool_name: "shell", tool_input: { command: c }, working_dir: A }), null, exitDeny, exitAllow],
    ];
    for (const [cli, run, shellP, readP, isDeny, isAllow] of cases) {
      const d = run(shellP(PUSH));
      if (!isDeny(d)) fail(`${cli}: hook không chặn \`git push\` sau && — deny-list trên ${cli} là giả`, d.stdout + d.stderr);
      if (readP && !isDeny(run(readP(ENV)))) fail(`${cli}: hook không chặn đọc .env`);
      const ok = run(shellP("git status"));
      if (!isAllow(ok)) fail(`${cli}: hook chặn/sai hợp đồng với lệnh hợp lệ — CLI sẽ chặn MỌI lệnh hoặc user tắt hook`, ok.stdout + ok.stderr);
    }
    if (!(statSync(join(A, ".clinerules/hooks/PreToolUse")).mode & 0o100)) fail("cline: hook không executable — Cline bỏ qua trong im lặng");
    // Matchers: a wrong one means the CLI never calls the hook. Tool names below
    // were read off real payloads (e2e) or the CLI's own migrate output (devin).
    const matchers = [
      ["gemini", J(".gemini/settings.json").hooks.BeforeTool[0].matcher, ["run_shell_command", "read_file"]],
      ["qwen", J(".qwen/settings.json").hooks.PreToolUse[0].matcher, ["run_shell_command", "read_file"]],
      ["droid", J(".factory/hooks.json").PreToolUse[0].matcher, ["Execute", "Read"]],
      ["devin", J(".devin/hooks.v1.json").PreToolUse[0].matcher, ["exec", "read"]],
      ["antigravity", J(".agents/hooks.json")["spec-harness-guard"].PreToolUse[0].matcher, ["run_command", "view_file"]],
      ["goose", J(".agents/plugins/spec-harness/hooks/hooks.json").hooks.PreToolUse[0].matcher, ["shell"]],
    ];
    for (const [cli, m, tools] of matchers) for (const t of tools)
      if (!new RegExp(`^(?:${m})$`).test(t)) fail(`${cli}: matcher "${m}" không khớp tool "${t}" — CLI không bao giờ gọi guard`);

    // In-process plugins: load the generated file and call it like the CLI does.
    let piH; (await import(join(A, ".pi/extensions/spec-harness.js"))).default({ on: (ev, h) => { if (ev === "tool_call") piH = h; } });
    if (!piH?.({ toolName: "bash", input: { command: PUSH } }, { cwd: A })?.block) fail("pi: extension không chặn git push");
    if (!piH({ toolName: "read", input: { path: ENV } }, { cwd: A })?.block) fail("pi: extension không chặn đọc .env");
    if (piH({ toolName: "bash", input: { command: "git status" } }, { cwd: A })) fail("pi: extension chặn lệnh hợp lệ");
    const oc = (await (await import(join(A, ".opencode/plugins/spec-harness.js"))).SpecHarness({}))["tool.execute.before"];
    const ocRun = (args) => oc({ tool: "bash" }, { args }).then(() => "ok", () => "blocked");
    if (await ocRun({ command: PUSH }) !== "blocked") fail("opencode: plugin không chặn git push");
    if (await ocRun({ filePath: ENV }) !== "blocked") fail("opencode: plugin không chặn đọc .env");
    if (await ocRun({ command: "git status" }) !== "ok") fail("opencode: plugin chặn lệnh hợp lệ");

    // M4: a fresh install is clean, and preflight sees EVERY adapter's hook go missing.
    const guards = J(".agents/spec-harness-guards.json");
    const pf0 = JSON.parse(spawnSync(process.execPath, ["scripts/validate-tasks.mjs", "--preflight", "--json"], { cwd: A, encoding: "utf8" }).stdout);
    const bad = (pf0.errors ?? []).filter((e) => e.includes("--guard"));
    if (bad.length) fail("cài mới mà preflight đã báo guard hỏng", bad.join("\n"));
    for (const [cli, file] of Object.entries(guards)) {
      if (!file) continue;
      const p = join(A, file), saved = read(p);
      writeFileSync(p, saved.replaceAll(`--guard ${cli}`, "--guard-gone"));
      const pf = spawnSync(process.execPath, ["scripts/validate-tasks.mjs", "--preflight", "--json"], { cwd: A, encoding: "utf8" });
      if (!(JSON.parse(pf.stdout).errors ?? []).some((e) => e.includes(`--guard ${cli}`)))
        fail(`preflight im lặng khi ${file} mất guard — deny-list ${cli} mất mà không ai biết`);
      writeFileSync(p, saved);
    }
    for (const c of ["hermes", "amp", "codewhale"]) if (!(c in guards)) fail(`${c} không được ghi vào manifest — cài lại sẽ bỏ rơi skills của nó`);
    // M7: re-install without --cli refreshes a deleted adapter file.
    rmSync(join(A, ".kiro/hooks/spec-harness.json"));
    writeFileSync(join(A, ".pi/extensions/spec-harness.js"), "// stale plugin from an older version\n");
    spawnSync(process.execPath, [self, A, "--yes"], { stdio: "ignore" });
    if (!read(join(A, ".pi/extensions/spec-harness.js")).includes("--guard pi")) fail("cài lại không làm mới plugin sinh ra — plugin cũ giữ lại mãi");
    if (!existsSync(join(A, ".kiro/hooks/spec-harness.json"))) fail("cài lại không --cli bỏ rơi lớp Kiro");
    rmSync(dirname(A), { recursive: true, force: true });
  }

  // --bootstrap (#64) e2e, R2b: folder script tạo ra phải qua validator 0 lỗi, và
  // một lần bị validator từ chối phải rollback để chạy lại được.
  {
    const R = mkrepo("boot");
    installInto(R);
    const g = (...a) => spawnSync("git", a, { cwd: R, encoding: "utf8" });
    g("config", "user.name", "dev"); g("config", "user.email", "d@x"); g("checkout", "-q", "-b", "feature/x");
    const cfgP = join(R, "harness.config.json"), cfg = JSON.parse(read(cfgP));
    cfg.tracker.urlPattern = "^https://t\\.x/"; writeFileSync(cfgP, JSON.stringify(cfg));
    const vec = { scope: 1, uncertainty: 0, dependency: 0, dataImpact: 0, integration: 0, testing: 1, blastRadius: 0, reversibility: 1 };
    const inp = { taskId: "B-1", taskName: "x", slug: "b", trackerUrl: "https://t.x/1", branchType: "bugfix", branch: "bugfix/B-1-b", sprintNumber: 2, complexity: { vector: vec } };
    const boot = (o) => spawnSync(process.execPath, ["scripts/validate-tasks.mjs", "--bootstrap", JSON.stringify(o)], { cwd: R, encoding: "utf8" });
    spawnSync(process.execPath, ["scripts/validate-tasks.mjs", "--triage", JSON.stringify(vec), "--branch-type", "bugfix", "--task-id", "B-1"], { cwd: R });
    const T = join(R, "docs/tasks/sprint-2/B-1-b");
    if (boot({ ...inp, slug: undefined }).status !== 2) fail("--bootstrap thiếu slug phải exit 2");
    // no counts → the validator rejects the vector's evidence: must roll back, not leave a half task.
    const bad = boot(inp);
    if (bad.status !== 1 || existsSync(join(T, "task.agent.json")) || existsSync(join(T, "00-Metadata.md")) || existsSync(join(T, ".agent-memory/orchestrator.md")))
      fail("--bootstrap bị validator từ chối phải exit 1 và rollback (task.agent.json/00/handoff)", bad.stdout + bad.stderr);
    const full = { ...inp, complexity: { vector: vec, counts: { symbol: "discount", filesTouched: 2, existingTests: 0 }, questions: [] } };
    const good = boot(full);
    if (good.status !== 0) fail("R2b: --bootstrap với input đủ không exit 0", good.stdout + good.stderr);
    const j = JSON.parse(read(join(T, "task.agent.json")));
    if (j.agents.orchestrator.status !== "skipped" || j.agents.implementer.status !== "not_applicable" || j.agents.fixer.status !== "pending" || j.attempts.bootstrap !== 1 || j.currentStage !== "fsd_write")
      fail("--bootstrap ghi sai agents/attempts/currentStage", JSON.stringify(j));
    if (!/Next agent: fsd-writer/.test(read(join(T, ".agent-memory/orchestrator.md")))) fail("--bootstrap không để lại handoff máy viết");
    if (read(join(T, "00-Metadata.md")).includes("{taskId}")) fail("--bootstrap không điền placeholder vào 00-Metadata.md");
    const before = read(join(T, "task.agent.json"));
    if (boot(full).status !== 1 || read(join(T, "task.agent.json")) !== before) fail("--bootstrap chạy lại trên task đã có phải exit 1 và không đụng task.agent.json");
    g("checkout", "-q", "-b", "develop");
    rmSync(join(R, "docs/tasks/sprint-2"), { recursive: true, force: true });
    { const r = boot(full); if (r.status !== 1 || existsSync(join(T, "task.agent.json"))) fail("--bootstrap trên nhánh protected phải exit 1 trước khi ghi gì", r.status + r.stdout + r.stderr + g("rev-parse", "--abbrev-ref", "HEAD").stdout); }
    rmSync(dirname(R), { recursive: true, force: true });
  }

  // --pack (#66) e2e trên fixture adversary thật: file mới ngoài scope phải có mặt và
  // bị đánh dấu; cap là exit code thật; thiếu key/base là lỗi dùng (2).
  {
    const root = mkdtempSync(join(tmpdir(), "sh-pack-"));
    const { P, T } = buildEvalCase(evalCases().find((c) => c.id === "clean"), root);
    writeFileSync(join(P, "src/extra.js"), "x\n");
    const pk = (...a) => spawnSync(process.execPath, ["scripts/validate-tasks.mjs", "--pack", T, ...a], { cwd: P, encoding: "utf8" });
    const r = pk("adversarial_review", "--base", "main");
    if (r.status !== 0) fail("--pack adversarial_review trên fixture sạch không exit 0", r.stderr);
    if (!/\?\? src\/extra\.js\s+← not in 03/.test(r.stdout)) fail("R3b: --pack làm mất hoặc không đánh dấu file untracked ngoài Gate 3", r.stdout.slice(-800));
    if (!r.stdout.includes("⟪docs/agents/Adversary.md⟫") || !r.stdout.includes("⟪08-Test-Evidence.md⟫") || !/⟪last handoff⟫\n### .* — implementer/.test(r.stdout) || !r.stdout.includes("# Contract: adversarial_review")) fail("--pack thiếu role file / artifact / contract", r.stdout.slice(0, 400));
    const jp = join(P, T, "task.agent.json"), jKeep = read(jp);
    writeFileSync(jp, JSON.stringify({ ...JSON.parse(jKeep), branchType: "bugfix" }));
    writeFileSync(join(P, T, ".agent-memory/fixer.md"), "### 2026-09-29 — fixer\n\n## Next Handoff\n- x\n");
    const fx = pk("implementation"), ad = pk("adversarial_review", "--base", "main");
    if (!fx.stdout.includes("⟪docs/agents/Fixer.md⟫") || !/⟪last handoff⟫\n### .* — fixer/.test(ad.stdout)) fail("--pack không đi theo routing: bugfix phải là Fixer.md và handoff của fixer", fx.stderr + ad.stderr);
    writeFileSync(jp, jKeep);
    if (pk("adversarial_review").status !== 2) fail("--pack adversarial_review thiếu --base phải exit 2");
    if (pk("bootstrap").status !== 2) fail("--pack bootstrap (không dispatch) phải exit 2");
    const cfgP = join(P, "harness.config.json"), keep = read(cfgP), cfg = JSON.parse(keep);
    writeFileSync(cfgP, JSON.stringify({ ...cfg, packCap: { ...cfg.packCap, fsd_write: 1000 } }));
    if (pk("fsd_write").status !== 1) fail("R3: rules+prose vượt packCap phải exit 1");
    writeFileSync(cfgP, JSON.stringify({ ...cfg, packWarn: 10 }));
    const w = pk("adversarial_review", "--base", "main");
    if (w.status !== 0 || !/⚠ --pack: machine part/.test(w.stderr)) fail("R3a: phần git vượt packWarn phải là warning, exit 0", w.stderr);
    delete cfg.packWarn; writeFileSync(cfgP, JSON.stringify(cfg));
    if (pk("fsd_write").status !== 2) fail("S6: thiếu packWarn phải exit 2");
    writeFileSync(cfgP, keep);
    rmSync(root, { recursive: true, force: true });
  }

  // --advance (#61) e2e trên fixture adversary thật: đỏ và xanh, và nó ghi đúng thứ
  // coordinator từng ghi tay (attempts, telemetry có giờ máy, lease còn sống).
  {
    const root = mkdtempSync(join(tmpdir(), "sh-adv-"));
    const { P, T } = buildEvalCase(evalCases().find((c) => c.id === "clean"), root);
    const adv = (...a) => spawnSync(process.execPath, ["scripts/validate-tasks.mjs", "--advance", ...a], { cwd: P, encoding: "utf8" });
    const J = () => JSON.parse(read(join(P, T, "task.agent.json")));
    if (adv(T).status !== 2) fail("--advance thiếu stage phải exit 2");
    if (adv("docs/tasks/nope", "implementation").status !== 2) fail("--advance task không tồn tại phải exit 2");
    if (adv(T, "adversarial_review").status !== 1) fail("--advance khi chưa giữ lease phải exit 1 — renew không được tự tạo lease");
    spawnSync(process.execPath, ["scripts/lease.mjs", "acquire", T], { cwd: P });
    if (adv(T, "reviewing").status !== 1) fail("--advance nhảy qua Gate 5 (task đang ở adversarial_review) mà exit 0");
    const ok = adv(T, "adversarial_review", "--cli", "claude");
    if (ok.status !== 0) fail("--advance adversarial_review trên fixture sạch không exit 0", ok.stdout + ok.stderr);
    if (!ok.stdout.includes("### ") || !ok.stdout.includes("implementer.md")) fail("--advance không in handoff cuối của implementer", ok.stdout);
    const j = J(), e = j.telemetry.at(-1);
    if (j.attempts.adversarial_review !== 1) fail("--advance không tăng attempts.adversarial_review");
    if (e.stage !== "adversarial_review" || e.attempt !== 1 || e.model !== "sonnet" || Math.abs(Date.parse(e.startedAt) - Date.now()) > 60000)
      fail("--advance ghi telemetry sai (stage/attempt/model adversary trivial=mid/giờ máy)", JSON.stringify(e));
    const v = spawnSync(process.execPath, ["scripts/validate-tasks.mjs", "--json", "--task", T], { cwd: P, encoding: "utf8" });
    if (JSON.parse(v.stdout).results[0].errors.length) fail("task.agent.json --advance ghi ra không qua validator", v.stdout);
    // #65 R5: the window --advance wrote is witnessed; the same entry typed by hand is not.
    const stampLog = read(join(P, "docs/tasks/_stamp.log"));
    if (!stampLog.includes(`${e.startedAt}\t${j.taskId}\tadversarial_review\t1\t-\tstart`)) fail("--advance không ghi dòng start vào _stamp.log", stampLog);
    const jp = join(P, T, "task.agent.json"), keep = read(jp);
    const cfgP = join(P, "harness.config.json");
    writeFileSync(jp, JSON.stringify({ ...j, createdAt: JSON.parse(read(cfgP)).stampSince, telemetry: [...j.telemetry, { stage: "implementation", tier: "mid", attempt: 1, startedAt: "2026-09-29T01:00:00Z", endedAt: "2026-09-29T01:20:00Z" }] }));
    const hand = spawnSync(process.execPath, ["scripts/validate-tasks.mjs", "--json", "--task", T], { cwd: P, encoding: "utf8" });
    const herr = JSON.parse(hand.stdout).results[0].errors;
    if (herr.filter((x) => /_stamp\.log/.test(x)).length !== 2) fail("R5: telemetry gõ tay (không có dòng _stamp.log) phải là 2 lỗi (start+end)", herr.join("\n"));
    writeFileSync(jp, keep);
    const cfgKeep = read(cfgP), cfgNo = JSON.parse(cfgKeep); delete cfgNo.stampSince; writeFileSync(cfgP, JSON.stringify(cfgNo));
    if (spawnSync(process.execPath, ["scripts/validate-tasks.mjs", "--task", T], { cwd: P }).status !== 2) fail("S6: thiếu config.stampSince phải exit 2");
    writeFileSync(cfgP, cfgKeep);
    // Closing a window is witnessed too: a re-dispatch ends the open entry, and the task still validates.
    if (adv(T, "adversarial_review", "--cli", "claude").status !== 0) fail("--advance lần 2 cùng stage không exit 0");
    const j2 = J();
    if (!j2.telemetry[0].endedAt || !read(join(P, "docs/tasks/_stamp.log")).includes(`${j2.telemetry[0].endedAt}\t${j2.taskId}\tadversarial_review\t1\t-\tend`)) fail("--advance không đóng entry cũ bằng dòng end trong _stamp.log");
    const v2 = spawnSync(process.execPath, ["scripts/validate-tasks.mjs", "--json", "--task", T], { cwd: P, encoding: "utf8" });
    if (JSON.parse(v2.stdout).results[0].errors.length) fail("telemetry do --advance ghi (2 entry) không qua R5", v2.stdout);
    // #67 slices: the fixture's 03 declares S1/S2; the task sent back to implementation
    // dispatches per slice, each attempt counted on its own key and stamped with its slice.
    const planP = join(P, T, "03-Technical-Plan.md"), planKeep = read(planP);
    const slicedPlan = planKeep.replace("| File (under `src/`) | Change Type | Reason | Related AC / Req |\n| --- | --- | --- | --- |", "| File (under `src/`) | Change Type | Reason | Related AC / Req | Slice |\n| --- | --- | --- | --- | --- |")
      .replace(/(\| `src\/discount\.js` \|.*\|)\n/, "$1 S1 |\n").replace(/(\| `test\/discount\.test\.js` \|.*\|)\n/, "$1 S2 |\n");
    writeFileSync(planP, planKeep);
    if (adv(T, "adversarial_review", "--slice", "S1").status !== 2) fail("--slice ngoài implementation phải exit 2");
    const jS = J(); writeFileSync(jp, JSON.stringify({ ...jS, currentStage: "implementation", status: "in_progress" }));
    if (adv(T, "implementation", "--slice", "S1").status !== 2) fail("--slice khi 03 không có cột Slice phải exit 2");
    writeFileSync(planP, slicedPlan);
    if (adv(T, "implementation").status !== 2) fail("S5c: 03 chia slice mà --advance implementation thiếu --slice phải exit 2");
    if (adv(T, "implementation", "--slice", "S9").status !== 2) fail("S5c: --slice không có trong 03 phải exit 2");
    const pS = spawnSync(process.execPath, ["scripts/validate-tasks.mjs", "--pack", T, "implementation", "--slice", "S2"], { cwd: P, encoding: "utf8" });
    if (pS.status !== 0 || !pS.stdout.includes("builds slice S2 only")) fail("--pack --slice S2 không nêu slice của dispatch", pS.stderr);
    if (spawnSync(process.execPath, ["scripts/validate-tasks.mjs", "--pack", T, "implementation", "--slice", "S9"], { cwd: P }).status !== 2) fail("--pack --slice ngoài 03 phải exit 2");
    // #68: pack cả plan đã chia slice = đúng cái context slice sinh ra để tránh.
    if (spawnSync(process.execPath, ["scripts/validate-tasks.mjs", "--pack", T, "implementation"], { cwd: P }).status !== 2) fail("#68: --pack implementation trên 03 chia slice mà thiếu --slice phải exit 2");
    // #70: S2 lần đầu trước S1 → exit 1, không ghi gì.
    { const before = read(jp); if (adv(T, "implementation", "--slice", "S2").status !== 1 || read(jp) !== before) fail("#70: --slice S2 trước S1 phải exit 1 và không ghi task.agent.json"); }
    for (const x of ["S1", "S2", "S1", "S1"]) { const r = adv(T, "implementation", "--slice", x, "--cli", "claude"); if (r.status !== 0) fail(`--advance implementation --slice ${x} không exit 0`, r.stderr); }
    const jS2 = J();
    const att = (x) => jS2.telemetry.filter((e) => e.slice === x).map((e) => e.attempt).join(",");
    if (att("S1") !== "1,2,3" || att("S2") !== "1" || jS2.attempts.implementation !== 3)
      fail("S5: attempt theo slice sai (S1=1,2,3 · S2=1 · attempts.implementation = slice tệ nhất = 3)", JSON.stringify(jS2.telemetry));
    const s1 = jS2.telemetry.filter((e) => e.slice === "S1");
    if (s1.length !== 3 || s1[1].attempt !== 2 || s1[1].tier !== "strong") fail("S5b: retry của một slice phải lên tier (implementer normal=mid → strong)", JSON.stringify(s1));
    if (!read(join(P, "docs/tasks/_stamp.log")).includes(`${s1[1].startedAt}\t${jS2.taskId}\timplementation\t2\tS1\tstart`)) fail("_stamp.log không ghi slice");
    // #71: entry S1 đang mở có snapshot; S1 sửa file của S2 → --advance kế tiếp exit 1, không ghi gì.
    {
      if (!s1[2].scopeSnap?.head) fail("#71: --advance --slice không lưu scopeSnap", JSON.stringify(s1[2]));
      const jKeepS = read(jp), testF = join(P, "test/discount.test.js"), testKeep = read(testF);
      writeFileSync(testF, testKeep + "\n// touched by S1\n");
      const bad = adv(T, "implementation", "--slice", "S2");
      if (bad.status !== 1 || !/slice S1 changed files outside its 03 rows: test\/discount\.test\.js/.test(bad.stderr) || read(jp) !== jKeepS) fail("#71: S1 sửa file của S2 phải exit 1, nêu file, không ghi gì", bad.stderr);
      writeFileSync(testF, testKeep);
      const srcF = join(P, "src/discount.js"), srcKeep = read(srcF);
      writeFileSync(srcF, srcKeep + "\n// S1 own file\n");
      const good = adv(T, "implementation", "--slice", "S2");
      if (good.status !== 0) fail("#71: S1 chỉ sửa file của S1 (và task folder) phải qua", good.stderr);
      writeFileSync(srcF, srcKeep); writeFileSync(jp, jKeepS);
    }
    writeFileSync(join(P, T, ".agent-memory/implementer.md"), read(join(P, T, ".agent-memory/implementer.md")).repeat(4));
    const vS = spawnSync(process.execPath, ["scripts/validate-tasks.mjs", "--json", "--task", T], { cwd: P, encoding: "utf8" });
    const vr = JSON.parse(vS.stdout).results[0];
    if (vr.errors.length || vr.warnings.some((w) => /under-reported|budget|_stamp\.log|no dispatch for/.test(w))) fail("task chia slice do --advance ghi không sạch (retry budget/under-report phải tính theo slice)", vS.stdout);
    // #69: S1's implementer moved the task on, S2 still owed → warning, S2 still dispatchable.
    writeFileSync(jp, JSON.stringify({ ...jS2, currentStage: "adversarial_review", telemetry: jS2.telemetry.filter((e) => e.stage === "implementation" && e.slice !== "S2") }));
    const vOwed = JSON.parse(spawnSync(process.execPath, ["scripts/validate-tasks.mjs", "--json", "--task", T], { cwd: P, encoding: "utf8" }).stdout).results[0];
    if (vOwed.errors.some((w) => /no dispatch for S2/.test(w)) || !vOwed.warnings.some((w) => /no dispatch for S2/.test(w))) fail("#69: S2 còn nợ trước Gate 5 phải là warning, không chặn dispatch S2", JSON.stringify(vOwed));
    if (adv(T, "adversarial_review").status !== 1) fail("#69: --advance adversarial_review khi S2 chưa dispatch phải exit 1");
    writeFileSync(jp, JSON.stringify({ ...jS2, currentStage: "adversarial_review", telemetry: jS2.telemetry.filter((e) => e.slice !== "S2") }));
    const vS4 = spawnSync(process.execPath, ["scripts/validate-tasks.mjs", "--json", "--task", T], { cwd: P, encoding: "utf8" });
    if (!JSON.parse(vS4.stdout).results[0].errors.some((w) => /no dispatch for S2/.test(w))) fail("#69: stage sau implementation đã chạy mà S2 chưa dispatch phải là error", vS4.stdout);
    const cfgS = JSON.parse(cfgKeep); delete cfgS.sliceFiles; writeFileSync(cfgP, JSON.stringify(cfgS));
    if (spawnSync(process.execPath, ["scripts/validate-tasks.mjs", "--task", T], { cwd: P }).status !== 2) fail("S6: thiếu config.sliceFiles phải exit 2");
    writeFileSync(cfgP, cfgKeep);
    writeFileSync(jp, keep); writeFileSync(planP, planKeep);
    rmSync(join(P, T, "08-Test-Evidence.md"));
    if (adv(T, "adversarial_review").status !== 1) fail("--advance bỏ qua verdict validator (08 bị xoá mà vẫn dispatch)");
    rmSync(root, { recursive: true, force: true });
  }

  // --eval (#52): model thật không chạy ở đây (tốn tiền, không tất định), nhưng mọi
  // thứ quanh nó thì phải xanh: (1) mỗi fixture đúng là điểm bàn giao cho adversary
  // — validator chỉ còn thiếu 09, không thiếu gì khác (fixture hỏng thì eval đo
  // nhầm "agent kêu fixture hỏng"); (2) scorer đỏ/xanh đúng trên 09 viết sẵn.
  {
    const cases = evalCases();
    if (!cases.some((c) => c.expect === "PASS") || !cases.some((c) => c.expect === "FAIL"))
      fail("eval cần cả case PASS lẫn FAIL — thiếu PASS thì adversary luôn nói FAIL cũng được điểm tuyệt đối");
    const trees = new Map();
    for (const c of cases) {
      if (c.expect === "FAIL" && !(c.mustMention ?? []).length) fail(`eval case ${c.id}: FAIL mà không có mustMention — đoán mò FAIL cũng qua`);
      const root = mkdtempSync(join(tmpdir(), "sh-evst-"));
      const { P, T } = buildEvalCase(c, root);
      const j = spawnSync(process.execPath, ["scripts/validate-tasks.mjs", "--json", "--task", T], { cwd: P, encoding: "utf8" });
      const res = JSON.parse(j.stdout).results[0];
      if (res.errors.length || res.warnings.length)
        fail(`eval fixture ${c.id} không sạch ở điểm bàn giao:`, [...res.errors, ...res.warnings].join("\n"));
      const leak = spawnSync("git", ["grep", "-l", "-F", c.id, "HEAD", "--", "src", "test", T, "package.json"], { cwd: P, encoding: "utf8" }).stdout.trim();
      if (c.id.length > 5 && leak) fail(`eval case ${c.id}: tên case lộ vào sandbox (${leak}) — model đọc được đáp án`);
      const tests = spawnSync("npm", ["run", "-s", "test:scope"], { cwd: P, encoding: "utf8", shell: process.platform === "win32" });
      if ((tests.status === 0) !== (c.id !== "stale-evidence"))
        fail(`eval case ${c.id}: test:scope exit ${tests.status} — chỉ stale-evidence được đỏ khi chạy lại (08 đã attest xanh)`);
      for (const [f, v] of Object.entries(c.feature ?? {}))
        if (v === null && existsSync(join(P, f))) fail(`eval case ${c.id}: ${f} = null nhưng vẫn còn trong sandbox`);
      // mỗi case phải là một cây code KHÁC: delta không được áp thì mọi case là bản sao của clean
      const tree = spawnSync("git", ["rev-parse", "HEAD:src", "HEAD:test"], { cwd: P, encoding: "utf8" }).stdout.trim();
      if (trees.has(tree)) fail(`eval case ${c.id}: code giống hệt case ${trees.get(tree)} — delta của case không được áp`);
      trees.set(tree, c.id);
      if (c.id === "clean") {
        // #56: 08 bỏ dòng AC coverage của AC-03 (vẫn còn trong cột Covers AC) → gate phải đỏ
        const e8 = join(P, T, "08-Test-Evidence.md");
        writeFileSync(e8, readFileSync(e8, "utf8").replace(/^\| AC-03 \|.*\n/m, ""));
        const r = spawnSync(process.execPath, ["scripts/validate-tasks.mjs", "--json", "--task", T], { cwd: P, encoding: "utf8" });
        if (!JSON.parse(r.stdout).results[0].errors.some((e) => e.includes("AC-03")))
          fail("acTrace #56: 08 mất dòng AC-03 mà validator vẫn xanh (AC ở cột Covers AC không phải coverage)");
      }
      rmSync(root, { recursive: true, force: true });
    }
    const c = { expect: "FAIL", mustMention: ["AC-03"] };
    const ok = (x, want, why) => { if (!x.length !== want) fail(`scoreAdversary: ${why} → ${JSON.stringify(x)}`); };
    ok(scoreAdversary(c, "**Result: FAIL** · x\nAC-03 không assert", []), true, "FAIL + nhắc đúng AC phải đậu");
    ok(scoreAdversary(c, "**Result: UNCERTAIN**\nAC-03", []), true, "UNCERTAIN trên task có bug vẫn chặn merge → đậu");
    ok(scoreAdversary(c, "**Result: FAIL**\nkhông nói gì cụ thể", []), false, "FAIL không nhắc bug = đoán mò");
    ok(scoreAdversary(c, "**Result: PASS**\nAC-03", []), false, "PASS trên task có bug");
    ok(scoreAdversary(c, null, []), false, "không có 09");
    ok(scoreAdversary({ expect: "PASS" }, "**Result: PASS | FAIL | UNCERTAIN** · {date}", []), false, "dòng template chưa điền không phải verdict");
    ok(scoreAdversary({ expect: "PASS" }, "**Verdict: PASS**", []), true, "PASS đúng trên task sạch");
    ok(scoreAdversary({ expect: "PASS" }, "**Result: UNCERTAIN**", []), false, "UNCERTAIN trên task sạch = gate không ai qua");
    ok(scoreAdversary(c, "## Verdict\n\n**FAIL.** AC-03 không assert", []), true, "heading Verdict + FAIL ở dòng sau (eval thật) → đậu");
    ok(scoreAdversary(c, "## Verdict\n\n**Gate 5: FAIL.** AC-03", []), true, "dòng kế tiếp có chữ khác trước FAIL (eval thật) → đậu");
    ok(scoreAdversary({ expect: "PASS" }, "## Verdict\n\nAC-01 ok\n\nPASS", []), false, "verdict chỉ đọc 1 dòng kế, không quét cả file");
    ok(scoreAdversary(c, "**Result: PASS**\nAC-03", [], "blocked"), true, "status=blocked thắng chữ trong 09");
    ok(scoreAdversary({ expect: "PASS" }, "**Result: FAIL**", [], "reviewing"), true, "status=reviewing = PASS");
    ok(scoreAdversary({ expect: "PASS" }, "**Result: PASS**", ["src/discount.js"]), false, "role sửa src/ là sai dù verdict đúng");
    // và cả vòng --eval end-to-end với một agent giả luôn nói PASS: phải exit 1
    const e = spawnSync(process.execPath, [fileURLToPath(import.meta.url), "--eval", "--agent",
      `node -e "require('fs').writeFileSync(process.argv[1]+'/09-Adversarial-Review.md','**Result: PASS**')" docs/tasks/sprint-1/SHOP-7-discount`],
      { encoding: "utf8" });
    if (e.status !== 1 || !/✔ clean/.test(e.stdout) || !/✖ boundary/.test(e.stdout))
      fail("--eval với agent luôn-PASS phải: clean ✔, case có bug ✖, exit 1", e.stdout + e.stderr);
  }

  rmSync(dirname(T), { recursive: true, force: true });
  console.log("✅ install self-test passed");
  process.exit(0);
}

// ── cài thật ───────────────────────────────────────────────────────────────
const yes = args.includes("--yes") || args.includes("-y");
const cliAt = args.indexOf("--cli");
const clis = cliAt === -1 ? [] : String(args[cliAt + 1] ?? "").split(",").filter(Boolean);
if (cliAt !== -1 && (!clis.length || clis.some((c) => !CLIS.includes(c))))
  die(`✖ --cli nhận danh sách phẩy trong: ${CLIS.join(", ")} (vd --cli codex,gemini)`);
const rest = args.filter((a, i) => a !== "--yes" && a !== "-y" && (cliAt === -1 || (i !== cliAt && i !== cliAt + 1)));
if (rest.length > 1) die(`dùng: node install.mjs [project-root] [--yes] [--cli ${CLIS.join(",")}]`);
const where = rest[0] ?? ".";
const target = resolve(where);
if (!existsSync(target)) die(`✖ không có thư mục: ${where}`);

// Đích rỗng = thư mục vừa tạo cho harness, không có gì để mất → cài thẳng.
// Đích có file = đang cài đè lên repo code. Trước đây đối số thư mục là bắt
// buộc và đóng vai rào chắn đó; bỏ nó đi thì xác nhận phải thay chỗ — và xác
// nhận này mạnh hơn: nó liệt kê đúng file sắp mất chứ không chỉ hỏi chung chung.
if (!yes && readdirSync(target).filter((n) => n !== ".git").length) {
  const hit = wouldClobber(target);
  console.log(`cài spec-harness vào: ${target}`);
  if (hit.length)
    console.log(`\n⚠️  sẽ ĐÈ ${hit.length} file trong project:\n${hit.map((f) => `   ${f}`).join("\n")}`);
  // Không có TTY (CI, `| tee`, docker build) thì readline trả EOF ngay và câu
  // hỏi thành "tự đồng ý" — đúng kiểu lỗi rào chắn im lặng biến mất. Chặn hẳn.
  if (!process.stdin.isTTY) die("\n✖ không có TTY để hỏi — thêm --yes nếu chắc.");
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  // Ctrl+D / Ctrl+C ở đây là "thôi khỏi", không phải crash — để nó ném AbortError
  // thì user thấy stack trace và không biết là đã huỷ hay đã ghi nửa chừng.
  const ans = await rl.question("\ntiếp tục? [y/N] ").then((s) => s.trim().toLowerCase(), () => "");
  rl.close();
  if (ans !== "y" && ans !== "yes") die("đã huỷ, không ghi gì.");
}

const { kept, hookSkipped, signpost, clobbered, clis: done } = installInto(target, clis);

console.log(`\n✅ đã cài vào ${where}`);
if (kept.length) {
  console.log("\ngiữ nguyên (đã có sẵn, không đè):");
  for (const k of kept) console.log(`   ${k}`);
}

if (clobbered.length) console.log(`
⚠️  ĐÃ ĐÈ file trùng tên của project (kernel bắt buộc đè để nâng được phiên bản):
${clobbered.map((f) => `   ${f}`).join("\n")}
    Bản cũ còn trong git: \`git diff\` để xem, \`git checkout -- <file>\` để lấy lại
    (lấy lại thì harness dùng bản của bạn — tự chịu trách nhiệm tương thích).`);

if (signpost) console.log(`
ℹ️  đã đặt biển báo ${signpost}
    Harness đứng cạnh repo code, nên PHẢI mở CLI trong ${where} — mở ở thư mục
    cha là mất skills, /start-task và guardrail deny git push. Biển báo đó bắt
    lỗi giúp bạn nếu lỡ mở nhầm.`);

console.log(`
ℹ️  Claude Code: adversary/fsd-reviewer chỉ được ghi trong tasksDir (hook trong frontmatter role).
    Hook đó TẮT tới khi bạn trust folder: mở \`claude\` ở đây một lần, đồng ý trust dialog.`);

if (done.includes("codex")) console.log(`
⚠️  Codex: hook guard (deny git push/reset --hard/.env) TẮT cho tới khi bạn trust.
    Mở codex trong project → trust project → gõ /hooks → trust 2 hook spec-harness.
    Chưa trust thì Codex bỏ qua hook trong im lặng — preflight không thấy được.
    Trust gắn với ĐƯỜNG DẪN THẬT (realpath) + hash của hook: mở qua symlink/đường khác
    hoặc sửa .codex/hooks.json = phải /hooks trust lại. Windows: Codex chưa bắn
    PreToolUse cho lệnh shell (openai/codex#24453) — trên Windows chỉ còn pre-commit/CI.`);
if (done.includes("cursor")) console.log(`
ℹ️  Cursor: guard ở .cursor/hooks.json chạy ngay. Không có hook gợi ý khi dán link task
    (beforeSubmitPrompt của Cursor không chèn được context) — gõ /start-task.`);

const trustNote = { gemini: "Gemini chỉ chạy hook project trong folder đã trust (/permissions)",
  qwen: "Qwen chỉ chạy hook project trong folder đã trust", droid: "Droid: xem /hooks tab Project",
  cline: "Cline: chặn run_commands/read_files = chỉ lệnh/file đó lỗi, task chạy tiếp; tool khác = dừng cả task; IDE cũ: bật Enable Hooks",
  copilot: "Copilot: hook repo chỉ chạy khi folder nằm trong trustedFolders (~/.copilot/config.json) — trả lời Yes lúc mở lần đầu",
  devin: "Devin CLI đọc .devin/hooks.v1.json (không đọc .windsurf/hooks.json của IDE)",
  pi: "pi: trust project để nạp .pi/extensions", kiro: "Kiro: hook có trong .kiro/hooks, bật enabled nếu IDE tắt" };
const notes = done.filter((c) => trustNote[c]).map((c) => `    · ${trustNote[c]}`);
if (notes.length) console.log(`\nℹ️  guard đã ghi, nhưng vài CLI tắt hook project tới khi bạn đồng ý:\n${notes.join("\n")}`);
if (done.includes("hermes")) console.log(`
⚠️  Hermes: hook chỉ đọc ~/.hermes/config.yaml — installer KHÔNG ghi ra ngoài repo. Tự dán:
      hooks:
        pre_tool_call:
          - command: >-
              sh -c 'f="$(git rev-parse --show-toplevel 2>/dev/null)/scripts/validate-tasks.mjs"; [ -f "$f" ] || exit 0; exec node "$f" --guard hermes'
    rồi: hermes hooks doctor   (và hermes skills trust cho .agents/skills)`);
if (done.includes("codewhale")) console.log(`
ℹ️  CodeWhale: hook tool_call_before hiện là observer chỉ-đọc (#455) — không chặn được. Chỉ có AGENTS.md + .agents/skills.`);
if (done.includes("amp")) console.log(`
ℹ️  Amp: không có hook — chỉ có AGENTS.md + .agents/skills. Guard deny = pre-commit + CI, không chặn lúc agent chạy.`);

if (hookSkipped) console.log(`
ℹ️  pre-commit hook chưa cắm (${hookSkipped}) — harness vẫn chạy bình thường.
    Gate chạy tay hoặc từ CI: node scripts/validate-tasks.mjs
    Muốn chặn ngay lúc commit thì chain vào hook sẵn có của bạn:
      "$(git rev-parse --show-toplevel)"/hooks/pre-commit || exit 1`);

console.log(`
⚠️  CHƯA CHẠY ĐƯỢC — config và ProjectRules cài ra là khung rỗng.

BẮT BUỘC: mở CLI agent trong thư mục vừa cài rồi gõ

      /init-project-rules

  Nó dò repo (.mcp.json, manifest package, git branch, CI workflow, repo anh em)
  rồi điền:
    · docs/agents/ProjectRules.md  §1 MCP · §2 guardrail · §3 nhánh · §7 lệnh
    · harness.config.json          repos · layers · models · evidenceCommandPattern

Hai việc nó KHÔNG làm được, bạn tự sửa:
    · .mcp.json                    URL server thật, rồi /mcp để login
    · acTrace.since                = ngày bật harness (task cũ hơn chỉ warning)

Xong thì:  node scripts/validate-tasks.mjs --self-check     ← phải xanh`);
