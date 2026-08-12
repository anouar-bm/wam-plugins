// Poly counterpart of entry.ts — wraps a Faust DSP compiled with
// FaustPolyDspGenerator instead of FaustMonoDspGenerator. Poly compile
// produces three assets (voice wasm+json, a shared generic mixer wasm,
// optional effect wasm+json) instead of mono's single wasm+json, so this
// needs its own loader; see scripts/build-faustide-poly-example.mjs.
//
// MIDI: Faust's own poly voice engine (FaustWebAudioDspVoice.extractPaths)
// auto-binds freq/gain/gate-named params to MIDI note-on/off by convention —
// no [midi:key] tags needed, and no ParamMgrProcessor patching needed either
// (unlike the mono path) since this is the engine those tags/conventions were
// actually designed for. GUI won't visibly move on note-on/off: each voice's
// freq/gate is private per-voice state, not a single top-level exposed param.
import { WebAudioModule } from "@webaudiomodules/sdk";
import { CompositeAudioNode, ParamMgrFactory } from "./sdk-parammgr/index.js";
import { FaustPolyDspGenerator } from "@grame/faustwasm/dist/esm-bundle/index.js";
import type { LooseFaustDspFactory, FaustPolyAudioWorkletNode } from "@grame/faustwasm";
// @ts-expect-error -- real faust-ui bundle (JS, not TS), see build script for provenance
import { FaustUI } from "./faust-ui.js";
// @ts-expect-error -- text loader, see build script
import faustUiCss from "./faust-ui.css";

declare const __PLUGIN_NAME__: string;
declare const __PLUGIN_IDENTIFIER__: string;
declare const __PLUGIN_VENDOR__: string;
declare const __VOICES__: number;
declare const __VOICE_WASM_URL__: string;
declare const __VOICE_JSON__: string;
declare const __MIXER_WASM_URL__: string;
declare const __HAS_EFFECT__: boolean;
declare const __EFFECT_WASM_URL__: string;
declare const __EFFECT_JSON__: string;

async function fetchWasmModule(url: string): Promise<WebAssembly.Module> {
  // Relative to this module's own URL, not the host page's origin — portable
  // to any static host (e.g. wam-plugins/community/).
  const res = await fetch(new URL(url, import.meta.url));
  if (!res.ok) throw new Error(`Failed to fetch WASM binary (${url}): ${res.status}`);
  return WebAssembly.compile(await res.arrayBuffer());
}

async function buildFactories(): Promise<{
  voiceFactory: LooseFaustDspFactory;
  mixerModule: WebAssembly.Module;
  effectFactory: LooseFaustDspFactory | null;
}> {
  const [voiceModule, mixerModule, effectModule] = await Promise.all([
    fetchWasmModule(__VOICE_WASM_URL__),
    fetchWasmModule(__MIXER_WASM_URL__),
    __HAS_EFFECT__ ? fetchWasmModule(__EFFECT_WASM_URL__) : Promise.resolve(null),
  ]);
  return {
    voiceFactory: { module: voiceModule, json: __VOICE_JSON__, poly: true },
    mixerModule,
    effectFactory: effectModule ? { module: effectModule, json: __EFFECT_JSON__, poly: true } : null,
  };
}

// See SamWAMS's fmsynth/index.js FaustCompositeAudioNode — same pattern as
// entry.ts's mono version, just wrapping the poly node instead.
class FaustCompositeAudioNode extends CompositeAudioNode {
  _output!: FaustPolyAudioWorkletNode;
  private _wamNode: any;

  setup(output: FaustPolyAudioWorkletNode, paramMgr: any): void {
    if (output.numberOfInputs > 0) this.connect(output as unknown as AudioNode, 0, 0);
    // Faust's poly processor listens for 'wam-midi' the same way the mono one
    // does (built into @grame/faustwasm) — but poly's own keyOn/keyOff already
    // binds freq/gain/gate by convention, so no extra bridging is needed here.
    (output as unknown as { setupWamEventHandler?: () => void }).setupWamEventHandler?.();
    this._wamNode = paramMgr;
    this._output = output;
  }

  destroy(): void {
    super.destroy();
    this._output?.destroy?.();
  }

  getParamValue(name: string): number {
    // freq/gain/gate aren't tracked by paramMgr (excluded from the poly
    // node's exposed .parameters — see setParamValue below), so read those
    // straight off the real Faust node; paramMgr is authoritative for
    // everything it does track (keeps host-automation state consistent).
    return this._wamNode.parameters.has(name)
      ? this._wamNode.getParamValue(name)
      : this._output.getParamValue(name);
  }

