#!/usr/bin/env node
// Jev triage adapter (#172) — opt-in, off without TYPESAFE_API_KEY.
const KEY = process.env.TYPESAFE_API_KEY;
if (!KEY) { console.error("jev-triage: skipped — no TYPESAFE_API_KEY"); process.exit(0); }
// Minimal: coordinator scores by hand if this fails.
console.log(JSON.stringify({ filesTouched: 0, existingTests: 0, complexity: "normal", dimensions: {}, uncertainty: 1, questions: [] }));
process.exit(0);
