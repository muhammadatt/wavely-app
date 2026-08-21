import { ref } from 'vue'
import { useEditorState } from './useEditorState.js'
import { useWindows } from './useWindows.js'
import { applyResonanceRegion, computePeakCache } from '../audio/processing.js'
import { getEffectChain, getEffectChainIfExists } from '../audio/effectChain.js'
import { resonanceEffect, RESONANCE_DEFAULTS } from '../audio/effects/resonance.js'
import { resolveRefMode, withRefModeDefaults } from '../audio/resonanceParams.js'
import { snapshotLevels } from '../audio/effects/levelTap.js'

// Registry id of this plugin's window. Must match the entry in src/ui/registry.js.
export const RESONANCE_WINDOW_ID = 'resonance-suppressor'

/**
 * Shipping defaults, with any reference-mode override applied.
 *
 * Resolved once, at module load: `?resoRef=peak` seeds the panel's knobs with
 * that mode's calibration, because the two references disagree about what
 * `selectivity` measures by an order of magnitude and the same numbers on the
 * two are not the same setting. See RESONANCE_REF_MODE_DEFAULTS.
 */
const DEFAULTS = withRefModeDefaults(RESONANCE_DEFAULTS)

/** True when something has asked for a non-shipping reference. Shown in the panel. */
export const resRefMode = resolveRefMode()

// Singleton reactive state shared between the sidebar trigger and the modal.
const resAttack = ref(DEFAULTS.attack)
const resRelease = ref(DEFAULTS.release)
const resMaxReduction = ref(DEFAULTS.maxReduction)
const resMode = ref(DEFAULTS.mode)
const resPreserveHarmonics = ref(DEFAULTS.preserveHarmonics)
const resPitchRange = ref(DEFAULTS.pitchRange)
const resMix = ref(DEFAULTS.mix)
/**
 * Sensitivity zones — see DEFAULT_RESONANCE_ZONES. Not filters.
 *
 * An array rather than a scalar, so every write replaces it: the panel edits
 * these by emitting a new array, and the kernel is handed a fresh copy on each
 * change. Nothing mutates a zone in place, which is what keeps the worklet's
 * copy and the panel's copy from diverging.
 */
const resZones = ref(DEFAULTS.zones ?? [])
/** Which zone the strip is editing. UI state, never sent to the kernel. */
const resSelectedZone = ref(0)
const resTrim = ref(DEFAULTS.trim)

const resPreview = ref(false)
/**
 * Auditioning the difference rather than the result.
 *
 * Deliberately not a member of currentParams(): that object is what apply()
 * hands the offline renderer, and a monitoring mode in there would be one
 * spread away from writing a difference signal into the timeline.
 */
const resDelta = ref(false)
const resReduction = ref(0)
const resInputLevels = ref([])
const resOutputLevels = ref([])
let meterId = null

/**
 * The live effect's nodes while the preview is running, or null.
 *
 * Held outside the reactive state on purpose. The spectrum display reads a
 * 576-float frame every animation frame; putting that through a ref would make
 * Vue diff a typed array 60 times a second to redraw a canvas that does not
 * care about reactivity. The meter loop owns this handle's lifetime, so the
 * display goes dark the moment the preview stops.
 */
let resNodes = null

/** Latest per-frequency frame, for a display that draws it directly. */
function resDisplayFn() {
  return resNodes?.getDisplay() ?? null
}

function currentParams() {
  return {
    attack: resAttack.value,
    release: resRelease.value,
    maxReduction: resMaxReduction.value,
    mix: resMix.value,
    trim: resTrim.value,
    zones: resZones.value,
    refMode: DEFAULTS.refMode ?? RESONANCE_DEFAULTS.refMode,
    mode: resMode.value,
    preserveHarmonics: resPreserveHarmonics.value,
    pitchRange: resPitchRange.value,
  }
}

