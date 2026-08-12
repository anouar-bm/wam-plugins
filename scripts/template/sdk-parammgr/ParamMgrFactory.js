import addFunctionModule from './sdk/src/addFunctionModule.js';
import processor from './ParamMgrProcessor.js';
import ParamMappingConfigurator from './ParamConfigurator.js';
import ParamMgrNode from './ParamMgrNode.js';
/** @typedef {import('@webaudiomodules/api').WebAudioModule} WebAudioModule */
/** @typedef {import('./types').ParametersMappingConfiguratorOptions} ParametersMappingConfiguratorOptions */
/** @typedef {import('./types').ParamMgrOptions} ParamMgrOptions */
/** @typedef {import('./types').AudioWorkletRegister} AudioWorkletRegister */

export default class ParamMgrFactory {
	/**
	 * @param {WebAudioModule} module
	 * @param {ParametersMappingConfiguratorOptions} [optionsIn = {}]
	 */
	static async create(module, optionsIn = {}) {
		const { audioContext, moduleId } = module;
		const instanceId = optionsIn.instanceId || module.instanceId;
		const groupId = optionsIn.groupId || module.groupId;
		const { paramsConfig, paramsMapping, internalParamsConfig } = new ParamMappingConfigurator(optionsIn);
		const initialParamsValue = Object.entries(paramsConfig)
			.reduce((currentParams, [name, { defaultValue }]) => {
				currentParams[name] = defaultValue;
				return currentParams;
			}, {});
		const serializableParamsConfig = Object.entries(paramsConfig)
			.reduce((currentParams, [name, { id, label, type, defaultValue, minValue, maxValue, discreteStep, exponent, choices, units }]) => {
				currentParams[name] = { id, label, type, defaultValue, minValue, maxValue, discreteStep, exponent, choices, units };
				return currentParams;
			}, {});
		await addFunctionModule(audioContext.audioWorklet, processor, moduleId, serializableParamsConfig);
		/** @type {ParamMgrOptions} */
		const options = {
			internalParamsConfig,
			parameterData: initialParamsValue,
			processorOptions: {
				paramsConfig,
				paramsMapping,
				internalParamsMinValues: Object.values(internalParamsConfig)
					.map((config) => Math.max(0, config?.minValue || 0)),
				internalParams: Object.keys(internalParamsConfig),
				groupId,
				instanceId,
				moduleId,
				// Mono Faust DSPs without explicit [midi:key]/[midi:keyon]/[midi:keyoff]
				// tags need ParamMgrProcessor's freq/gain/gate convention fallback to get
				// MIDI at all (see ParamMgrProcessor.handleMidiConvention). Poly DSPs
				// already get real per-voice keyOn/keyOff from Faust's own poly engine —
				// the fallback firing there too would fight it (overwrites the exposed
				// macro gain/freq/gate AudioParams with raw MIDI velocity on every note,
                // clobbering whatever the user set). Opt-in only, off by default.
				enableMidiConventionFallback: !!optionsIn.enableMidiConventionFallback,
			},
		};
		const node = new ParamMgrNode(module, options);
		await node.initialize();
		return node;
	}
}
