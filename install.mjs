#!/usr/bin/env node
// spec-harness installer — cài kernel + adapter + agent + gate vào một project.
//
// Chạy được từ MỌI shell (PowerShell, cmd, bash, zsh, WSL):
//   node install.mjs <project-root>
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
  symlinkSync, lstatSync, unlinkSync, chmodSync, mkdtempSync, realpathSync,
} from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync, spawnSync } from "node:child_process";
import { tmpdir } from "node:os";

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

function installInto(P) {
  // Nguồn thiếu folder = bản phát hành hỏng (package.json `files:` quên khai,
  // hoặc tarball cắt sai). Không bắt sớm thì lỗi rơi ra dưới dạng stack trace
  // ENOENT của cpSync — đúng nguyên nhân nhưng không ai đọc ra là lỗi đóng gói.
  for (const d of ["kernel", "agents", "skills", "adapters", "commands", "hooks"])
    if (!existsSync(join(SRC, d)))
      die(`✖ nguồn thiếu "${d}/" — bản phát hành hỏng (package.json files: thiếu mục?), không cài nửa vời`);

  const kept = [];
  // Copy chỉ khi đích chưa có. Đây là thứ giữ adapter sống qua lần cài lại.
  const keep = (src, dst) => existsSync(dst) ? kept.push(dst) : cpSync(src, dst);

  for (const d of ["docs", "scripts", "hooks", ".claude/agents", ".claude/commands", ".claude/skills"])
    mkdirSync(join(P, d), { recursive: true });

  // kernel — luôn ghi đè, đây là phần dùng chung
  cpSync(join(SRC, "kernel/docs"), join(P, "docs"), { recursive: true });
  for (const f of ["validate-tasks.mjs", "lease.mjs"])
    cpSync(join(SRC, "kernel/scripts", f), join(P, "scripts", f));
  for (const f of readdirSync(join(SRC, "agents")).filter((n) => n.endsWith(".md")))
    cpSync(join(SRC, "agents", f), join(P, ".claude/agents", f));
  cpSync(join(SRC, "hooks/pre-commit"), join(P, "hooks/pre-commit"));
  try { chmodSync(join(P, "hooks/pre-commit"), 0o755); } catch {}
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
  mkdirSync(join(P, ".github/workflows"), { recursive: true });
  keep(join(SRC, "adapters/ci/validate-tasks.yml"), join(P, ".github/workflows/spec-harness.yml"));

  const hookSkipped = installHook(P);

  execFileSync(process.execPath, ["scripts/validate-tasks.mjs", "--self-check"], { cwd: P, stdio: "inherit" });
  return { kept, hookSkipped };
}

// ── self-test ──────────────────────────────────────────────────────────────
const args = process.argv.slice(2);

if (args[0] === "--self-test") {
  const fail = (m, extra) => { console.error(`✖ self-test: ${m}`); if (extra) console.error(extra); process.exit(1); };
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
  if (!existsSync(join(T, ".mcp.json"))) fail("thiếu .mcp.json");

  // Lệnh phá working tree phải bị chặn ở tầng permission, không chỉ ở văn bản.
  let settings;
  try { settings = read(join(T, ".claude/settings.json")); JSON.parse(settings); }
  catch { fail("settings.json không phải JSON hợp lệ"); }
  for (const pat of ["git push", "git reset --hard", "git stash"])
    if (!settings.includes(`Bash(${pat}`)) fail(`settings.json thiếu deny cho '${pat}' — guardrail lại chỉ là prompt`);

  if (!existsSync(join(T, ".github/workflows/spec-harness.yml")))
    fail("thiếu CI workflow — gate chỉ tồn tại ở máy dev");
  if (!existsSync(join(T, ".claude/commands/init-project-rules.md"))) fail("thiếu lệnh /init-project-rules");

  // Kernel/skill không được hardcode tên tool MCP: khoá harness vào đúng một
  // tracker, project dùng Jira/Linear là agent gọi hụt trong im lặng.
  const hard = [];
  for (const d of ["docs", ".claude/skills", ".claude/agents"])
    for (const f of walk(join(T, d)))
      read(f).split("\n").forEach((l, i) => {
        if (/mcp__[a-z]/.test(l) && !l.includes("mcp__<server>__<tool>")) hard.push(`    ${f}:${i + 1}: ${l.trim()}`);
      });
  if (hard.length) fail("còn tên tool MCP hardcode:", hard.join("\n"));

  // kernel gọi skill nào thì skill đó phải được cài kèm
  for (const f of walk(join(SRC, "kernel/docs")))
    for (const [, sk] of read(f).matchAll(/skill `([a-z0-9-]+)`/g))
      if (!existsSync(join(T, ".claude/skills", sk, "SKILL.md")))
        fail(`kernel gọi skill '${sk}' nhưng không cài kèm`);

  const pr = read(join(T, "docs/agents/ProjectRules.md"));
  if (!pr.includes("CHƯA-ĐIỀN")) fail("ProjectRules không phải template rỗng");
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
  rmSync(dirname(NG), { recursive: true, force: true });

  rmSync(dirname(T), { recursive: true, force: true });
  console.log("✅ install self-test passed");
  process.exit(0);
}

// ── cài thật ───────────────────────────────────────────────────────────────
if (args.length !== 1) die("dùng: node install.mjs <project-root>");
const target = resolve(args[0]);
if (!existsSync(target)) die(`✖ không có thư mục: ${args[0]}`);

const { kept, hookSkipped } = installInto(target);

console.log(`\n✅ đã cài vào ${args[0]}`);
if (kept.length) {
  console.log("\ngiữ nguyên (đã có sẵn, không đè):");
  for (const k of kept) console.log(`   ${k}`);
}

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
