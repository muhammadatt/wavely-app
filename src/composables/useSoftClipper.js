import { ref } from 'vue'
import { useEditorState } from './useEditorState.js'
import { useWindows } from './useWindows.js'
import { applySoftClipperRegion, computePeakCache } from '../audio/processing.js'
import { getEffectChain, getEffectChainIfExists } from '../audio/effectChain.js'
import { softClipperEffect, SOFT_CLIPPER_DEFAULTS } from '../audio/effects/softClipper.js'
import { snapshotLevels } from '../audio/effects/levelTap.js'

// Registry id of this plugin's window. Must match the entry in src/ui/registry.js.
export const SOFT_CLIPPER_WINDOW_ID = 'soft-clipper'

// Singleton reactive state shared between the sidebar trigger and the modal —
// same pattern as useFET1176.js / useLA2A.js.
const headroomDb = ref(SOFT_CLIPPER_DEFAULTS.headroomDb)
const emphasisDb = ref(SOFT_CLIPPER_DEFAULTS.emphasisDb)
const outputTrimDb = ref(SOFT_CLIPPER_DEFAULTS.outputTrimDb)
const thresholdMode = ref(SOFT_CLIPPER_DEFAULTS.thresholdMode)
const fixedThresholdDb = ref(SOFT_CLIPPER_DEFAULTS.fixedThresholdDb)
const shape = ref(SOFT_CLIPPER_DEFAULTS.shape)

const clipperPreview = ref(false)
const clipperReduction = ref(0)
// Share of voiced blocks the curve engaged on, 0-100. See the kernel's
// ENGAGED_TAU_S for why this sits beside the dB reading rather than replacing
// it.
const clipperEngagedPct = ref(0)
// How much of HF Emphasis's boost the threshold is giving back, dB. See
// LIFT_TAU_S in the kernel.
const clipperLiftDb = ref(0)
const clipperDelta = ref(false)
const clipperInputLevels = ref([])
const clipperOutputLevels = ref([])
let meterId = null

function currentParams() {
  return {
    headroomDb: headroomDb.value,
    emphasisDb: emphasisDb.value,
    outputTrimDb: outputTrimDb.value,
    thresholdMode: thresholdMode.value,
    fixedThresholdDb: fixedThresholdDb.value,
    shape: shape.value,
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
    } else {
      stopMeters()
    }
  }

  function pushParam(name, value) {
    if (!clipperPreview.value) return
    const chain = getEffectChain(getAudioContext())
    chain.updateParam(softClipperEffect.id, name, value)
  }

  const syncHeadroom = (v) => { headroomDb.value = v; pushParam('headroomDb', v) }
  const syncEmphasis = (v) => { emphasisDb.value = v; pushParam('emphasisDb', v) }
  const syncOutputTrim = (v) => { outputTrimDb.value = v; pushParam('outputTrimDb', v) }
  const syncFixedThreshold = (v) => { fixedThresholdDb.value = v; pushParam('fixedThresholdDb', v) }

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
    emphasisDb,
    outputTrimDb,
    thresholdMode,
    fixedThresholdDb,
    shape,
    clipperPreview,
    clipperReduction,
    clipperEngagedPct,
    clipperLiftDb,
    clipperDelta,
    clipperInputLevels,
    clipperOutputLevels,
    getScope,
    hasSelection,
    togglePreview,
    toggleDelta,
    syncHeadroom,
    syncEmphasis,
    syncOutputTrim,
    syncFixedThreshold,
    setThresholdMode,
    setShape,
    apply,
    teardown,
    openModal,
    closeModal,
  }
}
