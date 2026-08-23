import { ref } from 'vue'
import { useEditorState } from './useEditorState.js'
import { renderTimelineToWav } from '../audio/export.js'
import {
  canSaveInPlace, isCancellation, pickSaveTarget, ensureWritePermission,
  writeWavToHandle, saveTargetKind, downloadWav,
} from '../audio/fileSave.js'

/**
 * Save / Save As.
 *
 * Distinct from Export, and deliberately so. Export is the multi-file,
 * choose-a-format, zip-it-up path — a decision. Save is the thing you hit every
 * few minutes without thinking, so it asks nothing, writes over the file you
 * already named, and says one word when it lands.
 *
 * The first Save on any document is a Save As, whether the file arrived by
 * drag-drop or the file picker. That is not a limitation of the drop path: it
 * is the rule for every document, because writing 16-bit WAV over someone's
 * source recording without showing them the filename first is data loss with a
 * keyboard shortcut in front of it. Once a destination exists, every later Save
 * goes straight to it.
 */

// App-wide rather than per-component: the tab strip, the command bar and the
// keyboard handler all need to know a write is in flight, and two of them can
// be looking at the same document.
const isSaving = ref(false)

export function useFileSave() {
  const {
    getDocument, appState, showToast, renameDocument,
    markDocumentSaved, getSaveTarget, setSaveTarget,
  } = useEditorState()

  /**
   * Render and write, assuming a destination is already settled.
   * @returns {Promise<boolean>} whether the document is now on disk
   */
  async function writeTo(doc, handle) {
    // Yield first: the render is synchronous and long enough on a full chapter
    // to swallow the frame that would have shown the button going busy.
    await new Promise(r => setTimeout(r, 0))

    let wav
    try {
      wav = renderTimelineToWav(
        doc.segments, doc.currentFile.sampleRate, doc.currentFile.channels
      )
    } catch (err) {
      console.error(`Failed to render ${doc.name}:`, err)
      showToast(`Couldn't save ${doc.name}`)
      return false
    }
    if (!wav) {
      showToast('Nothing to save — the timeline is empty')
      return false
    }

    if (!handle) {
      // No write API in this browser. The bytes still reach the disk, just via
      // the download folder and under whatever name it picks on a collision.
      downloadWav(wav, doc.name)
      markDocumentSaved(doc.id)
      showToast(`Saved ${doc.name} to your downloads`)
      return true
    }

    try {
      if (!await ensureWritePermission(handle)) {
        showToast('Save needs permission to write that file')
        return false
      }
      await writeWavToHandle(handle, wav)
    } catch (err) {
      console.error(`Failed to write ${doc.name}:`, err)
      showToast(`Couldn't write ${handle.name ?? doc.name}`)
      return false
    }

    markDocumentSaved(doc.id)
    showToast(`Saved ${handle.name ?? doc.name}`)
    return true
  }

  /**
   * Ask for a destination and write to it. Also the body of the first Save on
   * a document, which is why it is not just the Save As button's handler.
   */
  async function saveDocumentAs(docId = appState.activeDocumentId) {
    const doc = getDocument(docId)
    if (!doc || isSaving.value) return false

    if (!canSaveInPlace()) {
      isSaving.value = true
      try { return await writeTo(doc, null) } finally { isSaving.value = false }
    }

    let handle
    try {
      handle = await pickSaveTarget(doc.name)
    } catch (err) {
      // Cancelling a save dialog is an ordinary thing to do and needs no toast.
      if (isCancellation(err)) return false
      console.error('Save picker failed:', err)
      showToast("Couldn't open the save dialog")
      return false
    }

    isSaving.value = true
    try {
      const ok = await writeTo(doc, handle)
      if (!ok) return false
      // Adopt the destination only once something has actually been written to
      // it — a handle that failed its first write is not a place later Saves
      // should silently go.
      setSaveTarget(doc.id, handle)
      // The tab now names the file on disk, which is the whole point of having
      // chosen a name. Renaming is not an edit, so it leaves the document clean.
      if (handle.name) renameDocument(doc.id, handle.name)
      return true
    } finally {
      isSaving.value = false
    }
  }

  /**
   * Save to the known destination, or fall through to Save As when there
   * isn't one yet.
   */
  async function saveDocument(docId = appState.activeDocumentId) {
    const doc = getDocument(docId)
    if (!doc || isSaving.value) return false

    const handle = getSaveTarget(doc.id)
    if (saveTargetKind(handle) !== 'write') return saveDocumentAs(docId)

    isSaving.value = true
    try {
      return await writeTo(doc, handle)
    } finally {
      isSaving.value = false
    }
  }

  return { saveDocument, saveDocumentAs, isSaving, canSaveInPlace }
}
