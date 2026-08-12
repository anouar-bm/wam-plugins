// Real @webaudiomodules/sdk WAM2 module wrapping a Faust DSP.
//
// GUI: the actual @shren/faust-ui widget library (scripts/template/faust-ui.js,
// the same class SamWAMS's own gui.js uses and faustide's own preview iframe
// renders) — not a hand-rolled control grid.
//
// MIDI/automation event bus: composed from vendored @webaudiomodules/sdk-parammgr
// (scripts/template/sdk-parammgr/, copied verbatim from SamWAMS's own working
// dependency), exactly matching the architecture SamWAMS's index.js uses
// (FaustCompositeAudioNode extends CompositeAudioNode, wraps a real
// ParamMgrFactory-created node). This is what makes a real WAM host's
// `otherPlugin.audioNode.connectEvents(instanceId)` actually work — that call
// resolves against a real AudioWorkletProcessor registered in the browser's
// AudioWorklet-global WAM registry (registerProcessor(moduleId, ...) inside
// ParamMgrFactory.create), not against anything on the main thread. A plain
// duck-typed `node.scheduleEvents = () => {}` (the previous approach here)
// never gets found by that lookup, which is why routing MIDI through it threw
// "undefined is not an object (evaluating 'wam.scheduleEvents')".
import { WebAudioModule } from "@webaudiomodules/sdk";
import { CompositeAudioNode, ParamMgrFactory } from "./sdk-parammgr/index.js";
import { FaustMonoDspGenerator } from "@grame/faustwasm/dist/esm-bundle/index.js";
import type { LooseFaustDspFactory, FaustAudioWorkletNode } from "@grame/faustwasm";
// @ts-expect-error -- real faust-ui bundle (JS, not TS), see build script for provenance
import { FaustUI } from "./faust-ui.js";
// @ts-expect-error -- text loader, see build script
import faustUiCss from "./faust-ui.css";

declare const __PLUGIN_NAME__: string;
declare const __PLUGIN_IDENTIFIER__: string;
declare const __PLUGIN_VENDOR__: string;
declare const __WASM_URL__: string;
declare const __COMPILED_JS__: string;

async function buildFactory(): Promise<LooseFaustDspFactory> {
  // Relative to this module's own URL, not the host page's origin — portable
  // to any static host (e.g. wam-plugins/community/).
  const res = await fetch(new URL(__WASM_URL__, import.meta.url));
  if (!res.ok) throw new Error(`Failed to fetch WASM binary: ${res.status}`);
  const bytes = await res.arrayBuffer();
  const module = await WebAssembly.compile(bytes);
  return { module, json: __COMPILED_JS__, poly: false };
}

// See SamWAMS's fmsynth/index.js FaustCompositeAudioNode — this mirrors it
// exactly: `output` is the real Faust DSP node (audio + getUI/midiMessage),
// `paramMgr` is the real WAM2-compliant node (worklet-registered, so
// scheduleEvents/connectEvents work against real hosts and other plugins).
class FaustCompositeAudioNode extends CompositeAudioNode {
  _output!: FaustAudioWorkletNode;
  private _wamNode: any;

  setup(output: FaustAudioWorkletNode, paramMgr: any): void {
    if (output.numberOfInputs > 0) this.connect(output as unknown as AudioNode, 0, 0);
    // Tells Faust's own generated processor to listen for 'wam-midi' events
    // relayed by paramMgr's processor and forward them into midiMessage() —
    // built into @grame/faustwasm, see its setupWamEventHandler().
    (output as unknown as { setupWamEventHandler?: () => void }).setupWamEventHandler?.();
    this._wamNode = paramMgr;
    this._output = output;
  }

  destroy(): void {
    super.destroy();
    this._output?.destroy?.();
  }

  getParamValue(name: string): number {
    return this._wamNode.getParamValue(name);
  }

  setParamValue(name: string, value: number): void {
    return this._wamNode.setParamValue(name, value);
  }
}

