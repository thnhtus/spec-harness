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
