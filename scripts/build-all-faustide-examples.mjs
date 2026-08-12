#!/usr/bin/env node
// Runs build-faustide-example.mjs over every faustide example .dsp (excluding
// the LIBRARIES/*.lib files, which aren't standalone plugins). Continues past
// individual failures (soundfile-dependent examples, non-standalone
// smartKeyboard/associatedEffects fragments, etc.) and logs a summary.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const FAUSTIDE_ROOT = "/Users/anouar/Code/stage/cote-dazure/temp/faustide";
const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const examplesRoot = path.join(FAUSTIDE_ROOT, "src/static/examples");

function walk(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "LIBRARIES") continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else if (entry.name.endsWith(".dsp")) out.push(path.relative(examplesRoot, full));
  }
  return out;
}

const dspFiles = walk(examplesRoot).sort();
console.log(`Found ${dspFiles.length} example .dsp files (excluding LIBRARIES).`);

const results = { ok: [], failed: [] };
for (const [i, relPath] of dspFiles.entries()) {
  process.stdout.write(`[${i + 1}/${dspFiles.length}] ${relPath} ... `);
  try {
    execFileSync("node", [path.join(scriptDir, "build-faustide-example.mjs"), relPath], {
      cwd: path.resolve(scriptDir, ".."),
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 60_000,
    });
    console.log("OK");
    results.ok.push(relPath);
  } catch (err) {
    const msg = (err.stderr?.toString() || err.stdout?.toString() || err.message || "").trim().split("\n").slice(-3).join(" | ");
    console.log(`FAILED: ${msg}`);
    results.failed.push({ relPath, error: msg });
  }
}

console.log(`\n${results.ok.length}/${dspFiles.length} built successfully.`);
if (results.failed.length) {
  console.log(`${results.failed.length} failed:`);
  for (const f of results.failed) console.log(`  - ${f.relPath}: ${f.error}`);
}

fs.writeFileSync(
  path.join(scriptDir, "build-all-report.json"),
  JSON.stringify(results, null, 2)
);
console.log(`\nFull report: ${path.join(scriptDir, "build-all-report.json")}`);
