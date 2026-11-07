/**
 * Every chainable plugin's USER SETTINGS, read and written through its
 * composable — so a copy's settings can be captured and restored with its
 * window closed. A saved Plugin Chain (useChainPresets.js) is a list of these.
 *
 * Each entry is `{ use, io, presetPlugin?, chainKeys? }`:
 *   use(copy)    the composable of that copy ('solo' or 'chain-<n>'), built if needed
 *   io(api)      `{ read, write }` over it — `read()` a plain object, `write(p)` puts
 *                one into effect through the plugin's own sync functions
 *   presetPlugin the plugin's preset collection, if it has one. Its whitelist and
 *                `normalize` then guard what a saved chain restores, exactly as
 *                they guard a preset.
 *   chainKeys    settings a saved CHAIN keeps beyond the preset whitelist — user
 *                settings the plugin's presets leave out on purpose (the EQ's
 *                trims). `write` must tolerate them being absent.
 *
 * ⚠ ONE COPY OF EACH READ/WRITE. The twelve plugins with preset menus used to
 * define these in their panels; the panels now take them from here, so the
 * preset menu and a saved chain cannot disagree about what a plugin's settings
 * ARE. Measured values (alignment, auto makeup, ceilings, voice levels) never
 * enter either — the same rule, stated once.
 *
 * The plugins with no preset collection are in pluginSettingsExtra.js.
 */
import { useLA2A } from './useLA2A.js'
import { useFET1176 } from './useFET1176.js'
import { useResonance, resTargeting } from './useResonance.js'
import { useInflator } from './useInflator.js'
import { usePhatass } from './usePhatass.js'
import { useManualEq } from './useManualEq.js'
import { useScheps } from './useScheps.js'
import { useHFLimiter } from './useHFLimiter.js'
import { useAirBand } from './useAirBand.js'
import { useDeEsser } from './useDeEsser.js'
import { usePlosive } from './usePlosive.js'
import { useSaturationBench } from './useSaturationBench.js'
import { EXTRA_PLUGIN_SETTINGS } from './pluginSettingsExtra.js'
import { DE_ESSER_DEFAULTS } from '../audio/deEsserParams.js'
import {
  OPTO_SMOOTH_PRESET_PLUGIN, FET_PUNCH_PRESET_PLUGIN, RESO_TAME_PRESET_PLUGIN, RESO_TAME_STOCK_ZONES,
  INFLATOR_PRESET_PLUGIN, PHATASS_PRESET_PLUGIN, PARAMETRIC_EQ_PRESET_PLUGIN, SCHEPS_PRESET_PLUGIN,
  HF_LIMITER_PRESET_PLUGIN, AIR_BOOST_PRESET_PLUGIN, DE_ESSER_PRESET_PLUGIN, PLOSIVE_PRESET_PLUGIN,
  SATURATION_BENCH_PRESET_PLUGIN, pickParams,
} from '../audio/pluginPresets/index.js'
import { PHATASS_PARAM_KEYS } from '../audio/pluginPresets/phatass.js'
import { PLOSIVE_PARAM_KEYS } from '../audio/pluginPresets/plosive.js'
import { HF_LIMITER_PARAM_KEYS } from '../audio/pluginPresets/hfLimiter.js'

/**
 * LA Vintage 2A. Reading is just the knobs. Writing has one ordering
 * constraint: the Gain knob goes LAST and goes through the AUTO decision,
 * because `syncGain` is a take-over — it drops AUTO and accepts the value.
 * Setting the gain before deciding the AUTO state would leave AUTO off
 * whatever the preset asked for.
 */
