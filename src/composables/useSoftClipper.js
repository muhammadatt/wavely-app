import { ref, computed } from 'vue'
import { useEditorState } from './useEditorState.js'
import { useWindows } from './useWindows.js'
import {
  applySoftClipperRegion, computePeakCache, computeSoftClipperCeiling,
} from '../audio/processing.js'
import { getEffectChain, getEffectChainIfExists } from '../audio/effectChain.js'
import { softClipperEffect, SOFT_CLIPPER_DEFAULTS } from '../audio/effects/softClipper.js'
import {
  LIMITER_MODES, limiterModeFor, limiterModeById, limiterModeLatencyMs,
} from '../audio/effects/softClipperParams.js'
import { SOFT_CLIPPER_KERNEL_DEFAULTS } from '../audio/softClipperProcessor.js'
import { snapshotLevels } from '../audio/effects/levelTap.js'
import { tuningEnabled } from '../audio/softClipperTuning.js'
import { CEILING_PRESETS, DEFAULT_CEILING_PRESET, presetById } from '../audio/ceilingPresets.js'

// Registry id of this plugin's window. Must match the entry in src/ui/registry.js.
export const SOFT_CLIPPER_WINDOW_ID = 'soft-clipper'

// Singleton reactive state shared between the sidebar trigger and the modal —
// same pattern as useFET1176.js / useLA2A.js.
const headroomDb = ref(SOFT_CLIPPER_DEFAULTS.headroomDb)
const outputTrimDb = ref(SOFT_CLIPPER_DEFAULTS.outputTrimDb)
/**
 * ⚠ THE PANEL IS FIXED-ONLY, and this deliberately overrides the kernel default.
 *
 * The kernel still defaults to 'adaptive' so anything rendering without the
 * panel is untouched, but the panel never offers it: measured, a threshold that
 * follows the speech level rises exactly where the peaks are and costs 4-10x
 * more program energy for the same peak control (see CLAUDE.md). What the user
 * gets instead is one ceiling in dBFS, put in the right place for the material
 * by the preset buttons.
 */
const thresholdMode = ref('fixed')
const fixedThresholdDb = ref(SOFT_CLIPPER_DEFAULTS.fixedThresholdDb)
const shape = ref(SOFT_CLIPPER_DEFAULTS.shape)
/**
 * ⚠ HIDDEN CONTROLS. Limiter, the knee and HF Emphasis are shipped kernel
 * behaviour whose knobs live on the admin tuning panel rather than the
 * faceplate — see softClipperTuning.js for what each is and why. Their values
 * still come from the kernel's defaults, so a user who never sets the flag
 * gets exactly what the kernel ships and these refs simply never move.
 */
const limiter = ref(SOFT_CLIPPER_DEFAULTS.limiter)
// Seeded from the KERNEL's pin rather than from SOFT_CLIPPER_DEFAULTS, which
// holds null there on purpose so the shipped path forwards nothing. The panel
// needs a real number to display and to turn from.
const emphasisDb = ref(SOFT_CLIPPER_KERNEL_DEFAULTS.emphasisDb)
const tuningOn = tuningEnabled()

/**
 * Which ceiling preset was last applied, and whether a measurement is running.
 *
 * The preset is a STARTING POINT, not a mode: it measures the region and writes
 * `fixedThresholdDb`, after which the ceiling is an ordinary number the user can
 * turn. Turning it clears the preset lamp, because a ceiling that has been
 * nudged is no longer "MEDIUM" and saying otherwise would be a readout that
 * stops being true the moment anything changes — the same failure the Scheps
 * auto-trim note records.
 */
const ceilingPreset = ref(null)
const ceilingBusy = ref(false)
// Has the user turned the ceiling knob themselves this session? Once they have,
// opening the preview must not overwrite it with a preset — that would be the
// panel discarding a deliberate choice, which is exactly what "the Gain knob
// discarded the drag" already cost this plugin once.
let userSetCeiling = false

// Debounce + supersede, shared across every useSoftClipper() caller. The
// measurement depends on the REGION and the chosen percentile only — no other
// soft clipper parameter changes it — so knob drags never trigger it.
const CEILING_DEBOUNCE_MS = 90
let ceilingTimer = null
let ceilingSeq = 0

