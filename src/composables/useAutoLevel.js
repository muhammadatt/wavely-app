import { computed, ref } from 'vue'
import { useEditorState, DocumentSwitchedError } from './useEditorState.js'
import { useWindows } from './useWindows.js'
import { useEntitlements } from './useEntitlements.js'
import { analyzeVoiceActivity } from '../api/analyze.js'
import { applyAutoLevelRegion, computePeakCache, renderRegionToBuffer } from '../audio/processing.js'
import {
  AUTOLEVEL_DEFAULTS, expandVoicedRuns, prepareAutoLevel, solveAutoLevel,
} from '../audio/dsp/autoLevel.js'

export const AUTOLEVEL_WINDOW_ID = 'auto-leveler'

/**
 * Auto Leveler — an OFFLINE process: set the controls, press Apply, listen in
 * the editor, Undo if it is wrong.
 *
 * It used to be a real-time plugin (Analyse → a live gain curve in the
 * playback chain → Apply), with the analysis free and Apply Pro. The live
 * curve demonstrated little — phrase-to-phrase gain steps of a dB or two are
 * not something anyone judges by ear while a knob moves — and it made the
 * plugin a three-step job for the user who just wants the take levelled. So
 * one button now does all of it:
 *
 *   1. voice-activity detection on the server (`/api/analyze/vad`)
 *   2. clips and per-clip loudness, then the gain solve (browser)
 *   3. render the gain curve over the selection and commit one undo step
 *
 * Pro only (`autoLevel` in src/auth/plans.js, `offline: true`): asked for
 * before the upload, so a free user never waits on an analysis they cannot use.
 *
 * NOT CHAINABLE, ONE COPY. A Plugin Chain slot needs a live node, and the
 * leveler no longer has one. The live node (src/audio/effects/autoLevel.js)
 * stays in the tree, tested, for a future real-time use.
 */

const params = ref({ ...AUTOLEVEL_DEFAULTS })
const processing = ref(false)
/**
 * What the last Apply did, for the panel, PER FILE: { measurements } when it
 * levelled, { reason } when it declined. Cleared by nothing while the file is
 * open — it describes a past action and says so ("Last run") — and another tab
 * shows its own last run, or none.
 */
const lastResults = ref({})
const { appState } = useEditorState()
const lastResult = computed(() => lastResults.value[appState.activeDocumentId] ?? null)

/** Record what a run on `docId` did (apply calls it; exported for tests). */
export function recordAutoLevelResult(docId, result) {
  lastResults.value = { ...lastResults.value, [docId]: result }
}

/** Forget the last runs of files that are no longer open. */
export function forgetAutoLevelResults(openIds) {
  const open = new Set(openIds)
  if (Object.keys(lastResults.value).some(id => !open.has(id))) {
    lastResults.value = Object.fromEntries(Object.entries(lastResults.value).filter(([id]) => open.has(id)))
  }
}

/**
 * Auto Leveler's settings, for per-file save and restore. Known keys only, and
 * written straight in: a run in flight took its own copy when it started, so a
 * tab switch mid-run changes nothing it renders.
 */
export const autoLevelSettingsIO = {
  read: () => ({ ...params.value }),
  write: (p) => {
    const next = { ...params.value }
    for (const k of Object.keys(AUTOLEVEL_DEFAULTS)) {
      if (p && k in p && typeof p[k] === typeof AUTOLEVEL_DEFAULTS[k]) next[k] = p[k]
    }
    params.value = next
  },
}

/** Why the leveler declined, in the user's terms rather than the enum's. */
export function skipReasonText(reason) {
  switch (reason) {
    case 'duration_too_short':
      return 'Selection is under 10 seconds — too short to find a level to hold.'
    case 'insufficient_voiced_audio':
      return 'Under 5 seconds of speech in this selection.'
    case 'insufficient_clips':
      return 'Only one phrase found — nothing to level against.'
    case 'file_already_leveled':
      return 'Already level: every phrase is inside the deadband. Lower it to make a change.'
    default:
      return reason ? 'Nothing to level in this selection.' : null
  }
}

/**
 * The last run as figures, for the panel's LAST RUN card: null before any run;
 * else `declined` (the reason's text, or null when it levelled) and, when it
 * levelled, phrases, the phrase-loudness spread before / after, the deepest cut
 * and the largest boost (both dB ≥ 0), and `cap` when the room-tone floor
 * limited the boosts — `{ boostDb }`, 0 when it allowed none.
 */