export function la2aSettings(api) {
  return {
    read: () => ({
      mode: api.la2aMode.value,
      peakReduction: api.la2aPeakReduction.value,
      gain: api.la2aGain.value,
      r37: api.la2aR37.value,
      lookahead: api.la2aLookahead.value,
      analog: api.la2aAnalog.value,
      mix: api.la2aMix.value,
      autoMakeup: api.la2aAutoMakeup.value,
    }),
    write: (p) => {
      api.syncMode(p.mode)
      api.syncPeakReduction(p.peakReduction)
      api.syncR37(p.r37)
      // Absent in every preset saved before the control existed, and 0 is both
      // the default and what those patches were auditioned with.
      api.syncLookahead(p.lookahead ?? 0)
      // Absent in every preset saved before the control existed, and those were
      // auditioned WITH the nonlinearity — so an absent key means ON, never OFF.
      api.syncAnalog(p.analog !== false)
      // Absent in every preset saved before the control existed; those were
      // auditioned fully wet.
      api.syncMix(p.mix ?? 1)
      if (p.autoMakeup) {
        // Already on: the syncs above have each scheduled a re-measure, so the
        // knob lands on the new settings without a second toggle.
        if (!api.la2aAutoMakeup.value) api.toggleAutoMakeup()
      } else {
        if (api.la2aAutoMakeup.value) api.toggleAutoMakeup()
        api.syncGain(p.gain)
      }
    },
  }
}

/**
 * LA Classic 76. Same ordering constraint as LA Vintage 2A: Output goes last
 * and through the AUTO decision, because `syncOutput` is a take-over.
 *
 * ⚠ `fetDrive` HAS NO CONTROL ON THE FACE BUT PRESETS STILL CARRY IT. Each
 * factory preset was voiced with its own amount (0.2-0.6) against a default
 * of 1, so dropping it on load would re-voice every one of them. It rides
 * along invisibly: a preset sets it, a saved preset keeps what is in effect.
 */
export function fet1176Settings(api) {
  return {
    read: () => ({
      inputDrive: api.fetInput.value,
      output: api.fetOutput.value,
      attack: api.fetAttack.value,
      release: api.fetRelease.value,
      ratio: api.fetRatio.value,
      fetDrive: api.fetDrive.value,
      analog: api.fetAnalog.value,
      scHpf: api.fetScHpf.value,
      mix: api.fetMix.value,
      autoMakeup: api.fetAutoMakeup.value,
    }),
    write: (p) => {
      api.syncInput(p.inputDrive)
      api.syncAttack(p.attack)
      api.syncRelease(p.release)
      api.syncRatio(p.ratio)
      api.syncDrive(p.fetDrive)
      // Absent in presets saved before the lamp existed, which were auditioned
      // with the FET stage in — so absent means ON.
      api.syncAnalog(p.analog !== false)
      api.syncScHpf(p.scHpf)
      api.syncMix(p.mix)
      if (p.autoMakeup) {
        if (!api.fetAutoMakeup.value) api.toggleAutoMakeup()
      } else {
        if (api.fetAutoMakeup.value) api.toggleAutoMakeup()
        api.syncOutput(p.output)
      }
    },
  }
}

/**
 * Reso Soothe — its preset read/write.
 *
 * ⚠ THE PANEL RUNS ONE TARGETING MODEL AND SO DOES A PRESET. The kernel
 * dispatches on `focus`: a non-null patch TAKES OVER from the zone set. So
 * pushing both halves would mean a zone preset silently switching a
 * focus-model session, or a focus preset arriving in a session whose controls
 * are showing zones. `read` and `write` therefore touch only the live model's
 * half, and the preset MODULE registers only that model's table — the two
 * agree because both ask `resolveTargeting()`, once, at module load.
 *
 * The inert half still travels in the params, because a preset states every
 * one of its plugin's keys rather than inheriting a default that may move. It
 * is simply not pushed.
 *
 * What a preset must never carry, and why this write clears it rather than
 * setting it: the monitoring modes. DELTA, the per-zone delta and the focus
 * SOLO are UI state. Two of the three are expressible as ordinary parameters —
 * a zone delta is every other zone at depth zero, and `focus.solo` is a plain
 * field on the patch — so nothing about either would LOOK wrong if it leaked
 * into what Apply renders. `applyResonanceRegion` spreads its param object
 * straight into the kernel, so that leak is a one-node pass written to the
 * timeline. The store's whitelist keeps them out of the preset; clearing them
 * here keeps a stale isolation from surviving a patch that no longer has the
 * zone or node it was pointing at.
 */
