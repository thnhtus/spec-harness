// #139: which controls each CLI actually gets, and what would have to be true for a cell to read as
// anything but UNVERIFIED.
//
// Why this is its own file with no imports and no side effects: both the validator (--capabilities)
// and install.mjs --self-test need it, and importing validate-tasks.mjs runs its main against the
// cwd's config — which a packed tarball does not have. Pure data + pure functions, nothing else.
//
// Shipping an adapter proves a file was written, not that the CLI ever ran: that is
// "mechanism-only". Only a run recorded on disk earns "verified". The matrix exists so a reader
// never infers production compatibility from the installer's adapter table.

export const CAPABILITIES = ["guard", "roleFiles", "freshAdversary"];

export const CAP_PROOF = {
  guard: "run the CLI, issue a denied command (`git reset --hard`), confirm the hook blocked it",
  roleFiles: "the CLI lists the role in its own agent/subagent picker",
  freshAdversary: "a recorded --run-adversary or --eval run in its own process",
};

// Evidence on disk, keyed cli → capability. Adding a CLI here without the file is caught by the
// installer self-test, which is the only place with the source tree.
export const CAP_RUNS = {
  claude: { freshAdversary: "kernel/eval/last-pass.json" },
  pi: { freshAdversary: "docs/reports/multi-cli-e2e.md" },
};

export function capState(cli, capability, mechanism) {
  const run = CAP_RUNS[cli]?.[capability];
  if (run) return { state: "verified", evidence: run };
  return mechanism ? { state: "mechanism-only", evidence: null } : { state: "UNVERIFIED", evidence: null };
}

// mechanisms = { <cli>: { guard: bool, roleFiles: bool } } — a file exists and is armed. Never a run.
export function capabilityRows(clis, mechanisms = {}) {
  return [...new Set(clis)].map((cli) => ({
    cli,
    cells: Object.fromEntries(CAPABILITIES.map((c) => [c, capState(cli, c, mechanisms[cli]?.[c] === true)])),
  }));
}

export function renderCapabilityMatrix(rows) {
  const L = ["| CLI | guard | role files | independent adversary |", "| --- | --- | --- | --- |"];
  for (const r of rows)
    L.push(`| ${r.cli} | ${CAPABILITIES.map((c) => { const x = r.cells[c]; return x.state === "verified" ? `verified (\`${x.evidence}\`)` : x.state; }).join(" | ")} |`);
  return L.join("\n");
}

// ── self-check: moved here with the logic it tests ──────────────────────────
// The two names from other modules are imported HERE, not at the top: install.mjs --self-test
// imports this file directly (it owns no config), and a top-level import chain would drag the
// whole kernel — and the config load — into the installer.
export async function selfCheck({ assert }) {
  const { CLI_NAMES } = await import("./lib/routing.mjs");
  const { ROLE_DIRS } = await import("./lib/wiring.mjs");
  {
    const R = capabilityRows(["claude", "pi", "aider"], { claude: { guard: true, roleFiles: true }, aider: { guard: true } });
    const cell = (cli, c) => R.find((r) => r.cli === cli).cells[c];
    assert.equal(cell("aider", "roleFiles").state, "UNVERIFIED", "an unwired control is UNVERIFIED, not absent");
    assert.equal(cell("aider", "freshAdversary").state, "UNVERIFIED", "no adversary.cmd and no run → UNVERIFIED");
    assert.equal(cell("aider", "guard").state, "mechanism-only", "a written hook is a mechanism, never a run");
    assert.equal(cell("claude", "freshAdversary").state, "verified", "claude has a recorded adversary run");
    assert.match(cell("claude", "freshAdversary").evidence, /\.json$/, "verified names the file that proves it");
    assert.equal(cell("pi", "freshAdversary").state, "verified", "pi ran the full pipeline (multi-cli-e2e)");
    assert.equal(R.length, 3, "one row per CLI, deduped");
    assert.match(renderCapabilityMatrix(R), /^\| CLI \|/, "matrix renders as a table");
    assert.deepEqual(Object.keys(CAP_PROOF).sort(), [...CAPABILITIES].sort(), "every capability documents the proof it needs");
    const roleClis = Object.keys(ROLE_DIRS);
    assert.ok(roleClis.every((c) => CLI_NAMES.includes(c)), "every CLI with a role dir is a known CLI name");
    assert.ok(Object.keys(CAP_RUNS).every((c) => CLI_NAMES.includes(c)), "evidence is only recorded for known CLIs");
  }
}
