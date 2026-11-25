import { nextTick, reactive } from 'vue'
import { useEditorState } from './useEditorState.js'
import { useWindows, CHAIN_WINDOW_ID } from './useWindows.js'
import { useEntitlements } from './useEntitlements.js'
import { chainApplying } from './usePluginChain.js'
import { loadChain } from './useChainPresets.js'
import { writePluginSettings } from './pluginSettings.js'
import { resolveOffer } from './shareOffer.js'
import { chainPlugins, getOperation } from '../ui/registry.js'
import {
  PLUGIN_CHAIN_PRESET_PLUGIN, canSaveUserPresets, listPresets, saveUserPreset,
} from '../audio/pluginPresets/index.js'
import { decodeShare, hashWithoutShare, shareCodeFromHash } from '../audio/shareLink.js'
import { listenIdFromSearch } from '../audio/shareRecord.js'
import { getShareApi } from './useShareListen.js'
import { useFileImport } from './useFileImport.js'
import { requestTogglePlayback } from '../ui/transportBus.js'

/**
 * Shared chain and preset links (audio/shareLink.js), both ends.
 *
 * Sending is the preset menus' "Copy link" (usePluginPresets.copyLink).
 *
 * Receiving: the editor reads `#share=…` once at start-up, and again on
 * `hashchange` (a link pasted into a tab already open does not reload it), takes
 * it out of the address bar, and offers what it carries on a card
 * (SharedLinkNotice.vue). Nothing loads until the card is clicked: loading a
 * chain REPLACES the rack, and a link is not the user's decision.
 *
 * A shared LISTEN (`/?listen=<id>`, the listen page's "Open in crisp.fm",
 * shareRecord.js) is offered the same way, as kind 'project': Load opens the
 * dry recording as a new file, selects it, puts its chain in the rack and
 * plays — the chain previewing live is the "after". The click is also the
 * gesture the AudioContext needs. The audio starts fetching at load.
 */

const state = reactive({
  /** The decoded payload being offered, with `opId` / `plugins` resolved for display. */
  offer: null,
  /** True while a link's code is being decoded. */
  reading: false,
  /** True while a shared recording is being opened. */
  loading: false,
})

let started = false

async function readHash() {
  if (typeof window === 'undefined') return
  const code = shareCodeFromHash(window.location.hash)
  if (!code) return
  const rest = hashWithoutShare(window.location.hash)
  window.history.replaceState(window.history.state, '', `${window.location.pathname}${window.location.search}${rest}`)
  state.reading = true
  try {
    const offer = resolveOffer(await decodeShare(code), {
      chainIds: chainPlugins().map(op => op.id),
      getOperation,
    })
    if (offer) state.offer = offer
    else useEditorState().showToast('That shared link could not be read, or holds nothing this version can load', 6000)
  } finally {
    state.reading = false
  }
}

let projectAudio = null // Promise<Blob> for the offered project's dry take

function fetchBlob(url) {
  const p = fetch(url).then((r) => {
    if (!r.ok) throw new Error(`${r.status}`)
    return r.blob()
  })
  p.catch(() => {})
  return p
}

async function readListen() {
  const id = listenIdFromSearch(window.location.search)
  const params = new URLSearchParams(window.location.search)
  if (!params.has('listen')) return
  params.delete('listen')
  const rest = params.toString()
  window.history.replaceState(window.history.state, '', `${window.location.pathname}${rest ? `?${rest}` : ''}${window.location.hash}`)
  const api = getShareApi()
  const fail = () => useEditorState().showToast('That shared recording could not be found — it may have been deleted', 6000)
  if (!id || !api) { fail(); return }
  state.reading = true
  try {
    const share = await api.get(id)
    if (!share) { fail(); return }
    projectAudio = fetchBlob(share.audio.off)
    const chain = resolveOffer({ v: 1, kind: 'chain', name: share.title, params: share.chain }, {
      chainIds: chainPlugins().map(op => op.id),
      getOperation,
    })
    state.offer = {
      kind: 'project',
      name: share.title,
      note: share.note,
      share,
      params: share.chain,
      plugins: chain?.plugins ?? [],
    }
  } catch (err) {
    console.error('Shared listen failed:', err)
    fail()
  } finally {
    state.reading = false
  }
}

