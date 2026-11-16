import { nextTick, reactive } from 'vue'
import { useEditorState } from './useEditorState.js'
import { useFileImport } from './useFileImport.js'
import { useWindows } from './useWindows.js'
import { pluginSettingsIO, writePluginSettings } from './pluginSettings.js'
import { handOffWindowSettings } from './windowHandoff.js'
import { tryOutFromSearch } from '../content/marketing/index.js'
import { DEV_TUNING_PANELS } from '../devFlags.js'

/**
 * "Try it on this clip": the marketing pages' link into the editor
 * (`/?try=<slug>&clip=<sample>`, built by `tryOutUrl`).
 *
 * On load the editor reads the link and starts fetching the sample's dry take,
 * and the empty state shows a card naming the effect and the clip. ONE click
 * on it opens the clip as a document, selects all of it, puts the sample's
 * settings into the effect, opens the effect's window (which engages its
 * preview, as it does for any user) and starts playback.
 *
 * ⚠ IT WAITS FOR THAT CLICK ON PURPOSE. The editor's rule is no AudioContext
 * before a user gesture — browsers start one suspended and refuse to play —
 * and arriving from a link is not a gesture. The click is, so it can also
 * start playback, which a page load could not. The fetch starts at load, so
 * the click usually has the audio in hand.
 *
 * The query is removed from the address bar once read, so a reload lands on an
 * ordinary editor rather than offering the same clip again.
 */

const state = reactive({
  /** The parsed link (`tryOutFromSearch`), or null. */
  offer: null,
  /** 'ready' | 'loading' | 'failed' */
  status: 'ready',
})

let fetched = null // Promise<Blob>
let started = false

/** Read the address bar once, at start-up. */
function init() {
  if (started || typeof window === 'undefined') return
  started = true
  const offer = tryOutFromSearch(window.location.search, DEV_TUNING_PANELS)
  const params = new URLSearchParams(window.location.search)
  if (params.has('try') || params.has('clip')) {
    params.delete('try')
    params.delete('clip')
    const rest = params.toString()
    window.history.replaceState(window.history.state, '', `${window.location.pathname}${rest ? `?${rest}` : ''}${window.location.hash}`)
  }
  if (!offer) return
  state.offer = offer
  fetched = fetchClip(offer)
}

/** Start fetching a sample's dry take. A failure is reported when the user clicks. */
function fetchClip(offer) {
  const p = fetch(offer.url).then((r) => {
    if (!r.ok) throw new Error(`${offer.url}: ${r.status}`)
    return r.blob()
  })
  // Keep an early failure from being "unhandled"; `start` awaits it and reports it.
  p.catch(() => {})
  return p
}

export function useTryOut() {
  init()
  const { selectAll, showToast } = useEditorState()
  const { importFiles } = useFileImport()
  const { openWindow } = useWindows()

  /** Load the clip, dial in the sample, open the effect and play. Call from a click. */
  async function start() {
    const offer = state.offer
    if (!offer || state.status === 'loading') return
    state.status = 'loading'
    try {
      // A fetch that failed is retried on the next click rather than awaited again.
      fetched ??= fetchClip(offer)
      const blob = await fetched
      const file = new File([blob], `${offer.sample.title} (${offer.title} demo).mp3`, { type: 'audio/mpeg' })
      const [docId] = await importFiles([file])
      if (!docId) throw new Error('the clip did not decode')
      selectAll()
      // The sample's settings over what the effect holds now (its defaults on a
      // fresh load), through the same writer a preset or a saved chain uses.
      const io = pluginSettingsIO(offer.windowId, 'solo')
      if (io) writePluginSettings(offer.windowId, 'solo', { ...io.read(), ...offer.sample.settings })
      // A window with no chain settings (Loudness Normalize) takes them on mount.
      else if (Object.keys(offer.sample.settings ?? {}).length) {
        handOffWindowSettings(offer.windowId, offer.sample.settings)
      }
      openWindow(offer.windowId)
      state.offer = null
      // Let the window mount and engage its preview before the transport starts.
      await nextTick()
      setTimeout(() => window.dispatchEvent(new CustomEvent('wavely:toggle-play')), 350)
    } catch (err) {
      console.error('Try-out clip failed:', err)
      fetched = null
      state.status = 'failed'
      showToast('The demo clip could not be loaded')
    } finally {
      if (state.status === 'loading') state.status = 'ready'
    }
  }

  function dismiss() {
    state.offer = null
  }

  return { tryOut: state, start, dismiss }
}
