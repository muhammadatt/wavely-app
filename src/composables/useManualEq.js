import { ref, computed, shallowRef } from 'vue'
import { useEditorState } from './useEditorState.js'
import { useWindows } from './useWindows.js'
import {
  applyManualEqRegion, computePeakCache, renderRegionToBuffer,
} from '../audio/processing.js'
import { getEffectChain } from '../audio/effectChain.js'
import { manualEqEffect } from '../audio/effects/manualEq.js'
import {
  MAX_BANDS, createBand, applyForfeiture, setBandFrequency, setBandQ,
  candidateRoleFor, tagBand, resetBandQ, getRole, bandForRole, untaggedBands,
  ROLES_IN_ORDER, PARAM_RANGES, clamp, qRangeFor,
} from '../audio/eqBands.js'
import { analyzeVoxDoc, MIN_VOICED_FRAMES, HOP_SIZE, FRAME_SIZE } from '../audio/voxdoc/analysis.js'
import { buildSuggestions, suggestionToBand } from '../audio/voxdoc/suggestions.js'
import { MALE_REGIONS } from '../audio/voxdoc/regions.js'
import { getTimelineDuration } from '../audio/operations.js'

// Registry id of this plugin's window. Must match the entry in src/ui/registry.js.
export const MANUAL_EQ_WINDOW_ID = 'manual-eq'

// Singleton reactive state shared between the sidebar trigger and the modal.
// One instance, two views — the two registry entries (EQ and VoxDoc) both land
// here, which is what makes the mode switch a view change rather than a second
// plugin.
const bands = ref([])
const mode = ref('general') // 'general' | 'voxdoc'
const eqPreview = ref(false)
const outputTrim = ref(0)
const soloBandId = ref(null)
const showAnalyzer = ref(false)
const inputDb = ref(-Infinity)
const outputDb = ref(-Infinity)

// Analysis is heavy and frozen; the curves inside it are typed arrays that must
// never become reactive proxies, hence shallowRef.
const analysis = shallowRef(null)
const analyzedKey = ref(null)
const analyzing = ref(false)
const analysisError = ref(null)
const analysisWidened = ref(false)
/** Roles surfaced beyond the default-visible set, by user action or detection. */
const revealedRoles = ref([])

let meterId = null

/**
 * Open the EQ window in a given view, without needing the editor state.
 *
 * The registry's VoxDoc entry calls this. It exists as a standalone function
 * because registry actions are handed the editor state and nothing else, and
 * routing "open this window in this view" through the editor state would put a
 * plugin's view flag on the document model, where it does not belong.
 */
export function openManualEqWindow(initialMode = 'general') {
  mode.value = initialMode
  useWindows().openWindow(MANUAL_EQ_WINDOW_ID)
}

/**
 * Bands, as the kernel wants them.
 *
 * Kept as a plain snapshot rather than the reactive array — see the note in
 * effects/manualEq.js about postMessage and proxies.
 */
function currentBands() {
  return bands.value
}