  setParamValue(name: string, value: number): void {
    // paramMgr's internalParamsConfig is built from the poly node's
    // .parameters map, which only exposes params outside the freq/gain/gate
    // MIDI-polyphony convention (e.g. this DSP's ratio/feedback) — Faust's
    // own poly engine intentionally keeps freq/gain/gate as private per-voice
    // state with no AudioParam. Writes to those names are silently dropped
    // by paramMgr and never reach the real DSP at all, unlike faustide's own
    // GUI, which always writes directly to the Faust node's setParamValue —
    // unconditional, no filtering — so this does the same here. Always
    // writing to both keeps ratio/feedback's automation/GUI-poll state (via
    // paramMgr) consistent with what freq/gain/gate need (a real write that
    // reaches the DSP, so the next note-on's keyOn picks up the new value).
    this._wamNode.setParamValue(name, value);
    this._output.setParamValue(name, value);
  }
}

class FaustPolyWamModule extends WebAudioModule<FaustCompositeAudioNode> {
  constructor(groupId: string, audioContext: BaseAudioContext) {
    super(groupId, audioContext);
    Object.assign(this._descriptor, {
      identifier: __PLUGIN_IDENTIFIER__,
      name: __PLUGIN_NAME__,
      vendor: __PLUGIN_VENDOR__,
      version: "1.0.0",
      apiVersion: "2.0.0",
      isInstrument: true,
      hasAudioInput: false,
      hasAudioOutput: true,
      hasMidiInput: true,
      hasMidiOutput: false,
      hasAutomationInput: true,
      hasAutomationOutput: false,
      hasMpeInput: false,
      hasMpeOutput: false,
      hasOscInput: false,
      hasOscOutput: false,
      hasSysexInput: false,
      hasSysexOutput: false,
    });
  }

  async createAudioNode(): Promise<FaustCompositeAudioNode> {
    const { voiceFactory, mixerModule, effectFactory } = await buildFactories();
    const generator = new FaustPolyDspGenerator();
    const { moduleId, instanceId } = this;
    const faustNode = (await generator.createNode(
      this.audioContext,
      __VOICES__,
      __PLUGIN_NAME__,
      voiceFactory,
      mixerModule,
      effectFactory,
      false,
      1024,
      undefined,
      { moduleId, instanceId }
    )) as unknown as FaustPolyAudioWorkletNode | null;
    if (!faustNode) throw new Error("Faust poly node creation failed");

    const paramMgrNode = await ParamMgrFactory.create(this, {
      internalParamsConfig: Object.fromEntries((faustNode as unknown as { parameters: Map<string, unknown> }).parameters),
    });

    const node = new FaustCompositeAudioNode(this.audioContext);
    node.setup(faustNode, paramMgrNode);
    return node;
  }

  // Base class signature is `createGui(): Promise<Element>` — real WAM hosts await this.
  async createGui(): Promise<Element> {
    const wamNode = this.audioNode;
    const faustNode = wamNode._output;

    // faust-ui draws labels onto <canvas> elements sized by resize(), which
    // reads real layout dimensions off the DOM — see entry.ts for why this
    // needs a real registered custom element rather than a plain div.
    class FaustGuiElement extends HTMLElement {
      private pollId: ReturnType<typeof setInterval> | null = null;

      connectedCallback() {
        const shadow = this.attachShadow({ mode: "open" });
        const style = document.createElement("style");
        style.textContent = faustUiCss as string;
        shadow.appendChild(style);
        const container = document.createElement("div");
        container.style.position = "relative";
        container.style.overflow = "auto";
        shadow.appendChild(container);

        const faustUi = new FaustUI({
          ui: faustNode.getUI?.() ?? [],
          root: container,
          listenWindowMessage: false,
          listenWindowResize: false,
        });
        faustUi.paramChangeByUI = (path: string, value: number) => {
          wamNode.setParamValue(path, value);
        };
        faustUi.mount();
        container.style.width = `${faustUi.minWidth}px`;
        container.style.height = `${faustUi.minHeight}px`;
        faustUi.resize();

        // Global/effect params only — a poly voice's own freq/gain/gate are
        // private per-voice state, not exposed here, so this won't move on
        // note-on/off the way the mono template's GUI does.
        this.pollId = setInterval(async () => {
          const values = await wamNode.getParameterValues(false);
          for (const key in values) faustUi.paramChangeByDSP(key, values[key].value);
        }, 50);
      }

      disconnectedCallback() {
        if (this.pollId) clearInterval(this.pollId);
      }
    }
    const tag = `faust-poly-gui-${this.moduleId.toLowerCase().replace(/[^a-z0-9-]/g, "")}`;
    if (!customElements.get(tag)) customElements.define(tag, FaustGuiElement);

    return document.createElement(tag);
  }

  destroyGui(): void {}
}

export default FaustPolyWamModule;
