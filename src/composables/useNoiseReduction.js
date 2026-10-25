import { computed, reactive, ref } from 'vue'
import { useEditorState, DocumentSwitchedError } from './useEditorState.js'
import { useEntitlements } from './useEntitlements.js'
import { useWindows } from './useWindows.js'
import { computePeakCache } from '../audio/processing.js'
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
 * THERE IS NO LIVE PREVIEW, so the plugin has an audition of its own instead.
 * Process sends the selection once and holds what comes back next to what was
 * sent; Listen plays the pair from the start of the region straight to the
 * output, with Original / Denoised switching between them and Mix blending
 * them, both live, because both are gains on audio already in hand. Apply
 * commits that same blend — what was auditioned is what lands, sample for
 * sample — or processes first when there is nothing current to commit.
 *
 * ONE COPY, NOT pluginCopies(). The plugin cannot take a Plugin Chain slot: a
 * slot needs a node in the live chain, and a model that runs on the server has
 * none. So there is only ever the solo window to back.
 *
 * Free users may process up to FREE_PREVIEW_SECONDS to hear the result (the
 * server checks the same limit); Apply needs Pro (`applyFeature` on the window).
 */

const params = reactive({ ...NOISE_REDUCTION_DEFAULTS })

/**
 * The last processed region: { docId, revision, start, end, paramsKey,
 * sampleRate, dry, wet }. Held until the audio or a server setting moves.
 */
const result = ref(null)
const processing = ref(false)

const listening = ref(false)
/** 'denoised' | 'original' — which side Listen plays. */
const listenTo = ref('denoised')

let audition = null // { sources, dryGain, wetGain }
let processSeq = 0

const SAME_TIME_EPS = 1e-6

