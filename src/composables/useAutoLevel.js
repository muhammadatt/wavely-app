import { computed, ref, watch } from 'vue'
import { useEditorState } from './useEditorState.js'
import { useWindows } from './useWindows.js'
import { analyzeVoiceActivity } from '../api/analyze.js'
import { applyAutoLevelRegion, computePeakCache, renderRegionToBuffer } from '../audio/processing.js'
import { getEffectChain } from '../audio/effectChain.js'
import { autoLevelerEffect } from '../audio/effects/autoLevel.js'
import {
  AUTOLEVEL_DEFAULTS, expandVoicedRuns, prepareAutoLevel, solveAutoLevel,
} from '../audio/dsp/autoLevel.js'
import { snapshotLevels } from '../audio/effects/levelTap.js'
// A generic region predicate that happens to live in the de-esser's decision
// module. Shared rather than re-spelled: the +/-1e-6 tolerance is a convention,
// and two copies of a convention are one copy and a future bug.
import { regionCovers } from '../audio/dsp/clipGainDecision.js'

export const AUTOLEVEL_WINDOW_ID = 'auto-leveler'

/**
 * Auto Leveler — three-speed, where the de-esser is two.
 *
 *   Analyse (server)   the VAD mask. Seconds, once per region.
 *   Prepare  (client)  clips and per-clip loudness. A few hundred ms on a long
 *                      selection, and only when the mask or the audio changes.
 *   Solve    (client)  gains, merges, fades. Milliseconds — every knob move.
 *
 * The middle step is the one the de-esser does not have, and it is why the
 * controls stay live on a chapter. Everything below the divider is a pure
 * function of `prepared`, which is itself a pure function of the mask and the
 * audio, so no control on this panel can ever cost a K-weighting pass.
 */

// ── Frozen half ───────────────────────────────────────────────────────────────

/** The server's answer, and the analysis built on it. */
const vad = ref(null)
const prepared = ref(null)
const analyzing = ref(false)

/**
 * The region the analysis describes, and which audio it was measured from.
 *
 * Same shape and same staleness rules as the de-esser's: an edit or a different
 * file invalidates it, and so does moving the selection outside the analysed
 * bounds — but narrowing inside them does not, because every clip in the
 * narrowed span was already measured.
 */
const analyzedRegion = ref(null) // { start, end, sourceKey }

// ── Live half ─────────────────────────────────────────────────────────────────

const params = ref({ ...AUTOLEVEL_DEFAULTS })
const preview = ref(false)
const solved = ref(null)
const gainDb = ref(0)
const inputLevels = ref([])
const outputLevels = ref([])
let meterId = null

/**
 * Ballistics for the gain readout.
 *
 * Slower than the de-esser's 300 ms, and for the opposite reason. A de-esser's
 * reduction is an impulse the meter has to catch; a leveler's gain is a
 * staircase that holds for whole phrases. Damping it at all is only to stop the
 * number flickering as the playhead crosses a 30 ms fade — the value itself is
 * exact, read straight out of the curve.
 */
const METER_TAU_MS = 120

