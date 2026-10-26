import { ref } from 'vue'
import { useEditorState } from './useEditorState.js'
import { renderTimelineForSave } from '../audio/export.js'
import {
  canSaveInPlace, isCancellation, pickSaveTarget, ensureWritePermission,
  writeWavToHandle, saveTargetKind, downloadWav,
} from '../audio/fileSave.js'
import { bitDepthById, savePlan, toSaveFileName } from '../audio/saveFormat.js'

/**
 * Save / Save As.
 *
 * Distinct from Export, and deliberately so. Export is the multi-file, zip-it-up
 * path. Save is the thing you hit every few minutes without thinking: once a
 * document has a destination, Save asks nothing, writes over that file in the
 * format it was last saved in, and says one word when it lands.
 *
 * The first Save on a document, and every Save As, opens the Save dialog
 * (`SaveDialog.vue`): name, bit depth and sample rate, pre-filled from the file
 * the document was opened from, with the location shown as that file's folder.
 * Confirming it either writes straight over the original (same name, a WAV —
 * `savePlan`'s 'replace') or opens the system save dialog already in that
 * folder with the name filled in, so the location is one click to confirm.
 */

// App-wide rather than per-component: the tab strip, the command bar and the
// keyboard handler all need to know a write is in flight, and two of them can
// be looking at the same document.
const isSaving = ref(false)

export function useFileSave() {
  const {
    getDocument, appState, showToast, renameDocument,
    markDocumentSaved, getSaveTarget, setSaveTarget,
    getSaveSettings, setSaveSettings, getSourceHandle,
  } = useEditorState()

  /**
   * The handle a Save is anchored to: the file last saved to, else the file
   * the document was opened from. The dialog opens beside it and a Save under
   * its name replaces it.
   */
  function anchorHandleFor(docId) {
    return getSaveTarget(docId) ?? getSourceHandle(docId) ?? null
  }

  /**
   * Render and write, assuming a destination is already settled.
   * @param {object} doc
   * @param {FileSystemFileHandle|null} handle null = download
   * @param {{ bitDepth: string, sampleRate: number, fileName: string }} settings
   * @returns {Promise<boolean>} whether the document is now on disk
   */
  async function writeTo(doc, handle, settings) {
    // Permission first, while the click that confirmed the Save still counts
    // as a user gesture — the render below can outlast it, and a permission
    // prompt raised after it is refused without being shown.
    if (handle) {
      try {
        if (!await ensureWritePermission(handle)) {
          showToast('Save needs permission to write that file')
          return false
        }
      } catch (err) {
        console.error(`Permission check failed for ${handle.name}:`, err)
        showToast(`Couldn't write ${handle.name ?? doc.name}`)
        return false
      }
    }

    // Yield: the render is synchronous and long enough on a full chapter to
    // swallow the frame that would have shown the button going busy.
    await new Promise(r => setTimeout(r, 0))

    const depth = bitDepthById(settings.bitDepth)
    let wav
    try {
      wav = renderTimelineForSave(doc.segments, doc.currentFile.sampleRate, doc.currentFile.channels, {
        bits: depth.bits, float: depth.float, sampleRate: settings.sampleRate,
      })
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
      const savedAs = toSaveFileName(settings.fileName)
      downloadWav(wav, savedAs)
      markDocumentSaved(doc.id)
      showToast(`Saved ${savedAs} to your downloads`)
      return true
    }

    try {
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

  /** Open the Save dialog for a document. */
  function saveDocumentAs(docId = appState.activeDocumentId) {
    const doc = getDocument(docId)
    if (!doc || isSaving.value) return false
    appState.saveDialog = { docId: doc.id }
    return true
  }

  /**
   * Carry out a Save the dialog confirmed. Must be called from the confirming
   * click: both the system save dialog and the write-permission prompt need
   * the user gesture, so nothing slow may run before them.
   *
   * @param {string} docId
   * @param {{ fileName: string, bitDepth: string, sampleRate: number,
   *           chosenHandle?: FileSystemFileHandle|null }} choice
   * @returns {Promise<boolean>} whether the document is now on disk
   */
  async function confirmSave(docId, { fileName, bitDepth, sampleRate, chosenHandle = null }) {
    const doc = getDocument(docId)
    if (!doc || isSaving.value) return false

    const anchor = anchorHandleFor(docId)
    const plan = savePlan({
      supportsInPlace: canSaveInPlace(), chosenHandle, anchorHandle: anchor, fileName,
    })

    let handle = null
    if (plan === 'chosen') handle = chosenHandle
    else if (plan === 'replace') handle = anchor
    else if (plan === 'pick') {
      try {
        handle = await pickSaveTarget(fileName, anchor)
      } catch (err) {
        // Cancelling a save dialog is an ordinary thing to do and needs no toast.
        if (isCancellation(err)) return false
        console.error('Save picker failed:', err)
        showToast("Couldn't open the save dialog")
        return false
      }
    }

    const settings = { bitDepth, sampleRate, fileName: handle?.name ?? toSaveFileName(fileName) }
    isSaving.value = true
    try {
      const ok = await writeTo(doc, handle, settings)
      if (!ok) return false
      // Adopt the destination only once something has actually been written to
      // it — a handle that failed its first write is not a place later Saves
      // should silently go.
      if (handle) setSaveTarget(doc.id, handle)
      setSaveSettings(doc.id, settings)
      // The tab now names the file on disk, which is the whole point of having
      // chosen a name. Renaming is not an edit, so it leaves the document clean.
      if (settings.fileName !== doc.name) renameDocument(doc.id, settings.fileName)
      return true
    } finally {
      isSaving.value = false
    }
  }

  /**
   * Save to the known destination in the remembered format, or open the Save
   * dialog when there isn't one yet.
   */
  async function saveDocument(docId = appState.activeDocumentId) {
    const doc = getDocument(docId)
    if (!doc || isSaving.value) return false

    const handle = getSaveTarget(doc.id)
    const settings = getSaveSettings(doc.id)
    const kind = saveTargetKind(handle)
    // A browser with no write API downloads every Save; once the dialog has
    // been through once, later Saves download silently with the same choices.
    const silent = settings && (kind === 'write' || kind === 'download')
    if (!silent) return saveDocumentAs(docId)

    isSaving.value = true
    try {
      return await writeTo(doc, kind === 'write' ? handle : null, settings)
    } finally {
      isSaving.value = false
    }
  }

  return { saveDocument, saveDocumentAs, confirmSave, anchorHandleFor, isSaving, canSaveInPlace }
}