export const lastRunSummary = computed(() => {
  const r = lastResult.value
  if (!r) return null
  const m = r.measurements
  if (!m) return { declined: skipReasonText(r.reason) }
  return {
    declined: r.reason ? skipReasonText(r.reason) : null,
    phrases: m.clip_count_after_merge,
    spreadBeforeDb: m.input_clip_lufs_std_db,
    spreadAfterDb: m.output_clip_lufs_std_db,
    // gain_max_down_db is the solve's signed MINIMUM gain (−3.2 for a 3.2 dB
    // cut, 0 when nothing was cut), so the cut is its magnitude.
    cutDb: Math.max(0, -m.gain_max_down_db),
    boostDb: Math.max(0, m.gain_max_up_db),
    cap: m.noise_floor_cap_active ? { boostDb: m.max_up_effective_db <= 0.01 ? 0 : m.max_up_effective_db } : null,
  }
})

export function useAutoLevel() {
  const {
    state, hasSelection, replaceRegion, setPeakCache,
    startProcessing, endProcessing, pinActiveDocument, showToast,
  } = useEditorState()
  const entitlements = useEntitlements()
  const { openWindow, closeWindow } = useWindows()

  /** Set one param. Refused while a run is in flight (its controls are dimmed). */
  function syncParam(name, value) {
    if (processing.value) return
    params.value = { ...params.value, [name]: value }
  }

  function resetParams() {
    params.value = { ...AUTOLEVEL_DEFAULTS }
  }

  /**
   * Analyse, solve and commit over the selection. Resolves true when the
   * timeline changed.
   */
  async function apply() {
    if (!state.selection || !state.currentFile || processing.value) return false
    if (!entitlements.request('autoLevel')) return false
    const { start, end } = state.selection
    const { sampleRate, channels } = state.currentFile
    // Pinned to the document Apply was pressed on: tabs stay usable while it
    // runs, and `state` follows the active one (pinActiveDocument).
    const pin = pinActiveDocument('Auto Leveler')
    // ⚠ CAPTURED BEFORE THE REQUEST, CHECKED AFTER IT: the round trip is
    // seconds long and the editor stays live, so an edit can land while the
    // mask is in flight — and the mask would then describe audio that no
    // longer exists. `revision` identifies the timeline; buffer ids do not
    // (a trim keeps them while moving every segment).
    const revision = state.revision
    const settings = { ...params.value }

    processing.value = true
    startProcessing('Detecting speech...', pin.docId)
    try {
      const vad = await analyzeVoiceActivity({
        segments: state.segments, start, end, sampleRate, channels,
      })
      pin.check()
      if (state.revision !== revision) {
        showToast('Audio changed during analysis — try again')
        return false
      }

      // Mono for analysis: clip loudness and the mask are both single-channel
      // measurements, and the gain that comes out is applied to every channel.
      // Rendered after the upload rather than reused, so a chapter-length
      // mixdown is not held across the round trip.
      const mono = monoMixdown(renderRegionToBuffer(state.segments, start, end, sampleRate, channels))
      const prepared = prepareAutoLevel({
        audio: mono,
        sampleRate,
        frameVoiced: expandVoicedRuns(vad.voicedRuns, vad.numFrames),
        frameDurationS: vad.frameDurationS,
        noiseFloorDbfs: vad.noiseFloorDbfs,
      })
      const solved = prepared.applicable ? solveAutoLevel(prepared, settings) : null
      if (!solved?.applied) {
        const reason = prepared.applicable ? solved.reason : prepared.reason
        recordAutoLevelResult(pin.docId, { reason })
        showToast(skipReasonText(reason))
        return false
      }

      const buffer = applyAutoLevelRegion(
        state.segments, start, end, solved.segments, start, sampleRate, channels,
      )
      pin.check()
      const bufferId = replaceRegion(start, end, buffer, 'auto-levelling', pin.docId, pin.selection)
      const cache = await computePeakCache(buffer, 256)
      setPeakCache(bufferId, cache)

      const m = solved.measurements
      recordAutoLevelResult(pin.docId, { measurements: m })
      showToast(
        `Levelled ${m.clip_count_after_merge} phrases — ` +
        `spread ${m.input_clip_lufs_std_db.toFixed(1)} → ` +
        `${m.output_clip_lufs_std_db.toFixed(1)} dB`,
      )
      return true
    } catch (err) {
      console.error('Auto Leveler failed:', err)
      if (err instanceof DocumentSwitchedError) showToast(err.message)
      else if (!entitlements.handleServerRefusal(err)) showToast(err.message ?? 'Auto Leveler failed')
      return false
    } finally {
      processing.value = false
      endProcessing(pin.docId)
    }
  }

  return {
    params, processing, lastResult, lastRunSummary, hasSelection,
    syncParam, resetParams, apply,
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
