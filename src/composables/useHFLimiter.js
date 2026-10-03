import { reactive, ref } from 'vue'
import { useEditorState } from './useEditorState.js'
import { useWindows } from './useWindows.js'
import {
  applyHFLimiterRegion, computePeakCache, measureHFLimiterWarmthBands, measureHFLimiterWarmthPeak,
} from '../audio/processing.js'
import { regionAlignDb, regionPeakDb } from '../audio/analysisWindow.js'
import { ALIGN_TARGET_DBFS } from '../audio/dsp/inputAlign.js'
import { getEffectChain } from '../audio/effectChain.js'
import { hfLimiterEffect, HF_LIMITER_DEFAULTS } from '../audio/effects/hfLimiter.js'
import { WARMTH_LAYERS, warmthActive, warmthMakeupOn } from '../audio/hfLimiterParams.js'
import { measureBandSpectrum, bandRefPeakDb } from '../audio/saturationBenchAnalysis.js'
import { snapshotLevels } from '../audio/effects/levelTap.js'

// Registry id of this plugin's window. Must match the entry in src/ui/registry.js.
export const HF_LIMITER_WINDOW_ID = 'hf-limiter'

// Singleton reactive state shared between the sidebar trigger and the modal.
// `voiceLevelDb`, `warmthRefPeaksDb` and `warmthMakeupDb` are in here because
// the kernel needs them, but they are measured, never set from the panel.
const hflParams = reactive({ ...HF_LIMITER_DEFAULTS })
const hflPreview = ref(false)
// DELTA monitor: hear only what is being removed. Never part of the params
// the apply path renders with.
const hflDelta = ref(false)
const hflReduction = ref(0)
const hflTransient = ref(0)
// How far the Warmth peak guard is turning the added signal down, positive dB.
const hflGuard = ref(0)
const hflInputLevels = ref([])
const hflOutputLevels = ref([])
let meterId = null
let levelMeasuredFor = null
// Warmth readout: what the Warmth stage does to the selection's low end, per
// band, and the peak it leaves (hfLimiterWarmthReadout.js). `bandsDb` /
// `peakDb` null = not measured; the pending flags say a pass is in flight.
const hflWarmthReadout = ref({ bandsDb: null, loudnessDeltaDb: null, peakDb: null, inputPeakDb: null, bandsPending: false, peakPending: false })
let readoutTimer = null
let readoutSeq = 0
// Which setting/region the last readout's loudness change was measured for,
// so apply can tell whether the makeup belongs to what it is about to render.
let loudMeasuredFor = null
const MEASURED = new Set(['voiceLevelDb', 'warmthRefPeaksDb', 'warmthMakeupDb', 'warmthCeilingDb'])