export function useNoiseReduction() {
  const {
    state, appState, getAudioContext, hasSelection, replaceRegion, setPeakCache,
    startProcessing, endProcessing, pinActiveDocument, showToast,
  } = useEditorState()
  const entitlements = useEntitlements()
  const { openWindow, closeWindow } = useWindows()

  /**
   * True while `result` describes the audio and settings in front of the user.
   * The revision identifies the timeline (see useAutoLevel's sourceKey for why
   * buffer ids are not enough); the params key is everything the server read.
   */
  function resultMatchesSource(r = result.value) {
    return !!r
      && r.docId === appState.activeDocumentId
      && r.revision === state.revision
      && r.paramsKey === serverParamsKey(params)
  }

  const hasResult = computed(() => resultMatchesSource())

  /** The result covers exactly the current selection, so Apply can commit it. */
  const resultCoversSelection = computed(() => {
    const r = result.value
    const sel = state.selection
    return hasResult.value && !!sel
      && Math.abs(r.start - sel.start) < SAME_TIME_EPS
      && Math.abs(r.end - sel.end) < SAME_TIME_EPS
  })

  /** A result exists but no longer describes the audio or the settings. */
  const isStale = computed(() => result.value !== null && !hasResult.value)

  function setEngine(engine) {
    params.engine = engine
  }

  function setDf3Limit(v) {
    params.df3LimitDb = v
  }

  function setProtectConsonants(on) {
    params.protectConsonants = on
  }

  /** Mix is a browser-side blend: retunes the audition, never re-processes. */
  function setMix(v) {
    params.mix = v
    updateAuditionGains()
  }

  function setListenTo(which) {
    listenTo.value = which
    updateAuditionGains()
  }

  function resetParams() {
    Object.assign(params, NOISE_REDUCTION_DEFAULTS)
    updateAuditionGains()
  }

  // ── Server round trip ─────────────────────────────────────────────────────

  /**
   * Process [start, end), store the result and return it — or null when it
   * was superseded, cancelled or failed (with the toast already shown).
   */
  async function processRegion(start, end, label) {
    const { sampleRate, channels } = state.currentFile
    const pin = pinActiveDocument('Noise Reduction')
    const revision = state.revision
    const paramsKey = serverParamsKey(params)
    const seq = ++processSeq
    const engineLabel = NR_ENGINE_LABELS[params.engine]

    stopAudition()
    processing.value = true
    startProcessing(`${label} (${engineLabel})...`, pin.docId)
    try {
      const out = await denoiseRegion({
        segments: state.segments, start, end, sampleRate, channels,
        params: { ...params },
        isCancelled: () => seq !== processSeq,
      })
      if (!out || seq !== processSeq) return null
      pin.check()
      if (state.revision !== revision) {
        showToast('Audio changed during noise reduction — process again')
        return null
      }
      result.value = {
        docId: pin.docId, revision, start, end, paramsKey, sampleRate,
        dry: out.dry, wet: out.wet,
      }
      return result.value
    } catch (err) {
      console.error('Noise reduction failed:', err)
      if (err instanceof DocumentSwitchedError) showToast(err.message)
      else if (!entitlements.handleServerRefusal(err)) showToast(err.message || 'Noise reduction failed')
      return null
    } finally {
      if (seq === processSeq) processing.value = false
      endProcessing(pin.docId)
    }
  }

  /**
   * Process the selection to audition it. A user without the full feature gets
   * the first FREE_PREVIEW_SECONDS — the selection itself is left alone, so
   * Apply still names the region the user chose.
   */
  async function process() {
    if (!state.selection || !state.currentFile || processing.value) return
    const { start, end } = state.selection
    const limit = entitlements.previewLimit('noiseReduction')
    const stop = Math.min(end, start + limit)
    if (stop < end) {
      showToast(`Free preview: the first ${limit} s of your selection — Pro processes all of it`, 5000)
    }
    const r = await processRegion(start, stop, 'Reducing noise')
    if (r) {
      showToast('Processed — Listen to compare, then Apply')
      startAudition()
    }
  }

  // ── Audition ──────────────────────────────────────────────────────────────

  function auditionGains() {
    if (listenTo.value === 'original') return { dry: 1, wet: 0 }
    return { dry: 1 - params.mix, wet: params.mix }
  }

  function updateAuditionGains() {
    if (!audition) return
    const ctx = getAudioContext()
    const g = auditionGains()
    // A short ramp so switching sides mid-word is a crossfade, not a click.
    audition.dryGain.gain.setTargetAtTime(g.dry, ctx.currentTime, 0.008)
    audition.wetGain.gain.setTargetAtTime(g.wet, ctx.currentTime, 0.008)
  }

  function startAudition() {
    const r = result.value
    if (!hasResult.value || !r) return
    stopAudition()
    // One output at a time: the transport and the audition would talk over
    // each other otherwise.
    if (state.isPlaying) window.dispatchEvent(new CustomEvent('wavely:toggle-play'))

    const ctx = getAudioContext()
    const make = (channelData) => {
      const buf = ctx.createBuffer(channelData.length, channelData[0].length, r.sampleRate)
      channelData.forEach((d, ch) => buf.copyToChannel(d, ch))
      return buf
    }
    const g = auditionGains()
    const dryGain = ctx.createGain()
    const wetGain = ctx.createGain()
    dryGain.gain.value = g.dry
    wetGain.gain.value = g.wet
    dryGain.connect(ctx.destination)
    wetGain.connect(ctx.destination)

    const drySrc = ctx.createBufferSource()
    const wetSrc = ctx.createBufferSource()
    drySrc.buffer = make(r.dry)
    wetSrc.buffer = make(r.wet)
    drySrc.connect(dryGain)
    wetSrc.connect(wetGain)
    // Both on the same clock tick, so the blend is the sum Apply will write.
    const at = ctx.currentTime + 0.03
    drySrc.start(at)
    wetSrc.start(at)
    const session = { sources: [drySrc, wetSrc], dryGain, wetGain }
    wetSrc.onended = () => {
      if (audition === session) stopAudition()
    }
    audition = session
    listening.value = true
  }

  function stopAudition() {
    if (audition) {
      for (const s of audition.sources) {
        s.onended = null
        try { s.stop() } catch { /* never started */ }
        s.disconnect()
      }
      audition.dryGain.disconnect()
      audition.wetGain.disconnect()
      audition = null
    }
    listening.value = false
  }

  function toggleAudition() {
    if (listening.value) stopAudition()
    else startAudition()
  }

  // ── Apply ─────────────────────────────────────────────────────────────────

  /**
   * Commit the blend over the selection: the held result when it covers it
   * with the current settings, else a fresh round trip first.
   */
  async function apply() {
    if (!state.selection || !state.currentFile || processing.value) return
    if (!entitlements.request('noiseReduction')) return
    stopAudition()
    const { start, end } = state.selection

    const r = resultCoversSelection.value
      ? result.value
      : await processRegion(start, end, 'Reducing noise')
    if (!r) return

    const pin = pinActiveDocument('Noise Reduction')
    startProcessing('Applying noise reduction...', pin.docId)
    try {
      pin.check()
      const channels = blendDryWet(r.dry, r.wet, params.mix)
      const buffer = getAudioContext().createBuffer(channels.length, channels[0].length, r.sampleRate)
      channels.forEach((d, ch) => buffer.copyToChannel(d, ch))
      const bufferId = replaceRegion(start, end, buffer, 'noise reduction', pin.docId)
      const cache = await computePeakCache(buffer, 256)
      setPeakCache(bufferId, cache)
      const mixNote = params.mix < 1 ? ` at ${Math.round(params.mix * 100)}% mix` : ''
      showToast(`Noise reduced with ${NR_ENGINE_LABELS[params.engine]}${mixNote}`)
      // The audio just changed, so the result no longer describes it.
      result.value = null
    } catch (err) {
      console.error('Noise reduction apply failed:', err)
      showToast(err instanceof DocumentSwitchedError ? err.message : 'Noise reduction failed')
    } finally {
      endProcessing(pin.docId)
    }
  }

  function teardown() {
    stopAudition()
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
    listening,
    listenTo,
    hasResult,
    resultCoversSelection,
    isStale,
    hasSelection,
    result,
    setEngine,
    setDf3Limit,
    setProtectConsonants,
    setMix,
    setListenTo,
    resetParams,
    process,
    toggleAudition,
    stopAudition,
    apply,
    teardown,
    openModal,
    closeModal,
  }
}
