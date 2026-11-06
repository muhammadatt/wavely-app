import { reactive, ref } from 'vue'
import { useEditorState, DocumentSwitchedError } from './useEditorState.js'
import { useEntitlements } from './useEntitlements.js'
import { useWindows } from './useWindows.js'
import { computePeakCache, renderRegionToBuffer } from '../audio/processing.js'
import { denoiseRegion } from '../api/noiseReduction.js'
import {
  NOISE_REDUCTION_DEFAULTS,
  NR_ENGINE_LABELS,
  blendDryWet,
  serverParamsKey,
} from '../audio/noiseReductionParams.js'

// Registry id of this plugin's window. Must match the entry in src/ui/registry.js.
export const NOISE_REDUCTION_WINDOW_ID = 'noise-reduction'

/**
 * Noise Reduction — DeepFilterNet3 and/or RNNoise on the selection, run on the
 * server (see src/audio/noiseReductionParams.js for what each setting means).
 *
 * AN OFFLINE PROCESS, NOT A REAL-TIME PLUGIN. The models do not run in the
 * browser, so there is nothing to hear while a knob moves. The flow is the one
 * every desktop editor uses for a denoiser: choose the settings, Process the
 * selection, listen, and Undo if it is wrong. An earlier version auditioned a
 * ≤ 30 s server-processed excerpt inside the window (Preview → Listen →
 * Original / Denoised → Apply), and it read as a second, clunkier transport
 * rather than a preview — removed.
 *
 * Pro only (`noiseReduction` in src/auth/plans.js, `offline: true`): the
 * server refuses a non-Pro upload of any length.
 *
 * While it runs, the processing overlay names the stage (upload, server,
 * download) with the time spent so far — the server reports no fraction, so
 * the bar moves by stage rather than pretending to measure the model — and the
 * window offers Cancel. The last result is held (see `held`) so a retry that
 * only changes Mix needs no second round trip.
 *
 * ONE COPY, NOT pluginCopies(). The plugin cannot take a Plugin Chain slot: a
 * slot needs a node in the live chain, and a model that runs on the server has
 * none. So there is only ever the solo window to back.
 */

const params = reactive({ ...NOISE_REDUCTION_DEFAULTS })
const processing = ref(false)

let processSeq = 0
/** The run in flight: { seq, docId, timer }, or null. */
let run = null

/**
 * The last server result, held so the usual retry — Undo, change Mix, Process
 * again — commits at once instead of re-running the model. Undo restores the
 * timeline's revision, so `revision` matching means the audio under
 * [start, end) is exactly what was sent; `paramsKey` covers every setting the
 * server read (Mix is not one). Only the denoised side is held — the dry side
 * is re-rendered from the timeline — and only for selections up to
 * HOLD_MAX_SECONDS, since a chapter's worth of float audio is hundreds of MB.
 */
let held = null // { docId, revision, start, end, paramsKey, sampleRate, wet }
const HOLD_MAX_SECONDS = 10 * 60
const SAME_TIME_EPS = 1e-6

const STAGE_TEXT = {
  upload: 'Uploading the selection',
  denoise: 'Denoising on the server',
  download: 'Downloading the result',
  apply: 'Replacing the selection',
}
const STAGE_PROGRESS = { upload: 0.05, denoise: 0.15, download: 0.9, apply: 0.97 }

function clock(sec) {
  const m = Math.floor(sec / 60)
  return `${m}:${String(Math.floor(sec - m * 60)).padStart(2, '0')}`
}

