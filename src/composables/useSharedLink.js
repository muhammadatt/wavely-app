import { reactive } from 'vue'
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
 */

const state = reactive({
  /** The decoded payload being offered, with `opId` / `plugins` resolved for display. */
  offer: null,
  /** True while a link's code is being decoded. */
  reading: false,
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

function init() {
  if (started || typeof window === 'undefined') return
  started = true
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

  /** Put the offer into effect: the rack for a chain, the plugin's knobs for a preset. */
  function load() {
    const offer = state.offer
    if (!offer) return false
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
    const collection = offer.kind === 'chain' ? PLUGIN_CHAIN_PRESET_PLUGIN : offer.preset
    try {
      const saved = saveUserPreset(collection, freePresetName(collection, offer.name), offer.params)
      showToast(offer.kind === 'chain'
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
