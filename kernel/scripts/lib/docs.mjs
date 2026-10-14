import { CFG, DOC_ENUMS, EVIDENCE_RE, GATE4_DONE, HANDOFF_BLOCK_CAP, REPO_ROOT, enumRe } from "./config.mjs";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { calibrate, outcomeIsBlocking } from "./lifecycle.mjs";
import { NON_ANSWER_RE } from "./routing.mjs";
import * as guard from "./guard.mjs";
// Gate 2 says a blocking question left open blocks the gate. Rows look like
// "| Q-01 | … | blocking | open | …" — a table scan is enough to catch the case
// the gate exists for, and it is the one a model most often waves through.
//
// The scan needs BOTH tokens on the row, so a row missing either one used to
// vanish from the gate's view entirely -- and the default of vanishing is
// "no blocking question here", i.e. silently green. That is not a hypothetical:
// docLanguage is prose-only (SharedRules §5), but an agent writing a Vietnamese
// doc types `| blocking | chưa trả lời |` or `| chặn | open |` by reflex, and
// Gate 2 disappears while the table still looks complete. So an unrecognised
// row is an ERROR, not a skip: no data is fine, data we cannot read is not.
export const Q_ROW = /^\|\s*(Q-[A-Za-z0-9]+)\s*\|/;

export const Q_TYPE = enumRe(DOC_ENUMS.question?.type);

export const Q_STATUS = enumRe(DOC_ENUMS.question?.status);

// Which value of question.type actually blocks the gate, and which status means
// unresolved. Naming them in config too -- deriving them by position would make
// reordering the array silently change what Gate 2 blocks on.
export const Q_BLOCKS = enumRe([DOC_ENUMS.question?.blocksOn].filter(Boolean));

export const Q_UNRESOLVED = enumRe([DOC_ENUMS.question?.unresolved].filter(Boolean));


// #86/#87: template rows nobody filled. Gate 4/5 checked that 06 exists and that
// 08/09 hold one attested run, so a 06 left as `src/…` and a 09 whose AC table
// still reads AC-nn walked to `reviewing`. A row counts once its first cell is no
// longer a placeholder (`<…>`, `…`, `src/…`, AC-nn) and some other cell has text.
export const ROW_PLACEHOLDER = /^(`?<[^>]*>`?|…|`?[\w./-]*…`?|AC-nn|AC-ID|)$/;


// ---------------------------------------------------------------------------
// Self-check: node scripts/validate-tasks.mjs --self-check
// ---------------------------------------------------------------------------
// Reachable is not the same as armed. The file can be present, loaded, and
// empty -- every deny rule gone, preflight still green. These are the rules the
// harness relies on: Instructions.md forbids them in prose, and prose is what
// a model chooses to follow.
// The resume heading is a STRUCTURAL MARKER the validator splits on, so it must
// not follow config.docLanguage: a team setting docLanguage="English" would
// otherwise turn off newest-block cap enforcement without any warning. Accept
// either spelling; the docs use whichever matches their prose.
export const UPDATE_HEADING = /^## (?:Cập Nhật|Update) — /m;


// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
export function countLinesIn(text) {
  return text.replace(/\n$/, "").split("\n").length;
}


export function rel(p) {
  return relative(REPO_ROOT, p);
}


// { open: ids blocking the gate, unparsed: ids whose type/status is not an ENUM }
export function classifyQuestions(lines) {
  const open = [], unparsed = [];
  for (const l of lines) {
    const m = Q_ROW.exec(l);
    if (!m) continue;
    // An untouched template row (`| Q-01 |  | …`) states nothing -- skipping it
    // is "no data", which is the one case that legitimately stays quiet.
    if (!l.split("|").map((c) => c.trim())[2]) continue;
    if (!Q_TYPE.test(l) || !Q_STATUS.test(l)) { unparsed.push(m[1]); continue; }
    if (Q_BLOCKS.test(l) && Q_UNRESOLVED.test(l)) open.push(m[1]);
  }
  return { open, unparsed };
}


export function questionDefects(file) {
  if (!existsSync(file)) return { open: [], unparsed: [] };
  return classifyQuestions(readFileSync(file, "utf8").split("\n"));
}


