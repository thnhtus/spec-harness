// #139/#150: which controls each CLI actually gets, and what would have to be true for a cell to
// read as anything but UNVERIFIED.
//
// Why this is its own file with no imports and no side effects: both the validator
// (--capabilities) and install.mjs --self-test need it, and importing validate-tasks.mjs runs its
// main against the cwd's config — which a packed tarball does not have. Pure data + pure functions.
//
// THE POINT: shipping an adapter proves a file was written, not that anything was ever exercised,
// and exercising it against a fake payload does not prove the real CLI calls it. Those are three
// different claims and the matrix keeps them apart. A reader must never be able to infer production
// compatibility from the installer's adapter table.
//
//   UNVERIFIED      nothing to go on — the default, never PASS
//   mechanism-only  the file is installed/armed; nobody ever ran anything against it
//   simulated       install.mjs --self-test exercises the real code path with a synthetic payload
//                   or a fake agent: the harness side is proven, the CLI side is not
//   verified        a run against the real CLI is recorded on disk
//
// `simulated` is the honest home for most of what this repo tests. It is NOT a pass: a hook that
// answers a hand-built payload correctly still tells you nothing about whether Codex ever calls it.

// The eight controls the review asked for, in its order. Renaming one is a breaking change to the
// --capabilities --json contract; adding one requires CAP_PROOF + CAP_SIMULATED entries (asserted).
export const CAPABILITIES = [
  "roleLoading",      // Nạp role/skill
  "dangerousCommand", // Chặn thao tác nguy hiểm
  "outOfScopeWrite",  // Kiểm soát file ngoài scope
  "roleDispatch",     // Dispatch role
  "gateFailure",      // Gate failure
  "resumeAfterFail",  // Resume sau lỗi
  "freshAdversary",   // Adversary độc lập
  "mcp",              // MCP
];

// The EXACT evidence that would move a cell to `verified`. Written as the thing someone has to do,
// not as a description of the feature — a cell is a claim about a run, not about code.
export const CAP_PROOF = {
  roleLoading: "the real CLI lists the role and reads its content (paste the role's own words back)",
  dangerousCommand: "issue `git reset --hard` inside the real CLI and confirm it was blocked",
  outOfScopeWrite: "in the real CLI: edit a file outside the task, create a new one, write one via shell — all three refused",
  roleDispatch: "the real CLI dispatches the role for a stage and the role receives the right artifacts (--pack output)",
  gateFailure: "a failing gate in a real run exits non-zero AND the next stage is not dispatched",
  resumeAfterFail: "after a failure, a real run resumes at the right stage without overwriting 08/09",
  freshAdversary: "the adversary ran in its own process/context, with the pid or session id recorded",
  mcp: "the real MCP server returns data the run used, and an auth failure surfaces as an error (not as a pass)",
};

// Which capabilities install.mjs --self-test exercises for real against a synthetic payload. Keyed
// by capability → what the self-test does. Applies to a CLI only when its mechanism is installed.
// `null` = the self-test has nothing for it, so the cell can only be UNVERIFIED or verified.
export const CAP_SIMULATED = {
  roleLoading: null,
  dangerousCommand: "install.mjs --self-test feeds each CLI's own hook payload shape a denied command and asserts the deny verdict",
  outOfScopeWrite: "install.mjs --self-test runs the Claude role hook (--guard-role) against Edit/Write/Bash payloads writing outside tasksDir. Only Claude wires that hook: on other CLIs the rule is prose in the role file, so their cell stays UNVERIFIED",
  roleDispatch: "install.mjs --self-test asserts --pack per stage emits the stage contract, the task artifacts and the unfiltered git file list the role must receive",
  gateFailure: "install.mjs --self-test asserts --advance exits 1 on a failing gate and writes no telemetry for the stage",
  resumeAfterFail: "install.mjs --self-test --advance with a failing gate twice: non-zero exit, no telemetry, the stage rolls back to the previous one, and 08/09 stay byte-identical",
  freshAdversary: "install.mjs --self-test drives --run-adversary with a fake agent (no 09 → exit 1, writes to src/ → exit 1)",
  // mcp: nothing simulates it either. The tracker tests drive FAKE MCP responses through the
  // coordinator's own decision code — they never go through a CLI's MCP client, and no server is
  // installed by the harness. It is UNVERIFIED on purpose (SUPPORT.md says the same for Jira/Linear).
  mcp: null,
};

