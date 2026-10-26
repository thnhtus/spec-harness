#!/usr/bin/env node
// Interactive helper: declare models.<cli> in harness.config.json by prompting.
// Usage: node scripts/declare-models.mjs [--cli <name>] [--config <path>]
import { createInterface } from "node:readline/promises";
import { readFileSync, writeFileSync, existsSync } from "node:fs";


const args = process.argv.slice(2);
const cliFlag = args.includes("--cli") ? args[args.indexOf("--cli") + 1] : null;
const cfgPath = args.includes("--config") ? args[args.indexOf("--config") + 1] : "harness.config.json";

if (!existsSync(cfgPath)) { console.error(`✖ không tìm thấy ${cfgPath}`); process.exit(2); }
const cfg = JSON.parse(readFileSync(cfgPath, "utf8"));
cfg.models ??= {};

const rl = createInterface({ input: process.stdin, output: process.stdout });
const ask = (q, d = "") => rl.question(d ? `${q} [${d}]: ` : `${q}: `).then((s) => s.trim() || d);

let clis = cliFlag ? [cliFlag] : Object.keys(cfg.models || {});
if (!clis.length) {
  const typed = await ask("CLI name (claude/codex/gemini/...)");
  if (!typed) { rl.close(); process.exit(0); }
  clis = [typed];
}

for (const cli of clis) {
  console.log(`\n=== ${cli} ===`);
  cfg.models[cli] ??= {};
  for (const tier of ["cheap", "mid", "strong"]) {
    const cur = cfg.models[cli][tier]?.model ?? "";
    const model = await ask(`  ${tier} model id`, cur);
    if (!model) { delete cfg.models[cli][tier]; continue; }
    const entry = { model };
    const effort = await ask(`  ${tier} effort (low/medium/high, Enter để bỏ)`, cfg.models[cli][tier]?.effort ?? "");
    if (effort) entry.effort = effort;
    if (tier === "mid") {
      const sb = await ask(`  ${tier} sliceBytes (Enter để bỏ)`, String(cfg.models[cli][tier]?.sliceBytes ?? ""));
      if (sb) entry.sliceBytes = Number(sb);
    }
    cfg.models[cli][tier] = entry;
  }
  if (Object.keys(cfg.models[cli]).length === 0) delete cfg.models[cli];
}

rl.close();
writeFileSync(cfgPath, JSON.stringify(cfg, null, 2) + "\n");
console.log(`\n✅ đã ghi ${cfgPath}`);
console.log("Chạy tiếp: node scripts/validate-tasks.mjs --self-check");