const clipperPreview = ref(false)
const clipperReduction = ref(0)
// Share of voiced blocks the curve engaged on, 0-100. See the kernel's
// ENGAGED_TAU_S for why this sits beside the dB reading rather than replacing
// it.
const clipperEngagedPct = ref(0)
// How much of HF Emphasis's boost the threshold is giving back, dB. See
// LIFT_TAU_S in the kernel.
const clipperLiftDb = ref(0)
// Residual level in dBc — see RESIDUAL_TAU_S in the kernel.
const clipperResidualDbc = ref(-120)
const clipperDelta = ref(false)
const clipperInputLevels = ref([])
const clipperOutputLevels = ref([])
let meterId = null

function currentParams() {
  return {
    headroomDb: headroomDb.value,
    outputTrimDb: outputTrimDb.value,
    thresholdMode: thresholdMode.value,
    fixedThresholdDb: fixedThresholdDb.value,
    shape: shape.value,
    limiter: limiter.value,
    // Only when the tuning panel is open: on the shipped path emphasisDb must
    // stay absent so the kernel's pin governs, and forwarding a mirrored copy
    // of a pin is how a pin quietly stops being one.
    ...(tuningOn ? { emphasisDb: emphasisDb.value } : {}),
  }
}

export function useSoftClipper() {
  const { state, getAudioContext, hasSelection, replaceRegion, setPeakCache, startProcessing, endProcessing, showToast } = useEditorState()
  const { openWindow, closeWindow } = useWindows()

  function initChain() {
    const ctx = getAudioContext()
    const chain = getEffectChain(ctx)
    if (!chain.effects.find(e => e.id === softClipperEffect.id)) {
      chain.addEffect(softClipperEffect)
    }
    return chain
  }

  function startMeters(chain) {
    stopMeters()
    function tick() {
      const nodes = chain.effects.find(e => e.id === softClipperEffect.id)?.nodes
      if (nodes) {
        clipperReduction.value = nodes.getReduction()
        clipperEngagedPct.value = nodes.getEngagedFraction() * 100
        clipperLiftDb.value = nodes.getLift()
        clipperResidualDbc.value = nodes.getResidualDbc()
        const chCount = state.currentFile?.channels ?? 1
        clipperInputLevels.value = snapshotLevels(nodes.getInputLevels(chCount))
        clipperOutputLevels.value = snapshotLevels(nodes.getOutputLevels(chCount))
      }
      meterId = requestAnimationFrame(tick)
    }
    meterId = requestAnimationFrame(tick)
  }

  /**
   * The live scope ring, or null when nothing is running.
   *
   * A function rather than a ref, deliberately: this is ~1400 floats updating
   * at ~46 Hz feeding a canvas that redraws itself every frame anyway, and
   * routing it through reactivity would make Vue diff typed arrays for no
   * benefit. Same arrangement the resonance display uses.
   */
  function getScope() {
    const chain = getEffectChainIfExists()
    const nodes = chain?.effects.find(e => e.id === softClipperEffect.id)?.nodes
    return nodes?.getScope?.() ?? null
  }

  function stopMeters() {
    if (meterId !== null) {
      cancelAnimationFrame(meterId)
      meterId = null
    }
    clipperReduction.value = 0
    clipperEngagedPct.value = 0
    clipperLiftDb.value = 0
    clipperResidualDbc.value = -120
    clipperInputLevels.value = []
    clipperOutputLevels.value = []
  }

  function pushAllParams(chain) {
    for (const [name, value] of Object.entries(currentParams())) {
      chain.updateParam(softClipperEffect.id, name, value)
    }
    // Not in currentParams — deliberately, it is a monitoring mode and not a
    // parameter — so it needs restoring by hand when the preview comes back on.
    chain.effects.find(e => e.id === softClipperEffect.id)?.nodes
      ?.setMonitorDelta(clipperDelta.value)
  }

  /**
   * Hear only what the stage is removing.
   *
   * The most direct answer to the question this plugin actually raises — is
   * that grit or is that control — and one the meters cannot answer at all: at
   * the default the clipping blocks take a median of 0.3-0.4 dB, so the panel
   * can read idle while the residual is plainly audible. Nothing about the
   * file changes; Apply renders the processed output whatever this is set to.
   */
  function toggleDelta() {
    clipperDelta.value = !clipperDelta.value
    getEffectChainIfExists()?.effects
      .find(e => e.id === softClipperEffect.id)?.nodes
      ?.setMonitorDelta(clipperDelta.value)
  }

  function togglePreview() {
    const chain = initChain()
    clipperPreview.value = !clipperPreview.value
    chain.setEnabled(softClipperEffect.id, clipperPreview.value)

    if (clipperPreview.value) {
      pushAllParams(chain)
      startMeters(chain)
      // A ceiling in dBFS means nothing until it is placed against the
      // material, and the kernel's -10 default is arbitrary for any given
      // recording. Land on the default preset unless the user has already
      // chosen a ceiling this session.
      if (ceilingPreset.value === null && !userSetCeiling) applyCeilingPreset(DEFAULT_CEILING_PRESET)
    } else {
      stopMeters()
    }
  }

  function pushParam(name, value) {
    if (!clipperPreview.value) return
    const chain = getEffectChain(getAudioContext())
    chain.updateParam(softClipperEffect.id, name, value)
  }

  /**
   * Measure the region and put the ceiling where the named preset says.
   *
   * Superseded calls are discarded by sequence number, so clicking two presets
   * quickly — or dragging a selection edge under one — cannot land an older
   * measurement after a newer one.
   *
   * ⚠ A null measurement LEAVES THE CEILING ALONE. A region with no measurable
   * content has no sensible ceiling, and moving the knob to some fallback would
   * be worse than not moving it: the user asked for a value derived from this
   * material and there isn't one.
   */
  async function applyCeilingPreset(id) {
    const preset = presetById(id)
    if (!preset || !state.selection || !state.currentFile) return

    const { start, end } = state.selection
    const seq = ++ceilingSeq
    ceilingBusy.value = true
    try {
      const measured = await computeSoftClipperCeiling(
        state.segments, start, end, preset.percentile,
        state.currentFile.sampleRate, state.currentFile.channels,
      )
      if (seq !== ceilingSeq) return // a newer measurement is already in flight
      if (measured === null) return
      fixedThresholdDb.value = measured
      ceilingPreset.value = preset.id
      pushParam('fixedThresholdDb', measured)
    } catch (err) {
      console.error('Soft Clipper ceiling measurement failed:', err)
    } finally {
      if (seq === ceilingSeq) ceilingBusy.value = false
    }
  }

  /**
   * Re-run the current preset for a changed region, debounced.
   *
   * Only if a preset is actually active: once the user has turned the ceiling
   * by hand it is THEIR number, and moving it because the selection changed
   * would be the panel overwriting a deliberate choice.
   *
   * ⚠ IT ALSO HAS TO PLACE THE FIRST ONE. Opening the panel runs the default
   * preset, but that measurement needs a region and there may not be one yet —
   * the presets are disabled until there is, and the ceiling then sat at the
   * kernel's arbitrary -10 dBFS until the user clicked a button they had no
   * reason to think was waiting for them. The first selection is exactly the
   * moment the opening measurement becomes possible, so it runs then instead.
   * Still never over a hand-set ceiling.
   */
  function scheduleCeilingPreset() {
    if (ceilingPreset.value === null && (userSetCeiling || !clipperPreview.value)) return
    const id = ceilingPreset.value ?? DEFAULT_CEILING_PRESET
    if (ceilingTimer !== null) clearTimeout(ceilingTimer)
    ceilingTimer = setTimeout(() => {
      ceilingTimer = null
      applyCeilingPreset(id)
    }, CEILING_DEBOUNCE_MS)
  }

  const syncHeadroom = (v) => { headroomDb.value = v; pushParam('headroomDb', v) }
  const syncLimiter = (v) => { limiter.value = v; pushParam('limiter', v) }

  /**
   * Which of the two faceplate positions the current `limiter` value is, or ''
   * when the admin knob has been put somewhere between them — see
   * limiterModeFor.
   */
  const limiterMode = computed(() => limiterModeFor(limiter.value))

  /**
   * ⚠ THIS CHANGES THE STAGE'S LATENCY, about 1.1 ms to 5.1 ms (50 samples to
   * 226 at 44.1 kHz, 242 at 48 — the lookahead is a fixed number of
   * milliseconds, so the count moves with the rate and the time does not).
   * The offline apply
   * path reads the latency per render, so what lands on the timeline is right
   * either way; what moves is the PREVIEW, which shifts by ~4 ms the moment the
   * switch is thrown. That is inherent to putting a lookahead in circuit and is
   * why the panel says so rather than hiding it.
   */
  function setLimiterMode(id) {
    const mode = limiterModeById(id)
    if (mode) syncLimiter(mode.limiter)
  }

  /** Latency of the current mode in ms, at the file's own rate. */
  function limiterLatencyMs(sampleRate) {
    return limiterModeLatencyMs(limiter.value, sampleRate)
  }
  const syncEmphasis = (v) => { emphasisDb.value = v; pushParam('emphasisDb', v) }
  const syncOutputTrim = (v) => { outputTrimDb.value = v; pushParam('outputTrimDb', v) }
  const syncFixedThreshold = (v) => {
    fixedThresholdDb.value = v
    userSetCeiling = true
    // Hand-turned: it is no longer the preset's number, so stop claiming it is.
    ceilingPreset.value = null
    pushParam('fixedThresholdDb', v)
  }

  function setShape(v) {
    shape.value = v
    pushParam('shape', v)
  }

  function setThresholdMode(mode) {
    thresholdMode.value = mode
    pushParam('thresholdMode', mode)
  }

  async function apply() {
    if (!state.selection) return
    const { start, end } = state.selection

    const wasPreviewing = clipperPreview.value
    if (wasPreviewing) togglePreview()

    startProcessing('Applying Soft Clipper...')
    try {
      const buffer = await applySoftClipperRegion(
        state.segments, start, end,
        currentParams(),
        state.currentFile.sampleRate, state.currentFile.channels
      )
      const bufferId = replaceRegion(start, end, buffer, 'Soft Clip')
      const cache = await computePeakCache(buffer, 256)
      setPeakCache(bufferId, cache)
      showToast('Soft Clipper applied')
    } catch (err) {
      console.error('Soft Clipper failed:', err)
      showToast('Soft Clipper failed')
    } finally {
      endProcessing()
    }
  }

  function teardown() {
    stopMeters()
    // A measurement landing after the panel is gone would push a param at a
    // chain that is no longer previewing, and leave `busy` lit forever.
    if (ceilingTimer !== null) {
      clearTimeout(ceilingTimer)
      ceilingTimer = null
    }
    ceilingSeq++
    ceilingBusy.value = false
    if (clipperPreview.value) {
      const ctx = getAudioContext()
      const chain = getEffectChain(ctx)
      chain.setEnabled(softClipperEffect.id, false)
      clipperPreview.value = false
    }
    // Leaving DELTA latched would hand the next session a residual-only
    // monitor under a header that no longer says so. Read off the chain rather
    // than a retained handle — apply() has already dropped the meter loop's.
    if (clipperDelta.value) {
      clipperDelta.value = false
      getEffectChainIfExists()?.effects
        .find(e => e.id === softClipperEffect.id)?.nodes?.setMonitorDelta(false)
    }
  }

  function openModal() {
    openWindow(SOFT_CLIPPER_WINDOW_ID)
  }

  function closeModal() {
    closeWindow(SOFT_CLIPPER_WINDOW_ID)
  }

  return {
    headroomDb,
    outputTrimDb,
    thresholdMode,
    fixedThresholdDb,
    ceilingPreset,
    ceilingBusy,
    CEILING_PRESETS,
    shape,
    limiter,
    limiterMode,
    LIMITER_MODES,
    setLimiterMode,
    limiterLatencyMs,
    emphasisDb,
    tuningOn,
    clipperPreview,
    clipperReduction,
    clipperEngagedPct,
    clipperLiftDb,
    clipperResidualDbc,
    clipperDelta,
    clipperInputLevels,
    clipperOutputLevels,
    getScope,
    hasSelection,
    togglePreview,
    toggleDelta,
    syncHeadroom,
    syncLimiter,
    syncEmphasis,
    syncOutputTrim,
    syncFixedThreshold,
    setThresholdMode,
    setShape,
    applyCeilingPreset,
    scheduleCeilingPreset,
    apply,
    teardown,
    openModal,
    closeModal,
  }
}
