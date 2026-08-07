import { ref, computed } from 'vue'
import { useEditorState } from './useEditorState.js'
import { useWindows } from './useWindows.js'
import { applyManualEqRegion, computePeakCache } from '../audio/processing.js'
import { getEffectChain } from '../audio/effectChain.js'
import {
  MAX_BANDS, createBand, applyForfeiture, setBandFrequency, setBandQ,
  resetBandQ, isBandActive, PARAM_RANGES, clamp, qRangeFor, clampBandToRole,
} from '../audio/eqBands.js'

/**
 * One EQ: a band pool, a live biquad cascade, and an apply.
 *
 * EQ and VoiceRx were built as two views onto a single pool, on the reasoning
 * that a user shaping tone in one place and correcting problems in the other is
 * really doing one job to one signal. In use it did not hold up: role bands and
 * hand-placed bands sat in the same list looking alike and behaving
 * differently, and switching views left you looking at a control surface that
 * described only some of what you were hearing. They are two plugins now, each
 * calling this factory, each owning its own pool and its own node in the chain.
 *
 * What is left of the old design is the one-way hand-off — VoiceRx can pass its
 * corrections to the EQ. Only that direction, and only as a move, so a given
 * correction exists in exactly one pool and can never be applied twice.
 *
 * Everything role-, analysis- and suggestion-shaped lives in useVoiceRx.js;
 * nothing here knows what a role is.
 */
