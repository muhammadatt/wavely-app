import { ref } from 'vue'
import { useEditorState } from './useEditorState.js'
import { useWindows } from './useWindows.js'
import { applyResonanceRegion, computePeakCache, computeVoiceProfile } from '../audio/processing.js'
import { getEffectChain, getEffectChainIfExists } from '../audio/effectChain.js'
import { resonanceEffect, RESONANCE_DEFAULTS } from '../audio/effects/resonance.js'
import { resolveRefMode, withRefModeDefaults } from '../audio/resonanceParams.js'
import { placeResonanceZones } from '../audio/resonanceZonePlacement.js'
import { resolveTargeting } from '../audio/resonanceTargeting.js'
import { DEFAULT_RESONANCE_FOCUS, copyFocus } from '../audio/resonanceFocus.js'

// Registry id of this plugin's window. Must match the entry in src/ui/registry.js.
export const RESONANCE_WINDOW_ID = 'resonance-suppressor'

/**
 * Shipping defaults, with any reference-mode override applied.
 *
 * Resolved once, at module load: `?resoRef=cepstral` seeds the panel's knobs with
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
 * Which targeting model this session is running: 'zones' (ships) or 'focus'.
 *
 * Resolved once at module load rather than per render. Switching models
 * mid-session would mean two authoring surfaces editing one kernel, and the
 * question this flag exists to answer — which one can a person think in — is
 * not asked by flipping between them inside one panel; it is asked by working a
 * file in one and then working it in the other.
 */
export const resTargeting = resolveTargeting()

/**
 * The focus patch, or null when the zone model is running.
 *
 * `copyFocus` rather than the constant itself: DEFAULT_RESONANCE_FOCUS is a
 * module-level object, and handing it straight to a ref would let the first
 * knob move edit the default for the rest of the session.
 */
const resFocus = ref(resTargeting === 'focus' ? copyFocus(DEFAULT_RESONANCE_FOCUS) : null)
/** Which focus node the controls strip is editing. UI state, never a parameter. */
const resSelectedNode = ref(-1)

/**
 * Focus node whose region is being auditioned, or -1. UI STATE, NEVER A
 * PARAMETER.
 *
 * ⚠ THE SAME RULE AND THE SAME DANGER AS THE ZONE DELTA IT REPLACES, and for
 * the identical reason: `applyResonanceRegion` spreads the param object
 * straight into the kernel, and the isolation this rides on IS expressible as
 * an ordinary parameter — `focus.solo`. Nothing about it would LOOK wrong if it
 * leaked into what Apply renders. It would simply write a one-node pass into
 * the timeline.
 *
 * So `liveFocus()` applies it on the way to the live kernel only, and
 * `currentParams()` never consults it. Pinned by reading the source in
 * test/ui/resonanceFocusSolo.test.js, which is the only way to reach a
 * guarantee about a composable that cannot be imported under node.
 */
const resSoloNode = ref(-1)
/**
 * The `id` of the soloed node, so the solo can be reconciled after an edit.
 *
 * ⚠ THE INDEX ALONE IS NOT AN IDENTITY. Reported from use: deleting a node left
 * the delta monitor on, auditioning whatever node had shifted into that slot —
 * or, when the deleted node was the last one, nothing at all, with the panel
 * still lit. Every edit replaces the array, so an index survives a deletion
 * happily and silently means something else afterwards.
 *
 * The id is what does not move. `syncFocus` re-finds it on every edit and
 * clears the solo when it is gone, which covers deletion, reordering and
 * replacement with one rule rather than a special case per gesture.
 */
let soloId = null

/**
 * Zone whose removal is being auditioned, or -1. UI STATE, NEVER A PARAMETER.
 *
 * ⚠ THIS REPLACED PER-ZONE SOLO, and the two are one gesture apart: solo
 * isolated a zone and played what SURVIVED it, this isolates a zone and plays
 * what it TOOK OUT. Isolating is the same transform either way — every other
 * zone switched off — and the difference is the monitor the kernel is put in
 * while it holds. Solo answered "what does the file sound like with only this
 * band worked", which the global bypass already answers well enough; the
 * question a suppressor is actually asked is "what is this band removing", and
 * that needs the delta scoped to one zone rather than to the whole effect.
 *
 * Same rule as resDelta and for the same reason: `applyResonanceRegion` spreads
 * the param object straight into the kernel, so a monitoring mode living in
 * there would be one careless key from rendering an isolated pass into the
 * timeline. The isolation is expressible as ordinary parameters — every other
 * zone at depth zero — which is exactly what makes it dangerous, and why the
 * transform happens on the way to the LIVE kernel only. Apply always renders
 * the zones as they are set, in the processed monitor.
 */
const resDeltaZone = ref(-1)

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
 * Identical to the stored set unless a zone's delta is being auditioned, in
 * which case every other zone is switched off — which the kernel already
 * understands, so zone-scoped monitoring needs no mechanism of its own in the
 * DSP beyond the delta monitor it shares with the header's DELTA.
 */
function liveZones() {
  const only = resDeltaZone.value
  if (only < 0 || only >= resZones.value.length) return resZones.value
  return resZones.value.map((z, i) => ({ ...z, enabled: i === only }))
}

/**
 * Whether the kernel should be inverting: the header's DELTA, or a zone's.
 *
 * One monitor, two ways to ask for it. A zone delta forces it on regardless of
 * the header switch and hands the header switch back untouched when it clears,
 * so switching a zone's delta on and off again cannot silently turn the global
 * one off underneath someone.
 */
function monitoringDelta() {
  return resDelta.value || resDeltaZone.value >= 0 || resSoloNode.value >= 0
}

