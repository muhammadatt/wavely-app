/**
 * USER SETTINGS of the chainable plugins that have NO preset collection — the
 * other half of pluginSettings.js, same contract: `{ use, io }` per registry id,
 * `io(api)` giving `{ read, write }` over one copy's composable.
 *
 *   read()   a plain JSON object of what the USER set on the panel
 *   write(p) puts it into effect through the same sync / toggle functions the
 *            panel's controls call. A missing key keeps the current value; a bad
 *            one (wrong type, unknown id, non-finite) is ignored, and numbers are
 *            clamped to the control's own travel.
 *
 * The rules are the presets' (CLAUDE.md, "measured values never enter a
 * preset"):
 *   - nothing MEASURED is stored — alignment, auto makeup results, ceilings
 *     measured from the selection, voice levels, detected hum, analyses, F0;
 *   - an AUTO that owns a knob is stored as the flag, and the knob only while
 *     AUTO is off; `write` decides AUTO first and sets the knob after it, because
 *     the knob's sync is a take-over that drops AUTO;
 *   - monitoring (Delta, Listen, Solo) and ON / BYPASS are never touched — the
 *     chain owns the lamp, and a monitor is not a setting;
 *   - dev-only bench / tuning controls the shipping panel does not show are left
 *     out, so a saved chain carries what a user could have set and nothing else.
 */
import { useSoftClipper } from './useSoftClipper.js'
import { useVoxPressor } from './useVoxPressor.js'
import { useHumRemover } from './useHumRemover.js'
import { useSibilanceEditor } from './useSibilanceEditor.js'
import { useVocalSaturation } from './useVocalSaturation.js'
import { useVoiceRx } from './useVoiceRx.js'
import { LIMITER_MODES } from '../audio/effects/softClipperParams.js'
import {
  SOFT_CLIPPER_MAKEUP_MIN_DB, SOFT_CLIPPER_MAKEUP_MAX_DB,
} from '../audio/softClipperProcessor.js'
import {
  PEAKS_MAX, BODY_MAX, PARALLEL_DRIVE_MAX, PEAKS_SPEED_IDS, PEAKS_MODE_IDS, OUTPUT_CEILING_IDS,
} from '../audio/effects/voxPressorParams.js'
import { PARALLEL_COMPS } from '../audio/voxPressorProcessor.js'
import {
  VOCAL_SAT_MODES, VOCAL_SAT_CURVES, VOCAL_SAT_ASYM_MODES,
} from '../audio/vocalSatParams.js'
import { HARDNESS_MIN, HARDNESS_MAX } from '../audio/dsp/satCurves.js'

// ── Helpers ─────────────────────────────────────────────────────────────────

/** `v` clamped to [lo, hi], or undefined when it is not a finite number. */
function num(v, lo, hi) {
  return typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : undefined
}

/** `v` when it is one of `ids`, else undefined. */
function oneOf(v, ids) {
  return ids.includes(v) ? v : undefined
}

/**
 * For each `[key, range, sync]`: the clamped value of `p[key]`, handed to
 * `sync` — or nothing at all when the key is absent or unusable. `range` is
 * `[lo, hi]` for a number or an array of ids for a choice.
 */
function writeFields(p, fields) {
  for (const [key, range, sync] of fields) {
    const v = isIdList(range) ? oneOf(p[key], range) : num(p[key], range[0], range[1])
    if (v !== undefined) sync(v)
  }
}
const isIdList = range => range.some(x => typeof x !== 'number')

/** A `write` must take whatever a saved chain holds, including nothing. */
const asObject = p => (p && typeof p === 'object' && !Array.isArray(p) ? p : {})

// ── Soft Clipper ────────────────────────────────────────────────────────────

/**
 * Stored: PEAK CONTROL (CLIP / LIMIT), AUTO makeup, and Output while AUTO is off.
 *
 * ⚠ THE CEILING IS NOT STORED. It is a dBFS number placed against THIS
 * selection — by the default ceiling preset on opening, or by a preset button,
 * both measured — and CLAUDE.md lists the Soft Clipper as having no preset
 * collection precisely because "its ceiling and makeup are measured per file".
 * A hand-turned ceiling is indistinguishable from the panel's own from outside
 * the composable, and on another recording either one is an arbitrary number.
 * A restored slot therefore places its ceiling as a fresh slot does: measured
 * on what the slots before it produced (`chainRenderParams`).
 *
 * Left out too: headroom (only the ADAPTIVE scope drags it, and the panel is
 * fixed-only), the shape, the raw limiter amount and HF Emphasis (admin tuning
 * panel), and Delta (monitoring).
 */