export function useManualEq() {
  const {
    state, getAudioContext, hasSelection, replaceRegion, setPeakCache,
    startProcessing, endProcessing, showToast,
  } = useEditorState()
  const { openWindow, closeWindow } = useWindows()

  // ── Analysis bookkeeping ──────────────────────────────────────────────────

  /** Key describing the exact audio a result was measured from. */
  function selectionKey() {
    if (!state.selection || !state.currentFile) return null
    const { start, end } = state.selection
    const ids = state.segments.map(s => s.sourceBufferId ?? 'silence').join(',')
    return `${start.toFixed(6)}:${end.toFixed(6)}:${ids}`
  }

  const isStale = computed(
    () => analysis.value !== null && analyzedKey.value !== selectionKey(),
  )

  const hasAnalysis = computed(() => analysis.value?.ok === true && !isStale.value)

  /**
   * The resolved region table.
   *
   * Before analysis there is no measured voice type, so role ranges fall back to
   * the male table. That only affects where a *manually* added role band is
   * allowed to sit — nothing is claimed about the speaker until Analyze has run,
   * and the UI does not display a voice type until then.
   */
  const regions = computed(() => analysis.value?.regions ?? MALE_REGIONS)

  /**
   * Suggestions are derived, never stored (spec §9.2).
   *
   * Recomputing them from the frozen analysis is what makes "switch to General
   * and back" free: there is no pending-suggestion state to discard or restore,
   * and nothing can go stale independently of the analysis it came from.
   */
  const suggestions = computed(() => {
    if (!hasAnalysis.value) return []
    const applied = new Set(
      bands.value.filter(b => b.origin === 'suggestion').map(b => b.role),
    )
    return buildSuggestions(analysis.value).filter(s => !applied.has(s.roleId))
  })

  // ── Live chain ────────────────────────────────────────────────────────────

  function initChain() {
    const ctx = getAudioContext()
    const chain = getEffectChain(ctx)
    if (!chain.effects.find(e => e.id === manualEqEffect.id)) {
      chain.addEffect(manualEqEffect)
    }
    return chain
  }

  function nodes() {
    const chain = getEffectChain(getAudioContext())
    return chain.effects.find(e => e.id === manualEqEffect.id)?.nodes ?? null
  }

  function soloIndex() {
    if (soloBandId.value === null) return null
    const i = bands.value.findIndex(b => b.id === soloBandId.value)
    return i === -1 ? null : i
  }

  /** Push the whole band list. Cheap enough that partial updates are not worth it. */
  function pushBands() {
    if (!eqPreview.value) return
    const chain = getEffectChain(getAudioContext())
    chain.updateParam(manualEqEffect.id, 'bands', currentBands())
    chain.updateParam(manualEqEffect.id, 'soloIndex', soloIndex())
    chain.updateParam(manualEqEffect.id, 'output', outputTrim.value)
  }

  function startMeters(chain) {
    stopMeters()
    function tick() {
      const n = chain.effects.find(e => e.id === manualEqEffect.id)?.nodes
      if (n) {
        inputDb.value = n.getInputLevelDb()
        outputDb.value = n.getOutputLevelDb()
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

  function togglePreview() {
    const chain = initChain()
    eqPreview.value = !eqPreview.value
    chain.setEnabled(manualEqEffect.id, eqPreview.value)

    if (eqPreview.value) {
      pushBands()
      startMeters(chain)
    } else {
      stopMeters()
    }
  }

  // ── Band editing ──────────────────────────────────────────────────────────

  const atBandLimit = computed(() => bands.value.length >= MAX_BANDS)

  function addBand(spec) {
    if (atBandLimit.value) {
      showToast(`EQ is limited to ${MAX_BANDS} bands`)
      return null
    }
    const band = createBand({ regions: regions.value, ...spec })
    bands.value = [...bands.value, band]
    pushBands()
    return band
  }

  function removeBand(id) {
    if (soloBandId.value === id) soloBandId.value = null
    bands.value = bands.value.filter(b => b.id !== id)
    pushBands()
  }

  function findBand(id) {
    return bands.value.find(b => b.id === id) ?? null
  }

  /**
   * Mutate a band and republish.
   *
   * The array identity changes on every edit so the plot's computed curve
   * re-runs; the band objects themselves are mutated in place so a drag does not
   * churn ids and lose the handle under the pointer.
   */
  function updateBand(id, mutate) {
    const band = findBand(id)
    if (!band) return
    mutate(band)
    bands.value = [...bands.value]
    pushBands()
  }

  function setFrequency(id, hz) {
    updateBand(id, b => setBandFrequency(b, hz))
  }

  function setGain(id, db) {
    updateBand(id, (b) => {
      b.gainDb = clamp(db, ...PARAM_RANGES.gainDb)
    })
  }

  function setQ(id, q) {
    updateBand(id, b => setBandQ(b, q))
  }

  function setType(id, type) {
    updateBand(id, (b) => {
      b.type = type
      b.q = clamp(b.q, ...qRangeFor(type))
      // A type change can take a role band outside what its role means, but the
      // role is defined by frequency, not shape — so only re-check the range.
      applyForfeiture(b)
    })
  }

  function toggleBand(id) {
    updateBand(id, (b) => {
      b.enabled = !b.enabled
    })
  }

  function resetQ(id) {
    updateBand(id, b => resetBandQ(b))
  }

  function retag(id) {
    const band = findBand(id)
    if (!band) return
    const roleId = candidateRoleFor(band, regions.value)
    if (!roleId) return
    updateBand(id, b => tagBand(b, roleId, regions.value))
  }

  function clearBands() {
    bands.value = []
    soloBandId.value = null
    pushBands()
  }

  // ── Solo and audition ─────────────────────────────────────────────────────

  function setSolo(id) {
    soloBandId.value = id
    pushBands()
  }

  function clearSolo() {
    soloBandId.value = null
    pushBands()
  }

  /**
   * Press-and-hold audition of a single suggestion (spec §9.5).
   *
   * Adds the band, mutes every other one, and hands back a restore function.
   * Implemented by toggling `enabled` rather than by rebuilding the pool so the
   * release path cannot lose a user's band — the highest-teaching-value
   * interaction in the tool is not worth risking the pool for.
   */
  function auditionSuggestion(suggestion) {
    if (bands.value.length >= MAX_BANDS) return () => {}
    const previous = bands.value.map(b => b.enabled)
    const band = suggestionToBand(suggestion, regions.value)

    bands.value = [...bands.value.map(b => ({ ...b, enabled: false })), band]
    pushBands()

    return function stop() {
      bands.value = bands.value
        .filter(b => b.id !== band.id)
        .map((b, i) => ({ ...b, enabled: previous[i] ?? b.enabled }))
      pushBands()
    }
  }

  function applySuggestion(suggestion) {
    if (atBandLimit.value) {
      showToast(`EQ is limited to ${MAX_BANDS} bands`)
      return
    }
    const role = getRole(suggestion.roleId)
    // One band per role: applying over an existing one replaces it rather than
    // stacking a second correction on the same region.
    const existing = suggestion.roleId ? bandForRole(bands.value, suggestion.roleId) : null
    const band = suggestionToBand(suggestion, regions.value)
    bands.value = existing
      ? bands.value.map(b => (b.id === existing.id ? band : b))
      : [...bands.value, band]
    revealRole(suggestion.roleId)
    pushBands()
    if (role) showToast(`${role.label}: ${suggestion.gainDb > 0 ? '+' : ''}${suggestion.gainDb} dB`)
  }

  function applyAllSuggestions() {
    for (const s of suggestions.value) {
      if (bands.value.length >= MAX_BANDS) break
      applySuggestion(s)
    }
  }

  // ── Role visibility ───────────────────────────────────────────────────────

  function revealRole(roleId) {
    if (roleId && !revealedRoles.value.includes(roleId)) {
      revealedRoles.value = [...revealedRoles.value, roleId]
    }
  }

  /**
   * Roles with a control on screen: the default-visible set, plus any role a
   * suggestion targets, plus any the user added by hand. Eight sliders at once
   * undercuts the sparseness that justifies the mode existing, so the rest stay
   * behind an explicit add.
   */
  const visibleRoles = computed(() => ROLES_IN_ORDER.filter(r =>
    r.defaultVisible
    || revealedRoles.value.includes(r.id)
    || bands.value.some(b => b.role === r.id)
    || suggestions.value.some(s => s.roleId === r.id)))

  const hiddenRoles = computed(() =>
    ROLES_IN_ORDER.filter(r => !visibleRoles.value.includes(r)))

  /** The gain of a role's band, or 0 where the role has no band yet. */
  function roleGain(roleId) {
    return bandForRole(bands.value, roleId)?.gainDb ?? 0
  }

  /**
   * Move a role's gain, creating the band on first touch.
   *
   * A role slider at 0 dB with no band behind it is the correct resting state:
   * an inert band in the pool would occupy one of the twelve slots and show up
   * in the "general bands active" count for no reason.
   */
  function setRoleGain(roleId, db) {
    const existing = bandForRole(bands.value, roleId)
    if (existing) {
      setGain(existing.id, db)
      return
    }
    if (db === 0) return
    const role = getRole(roleId)
    const range = analysis.value?.regionResults?.find(r => r.roleId === roleId)
    // Centre a fresh role band where the anomaly was measured if there is one,
    // otherwise at the geometric centre of the role's range.
    const [lo, hi] = range
      ? [range.scanLowHz, range.scanHighHz]
      : (regions.value[role.region] ?? [200, 400])
    addBand({
      role: roleId,
      frequencyHz: range?.centerHz ?? Math.sqrt(lo * hi),
      gainDb: db,
      origin: 'manual_voxdoc',
    })
  }

  // ── Analyze ───────────────────────────────────────────────────────────────

  /**
   * Widen a too-short selection symmetrically into the surrounding audio.
   *
   * Used for display and suggestion generation only — the EQ is still applied to
   * the user's actual selection. Reaching outside is honest as long as it is
   * labelled, and it is strictly better than the alternative, which is refusing
   * to analyse a phrase that happens to be short.
   */
  function widenedRange(start, end, duration) {
    const needed = ((MIN_VOICED_FRAMES * HOP_SIZE + FRAME_SIZE) / 44100) * 3
    if (end - start >= needed) return { start, end, widened: false }
    const grow = (needed - (end - start)) / 2
    const s = Math.max(0, start - grow)
    const e = Math.min(duration, end + grow)
    return { start: s, end: e, widened: s !== start || e !== end }
  }

  async function analyze() {
    if (!state.selection || !state.currentFile) return
    analyzing.value = true
    analysisError.value = null

    try {
      const { sampleRate, channels } = state.currentFile
      const sel = state.selection
      const range = widenedRange(sel.start, sel.end, getTimelineDuration(state.segments))

      const rendered = renderRegionToBuffer(
        state.segments, range.start, range.end, sampleRate, channels,
      )
      // Mono for analysis: the envelope is a single-channel measurement and a
      // stereo pair would otherwise be analysed as its left channel alone.
      const mono = rendered.length === 1 ? rendered[0] : mixToMono(rendered)

      const result = analyzeVoxDoc(mono, sampleRate)

      if (!result.ok) {
        analysis.value = null
        analyzedKey.value = null
        analysisError.value = result.reason
        return
      }

      analysis.value = result
      analyzedKey.value = selectionKey()
      analysisWidened.value = range.widened
      for (const b of result.bands) revealRole(b.roleId)
    } catch (err) {
      console.error('VoxDoc analysis failed:', err)
      analysisError.value = 'failed'
    } finally {
      analyzing.value = false
    }
  }

  function mixToMono(channelData) {
    const n = channelData[0].length
    const out = new Float32Array(n)
    for (const ch of channelData) for (let i = 0; i < n; i++) out[i] += ch[i]
    const scale = 1 / channelData.length
    for (let i = 0; i < n; i++) out[i] *= scale
    return out
  }

  // ── Mode ──────────────────────────────────────────────────────────────────

  /**
   * Switch view. Deliberately does nothing but set a string — see the governing
   * rule in eqBands.js. Any clamping, snapping or resetting added here would be
   * the bug spec §2.1 exists to prevent.
   */
  function setMode(next) {
    mode.value = next
  }

  // ── Apply ─────────────────────────────────────────────────────────────────

  async function apply() {
    if (!state.selection) return
    const { start, end } = state.selection

    const wasPreviewing = eqPreview.value
    if (wasPreviewing) togglePreview()
    clearSolo()

    startProcessing('Applying EQ...')
    try {
      const buffer = await applyManualEqRegion(
        state.segments, start, end,
        { bands: currentBands(), output: outputTrim.value },
        state.currentFile.sampleRate, state.currentFile.channels,
      )
      const bufferId = replaceRegion(start, end, buffer)
      const cache = await computePeakCache(buffer, 256)
      setPeakCache(bufferId, cache)
      showToast('EQ applied')
    } catch (err) {
      console.error('EQ failed:', err)
      showToast('EQ failed')
    } finally {
      endProcessing()
    }
  }

  function teardown() {
    stopMeters()
    if (eqPreview.value) {
      const chain = getEffectChain(getAudioContext())
      chain.setEnabled(manualEqEffect.id, false)
      eqPreview.value = false
    }
    soloBandId.value = null
  }

  function openModal(initialMode = 'general') {
    mode.value = initialMode
    openWindow(MANUAL_EQ_WINDOW_ID)
  }

  function closeModal() {
    closeWindow(MANUAL_EQ_WINDOW_ID)
  }

  return {
    // state
    bands, mode, eqPreview, outputTrim, soloBandId, showAnalyzer,
    inputDb, outputDb,
    analysis, analyzing, analysisError, analysisWidened, isStale, hasAnalysis,
    suggestions, regions, visibleRoles, hiddenRoles, atBandLimit,
    hasSelection,
    untagged: computed(() => untaggedBands(bands.value)),

    // chain
    togglePreview, pushBands, nodes, getSpectrum: () => nodes()?.getSpectrumDb() ?? null,

    // bands
    addBand, removeBand, findBand, setFrequency, setGain, setQ, setType,
    toggleBand, resetQ, retag, clearBands,
    setSolo, clearSolo,

    // voxdoc
    analyze, applySuggestion, applyAllSuggestions, auditionSuggestion,
    roleGain, setRoleGain, revealRole,

    // lifecycle
    setMode, apply, teardown, openModal, closeModal,
  }
}
