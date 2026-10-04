import { reactive, ref } from 'vue'
import { useEditorState } from './useEditorState.js'
import { useWindows } from './useWindows.js'
import {
  applyPhatassRegion, cancelPhatassWarmthPeak, computePeakCache, measurePhatassWarmthBands,
  measurePhatassWarmthPeak,
} from '../audio/processing.js'
import { regionAlignDb, regionPeakDb } from '../audio/analysisWindow.js'
import { ALIGN_TARGET_DBFS } from '../audio/dsp/inputAlign.js'
import { getEffectChain } from '../audio/effectChain.js'
import { phatassEffect, PHATASS_DEFAULTS } from '../audio/effects/phatass.js'
import { WARMTH_LAYERS, warmthActive } from '../audio/phatassParams.js'
import { measureBandSpectrum, bandRefPeakDb } from '../audio/saturationBenchAnalysis.js'
import { snapshotLevels } from '../audio/effects/levelTap.js'

// Registry id of this plugin's window. Must match the entry in src/ui/registry.js.
export const PHATASS_WINDOW_ID = 'phatass'

// Singleton reactive state shared between the sidebar trigger and the modal.
// `voiceLevelDb`, `warmthRefPeaksDb` and `warmthCeilingDb` are in here because
// the kernel needs them, but they are measured, never set from the panel.
const phParams = reactive({ ...PHATASS_DEFAULTS })
const phPreview = ref(false)
const phInputLevels = ref([])
const phOutputLevels = ref([])
let meterId = null
let levelMeasuredFor = null
let ceilingMeasuredFor = null
// Warmth readout: what the Warmth stage does to the selection's low end, per
// band, and the peak it leaves (phatassWarmthReadout.js). `bandsDb` /
// `peakDb` null = not measured; the pending flags say a pass is in flight.
const phWarmthReadout = ref({ bandsDb: null, peakDb: null, inputPeakDb: null, bandsPending: false, peakPending: false })
let readoutTimer = null
let readoutSeq = 0
const MEASURED = new Set(['voiceLevelDb', 'warmthRefPeaksDb', 'warmthCeilingDb'])

