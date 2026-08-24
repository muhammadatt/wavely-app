import { ref } from 'vue'
import { useEditorState } from './useEditorState.js'
import { useWindows } from './useWindows.js'
import {
  applySoftClipperRegion, computePeakCache, computeSoftClipperSpeechLevel,
} from '../audio/processing.js'
import { getEffectChain, getEffectChainIfExists } from '../audio/effectChain.js'
import { softClipperEffect, SOFT_CLIPPER_DEFAULTS } from '../audio/effects/softClipper.js'
import { snapshotLevels } from '../audio/effects/levelTap.js'
import { DEFAULT_DRIVE_RATIOS, driveTuningEnabled, clampRatio } from '../audio/softClipperTuning.js'

// Registry id of this plugin's window. Must match the entry in src/ui/registry.js.
export const SOFT_CLIPPER_WINDOW_ID = 'soft-clipper'

// Singleton reactive state shared between the sidebar trigger and the modal —
// same pattern as useFET1176.js / useLA2A.js.
const headroomDb = ref(SOFT_CLIPPER_DEFAULTS.headroomDb)
const outputTrimDb = ref(SOFT_CLIPPER_DEFAULTS.outputTrimDb)
const thresholdMode = ref(SOFT_CLIPPER_DEFAULTS.thresholdMode)
const fixedThresholdDb = ref(SOFT_CLIPPER_DEFAULTS.fixedThresholdDb)
const shape = ref(SOFT_CLIPPER_DEFAULTS.shape)
const drive = ref(SOFT_CLIPPER_DEFAULTS.drive)
const limiter = ref(SOFT_CLIPPER_DEFAULTS.limiter)
// ⚠ TEMPORARY: the Drive split, adjustable by ear behind a flag. See
// softClipperTuning.js — this and the three knobs come out once the ratios
// are settled.
const tuningOn = driveTuningEnabled()
const driveRatios = ref({ ...DEFAULT_DRIVE_RATIOS })

/**
 * The region's measured speech level, for STATIC threshold mode.
 *
 * A MEASURED PARAMETER, exactly like Scheps' wet trim and the compressors'
 * auto-makeup: measured once in the worker, handed to the kernel as a number,
 * used unchanged by both the preview and the apply render. That is what keeps
 * the two sample-identical — there is no second pass, nothing settles under a
 * running preview, and nothing depends on how much audio has been heard.
 *
 * null means "not measured", and the kernel falls back to the adaptive tracker
 * rather than rendering against a missing number. See staticThreshold.js.
 */
const speechLevelDb = ref(null)
const speechLevelBusy = ref(false)
/**
 * WHICH REGION THE MEASUREMENT BELONGS TO.
 *
 * Without this, moving the selection leaves the previous region's level in
 * place until the new measurement lands, and an Apply in that window renders
 * against a threshold measured somewhere else — silently, and differently from
 * what was previewed. Invalidating to null instead would be worse: the preview
 * would audibly drop back to adaptive on every selection nudge. So the value is
 * kept for the preview and CHECKED at apply.
 */
let speechLevelRegion = null