export function useResonance() {
  const {
    state, getAudioContext, hasSelection, replaceRegion, setPeakCache,
    startProcessing, endProcessing, showToast,
  } = useEditorState()
  const { openWindow, closeWindow } = useWindows()

  function initChain() {
    const ctx = getAudioContext()
    const chain = getEffectChain(ctx)
    if (!chain.effects.find(e => e.id === resonanceEffect.id)) {
      chain.addEffect(resonanceEffect)
    }
    return chain
  }

  function startMeters(chain) {
    stopMeters()
    resNodes = chain.effects.find(e => e.id === resonanceEffect.id)?.nodes ?? null
    function tick() {
      const nodes = resNodes
      if (nodes) {
        resReduction.value = nodes.getReduction()
        // Only meter channels the source really has: the splitter is
        // discrete, so asking for stereo on a mono file adds a dead bar.
        const chCount = state.currentFile?.channels ?? 1
        resInputLevels.value = snapshotLevels(nodes.getInputLevels(chCount))
        resOutputLevels.value = snapshotLevels(nodes.getOutputLevels(chCount))
      }
      meterId = requestAnimationFrame(tick)
    }
    meterId = requestAnimationFrame(tick)
  }

  function stopMeters() {
    if (meterId !== null) {
      cancelAnimationFrame(meterId)
      meterId = null
    }
    resNodes = null
    resReduction.value = 0
    resInputLevels.value = []
    resOutputLevels.value = []
  }

  function pushAllParams(chain) {
    for (const [name, value] of Object.entries(currentParams())) {
      chain.updateParam(resonanceEffect.id, name, value)
    }
    // Not in currentParams, so it needs restoring by hand when the preview is
    // switched back on.
    chain.effects.find(e => e.id === resonanceEffect.id)?.nodes
      ?.setMonitorDelta(resDelta.value)
  }

  /**
   * Hear only what is being removed.
   *
   * The most direct answer to "is it taking out the ring or the voice", and the
   * one question the display cannot settle on its own — a plot can show a
   * narrow cut landing on a peak and still not tell you that the peak was a
   * consonant. Nothing about the file changes: this is a monitoring mode, and
   * Apply renders the processed output whatever it is set to.
   */
  function toggleDelta() {
    resDelta.value = !resDelta.value
    resNodes?.setMonitorDelta(resDelta.value)
  }

  function togglePreview() {
    const chain = initChain()
    resPreview.value = !resPreview.value
    chain.setEnabled(resonanceEffect.id, resPreview.value)

    if (resPreview.value) {
      pushAllParams(chain)
      startMeters(chain)
    } else {
      stopMeters()
    }
  }

  function pushParam(name, value) {
    if (!resPreview.value) return
    const chain = getEffectChain(getAudioContext())
    chain.updateParam(resonanceEffect.id, name, value)
  }

  function syncParam(name, refVar, value) {
    refVar.value = value
    pushParam(name, value)
  }

  const syncAttack = v => syncParam('attack', resAttack, v)
  const syncRelease = v => syncParam('release', resRelease, v)
  const syncMaxReduction = v => syncParam('maxReduction', resMaxReduction, v)
  const syncMix = v => syncParam('mix', resMix, v)
  const syncTrim = v => syncParam('trim', resTrim, v)
  const syncZones = v => syncParam('zones', resZones, v)
  const syncMode = v => syncParam('mode', resMode, v)
  const syncPitchRange = v => syncParam('pitchRange', resPitchRange, v)

  function togglePreserveHarmonics() {
    syncParam('preserveHarmonics', resPreserveHarmonics, !resPreserveHarmonics.value)
  }

  async function apply() {
    if (!state.selection) return
    const { start, end } = state.selection

    const wasPreviewing = resPreview.value
    if (wasPreviewing) togglePreview()

    startProcessing('Suppressing resonances...')
    try {
      const buffer = await applyResonanceRegion(
        state.segments, start, end,
        currentParams(),
        state.currentFile.sampleRate, state.currentFile.channels,
      )
      const bufferId = replaceRegion(start, end, buffer, 'resonance suppression')
      const cache = await computePeakCache(buffer, 256)
      setPeakCache(bufferId, cache)
      showToast('Resonance suppression applied')
    } catch (err) {
      console.error('Resonance suppression failed:', err)
      showToast('Resonance suppression failed')
    } finally {
      endProcessing()
    }
  }

  function teardown() {
    stopMeters()
    if (resPreview.value) {
      const chain = getEffectChain(getAudioContext())
      chain.setEnabled(resonanceEffect.id, false)
      resPreview.value = false
    }
    // Cleared on the node too, not just in the ref. The effect entry outlives
    // this panel, so a mode left set on it would come back the next time the
    // preview was switched on — under a header that no longer said so. Read off
    // the chain rather than the meter loop's handle, which apply() has already
    // dropped by the time it gets here.
    if (resDelta.value) {
      resDelta.value = false
      getEffectChainIfExists()?.effects
        .find(e => e.id === resonanceEffect.id)?.nodes?.setMonitorDelta(false)
    }
  }

  function openModal() {
    openWindow(RESONANCE_WINDOW_ID)
  }

  function closeModal() {
    closeWindow(RESONANCE_WINDOW_ID)
  }

  return {
    resAttack,
    resRelease,
    resMaxReduction,
    resMix,
    resTrim,
    resZones,
    resSelectedZone,
    resRefMode,
    resMode,
    resPreserveHarmonics,
    resPitchRange,
    resPreview,
    resDelta,
    resReduction,
    resInputLevels,
    resOutputLevels,
    resDisplayFn,
    hasSelection,
    togglePreview,
    toggleDelta,
    syncAttack,
    syncRelease,
    syncMaxReduction,
    syncMix,
    syncTrim,
    syncZones,
    syncMode,
    syncPitchRange,
    togglePreserveHarmonics,
    apply,
    teardown,
    openModal,
    closeModal,
  }
}
