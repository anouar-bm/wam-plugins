#!/usr/bin/env node
// Builds a polyphonic faustide example .dsp into a WAM2 plugin under
// community/faustide/<slug>/, using FaustPolyDspGenerator instead of the
// mono pipeline in build-faustide-example.mjs. Poly compile produces three
// pieces (voice wasm+json, a shared generic mixer wasm, optional effect
// wasm+json) instead of mono's single wasm+json, so it needs its own
// build script and runtime loader (scripts/template/entry-poly.ts) —
// entry.ts can't load a poly factory.
//
// Usage:
//   node scripts/build-faustide-poly-example.mjs <exampleRelPath> [displayName] [slug]
//
// The DSP must declare `options "[nvoices:N]"` (or pass voices via a wrapper)
// and use the plain freq/gain/gate naming convention — that's what Faust's
// own poly voice engine (FaustWebAudioDspVoice.extractPaths) auto-binds to
// MIDI note-on/off, matching faustide's own "Poly Voices" setting.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const FAUSTIDE_ROOT = "/Users/anouar/Code/stage/cote-dazure/temp/faustide";
const DEFAULT_VOICES = 8;

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "..");
const communityDir = path.join(repoRoot, "community");
const plugsJsonPath = path.join(communityDir, "plugins.json");
const templateDir = path.join(scriptDir, "template");

const [, , exampleRelPath, displayNameArg, slugArg] = process.argv;
if (!exampleRelPath) {
  console.error("Usage: node scripts/build-faustide-poly-example.mjs <exampleRelPath> [displayName] [slug]");
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

const voicesMatch = dspCode.match(/\[nvoices:(\d+)\]/);
const voices = voicesMatch ? Number(voicesMatch[1]) : DEFAULT_VOICES;

console.log(`Building poly "${displayName}" (slug: ${slug}, voices: ${voices}) from ${exampleRelPath}`);

// --- 1. Compile DSP -> voice wasm+json + generic mixer wasm ---
const require = createRequire(import.meta.url);
globalThis.require = require;
globalThis.__filename = fileURLToPath(import.meta.url);
globalThis.__dirname = scriptDir;

const { instantiateFaustModule, LibFaust, FaustPolyDspGenerator, FaustCompiler } = await import(
  "@grame/faustwasm/dist/esm-bundle/index.js"
);
const faustModule = await instantiateFaustModule();
const compiler = new FaustCompiler(new LibFaust(faustModule));
const generator = new FaustPolyDspGenerator();
const result = await generator.compile(compiler, "plugin", dspCode, "-ftz 2");
if (!result || !result.voiceFactory) {
  throw new Error(compiler.getErrorMessage() || "Faust poly compilation failed (no voiceFactory)");
}
if (!result.voiceFactory.code) throw new Error("Compiler produced no voice WASM binary");
const voiceWasm = Buffer.from(result.voiceFactory.code);
const voiceJson = result.voiceFactory.json ?? "{}";
const mixerWasm = Buffer.from(result.mixerBuffer);
const hasEffect = !!result.effectFactory?.code;
const effectWasm = hasEffect ? Buffer.from(result.effectFactory.code) : null;
const effectJson = hasEffect ? result.effectFactory.json ?? "{}" : null;

// --- 2. esbuild bundle the poly entry (static template, no per-build patching) ---
const { build } = await import("esbuild");
const bundle = await build({
  entryPoints: [path.join(templateDir, "entry-poly.ts")],
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
    __VOICES__: JSON.stringify(voices),
    __VOICE_WASM_URL__: JSON.stringify("./voice.wasm"),
    __VOICE_JSON__: JSON.stringify(voiceJson),
    __MIXER_WASM_URL__: JSON.stringify("./mixer.wasm"),
    __HAS_EFFECT__: JSON.stringify(hasEffect),
    __EFFECT_WASM_URL__: JSON.stringify(hasEffect ? "./effect.wasm" : ""),
    __EFFECT_JSON__: JSON.stringify(effectJson ?? "{}"),
  },
  logLevel: "info",
});
const output = bundle.outputFiles[0];
if (!output) throw new Error("esbuild produced no output");

// --- 3. Install into community/faustide/<slug>/ ---
const outDir = path.join(communityDir, "faustide", slug);
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, "index.js"), output.text);
fs.writeFileSync(path.join(outDir, "voice.wasm"), voiceWasm);
fs.writeFileSync(path.join(outDir, "mixer.wasm"), mixerWasm);
if (hasEffect) fs.writeFileSync(path.join(outDir, "effect.wasm"), effectWasm);
console.log(`Wrote ${outDir}/index.js (${(output.text.length / 1024).toFixed(1)} KB) + voice.wasm + mixer.wasm${hasEffect ? " + effect.wasm" : ""}`);

// --- 4. Upsert plugins.json entry ---
const plugins = JSON.parse(fs.readFileSync(plugsJsonPath, "utf8"));
const descMatch = dspCode.match(/declare\s+description\s+"([^"]+)"/);
const category = path.dirname(exampleRelPath).split("/")[0];
const newEntry = {
  identifier,
  name: displayName,
  vendor: "GRAME (faustide example)",
  website: `https://github.com/grame-cncm/faustide/tree/master/src/static/examples/${category}`,
  description: descMatch?.[1] ?? `Faust poly example (${exampleRelPath}), compiled via faustwasm to a WAM2 module.`,
  keywords: ["faust", "faustide", "poly", category.toLowerCase()],
  category: ["Instrument"],
  thumbnail: "",
  path: `faustide/${slug}/index.js`,
};
const existingIdx = plugins.findIndex((p) => p.identifier === identifier);
if (existingIdx >= 0) plugins[existingIdx] = newEntry;
else plugins.push(newEntry);
fs.writeFileSync(plugsJsonPath, JSON.stringify(plugins, null, 2));
console.log(`${existingIdx >= 0 ? "Updated" : "Added"} plugins.json entry: ${identifier}`);

// Static descriptor.json, readable by a host without instantiating the
// plugin -- mirrors community/Pro54/descriptor.json's shape. Poly builds in
// this catalog are always instruments (freq/gain/gate voice convention, no
// external audio input), unlike the mono pipeline which also builds effects.
fs.writeFileSync(path.join(outDir, "descriptor.json"), JSON.stringify({
  identifier,
  name: displayName,
  vendor: "GRAME (faustide example)",
  description: newEntry.description,
  version: "1.0.0",
  apiVersion: "2.0.0",
  thumbnail: "",
  keywords: newEntry.keywords,
  isInstrument: true,
  hasMidiInput: true,
  hasMidiOutput: false,
  hasAudioInput: false,
  hasAudioOutput: true,
  website: newEntry.website,
}, null, 2));

console.log("Done. Reload the app (http://localhost:8080) and pick it from the dropdown.");
