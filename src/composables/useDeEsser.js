import { computed, ref, watch } from 'vue'
import { useEditorState } from './useEditorState.js'
import { useWindows } from './useWindows.js'
import { analyzeSibilance } from '../api/analyze.js'
import { applyDeEsserRegion, computePeakCache } from '../audio/processing.js'
import { getEffectChain } from '../audio/effectChain.js'
import {
  clipGainDeEsserEffect,
  DEESSER_DEFAULTS,
  renderDeEsserEnvelope,
} from '../audio/effects/clipGainDeEss.js'
import { regionCovers } from '../audio/dsp/clipGainDecision.js'
import { snapshotLevels } from '../audio/effects/levelTap.js'

export const DEESSER_WINDOW_ID = 'clip-gain-deesser'

// ── Frozen half ───────────────────────────────────────────────────────────────
// Set by Analyse, and only by Analyse. Everything below the divider is derived
// from these numbers without touching the server again.

/** Per-event measurements from the last analysis: eventPeakDb + contextRmsDb. */
const measuredEvents = ref([])
const analysis = ref(null)
const analyzing = ref(false)

/**
 * The region the measurements describe, and which audio it was measured from.
 *
 * Stored as a region rather than as an exact selection fingerprint. Narrowing
 * the selection to work on one phrase is the normal way to use this, and every
 * event inside the new bounds was already measured — re-running detection there
 * would return the same numbers for the third time.
 */
const analyzedRegion = ref(null) // { start, end, sourceKey }

/**
 * Detection parameter OVERRIDES — sparse, empty by default.
 *
 * Deliberately not seeded from a defaults table: the parameter names and their
 * descriptions live in sibilanceTuning.js, which only the dev panel imports, so
 * a production build carries no trace of them. An empty object means "use the
 * server's defaults", which is what every ordinary user gets.
 */
const tuning = ref({})

// ── Live half ─────────────────────────────────────────────────────────────────
// Pure functions of the frozen measurements, recomputed on every change.

const params = ref({ ...DEESSER_DEFAULTS })
const preview = ref(false)
const reductionDb = ref(0)
const inputLevels = ref([])
const outputLevels = ref([])
const treatedCount = ref(0)
const maxReductionDb = ref(0)
let meterId = null
let meterLastMs = 0

/**
 * Release time constant for the gain-reduction meter, in ms.
 *
 * The reduction itself is an impulse — 30–80 ms with 3 ms fades — so a meter
 * that tracks it literally is invisible at 60 fps. Instant attack and a slow
 * release is the standard hardware behaviour: the needle jumps and falls back.
 */
const GR_RELEASE_MS = 300

/** Below this the bar is holding a rounding error, not a reduction. */
const GR_FLOOR_DB = 0.05