/**
 * The focus patch as the LIVE kernel should hear it.
 *
 * Identical to the stored patch unless a node's region is being auditioned, in
 * which case `solo` is set — which the curve builder already understands, so
 * node-scoped monitoring needs no mechanism of its own in the DSP beyond the
 * delta monitor it shares with the header's DELTA.
 */
function liveFocus() {
  const f = resFocus.value
  if (!f || resSoloNode.value < 0) return f
  return { ...f, solo: resSoloNode.value }
}

function currentParams() {
  return {
    attack: resAttack.value,
    release: resRelease.value,
    mix: resMix.value,
    trim: resTrim.value,
    zones: resZones.value,
    // Null under the zone model, which is what the kernel's dispatch reads as
    // "use zones". Present-and-null rather than absent — see RESONANCE_DEFAULTS.
    focus: resFocus.value,
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
    // Not from currentParams: that object is what Apply renders with, and a
    // zone's delta isolation must never reach it.
    chain.updateParam(resonanceEffect.id, 'zones', liveZones())
    chain.updateParam(resonanceEffect.id, 'focus', liveFocus())
    // Not in currentParams, so it needs restoring by hand when the preview is
    // switched back on.
    chain.effects.find(e => e.id === resonanceEffect.id)?.nodes
      ?.setMonitorDelta(monitoringDelta())
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
    resNodes?.setMonitorDelta(monitoringDelta())
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
   * A focus edit: the whole patch at once.
   *
   * One ref rather than one per field, and one push rather than several. The
   * globals and the nodes are read together by `buildResonanceFocusCurves` —
   * every per-bin threshold is `global.selectivity - bias`, so a node move and a
   * global move are the same kind of edit to the same curve. Splitting them
   * would mean two params that must arrive in the same frame to be coherent.
   */
  /**
   * A focus edit, with the solo reconciled against it.
   *
   * The reconcile is here rather than in the gestures because every route that
   * can invalidate a solo — the card's DELETE, the plot's double-click, the
   * keyboard's Delete — arrives through this one function, and a rule applied
   * per gesture is a rule with a gesture missing from it.
   */
  const syncFocus = (v) => {
    resFocus.value = v
    if (soloId !== null) {
      const at = (v?.nodes ?? []).findIndex(n => n.id === soloId)
      if (at < 0) clearFocusSolo()
      else resSoloNode.value = at
    }
    pushParam('focus', liveFocus())
  }

  /** Stop auditioning a node's region, and put the monitor back. */
  function clearFocusSolo() {
    if (resSoloNode.value < 0 && soloId === null) return
    resSoloNode.value = -1
    soloId = null
    resNodes?.setMonitorDelta(monitoringDelta())
  }

  /**
   * Hear what one node's region is removing, and nothing else.
   *
   * The node's own influence scoped to the delta monitor: inside its reach the
   * detector runs exactly as the full patch does, outside it nothing is
   * touched, and the kernel plays the complement. A second click on the same
   * node clears it.
   *
   * ⚠ ASKING IT OF A BYPASSED NODE IS NOT SILENCE, and that is the one place
   * this differs from the zone delta it replaces. A bypassed ZONE removed
   * nothing, so soloing it was honestly silent; a bypassed NODE only means "no
   * opinion here", and the global detector is still working that region — so
   * what you hear is what the region is losing anyway. That is the true answer
   * to the question being asked, and it is the more useful one.
   */
  function toggleFocusSolo(index) {
    const on = resSoloNode.value !== index
    resSoloNode.value = on ? index : -1
    soloId = on ? (resFocus.value?.nodes?.[index]?.id ?? null) : null
    pushParam('focus', liveFocus())
    resNodes?.setMonitorDelta(monitoringDelta())
  }

  /**
   * Hear what one zone is removing, and nothing else.
   *
   * Every other zone off plus the delta monitor: the kernel then computes its
   * gain from this zone alone and plays the complement, so what comes out is
   * that band's cut and silence everywhere else. A second click on the same
   * zone clears it, and asking it of a zone that is switched off is allowed —
   * the honest answer is nothing, which is a legitimate thing to hear when you
   * are deciding whether a band is the problem.
   */
  function toggleZoneDelta(index) {
    resDeltaZone.value = resDeltaZone.value === index ? -1 : index
    pushZones()
    resNodes?.setMonitorDelta(monitoringDelta())
  }

  function clearZoneDelta() {
    if (resDeltaZone.value < 0) return
    resDeltaZone.value = -1
    pushZones()
    resNodes?.setMonitorDelta(monitoringDelta())
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
      // A zone delta names a zone BY INDEX, and a re-partition moves every
      // index — so an audition left running would silently be of a different
      // band than the one it was switched on for.
      clearZoneDelta()
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
    // A zone delta is a monitoring state and the effect entry outlives this
    // panel, so one left set would come back the next time the preview was
    // switched on — under a panel that no longer said so. Same reason the
    // header's delta is cleared below.
    const wasMonitoring = monitoringDelta()
    resDeltaZone.value = -1
    resSoloNode.value = -1
    soloId = null
    resDelta.value = false
    // The measured voice goes too, and for the same reason: it describes the
    // file that was open, and coming back under a panel showing a different one
    // would put a stale F0 beside boundaries that were never placed from it.
    resVoiceProfile.value = null
    if (wasMonitoring) {
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
    resDeltaZone,
    resTargeting,
    resFocus,
    resSelectedNode,
    resSoloNode,
    syncFocus,
    toggleFocusSolo,
    clearFocusSolo,
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
    toggleZoneDelta,
    clearZoneDelta,
    syncMode,
    apply,
    teardown,
    openModal,
    closeModal,
  }
}