// Evidence on disk, keyed cli → capability → file. A file named here must exist (installer
// self-test asserts it), and every CLI must be a known CLI name (kernel self-check asserts it).
//
// #150: `claude`/`pi` × freshAdversary were marked `verified` on evidence that does not match
// CAP_PROOF. kernel/eval/last-pass.json proves the adversary CATCHES BUGS (8/8) — it records no pid
// or session id, so it is not proof of a separate process. docs/reports/multi-cli-e2e.md proves pi
// drove the whole pipeline, but through `--cli claude` with Claude models behind a proxy, so it is
// not proof about pi either. Both are listed under CAP_INDIRECT instead: real, recorded, and short
// of what the cell claims.
export const CAP_RUNS = {};

// Recorded runs that are evidence FOR something, just not for the cell's own claim. Rendered as a
// footnote, never as a state: a reader who wants the nuance gets it, a reader skimming the table
// does not get a green cell out of it.
export const CAP_INDIRECT = {
  claude: {
    freshAdversary: "kernel/eval/last-pass.json — adversary caught 8/8 planted bugs via `claude -p --agent adversary`; no pid/session recorded, so process isolation itself is unproven",
  },
  pi: {
    freshAdversary: "docs/reports/multi-cli-e2e.md — pi drove bootstrap→reviewing with 6 fresh-context subagents, but via `--cli claude` and Claude models behind a proxy",
  },
};

// `runs` is injectable so the self-check can exercise the verified branch without shipping fake
// evidence: with CAP_RUNS empty (today's truth) that branch would otherwise be dead code, and a
// dead branch is exactly where "no evidence → PASS" would hide.
export function capState(cli, capability, mechanism, runs = CAP_RUNS) {
  const run = runs[cli]?.[capability];
  if (run) return { state: "verified", evidence: run };
  if (!mechanism) return { state: "UNVERIFIED", evidence: null };
  const sim = CAP_SIMULATED[capability];
  return sim ? { state: "simulated", evidence: sim } : { state: "mechanism-only", evidence: null };
}

// mechanisms = { <cli>: { <capability>: bool } } — a file exists and is armed. Never a run.
export function capabilityRows(clis, mechanisms = {}) {
  return [...new Set(clis)].map((cli) => ({
    cli,
    cells: Object.fromEntries(CAPABILITIES.map((c) => [c, capState(cli, c, mechanisms[cli]?.[c] === true)])),
    indirect: CAP_INDIRECT[cli] ?? null,
  }));
}

// Short header per column so the table fits a terminal; the long name is in CAP_PROOF.
export const CAP_HEADER = {
  roleLoading: "role load", dangerousCommand: "deny cmd", outOfScopeWrite: "scope write",
  roleDispatch: "dispatch", gateFailure: "gate fail", resumeAfterFail: "resume",
  freshAdversary: "adversary", mcp: "mcp",
};
const CELL = { verified: "verified", simulated: "sim", "mechanism-only": "mech", UNVERIFIED: "UNVERIFIED" };

