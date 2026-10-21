import { computed, ref, watch } from 'vue'
import { useEditorState, DocumentSwitchedError } from './useEditorState.js'
import { useWindows } from './useWindows.js'
import { registerChainPlugin } from './usePluginChain.js'
import { pluginCopies, effectForCopy, idForCopy } from './pluginCopies.js'
import { applyHFSoftenerRegion, computePeakCache, measureHFSoftenerAutoAir } from '../audio/processing.js'
import { regionAlignDb } from '../audio/analysisWindow.js'
import { ALIGN_TARGET_DBFS } from '../audio/dsp/inputAlign.js'
import { levelOffsetDbFor } from '../audio/deEsserProcessor.js'
import { getEffectChain, getEffectChainIfExists } from '../audio/effectChain.js'
import { hfSoftenerEffect as soloHfSoftenerEffect, HF_SOFTENER_DEFAULTS } from '../audio/effects/deEsser.js'
import { splitAmount, amountSplitOf } from '../audio/deEsserParams.js'
import { snapshotLevels } from '../audio/effects/levelTap.js'

// Registry id of this plugin's window. Must match the entry in src/ui/registry.js.
export const HF_SOFTENER_WINDOW_ID = 'hf-softener'

/**
 * One copy of the plugin — the solo copy or the chain's (pluginCopies.js). Each
 * has its own state, its own node in the EffectChain and its own window.
 */
