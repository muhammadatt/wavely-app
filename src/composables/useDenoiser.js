import { computed, ref, shallowRef, watch } from 'vue'
import { useEditorState, DocumentSwitchedError } from './useEditorState.js'
import { useWindows } from './useWindows.js'
import {
  registerChainPlugin, renderUpstream, upstreamDefs, upstreamSignature,
} from './usePluginChain.js'
import { pluginCopies, effectForCopy, idForCopy } from './pluginCopies.js'
import {
  applyDenoiserRegion, learnNoiseProfileRegion, computePeakCache, NOISE_PROFILE_MAX_S,
} from '../audio/processing.js'
import { getEffectChain } from '../audio/effectChain.js'
import { denoiserEffect as soloDenoiserEffect, DENOISER_DEFAULTS } from '../audio/effects/denoiser.js'
import { snapshotLevels } from '../audio/effects/levelTap.js'
import {
  DENOISE_DISPLAY_BANDS, binPowerToDb, displayBandMap, powerToBandsDb,
} from '../audio/dsp/spectralDenoise.js'

// Registry id of this plugin's window. Must match the entry in src/ui/registry.js.
export const DENOISER_WINDOW_ID = 'spectral-denoise'

/**
 * Under this gap between the speech level and the learned noise, the "pauses"
 * the auto profile found probably held voice too — say so rather than let the
 * user wonder why the voice got thinner. Reasoned, not measured.
 */
export const PROFILE_GAP_WARN_DB = 12

/**
 * Spectral Denoise (prototype): a noise-profile MMSE-LSA denoiser that runs
 * entirely in the browser — no server call, no account.
 *
 * The profile is learned automatically from the whole file's quietest frames
 * the first time the plugin is turned on for a document ('auto'), or from the
 * selection when the user marks it as room tone ('selection'). It is kept per
 * document, so switching tabs does not denoise one file with another's noise.
 *
 * IN THE CHAIN, A SLOT LEARNS FROM WHAT REACHES IT, the way a DAW insert's
 * Learn hears whatever the plugins ahead of it produce: the learn spans are
 * rendered through the live slots ahead of it first (usePluginChain's
 * renderUpstream — the same renders the chain's Apply runs), then learned. The
 * profile is then FROZEN: preview and Apply both use it, so what is heard is
 * what is written. A signature of those upstream slots (order, ON / BYPASS,
 * settings) is stored with it; when it no longer matches, the status says the
 * profile is out of date and offers to learn again — nothing re-learns behind
 * the user's back, and Apply still uses the stored profile (a DAW renders with
 * the profile it holds). The solo copy has nothing ahead of it and learns from
 * the file.
 */