export function useNoiseReduction() {
  const {
    state, getAudioContext, hasSelection, replaceRegion, setPeakCache,
    startProcessing, endProcessing, updateProcessingStage, updateProcessingProgress,
    pinActiveDocument, showToast,
  } = useEditorState()
  const entitlements = useEntitlements()
  const { openWindow, closeWindow } = useWindows()

  function setEngine(engine) {
    params.engine = engine
  }

  function setDf3Limit(v) {
    params.df3LimitDb = v
  }

  function setProtectConsonants(on) {
    params.protectConsonants = on
  }

  function setMix(v) {
    params.mix = v
  }

  function resetParams() {
    Object.assign(params, NOISE_REDUCTION_DEFAULTS)
  }

  /** The held result, when it describes this audio, span and settings. */
  function heldFor(docId, start, end) {
    const h = held
    return h && h.docId === docId && h.revision === state.revision
      && Math.abs(h.start - start) < SAME_TIME_EPS && Math.abs(h.end - end) < SAME_TIME_EPS
      && h.paramsKey === serverParamsKey(params)
      ? h : null
  }

  /** Show a stage on the processing overlay, with the time spent so far. */
  function showStage(r, stage, serverText = null) {
    if (!run || run !== r) return
    r.stage = stage
    r.serverText = serverText
    updateProcessingProgress(STAGE_PROGRESS[stage], r.docId)
    renderStage(r)
  }

  function renderStage(r) {
    const elapsed = clock((Date.now() - r.startedAt) / 1000)
    const text = r.serverText ? `${STAGE_TEXT[r.stage]} — ${r.serverText}` : STAGE_TEXT[r.stage]
    updateProcessingStage(`${text} · ${elapsed}`, r.docId)
  }

  function finishRun(r) {
    clearInterval(r.timer)
    if (run !== r) return
    run = null
    processing.value = false
    endProcessing(r.docId)
  }

  /**
   * Denoise the selection on the server and commit it as one undo step.
   * Resolves true when something was committed.
   */
  async function apply() {
    if (!state.selection || !state.currentFile || processing.value) return false
    if (!entitlements.request('noiseReduction')) return false
    const { start, end } = state.selection
    const { sampleRate, channels } = state.currentFile
    const pin = pinActiveDocument('Noise Reduction')
    const revision = state.revision
    const settings = { ...params }
    const paramsKey = serverParamsKey(settings)
    const engineLabel = NR_ENGINE_LABELS[settings.engine]
    const reuse = heldFor(pin.docId, start, end)

    const r = { seq: ++processSeq, docId: pin.docId, startedAt: Date.now(), stage: 'upload', serverText: null, timer: null }
    run = r
    processing.value = true
    startProcessing(`Reducing noise (${engineLabel})`, pin.docId)
    r.timer = setInterval(() => renderStage(r), 1000)
    const cancelled = () => run !== r
    try {
      let wet
      if (reuse) {
        wet = reuse.wet
      } else {
        const out = await denoiseRegion({
          segments: state.segments, start, end, sampleRate, channels,
          params: settings,
          isCancelled: cancelled,
          onStage: (stage, text) => showStage(r, stage, text),
        })
        if (!out || cancelled()) return false
        wet = out.wet
      }
      pin.check()
      if (state.revision !== revision) {
        showToast('Audio changed during noise reduction — try again')
        return false
      }
      held = end - start <= HOLD_MAX_SECONDS
        ? { docId: pin.docId, revision, start, end, paramsKey, sampleRate, wet }
        : null

      showStage(r, 'apply')
      const dry = renderRegionToBuffer(state.segments, start, end, sampleRate, channels)
      const blended = blendDryWet(dry, wet, settings.mix)
      const buffer = getAudioContext().createBuffer(blended.length, blended[0].length, sampleRate)
      blended.forEach((d, ch) => buffer.copyToChannel(d, ch))
      const bufferId = replaceRegion(start, end, buffer, 'noise reduction', pin.docId)
      const cache = await computePeakCache(buffer, 256)
      setPeakCache(bufferId, cache)
      const mixNote = settings.mix < 1 ? ` at ${Math.round(settings.mix * 100)}% mix` : ''
      showToast(`Noise reduced with ${engineLabel}${mixNote} — undo to compare`)
      return true
    } catch (err) {
      if (cancelled()) return false
      console.error('Noise reduction failed:', err)
      if (err instanceof DocumentSwitchedError) showToast(err.message)
      else if (!entitlements.handleServerRefusal(err)) showToast(err.message || 'Noise reduction failed')
      return false
    } finally {
      finishRun(r)
    }
  }

  /**
   * Stop waiting for the run in flight. The server job is left to finish and
   * expire on its own (it holds nothing of the user's beyond the upload);
   * nothing is committed.
   */
  function cancel() {
    const r = run
    if (!r) return
    run = null
    clearInterval(r.timer)
    processing.value = false
    endProcessing(r.docId)
    showToast('Noise reduction cancelled')
  }

  function openModal() {
    openWindow(NOISE_REDUCTION_WINDOW_ID)
  }

  function closeModal() {
    closeWindow(NOISE_REDUCTION_WINDOW_ID)
  }

  return {
    params,
    processing,
    hasSelection,
    setEngine,
    setDf3Limit,
    setProtectConsonants,
    setMix,
    resetParams,
    apply,
    cancel,
    openModal,
    closeModal,
  }
}