class FaustWamModule extends WebAudioModule<FaustCompositeAudioNode> {
  constructor(groupId: string, audioContext: BaseAudioContext) {
    super(groupId, audioContext);
    Object.assign(this._descriptor, {
      identifier: __PLUGIN_IDENTIFIER__,
      name: __PLUGIN_NAME__,
      vendor: __PLUGIN_VENDOR__,
      version: "1.0.0",
      apiVersion: "2.0.0",
      // isInstrument/hasAudioInput are corrected in createAudioNode() once the
      // real Faust node's channel count is known -- entry.ts's mono pipeline
      // builds both instruments (violin, organ, ...) and effects (reverb,
      // distortion chains, ...), so a fixed guess here would be wrong for one
      // of the two. These are placeholders only.
      isInstrument: true,
      hasAudioInput: false,
      hasAudioOutput: true,
      // The composite node's own worklet processor participates in the real
      // WAM MIDI event bus (see setupWamEventHandler above) — unlike the
      // previous duck-typed version, this is no longer a false claim.
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
    const factory = await buildFactory();
    const generator = new FaustMonoDspGenerator();
    const { moduleId, instanceId } = this;
    const faustNode = (await generator.createNode(
      this.audioContext,
      __PLUGIN_NAME__,
      factory,
      false,
      1024,
      undefined,
      { moduleId, instanceId }
    )) as unknown as FaustAudioWorkletNode | null;
    if (!faustNode) throw new Error("Faust node creation failed");

    // A DSP with 0 audio inputs is a sound generator (instrument); one with
    // audio inputs is an effect processing an external signal. Cheap, always-
    // available signal straight from the compiled DSP -- no per-plugin
    // hardcoding needed.
    const hasAudioInput = faustNode.numberOfInputs > 0;
    Object.assign(this._descriptor, {
      isInstrument: !hasAudioInput,
      hasAudioInput,
    });

    const paramMgrNode = await ParamMgrFactory.create(this, {
      internalParamsConfig: Object.fromEntries((faustNode as unknown as { parameters: Map<string, unknown> }).parameters),
      // Mono DSPs without explicit [midi:key]/[midi:keyon]/[midi:keyoff] tags need
      // this to get MIDI at all -- see ParamMgrProcessor.handleMidiConvention.
      enableMidiConventionFallback: true,
    } as any);

    const node = new FaustCompositeAudioNode(this.audioContext);
    node.setup(faustNode, paramMgrNode);
    return node;
  }

  // Base class signature is `createGui(): Promise<Element>` — real WAM hosts await this.
  async createGui(): Promise<Element> {
    const wamNode = this.audioNode;
    const faustNode = wamNode._output;

    // faust-ui draws labels onto <canvas> elements sized by resize(), which
    // reads real layout dimensions off the DOM — calling it before this
    // element is attached to the WAM host's document would size every canvas
    // to 0 and no label text would render. A plain document.createElement("div")
    // never gets a connectedCallback (that's a custom-element-only lifecycle
    // hook) — SamWAMS's own verified-working gui.js relies on exactly this,
    // so this element has to be a real registered custom element too.
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
        // Writes go through the composite node (-> paramMgr), same as
        // SamWAMS's gui.js `wamNode.setParamValue(path, value)` — not
        // straight to the Faust node, so host-side automation state and
        // GUI state stay the single same source of truth.
        faustUi.paramChangeByUI = (path: string, value: number) => {
          wamNode.setParamValue(path, value);
        };
        faustUi.mount();
        container.style.width = `${faustUi.minWidth}px`;
        container.style.height = `${faustUi.minHeight}px`;
        // Only safe to call now — this element is actually connected, so
        // the label canvases can read real layout dimensions.
        faustUi.resize();

        // Reads DSP-driven / host-automated values back into the widgets.
        // Polls the real paramMgr-backed getParameterValues() (async, reads
        // live audio-thread state) rather than Faust's own output-param
        // push handler — same choice SamWAMS's gui.js makes, since
        // automation arriving via paramMgr's AudioParams wouldn't otherwise
        // reach the GUI.
        this.pollId = setInterval(async () => {
          const values = await wamNode.getParameterValues(false);
          for (const key in values) faustUi.paramChangeByDSP(key, values[key].value);
        }, 50);
      }

      disconnectedCallback() {
        if (this.pollId) clearInterval(this.pollId);
      }
    }
    const tag = `faust-gui-${this.moduleId.toLowerCase().replace(/[^a-z0-9-]/g, "")}`;
    if (!customElements.get(tag)) customElements.define(tag, FaustGuiElement);

    return document.createElement(tag);
  }

  destroyGui(): void {}
}

export default FaustWamModule;