export function resonanceSettings(api) {
  const focusMode = resTargeting === 'focus'
  return {
    read: () => ({
      attack: api.resAttack.value,
      release: api.resRelease.value,
      mode: api.resMode.value,
      mix: api.resMix.value,
      trim: api.resTrim.value,
      // The half the panel is not running is reported as the preset's own inert
      // value, so a preset matches itself rather than reading as MODIFIED
      // against a zone set nobody can see or edit in this session.
      zones: focusMode ? RESO_TAME_STOCK_ZONES : api.resZones.value,
      focus: focusMode ? api.resFocus.value : null,
    }),
    write: (p) => {
      if (focusMode) {
        if (api.resSoloNode.value >= 0) api.toggleFocusSolo(api.resSoloNode.value)
        // Never null in this collection: the focus model's `normalize` repairs a
        // null patch to the stock global, because null is the instruction to read
        // the zone set — i.e. to switch models — rather than a missing value.
        api.syncFocus(p.focus)
        // The node strip edits one node by index, and a preset can carry fewer
        // nodes than the patch it replaces — leaving the selection past the end
        // would point the controls at nothing.
        if (api.resSelectedNode.value >= (p.focus?.nodes?.length ?? 0)) api.resSelectedNode.value = -1
      } else {
        api.clearZoneDelta()
        api.syncZones(p.zones)
        if (api.resSelectedZone.value >= p.zones.length) api.resSelectedZone.value = 0
      }
      api.syncAttack(p.attack)
      api.syncRelease(p.release)
      api.syncMode(p.mode)
      api.syncMix(p.mix)
      api.syncTrim(p.trim)
    },
  }
}

export function inflatorSettings(api) {
  return { read: () => api.currentParams(), write: p => api.applyParams(p) }
}

export function phatassSettings(api) {
  return {
    read: () => Object.fromEntries(PHATASS_PARAM_KEYS.map(k => [k, api.phParams[k]])),
    write: p => api.applyParams(p),
  }
}

/** The EQ's trims' range, dB — the panel's knobs (EqModal.vue). */
const EQ_TRIM_MAX_DB = 12
const clampTrim = v => Math.max(-EQ_TRIM_MAX_DB, Math.min(EQ_TRIM_MAX_DB, v))

/**
 * The EQ's band set, stored low to high — and its IN / OUT trims.
 *
 * The trims are NOT part of an EQ preset (a preset is a band set, and the
 * collection's whitelist drops them), but they are user settings that change
 * what the slot plays, so a saved chain carries them (`chainKeys` below). A
 * preset load arrives without them and leaves the trims where they are.
 */
export function eqSettings(api) {
  return {
    read: () => ({ ...api.presetParams(), input: api.inputTrim.value, output: api.outputTrim.value }),
    write: (p) => {
      api.applyPreset(p)
      if (Number.isFinite(p.input)) api.setInputTrim(clampTrim(p.input))
      if (Number.isFinite(p.output)) api.setOutputTrim(clampTrim(p.output))
    },
  }
}

export function schepsSettings(api) {
  return {
    read: () => ({
      character: api.schepsCharacter.value,
      squash: api.schepsSquash.value,
      mix: api.schepsMix.value,
      output: api.schepsOutput.value,
      autoTrim: api.schepsAutoTrim.value,
    }),
    write: p => api.applyParams(p),
  }
}

export function hfLimiterSettings(api) {
  return {
    read: () => Object.fromEntries(HF_LIMITER_PARAM_KEYS.map(k => [k, api.hflParams[k]])),
    write: p => api.applyParams(p),
  }
}

export function airBandSettings(api) {
  return {
    read: () => ({ air: api.airBandAir.value, output: api.airBandOutput.value }),
    write: p => api.applyParams(p),
  }
}

export function deEsserSettings(api) {
  return {
    read: () => ({
      duck: api.hfDuck.value, amount: api.hfAmount.value, guard: api.hfGuard.value,
      band: api.hfBand.value, detect: api.hfDetect.value, detectHigh: api.hfDetectHigh.value,
      // Under AUTO the knob holds a MEASUREMENT of this selection, which is the
      // file's, not the patch's: store the default, so a preset never carries it
      // and AUTO never makes one read as modified. applyParams ignores it anyway.
      air: api.hfComp.value ? DE_ESSER_DEFAULTS.air : api.hfAir.value,
      comp: api.hfComp.value, soften: api.hfSoften.value,
    }),
    write: p => api.applyParams(p),
  }
}

