import { reactive, ref } from 'vue'
import { useEditorState } from './useEditorState.js'
import { useWindows } from './useWindows.js'
import { registerChainPlugin } from './usePluginChain.js'
import {
  applyPhatassRegion, cancelPhatassOutputMakeup, cancelPhatassTapeMakeup, computePeakCache,
  measurePhatassOutputMakeup, measurePhatassTapeMakeup, measurePhatassWarmthBands,
} from '../audio/processing.js'
import { regionAlignDb, regionPeakDb } from '../audio/analysisWindow.js'
import { ALIGN_TARGET_DBFS } from '../audio/dsp/inputAlign.js'
import { getEffectChain } from '../audio/effectChain.js'
import { phatassEffect, PHATASS_DEFAULTS } from '../audio/effects/phatass.js'
import { WARMTH_LAYERS, warmthActive, headBumpFor, headBumpMaxLiftDb } from '../audio/phatassParams.js'
import { measureBandSpectrum, bandRefPeakDb } from '../audio/saturationBenchAnalysis.js'
import { snapshotLevels } from '../audio/effects/levelTap.js'
import { NeedleSpring, satMeterValue } from '../audio/dsp/saturationMeter.js'

// Registry id of this plugin's window. Must match the entry in src/ui/registry.js.
export const PHATASS_WINDOW_ID = 'phatass'

