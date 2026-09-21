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
  symlinkSync, lstatSync, unlinkSync, chmodSync, mkdtempSync, realpathSync,
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
  for (const f of ["validate-tasks.mjs", "lease.mjs", "run-evidence.mjs"])
    chk(join(SRC, "kernel/scripts", f), join(P, "scripts", f));
  chk(join(SRC, "hooks/pre-commit"), join(P, "hooks/pre-commit"));
  return out;
}

// Version của kernel đang cài. Đọc từ package.json của NGUỒN, không hardcode —
// hai chỗ khai số thì chúng sẽ lệch, và đó đúng là bug đã có (plugin.json 0.1.0
// vs package.json 0.1.1).
function kernelVersion() {
  try { return JSON.parse(read(join(SRC, "package.json"))).version; } catch { return null; }
}

function installInto(P) {
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
  for (const f of ["validate-tasks.mjs", "lease.mjs", "run-evidence.mjs"])
    over(join(SRC, "kernel/scripts", f), join(P, "scripts", f));
  for (const f of readdirSync(join(SRC, "agents")).filter((n) => n.endsWith(".md")))
    cpSync(join(SRC, "agents", f), join(P, ".claude/agents", f));
  over(join(SRC, "hooks/pre-commit"), join(P, "hooks/pre-commit"));
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

  const hookSkipped = installHook(P);
  const signpost = installSignpost(P, wasEmpty);

  execFileSync(process.execPath, ["scripts/validate-tasks.mjs", "--self-check"], { cwd: P, stdio: "inherit" });
  return { kept, hookSkipped, signpost, clobbered };
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
  // Gate 4/5 ở evidenceMode "attested" gọi wrapper này. Thiếu nó thì evidence
  // quay về kiểu dán tay — gate vẫn xanh, chỉ là không còn kiểm được gì.
  if (spawnSync(process.execPath, ["scripts/run-evidence.mjs", "--self-check"],
      { cwd: T, stdio: "ignore" }).status !== 0) fail("run-evidence.mjs thiếu hoặc self-check đỏ");
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
      adapterMustHave: "CHƯA-ĐIỀN",
      ownMustNot: "CHƯA-ĐIỀN",
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
    // Xoá ĐÚNG folder vừa dựng: brokenTask() cũng nằm trong sprint-1, và các
    // check phía sau cần nó để chứng minh hook chặn được commit hỏng.
    rmSync(dir, { recursive: true, force: true });
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
  const langLock = [];
  for (const d of ["docs", ".claude/agents"])
    for (const f of walk(join(T, d)))
      read(f).split("\n").forEach((l, i) => {
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

  rmSync(dirname(T), { recursive: true, force: true });
  console.log("✅ install self-test passed");
  process.exit(0);
}

// ── cài thật ───────────────────────────────────────────────────────────────
const yes = args.includes("--yes") || args.includes("-y");
const rest = args.filter((a) => a !== "--yes" && a !== "-y");
if (rest.length > 1) die("dùng: node install.mjs [project-root] [--yes]");
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

const { kept, hookSkipped, signpost, clobbered } = installInto(target);

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