export function useHFLimiter() {
  const {
    state, appState, getAudioContext, hasSelection, replaceRegion, setPeakCache,
    startProcessing, endProcessing, showToast, totalDuration,
  } = useEditorState()
  const { openWindow, closeWindow } = useWindows()

  function initChain() {
    const chain = getEffectChain(getAudioContext())
    if (!chain.effects.find(e => e.id === hfLimiterEffect.id)) chain.addEffect(hfLimiterEffect)
    return chain
  }

  function nodesOf(chain) {
    return chain.effects.find(e => e.id === hfLimiterEffect.id)?.nodes
  }

  function startMeters(chain) {
    stopMeters()
    function tick() {
      const nodes = nodesOf(chain)
      if (nodes) {
        const chCount = state.currentFile?.channels ?? 1
        hflInputLevels.value = snapshotLevels(nodes.getInputLevels(chCount))
        hflOutputLevels.value = snapshotLevels(nodes.getOutputLevels(chCount))
        hflReduction.value = nodes.getReduction()
        hflTransient.value = nodes.getTransient()
        hflGuard.value = nodes.getGuard?.() ?? 0
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
    hflInputLevels.value = []
    hflOutputLevels.value = []
    hflReduction.value = 0
    hflTransient.value = 0
    hflGuard.value = 0
  }

  function pushParam(name, value) {
    if (!hflPreview.value) return
    getEffectChain(getAudioContext()).updateParam(hfLimiterEffect.id, name, value)
  }

  /**
   * Measure the file's voice level and move the threshold with it, so a
   * Threshold setting means the same thing on a quiet recording and a hot one.
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
    hflParams.voiceLevelDb = gated
    pushParam('voiceLevelDb', gated)
    // Warmth's calibration, the Saturation Bench's: each layer's band level on
    // this file, so a Warmth setting means the same on a quiet take and a hot one.
    const spectrum = measureBandSpectrum(
      state.segments, 0, end, state.currentFile.sampleRate, state.currentFile.channels,
    )
    const refs = WARMTH_LAYERS.map(l => bandRefPeakDb(spectrum, l.loHz, l.hiHz))
    hflParams.warmthRefPeaksDb = refs
    pushParam('warmthRefPeaksDb', refs)
  }

  function togglePreview() {
    const chain = initChain()
    hflPreview.value = !hflPreview.value
    chain.setEnabled(hfLimiterEffect.id, hflPreview.value)
    if (hflPreview.value) {
      refreshLevel()
      for (const [name, value] of Object.entries(hflParams)) {
        chain.updateParam(hfLimiterEffect.id, name, value)
      }
      nodesOf(chain)?.setListen(hflDelta.value ? 'delta' : 'off')
      startMeters(chain)
      scheduleWarmthReadout()
    } else {
      // Bypassed, there is nothing to hear in the delta.
      hflDelta.value = false
      stopMeters()
    }
  }

  /** Set one user-facing param. */
  function syncParam(name, value) {
    if (!(name in hflParams) || MEASURED.has(name)) return
    hflParams[name] = value
    pushParam(name, value)
    if (name === 'odd' || name === 'even' || name === 'warmthGuard') scheduleWarmthReadout()
    if (name === 'warmthMakeup') updateMakeup()
  }

  /** The key a measured makeup belongs to: the setting, the region and the file's state. */
  function makeupKey(start, end) {
    return `${appState.activeDocumentId}:${state.revision}:${hflParams.odd}:${hflParams.even}:${hflParams.warmthGuard}:${start}:${end}`
  }

  /**
   * LOUD makeup: minus the loudness change the readout measured. Kept whether
   * LOUD is on or not, so switching it is instant; the kernel ignores it when OFF.
   */
  function updateMakeup() {
    const r = hflWarmthReadout.value
    const db = Number.isFinite(r.loudnessDeltaDb) ? -r.loudnessDeltaDb : 0
    if (hflParams.warmthMakeupDb === db) return
    hflParams.warmthMakeupDb = db
    pushParam('warmthMakeupDb', db)
  }

  /** Is the makeup measured for this setting and region? */
  function makeupCurrent(key) {
    return loudMeasuredFor === key
  }

  /**
   * The peak guard's ceiling: the selection's own peak (the whole file with
   * nothing selected). Cheap — a scan of the source, no render — so it is
   * re-read whenever the readout or apply runs.
   */
  function refreshCeiling(start, end) {
    if (!state.currentFile || !(end > start)) return
    const db = regionPeakDb(state.segments, start, end, state.currentFile.sampleRate, state.currentFile.channels)
    const v = Number.isFinite(db) ? db : null
    if (hflParams.warmthCeilingDb === v) return
    hflParams.warmthCeilingDb = v
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
    if (!state.currentFile || !warmthActive(hflParams)) {
      hflWarmthReadout.value = { bandsDb: null, loudnessDeltaDb: null, peakDb: null, inputPeakDb: null, bandsPending: false, peakPending: false }
      return
    }
    refreshLevel() // the layers' calibration must be this file's before measuring
    const { start, end } = selectionSpan()
    if (!(end > start)) return
    refreshCeiling(start, end)
    const key = makeupKey(start, end)
    const { sampleRate, channels } = state.currentFile
    const params = { ...hflParams }
    hflWarmthReadout.value = { ...hflWarmthReadout.value, bandsPending: true, peakPending: true }
    try {
      const { bandsDb, loudnessDeltaDb, peakDb, inputPeakDb } = await measureHFLimiterWarmthBands(
        state.segments, start, end, params, sampleRate, channels,
      )
      if (seq !== readoutSeq) return
      hflWarmthReadout.value = { bandsDb, loudnessDeltaDb, peakDb, inputPeakDb, bandsPending: false, peakPending: peakDb === null }
      loudMeasuredFor = key
      updateMakeup()
      if (peakDb !== null) return
      const whole = await measureHFLimiterWarmthPeak(
        state.segments, start, end, params, sampleRate, channels,
      )
      if (seq !== readoutSeq) return
      hflWarmthReadout.value = { ...hflWarmthReadout.value, ...whole, peakPending: false }
    } catch (err) {
      if (err?.cancelled || seq !== readoutSeq) return
      console.error('HF Limiter warmth readout failed:', err)
      hflWarmthReadout.value = { ...hflWarmthReadout.value, bandsPending: false, peakPending: false }
    }
  }

  /** Re-measure shortly after the last change. */
  function scheduleWarmthReadout() {
    clearTimeout(readoutTimer)
    readoutTimer = setTimeout(refreshWarmthReadout, 250)
  }

  function toggleDelta() {
    if (!hflPreview.value) return
    hflDelta.value = !hflDelta.value
    nodesOf(getEffectChain(getAudioContext()))?.setListen(hflDelta.value ? 'delta' : 'off')
  }

  async function apply() {
    if (!state.selection) return
    const { start, end } = state.selection

    const wasPreviewing = hflPreview.value
    if (wasPreviewing) togglePreview()
    refreshLevel()
    refreshCeiling(start, end)
    // The makeup must belong to THIS setting and region, or the render is at
    // whatever level the last knob position measured.
    if (warmthMakeupOn(hflParams) && warmthActive(hflParams)) {
      const { start: s0, end: e0 } = selectionSpan()
      if (!makeupCurrent(makeupKey(s0, e0))) {
        clearTimeout(readoutTimer)
        await refreshWarmthReadout()
      }
    }

    startProcessing('Applying HF Limiter...')
    try {
      const buffer = await applyHFLimiterRegion(
        state.segments, start, end,
        { ...hflParams },
        state.currentFile.sampleRate, state.currentFile.channels,
      )
      const bufferId = replaceRegion(start, end, buffer, 'HF Limiter')
      const cache = await computePeakCache(buffer, 256)
      setPeakCache(bufferId, cache)
      showToast('HF Limiter applied')
    } catch (err) {
      console.error('HF Limiter failed:', err)
      showToast('HF Limiter failed')
    } finally {
      endProcessing()
    }
  }

  function teardown() {
    stopMeters()
    // Delta is a monitoring aid; never leave the chain auditioning it after
    // the window closes.
    hflDelta.value = false
    if (hflPreview.value) {
      const chain = getEffectChain(getAudioContext())
      nodesOf(chain)?.setListen('off')
      chain.setEnabled(hfLimiterEffect.id, false)
      hflPreview.value = false
    }
  }

  function openModal() {
    openWindow(HF_LIMITER_WINDOW_ID)
  }

  function closeModal() {
    closeWindow(HF_LIMITER_WINDOW_ID)
  }

  return {
    hflParams,
    hflPreview,
    hflDelta,
    hflReduction,
    hflTransient,
    hflGuard,
    hflInputLevels,
    hflOutputLevels,
    hflWarmthReadout,
    hasSelection,
    togglePreview,
    syncParam,
    scheduleWarmthReadout,
    toggleDelta,
    apply,
    teardown,
    openModal,
    closeModal,
  }
}