export function renderCapabilityMatrix(rows) {
  const L = [`| CLI | ${CAPABILITIES.map((c) => CAP_HEADER[c]).join(" | ")} |`,
    `| --- | ${CAPABILITIES.map(() => "---").join(" | ")} |`];
  for (const r of rows)
    L.push(`| ${r.cli} | ${CAPABILITIES.map((c) => {
      const x = r.cells[c];
      return x.state === "verified" ? `verified (\`${x.evidence}\`)` : CELL[x.state];
    }).join(" | ")} |`);
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
    const all = Object.fromEntries(CAPABILITIES.map((c) => [c, true]));
    const R = capabilityRows(["claude", "pi", "aider"], { claude: all, aider: { dangerousCommand: true, roleLoading: true } });
    const cell = (cli, c) => R.find((r) => r.cli === cli).cells[c];

    // The default, and the two ways a cell is allowed to stop being the default.
    assert.equal(cell("pi", "dangerousCommand").state, "UNVERIFIED", "no mechanism installed → UNVERIFIED, never a pass");
    assert.equal(cell("pi", "mcp").state, "UNVERIFIED", "a capability nobody wired is UNVERIFIED");
    assert.equal(cell("aider", "dangerousCommand").state, "simulated", "armed + a self-test that exercises it = simulated");
    assert.equal(cell("aider", "roleLoading").state, "mechanism-only", "armed with no self-test behind it is only a mechanism");
    assert.ok(cell("aider", "dangerousCommand").evidence.includes("--self-test"), "simulated names what simulates it");

    // #150: `verified` must mean a run against the real CLI, and nothing currently earns it.
    assert.deepEqual(CAP_RUNS, {}, "no cell may claim `verified` without a recorded real-CLI run matching CAP_PROOF");

    // …and the verified branch still has to work for the day someone records a real run. Injected
    // rather than shipped: CAP_RUNS stays empty until a run matches CAP_PROOF exactly.
    const fake = { aider: { dangerousCommand: "docs/reports/some-real-run.md" } };
    assert.deepEqual(capState("aider", "dangerousCommand", true, fake), { state: "verified", evidence: "docs/reports/some-real-run.md" }, "a recorded run wins over the mechanism flag and names its file");
    assert.equal(capState("aider", "mcp", false, fake).state, "UNVERIFIED", "a run for one capability says nothing about another");
    assert.equal(capState("aider", "mcp", true, fake).state, "mechanism-only", "…and an unrelated run never promotes an armed mechanism either");
    assert.equal(capState("pi", "dangerousCommand", true, fake).state, "simulated", "a run for one CLI says nothing about another");
    for (const c of CAPABILITIES) assert.notEqual(cell("claude", c).state, "verified", "a fully armed install is still not a verified one");
    // …and the runs that exist are recorded as indirect, so the nuance is not lost by downgrading.
    assert.match(R.find((r) => r.cli === "claude").indirect.freshAdversary, /8\/8/, "claude's eval run stays on record as indirect evidence");
    assert.match(R.find((r) => r.cli === "pi").indirect.freshAdversary, /--cli claude/, "pi's run names the caveat that keeps it from being proof about pi");
    assert.equal(R.find((r) => r.cli === "aider").indirect, null, "a CLI with no recorded run has no footnote");

    // The eight rows the review asked for, and the contract every one of them must satisfy.
    assert.equal(CAPABILITIES.length, 8, "the review's eight capabilities, no fewer");
    assert.deepEqual(Object.keys(CAP_PROOF).sort(), [...CAPABILITIES].sort(), "every capability states the evidence that would verify it");
    assert.deepEqual(Object.keys(CAP_SIMULATED).sort(), [...CAPABILITIES].sort(), "every capability declares whether a self-test simulates it (null = none)");
    assert.deepEqual(Object.keys(CAP_HEADER).sort(), [...CAPABILITIES].sort(), "every capability has a column header");
    for (const c of CAPABILITIES) assert.ok(/real|pid|session|non-zero/.test(CAP_PROOF[c]), `${c}: CAP_PROOF must demand a real run, not a description of the feature`);

    assert.equal(R.length, 3, "one row per CLI, deduped");
    assert.match(renderCapabilityMatrix(R), /^\| CLI \| role load \|/, "matrix renders with the eight columns");
    assert.ok(!renderCapabilityMatrix(R).includes("| PASS |"), "no cell ever renders as a bare PASS");
    const roleClis = Object.keys(ROLE_DIRS);
    assert.ok(roleClis.every((c) => CLI_NAMES.includes(c)), "every CLI with a role dir is a known CLI name");
    for (const m of [CAP_RUNS, CAP_INDIRECT])
      assert.ok(Object.keys(m).every((c) => CLI_NAMES.includes(c)), "evidence is only recorded for known CLIs");
  }
}
