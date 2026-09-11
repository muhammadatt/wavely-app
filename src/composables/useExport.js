import { ref } from 'vue'
import { useEditorState } from './useEditorState.js'
import { renderTimelineToWav } from '../audio/export.js'
import { downloadBlob } from '../audio/download.js'
import { createZip } from '../audio/zip.js'
import {
  estimatedBytes, totalBytes, formatSize, overZipLimit, uniqueNames,
} from '../audio/exportPlan.js'

/**
 * Export: render the chosen documents to WAV and hand them over, one file or a
 * zip of many.
 *
 * This lives in a composable because export is now reachable from two surfaces
 * — the export dialog and the files panel — and they have to behave
 * identically. The files panel used to hand its ticked set to the dialog and
 * open it, which made the user confirm a selection they had just made, in a
 * second list of the same files, with the same checkboxes already ticked. The
 * panel exports directly instead, and the dialog keeps its own place for the
 * case it is actually good at: arriving with nothing chosen and deciding there.
 *
 * ⚠ THE RULES ARE THE EXPORT, NOT DECORATION AROUND IT. Name collisions
 * disambiguate, a multi-file export zips, an oversized one is refused before it
 * builds an archive the writer cannot address, and a file that fails to render
 * is skipped rather than aborting its siblings. Two copies of that would drift;
 * the second copy is how a surface ends up quietly worse than the other. The
 * pure half lives in `audio/exportPlan.js`, where a test can reach it — this
 * module cannot be imported under node, it pulls in the worklet chain.
 */

// App-wide rather than per-component, for the same reason `isSaving` is: the
// files panel can start an export and the dialog can be opened over the top of
// it, and both need to know a render is in flight.
const isExporting = ref(false)
const exportProgress = ref({ done: 0, total: 0 })

export function useExport() {
  const { showToast } = useEditorState()

  /**
   * Render `docs` and deliver them.
   * @returns {Promise<boolean>} whether anything reached the user — callers use
   *   it to decide whether to dismiss themselves, so a total failure leaves the
   *   surface standing with the selection intact.
   */
  async function exportDocuments(docs) {
    if (docs.length === 0 || isExporting.value || overZipLimit(docs)) return false

    isExporting.value = true
    exportProgress.value = { done: 0, total: docs.length }

    try {
      const names = uniqueNames(docs)
      const rendered = []
      const failed = []

      for (const [i, doc] of docs.entries()) {
        // Yield to the browser between files so the progress readout actually
        // paints — rendering is synchronous and would otherwise freeze the UI
        // solid until every file was done.
        await new Promise(r => setTimeout(r, 0))
        try {
          const wav = renderTimelineToWav(
            doc.segments, doc.currentFile.sampleRate, doc.currentFile.channels
          )
          if (wav) rendered.push({ name: names[i], data: wav })
          else failed.push(doc.name)
        } catch (err) {
          console.error(`Failed to render ${doc.name}:`, err)
          failed.push(doc.name)
        }
        exportProgress.value = { done: i + 1, total: docs.length }
      }

      if (rendered.length === 0) {
        showToast('Nothing to export')
        return false
      }

      if (rendered.length === 1) {
        downloadBlob(new Blob([rendered[0].data], { type: 'audio/wav' }), rendered[0].name)
        showToast(`Exported ${rendered[0].name}`)
      } else {
        const stamp = new Date().toISOString().slice(0, 10)
        downloadBlob(createZip(rendered), `wavely-export-${stamp}.zip`)
        showToast(`Exported ${rendered.length} files as a zip`)
      }

      if (failed.length > 0) {
        showToast(`Skipped ${failed.length} file${failed.length === 1 ? '' : 's'} that failed to render`)
      }
      return true
    } finally {
      isExporting.value = false
    }
  }

  return {
    isExporting, exportProgress, exportDocuments,
    estimatedBytes, totalBytes, formatSize, overZipLimit, uniqueNames,
  }
}
