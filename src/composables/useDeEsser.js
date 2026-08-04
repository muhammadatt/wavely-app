import { computed, ref } from 'vue'
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

export const DEESSER_WINDOW_ID = 'clip-gain-deesser'

// ── Frozen half ───────────────────────────────────────────────────────────────
// Set by Analyse, and only by Analyse. Everything below the divider is derived
// from these numbers without touching the server again.

/** Per-event measurements from the last analysis: eventPeakDb + contextRmsDb. */
const measuredEvents = ref([])
const analysis = ref(null)
const analyzing = ref(false)
const analyzedKey = ref(null)

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
const inputDb = ref(-Infinity)
const outputDb = ref(-Infinity)
const treatedCount = ref(0)
const maxReductionDb = ref(0)
let meterId = null

export function useDeEsser() {
  const {
    state, getAudioContext, hasSelection, replaceRegion, setPeakCache,
    startProcessing, endProcessing, showToast,
  } = useEditorState()
  const { openWindow, closeWindow } = useWindows()

  /** Identifies the exact audio a result was measured from. */
  function selectionKey() {
    if (!state.selection || !state.currentFile) return null
    const { start, end } = state.selection
    const ids = state.segments.map(s => s.sourceBufferId ?? 'silence').join(',')
    return `${start.toFixed(6)}:${end.toFixed(6)}:${ids}`
  }

  /**
   * True when the analysis no longer describes the current selection.
   *
   * Event offsets are relative to the analysed region, so an edit that shifts
   * the timeline would place every one of them somewhere else. Nothing about
   * the numbers themselves would look wrong, which is why this is checked
   * rather than trusted.
   */
  const isStale = computed(
    () => analysis.value !== null && analyzedKey.value !== selectionKey(),
  )

  const hasAnalysis = computed(() => measuredEvents.value.length > 0)

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
    function tick() {
      const nodes = chain.effects.find(e => e.id === clipGainDeEsserEffect.id)?.nodes
      if (nodes) {
        inputDb.value = nodes.getInputLevelDb()
        outputDb.value = nodes.getOutputLevelDb()
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
    inputDb.value = -Infinity
    outputDb.value = -Infinity
  }

  /**
   * Rebuild the envelope from the frozen measurements and push it to the chain.
   *
   * This is the whole live path: every attenuation control lands here, and it
   * is a decision pass plus an envelope render over the analysed region —
   * milliseconds, no server, no re-detection.
   */
  function rebuildEnvelope() {
    if (!state.selection || !state.currentFile || !hasAnalysis.value) {
      treatedCount.value = 0
      maxReductionDb.value = 0
      return null
    }
    const { start, end } = state.selection
    const sampleRate = state.currentFile.sampleRate
    const numSamples = Math.ceil((end - start) * sampleRate)

    const rendered = renderDeEsserEnvelope(
      measuredEvents.value, numSamples, sampleRate, params.value,
    )
    treatedCount.value = rendered.treatedCount
    maxReductionDb.value = rendered.maxReductionDb
    return { deviation: rendered.deviation, startSec: start }
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
    analyzedKey.value = null
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
        params: pruneUndefined({
          detection, minDurationMs, contextWindowMs, ...params.value,
        }),
      })

      analysis.value = result
      measuredEvents.value = result.measuredEvents
      analyzedKey.value = selectionKey()
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
    if (!state.selection || !hasAnalysis.value) return
    const { start, end } = state.selection

    const envelope = rebuildEnvelope()
    if (!envelope) return

    const wasPreviewing = preview.value
    if (wasPreviewing) togglePreview()

    startProcessing('De-essing...')
    try {
      const buffer = applyDeEsserRegion(
        state.segments, start, end, envelope.deviation,
        state.currentFile.sampleRate, state.currentFile.channels,
      )
      const bufferId = replaceRegion(start, end, buffer)
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
    treatedCount, maxReductionDb, inputDb, outputDb,
    tuning, syncTuning, resetTuning,
    hasAnalysis, hasSelection, isStale,
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
