import { ref } from 'vue'
import { useEditorState } from './useEditorState.js'
import { useWindows } from './useWindows.js'
import { applyResonanceRegion, computePeakCache, computeVoiceProfile } from '../audio/processing.js'
import { getEffectChain, getEffectChainIfExists } from '../audio/effectChain.js'
import { resonanceEffect, RESONANCE_DEFAULTS } from '../audio/effects/resonance.js'
import { resolveRefMode, withRefModeDefaults } from '../audio/resonanceParams.js'
import { placeResonanceZones } from '../audio/resonanceZonePlacement.js'

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
const resMode = ref(DEFAULTS.mode)
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

/**
 * Zone being soloed, or -1. UI STATE, NEVER A PARAMETER.
 *
 * Same rule as resDelta and for the same reason: `applyResonanceRegion` spreads
 * the param object straight into the kernel, so a monitoring mode living in
 * there would be one careless key from rendering a soloed pass into the
 * timeline. Solo is expressible as parameters — it is every other zone at depth
 * zero — which is exactly what makes it dangerous, and why the transform
 * happens on the way to the LIVE kernel only. Apply always renders the zones as
 * they are set.
 */
const resSoloZone = ref(-1)

/**
 * The voice the zones were last placed from, or null.
 *
 * `{ medianF0Hz, cornerHz, voiceType, boundaries }`. Kept so the panel can say
 * WHAT it measured rather than only that it measured — a boundary set that
 * moved for reasons the user cannot see is worse than one that did not move.
 * Cleared on teardown for the same reason the monitoring modes are: the effect
 * entry outlives the panel, and a stale reading would come back describing a
 * file that is no longer open.
 */
const resVoiceProfile = ref(null)
const resPlacementBusy = ref(false)

/**
 * ⚠ ITS OWN COUNTER, not one shared with any other measurement.
 *
 * Sharing a sequence number across two independent measurements is a latching
 * bug, and the soft clipper shipped it: the second call invalidates the first,
 * the first's `finally` then declines to lower the flag it raised, and the busy
 * state never clears. Supersession is per-measurement because that is what it
 * means — a newer placement cancels an older placement and nothing else.
 */
let placementSeq = 0

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

/**
 * The zones as the live kernel should hear them.
 *
 * Identical to the stored set unless a zone is soloed, in which case every
 * other zone is switched off — which the kernel already understands, so solo
 * needs no mechanism of its own in the DSP.
 */
function liveZones() {
  const solo = resSoloZone.value
  if (solo < 0 || solo >= resZones.value.length) return resZones.value
  return resZones.value.map((z, i) => ({ ...z, enabled: i === solo }))
}

function currentParams() {
  return {
    attack: resAttack.value,
    release: resRelease.value,
    mix: resMix.value,
    trim: resTrim.value,
    zones: resZones.value,
    refMode: DEFAULTS.refMode ?? RESONANCE_DEFAULTS.refMode,
    mode: resMode.value,
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
  }

  function pushAllParams(chain) {
    for (const [name, value] of Object.entries(currentParams())) {
      chain.updateParam(resonanceEffect.id, name, value)
    }
    // Not from currentParams: that object is what Apply renders with, and solo
    // must never reach it.
    chain.updateParam(resonanceEffect.id, 'zones', liveZones())
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
  const syncMix = v => syncParam('mix', resMix, v)
  const syncTrim = v => syncParam('trim', resTrim, v)
  function pushZones() {
    pushParam('zones', liveZones())
  }

  const syncZones = (v) => {
    resZones.value = v
    pushZones()
  }

  /**
   * Hear one zone's processing alone.
   *
   * A second click on the same zone clears it, and selecting solo on a zone
   * that is switched off is allowed — it means "nothing", which is a legitimate
   * thing to want to hear when you are deciding whether a band is the problem.
   */
  function toggleSolo(index) {
    resSoloZone.value = resSoloZone.value === index ? -1 : index
    pushZones()
  }

  function clearSolo() {
    if (resSoloZone.value < 0) return
    resSoloZone.value = -1
    pushZones()
  }
  const syncMode = v => syncParam('mode', resMode, v)

  /**
   * Put the zone boundaries where this voice's spectrum actually changes.
   *
   * A STARTING POINT THAT WRITES VALUES, not a mode — the same shape as the
   * soft clipper's ceiling presets. It measures the selection once, rewrites
   * the four boundaries, and gets out of the way; every boundary is an ordinary
   * draggable line afterwards, and nothing re-runs on its own.
   *
   * ⚠ IT IS NOT WIRED TO SELECTION CHANGES, deliberately. The ceiling presets
   * re-measure on every new region because a ceiling in dBFS is meaningless
   * until it is placed against material. A zone boundary is not: it describes
   * the speaker, and re-placing it under the user every time they drag a
   * selection would move controls they had set by hand.
   *
   * ⚠ A null measurement LEAVES THE ZONES ALONE. A region with no pitched
   * material has no voice to aim at, and moving the boundaries to some fallback
   * would be worse than not moving them — the user asked for geometry derived
   * from this speaker and there isn't any.
   */
  async function fitZonesToVoice() {
    if (!state.selection || !state.currentFile) return

    const { start, end } = state.selection
    const seq = ++placementSeq
    resPlacementBusy.value = true
    try {
      const profile = await computeVoiceProfile(
        state.segments, start, end,
        state.currentFile.sampleRate, state.currentFile.channels,
      )
      if (seq !== placementSeq) return // a newer placement is already in flight
      if (!profile) {
        showToast('Not enough voiced audio to fit zones')
        return
      }
      const placed = placeResonanceZones(resZones.value, profile)
      if (!placed) return

      resZones.value = placed.zones
      resVoiceProfile.value = { ...profile, voiceType: placed.voiceType, boundaries: placed.boundaries }
      // The count can grow, so a selection past the new end would point at
      // nothing; it cannot shrink, but clamping costs nothing and says so.
      resSelectedZone.value = Math.min(resSelectedZone.value, placed.zones.length - 1)
      clearSolo()
      pushZones()
      showToast(`Zones fitted to voice (F0 ${Math.round(profile.medianF0Hz)} Hz)`)
    } catch (err) {
      console.error('Zone placement failed:', err)
      showToast('Zone placement failed')
    } finally {
      if (seq === placementSeq) resPlacementBusy.value = false
    }
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
    // Solo is a monitoring state and the effect entry outlives this panel, so
    // one left set would come back the next time the preview was switched on —
    // under a panel that no longer said so. Same reason delta is cleared below.
    resSoloZone.value = -1
    resVoiceProfile.value = null
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
    resMix,
    resTrim,
    resZones,
    resSelectedZone,
    resSoloZone,
    resRefMode,
    resMode,
    resPreview,
    resDelta,
    resReduction,
    resDisplayFn,
    hasSelection,
    togglePreview,
    toggleDelta,
    syncAttack,
    syncRelease,
    syncMix,
    syncTrim,
    syncZones,
    resVoiceProfile,
    resPlacementBusy,
    fitZonesToVoice,
    toggleSolo,
    clearSolo,
    syncMode,
    apply,
    teardown,
    openModal,
    closeModal,
  }
}
