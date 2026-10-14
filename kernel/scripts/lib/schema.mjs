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