// Singleton reactive state shared between the sidebar trigger and the modal.
// `voiceLevelDb`, `warmthRefPeaksDb` and `warmthCeilingDb` are in here because
// the kernel needs them, but they are measured, never set from the panel.
const phParams = reactive({ ...PHATASS_DEFAULTS })
const phPreview = ref(false)
const phInputLevels = ref([])
const phOutputLevels = ref([])
// The saturation needle, 0–100, and the reading it is heading for (dB re the
// clean signal; −Infinity at rest).
const phSatNeedle = ref(0)
const phSatDb = ref(-Infinity)
let meterId = null
let levelMeasuredFor = null
let ceilingMeasuredFor = null
// Warmth readout: what the Warmth stage does to the selection's low end, per
// band, and the peak it leaves (phatassWarmthReadout.js). `bandsDb` /
// `peakDb` null = not measured; the pending flags say a pass is in flight.
const WARMTH_READOUT_ON_PANEL = false
const phWarmthReadout = ref({ bandsDb: null, peakDb: null, inputPeakDb: null, bandsPending: false, peakPending: false })
let readoutTimer = null
let readoutSeq = 0
// TAPE's automatic makeup: `pending` while a whole-selection render is in flight.
const phTapeMakeup = ref({ pending: false })
let tapeTimer = null
let tapeSeq = 0
// The EXACT makeup, measured in the background once preview's fast one has
// landed and the knobs have been still for EXACT_MAKEUP_IDLE_MS, and kept
// against everything that moves it (`tapeMakeupKey`). Apply uses it instead
// of rendering TAPE over the selection again — on a long selection that render
// was the first several seconds of the wait.
const exactMakeups = new Map() // key → makeupDb, most recent last
const EXACT_MAKEUP_KEEP = 16
function rememberExactMakeup(key, makeupDb) {
  exactMakeups.delete(key)
  exactMakeups.set(key, makeupDb)
  if (exactMakeups.size > EXACT_MAKEUP_KEEP) exactMakeups.delete(exactMakeups.keys().next().value)
}
let exactTimer = null
const EXACT_MAKEUP_IDLE_MS = 600
// The bench's output trim: `pending` while a render of the chain is in flight.
const phOutputMakeup = ref({ pending: false })
let outputTimer = null
let outputSeq = 0
const MEASURED = new Set(['voiceLevelDb', 'warmthRefPeaksDb', 'warmthCeilingDb', 'tapeMakeupDb', 'outputMakeupDb'])
// Params that do not change what the output trim measures: Output rides on top
// of it, and the mode is handled on its own.
const OUTPUT_TRIM_IGNORES = new Set(['output', 'outputMakeup'])

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
    const needle = new NeedleSpring()
    let last = performance.now()
    function tick(now) {
      const nodes = nodesOf(chain)
      if (nodes) {
        const chCount = state.currentFile?.channels ?? 1
        phInputLevels.value = snapshotLevels(nodes.getInputLevels(chCount))
        phOutputLevels.value = snapshotLevels(nodes.getOutputLevels(chCount))
        const db = nodes.getSaturationDb?.() ?? -Infinity
        phSatDb.value = db
        phSatNeedle.value = needle.step(satMeterValue(db), Math.max(0, (now - last) / 1000))
      }
      last = now
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
    phSatNeedle.value = 0
    phSatDb.value = -Infinity
  }

  function pushParam(name, value) {
    if (!phPreview.value) return
    getEffectChain(getAudioContext()).updateParam(phatassEffect.id, name, value)
  }

  /**
   * Measure the file's voice level and move the HF shelves' thresholds with
   * it, so an HF detent means the same thing on a quiet recording and a hot one.
   *
   * ⚠ THE WHOLE FILE, NEVER THE SELECTION, and the same gated-RMS statistic —
   * the rule OptoSmooth's input alignment and the HF Softener's level offset
   * already follow, so all three read one number for one file. Measured per
   * selection, a phrase and the paragraph around it would get different
   * thresholds and the same edit applied twice would disagree with itself.
   */
  function refreshLevel(segments = state.segments) {
    if (!state.currentFile) return
    // `segments` is the document's timeline, or — during a chain apply — the
    // chain's running result, which is no revision of the document: always
    // measured, and recorded under a key no real revision matches.
    const own = segments === state.segments
    const key = own ? `${appState.activeDocumentId}:${state.revision}` : `${appState.activeDocumentId}:chain`
    if (own && levelMeasuredFor === key) return
    const end = totalDuration.value
    if (!(end > 0)) return
    const gated = ALIGN_TARGET_DBFS - regionAlignDb(
      segments, 0, end, state.currentFile.sampleRate, state.currentFile.channels,
    )
    levelMeasuredFor = key
    phParams.voiceLevelDb = gated
    pushParam('voiceLevelDb', gated)
    // Warmth's calibration, the Saturation Bench's: each layer's band level on
    // this file, so a Warmth setting means the same on a quiet take and a hot one.
    const spectrum = measureBandSpectrum(
      segments, 0, end, state.currentFile.sampleRate, state.currentFile.channels,
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
      cancelTapeMakeup()
      cancelOutputMakeup()
    }
  }

  /** Set one user-facing param. */
  function syncParam(name, value) {
    if (!(name in phParams) || MEASURED.has(name)) return
    const bumpBefore = headBumpFor(phParams.tapeHeadBump, phParams.hf)
    const inputBefore = Number(phParams.inputDb) || 0
    phParams[name] = value
    pushParam(name, value)
    // TAPE comes first, so Warmth's knobs move the readout, not the makeup.
    if (name === 'warmth' || name === 'oddEven') scheduleReadout()
    // The curve, the low push and the head bump change what TAPE takes off the peak —
    // and the Speed dial picks the head bump. Until the new measurement lands,
    // never give back more than the knob; and a NEW head bump, which sits after
    // the curve and can lift the peak by itself, takes its largest lift off that
    // too (keeping the old makeup under a +9 dB bump raised a 55 Hz peak 5.6 dB).
    if ((name === 'inputDb' || name === 'tapeCurve' || name === 'tapeStep' || name === 'tapeLowPush' || name === 'tapeHeadBump' || name === 'hf') && Number(phParams.tape) > 0) {
      const bump = headBumpFor(phParams.tapeHeadBump, phParams.hf)
      const lift = bump !== bumpBefore ? headBumpMaxLiftDb(bump, state.currentFile?.sampleRate) : 0
      // Less Input drives TAPE less, so it takes less off the peak — at most
      // dB for dB, since a clipper's output peak never falls as its input
      // rises. The knob alone is no bound then; take the drop off as well, so
      // the interim makeup errs quiet rather than lifting the preview above
      // what the measurement will settle on.
      const inputDrop = name === 'inputDb' ? Math.max(0, inputBefore - Number(value)) : 0
      setTapeMakeup(Math.min(phParams.tapeMakeupDb || 0, Number(phParams.tape) - lift) - inputDrop)
      scheduleTapeMakeup()
    }
    if (name === 'tape') {
      // Until the new measurement lands, never give back more than the knob
      // now asks for (a smaller TAPE takes less off); 0 has nothing to restore.
      const interim = value > 0 ? Math.min(phParams.tapeMakeupDb || 0, value) : 0
      setTapeMakeup(interim)
      scheduleTapeMakeup()
    }
    // The bench's output trim hears the whole chain, so every other knob moves
    // it; the old value holds until the new one lands.
    if (name === 'outputMakeup') {
      if (value === 'off' || value === 'keep') cancelOutputMakeup()
      else scheduleOutputMakeup()
    } else if (!OUTPUT_TRIM_IGNORES.has(name)) scheduleOutputMakeup()
  }

  /** Everything TAPE's makeup depends on: the document, the span and TAPE's own settings. */
  function tapeMakeupKey(start, end) {
    return JSON.stringify([
      appState.activeDocumentId, state.revision, start, end,
      phParams.inputDb, phParams.tape, phParams.tapeCurve, phParams.tapeStep, phParams.tapeLowPush, phParams.tapeHeadBump, phParams.hf,
      phParams.warmthCeilingDb, phParams.voiceLevelDb,
    ])
  }

  /** After a fast makeup lands: measure the exact one in the background, unless it is already known. */
  function scheduleExactMakeup(start, end) {
    clearTimeout(exactTimer)
    exactTimer = null
    if (!(Number(phParams.tape) > 0) || !state.currentFile) return
    const key = tapeMakeupKey(start, end)
    if (exactMakeups.has(key)) {
      setTapeMakeup(exactMakeups.get(key))
      return
    }
    exactTimer = setTimeout(async () => {
      exactTimer = null
      const seq = tapeSeq
      try {
        const { makeupDb } = await measurePhatassTapeMakeup(
          state.segments, start, end, { ...phParams }, state.currentFile.sampleRate, state.currentFile.channels,
        )
        // Anything that moves the makeup bumps tapeSeq and cancels this render.
        if (seq !== tapeSeq || tapeMakeupKey(start, end) !== key) return
        rememberExactMakeup(key, makeupDb)
        setTapeMakeup(makeupDb)
      } catch (err) {
        if (!err?.cancelled) console.error('PHAT*SS exact tape makeup failed:', err)
      }
    }, EXACT_MAKEUP_IDLE_MS)
  }

  function setTapeMakeup(db) {
    if (phParams.tapeMakeupDb === db) return
    phParams.tapeMakeupDb = db
    pushParam('tapeMakeupDb', db)
  }

  /**
   * TAPE's makeup for live preview: what TAPE took off the selection's peak,
   * by the fast bounded search (phatassTapeMakeup.js) — TAPE is first in the
   * chain, so nothing else moves it. Apply re-measures the exact way.
   * Resolves the makeup set, or null if superseded.
   */
  async function refreshTapeMakeup() {
    const seq = ++tapeSeq
    if (!state.currentFile || !(Number(phParams.tape) > 0)) {
      phTapeMakeup.value = { pending: false }
      setTapeMakeup(0)
      return 0
    }
    refreshLevel()
    const { start, end } = selectionSpan()
    if (!(end > start)) return null
    refreshCeiling(start, end)
    // Settings already measured exactly (back to an earlier position): no render.
    const known = exactMakeups.get(tapeMakeupKey(start, end))
    if (known !== undefined) {
      phTapeMakeup.value = { pending: false }
      setTapeMakeup(known)
      scheduleOutputMakeup()
      return known
    }
    phTapeMakeup.value = { pending: true }
    try {
      const { makeupDb } = await measurePhatassTapeMakeup(
        state.segments, start, end, { ...phParams }, state.currentFile.sampleRate, state.currentFile.channels,
        { exact: false },
      )
      if (seq !== tapeSeq) return null
      phTapeMakeup.value = { pending: false }
      setTapeMakeup(makeupDb)
      // The output trim renders with TAPE's makeup in place, so it follows it.
      scheduleOutputMakeup()
      scheduleExactMakeup(start, end)
      return makeupDb
    } catch (err) {
      if (err?.cancelled || seq !== tapeSeq) return null
      console.error('PHAT*SS tape makeup failed:', err)
      phTapeMakeup.value = { pending: false }
      scheduleOutputMakeup()
      return null
    }
  }

  function scheduleTapeMakeup() {
    // Pending from the moment it is scheduled, so the caption never shows the
    // interim value as if it were the answer.
    if (Number(phParams.tape) > 0) phTapeMakeup.value = { pending: true }
    // A measurement already in flight is for the old settings: drop it now, or
    // it could land in the debounce window and overwrite the interim.
    tapeSeq++
    cancelPhatassTapeMakeup()
    clearTimeout(exactTimer)
    exactTimer = null
    clearTimeout(tapeTimer)
    tapeTimer = setTimeout(refreshTapeMakeup, 250)
  }

  function cancelTapeMakeup() {
    clearTimeout(tapeTimer)
    tapeTimer = null
    clearTimeout(exactTimer)
    exactTimer = null
    tapeSeq++
    cancelPhatassTapeMakeup()
    phTapeMakeup.value = { pending: false }
  }

  function setOutputMakeup(db) {
    if (phParams.outputMakeupDb === db) return
    phParams.outputMakeupDb = db
    pushParam('outputMakeupDb', db)
  }

  // Measured trims only: KEEP is a share of TAPE's makeup, worked out in toKernelParams.
  const outputTrimOn = () => phParams.outputMakeup === 'peak' || phParams.outputMakeup === 'rms'

  /**
   * The bench's output trim for live preview (phatassOutputMakeup.js): exact
   * on a selection up to its cap, sampled blocks beyond. Waits for TAPE's
   * makeup, which it renders with — that measurement schedules this one when
   * it lands. Apply re-measures the exact way.
   */
  async function refreshOutputMakeup() {
    const seq = ++outputSeq
    if (!state.currentFile || !outputTrimOn()) {
      phOutputMakeup.value = { pending: false }
      return
    }
    if (phTapeMakeup.value.pending) return
    refreshLevel()
    const { start, end } = selectionSpan()
    if (!(end > start)) return
    refreshCeiling(start, end)
    phOutputMakeup.value = { pending: true }
    try {
      const { makeupDb } = await measurePhatassOutputMakeup(
        state.segments, start, end, { ...phParams }, state.currentFile.sampleRate, state.currentFile.channels,
        { exact: false },
      )
      if (seq !== outputSeq) return
      phOutputMakeup.value = { pending: false }
      setOutputMakeup(makeupDb)
    } catch (err) {
      if (err?.cancelled || seq !== outputSeq) return
      console.error('PHAT*SS output trim failed:', err)
      phOutputMakeup.value = { pending: false }
    }
  }

  function scheduleOutputMakeup() {
    if (!outputTrimOn() || !phPreview.value) return
    phOutputMakeup.value = { pending: true }
    // As for TAPE's makeup: a trim in flight was measured on the old chain.
    outputSeq++
    cancelPhatassOutputMakeup()
    clearTimeout(outputTimer)
    outputTimer = setTimeout(refreshOutputMakeup, 250)
  }

  function cancelOutputMakeup() {
    clearTimeout(outputTimer)
    outputTimer = null
    outputSeq++
    cancelPhatassOutputMakeup()
    phOutputMakeup.value = { pending: false }
  }

  /**
   * The peak guard's ceiling: the selection's own peak (the whole file with
   * nothing selected). A scan of the source, no render, and only re-scanned
   * when the span or the file changes — it is checked on every knob turn.
   */
  function refreshCeiling(start, end, segments = state.segments) {
    if (!state.currentFile || !(end > start)) return
    const own = segments === state.segments
    const key = own
      ? `${appState.activeDocumentId}:${state.revision}:${start}:${end}`
      : `${appState.activeDocumentId}:chain`
    if (own && ceilingMeasuredFor === key) return
    ceilingMeasuredFor = key
    const db = regionPeakDb(segments, start, end, state.currentFile.sampleRate, state.currentFile.channels)
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
   * is selected): bands sampled across it, and the peak — measured on a short
   * selection, the guard's bound (the selection's peak) on a long one. Stale
   * answers are dropped.
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
      phWarmthReadout.value = { bandsDb, peakDb, inputPeakDb, bandsPending: false, peakPending: false }
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
  function scheduleReadout() {
    if (phPreview.value) {
      // The calibration too (keyed on the document and revision, so a no-op on
      // a knob turn): it used to ride on the readout, and with the readout off
      // the panel an edit under TAPE 0 / trim OFF left preview on the old
      // file's thresholds while Apply re-measured them.
      refreshLevel()
      const { start, end } = selectionSpan()
      refreshCeiling(start, end)
    }
    clearTimeout(readoutTimer)
    // Off the Modula panel (owner's call, October 2026): nothing shows it, so
    // nothing renders it. The measurement stays, ready to be shown again.
    if (WARMTH_READOUT_ON_PANEL) readoutTimer = setTimeout(refreshWarmthReadout, 250)
  }

  /** The selection or preview changed: the readout, TAPE's makeup and the output trim all follow. */
  function scheduleWarmthReadout() {
    scheduleReadout()
    if (Number(phParams.tape) > 0) scheduleTapeMakeup()
    scheduleOutputMakeup()
  }

  /** Drop any pending or in-flight readout: nothing renders after the panel stops. */
  function cancelWarmthReadout() {
    clearTimeout(readoutTimer)
    readoutTimer = null
    readoutSeq++
    phWarmthReadout.value = { ...phWarmthReadout.value, bandsPending: false, peakPending: false }
  }

  /** Render [start, end) of `segments` with the current settings, uncommitted. */
  function renderRegion(segments, start, end) {
    return applyPhatassRegion(
      segments, start, end,
      { ...phParams },
      state.currentFile.sampleRate, state.currentFile.channels,
    )
  }

  /** The measurements apply needs exact for this span, measured on the source. */
  async function prepareApply(start, end, segments = state.segments) {
    // During a chain apply `segments` is the chain's running result: measured
    // fresh, and never read from or written to the per-revision makeup cache.
    const own = segments === state.segments
    refreshLevel(segments)
    refreshCeiling(start, end, segments)
    // Never apply a stale (debounced or interim) makeup: the exact one for
    // this span and these settings — from the background measurement when it
    // already ran, otherwise measured now.
    if (Number(phParams.tape) > 0) {
      const key = tapeMakeupKey(start, end)
      if (own && exactMakeups.has(key)) {
        setTapeMakeup(exactMakeups.get(key))
      } else {
        const { makeupDb } = await measurePhatassTapeMakeup(
          segments, start, end, { ...phParams }, state.currentFile.sampleRate, state.currentFile.channels,
        )
        if (own) rememberExactMakeup(key, makeupDb)
        setTapeMakeup(makeupDb)
      }
    }
    // The output trim after it, since it renders with TAPE's makeup in place.
    if (outputTrimOn()) {
      const { makeupDb } = await measurePhatassOutputMakeup(
        segments, start, end, { ...phParams }, state.currentFile.sampleRate, state.currentFile.channels,
      )
      setOutputMakeup(makeupDb)
    }
  }

  async function apply() {
    if (!state.selection) return
    const { start, end } = state.selection

    const wasPreviewing = phPreview.value
    if (wasPreviewing) togglePreview()

    startProcessing('Applying PHAT*SS...')
    try {
      await prepareApply(start, end)
      const buffer = await renderRegion(state.segments, start, end)
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
    cancelTapeMakeup()
    cancelOutputMakeup()
  }

  registerChainPlugin({
    id: phatassEffect.id,
    windowId: PHATASS_WINDOW_ID,
    label: 'PHAT*SS',
    isActive: () => phPreview.value,
    setActive: (on) => { if (phPreview.value !== on) togglePreview() },
    render: async (segments, start, end) => {
      await prepareApply(start, end, segments)
      return renderRegion(segments, start, end)
    },
    resume: () => startMeters(initChain()),
  })

  /** Put a whole param set into effect (a preset): each through syncParam, so makeups follow. */
  function applyParams(p) {
    for (const [k, v] of Object.entries(p)) if (phParams[k] !== v) syncParam(k, v)
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
    phSatNeedle,
    phSatDb,
    phWarmthReadout,
    phTapeMakeup,
    phOutputMakeup,
    hasSelection,
    togglePreview,
    syncParam,
    applyParams,
    scheduleWarmthReadout,
    apply,
    teardown,
    openModal,
    closeModal,
  }
}