export function plosiveSettings(api) {
  return {
    read: () => Object.fromEntries(PLOSIVE_PARAM_KEYS.map(k => [k, api.plParams[k]])),
    write: p => api.applyParams(p),
  }
}

export function saturationBenchSettings(api) {
  return {
    read: () => ({ layers: api.sbLayers.value, inputDb: api.sbInputDb.value, outputDb: api.sbOutputDb.value }),
    write: p => api.applyParams(p),
  }
}

/** Keyed by the plugin's registry id (its solo window id). */
export const PLUGIN_SETTINGS = {
  'opto-smooth': { use: useLA2A, io: la2aSettings, presetPlugin: OPTO_SMOOTH_PRESET_PLUGIN },
  'fet-punch': { use: useFET1176, io: fet1176Settings, presetPlugin: FET_PUNCH_PRESET_PLUGIN },
  'resonance-suppressor': { use: useResonance, io: resonanceSettings, presetPlugin: RESO_TAME_PRESET_PLUGIN },
  'inflator': { use: useInflator, io: inflatorSettings, presetPlugin: INFLATOR_PRESET_PLUGIN },
  'phatass': { use: usePhatass, io: phatassSettings, presetPlugin: PHATASS_PRESET_PLUGIN },
  'manual-eq': { use: useManualEq, io: eqSettings, presetPlugin: PARAMETRIC_EQ_PRESET_PLUGIN, chainKeys: ['input', 'output'] },
  'scheps-parallel': { use: useScheps, io: schepsSettings, presetPlugin: SCHEPS_PRESET_PLUGIN },
  'hf-limiter': { use: useHFLimiter, io: hfLimiterSettings, presetPlugin: HF_LIMITER_PRESET_PLUGIN },
  'air-band': { use: useAirBand, io: airBandSettings, presetPlugin: AIR_BOOST_PRESET_PLUGIN },
  'de-esser': { use: useDeEsser, io: deEsserSettings, presetPlugin: DE_ESSER_PRESET_PLUGIN },
  'plosive': { use: usePlosive, io: plosiveSettings, presetPlugin: PLOSIVE_PRESET_PLUGIN },
  'saturation-bench': { use: useSaturationBench, io: saturationBenchSettings, presetPlugin: SATURATION_BENCH_PRESET_PLUGIN },
  ...EXTRA_PLUGIN_SETTINGS,
}

/** Deep plain copy: refs' arrays and objects must not be shared with a saved chain. */
const plain = value => JSON.parse(JSON.stringify(value ?? null))

/**
 * The `{ read, write }` of `copy` of a plugin, building the copy if it does not
 * exist yet — or null for a plugin with no entry. Building a copy registers it
 * with the chain, so call this outside a computed (see useChainPresets.js).
 */
export function pluginSettingsIO(pluginId, copy) {
  const entry = PLUGIN_SETTINGS[pluginId]
  return entry ? entry.io(entry.use(copy)) : null
}

/**
 * What a saved chain stores for a plugin, from its raw settings: the preset
 * whitelist (and `normalize`) when it has a collection, plus its `chainKeys`;
 * a plain copy otherwise. Used both to save and to load, so the two agree.
 */
export function chainSettingsOf(pluginId, settings) {
  const entry = PLUGIN_SETTINGS[pluginId]
  if (!entry || !settings || typeof settings !== 'object') return null
  if (!entry.presetPlugin) return plain(settings)
  const params = pickParams(entry.presetPlugin, settings)
  if (!params) return null
  for (const key of entry.chainKeys ?? []) {
    if (Object.prototype.hasOwnProperty.call(settings, key)) params[key] = plain(settings[key])
  }
  return params
}

/**
 * Put saved settings into `copy` of a plugin. Settings saved by an older build
 * pass through the plugin's preset whitelist and `normalize` first, when it has
 * one, so a key the plugin has since dropped or a value out of range cannot
 * reach the kernel. Returns false when there was nothing to write.
 */
export function writePluginSettings(pluginId, copy, settings) {
  const params = chainSettingsOf(pluginId, settings)
  if (!params) return false
  pluginSettingsIO(pluginId, copy).write(params)
  return true
}