export function softClipperSettings(api) {
  const modeIds = LIMITER_MODES.map(m => m.id)
  return {
    read: () => {
      const out = { autoMakeup: api.autoMakeup.value }
      // '' when the admin knob sits between the two faceplate positions: not a
      // panel setting, so not stored.
      if (api.limiterMode.value) out.peakControl = api.limiterMode.value
      if (!api.autoMakeup.value) out.outputTrimDb = api.outputTrimDb.value
      return out
    },
    write: (raw) => {
      const p = asObject(raw)
      const mode = oneOf(p.peakControl, modeIds)
      if (mode !== undefined) api.setLimiterMode(mode)
      // AUTO first: syncOutputTrim is a take-over that switches AUTO off.
      if (p.autoMakeup === true) {
        if (!api.autoMakeup.value) api.toggleAutoMakeup()
      } else if (p.autoMakeup === false) {
        if (api.autoMakeup.value) api.toggleAutoMakeup()
      }
      if (!api.autoMakeup.value) {
        const trim = num(p.outputTrimDb, SOFT_CLIPPER_MAKEUP_MIN_DB, SOFT_CLIPPER_MAKEUP_MAX_DB)
        if (trim !== undefined) api.syncOutputTrim(trim)
      }
    },
  }
}

// ── VoxPressor ──────────────────────────────────────────────────────────────

/**
 * The faceplate: Peaks, its ATTACK / RELEASE (speed) and KNEE (mode), Body,
 * De-ess and its band split, Parallel's Mix, Drive and LA-2A / 1176 switch,
 * Lo Detail (density) and the output ceiling. In PARAM units — Peaks and Body
 * 0–10, which the panel shows ×10.
 *
 * Left out: every measured value (`alignDb` and all of `VOX_MEASURED_KEYS` —
 * makeups, ceilings, the voice's corner and F0, source peak, level offsets) and
 * the guides; the BENCH rows (Body lookahead, the Parallel de-esser, its mode
 * and the 1176's sibilance emphasis), which only dev builds show; Character
 * (WARM / CLEAN), Output trim and the Peaks AUTO pill, all off the panel; and
 * Listen, a monitor.
 */
const VOX_FIELDS = [
  ['peaks', [0, PEAKS_MAX], 'syncPeaks', 'voxPeaks'],
  ['speed', PEAKS_SPEED_IDS, 'syncSpeed', 'voxSpeed'],
  ['peaksMode', PEAKS_MODE_IDS, 'syncPeaksMode', 'voxPeaksMode'],
  ['body', [0, BODY_MAX], 'syncBody', 'voxBody'],
  ['deEss', [0, 100], 'syncDeEss', 'voxDeEss'],
  ['deEssSplit', [0, 100], 'syncDeEssSplit', 'voxDeEssSplit'],
  ['parallelComp', PARALLEL_COMPS, 'syncParallelComp', 'voxParallelComp'],
  ['parallel', [0, 100], 'syncParallel', 'voxParallel'],
  ['parallelDrive', [0, PARALLEL_DRIVE_MAX], 'syncParallelDrive', 'voxParallelDrive'],
  ['density', [0, 100], 'syncDensity', 'voxDensity'],
  ['ceiling', OUTPUT_CEILING_IDS, 'syncCeiling', 'voxCeiling'],
]

export function voxPressorSettings(api) {
  return {
    read: () => Object.fromEntries(VOX_FIELDS.map(([key, , , ref]) => [key, api[ref].value])),
    write: (raw) => {
      const p = asObject(raw)
      // Only what changed: each sync re-measures (`syncParallelComp` also drops
      // the Parallel makeup), so re-sending an unchanged value is not free.
      writeFields(p, VOX_FIELDS
        .filter(([key, , , ref]) => p[key] !== api[ref].value)
        .map(([key, range, sync]) => [key, range, api[sync]]))
    },
  }
}

// ── Hum Remover ─────────────────────────────────────────────────────────────

/**
 * Stored: the mains frequency (50 / 60 Hz), notch Width (Q) and Depth.
 *
 * ⚠ THE NOTCHED HARMONICS ARE NOT STORED. They are the DETECTED frequencies of
 * the last Analyse, ticked from its measurements of one recording; a restored
 * slot has none until it is analysed again, as a new slot does. The mains
 * choice is a fact about where the user records, so it travels.
 */
const HUM_MAINS = [50, 60]

export function humRemoverSettings(api) {
  return {
    read: () => ({ fundamental: api.humFundamental.value, q: api.humQ.value, depth: api.humDepth.value }),
    write: (raw) => {
      const p = asObject(raw)
      // setFundamental discards an analysis measured against the other series;
      // it is a no-op when the value is unchanged.
      if (HUM_MAINS.includes(p.fundamental)) api.setFundamental(p.fundamental)
      writeFields(p, [
        ['q', [5, 60], api.syncQ],
        ['depth', [0, 40], api.syncDepth],
      ])
    },
  }
}

// ── Sibilance Editor ────────────────────────────────────────────────────────