// A finished role must leave a usable handoff: the coordinator routes on
// "Continue automation", and a role that silently skipped its block hands the
// next stage nothing. Checks presence, not prose.
export function handoffDefects(memDir, role) {
  const f = join(memDir, `${role}.md`);
  if (!existsSync(f)) return [`.agent-memory/${role}.md missing (SharedRules §4)`];
  const text = readFileSync(f, "utf8");
  const defects = [];
  if (!/^###\s/m.test(text)) defects.push(`.agent-memory/${role}.md has no "### " handoff block`);
  if (!/Continue automation\s*\**\s*:/i.test(text))
    defects.push(`.agent-memory/${role}.md missing "Continue automation" — coordinator routes on it`);
  if (!/Next agent\s*\**\s*:/i.test(text))
    defects.push(`.agent-memory/${role}.md missing "Next agent"`);
  return defects;
}


// The coordinator routes on the LAST handoff block. A role that finished but
// left "Continue automation: no" contradicts a task that moved on — one of the
// two is wrong, and reading only presence never caught it.
export function handoffHalted(memDir, role) {
  const f = join(memDir, `${role}.md`);
  if (!existsSync(f)) return false;
  const blocks = readFileSync(f, "utf8").split(/^### /m).slice(1);
  const last = blocks[blocks.length - 1] ?? "";
  return /Continue automation\s*\**\s*:\s*\**\s*no\b/i.test(last);
}


// How many times a role actually ran, measured independently of what the
// coordinator claims. Handoff blocks are append-only (SharedRules §4), so the
// block count is evidence `attempts` is not: the actor that would spin is the
// same one that writes `attempts`, and it will not incriminate itself.
// The other exit from an exhausted budget. split is for a task that has NOT
// shipped; a task that went over budget, still passed Gate 5 and merged cannot
// honestly be "split" -- splitInto would point at issues that do not exist --
// so the only way past the error was --no-verify. Shipped + closed + a written
// reason (not a dismissal) is a named exit with a trace; --calibrate still sees the attempts.
export function overBudgetAccepted(data) {
  const why = String(data.outcome?.overBudget ?? "").trim();
  return GATE4_DONE.has(data.status) && !!data.outcome?.closedAt && why.length >= 20 && !NON_ANSWER_RE.test(why);
}


export function handoffBlockCount(memDir, role) {
  const f = join(memDir, `${role}.md`);
  if (!existsSync(f)) return 0;
  return (readFileSync(f, "utf8").match(/^### /gm) ?? []).length;
}


// Returns array of {file, lines} for handoff blocks exceeding the cap.
export function oversizedHandoffBlocks(memDir) {
  const offenders = [];
  if (!existsSync(memDir)) return offenders;
  for (const f of readdirSync(memDir).filter((x) => x.endsWith(".md"))) {
    const text = readFileSync(join(memDir, f), "utf8");
    // Blocks delimited by headings starting "### " (per SharedRules §4).
    const parts = text.split(/^### /m).slice(1);
    parts.forEach((block, i) => {
      const lines = block.replace(/\n$/, "").split("\n").length;
      if (lines > HANDOFF_BLOCK_CAP)
        offenders.push({ file: `${f} (block ${i + 1})`, lines });
    });
  }
  return offenders;
}


// Gate 5 artifact: the adversary must record a verdict and paste output it ran
// itself. Existence alone let it copy 08 across and call that a review.
//
// Divergent evidence: the whole point of Gate 5 is not trusting 08, so the
// cheapest way to satisfy it — pasting 08's fence into 09 — is exactly what it
// must not accept. We cannot prove a command ran; we can demand the ONE artifact
// a copy cannot produce: the side-by-side table (what 08 claimed | what I got),
// which requires the adversary to have a result of its own to put in column 3.
export function staticLayerRows(t) {
  // "| `cmd` | claimed | observed | ✔ |" — the 09 template's first table.
  const rows = [];
  for (const line of t.split("\n")) {
    const cells = line.split("|").map((c) => c.trim());
    if (cells.length < 6) continue; // leading+trailing empties around 4 columns
    const [, cmd, claimed, observed] = cells;
    if (!EVIDENCE_RE.test(cmd)) continue; // header/separator/prose rows
    rows.push({ cmd, claimed, observed });
  }
  return rows;
}

// Docs are append-only: on a real repo the top table stayed the untouched
// template while the real one sat in a later `## Update` round — under a
// `### Changed files`, or under no heading at all, just the template's header
// row. So a table counts when its nearest heading (## or ###) names the section
// OR its header row matches the template's; null = neither exists anywhere.
export function filledRows(text, heading, header = null) {
  let near = "", found = false, out = [], tbl = null;
  const flush = () => {
    if (tbl && (near.startsWith(heading) || header?.test(tbl[0] ?? ""))) {
      found = true;
      out.push(...tbl.slice(1).filter((l) => !/^\|\s*-{3}/.test(l)));
    }
    tbl = null;
  };
  for (const l of text.split("\n")) {
    if (/^\|/.test(l)) { (tbl ??= []).push(l); continue; }
    flush();
    const h = l.match(/^#{2,3} (.*)/);
    if (h) { near = h[1]; if (near.startsWith(heading)) found = true; }
  }
  flush();
  if (!found) return null;
  return out.map((l) => l.split(/(?<!\\)\|/).slice(1, -1).map((c) => c.trim()))
    .filter((c) => !ROW_PLACEHOLDER.test(c[0] ?? "") && c.slice(1).some((x) => x && !ROW_PLACEHOLDER.test(x)));
}

export function notesDefects(t) {
  const rows = filledRows(t, "Changed files", /\|\s*Change Type\s*\|/i);
  return rows === null ? ["06 has no `## Changed files` section"]
    : rows.length ? [] : ["06 `Changed files` has no real row (still the template's `src/…`) — Gate 4 needs what was changed and why (Implementer §4)"];
}


// R5 (#65): telemetry windows must have a witness. In the SHOP-7 run the
// coordinator typed round-minute windows no clock produced, and the validator
// was green. --advance is now the only writer of telemetry, and it appends one
// line per start/end to {tasksDir}/_stamp.log (tab-separated: ts, taskId, stage,
// attempt, slice, start|end) — so an entry with no matching line was typed by hand.
// ponytail: the log is a plain file inside tasksDir, so an agent that means it can
// append a matching line too. This moves a typo-grade fake to a deliberate one,
// the same ceiling as _triage.log. Signed since #103 — residual ceiling is below.
// Gate 1 stops an empty FSD reaching the reviewer; a task already done + closed
// is past every reviewer, and rewriting its shipped FSD would be a retroactive
// fake. Same exit as acTrace.since, keyed on the outcome instead of a date.
export function shippedBeforeRule(data) {
  return data.status === "done" && !!data.outcome?.closedAt;
}


// #86/#87 rows: blocking from acTrace.since, but a shipped + closed task is past
// every reader of 06/08/09 — history, like Gate 1.
export function templateRowsBlock(data) {
  return outcomeIsBlocking(data) && !shippedBeforeRule(data);
}

// ── self-check: moved here with the logic it tests ──────────────────
export async function selfCheck({ assert }) {
  const { GATE4_ARTIFACTS, TASKS_DIR } = await import("./config.mjs");
  const { hasRealEvidenceIn } = await import("./evidence.mjs");
  const { roleWriteVerdict } = await import("./guard.mjs");
  const { strayTaskFolders } = await import("./lifecycle.mjs");
  const { deriveComplexity } = await import("./routing.mjs");
  const { acsMissingIn, declaredACsIn } = await import("./trace.mjs");
  const sample = CFG.evidenceSampleCommand;
  {
    const ev = GATE4_ARTIFACTS.evidence;
    const tplPath = join(TASKS_DIR, "_templates", ev);
    if (existsSync(tplPath)) {
      const raw = readFileSync(tplPath, "utf8");
      assert.equal(hasRealEvidenceIn(raw), false, `${ev} template must not satisfy Gate 4 untouched`);
      assert.equal(
        hasRealEvidenceIn(raw.replace(/`<[^`>]*>`/, `\`${sample}\``)),
        false,
        `${ev} template + a command name but no pasted output must not satisfy Gate 4`,
      );
    }
  }

  // declaredACsIn: table rows only, placeholders excluded, deduped.
  assert.deepEqual(
    declaredACsIn(
      ["| AC-ID | Criterion |", "| AC-01 | x |", "| AC-01 | duplicate |", "| AC-02 | y |", "mentions AC-99 in prose"].join("\n"),
    ),
    ["AC-01", "AC-02"],
    "AC ids from table rows",
  );
  assert.deepEqual(declaredACsIn("| AC-nn |  | open |"), [], "unfilled placeholder is not an AC");

  // acsMissingIn: word-boundary, so AC-1 must not be satisfied by AC-10.
  assert.deepEqual(acsMissingIn("| AC-01 | x |\n| AC-02 | y |", ["AC-01", "AC-03"]), ["AC-03"]);
  assert.deepEqual(acsMissingIn("| AC-10 | x |", ["AC-1"]), ["AC-1"], "AC-1 ≠ AC-10");
  // cell:"first" (#56): a "Covers AC" cell is not the AC's own coverage row
  assert.deepEqual(acsMissingIn("| Unit | `t` | AC-01, AC-03 | ok |\n| AC-01 | `a::b` | PASS |", ["AC-01", "AC-03"], "first"), ["AC-03"]);
  assert.deepEqual(acsMissingIn("| Unit | `t` | AC-01, AC-03 | ok |", ["AC-03"]), [], "without cell any table cell still counts (03 lists ACs in Related AC)");
  assert.deepEqual(acsMissingIn("| AC-10 | x |", ["AC-1"], "first"), ["AC-1"], "first cell is matched whole, AC-1 ≠ AC-10");
  // Prose, comments and "not covered" notes are not coverage. declaredACsIn is
  // strict about table rows; the reached-side must be exactly as strict.
  // #110: a stage claimed in `attempts` with no telemetry entry was never dispatched.
  {
    const body = (n) => Array.from({ length: n }, (_, i) => `l${i}`).join("\n");
    const oneBlock = body(12);
    const twoRounds = `${body(12)}\n## Cập Nhật — 2026-01-02\n${body(3)}`;
  // Same doc, English heading: the cap must behave identically, or docLanguage
  // silently disables it.
  const twoRoundsEn = `${body(12)}\n## Update — 2026-01-02\n${body(3)}`;
  assert.equal(
    twoRoundsEn.split(UPDATE_HEADING).length,
    twoRounds.split(UPDATE_HEADING).length,
    "the update marker must be language-independent — it is structure, not prose",
  );
    assert.equal(countLinesIn(oneBlock), 12, "plain count");
    assert.equal(
      countLinesIn("## Cập Nhật — " + twoRounds.split(/^## Cập Nhật — /m).pop()),
      4,
      "newest block is measured alone, not the accumulated file",
    );
  }

  // deriveComplexity: effort thresholds + risk floors. These are the cases the
  // formula exists for — a small diff in a blast-radius-3 area is not trivial.
  const v = (o) => ({ scope: 0, uncertainty: 0, dependency: 0, dataImpact: 0, integration: 0, testing: 0, blastRadius: 0, reversibility: 0, ...o });
  assert.equal(deriveComplexity(v({})).label, "trivial", "all zero → trivial");
  assert.equal(deriveComplexity(v({ scope: 2, testing: 1 })).label, "normal", "effort 3 → normal");
  assert.equal(deriveComplexity(v({ scope: 2, dependency: 2, testing: 2, integration: 1 })).label, "high", "effort 7 → high");
  assert.equal(deriveComplexity(v({ scope: 1, blastRadius: 3 })).label, "high", "tiny diff, system-wide blast → high");
  assert.equal(deriveComplexity(v({ reversibility: 4 })).label, "high", "irreversible → high even at effort 0");
  assert.equal(deriveComplexity(v({ scope: 2, uncertainty: 2, dependency: 2, dataImpact: 2, integration: 2, testing: 2 })).effort, 12, "effort maxes at 12");
  assert.equal(deriveComplexity(v({ blastRadius: 2 })).label, "normal", "feature-wide blast floors at normal");

  // classifyQuestions: table row only, both flags on the same row.
  assert.deepEqual(
    classifyQuestions(["| Q-01 | x | blocking | open |", "| Q-02 | y | blocking | answered |", "| Q-03 | z | non-blocking | open |", "prose blocking open"]).open,
    ["Q-01"],
  );
  // A row whose ENUM was translated must be LOUD, not skipped. Skipping it
  // defaults to "no blocking question" and turns Gate 2 off in silence — the
  // failure mode a Vietnamese-prose task hits by reflex, not by evasion.
  assert.deepEqual(
    classifyQuestions(["| Q-01 | x | blocking | chưa trả lời |", "| Q-02 | y | chặn | open |"]).unparsed,
    ["Q-01", "Q-02"],
    "translated Type/Status must be reported, never silently dropped",
  );
  assert.deepEqual(
    classifyQuestions(["| Q-01 | x | blocking | chưa trả lời |"]).open,
    [],
    "an unreadable row is not counted as open — it is reported separately",
  );
  assert.deepEqual(
    classifyQuestions(["| Q-nn |  | blocking \\| non-blocking | open \\| answered |", "| Q-01 |  |  |  |"]).unparsed,
    [],
    "untouched template row states nothing — no data stays quiet (empty Question cell)",
  );
  assert.deepEqual(
    classifyQuestions(["| Q-01 | x | non-blocking | deferred |"]).unparsed,
    [],
    "every documented ENUM value parses",
  );
  // Every value the config declares must parse. Retyping the list into a regex
  // is what let the template and the gate disagree; this asserts they cannot.
  for (const t of DOC_ENUMS.question?.type ?? [])
    for (const s of DOC_ENUMS.question?.status ?? [])
      assert.deepEqual(
        classifyQuestions([`| Q-01 | x | ${t} | ${s} |`]).unparsed,
        [],
        `docEnums value pair ${t}/${s} must parse — config and validator cannot disagree`,
      );

  // enumRe: longest-first, so `non-blocking` is never read as a bare `blocking`.
  // Getting this wrong flips Gate 2 into blocking on non-blocking rows.
  assert.equal(enumRe(["blocking", "non-blocking"]).test("| x | non-blocking |"), true);
  assert.equal(enumRe(["blocking"]).test("| x | non-blocking |"), false, "non-blocking must not match bare `blocking`");
  assert.equal(enumRe(["open"]).test("| x | reopened |"), false, "substring of a longer word is not a match");
  assert.equal(enumRe([]).test("anything"), false, "an empty enum matches nothing, never everything");
  assert.deepEqual(
    classifyQuestions(["| Q-01 | x | non-blocking | open |"]).open,
    [],
    "non-blocking + open must NOT block Gate 2 — the longest-first bug would",
  );

  // A missing docEnums must not silently disarm Gate 2: with no config the
  // regexes match nothing, so every filled row reads as unparsed (loud), and
  // none reads as clean (quiet). Fail closed.
  assert.equal(
    Object.keys(DOC_ENUMS).length > 0,
    true,
    "harness.config.json must declare docEnums — without it the doc tables have no schema at all",
  );

  // roleWriteVerdict (#53): inside tasksDir allowed, anything else denied.
  await guard.selfCheck({ assert });
  {
    const { mkdtempSync, mkdirSync, writeFileSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const d = mkdtempSync(join(tmpdir(), "sh-st-"));
    for (const x of ["ABC-1", "archive", "_templates", "sprint-1"]) mkdirSync(join(d, x));
    for (const x of ["ABC-1", "_templates", "sprint-1"]) writeFileSync(join(d, x, "task.agent.json"), "{}");
    assert.deepEqual(strayTaskFolders(d, "sprint-"), ["ABC-1"], "only a task.agent.json dir outside the group prefix is stray");
    assert.deepEqual(strayTaskFolders(join(d, "nope"), "sprint-"), [], "missing tasksDir is not a crash");
    rmSync(d, { recursive: true, force: true });
  }

  // handoffDefects: presence of the two fields the coordinator routes on.
}