const copies = pluginCopies((copy, life) => {
  const hfSoftenerEffect = effectForCopy(soloHfSoftenerEffect, copy)
  const windowId = idForCopy(HF_SOFTENER_WINDOW_ID, copy)

  // Reactive state shared by every caller of this copy.
  const hfAmount = ref(HF_SOFTENER_DEFAULTS.amount)
  // Lisp guard strength, 0–100 % (0 = off), and the two Advanced controls.
  const hfGuard = ref(HF_SOFTENER_DEFAULTS.guard)
  const hfPlosives = ref(HF_SOFTENER_DEFAULTS.plosives)
  const hfBand = ref(HF_SOFTENER_DEFAULTS.band)
  // The band-limited ResoTame ahead of the softener — an A/B of the pairing,
  // with fixed settings (see deEsserResoStage.js).
  const hfResoAmount = ref(HF_SOFTENER_DEFAULTS.resoAmount)
  // Soften: the onset softener at the end of the chain (deEsserSoftenStage.js),
  // on the panel in the slot Reso's knob had.
  const hfSoften = ref(HF_SOFTENER_DEFAULTS.soften)
  // Air makeup: Air Boost's curve after the cut — ONE value, the knob's. While AUTO
  // (`hfComp`) is on the measurement writes it (a fraction of the top end the
  // chain removes, deEsserAutoAir.js); touching the knob takes over.
  const hfAir = ref(HF_SOFTENER_DEFAULTS.air)
  const hfComp = ref(HF_SOFTENER_DEFAULTS.comp)
  const hfAirLossDb = ref(null)
  let autoAirTimer = null
  let autoAirSeq = 0
  // The detector's high-pass corner, Hz: raise it when bright vowels trip the cut.
  const hfDetect = ref(HF_SOFTENER_DEFAULTS.detect)
  const hfDetectHigh = ref(HF_SOFTENER_DEFAULTS.detectHigh)
  // VOICED: the lift follows the voicing, so it brightens vowels without
  // handing the cut back to the sibilants. STATIC: Air Boost's behaviour.
  const hfAirMode = ref(HF_SOFTENER_DEFAULTS.airMode)
  // How the reduction is taken: 0 all as the band cut, 100 all as a broadband duck.
  const hfDuck = ref(HF_SOFTENER_DEFAULTS.duck)
  // AMOUNT and SPLIT are a view over Duck (wide band) and EQ (split band), not a
  // third control: duck = amount x (1 - split), eq = amount x split, so the two
  // stages always share the Amount. Duck and EQ stay the state and what presets
  // store; the Split is remembered here because it cannot be read back from a
  // pair that is 0 / 0.
  const hfSplit = ref(amountSplitOf(HF_SOFTENER_DEFAULTS.duck, HF_SOFTENER_DEFAULTS.amount).split)
  const hfTotal = computed(() => amountSplitOf(hfDuck.value, hfAmount.value).total)
  const hfBroadband = ref(0)
  // The file's gated RMS and the offset it puts on every detector level. A
  // property of the audio, measured, never a user setting.
  const hfFileLevelDb = ref(null)
  const hfLevelOffset = ref(0)
  let levelMeasuredFor = null
  // DELTA monitor: hear only what is being removed. Never part of the params
  // the apply path renders with.
  const hfDelta = ref(false)
  // AUDITION monitor: hear only what the detector hears (its band). Same rule as
  // DELTA, and the two are exclusive — one monitor tap at a time.
  const hfAudition = ref(false)
  const listenMode = () => (hfAudition.value ? 'sidechain' : hfDelta.value ? 'delta' : 'off')
  const hfPreview = ref(false)
  const hfReduction = ref(0)
  // The Reso stage's reduction and the two lamps, read with the other meters.
  const hfReso = ref(0)
  const hfSoftenCut = ref(0)
  const hfBurstLamp = ref(0)
  const hfAirLamp = ref(0)
  const hfThresholdLift = ref(0)
  const hfInputLevels = ref([])
  const hfOutputLevels = ref([])
  let meterId = null

  function currentParams() {
    return {
      amount: hfAmount.value,
      // Pinned after listening, and off the panel: Context at 50 %, the rotator
      // on the detector only, a 40 ms release, and the fast release as each
      // vowel starts. The kernel keeps all four switchable for the bench and the
      // tests.
      context: HF_SOFTENER_DEFAULTS.context,
      rotator: HF_SOFTENER_DEFAULTS.rotator,
      release: HF_SOFTENER_DEFAULTS.release,
      vowelRelease: HF_SOFTENER_DEFAULTS.vowelRelease,
      shape: HF_SOFTENER_DEFAULTS.shape, // pinned
      guard: hfGuard.value,
      plosives: hfPlosives.value,
      band: hfBand.value,
      resoAmount: hfResoAmount.value,
      soften: hfSoften.value,
      air: hfAir.value,
      comp: hfComp.value,
      airMode: hfAirMode.value,
      duck: hfDuck.value,
      detect: hfDetect.value,
      detectHigh: hfDetectHigh.value,
      levelOffset: hfLevelOffset.value,
    }
  }

  // A chain copy whose slot is removed is disposed (pluginCopies.js): nothing
  // it scheduled may run on, and a pass still in flight must land nowhere.
  life.onDispose(() => {
    clearTimeout(autoAirTimer)
    autoAirTimer = null
    autoAirSeq++
  })

  // Whether this copy's file-following watchers are installed (see below).
  let following = false

  function useDeEsser() {
    const {
      state, appState, getAudioContext, hasSelection, replaceRegion, setPeakCache,
      startProcessing, endProcessing, pinActiveDocument, showToast, totalDuration,
    } = useEditorState()
    const { openWindow, closeWindow } = useWindows()

    function initChain() {
      const ctx = getAudioContext()
      const chain = getEffectChain(ctx)
      if (!chain.effects.find(e => e.id === hfSoftenerEffect.id)) {
        chain.addEffect(hfSoftenerEffect)
      }
      return chain
    }

    function nodesOf(chain) {
      return chain.effects.find(e => e.id === hfSoftenerEffect.id)?.nodes
    }

    function startMeters(chain) {
      stopMeters()
      function tick() {
        const nodes = nodesOf(chain)
        if (nodes) {
          const chCount = state.currentFile?.channels ?? 1
          hfInputLevels.value = snapshotLevels(nodes.getInputLevels(chCount))
          hfOutputLevels.value = snapshotLevels(nodes.getOutputLevels(chCount))
          hfReduction.value = nodes.getReduction()
          hfThresholdLift.value = nodes.getThresholdLift()
          hfBroadband.value = nodes.getBroadband?.() ?? 0
          hfReso.value = nodes.getReso?.() ?? 0
          hfSoftenCut.value = nodes.getSoften?.() ?? 0
          const lamps = nodes.getLamps?.()
          hfBurstLamp.value = lamps?.burst ?? 0
          hfAirLamp.value = lamps?.air ?? 0
        }
        meterId = requestAnimationFrame(tick)
      }
      meterId = requestAnimationFrame(tick)
    }

    /**
     * The activity scope's ring and the input spectrum tap, or null while the
     * effect is not in the chain. Functions, not refs: canvases read them every
     * frame, and typed arrays have no business going through reactivity.
     */
    function getScope() {
      if (!hfPreview.value) return null
      return nodesOf(getEffectChain(getAudioContext()))?.getScope?.() ?? null
    }

    /** Freeze the scope while the transport is stopped; see the effect wrapper. */
    function holdScope(on) {
      if (!hfPreview.value) return
      nodesOf(getEffectChain(getAudioContext()))?.holdScope?.(on)
    }

    function clearScope() {
      if (!hfPreview.value) return
      nodesOf(getEffectChain(getAudioContext()))?.clearScope?.()
    }

    function getInputSpectrum() {
      if (!hfPreview.value) return null
      return nodesOf(getEffectChain(getAudioContext()))?.getInputSpectrum?.() ?? null
    }

    function stopMeters() {
      if (meterId !== null) {
        cancelAnimationFrame(meterId)
        meterId = null
      }
      hfInputLevels.value = []
      hfOutputLevels.value = []
      hfReduction.value = 0
      hfThresholdLift.value = 0
      hfBroadband.value = 0
      hfReso.value = 0
      hfSoftenCut.value = 0
      hfBurstLamp.value = 0
      hfAirLamp.value = 0
    }

    function pushAllParams(chain) {
      for (const [name, value] of Object.entries(currentParams())) {
        chain.updateParam(hfSoftenerEffect.id, name, value)
      }
    }

    /**
     * Measure the file's level and move every detector threshold with it, so an
     * Amount setting means the same thing on a quiet recording and a hot one.
     *
     * ⚠ THE WHOLE FILE, NEVER THE SELECTION — the same rule OptoSmooth's input
     * alignment follows (see `regionAlignDb`). Measured per selection, a phrase
     * and the paragraph containing it would get different thresholds, and the
     * same edit applied twice would disagree with itself. Same gated-RMS
     * statistic too, so the two plugins read one number for one file.
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
      // regionAlignDb answers "how far below the alignment target", so the
      // gated level itself is the target minus that.
      const gated = ALIGN_TARGET_DBFS - regionAlignDb(
        segments, 0, end, state.currentFile.sampleRate, state.currentFile.channels,
      )
      levelMeasuredFor = key
      hfFileLevelDb.value = gated
      hfLevelOffset.value = levelOffsetDbFor(gated)
      pushParam('levelOffset', hfLevelOffset.value)
      scheduleAutoAir()
    }

    /**
     * Measure the chain's top-end loss and, while AUTO is on, set the Air knob from it.
     * Over the selection (the usual capped window), since that is what apply
     * will render; the whole file when nothing is selected. Stale answers — a
     * newer request went out, or AUTO was dropped meanwhile — are discarded.
     */
    async function refreshAutoAir(segments = state.segments) {
      if (!state.currentFile || !hfComp.value) return
      const sel = state.selection
      const start = sel ? sel.start : 0
      const end = sel ? sel.end : totalDuration.value
      if (!(end > start)) return
      const seq = ++autoAirSeq
      try {
        const { lossDb, airDb } = await measureHFSoftenerAutoAir(
          segments, start, end, currentParams(),
          state.currentFile.sampleRate, state.currentFile.channels,
        )
        if (seq !== autoAirSeq || !hfComp.value) return
        hfAirLossDb.value = lossDb
        // AUTO owns the knob: the measurement IS its value.
        hfAir.value = airDb
        pushParam('air', airDb)
      } catch (err) {
        console.error('HF Softener auto Air failed:', err)
      }
    }

    /** Re-measure shortly after the last change: every control that moves the cut moves the answer. */
    function scheduleAutoAir() {
      if (!hfComp.value) return
      clearTimeout(autoAirTimer)
      autoAirTimer = setTimeout(refreshAutoAir, 250)
    }

    /** The AUTO pill. On: the measurement takes the knob. Off: the knob keeps what it holds. */
    function syncComp(on) {
      if (!on) {
        disableAuto()
        return
      }
      hfComp.value = true
      pushParam('comp', true)
      scheduleAutoAir()
    }

    function togglePreview() {
      const chain = initChain()
      hfPreview.value = !hfPreview.value
      chain.setEnabled(hfSoftenerEffect.id, hfPreview.value)

      if (hfPreview.value) {
        refreshLevel()
        pushAllParams(chain)
        scheduleAutoAir()
        nodesOf(chain)?.setListen(listenMode())
        startMeters(chain)
      } else {
        // Bypassed, there is nothing to hear in the delta.
        hfDelta.value = false
        hfAudition.value = false
        stopMeters()
      }
    }

    function pushParam(name, value) {
      if (!hfPreview.value) return
      const chain = getEffectChain(getAudioContext())
      chain.updateParam(hfSoftenerEffect.id, name, value)
    }

    function syncAmount(v) {
      hfAmount.value = v
      pushParam('amount', v)
      scheduleAutoAir()
    }

    function syncDuck(v) {
      hfDuck.value = v
      pushParam('duck', v)
      scheduleAutoAir()
    }

    function syncAirMode(v) {
      hfAirMode.value = v
      pushParam('airMode', v)
    }

    /**
     * The Air knob. Touching it while AUTO is on takes over: AUTO drops, and any
     * measurement still in flight is discarded so it cannot land afterwards and
     * move a knob the user now owns. The value stays where they put it.
     */
    function syncAir(v) {
      if (hfComp.value) disableAuto()
      hfAir.value = v
      pushParam('air', v)
    }

    function disableAuto() {
      hfComp.value = false
      autoAirSeq++
      clearTimeout(autoAirTimer)
      pushParam('comp', false)
    }

    function syncDetect(v) {
      hfDetect.value = v
      pushParam('detect', v)
      scheduleAutoAir()
    }

    function syncDetectHigh(v) {
      hfDetectHigh.value = v
      pushParam('detectHigh', v)
      scheduleAutoAir()
    }

    function syncResoAmount(v) {
      hfResoAmount.value = v
      pushParam('resoAmount', v)
      scheduleAutoAir()
    }

    // Soften acts on onsets only, so it does not move AUTO's measurement.
    function syncSoften(v) {
      hfSoften.value = v
      pushParam('soften', v)
    }

    function syncGuard(v) {
      hfGuard.value = v
      pushParam('guard', v)
      scheduleAutoAir()
    }

    function syncPlosives(v) {
      hfPlosives.value = v
      pushParam('plosives', v)
      scheduleAutoAir()
    }

    function syncBand(v) {
      hfBand.value = v
      pushParam('band', v)
      scheduleAutoAir()
    }

    /** Spread an Amount over the two stages by the Split (the % that goes to the EQ). */
    function spread(total, split) {
      const { duck, amount } = splitAmount(total, split)
      syncDuck(duck)
      syncAmount(amount)
    }

    function syncTotal(v) {
      spread(v, hfSplit.value)
    }

    function syncSplit(v) {
      hfSplit.value = v
      spread(hfTotal.value, v)
    }

    /**
     * A preset's controls, through the same paths a knob turn takes. The Air
     * Mode is pinned (VOICED) and the measured values (AUTO's measured figure, the
     * file's level) are not preset params, so neither arrives here.
     */
    function applyParams(p) {
      const set = (key, ref, sync) => { if (p[key] !== undefined && p[key] !== ref.value) sync(p[key]) }
      set('duck', hfDuck, syncDuck)
      set('amount', hfAmount, syncAmount)
      set('guard', hfGuard, syncGuard)
      set('plosives', hfPlosives, syncPlosives)
      set('band', hfBand, syncBand)
      set('detect', hfDetect, syncDetect)
      set('detectHigh', hfDetectHigh, syncDetectHigh)
      // AUTO first: when it is on the measurement owns the Air, and a preset's
      // stored value must not take the knob over.
      set('comp', hfComp, syncComp)
      if (!hfComp.value) set('air', hfAir, syncAir)
      set('soften', hfSoften, syncSoften)
      // The Split follows what the preset put in the two stages (kept when both are 0).
      const { split } = amountSplitOf(hfDuck.value, hfAmount.value)
      if (split !== null) hfSplit.value = split
    }

    function toggleDelta() {
      if (!hfPreview.value) return
      hfDelta.value = !hfDelta.value
      if (hfDelta.value) hfAudition.value = false
      nodesOf(getEffectChain(getAudioContext()))?.setListen(listenMode())
    }

    function toggleAudition() {
      if (!hfPreview.value) return
      hfAudition.value = !hfAudition.value
      if (hfAudition.value) hfDelta.value = false
      nodesOf(getEffectChain(getAudioContext()))?.setListen(listenMode())
    }

    /** What apply re-measures first, so it renders with exact rather than live values. */
    async function prepareApply(segments = state.segments) {
      refreshLevel(segments)
      // With AUTO on, render with the Air measured for exactly these settings, not
      // whatever a debounced request last left on the knob.
      if (hfComp.value) {
        clearTimeout(autoAirTimer)
        await refreshAutoAir(segments)
      }
    }

    /** Render [start, end) of `segments` with the current settings, uncommitted. */
    function renderRegion(segments, start, end) {
      return applyHFSoftenerRegion(
        segments, start, end,
        currentParams(),
        state.currentFile.sampleRate, state.currentFile.channels,
      )
    }

    async function apply() {
      if (!state.selection) return
      const { start, end } = state.selection
      // Pinned to the document Apply was pressed on: tabs stay usable while it
      // renders, and `state` follows the active one (pinActiveDocument).
      const pin = pinActiveDocument('De-Esser')

      const wasPreviewing = hfPreview.value
      if (wasPreviewing) togglePreview()
      await prepareApply()

      startProcessing('Applying HF Softener...', pin.docId)
      try {
        const buffer = await renderRegion(state.segments, start, end)
        pin.check()
        const bufferId = replaceRegion(start, end, buffer, 'HF Softener', pin.docId)
        const cache = await computePeakCache(buffer, 256)
        setPeakCache(bufferId, cache)
        showToast('HF Softener applied')
      } catch (err) {
        console.error('HF Softener failed:', err)
        showToast(err instanceof DocumentSwitchedError ? err.message : 'HF Softener failed')
      } finally {
        endProcessing(pin.docId)
      }
    }

    function teardown() {
      stopMeters()
      // Delta is a monitoring aid; never leave the chain auditioning it after
      // the window closes.
      hfDelta.value = false
      hfAudition.value = false
      const chain = getEffectChainIfExists()
      if (chain) nodesOf(chain)?.setListen('off')
    }

    // The measurements that follow the selection and the file run for as long
    // as this copy can be HEARD, not only while its window is open: a chain
    // slot keeps playing with its window closed, and its preview would
    // otherwise keep the last selection's numbers. Installed once per copy,
    // in the copy's own scope, so they stop when a removed slot is disposed.
    if (!following) {
      following = true
      life.scope.run(() => {
        const { appState } = useEditorState()
        watch(() => state.selection, () => {
          if (hfPreview.value) scheduleAutoAir()
        }, { deep: true })
        watch(() => [state.revision, appState.activeDocumentId], () => {
          if (hfPreview.value) refreshLevel()
        })
      })
    }

    registerChainPlugin({
      id: hfSoftenerEffect.id,
      windowId,
      label: 'HF Softener',
      dispose: life.dispose,
      isActive: () => hfPreview.value,
      setActive: (on) => { if (hfPreview.value !== on) togglePreview() },
      render: async (segments, start, end) => {
        await prepareApply(segments)
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
      hfAmount,
      hfResoAmount,
      hfSoften,
      hfSoftenCut,
      hfAir,
      hfComp,
      hfAirLossDb,
      hfDetect,
      hfDetectHigh,
      hfAudition,
      hfAirMode,
      hfDuck,
      hfBroadband,
      hfSplit,
      hfTotal,
      hfGuard,
      hfPlosives,
      hfBand,
      hfFileLevelDb,
      hfLevelOffset,
      hfDelta,
      hfPreview,
      hfReduction,
      hfReso,
      hfBurstLamp,
      hfAirLamp,
      getScope,
      holdScope,
      clearScope,
      getInputSpectrum,
      hfThresholdLift,
      hfInputLevels,
      hfOutputLevels,
      hasSelection,
      togglePreview,
      syncAmount,
      syncResoAmount,
      syncSoften,
      syncAir,
      syncComp,
      syncDetect,
      syncDetectHigh,
      refreshAutoAir,
      scheduleAutoAir,
      syncAirMode,
      syncDuck,
      syncTotal,
      syncSplit,
      syncGuard,
      syncPlosives,
      syncBand,
      applyParams,
      toggleDelta,
      toggleAudition,
      refreshLevel,
      apply,
      teardown,
      openModal,
      closeModal,
    }
  }

  return useDeEsser
})

/** The copy the calling window edits (the solo copy outside a plugin window). */
export function useDeEsser() {
  return copies()()
}