function init() {
  if (started || typeof window === 'undefined') return
  started = true
  readListen()
  readHash()
  window.addEventListener('hashchange', readHash)
}

/** A free name for saving `name` into a collection, never overwriting one there. */
export function freePresetName(collectionId, name) {
  const taken = new Set(listPresets(collectionId).map(p => p.name.toLowerCase()))
  if (!taken.has(name.toLowerCase())) return name
  for (let n = 2; n < 100; n++) {
    const candidate = `${name} (${n})`
    if (!taken.has(candidate.toLowerCase())) return candidate
  }
  return `${name} (${Date.now()})`
}

export function useSharedLink() {
  init()
  const { showToast } = useEditorState()
  const { openWindow } = useWindows()
  const entitlements = useEntitlements()

  const { importFiles } = useFileImport()
  const { selectAll, getAudioContext } = useEditorState()

  /** A shared listen: the dry take as a new file, its chain in the rack, playing. */
  async function loadProject(offer) {
    if (chainApplying.value) {
      showToast('Wait for the chain to finish applying')
      return false
    }
    // Inside the click, before anything is awaited (Safari keeps a context
    // created later suspended).
    getAudioContext()
    state.loading = true
    try {
      projectAudio ??= fetchBlob(offer.share.audio.off)
      const blob = await projectAudio
      const safe = offer.name.replace(/[\\/:*?"<>|]+/g, ' ').trim() || 'Shared recording'
      const [docId] = await importFiles([new File([blob], `${safe}.mp3`, { type: 'audio/mpeg' })])
      if (!docId) throw new Error('the recording did not decode')
      selectAll()
      loadChain(offer.params)
      openWindow(CHAIN_WINDOW_ID)
      state.offer = null
      projectAudio = null
      await nextTick()
      setTimeout(requestTogglePlayback, 350)
      return true
    } catch (err) {
      console.error('Opening the shared recording failed:', err)
      projectAudio = null
      showToast('The shared recording could not be opened', 5000)
      return false
    } finally {
      state.loading = false
    }
  }

  /** Put the offer into effect: the rack for a chain, the plugin's knobs for a preset. */
  function load() {
    const offer = state.offer
    if (!offer) return false
    if (offer.kind === 'project') return loadProject(offer)
    if (offer.kind === 'chain') {
      if (chainApplying.value) {
        showToast('Wait for the chain to finish applying')
        return false
      }
      loadChain(offer.params)
      openWindow(CHAIN_WINDOW_ID)
    } else {
      if (!writePluginSettings(offer.opId, 'solo', offer.params)) {
        showToast('Those settings could not be loaded')
        return false
      }
      openWindow(offer.opId)
    }
    state.offer = null
    return true
  }

  const canSave = () => entitlements.can('savePresets') && canSaveUserPresets()

  /** Keep the offer in the user's own presets (or saved chains), under a free name. */
  function save() {
    const offer = state.offer
    if (!offer) return false
    if (!canSave()) {
      entitlements.request('savePresets')
      return false
    }
    const collection = offer.kind === 'preset' ? offer.preset : PLUGIN_CHAIN_PRESET_PLUGIN
    try {
      const saved = saveUserPreset(collection, freePresetName(collection, offer.name), offer.params)
      showToast(offer.kind !== 'preset'
        ? `Saved to your chains as “${saved.name}”`
        : `Saved to your ${offer.pluginLabel} presets as “${saved.name}”`)
      return true
    } catch (err) {
      showToast(err?.message ?? 'Could not save it', 5000)
      return false
    }
  }

  function dismiss() { state.offer = null }

  return { state, load, save, dismiss, canSave }
}
