import { ref } from 'vue'
import { useEditorState } from './useEditorState.js'
import { useWindows } from './useWindows.js'
import { applySchepsRegion, computeSchepsTrim, computePeakCache } from '../audio/processing.js'
import { getEffectChain } from '../audio/effectChain.js'
import { schepsEffect, SCHEPS_DEFAULTS } from '../audio/effects/scheps.js'
import { snapshotLevels } from '../audio/effects/levelTap.js'

// Registry id of this plugin's window. Must match the entry in src/ui/registry.js.
export const SCHEPS_WINDOW_ID = 'scheps-parallel'

// Singleton reactive state shared between the sidebar trigger and the modal.
const schepsCharacter = ref(SCHEPS_DEFAULTS.character)
const schepsSquash = ref(SCHEPS_DEFAULTS.squash)
const schepsMix = ref(SCHEPS_DEFAULTS.mix)
const schepsOutput = ref(SCHEPS_DEFAULTS.output)

/**
 * The two measured numbers behind the blend: the wet-path trim, and the
 * dry/wet correlation that corrects the mix law. Both come from the region
 * being edited, so they follow the material.
 *
 * Auto trim is on by default, for the same reason the compressors' auto makeup
 * is: without it, pushing Mix mostly makes things louder, and every A/B the
 * user runs is then decided by loudness rather than by character — which is the
 * one comparison this plugin exists to let them make honestly.
 */
const schepsAutoTrim = ref(true)
const schepsAutoTrimBusy = ref(false)
const schepsWetTrimDb = ref(SCHEPS_DEFAULTS.wetTrimDb)
const schepsCorrelation = ref(SCHEPS_DEFAULTS.correlation)
const schepsDensityDb = ref(SCHEPS_DEFAULTS.densityDb)

const schepsPreview = ref(false)
const schepsReduction = ref(0)
const schepsInputLevels = ref([])
const schepsOutputLevels = ref([])
let meterId = null

// Debounce + supersede state for the trim measurement, shared across every
// useScheps() caller so knob drags coalesce into one measurement. This pass is
// heavier than the compressors' — it runs two EQ cascades and the opto cell —
// so the window is longer than theirs.
const TRIM_DEBOUNCE_MS = 90
let trimTimer = null
let trimSeq = 0
let trimBurstActive = false
let trimBurstDirty = false

function currentParams() {
  return {
    character: schepsCharacter.value,
    squash: schepsSquash.value,
    mix: schepsMix.value,
    output: schepsOutput.value,
    wetTrimDb: schepsWetTrimDb.value,
    correlation: schepsCorrelation.value,
    densityDb: schepsDensityDb.value,
  }
}

/** Params for the measurement pass — the trim is what we're solving for. */
function measurementParams() {
  return {
    character: schepsCharacter.value,
    squash: schepsSquash.value,
  }
}

