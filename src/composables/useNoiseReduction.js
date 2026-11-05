import { reactive, ref } from 'vue'
import { useEditorState, DocumentSwitchedError } from './useEditorState.js'
import { useEntitlements } from './useEntitlements.js'
import { useWindows } from './useWindows.js'
import { computePeakCache } from '../audio/processing.js'
import { denoiseRegion } from '../api/noiseReduction.js'
import {
  NOISE_REDUCTION_DEFAULTS,
  NR_ENGINE_LABELS,
  blendDryWet,
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
 * ONE COPY, NOT pluginCopies(). The plugin cannot take a Plugin Chain slot: a
 * slot needs a node in the live chain, and a model that runs on the server has
 * none. So there is only ever the solo window to back.
 */

const params = reactive({ ...NOISE_REDUCTION_DEFAULTS })
const processing = ref(false)

let processSeq = 0

export function useNoiseReduction() {
  const {
    state, getAudioContext, hasSelection, replaceRegion, setPeakCache,
    startProcessing, endProcessing, pinActiveDocument, showToast,
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
    const engineLabel = NR_ENGINE_LABELS[settings.engine]
    const seq = ++processSeq

    processing.value = true
    startProcessing(`Reducing noise (${engineLabel})...`, pin.docId)
    try {
      const out = await denoiseRegion({
        segments: state.segments, start, end, sampleRate, channels,
        params: settings,
        isCancelled: () => seq !== processSeq,
      })
      if (!out || seq !== processSeq) return false
      pin.check()
      if (state.revision !== revision) {
        showToast('Audio changed during noise reduction — try again')
        return false
      }
      const blended = blendDryWet(out.dry, out.wet, settings.mix)
      const buffer = getAudioContext().createBuffer(blended.length, blended[0].length, sampleRate)
      blended.forEach((d, ch) => buffer.copyToChannel(d, ch))
      const bufferId = replaceRegion(start, end, buffer, 'noise reduction', pin.docId)
      const cache = await computePeakCache(buffer, 256)
      setPeakCache(bufferId, cache)
      const mixNote = settings.mix < 1 ? ` at ${Math.round(settings.mix * 100)}% mix` : ''
      showToast(`Noise reduced with ${engineLabel}${mixNote} — undo to compare`)
      return true
    } catch (err) {
      console.error('Noise reduction failed:', err)
      if (err instanceof DocumentSwitchedError) showToast(err.message)
      else if (!entitlements.handleServerRefusal(err)) showToast(err.message || 'Noise reduction failed')
      return false
    } finally {
      if (seq === processSeq) processing.value = false
      endProcessing(pin.docId)
    }
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
    openModal,
    closeModal,
  }
}
