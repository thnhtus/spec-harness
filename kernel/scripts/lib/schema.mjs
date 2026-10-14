import { readFileSync } from "node:fs";
// schema.mjs — minimal JSON-Schema subset used by task.agent.schema.json (#118 split).

// ---------------------------------------------------------------------------
// Minimal JSON-Schema validator (covers the subset used by the schema)
// ---------------------------------------------------------------------------
export function validateSchema(data, schema, path = "") {
  const errs = [];
  const t = schema.type;
  const typeOf = (v) =>
    Array.isArray(v) ? "array" : v === null ? "null" : typeof v === "number" && Number.isInteger(v) ? "integer" : typeof v;

  if (t) {
    const actual = typeOf(data);
    const want = Array.isArray(t) ? t : [t];
    const ok = want.some((w) => (w === "integer" ? actual === "integer" : w === "number" ? actual === "integer" || actual === "number" : actual === w));
    if (!ok) {
      errs.push(`${path || "(root)"}: expected type ${want.join("|")}, got ${actual}`);
      return errs; // type mismatch: stop deeper checks
    }
  }
  if (schema.const !== undefined && data !== schema.const)
    errs.push(`${path}: must equal "${schema.const}" (got "${data}")`);
  if (schema.enum && !schema.enum.includes(data))
    errs.push(`${path}: "${data}" not in [${schema.enum.join(", ")}]`);
  if (typeof data === "string") {
    if (schema.minLength !== undefined && data.length < schema.minLength)
      errs.push(`${path}: too short (min ${schema.minLength})`);
    if (schema.pattern && !new RegExp(schema.pattern).test(data))
      errs.push(`${path}: does not match pattern ${schema.pattern}`);
  }
  if (typeof data === "number") {
    if (schema.minimum !== undefined && data < schema.minimum)
      errs.push(`${path}: below minimum ${schema.minimum}`);
    if (schema.maximum !== undefined && data > schema.maximum)
      errs.push(`${path}: above maximum ${schema.maximum}`);
  }
  if (schema.type === "object" || (schema.properties && typeof data === "object" && data !== null && !Array.isArray(data))) {
    for (const req of schema.required ?? [])
      if (!(req in data)) errs.push(`${path}/${req}: required field missing`);
    for (const [k, v] of Object.entries(data)) {
      const sub = schema.properties?.[k];
      if (sub) errs.push(...validateSchema(v, sub, `${path}/${k}`));
      else if (schema.additionalProperties && typeof schema.additionalProperties === "object")
        errs.push(...validateSchema(v, schema.additionalProperties, `${path}/${k}`));
    }
  }
  // allOf / if-then (only the bugfix routing rule we declared)
  for (const sub of schema.allOf ?? []) {
    if (sub.if) {
      const condErrs = validateSchema(data, sub.if, path);
      if (condErrs.length === 0 && sub.then)
        errs.push(...validateSchema(data, sub.then, path));
    } else {
      errs.push(...validateSchema(data, sub, path));
    }
  }
  return errs;
}
// ── self-check: moved here with the logic it tests ──────────────────
export async function selfCheck({ assert }) {
  const { SCHEMA_PATH } = await import("./config.mjs");
  const { REQUIRED_DENY } = await import("./guard.mjs");
  const { denyGaps, mcpGaps } = await import("./wiring.mjs");
  {
    const sch = JSON.parse(readFileSync(SCHEMA_PATH, "utf8"));
    const names = [...Object.keys(sch.properties ?? {}), ...(sch.required ?? [])];
    for (const n of names)
      assert.ok(!/clickup|jira|linear|asana|trello/i.test(n),
        `task.agent.schema.json field ${JSON.stringify(n)} names a specific tracker \u2014 every other team then stores their own URL in a field named after someone else's tool; use tracker.urlPattern for the shape instead`);
    assert.ok(sch.required?.includes("trackerUrl"), "trackerUrl must stay required \u2014 without it Gate 1 has no requirement source to read");
  }
  // The reason those four .env rules are in the list at all: `Read(.env)` denies
  // the Read tool, and the agent still has Bash.
  assert.ok(
    denyGaps(JSON.stringify({ permissions: { deny: REQUIRED_DENY.filter((r) => !r.startsWith("Bash(cat")) } }))
      .some((d) => /cat \.env/.test(d)),
    "denying Read(.env) while leaving `cat .env` open is a sign on the wrong door",
  );

  // mcpGaps: a placeholder URL kills the CLI at startup; a credential is committed.
  assert.deepEqual(mcpGaps('{"mcpServers":{"tracker":{"type":"http","url":"https://mcp.clickup.com/mcp"}}}').errors, [],
    "a real URL is fine");
  assert.deepEqual(mcpGaps('{"mcpServers":{"browser":{"command":"npx","args":["-y","x"]}}}').errors, [],
    "a local server has no url and must not be flagged");
  assert.ok(mcpGaps('{"mcpServers":{"g":{"url":"https://<git-host>/api"}}}').errors.some((e) => /ERR_INVALID_URL/.test(e)),
    "angle brackets are not a valid hostname — the CLI dies before you can fix it");
  assert.ok(mcpGaps('{"mcpServers":{"t":{"url":"https://example.com/mcp"}}}').errors.some((e) => /placeholder/.test(e)),
    "example.com parses fine and answers nothing — Gate 1 loses its source of AC");
  // The shipped template uses `gitlab.example.com`; an anchored regex would wave
  // it through, which is a check that exists without catching anything.
  assert.ok(mcpGaps('{"mcpServers":{"g":{"url":"https://gitlab.example.com/api/v4/mcp"}}}').errors
      .some((e) => /placeholder/.test(e)),
    "a placeholder subdomain is still a placeholder");
  assert.deepEqual(mcpGaps('{"mcpServers":{"t":{"url":"https://gitlab.acme-corp.com/api/v4/mcp"}}}').errors, [],
    "a real self-hosted host must not be flagged");
  assert.ok(mcpGaps('{"mcpServers":{"t":{"url":"https://x.com","headers":{"Authorization":"Bearer sk-abcdefghijklmnopqrst"}}}}').errors
      .some((e) => /credential/.test(e)),
    ".mcp.json is committed; a bearer token in it is a leak");
  // Scanning field NAMES missed this: same leak, header the list never named.
  // That is the case the check exists for, and it used to pass in silence.
  assert.ok(mcpGaps('{"mcpServers":{"t":{"url":"https://x.com","headers":{"X-Api-Token":"ghp_abcdefghijklmnopqrst"}}}}').errors
      .some((e) => /credential/.test(e)),
    "a real token under an unlisted header name is still a leak");
  // The other direction, and the reason field-name scanning had to go: a runtime
  // value is the CORRECT shape -- the token stays in the keychain or the env and
  // never enters the repo. Flagging it teaches people to switch the check off.
  for (const v of ["!printf 'Bearer %s' \"$(gh auth token)\"", "${GITHUB_TOKEN}", "$GITHUB_TOKEN", "Bearer ${TOKEN}"])
    assert.deepEqual(
      mcpGaps(JSON.stringify({ mcpServers: { t: { url: "https://x.com", headers: { Authorization: v } } } })).errors, [],
      `runtime value (${v}) is a recipe for fetching the secret, not the secret`);

}

