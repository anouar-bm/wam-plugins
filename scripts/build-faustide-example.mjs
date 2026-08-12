#!/usr/bin/env node
// Builds a faustide example .dsp into a WAM2 plugin under community/faustide/<slug>/
// and registers it in community/plugins.json.
//
// Usage:
//   node scripts/build-faustide-example.mjs <exampleRelPath> [displayName] [slug]
//
// <exampleRelPath> is relative to faustide's src/static/examples/, e.g.:
//   physicalModeling/violinMIDI.dsp
//   reverb/freeverb.dsp
//
// GUI is the *real* Faust UI widget set (scripts/template/faust-ui.js, the
// same @shren/faust-ui bundle SamWAMS's own gui.js uses and faustide's own
// preview iframe renders) — not a hand-rolled control grid. See
// scripts/template/entry.ts for the WAM2 wrapper.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const FAUSTIDE_ROOT = "/Users/anouar/Code/stage/cote-dazure/temp/faustide";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "..");
const communityDir = path.join(repoRoot, "community");
const plugsJsonPath = path.join(communityDir, "plugins.json");
const templateDir = path.join(scriptDir, "template");

const [, , exampleRelPath, displayNameArg, slugArg] = process.argv;
if (!exampleRelPath) {
  console.error("Usage: node scripts/build-faustide-example.mjs <exampleRelPath> [displayName] [slug]");
  console.error("  e.g.  node scripts/build-faustide-example.mjs physicalModeling/violinMIDI.dsp");
  process.exit(1);
}

const dspSourcePath = path.join(FAUSTIDE_ROOT, "src/static/examples", exampleRelPath);
if (!fs.existsSync(dspSourcePath)) {
  console.error(`No such faustide example: ${dspSourcePath}`);
  process.exit(1);
}
const dspCode = fs.readFileSync(dspSourcePath, "utf8");

const nameMatch = dspCode.match(/declare\s+name\s+"([^"]+)"/);
const displayName = displayNameArg || nameMatch?.[1] || path.basename(exampleRelPath, ".dsp");
const slug = (slugArg || displayName).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
const identifier = `org.grame.faustide.${slug.replace(/-/g, "")}`;

console.log(`Building "${displayName}" (slug: ${slug}) from ${exampleRelPath}`);

// --- 1. Compile DSP -> wasm + json ---
const require = createRequire(import.meta.url);
globalThis.require = require;
globalThis.__filename = fileURLToPath(import.meta.url);
globalThis.__dirname = scriptDir;

const { instantiateFaustModule, LibFaust, FaustMonoDspGenerator, FaustCompiler } = await import(
  "@grame/faustwasm/dist/esm-bundle/index.js"
);
const faustModule = await instantiateFaustModule();
const compiler = new FaustCompiler(new LibFaust(faustModule));
const generator = new FaustMonoDspGenerator();
const result = await generator.compile(compiler, "plugin", dspCode, "-ftz 2");
if (!result || !result.factory) {
  throw new Error(compiler.getErrorMessage() || "Faust compilation failed (no factory)");
}
const { factory } = result;
if (!factory.code) throw new Error("Compiler produced no WASM binary");
const wasmBinary = Buffer.from(factory.code);
const compiledJs = factory.json ?? "{}";

// --- 2. esbuild bundle the real-faust-ui entry (static template, no per-build patching) ---
const { build } = await import("esbuild");
const bundle = await build({
  entryPoints: [path.join(templateDir, "entry.ts")],
  bundle: true,
  write: false,
  format: "esm",
  platform: "browser",
  loader: { ".css": "text" },
  external: ["fs", "url"],
  define: {
    __PLUGIN_NAME__: JSON.stringify(displayName),
    __PLUGIN_IDENTIFIER__: JSON.stringify(identifier),
    __PLUGIN_VENDOR__: JSON.stringify("GRAME (faustide example)"),
    __WASM_URL__: JSON.stringify("./plugin.wasm"),
    __COMPILED_JS__: JSON.stringify(compiledJs),
  },
  logLevel: "info",
});
const output = bundle.outputFiles[0];
if (!output) throw new Error("esbuild produced no output");

// --- 3. Install into community/faustide/<slug>/ ---
const outDir = path.join(communityDir, "faustide", slug);
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, "index.js"), output.text);
fs.writeFileSync(path.join(outDir, "plugin.wasm"), wasmBinary);
console.log(`Wrote ${outDir}/index.js (${(output.text.length / 1024).toFixed(1)} KB) + plugin.wasm`);

// --- 4. Upsert plugins.json entry ---
const plugins = JSON.parse(fs.readFileSync(plugsJsonPath, "utf8"));
const descMatch = dspCode.match(/declare\s+description\s+"([^"]+)"/);
const category = path.dirname(exampleRelPath).split("/")[0];
const newEntry = {
  identifier,
  name: displayName,
  vendor: "GRAME (faustide example)",
  website: `https://github.com/grame-cncm/faustide/tree/master/src/static/examples/${category}`,
  description: descMatch?.[1] ?? `Faust example (${exampleRelPath}), compiled via faustwasm to a WAM2 module.`,
  keywords: ["faust", "faustide", category.toLowerCase()],
  category: /_MIDI|_ui_MIDI|midi_/i.test(dspCode) ? ["Instrument"] : ["Effect"],
  thumbnail: "",
  path: `faustide/${slug}/index.js`,
};
const existingIdx = plugins.findIndex((p) => p.identifier === identifier);
if (existingIdx >= 0) plugins[existingIdx] = newEntry;
else plugins.push(newEntry);
fs.writeFileSync(plugsJsonPath, JSON.stringify(plugins, null, 2));
console.log(`${existingIdx >= 0 ? "Updated" : "Added"} plugins.json entry: ${identifier}`);

console.log("Done. Reload the app (http://localhost:8080) and pick it from the dropdown.");