export function useAutoLevel() {
  const {
    state, getAudioContext, hasSelection, replaceRegion, setPeakCache,
    startProcessing, endProcessing, showToast,
  } = useEditorState()
  const { openWindow, closeWindow } = useWindows()

  function sourceKey() {
    if (!state.currentFile) return null
    const ids = state.segments.map(s => s.sourceBufferId ?? 'silence').join(',')
    return `${state.currentFile.name}:${ids}`
  }

  const isStale = computed(() => {
    const region = analyzedRegion.value
    if (!region) return false
    if (region.sourceKey !== sourceKey()) return true
    // Narrowing inside the analysed region is fine; moving outside it is not.
    return !regionCovers(region, state.selection)
  })

  const hasAnalysis = computed(() => prepared.value?.applicable === true)
  const curveValid = computed(
    () => hasAnalysis.value && !isStale.value && solved.value?.applied === true,
  )

  /** Why the leveler declined, in the user's terms rather than the enum's. */
  const skipReason = computed(() => {
    const reason = prepared.value?.applicable === false
      ? prepared.value.reason
      : solved.value?.applied === false ? solved.value.reason : null
    switch (reason) {
      case 'duration_too_short':
        return 'Selection is under 10 seconds — too short to find a level to hold.'
      case 'insufficient_voiced_audio':
        return 'Under 5 seconds of speech in this selection.'
      case 'insufficient_clips':
        return 'Only one phrase found — nothing to level against.'
      case 'file_already_leveled':
        return 'Already level: every phrase is inside the deadband. Lower it to hear a change.'
      default:
        return null
    }
  })

  function initChain() {
    const ctx = getAudioContext()
    const chain = getEffectChain(ctx)
    if (!chain.effects.find(e => e.id === autoLevelerEffect.id)) {
      chain.addEffect(autoLevelerEffect)
    }
    return chain
  }

  function startMeters(chain) {
    stopMeters()
    let lastMs = 0
    function tick(nowMs) {
      const nodes = chain.effects.find(e => e.id === autoLevelerEffect.id)?.nodes
      if (nodes) {
        const chCount = state.currentFile?.channels ?? 1
        inputLevels.value = snapshotLevels(nodes.getInputLevels(chCount))
        outputLevels.value = snapshotLevels(nodes.getOutputLevels(chCount))

        const target = nodes.getGainDb()
        const dtMs = lastMs ? nowMs - lastMs : 0
        lastMs = nowMs
        const k = dtMs > 0 ? Math.exp(-dtMs / METER_TAU_MS) : 0
        gainDb.value = target + (gainDb.value - target) * k
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
    inputLevels.value = []
    outputLevels.value = []
    gainDb.value = 0
  }

  /**
   * Re-solve from the frozen analysis and push the curve to the chain.
   *
   * The entire live path. No server, no re-filtering, no re-segmentation — the
   * clips and their loudness are already known, so this is a median, a transfer
   * curve over a few hundred clips, and the fade placement.
   */
  function rebuildCurve() {
    if (!state.currentFile || !hasAnalysis.value || isStale.value) {
      solved.value = null
      return null
    }
    const result = solveAutoLevel(prepared.value, params.value)
    solved.value = result
    if (!result.applied) return null

    return {
      segments: result.segments,
      startSec: analyzedRegion.value.start,
      sampleRate: state.currentFile.sampleRate,
    }
  }

  function pushCurve() {
    if (!preview.value) return
    const chain = getEffectChain(getAudioContext())
    chain.updateParam(autoLevelerEffect.id, 'curve', rebuildCurve())
  }

  function togglePreview() {
    const chain = initChain()
    preview.value = !preview.value
    chain.setEnabled(autoLevelerEffect.id, preview.value)

    if (preview.value) {
      chain.updateParam(autoLevelerEffect.id, 'curve', rebuildCurve())
      startMeters(chain)
    } else {
      stopMeters()
    }
  }

  // A stale curve must leave the chain, not merely grey out the panel: the
  // segments are positioned against the analysed region, so once the audio
  // under them changes they apply phrase gains to unrelated phrases.
  watch(isStale, (stale) => {
    if (stale) pushCurve()
  })

  function syncParam(name, value) {
    params.value = { ...params.value, [name]: value }
    pushCurve()
  }

  function resetParams() {
    params.value = { ...AUTOLEVEL_DEFAULTS }
    pushCurve()
  }

  function clearAnalysis() {
    vad.value = null
    prepared.value = null
    solved.value = null
    analyzedRegion.value = null
    pushCurve()
  }

  /**
   * Fetch the VAD mask for the selection, then prepare against the same audio.
   *
   * The region is rendered twice — once to upload, once to analyse locally.
   * Reusing one render would mean holding a chapter-length mixdown across an
   * upload and a network round trip, which is the peak-memory moment of the
   * whole plugin. Rendering again afterwards costs a fraction of the wait that
   * just happened.
   */
  async function analyze() {
    if (!state.selection || !state.currentFile) return
    const { start, end } = state.selection
    const { sampleRate, channels } = state.currentFile

    analyzing.value = true
    try {
      const result = await analyzeVoiceActivity({
        segments: state.segments, start, end, sampleRate, channels,
      })
      vad.value = result

      // Mono for analysis: clip loudness and the mask are both single-channel
      // measurements, and the gain that comes out is applied to every channel.
      const mono = monoMixdown(
        renderRegionToBuffer(state.segments, start, end, sampleRate, channels),
      )

      prepared.value = prepareAutoLevel({
        audio: mono,
        sampleRate,
        frameVoiced: expandVoicedRuns(result.voicedRuns, result.numFrames),
        frameDurationS: result.frameDurationS,
        noiseFloorDbfs: result.noiseFloorDbfs,
      })
      analyzedRegion.value = { start, end, sourceKey: sourceKey() }
      pushCurve()

      if (!prepared.value.applicable) {
        showToast(skipReason.value ?? 'Nothing to level in this selection')
      } else {
        const n = prepared.value.clips.length
        showToast(`${n} phrase${n === 1 ? '' : 's'} found`)
      }
    } catch (err) {
      console.error('Voice-activity analysis failed:', err)
      showToast(err.message ?? 'Auto Leveler analysis failed')
    } finally {
      analyzing.value = false
    }
  }

  async function apply() {
    if (!state.selection || !curveValid.value) return
    const { start, end } = state.selection
    const curve = rebuildCurve()
    if (!curve) return

    const wasPreviewing = preview.value
    if (wasPreviewing) togglePreview()

    startProcessing('Levelling...')
    try {
      const buffer = applyAutoLevelRegion(
        state.segments, start, end, curve.segments, analyzedRegion.value.start,
        state.currentFile.sampleRate, state.currentFile.channels,
      )
      const bufferId = replaceRegion(start, end, buffer, 'auto-levelling')
      const cache = await computePeakCache(buffer, 256)
      setPeakCache(bufferId, cache)

      const m = solved.value.measurements
      showToast(
        `Levelled ${m.clip_count_after_merge} phrases — ` +
        `spread ${m.input_clip_lufs_std_db.toFixed(1)} → ` +
        `${m.output_clip_lufs_std_db.toFixed(1)} dB`,
      )
      // The audio just changed, so the clips no longer describe it.
      clearAnalysis()
    } catch (err) {
      console.error('Auto Leveler apply failed:', err)
      showToast('Auto Leveler apply failed')
    } finally {
      endProcessing()
    }
  }

  function teardown() {
    if (preview.value) togglePreview()
    stopMeters()
  }

  return {
    params, preview, analyzing, prepared, solved, vad,
    gainDb, inputLevels, outputLevels,
    hasAnalysis, hasSelection, isStale, curveValid, analyzedRegion, skipReason,
    togglePreview, syncParam, resetParams, analyze, apply, teardown,
    openModal: () => openWindow(AUTOLEVEL_WINDOW_ID),
    closeModal: () => closeWindow(AUTOLEVEL_WINDOW_ID),
  }
}

/** Average the channels down to one, which is what the analysis measures. */
function monoMixdown(channelData) {
  if (channelData.length === 1) return channelData[0]
  const n = channelData[0].length
  const mono = new Float32Array(n)
  for (let i = 0; i < n; i++) {
    let sum = 0
    for (let c = 0; c < channelData.length; c++) sum += channelData[c][i]
    mono[i] = sum / channelData.length
  }
  return mono
}
