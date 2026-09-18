#!/usr/bin/env node
// Lease cho một task folder: chặn hai phiên /start-task cùng chạy một task.
//
//   node scripts/lease.mjs acquire <task-folder>    # exit 1 nếu phiên khác đang giữ
//   node scripts/lease.mjs renew   <task-folder>    # gọi mỗi lần dispatch stage
//   node scripts/lease.mjs release <task-folder>
//   node scripts/lease.mjs --self-check
//
// Worktree cách ly file của repo CODE. Nó không cách ly docs/tasks/ — ở bố cục
// C mọi task dùng chung một repo harness, nên hai phiên sẽ ghi đè handoff của
// nhau mà không ai biết.
//
// Viết bằng Node để chạy được từ PowerShell/cmd, không chỉ bash: `mkdir -p`,
// `find -mmin`, `hostname`, `$$` đều không có ở đó — mà step 0 của /start-task
// là thứ chạy TRƯỚC mọi thứ khác, hỏng nó là hỏng cả lệnh.

import { mkdirSync, writeFileSync, readFileSync, statSync, rmSync } from "node:fs";
import { join } from "node:path";
import { hostname, tmpdir } from "node:os";

const TTL_MS = 30 * 60 * 1000; // lease cũ hơn 30' = phiên trước đã treo/Ctrl-C

const paths = (taskDir) => {
  const dir = join(taskDir, ".agent-memory", ".lease.d");
  return { dir, owner: join(dir, "owner") };
};

const mtime = (p) => { try { return statSync(p).mtimeMs; } catch { return null; } };

// Lease coi là chết khi — và chỉ khi — nó CŨ.
//
// Giữa mkdir và ghi owner có một khe vài ms mà thư mục đã tồn tại còn owner thì
// chưa. Đọc "owner không có" là "chết" thì mọi phiên rơi vào khe đó sẽ CƯỚP
// lease của một phiên đang sống (đo thật trên bản bash: 20 phiên song song, 7
// phiên cướp được). Nên thiếu owner mặc định là CÒN SỐNG; chỉ khi chính thư mục
// cũng đã quá TTL mới là mồ côi thật (phiên kia chết đúng khe đó).
function dead({ dir, owner }, now = Date.now()) {
  const t = mtime(owner) ?? mtime(dir);
  return t !== null && now - t > TTL_MS;
}

const stamp = ({ owner }) =>
  writeFileSync(owner, `pid=${process.pid} host=${hostname()} at=${new Date().toISOString()}`);

// mkdir chứ không phải "kiểm rồi ghi": khe giữa kiểm và ghi đúng là cái race mà
// lease sinh ra để chống. mkdir thất bại-nếu-đã-tồn-tại trong MỘT syscall.
function acquire(taskDir) {
  const p = paths(taskDir);
  mkdirSync(join(taskDir, ".agent-memory"), { recursive: true });
  try {
    mkdirSync(p.dir); // { recursive: true } sẽ KHÔNG ném khi đã tồn tại — mất hết tác dụng
  } catch (e) {
    if (e.code !== "EEXIST") throw e;
    if (!dead(p)) {
      try { console.error(readFileSync(p.owner, "utf8")); } catch {}
      console.error("→ task đang chạy ở nơi khác. DỪNG.");
      return 1;
    }
  }
  stamp(p);
  return 0;
}

const release = (taskDir) => (rmSync(paths(taskDir).dir, { recursive: true, force: true }), 0);

// TTL 30' được thiết kế để phát hiện PHIÊN ĐÃ CHẾT, nhưng stamp() chỉ chạy một
// lần lúc acquire — nên nó áp cho cả vòng đời task. Một task `high` chạy 6 stage
// với model `strong` vượt 30' là bình thường, và lúc đó lease ĐANG SỐNG bị coi
// là mồ côi: phiên thứ hai acquire được, hai phiên cùng ghi .agent-memory —
// đúng cái race mà lease sinh ra để chống.
//
// Coordinator gọi renew mỗi lần dispatch stage (cùng chỗ nó tăng attempts).
// Không cần timer hay tiến trình nền: mỗi stage là một nhịp tim tự nhiên, và
// stage dài nhất vẫn ngắn hơn TTL.
//
// KHÔNG tạo lease từ hư không — renew mà tự mkdir thì nó thành acquire bỏ qua
// kiểm tra, tức là hợp pháp hoá đúng cái cướp lease mà file này chống.
function renew(taskDir) {
  const p = paths(taskDir);
  if (mtime(p.dir) === null) {
    console.error("→ không giữ lease (chưa acquire, hoặc đã bị release). Không renew.");
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

  assert.equal(acquire(t), 0, "lease trống phải lấy được");
  assert.equal(acquire(t), 1, "lease đang sống phải bị từ chối");

  // owner cũ → tiếp quản được
  const p = paths(t);
  const old = new Date(Date.now() - TTL_MS - 60_000);
  utimesSync(p.owner, old, old);
  assert.equal(acquire(t), 0, "lease quá TTL phải tiếp quản được");

  // Khe mkdir→stamp: thư mục mới, chưa có owner → phải coi là CÒN SỐNG.
  release(t);
  mkdirSync(p.dir, { recursive: true });
  assert.equal(dead(p), false, "thiếu owner + thư mục mới = còn sống, không được cướp");
  utimesSync(p.dir, old, old);
  assert.equal(dead(p), true, "thiếu owner + thư mục quá TTL = mồ côi thật");

  // renew: giữ lease sống qua mốc TTL, nếu không task dài tự mất chỗ.
  release(t);
  acquire(t);
  utimesSync(p.owner, old, old);
  assert.equal(dead(p), true, "tiền đề: lease đã quá TTL");
  assert.equal(renew(t), 0, "đang giữ lease thì renew được");
  assert.equal(dead(p), false, "renew phải làm lease sống lại");
  assert.equal(acquire(t), 1, "renew xong, phiên khác vẫn phải bị từ chối");

  release(t);
  assert.equal(renew(t), 1, "không giữ lease thì KHÔNG renew được");
  assert.equal(mtime(p.dir), null, "renew không được tạo lease từ hư không");

  acquire(t);
  release(t);
  assert.equal(mtime(p.dir), null, "release phải xoá lease");
  rmSync(t, { recursive: true, force: true });
  console.log("✅ lease self-check passed");
  process.exit(0);
}

const [cmd, taskDir] = process.argv.slice(2);
const CMDS = { acquire, renew, release };
if (!taskDir || !CMDS[cmd]) {
  console.error("dùng: node scripts/lease.mjs acquire|renew|release <task-folder>");
  process.exit(2);
}
process.exit(CMDS[cmd](taskDir));