/**
 * Stored: the attenuation knobs — both ceilings, Amount, Max Cut and the four
 * fades. Travel as on the panel.
 *
 * Left out: the detected events and the analysis (measurements of one
 * recording; a chain apply re-analyses the running audio anyway), and the
 * detection `tuning` overrides, which only the dev tuning panel sets.
 */
const SIBILANCE_FIELDS = [
  ['stridentCeilingDb', [-12, 18]],
  ['nonStridentCeilingDb', [-18, 12]],
  ['reductionRatio', [0, 1]],
  ['maxReductionDb', [0, 24]],
  ['fricativeInMs', [0.5, 20]],
  ['fricativeOutMs', [0.5, 20]],
  ['affricateInMs', [0.5, 20]],
  ['affricateOutMs', [0.5, 20]],
]

export function sibilanceEditorSettings(api) {
  return {
    read: () => Object.fromEntries(SIBILANCE_FIELDS.map(([key]) => [key, api.params.value[key]])),
    write: (raw) => {
      const p = asObject(raw)
      writeFields(p, SIBILANCE_FIELDS.map(([key, range]) => [key, range, v => api.syncParam(key, v)]))
    },
  }
}

// ── Tube Saturation ─────────────────────────────────────────────────────────

/**
 * Every control on its window: none is measured and none is dev-only (the
 * plugin itself is a dev release). `autoDrive` is a knob, not an AUTO that owns
 * one, so it is stored like any other.
 */
const VOCAL_SAT_FIELDS = [
  ['drive', [0, 5], 'syncDrive', 'vsDrive'],
  ['wetDry', [0, 1], 'syncWetDry', 'vsWetDry'],
  ['asymmetry', [0, 100], 'syncAsymmetry', 'vsAsymmetry'],
  ['asymMode', VOCAL_SAT_ASYM_MODES.map(m => m.id), 'syncAsymMode', 'vsAsymMode'],
  ['mode', VOCAL_SAT_MODES.map(m => m.id), 'syncMode', 'vsMode'],
  ['curve', VOCAL_SAT_CURVES.map(c => c.id), 'syncCurve', 'vsCurve'],
  ['hardness', [HARDNESS_MIN, HARDNESS_MAX], 'syncHardness', 'vsHardness'],
  ['emphasis', [0, 100], 'syncEmphasis', 'vsEmphasis'],
  ['soften', [0, 100], 'syncSoften', 'vsSoften'],
  ['tame', [0, 100], 'syncTame', 'vsTame'],
  ['autoDrive', [0, 100], 'syncAutoDrive', 'vsAutoDrive'],
  ['hfLoss', [0, 100], 'syncHfLoss', 'vsHfLoss'],
  ['lowCrossover', [100, 2000], 'syncLowCrossover', 'vsLowCrossover'],
  ['midCrossover', [1000, 8000], 'syncMidCrossover', 'vsMidCrossover'],
  ['lowDriveMult', [0, 10], 'syncLowDriveMult', 'vsLowDriveMult'],
  ['midDriveMult', [0, 10], 'syncMidDriveMult', 'vsMidDriveMult'],
  ['highDriveMult', [0, 10], 'syncHighDriveMult', 'vsHighDriveMult'],
]

export function vocalSaturationSettings(api) {
  return {
    read: () => Object.fromEntries(VOCAL_SAT_FIELDS.map(([key, , , ref]) => [key, api[ref].value])),
    write: (raw) => {
      const p = asObject(raw)
      writeFields(p, VOCAL_SAT_FIELDS.map(([key, range, sync]) => [key, range, api[sync]]))
    },
  }
}

// ── VoiceRx ─────────────────────────────────────────────────────────────────

/**
 * NOTHING IS STORED, deliberately. VoiceRx's bands are a DIAGNOSIS of one
 * recording: their frequencies are the measured anomaly centres, their ranges
 * the analysed voice's regions, and the suggestions they came from are derived
 * from the analysis. On another recording they are the measured-values-in-a-
 * preset failure, and a hand-set role knob is no better — it sits at the
 * measured centre too. A restored slot is an empty VoiceRx waiting for Analyse,
 * as a new one is. A user who wants the corrections kept moves them into the
 * EQ (Send to EQ), where they are ordinary bands a saved chain does store.
 */
export function voiceRxSettings() {
  return { read: () => ({}), write: () => {} }
}

/** Keyed by the plugin's registry id (its solo window id, src/ui/registry.js). */
export const EXTRA_PLUGIN_SETTINGS = {
  'soft-clipper': { use: useSoftClipper, io: softClipperSettings },
  'vox-pressor': { use: useVoxPressor, io: voxPressorSettings },
  'hum-remover': { use: useHumRemover, io: humRemoverSettings },
  'clip-gain-deesser': { use: useSibilanceEditor, io: sibilanceEditorSettings },
  'vocal-saturation': { use: useVocalSaturation, io: vocalSaturationSettings },
  'voicerx': { use: useVoiceRx, io: voiceRxSettings },
}