// Debounce + supersede, shared across every useSoftClipper() caller. Unlike the
// trim measurements this does NOT follow the knobs — no soft clipper parameter
// changes what the tracker reads, only the region does — so it fires on
// selection changes and on entering static mode, and a debounce is enough.
const SPEECH_LEVEL_DEBOUNCE_MS = 90
let speechTimer = null
let speechSeq = 0

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
    drive: drive.value,
    limiter: limiter.value,
    staticSpeechLevelDb: speechLevelDb.value,
    ...(tuningOn ? { driveRatios: { ...driveRatios.value } } : {}),
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
      refreshSpeechLevel()
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
   * Re-measure the region's speech level for static mode.
   *
   * Superseded calls are discarded by sequence number, so dragging a selection
   * edge cannot land an older measurement after a newer one — the same guard
   * the trim measurements use, and it matters more here: a stale speech level
   * puts the threshold in the wrong place for the whole region rather than
   * merely mis-trimming it.
   */
  async function refreshSpeechLevel() {
    if (thresholdMode.value !== 'static') return
    if (!state.selection || !state.currentFile) return

    const { start, end } = state.selection
    const seq = ++speechSeq
    speechLevelBusy.value = true
    try {
      const measured = await computeSoftClipperSpeechLevel(
        state.segments, start, end,
        state.currentFile.sampleRate, state.currentFile.channels,
      )
      if (seq !== speechSeq) return // a newer measurement is already in flight
      speechLevelDb.value = measured
      speechLevelRegion = { start, end }
      pushParam('staticSpeechLevelDb', measured)
    } catch (err) {
      console.error('Soft Clipper speech level measurement failed:', err)
      // Leave the previous value alone rather than clearing it: falling back to
      // adaptive on a transient worker failure would change the sound without
      // the user touching anything.
    } finally {
      if (seq === speechSeq) speechLevelBusy.value = false
    }
  }

  function scheduleSpeechLevel() {
    if (thresholdMode.value !== 'static') return
    if (speechTimer !== null) clearTimeout(speechTimer)
    speechTimer = setTimeout(() => {
      speechTimer = null
      refreshSpeechLevel()
    }, SPEECH_LEVEL_DEBOUNCE_MS)
  }

  const syncHeadroom = (v) => { headroomDb.value = v; pushParam('headroomDb', v) }
  const syncDrive = (v) => { drive.value = v; pushParam('drive', v) }
  const syncLimiter = (v) => { limiter.value = v; pushParam('limiter', v) }
  const syncRatio = (name, v) => {
    driveRatios.value = { ...driveRatios.value, [name]: clampRatio(v) }
    pushParam('driveRatios', { ...driveRatios.value })
  }
  const syncOutputTrim = (v) => { outputTrimDb.value = v; pushParam('outputTrimDb', v) }
  const syncFixedThreshold = (v) => { fixedThresholdDb.value = v; pushParam('fixedThresholdDb', v) }

  function setShape(v) {
    shape.value = v
    pushParam('shape', v)
  }

  function setThresholdMode(mode) {
    thresholdMode.value = mode
    pushParam('thresholdMode', mode)
    // Entering static mode with no measurement would silently run adaptive —
    // the kernel's fallback is a safety net, not a mode.
    if (mode === 'static') refreshSpeechLevel()
  }

  async function apply() {
    if (!state.selection) return
    const { start, end } = state.selection

    const wasPreviewing = clipperPreview.value
    if (wasPreviewing) togglePreview()

    startProcessing('Applying Soft Clipper...')
    try {
      // ⚠ NEVER APPLY STATIC MODE AGAINST A MISSING MEASUREMENT. The kernel
      // falls back to the adaptive tracker when staticSpeechLevelDb is not
      // finite, which is right as a safety net and wrong as a silent outcome:
      // the render would differ from the preview and nothing would say so.
      // The measurement is deterministic for a given region, so measuring here
      // returns the number the preview already used.
      const stale = speechLevelRegion === null
        || speechLevelRegion.start !== start
        || speechLevelRegion.end !== end
      if (thresholdMode.value === 'static' && (speechLevelDb.value === null || stale)) {
        await refreshSpeechLevel()
      }
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
    if (speechTimer !== null) {
      clearTimeout(speechTimer)
      speechTimer = null
    }
    speechSeq++
    speechLevelBusy.value = false
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
    speechLevelDb,
    speechLevelBusy,
    shape,
    drive,
    limiter,
    tuningOn,
    driveRatios,
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
    syncDrive,
    syncLimiter,
    syncRatio,
    syncOutputTrim,
    syncFixedThreshold,
    setThresholdMode,
    setShape,
    refreshSpeechLevel,
    scheduleSpeechLevel,
    apply,
    teardown,
    openModal,
    closeModal,
  }
}