export function useScheps() {
  const {
    state, getAudioContext, hasSelection, replaceRegion, setPeakCache,
    startProcessing, endProcessing, showToast,
  } = useEditorState()
  const { openWindow, closeWindow } = useWindows()

  function initChain() {
    const ctx = getAudioContext()
    const chain = getEffectChain(ctx)
    if (!chain.effects.find(e => e.id === schepsEffect.id)) {
      chain.addEffect(schepsEffect)
    }
    return chain
  }

  function startMeters(chain) {
    stopMeters()
    function tick() {
      const nodes = chain.effects.find(e => e.id === schepsEffect.id)?.nodes
      if (nodes) {
        schepsReduction.value = nodes.getReduction()
        // Only meter channels the source really has: the splitter is
        // discrete, so asking for stereo on a mono file adds a dead bar.
        const chCount = state.currentFile?.channels ?? 1
        schepsInputLevels.value = snapshotLevels(nodes.getInputLevels(chCount))
        schepsOutputLevels.value = snapshotLevels(nodes.getOutputLevels(chCount))
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
    schepsReduction.value = 0
    schepsInputLevels.value = []
    schepsOutputLevels.value = []
  }

  function pushAllParams(chain) {
    for (const [name, value] of Object.entries(currentParams())) {
      chain.updateParam(schepsEffect.id, name, value)
    }
  }

  function togglePreview() {
    const chain = initChain()
    schepsPreview.value = !schepsPreview.value
    chain.setEnabled(schepsEffect.id, schepsPreview.value)

    if (schepsPreview.value) {
      pushAllParams(chain)
      startMeters(chain)
      refreshAutoTrim()
    } else {
      stopMeters()
    }
  }

  function pushParam(name, value) {
    if (!schepsPreview.value) return
    const chain = getEffectChain(getAudioContext())
    chain.updateParam(schepsEffect.id, name, value)
  }

  /**
   * Re-measure the wet trim and correlation for the current selection and
   * settings. Superseded calls are discarded by sequence number so a fast knob
   * drag can't have an older measurement land after a newer one.
   */
  async function refreshAutoTrim() {
    if (!schepsAutoTrim.value || !state.selection || !state.currentFile) return

    const { start, end } = state.selection
    const seq = ++trimSeq
    schepsAutoTrimBusy.value = true
    try {
      const { trimDb, correlation, densityDb } = await computeSchepsTrim(
        state.segments, start, end,
        measurementParams(),
        state.currentFile.sampleRate, state.currentFile.channels,
      )
      if (seq !== trimSeq) return // a newer measurement is already in flight
      schepsWetTrimDb.value = trimDb
      schepsCorrelation.value = correlation
      schepsDensityDb.value = densityDb
      pushParam('wetTrimDb', trimDb)
      pushParam('correlation', correlation)
      pushParam('densityDb', densityDb)
    } catch (err) {
      console.error('Scheps auto trim measurement failed:', err)
    } finally {
      if (seq === trimSeq) schepsAutoTrimBusy.value = false
    }
  }

  function scheduleAutoTrim() {
    if (!schepsAutoTrim.value) return

    // Leading edge: the first move in a burst measures immediately so the
    // readout responds right away.
    if (!trimBurstActive) {
      trimBurstActive = true
      trimBurstDirty = false
      refreshAutoTrim()
    } else {
      trimBurstDirty = true
    }

    if (trimTimer !== null) clearTimeout(trimTimer)
    trimTimer = setTimeout(() => {
      trimTimer = null
      const shouldRunTrailing = trimBurstDirty
      trimBurstActive = false
      trimBurstDirty = false
      if (shouldRunTrailing) refreshAutoTrim()
    }, TRIM_DEBOUNCE_MS)
  }

  // Only the two params that change what the wet path sounds like need a
  // re-measure. Mix does not: the trim is a property of the wet path alone, and
  // the mix law already accounts for the blend. Output does not either — it is
  // a deliberate deviation applied after everything.
  function syncCharacter(v) {
    schepsCharacter.value = v
    pushParam('character', v)
    scheduleAutoTrim()
  }

  function syncSquash(v) {
    schepsSquash.value = v
    pushParam('squash', v)
    scheduleAutoTrim()
  }

  function syncMix(v) {
    schepsMix.value = v
    pushParam('mix', v)
  }

  function syncOutput(v) {
    schepsOutput.value = v
    pushParam('output', v)
  }

  function toggleAutoTrim() {
    schepsAutoTrim.value = !schepsAutoTrim.value
    if (schepsAutoTrim.value) {
      refreshAutoTrim()
      return
    }

    // Off means no wet trim at all, and a textbook equal-power blend. Leaving
    // the last measured pair in place would be worse than either: the readout
    // would claim a match that stops being true the moment anything changes.
    if (trimTimer !== null) {
      clearTimeout(trimTimer)
      trimTimer = null
    }
    trimBurstActive = false
    trimBurstDirty = false
    trimSeq++ // discard any in-flight measurement
    schepsAutoTrimBusy.value = false
    schepsWetTrimDb.value = 0
    schepsCorrelation.value = 0
    schepsDensityDb.value = 0
    pushParam('wetTrimDb', 0)
    pushParam('correlation', 0)
    pushParam('densityDb', 0)
  }

  async function apply() {
    if (!state.selection) return
    const { start, end } = state.selection

    const wasPreviewing = schepsPreview.value
    if (wasPreviewing) togglePreview()

    startProcessing('Applying Scheps Parallel...')
    try {
      const buffer = await applySchepsRegion(
        state.segments, start, end,
        currentParams(),
        state.currentFile.sampleRate, state.currentFile.channels,
      )
      const bufferId = replaceRegion(start, end, buffer)
      const cache = await computePeakCache(buffer, 256)
      setPeakCache(bufferId, cache)
      showToast('Scheps Parallel applied')
    } catch (err) {
      console.error('Scheps Parallel failed:', err)
      showToast('Scheps Parallel failed')
    } finally {
      endProcessing()
    }
  }

  function teardown() {
    stopMeters()
    if (schepsPreview.value) {
      const chain = getEffectChain(getAudioContext())
      chain.setEnabled(schepsEffect.id, false)
      schepsPreview.value = false
    }
  }

  function openModal() {
    openWindow(SCHEPS_WINDOW_ID)
  }

  function closeModal() {
    closeWindow(SCHEPS_WINDOW_ID)
  }

  return {
    schepsCharacter,
    schepsSquash,
    schepsMix,
    schepsOutput,
    schepsAutoTrim,
    schepsAutoTrimBusy,
    schepsWetTrimDb,
    schepsCorrelation,
    schepsDensityDb,
    schepsPreview,
    schepsReduction,
    schepsInputLevels,
    schepsOutputLevels,
    hasSelection,
    togglePreview,
    syncCharacter,
    syncSquash,
    syncMix,
    syncOutput,
    toggleAutoTrim,
    refreshAutoTrim,
    apply,
    teardown,
    openModal,
    closeModal,
  }
}