export function usePhatass() {
  const {
    state, appState, getAudioContext, hasSelection, replaceRegion, setPeakCache,
    startProcessing, endProcessing, showToast, totalDuration,
  } = useEditorState()
  const { openWindow, closeWindow } = useWindows()

  function initChain() {
    const chain = getEffectChain(getAudioContext())
    if (!chain.effects.find(e => e.id === phatassEffect.id)) chain.addEffect(phatassEffect)
    return chain
  }

  function nodesOf(chain) {
    return chain.effects.find(e => e.id === phatassEffect.id)?.nodes
  }

  function startMeters(chain) {
    stopMeters()
    function tick() {
      const nodes = nodesOf(chain)
      if (nodes) {
        const chCount = state.currentFile?.channels ?? 1
        phInputLevels.value = snapshotLevels(nodes.getInputLevels(chCount))
        phOutputLevels.value = snapshotLevels(nodes.getOutputLevels(chCount))
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
    phInputLevels.value = []
    phOutputLevels.value = []
  }

  function pushParam(name, value) {
    if (!phPreview.value) return
    getEffectChain(getAudioContext()).updateParam(phatassEffect.id, name, value)
  }

  /**
   * Measure the file's voice level and move the tape shelf's threshold with
   * it, so a Tame setting means the same thing on a quiet recording and a hot one.
   *
   * ⚠ THE WHOLE FILE, NEVER THE SELECTION, and the same gated-RMS statistic —
   * the rule OptoSmooth's input alignment and the HF Softener's level offset
   * already follow, so all three read one number for one file. Measured per
   * selection, a phrase and the paragraph around it would get different
   * thresholds and the same edit applied twice would disagree with itself.
   */
  function refreshLevel() {
    if (!state.currentFile) return
    const key = `${appState.activeDocumentId}:${state.revision}`
    if (levelMeasuredFor === key) return
    const end = totalDuration.value
    if (!(end > 0)) return
    const gated = ALIGN_TARGET_DBFS - regionAlignDb(
      state.segments, 0, end, state.currentFile.sampleRate, state.currentFile.channels,
    )
    levelMeasuredFor = key
    phParams.voiceLevelDb = gated
    pushParam('voiceLevelDb', gated)
    // Warmth's calibration, the Saturation Bench's: each layer's band level on
    // this file, so a Warmth setting means the same on a quiet take and a hot one.
    const spectrum = measureBandSpectrum(
      state.segments, 0, end, state.currentFile.sampleRate, state.currentFile.channels,
    )
    const refs = WARMTH_LAYERS.map(l => bandRefPeakDb(spectrum, l.loHz, l.hiHz))
    phParams.warmthRefPeaksDb = refs
    pushParam('warmthRefPeaksDb', refs)
  }

  function togglePreview() {
    const chain = initChain()
    const on = !phPreview.value
    if (on) {
      // Every measured input — the guard's ceiling above all — is known before
      // the chain is enabled, and pushed in full: an unmeasured ceiling would
      // let Warmth raise the peak for the first moments of preview.
      refreshLevel()
      const { start, end } = selectionSpan()
      refreshCeiling(start, end)
      for (const [name, value] of Object.entries(phParams)) {
        chain.updateParam(phatassEffect.id, name, value)
      }
    }
    phPreview.value = on
    chain.setEnabled(phatassEffect.id, on)
    if (on) {
      startMeters(chain)
      scheduleWarmthReadout()
    } else {
      stopMeters()
      cancelWarmthReadout()
    }
  }

  /** Set one user-facing param. */
  function syncParam(name, value) {
    if (!(name in phParams) || MEASURED.has(name)) return
    phParams[name] = value
    pushParam(name, value)
    if (name === 'warmth' || name === 'oddEven') scheduleWarmthReadout()
  }

  /**
   * The peak guard's ceiling: the selection's own peak (the whole file with
   * nothing selected). A scan of the source, no render, and only re-scanned
   * when the span or the file changes — it is checked on every knob turn.
   */
  function refreshCeiling(start, end) {
    if (!state.currentFile || !(end > start)) return
    const key = `${appState.activeDocumentId}:${state.revision}:${start}:${end}`
    if (ceilingMeasuredFor === key) return
    ceilingMeasuredFor = key
    const db = regionPeakDb(state.segments, start, end, state.currentFile.sampleRate, state.currentFile.channels)
    const v = Number.isFinite(db) ? db : null
    if (phParams.warmthCeilingDb === v) return
    phParams.warmthCeilingDb = v
    pushParam('warmthCeilingDb', v)
  }

  function selectionSpan() {
    const sel = state.selection
    return { start: sel ? sel.start : 0, end: sel ? sel.end : totalDuration.value }
  }

  /**
   * Measure the Warmth readout for the selection (the whole file when nothing
   * is selected): bands over the usual capped window, then the peak over the
   * whole region on its own cancellable worker. Stale answers are dropped.
   */
  async function refreshWarmthReadout() {
    const seq = ++readoutSeq
    if (!phPreview.value) return
    if (!state.currentFile || !warmthActive(phParams)) {
      phWarmthReadout.value = { bandsDb: null, peakDb: null, inputPeakDb: null, bandsPending: false, peakPending: false }
      return
    }
    refreshLevel() // the layers' calibration must be this file's before measuring
    const { start, end } = selectionSpan()
    if (!(end > start)) return
    refreshCeiling(start, end)
    const { sampleRate, channels } = state.currentFile
    const params = { ...phParams }
    phWarmthReadout.value = { ...phWarmthReadout.value, bandsPending: true, peakPending: true }
    try {
      const { bandsDb, peakDb, inputPeakDb } = await measurePhatassWarmthBands(
        state.segments, start, end, params, sampleRate, channels,
      )
      if (seq !== readoutSeq) return
      phWarmthReadout.value = { bandsDb, peakDb, inputPeakDb, bandsPending: false, peakPending: peakDb === null }
      if (peakDb !== null) return
      const whole = await measurePhatassWarmthPeak(
        state.segments, start, end, params, sampleRate, channels,
      )
      if (seq !== readoutSeq) return
      phWarmthReadout.value = { ...phWarmthReadout.value, ...whole, peakPending: false }
    } catch (err) {
      if (err?.cancelled || seq !== readoutSeq) return
      console.error('PHAT*SS warmth readout failed:', err)
      phWarmthReadout.value = { ...phWarmthReadout.value, bandsPending: false, peakPending: false }
    }
  }

  /**
   * Re-measure shortly after the last change. The guard's ceiling is cheap and
   * load-bearing, so it follows the selection at once; the readout waits.
   */
  function scheduleWarmthReadout() {
    if (phPreview.value) {
      const { start, end } = selectionSpan()
      refreshCeiling(start, end)
    }
    clearTimeout(readoutTimer)
    readoutTimer = setTimeout(refreshWarmthReadout, 250)
  }

  /** Drop any pending or in-flight readout: nothing renders after the panel stops. */
  function cancelWarmthReadout() {
    clearTimeout(readoutTimer)
    readoutTimer = null
    readoutSeq++
    cancelPhatassWarmthPeak()
    phWarmthReadout.value = { ...phWarmthReadout.value, bandsPending: false, peakPending: false }
  }

  async function apply() {
    if (!state.selection) return
    const { start, end } = state.selection

    const wasPreviewing = phPreview.value
    if (wasPreviewing) togglePreview()
    refreshLevel()
    refreshCeiling(start, end)

    startProcessing('Applying PHAT*SS...')
    try {
      const buffer = await applyPhatassRegion(
        state.segments, start, end,
        { ...phParams },
        state.currentFile.sampleRate, state.currentFile.channels,
      )
      const bufferId = replaceRegion(start, end, buffer, 'PHAT*SS')
      const cache = await computePeakCache(buffer, 256)
      setPeakCache(bufferId, cache)
      showToast('PHAT*SS applied')
    } catch (err) {
      console.error('PHAT*SS failed:', err)
      showToast('PHAT*SS failed')
    } finally {
      endProcessing()
    }
  }

  function teardown() {
    stopMeters()
    cancelWarmthReadout()
    if (phPreview.value) {
      const chain = getEffectChain(getAudioContext())
      chain.setEnabled(phatassEffect.id, false)
      phPreview.value = false
    }
  }

  function openModal() {
    openWindow(PHATASS_WINDOW_ID)
  }

  function closeModal() {
    closeWindow(PHATASS_WINDOW_ID)
  }

  return {
    phParams,
    phPreview,
    phInputLevels,
    phOutputLevels,
    phWarmthReadout,
    hasSelection,
    togglePreview,
    syncParam,
    scheduleWarmthReadout,
    apply,
    teardown,
    openModal,
    closeModal,
  }
}