export function createEqInstance({
  effect, windowId, label, maxBands = MAX_BANDS, frequencyPolicy = 'forfeit',
}) {
  // Module-scope-per-instance: created once at import, shared by every caller
  // of the owning composable, exactly as the single pool used to be.
  const bands = ref([])
  const eqPreview = ref(false)
  const outputTrim = ref(0)
  const soloBandId = ref(null)
  /**
   * A region being auditioned that has no band — `{ type, frequencyHz, q }`.
   *
   * Solo is a monitoring state, not an edit, so wanting to hear a region should
   * not have to mint a band to hang the monitor filter on. An inert 0 dB band
   * left behind by an audition would occupy a pool slot, show up in the band
   * count and need cleaning up on exit; a probe is discarded by clearing it.
   * Mutually exclusive with soloBandId — setting either clears the other.
   */
  const soloProbe = ref(null)
  const inputDb = ref(-Infinity)
  const outputDb = ref(-Infinity)

  let meterId = null

  function use() {
    const {
      state, getAudioContext, replaceRegion, setPeakCache, hasSelection,
      startProcessing, endProcessing, showToast,
    } = useEditorState()
    const { openWindow, closeWindow } = useWindows()

    // ── Live chain ──────────────────────────────────────────────────────────

    function initChain() {
      const ctx = getAudioContext()
      const chain = getEffectChain(ctx)
      if (!chain.effects.find(e => e.id === effect.id)) chain.addEffect(effect)
      return chain
    }

    function nodes() {
      const chain = getEffectChain(getAudioContext())
      return chain.effects.find(e => e.id === effect.id)?.nodes ?? null
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
      chain.updateParam(effect.id, 'bands', bands.value)
      chain.updateParam(effect.id, 'soloIndex', soloIndex())
      chain.updateParam(effect.id, 'soloProbe', soloProbe.value)
      chain.updateParam(effect.id, 'output', outputTrim.value)
    }

    function startMeters(chain) {
      stopMeters()
      function tick() {
        const n = chain.effects.find(e => e.id === effect.id)?.nodes
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
      chain.setEnabled(effect.id, eqPreview.value)

      if (eqPreview.value) {
        pushBands()
        startMeters(chain)
      } else {
        stopMeters()
      }
    }

    function setPreview(on) {
      if (eqPreview.value !== on) togglePreview()
    }

    // ── Band editing ────────────────────────────────────────────────────────

    const atBandLimit = computed(() => bands.value.length >= maxBands)

    function addBand(spec) {
      if (atBandLimit.value) {
        showToast(`${label} holds ${maxBands} bands — remove one to add another`)
        return null
      }
      const band = createBand(spec)
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
     * re-runs; the band objects themselves are mutated in place so a drag does
     * not churn ids and lose the handle under the pointer.
     */
    function updateBand(id, mutate) {
      const band = findBand(id)
      if (!band) return
      mutate(band)
      bands.value = [...bands.value]
      pushBands()
    }

    /**
     * Move a band along the axis, under the pool's own policy.
     *
     * 'forfeit' lets a band leave its role and drops the tag; 'clamp' holds it
     * inside. See clampBandToRole for why the same gesture should do opposite
     * things in the two plugins.
     */
    function setFrequency(id, hz) {
      updateBand(id, b => (frequencyPolicy === 'clamp'
        ? clampBandToRole(b, hz)
        : setBandFrequency(b, hz)))
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
        // A type change can take a role band outside what its role means, but
        // the role is defined by frequency, not shape — so only re-check range.
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

    function clearBands() {
      bands.value = []
      soloBandId.value = null
      soloProbe.value = null
      pushBands()
    }

    /** Drop bands straight in, keeping the pool's invariants. Used by the hand-off. */
    function adoptBands(specs) {
      const room = maxBands - bands.value.length
      const taken = specs.slice(0, Math.max(0, room))
      bands.value = [...bands.value, ...taken.map(s => createBand(s))]
      pushBands()
      return { added: taken.length, dropped: specs.length - taken.length }
    }

    // ── Solo ────────────────────────────────────────────────────────────────

    function setSolo(id) {
      soloBandId.value = id
      soloProbe.value = null
      pushBands()
    }

    /** Audition a region with no band behind it. `{ type, frequencyHz, q }`. */
    function setSoloProbe(probe) {
      soloProbe.value = probe
      soloBandId.value = null
      pushBands()
    }

    function clearSolo() {
      soloBandId.value = null
      soloProbe.value = null
      pushBands()
    }

    // ── Apply ───────────────────────────────────────────────────────────────

    async function apply() {
      if (!state.selection) return
      const { start, end } = state.selection

      const wasPreviewing = eqPreview.value
      if (wasPreviewing) togglePreview()
      clearSolo()

      startProcessing(`Applying ${label}...`)
      try {
        const buffer = await applyManualEqRegion(
          state.segments, start, end,
          { bands: bands.value, output: outputTrim.value },
          state.currentFile.sampleRate, state.currentFile.channels,
        )
        const bufferId = replaceRegion(start, end, buffer)
        const cache = await computePeakCache(buffer, 256)
        setPeakCache(bufferId, cache)
        showToast(`${label} applied`)
      } catch (err) {
        console.error(`${label} failed:`, err)
        showToast(`${label} failed`)
      } finally {
        endProcessing()
      }
    }

    function teardown() {
      stopMeters()
      if (eqPreview.value) {
        const chain = getEffectChain(getAudioContext())
        chain.setEnabled(effect.id, false)
        eqPreview.value = false
      }
      soloBandId.value = null
      soloProbe.value = null
    }

    return {
      // state
      bands, eqPreview, outputTrim, soloBandId, soloProbe, inputDb, outputDb,
      hasSelection, atBandLimit, maxBands,
      activeBands: computed(() => bands.value.filter(isBandActive)),

      // chain
      togglePreview, setPreview, pushBands, nodes,
      getSpectrum: () => nodes()?.getSpectrumDb() ?? null,

      // bands
      addBand, removeBand, findBand, updateBand, setFrequency, setGain, setQ,
      setType, toggleBand, resetQ, clearBands, adoptBands,
      setSolo, setSoloProbe, clearSolo,

      // lifecycle
      apply, teardown,
      openModal: () => openWindow(windowId),
      closeModal: () => closeWindow(windowId),

      // for the owning composable
      showToast, state,
    }
  }

  return { use, bands, eqPreview, soloBandId, soloProbe }
}
