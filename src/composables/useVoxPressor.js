import { ref, watch } from 'vue'
import { useEditorState, DocumentSwitchedError } from './useEditorState.js'
import { useWindows } from './useWindows.js'
import { registerChainPlugin } from './usePluginChain.js'
import { pluginCopies, effectForCopy, idForCopy } from './pluginCopies.js'
import {
  applyVoxPressorRegion, computeVoxPressorMeasure, computeVoxPressorExact, computePeakCache,
} from '../audio/processing.js'
import { analysedWholeRegion, regionAlignDb } from '../audio/analysisWindow.js'
import { getSegmentDuration } from '../audio/operations.js'
import { toKernelParams, VOX_MEASURED_KEYS } from '../audio/effects/voxPressorParams.js'
import { getEffectChain } from '../audio/effectChain.js'
import { voxPressorEffect as soloEffect, VOX_DEFAULTS } from '../audio/effects/voxPressor.js'
import { snapshotLevels } from '../audio/effects/levelTap.js'

// Registry id of this plugin's window. Must match the entry in src/ui/registry.js.
export const VOX_WINDOW_ID = 'vox-pressor'

/** Measured keys, pushed to the live node in this order — ceilings first. */
const MEASURED = VOX_MEASURED_KEYS

const copies = pluginCopies((copy, life) => {
  const effect = effectForCopy(soloEffect, copy)
  const windowId = idForCopy(VOX_WINDOW_ID, copy)

  const voxPeaks = ref(VOX_DEFAULTS.peaks)
  const voxBody = ref(VOX_DEFAULTS.body)
  const voxOutput = ref(VOX_DEFAULTS.output)
  const voxListen = ref(VOX_DEFAULTS.listen)
  /** BENCH: the LA-2A's lookahead, ms. Measured with, so it re-measures. */
  const voxBodyLookahead = ref(VOX_DEFAULTS.bodyLookaheadMs)
  /** The file's alignment (whole file, gated RMS), and which timeline it is for. */
  const voxAlignDb = ref(VOX_DEFAULTS.alignDb)
  let alignedFor = null

  /**
   * Everything `measureVoxPressor` measured. The kernel values ride in
   * `currentParams()` so preview and apply cannot disagree.
   */
  const voxMeasured = ref(Object.fromEntries(MEASURED.map(k => [k, VOX_DEFAULTS[k]])))
  /** The readouts: { peaksDb, peaksBodyDb, bodyDb } at the knobs measured, or null. */
  const voxReadout = ref(null)
  const voxBusy = ref(false)

  const voxPreview = ref(false)
  const voxPeaksGr = ref(0)
  const voxBodyGr = ref(0)
  const voxInputLevels = ref([])
  const voxOutputLevels = ref([])
  let meterId = null

  // The corner is a property of the material, not of the knobs: measured with
  // the first measurement on a region and handed back to every later one.
  let cornerFor = null
  /** Which (timeline, selection, knobs) the measured values belong to. */
  let solvedFor = null
  let inFlight = null

  const SOLVE_DEBOUNCE_MS = 120
  let solveTimer = null
  let solveSeq = 0
  let burstActive = false
  let burstDirty = false

  function currentParams() {
    return {
      peaks: voxPeaks.value,
      body: voxBody.value,
      output: voxOutput.value,
      listen: voxListen.value,
      bodyLookaheadMs: voxBodyLookahead.value,
      alignDb: voxAlignDb.value,
      ...voxMeasured.value,
    }
  }

  life.onDispose(() => {
    clearTimeout(solveTimer)
    solveTimer = null
    solveSeq++
  })

  let following = false

  function useVoxPressor() {
    const {
      state, appState, getAudioContext, replaceRegion, setPeakCache,
      startProcessing, endProcessing, pinActiveDocument, showToast, hasSelection, totalDuration,
    } = useEditorState()
    const { openWindow, closeWindow } = useWindows()

    function initChain() {
      const chain = getEffectChain(getAudioContext())
      if (!chain.effects.find(e => e.id === effect.id)) chain.addEffect(effect)
      return chain
    }

    function startMeters(chain) {
      stopMeters()
      function tick() {
        const nodes = chain.effects.find(e => e.id === effect.id)?.nodes
        if (nodes) {
          const r = nodes.getReductions()
          voxPeaksGr.value = r.peaks
          voxBodyGr.value = r.body
          const chCount = state.currentFile?.channels ?? 1
          voxInputLevels.value = snapshotLevels(nodes.getInputLevels(chCount))
          voxOutputLevels.value = snapshotLevels(nodes.getOutputLevels(chCount))
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
      voxPeaksGr.value = 0
      voxBodyGr.value = 0
      voxInputLevels.value = []
      voxOutputLevels.value = []
    }

    function pushParam(name, value) {
      if (!voxPreview.value) return
      getEffectChain(getAudioContext()).updateParam(effect.id, name, value)
    }

    function pushAllParams(chain) {
      for (const [name, value] of Object.entries(currentParams())) {
        chain.updateParam(effect.id, name, value)
      }
    }

    function togglePreview() {
      const chain = initChain()
      voxPreview.value = !voxPreview.value
      chain.setEnabled(effect.id, voxPreview.value)
      if (voxPreview.value) {
        pushAllParams(chain)
        startMeters(chain)
        refreshSolve()
      } else {
        stopMeters()
      }
    }

    function timelineKey(segments) {
      return segments === state.segments
        ? `${appState.activeDocumentId}:${state.revision}` : `${appState.activeDocumentId}:chain`
    }

    /**
     * The file's alignment, over the WHOLE timeline (LA Vintage 2A's and LA
     * Classic 76's contract: one operating point for the whole file, whatever
     * is selected). Synchronous and cheap, so the stages come out of bypass at
     * once; re-measured only when the timeline changes.
     */
    function ensureAlignment(segments) {
      const key = timelineKey(segments)
      if (alignedFor === key && segments === state.segments) return
      const end = segments === state.segments
        ? totalDuration.value
        : segments.reduce((t, seg) => Math.max(t, seg.outputStart + getSegmentDuration(seg)), 0)
      if (!(end > 0)) return
      const db = regionAlignDb(segments, 0, end, state.currentFile.sampleRate, state.currentFile.channels)
      alignedFor = key
      voxAlignDb.value = db
      pushParam('alignDb', db)
    }

    /** The key a measurement belongs to: the timeline, the region and every setting it reads. */
    function solveKey(segments, start, end) {
      return `${timelineKey(segments)}|${start}|${end}|${voxPeaks.value}|${voxBody.value}|${voxBodyLookahead.value}|${voxAlignDb.value}`
    }

    /**
     * Measure `[start, end)` of `segments` at the current knobs and store the
     * result. Superseded calls are discarded by sequence number, so a knob drag
     * cannot have an older measurement land after a newer one.
     */
    async function solve(segments, start, end) {
      ensureAlignment(segments)
      const seq = ++solveSeq
      const key = solveKey(segments, start, end)
      const regionKey = key.split('|').slice(0, 3).join('|')
      voxBusy.value = true
      try {
        const kp = toKernelParams(currentParams())
        if (cornerFor !== regionKey) delete kp.cornerHz
        const r = await computeVoxPressorMeasure(
          segments, start, end, kp, state.currentFile.sampleRate, state.currentFile.channels,
        )
        if (seq !== solveSeq) return false
        cornerFor = regionKey
        const next = {}
        for (const k of MEASURED) next[k] = r[k] ?? null
        voxMeasured.value = next
        for (const k of MEASURED) pushParam(k, next[k])
        voxReadout.value = { peaksDb: r.peaksDb, peaksBodyDb: r.peaksBodyDb, bodyDb: r.bodyDb }
        solvedFor = key
        return true
      } finally {
        if (seq === solveSeq) voxBusy.value = false
      }
    }

    /**
     * What the preview is measured for: the selection, or the whole file when
     * there is none.
     *
     * ⚠ THE WHOLE FILE FALLBACK IS NOT A NICETY. The first build solved only
     * for a selection, so a panel opened with nothing selected played through
     * an UNSOLVED kernel — see `toKernelParams` for what that sounded like.
     * Apply still needs a selection; this only decides what the preview hears.
     */
    function previewRegion() {
      if (state.selection) return state.selection
      const end = totalDuration.value
      return end > 0 ? { start: 0, end } : null
    }

    function refreshSolve() {
      if (!state.currentFile) return null
      ensureAlignment(state.segments)
      const region = previewRegion()
      if (!region) return null
      const { start, end } = region
      inFlight = solve(state.segments, start, end).catch((err) => {
        console.error('VoxPressor measurement failed:', err)
        return false
      })
      return inFlight
    }

    function scheduleSolve() {
      if (!burstActive) {
        burstActive = true
        burstDirty = false
        refreshSolve()
      } else {
        burstDirty = true
      }
      if (solveTimer !== null) clearTimeout(solveTimer)
      solveTimer = setTimeout(() => {
        solveTimer = null
        const trailing = burstDirty
        burstActive = false
        burstDirty = false
        if (trailing) refreshSolve()
      }, SOLVE_DEBOUNCE_MS)
    }

    function syncPeaks(v) {
      voxPeaks.value = v
      pushParam('peaks', v)
      scheduleSolve()
    }

    function syncBody(v) {
      voxBody.value = v
      pushParam('body', v)
      scheduleSolve()
    }

    function syncBodyLookahead(v) {
      voxBodyLookahead.value = v
      pushParam('bodyLookaheadMs', v)
      scheduleSolve()
    }

    function syncOutput(v) {
      voxOutput.value = v
      pushParam('output', v)
    }

    function syncListen(v) {
      voxListen.value = v
      pushParam('listen', v)
    }

    /**
     * Make sure the measured values belong to `segments` and the current
     * knobs before rendering: re-measure unless the last measurement is exactly this.
     */
    async function prepareApply(segments, start, end) {
      ensureAlignment(segments)
      if (solvedFor !== solveKey(segments, start, end) || segments !== state.segments) {
        await solve(segments, start, end)
      }
      /**
       * ⚠ EXACT RESTORES FOR A REGION LONGER THAN THE SOLVE'S WINDOW. Each
       * stage restores its peak to its ceiling, and the window's peak is only
       * a lower bound on the region's — so its restores are too generous and
       * would push the passage it never saw into the limiters. Re-measured over
       * the whole region at the makeups just measured.
       */
      if (!analysedWholeRegion(start, end)) {
        const exact = await computeVoxPressorExact(
          segments, start, end, toKernelParams(currentParams()),
          state.currentFile.sampleRate, state.currentFile.channels,
        )
        const next = { ...voxMeasured.value }
        for (const k of MEASURED) if (k in exact) next[k] = exact[k]
        voxMeasured.value = next
        for (const k of MEASURED) pushParam(k, next[k])
      }
    }

    function renderRegion(segments, start, end) {
      return applyVoxPressorRegion(
        segments, start, end, currentParams(),
        state.currentFile.sampleRate, state.currentFile.channels,
      )
    }

    async function apply() {
      if (!state.selection) return
      const { start, end } = state.selection
      const pin = pinActiveDocument('VoxPressor')
      const wasPreviewing = voxPreview.value
      startProcessing('Applying VoxPressor...', pin.docId)
      try {
        await prepareApply(state.segments, start, end)
        if (wasPreviewing) togglePreview()
        const buffer = await renderRegion(state.segments, start, end)
        pin.check()
        const bufferId = replaceRegion(start, end, buffer, 'VoxPressor', pin.docId)
        setPeakCache(bufferId, await computePeakCache(buffer, 256))
        showToast('VoxPressor applied')
      } catch (err) {
        console.error('VoxPressor failed:', err)
        showToast(err instanceof DocumentSwitchedError ? err.message : 'VoxPressor failed')
      } finally {
        endProcessing(pin.docId)
      }
    }

    function teardown() {
      stopMeters()
      if (voxListen.value !== 'off') syncListen('off')
    }

    if (!following) {
      following = true
      life.scope.run(() => {
        const { isOpen } = useWindows()
        watch(() => state.selection, () => {
          if (voxPreview.value || isOpen(windowId)) scheduleSolve()
        }, { deep: true })
        // A different file, or an edit to this one: the measurements describe
        // audio that is no longer there. Re-align at once (cheap), and drop the
        // makeups and ceilings — another file's makeup would lift this one by
        // several dB, and its ceiling would limit at the wrong peak — until the
        // new measurement lands.
        watch(() => `${appState.activeDocumentId}:${state.revision}`, () => {
          if (!(voxPreview.value || isOpen(windowId))) return
          const cleared = {
            peaksCeilingDb: null, bodyCeilingDb: null,
            peaksMakeupDb: 0, peaksRestoreDb: 0, bodyMakeupDb: 0, makeupDb: 0,
          }
          voxMeasured.value = { ...voxMeasured.value, ...cleared }
          for (const [k, v] of Object.entries(cleared)) pushParam(k, v)
          voxReadout.value = null
          solveSeq++
          if (state.currentFile) ensureAlignment(state.segments)
          scheduleSolve()
        })
      })
    }

    registerChainPlugin({
      id: effect.id,
      windowId,
      label: 'VoxPressor',
      dispose: life.dispose,
      isActive: () => voxPreview.value,
      setActive: (on) => { if (voxPreview.value !== on) togglePreview() },
      // Measured against the chain's running segments, never the document's.
      render: async (segments, start, end) => {
        await prepareApply(segments, start, end)
        return renderRegion(segments, start, end)
      },
      resume: () => startMeters(initChain()),
      suspend: teardown,
    })

    function openModal() {
      openWindow(windowId)
    }

    function closeModal() {
      closeWindow(windowId)
    }

    return {
      voxPeaks, voxBody, voxOutput, voxListen, voxBodyLookahead,
      voxMeasured, voxReadout, voxBusy,
      voxPreview, voxPeaksGr, voxBodyGr, voxInputLevels, voxOutputLevels,
      hasSelection,
      togglePreview, syncPeaks, syncBody, syncOutput, syncListen, syncBodyLookahead,
      refreshSolve, apply, teardown, openModal, closeModal,
    }
  }

  return useVoxPressor
})

/** The copy the calling window edits (the solo copy outside a plugin window). */
export function useVoxPressor() {
  return copies()()
}