export function useDeEsser() {
  const {
    state, getAudioContext, hasSelection, replaceRegion, setPeakCache,
    startProcessing, endProcessing, showToast,
  } = useEditorState()
  const { openWindow, closeWindow } = useWindows()

  /**
   * Identifies the audio itself — not the selection within it.
   *
   * Any edit mints new buffer ids, and loading another file replaces them
   * wholesale, so this changing means the measurements describe audio that is
   * no longer on the timeline.
   */
  function sourceKey() {
    if (!state.currentFile) return null
    const ids = state.segments.map(s => s.sourceBufferId ?? 'silence').join(',')
    return `${state.currentFile.name}:${ids}`
  }

  /**
   * True when the analysis no longer covers what is selected.
   *
   * Two ways to go stale, and they are different failures. The audio changed —
   * an edit, or a different file — and the offsets now point at unrelated
   * samples. Or the selection has moved outside the analysed region, where
   * nothing was measured. Narrowing INSIDE the region is neither: those events
   * are already measured.
   */
  const isStale = computed(() => {
    const region = analyzedRegion.value
    if (!region) return false
    if (region.sourceKey !== sourceKey()) return true
    return !regionCovers(region, state.selection)
  })

  const hasAnalysis = computed(() => measuredEvents.value.length > 0)

  /** Measurements exist AND still describe what is selected. */
  const envelopeValid = computed(() => hasAnalysis.value && !isStale.value)

  function initChain() {
    const ctx = getAudioContext()
    const chain = getEffectChain(ctx)
    if (!chain.effects.find(e => e.id === clipGainDeEsserEffect.id)) {
      chain.addEffect(clipGainDeEsserEffect)
    }
    return chain
  }

  function startMeters(chain) {
    stopMeters()
    function tick(nowMs) {
      const nodes = chain.effects.find(e => e.id === clipGainDeEsserEffect.id)?.nodes
      if (nodes) {
        // Only meter channels the source really has: the splitter is
        // discrete, so asking for stereo on a mono file adds a dead bar.
        const chCount = state.currentFile?.channels ?? 1
        inputLevels.value = snapshotLevels(nodes.getInputLevels(chCount))
        outputLevels.value = snapshotLevels(nodes.getOutputLevels(chCount))

        // Both values are <= 0, so "more reduction" is more negative. Attack is
        // instantaneous — the peak the node reports for this frame is shown in
        // full, never averaged away — and only the fall back to rest is damped.
        const peak = nodes.getReduction()
        const dtMs = meterLastMs ? nowMs - meterLastMs : 0
        meterLastMs = nowMs
        if (peak <= reductionDb.value) {
          reductionDb.value = peak
        } else {
          const k = Math.exp(-dtMs / GR_RELEASE_MS)
          const released = peak + (reductionDb.value - peak) * k
          reductionDb.value = released > -GR_FLOOR_DB ? peak : released
        }
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
    meterLastMs = 0
    inputLevels.value = []
    outputLevels.value = []
    reductionDb.value = 0
  }

  /**
   * Rebuild the envelope from the frozen measurements and push it to the chain.
   *
   * This is the whole live path: every attenuation control lands here, and it
   * is a decision pass plus an envelope render over the analysed region —
   * milliseconds, no server, no re-detection.
   */
  function rebuildEnvelope() {
    // A stale envelope must not keep playing. Event offsets are relative to the
    // analysed region, so once the audio underneath has changed they point at
    // unrelated samples — audible, wrong, and with nothing on screen to explain
    // it beyond a line of text.
    if (!state.currentFile || !envelopeValid.value) {
      treatedCount.value = 0
      maxReductionDb.value = 0
      return null
    }
    const region = analyzedRegion.value
    const sampleRate = state.currentFile.sampleRate
    // Built over the ANALYSED region, positioned at its start. Event offsets are
    // relative to that, so narrowing the selection changes nothing here — it
    // only changes which part of it apply() writes back.
    const numSamples = Math.ceil((region.end - region.start) * sampleRate)

    const rendered = renderDeEsserEnvelope(
      measuredEvents.value, numSamples, sampleRate, params.value,
    )
    treatedCount.value = rendered.treatedCount
    maxReductionDb.value = rendered.maxReductionDb
    return { deviation: rendered.deviation, startSec: region.start }
  }

  function pushEnvelope() {
    if (!preview.value) return
    const chain = getEffectChain(getAudioContext())
    chain.updateParam(clipGainDeEsserEffect.id, 'envelope', rebuildEnvelope())
  }

  function togglePreview() {
    const chain = initChain()
    preview.value = !preview.value
    chain.setEnabled(clipGainDeEsserEffect.id, preview.value)

    if (preview.value) {
      chain.updateParam(clipGainDeEsserEffect.id, 'envelope', rebuildEnvelope())
      startMeters(chain)
    } else {
      stopMeters()
    }
  }

  // Going stale has to take the envelope out of the chain, not just change the
  // status text. Until this existed the effect kept applying measurements from
  // a region — or a file — that was no longer under the playhead.
  watch(isStale, (stale) => {
    if (stale) pushEnvelope()
  })

  /** Every attenuation control routes through here. */
  function syncParam(name, value) {
    params.value = { ...params.value, [name]: value }
    pushEnvelope()
  }

  /** Detection parameters — dev tuning panel only. Invalidates the analysis. */
  function syncTuning(name, value) {
    tuning.value = { ...tuning.value, [name]: value }
  }

  function resetTuning() {
    tuning.value = {}
  }

  function clearAnalysis() {
    measuredEvents.value = []
    analysis.value = null
    analyzedRegion.value = null
    treatedCount.value = 0
    maxReductionDb.value = 0
    pushEnvelope()
  }

  /** Run sibilance detection over the current selection. */
  async function analyze() {
    if (!state.selection || !state.currentFile) return
    const { start, end } = state.selection

    analyzing.value = true
    try {
      const { detection, minDurationMs, contextWindowMs } = splitTuning(tuning.value)
      const result = await analyzeSibilance({
        segments: state.segments,
        start,
        end,
        sampleRate: state.currentFile.sampleRate,
        channels: state.currentFile.channels,
        // Detection settings only. The ceilings, ratio, cap and fades never
        // reach detection — measuredEvents is collected before the ceiling
        // test — so sending them would only change a treatedCount in the
        // response that the client recomputes anyway.
        params: pruneUndefined({ detection, minDurationMs, contextWindowMs }),
      })

      analysis.value = result
      measuredEvents.value = result.measuredEvents
      analyzedRegion.value = { start, end, sourceKey: sourceKey() }
      pushEnvelope()

      const n = result.measuredEvents.length
      showToast(
        n === 0
          ? 'No sibilant events detected'
          : `${n} sibilant event${n === 1 ? '' : 's'} detected`,
      )
    } catch (err) {
      console.error('Sibilance analysis failed:', err)
      showToast(err.message ?? 'Sibilance analysis failed')
    } finally {
      analyzing.value = false
    }
  }

  async function apply() {
    if (!state.selection || !envelopeValid.value) return
    const { start, end } = state.selection

    const envelope = rebuildEnvelope()
    if (!envelope) return

    // The envelope spans the analysed region; apply writes back only the
    // current selection, so take the slice that lines up with it.
    const sampleRate = state.currentFile.sampleRate
    const offset = Math.round((start - envelope.startSec) * sampleRate)
    const length = Math.ceil((end - start) * sampleRate)
    const slice = envelope.deviation.subarray(
      Math.max(0, offset),
      Math.min(envelope.deviation.length, Math.max(0, offset) + length),
    )

    const wasPreviewing = preview.value
    if (wasPreviewing) togglePreview()

    startProcessing('De-essing...')
    try {
      const buffer = applyDeEsserRegion(
        state.segments, start, end, slice,
        state.currentFile.sampleRate, state.currentFile.channels,
      )
      const bufferId = replaceRegion(start, end, buffer, 'de-essing')
      const cache = await computePeakCache(buffer, 256)
      setPeakCache(bufferId, cache)
      showToast(`De-essed ${treatedCount.value} event${treatedCount.value === 1 ? '' : 's'}`)
      // The audio just changed, so the measurements no longer describe it.
      clearAnalysis()
    } catch (err) {
      console.error('De-esser apply failed:', err)
      showToast('De-esser apply failed')
    } finally {
      endProcessing()
    }
  }

  function teardown() {
    if (preview.value) togglePreview()
    stopMeters()
  }

  return {
    params, preview, analysis, analyzing, measuredEvents,
    treatedCount, maxReductionDb, reductionDb, inputLevels, outputLevels,
    tuning, syncTuning, resetTuning,
    hasAnalysis, hasSelection, isStale, envelopeValid, analyzedRegion,
    togglePreview, syncParam, analyze, apply, teardown,
    openModal: () => openWindow(DEESSER_WINDOW_ID),
    closeModal: () => closeWindow(DEESSER_WINDOW_ID),
  }
}

/**
 * Split the sparse tuning overrides into what the route expects.
 *
 * minDurationMs and contextWindowMs are de-esser-stage settings; everything
 * else is a sibilance_detector.DEFAULT_PARAMS override and goes under
 * `detection` as a sparse patch. Absent keys stay absent so the server's own
 * defaults apply — which is the whole production path.
 */
function splitTuning(t) {
  const { minDurationMs, contextWindowMs, ...detection } = t
  return { detection, minDurationMs, contextWindowMs }
}

/** Drop undefined keys so they do not override a server default with null. */
function pruneUndefined(obj) {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined))
}
