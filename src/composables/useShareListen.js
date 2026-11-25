import { reactive } from 'vue'
import { useEditorState, DocumentSwitchedError } from './useEditorState.js'
import { usePluginChain } from './usePluginChain.js'
import { captureChain } from './useChainPresets.js'
import { useEntitlements } from './useEntitlements.js'
import { AUTH_ENABLED, SUPABASE_URL, SUPABASE_KEY } from '../auth/config.js'
import { getSupabase } from '../auth/supabaseClient.js'
import { createShareApi } from '../api/shares.js'
import { renderRegionToBuffer } from '../audio/processing.js'
import { getTimelineDuration } from '../audio/operations.js'
import { encodeInWorker } from '../audio/export.js'
import {
  SHARE_MAX_SECONDS, SHARE_MP3_BITRATE, cleanShareText, defaultShareTitle,
  gatedRmsDb, listenUrl, shareMp3Rate,
} from '../audio/shareRecord.js'

/**
 * Share a before / after: the selection (or the whole file) as it is, and the
 * same span through the live Plugin Chain, both MP3, with the chain itself —
 * a listen page at `/s/<id>` (src/listen/) that plays the two in lock-step and
 * opens the recording with its chain in the editor.
 *
 * The "after" is rendered exactly as the chain's Apply renders it
 * (`renderLive`), and nothing is committed: the file is not touched. Storage
 * and its rules: supabase/migrations/20261125000000_shares.sql.
 *
 * ⚠ THE CHAIN MUST BE ON. After an Apply the chain is bypassed and the audio
 * already holds its processing, so sharing then would put processed audio on
 * both sides; the dialog says to Undo the Apply first.
 */

const state = reactive({
  open: false,
  /** '' | 'render' | 'encode' | 'record' | 'upload' | 'finish' */
  stage: '',
  busy: false,
  error: '',
  /** The last share made in this dialog: { id, url, title } */
  made: null,
  /** The user's shares, when listed: [{ id, title, seconds, createdAt, url }] */
  mine: null,
  mineError: '',
})

let api = null
function shareApi() {
  if (!AUTH_ENABLED) return null
  api ??= createShareApi(getSupabase(SUPABASE_URL, SUPABASE_KEY))
  return api
}

/** Shares read by anyone (the editor's `?listen=`), with or without a session. */
export function getShareApi() {
  return shareApi()
}

const STAGE_TEXT = {
  render: 'Rendering the chain…',
  encode: 'Encoding…',
  record: 'Creating the share…',
  upload: 'Uploading…',
  finish: 'Finishing…',
}

export function useShareListen() {
  const { state: editor, showToast, pinActiveDocument } = useEditorState()
  const chain = usePluginChain()
  const entitlements = useEntitlements()

  /** The span a share would hold: the selection, or the whole file. */
  function span() {
    if (!editor.currentFile) return null
    if (editor.selection) return { start: editor.selection.start, end: editor.selection.end, whole: false }
    return { start: 0, end: getTimelineDuration(editor.segments), whole: true }
  }

  /** Why a share can't be made now, or ''. */
  function blocker() {
    if (!AUTH_ENABLED) return 'Sharing is not available in this version'
    const s = span()
    if (!s || s.end <= s.start) return 'Open a file first'
    if (s.end - s.start > SHARE_MAX_SECONDS + 1e-6) {
      return `Shares hold up to ${SHARE_MAX_SECONDS / 60} minutes — select a shorter part`
    }
    const why = chain.renderBlocker('share')
    if (why === 'Turn the chain on to share it') {
      return 'Turn the chain on to share it. If you already applied it, Undo the Apply first, so the share starts from the original.'
    }
    return why
  }

  function open() {
    if (!AUTH_ENABLED) return
    state.open = true
    state.error = ''
    state.made = null
    state.stage = ''
  }

  function close() {
    if (state.busy) return
    state.open = false
  }

  const defaultTitle = () => defaultShareTitle(editor.currentFile?.name)

  /** Render, encode, upload. Resolves to the share's URL, or null. */
  async function create({ title, note }) {
    if (state.busy) return null
    const why = blocker()
    if (why) { state.error = why; return null }
    if (!entitlements.request('shareListen')) return null
    const text = cleanShareText(title || defaultTitle(), note)
    const { start, end } = span()
    const pin = pinActiveDocument('The share')
    const rate = editor.currentFile.sampleRate
    const channels = editor.currentFile.channels
    const slots = chain.slots.value
    // The chain as it stands when Share is pressed: what the "after" renders.
    const chainParams = JSON.parse(JSON.stringify(captureChain(slots)))

    state.busy = true
    state.error = ''
    state.made = null
    try {
      state.stage = 'render'
      const dry = renderRegionToBuffer(editor.segments, start, end, rate, channels)
      const rendered = await chain.renderLive(start, end, { check: () => pin.check() })
      pin.check()
      const n = Math.min(dry[0].length, rendered.length)
      const off = dry.map(ch => ch.slice(0, n))
      const on = Array.from({ length: channels }, (_, c) => rendered.getChannelData(Math.min(c, rendered.numberOfChannels - 1)).slice(0, n))
      const levelDb = { off: gatedRmsDb(off, rate), on: gatedRmsDb(on, rate) }

      state.stage = 'encode'
      const settings = { format: 'mp3', bitrate: SHARE_MP3_BITRATE, sampleRate: shareMp3Rate(rate), bitDepth: '16' }
      const [offMp3, onMp3] = await Promise.all([
        encodeInWorker(off, rate, settings),
        encodeInWorker(on, rate, settings),
      ])

      const id = await shareApi().create({
        ...text,
        chain: chainParams,
        seconds: n / rate,
        levelDb,
        off: new Blob([offMp3.bytes], { type: 'audio/mpeg' }),
        on: new Blob([onMp3.bytes], { type: 'audio/mpeg' }),
      }, { onStage: (s) => { state.stage = s } })

      const url = listenUrl(id, window.location.origin)
      state.made = { id, url, title: text.title }
      if (state.mine) listMine()
      return url
    } catch (err) {
      console.error('Share failed:', err)
      state.error = err instanceof DocumentSwitchedError ? err.message : (err?.message || 'The share could not be made')
      return null
    } finally {
      state.busy = false
      state.stage = ''
    }
  }

  async function listMine() {
    state.mineError = ''
    try {
      const rows = await shareApi().listOwn()
      state.mine = rows.filter(r => r.ready).map(r => ({ ...r, url: listenUrl(r.id, window.location.origin) }))
    } catch (err) {
      state.mineError = err?.message || 'Could not list your shares'
    }
  }

  async function remove(id) {
    try {
      await shareApi().remove(id)
      if (state.mine) state.mine = state.mine.filter(r => r.id !== id)
      if (state.made?.id === id) state.made = null
      showToast('Share deleted — its link no longer works')
    } catch (err) {
      showToast(err?.message || 'Could not delete the share', 5000)
    }
  }

  async function copy(url) {
    try {
      await navigator.clipboard.writeText(url)
      showToast('Link copied')
    } catch {
      window.prompt('Copy this link:', url)
    }
  }

  return {
    state, span, blocker, open, close, create, listMine, remove, copy, defaultTitle,
    stageText: () => STAGE_TEXT[state.stage] ?? '',
    available: AUTH_ENABLED,
  }
}