const copies = pluginCopies((copy, life) => {
  const effect = effectForCopy(soloDenoiserEffect, copy)
  const windowId = idForCopy(DENOISER_WINDOW_ID, copy)

  const reduction = ref(DENOISER_DEFAULTS.reduction)
  const threshold = ref(DENOISER_DEFAULTS.threshold)
  const smoothing = ref(DENOISER_DEFAULTS.smoothing)

  const engaged = ref(false)
  const delta = ref(false)
  const learning = ref(false)
  /** While learning through the slots ahead: 'LA Vintage 2A (1/2)' etc., else ''. */
  const learningStep = ref('')

  /** docId → { profile: Float32Array, info } */
  const profiles = new Map()
  /** The active document's profile, or null. */
  const profile = shallowRef(null)
  // { source, noiseDb, speechDb, gapDb, frames, seconds, sampleRate,
  //   upstream (signature at learn time), upstreamLabels }
  const profileInfo = ref(null)

  const inputLevels = ref([])
  const outputLevels = ref([])
  const reductionDb = ref(0)
  /** Live spectra on the display grid, dB (sine-equivalent per bin). */
  const inBandsDb = shallowRef(new Float32Array(DENOISE_DISPLAY_BANDS).fill(-120))
  const outBandsDb = shallowRef(new Float32Array(DENOISE_DISPLAY_BANDS).fill(-120))
  let meterId = null
  let lastSeq = -1
  let following = false

  function useDenoiser() {
    const {
      state, appState, getAudioContext, hasSelection, replaceRegion, setPeakCache,
      startProcessing, endProcessing, pinActiveDocument, showToast,
    } = useEditorState()
    const { openWindow, closeWindow } = useWindows()

    function currentParams() {
      return {
        profile: profile.value,
        reduction: reduction.value,
        threshold: threshold.value,
        smoothing: smoothing.value,
      }
    }

    /** The learned profile drawn on the display grid, dB — with Threshold added, as the kernel uses it. */
    const profileBandsDb = computed(() => {
      const p = profile.value
      const sr = profileInfo.value?.sampleRate
      if (!p || !sr) return null
      const out = new Float32Array(DENOISE_DISPLAY_BANDS)
      powerToBandsDb(p, displayBandMap(sr), out)
      for (let b = 0; b < out.length; b++) out[b] += threshold.value
      return out
    })

    /**
     * Where the profile stands, as structured state; the panel words it.
     * 'learning' | 'none' | 'stale' (the slots ahead changed since it was
     * learned) | 'weak' (little gap between noise and speech) | 'ok'
     */
    const profileStatus = computed(() => {
      if (learning.value) return { kind: 'learning', step: learningStep.value }
      const info = profileInfo.value
      if (!info) return { kind: 'none' }
      if ((info.upstream ?? '') !== upstreamSignature(effect.id)) return { kind: 'stale', ...info }
      if (info.source === 'auto' && info.gapDb < PROFILE_GAP_WARN_DB) return { kind: 'weak', ...info }
      return { kind: 'ok', ...info }
    })

    function syncActiveProfile() {
      const entry = profiles.get(appState.activeDocumentId) ?? null
      if (profile.value !== (entry?.profile ?? null)) {
        profile.value = entry?.profile ?? null
        profileInfo.value = entry?.info ?? null
        pushParam('profile', profile.value)
      }
    }

    function initChain() {
      const chain = getEffectChain(getAudioContext())
      if (!chain.effects.find(e => e.id === effect.id)) chain.addEffect(effect)
      return chain
    }

    const nodesOf = chain => chain.effects.find(e => e.id === effect.id)?.nodes

    function startMeters(chain) {
      stopMeters()
      function tick() {
        const nodes = nodesOf(chain)
        if (nodes) {
          const chCount = state.currentFile?.channels ?? 1
          inputLevels.value = snapshotLevels(nodes.getInputLevels(chCount))
          outputLevels.value = snapshotLevels(nodes.getOutputLevels(chCount))
          const m = nodes.getMeter()
          if (m.seq !== lastSeq) {
            lastSeq = m.seq
            reductionDb.value = m.reductionDb
            const a = new Float32Array(DENOISE_DISPLAY_BANDS)
            const b = new Float32Array(DENOISE_DISPLAY_BANDS)
            for (let i = 0; i < a.length; i++) {
              a[i] = binPowerToDb(m.inBands[i])
              b[i] = binPowerToDb(m.outBands[i])
            }
            inBandsDb.value = a
            outBandsDb.value = b
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
      inputLevels.value = []
      outputLevels.value = []
      reductionDb.value = 0
    }

    function pushParam(name, value) {
      if (!engaged.value) return
      getEffectChain(getAudioContext()).updateParam(effect.id, name, value)
    }

    function pushAllParams(chain) {
      for (const [name, value] of Object.entries(currentParams())) chain.updateParam(effect.id, name, value)
    }

    function toggleEngaged() {
      const chain = initChain()
      engaged.value = !engaged.value
      chain.setEnabled(effect.id, engaged.value)
      if (engaged.value) {
        syncActiveProfile()
        pushAllParams(chain)
        startMeters(chain)
        // First time on for this file: learn from the whole file's pauses.
        // A tick later: the chain switches a new slot ON before it puts it in
        // the rack (usePluginChain's addDef), and learning now would hear none
        // of the slots ahead of it.
        setTimeout(() => {
          if (engaged.value && !profile.value && !learning.value) learn('auto')
        }, 0)
      } else {
        if (delta.value) toggleDelta()
        stopMeters()
      }
    }

    function toggleDelta() {
      delta.value = !delta.value
      const nodes = engaged.value ? nodesOf(getEffectChain(getAudioContext())) : null
      nodes?.setDelta(delta.value)
      if (!engaged.value) delta.value = false
    }

    function setReduction(v) { reduction.value = v; pushParam('reduction', v) }
    function setThreshold(v) { threshold.value = v; pushParam('threshold', v) }
    function setSmoothing(v) { smoothing.value = v; pushParam('smoothing', v) }

    /**
     * Learn the noise profile. 'auto': the whole file's quietest frames.
     * 'selection': every frame of the selection, which the user says is room tone.
     */
    async function learn(source = 'auto') {
      if (!state.currentFile || learning.value) return
      const docId = appState.activeDocumentId
      const { sampleRate, channels } = state.currentFile
      let start = 0
      let end = state.currentFile.duration
      if (source === 'selection') {
        if (!state.selection) return
        ;({ start, end } = state.selection)
      }
      // What reaches this slot, read BEFORE the render: a knob turned upstream
      // while it runs then shows the profile as out of date, as it is.
      const upstream = upstreamSignature(effect.id)
      const upstreamLabels = upstreamDefs(effect.id).map(d => d.label)
      const segments = state.segments
      learning.value = true
      learningStep.value = ''
      try {
        const result = await learnNoiseProfileRegion(
          segments, start, end, sampleRate, channels,
          {
            mode: source === 'selection' ? 'all' : 'auto',
            renderSpan: upstreamLabels.length === 0 ? null : (a, b, i, n) => renderUpstream(
              effect.id, segments, a, b,
              (k, m, label) => { learningStep.value = n > 1 ? `${label} · ${i + 1}/${n}` : label },
            ),
          },
        )
        if (!result.ok) {
          showToast(result.reason === 'too-short'
            ? 'Too little audio to learn the noise — select at least half a second'
            : 'Nothing but silence there to learn from')
          return
        }
        const info = {
          source,
          noiseDb: result.noiseDb,
          speechDb: result.speechDb,
          gapDb: result.gapDb,
          frames: result.frames,
          seconds: Math.min(end - start, NOISE_PROFILE_MAX_S),
          sampleRate,
          upstream,
          upstreamLabels,
        }
        // Learned through the slots ahead, the renders read the ACTIVE file's
        // rate and channels as they ran: a switch away mid-learn makes the
        // result a mixture, so it is dropped (the next turn-on learns again).
        if (upstreamLabels.length > 0 && appState.activeDocumentId !== docId) return
        profiles.set(docId, { profile: result.profile, info })
        // The user may have switched tabs while it ran: only show it if it is theirs.
        if (appState.activeDocumentId === docId) {
          profile.value = result.profile
          profileInfo.value = info
          pushParam('profile', result.profile)
        }
      } catch (err) {
        console.error('Noise profile learning failed:', err)
        showToast('Could not learn the noise profile')
      } finally {
        learning.value = false
        learningStep.value = ''
      }
    }

    function renderRegion(segments, start, end) {
      return applyDenoiserRegion(
        segments, start, end, currentParams(),
        state.currentFile.sampleRate, state.currentFile.channels,
      )
    }

    async function apply() {
      if (!state.selection) return false
      if (!profile.value) {
        await learn('auto')
        if (!profile.value) return false
      }
      const { start, end } = state.selection
      const pin = pinActiveDocument('Spectral Denoise')
      const wasEngaged = engaged.value
      if (wasEngaged) toggleEngaged()

      startProcessing('Removing noise...', pin.docId)
      try {
        const buffer = await renderRegion(state.segments, start, end)
        pin.check()
        const bufferId = replaceRegion(start, end, buffer, 'spectral denoise', pin.docId, pin.selection)
        setPeakCache(bufferId, await computePeakCache(buffer, 256))
        showToast('Noise reduced')
        return true
      } catch (err) {
        console.error('Spectral Denoise failed:', err)
        showToast(err instanceof DocumentSwitchedError ? err.message : 'Spectral Denoise failed')
        if (wasEngaged && !engaged.value) toggleEngaged()
        return false
      } finally {
        endProcessing(pin.docId)
      }
    }

    function teardown() {
      stopMeters()
    }

    // A tab switch brings that file's own profile (or none — learned on the
    // next turn-on). Installed once per copy, in the copy's own scope.
    if (!following) {
      following = true
      life.scope.run(() => {
        watch(() => appState.activeDocumentId, () => {
          syncActiveProfile()
          if (engaged.value && !profile.value) learn('auto')
        })
      })
      life.onDispose(() => profiles.clear())
    }

    registerChainPlugin({
      id: effect.id,
      windowId,
      label: 'Spectral Denoise',
      dispose: life.dispose,
      isActive: () => engaged.value,
      setActive: (on) => { if (engaged.value !== on) toggleEngaged() },
      render: renderRegion,
      resume: () => { syncActiveProfile(); startMeters(initChain()) },
      suspend: teardown,
      // The chain's Apply renders with the stored profile; it cannot learn one
      // mid-render, since learning hears the slots ahead, which are rendering.
      unavailable: () => (learning.value ? 'still learning the noise'
        : profile.value ? '' : 'learn the noise first'),
    })

    return {
      reduction, threshold, smoothing,
      engaged, delta, learning, learningStep,
      profile, profileInfo, profileStatus, profileBandsDb,
      inputLevels, outputLevels, reductionDb, inBandsDb, outBandsDb,
      hasSelection,
      toggleEngaged, toggleDelta, setReduction, setThreshold, setSmoothing,
      learn, apply, teardown,
      openModal: () => openWindow(windowId),
      closeModal: () => closeWindow(windowId),
    }
  }

  return useDenoiser
})

/** The copy the calling window edits (the solo copy outside a plugin window), or `copy` when named. */
export function useDenoiser(copy) {
  return copies(copy)()
}

/** The copies of this plugin built so far, without building any (see perFilePluginSettings.js). */
useDenoiser.builtCopies = () => copies.built()
