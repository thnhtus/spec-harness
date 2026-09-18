#!/usr/bin/env node
// Chạy một lệnh kiểm tra rồi ghi lại bằng chứng KHÔNG bịa rẻ được.
//
//   node scripts/run-evidence.mjs -- npm run test:scope
//   node scripts/run-evidence.mjs --append docs/tasks/sprint-1/ABC-1-x/08-Test-Evidence.md -- npm run lint
//   node scripts/run-evidence.mjs --self-check
//
// Vì sao tồn tại: Gate 4/5 trước đây hỏi "văn bản này có giống output test
// không" — một câu hỏi regex trả lời được, nên một agent chưa từng chạy lệnh
// nào vẫn qua được bằng cách gõ ra `Tests: 12 passed`. Câu hỏi đúng là "lệnh
// này đã chạy và exit 0 chưa", và chỉ tiến trình thật sự chạy nó mới trả lời
// được. Wrapper này chạy lệnh rồi đóng dấu kết quả MÁY ĐO ĐƯỢC vào output.
//
// Nó không chống nổi một agent cố tình gõ tay cả khối attestation — không có gì
// làm được thế mà không có máy chủ ký. Nó chuyển việc đó từ "vô tình lọt vì gate
// lỏng" thành "cố ý bịa", và để lại `gitRev` + `durationMs` cho adversary đối
// chiếu. Đó là mức phòng thủ đúng với một harness chạy trên máy của chính dev.

import { spawnSync } from "node:child_process";
import { appendFileSync, readFileSync, existsSync } from "node:fs";

export const MARK = "--- spec-harness attestation ---";

// Thứ tự cố định: validator so field theo tên, nhưng người đọc diff thì so theo
// dòng — giữ ổn định để diff hai lần chạy chỉ hiện cái thật sự đổi.
export function renderAttestation(a) {
  return [
    MARK,
    `exitCode: ${a.exitCode}`,
    `durationMs: ${a.durationMs}`,
    `gitRev: ${a.gitRev}`,
    `startedAt: ${a.startedAt}`,
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
    startedAt: get("startedAt"),
  };
}

const gitRev = () => {
  const r = spawnSync("git", ["rev-parse", "--short", "HEAD"], { encoding: "utf8" });
  return r.status === 0 ? r.stdout.trim() : "unavailable";
};

export function runEvidence(argv) {
  const started = new Date();
  const t0 = Date.now();
  // stdio inherit KHÔNG dùng được: phải bắt output để ghi vào 08. Nhưng vẫn in
  // ra terminal, nếu không dev chạy lệnh mà không thấy gì trong lúc chờ.
  const r = spawnSync(argv[0], argv.slice(1), { encoding: "utf8", shell: false });
  const out = `${r.stdout ?? ""}${r.stderr ?? ""}`;
  process.stdout.write(out);
  // Lệnh không tồn tại: spawn lỗi, status null. Đó là exit khác 0 về mặt ý nghĩa
  // — coi là 0 thì một lệnh gõ sai tên sẽ thành bằng chứng xanh.
  const exitCode = r.error ? 127 : (r.status ?? 1);
  return {
    block: [
      "```",
      `$ ${argv.join(" ")}`,
      out.trimEnd(),
      renderAttestation({ exitCode, durationMs: Date.now() - t0, gitRev: gitRev(), startedAt: started.toISOString() }),
      "```",
    ].join("\n"),
    exitCode,
  };
}

// ── self-check ─────────────────────────────────────────────────────────────
if (process.argv[2] === "--self-check") {
  const { strict: assert } = await import("node:assert");

  const ok = runEvidence([process.execPath, "-e", "console.log('Tests: 4 passed')"]);
  assert.equal(ok.exitCode, 0, "lệnh thành công → exit 0");
  const a = parseAttestation(ok.block);
  assert.ok(a, "block phải parse được");
  assert.equal(a.exitCode, 0, "attestation ghi đúng exit code");
  assert.ok(a.durationMs >= 0 && Number.isFinite(a.durationMs), "durationMs là số thật");
  assert.ok(/^\d{4}-\d{2}-\d{2}T/.test(a.startedAt), "startedAt là ISO timestamp");

  // Đây là ca wrapper sinh ra để bắt: lệnh IN RA "passed" nhưng exit khác 0.
  // Regex cũ đọc chữ "passed" là xanh; attestation đọc exit code là đỏ.
  const lying = runEvidence([process.execPath, "-e", "console.log('Tests: 12 passed'); process.exit(1)"]);
  assert.equal(lying.exitCode, 1, "in ra passed mà exit 1 vẫn là thất bại");
  assert.equal(parseAttestation(lying.block).exitCode, 1, "attestation không tin output, tin exit code");

  // Lệnh không tồn tại phải là thất bại, không phải exit 0 im lặng.
  assert.equal(runEvidence(["khong-co-lenh-nay-dau-123"]).exitCode, 127, "lệnh không tồn tại = thất bại");

  assert.equal(parseAttestation("không có attestation ở đây"), null, "thiếu marker → null");
  // Chạy lại append vào cùng file: phải đọc được block MỚI NHẤT, không phải cũ.
  const two = `${runEvidence([process.execPath, "-e", "process.exit(1)"]).block}\n${ok.block}`;
  assert.equal(parseAttestation(two).exitCode, 0, "đọc attestation mới nhất, không phải cái đầu tiên");

  console.log("✅ run-evidence self-check passed");
  process.exit(0);
}

const sep = process.argv.indexOf("--");
if (sep === -1 || sep === process.argv.length - 1) {
  console.error("dùng: node scripts/run-evidence.mjs [--append <file>] -- <lệnh> [args...]");
  process.exit(2);
}
const appendAt = process.argv.indexOf("--append");
const target = appendAt !== -1 && appendAt < sep ? process.argv[appendAt + 1] : null;
const { block, exitCode } = runEvidence(process.argv.slice(sep + 1));

if (target) {
  if (!existsSync(target)) { console.error(`✖ không có file: ${target}`); process.exit(2); }
  appendFileSync(target, `\n${block}\n`);
  console.error(`→ đã ghi evidence vào ${target}`);
} else {
  console.error(`\n→ dán block dưới đây vào 08-Test-Evidence.md:\n`);
  console.log(block);
}
process.exit(exitCode);
