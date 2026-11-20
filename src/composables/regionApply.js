import { useEditorState, DocumentSwitchedError } from './useEditorState.js'
import { computePeakCache } from '../audio/processing.js'

/**
 * Render a region and commit it as one undo step — the shape every simple
 * apply shares (Peak / Loudness Normalize, Volume, Fade), written once so each
 * one gets the document pin right.
 *
 * In order:
 *   1. refuse while this file is already processing (one apply at a time: a
 *      second would render from the uncommitted timeline);
 *   2. PIN the document (`pinActiveDocument`) — tabs stay usable while a
 *      render runs, and the editor's defaults follow the active tab;
 *   3. render, from the timeline as it is NOW (read before the first await);
 *   4. compute the new buffer's peak cache;
 *   5. `pin.check()` — refuse, with a toast, if the user switched files or the
 *      file was edited meanwhile; nothing is committed;
 *   6. commit: replace the region, recording the selection the apply ran on.
 *
 * `render({ segments, start, end, ctx, sampleRate, channels })` resolves
 * `{ buffer, ...anything }`; the whole object comes back on success, null on
 * refusal or failure (which has already been reported).
 *
 * @param {object} o
 * @param {string} o.what    sentence subject for refusals ("The fade in")
 * @param {string} o.label   the undo step's label ("the fade in")
 * @param {string} o.busy    the processing overlay's message
 * @param {number} o.start
 * @param {number} o.end
 * @param {(r: object) => Promise<{ buffer: AudioBuffer }>} o.render
 * @param {string | ((err: Error) => string)} [o.failed]  the toast on an error
 * @param {object} [deps]  the editor and peak-cache functions (tests pass fakes)
 */
export async function applyToRegion(
  { what, label, busy, start, end, render, failed },
  deps = defaultDeps(),
) {
  const { editor, peakCache } = deps
  const { state } = editor
  if (!(end > start) || !state.currentFile) return null
  if (editor.editBlockedByProcessing()) return null

  const pin = editor.pinActiveDocument(what)
  editor.startProcessing(busy, pin.docId)
  try {
    const { sampleRate, channels } = state.currentFile
    const out = await render({
      segments: state.segments, start, end, ctx: editor.getAudioContext(), sampleRate, channels,
    })
    const cache = await peakCache(out.buffer, 256)
    pin.check()
    const bufferId = editor.replaceRegion(start, end, out.buffer, label, pin.docId, pin.selection)
    editor.setPeakCache(bufferId, cache)
    return out
  } catch (err) {
    console.error(`${what} failed:`, err)
    editor.showToast(err instanceof DocumentSwitchedError
      ? err.message
      : (typeof failed === 'function' ? failed(err) : failed) ?? `${what} failed`)
    return null
  } finally {
    editor.endProcessing(pin.docId)
  }
}

function defaultDeps() {
  return { editor: useEditorState(), peakCache: computePeakCache }
}
