import { ref } from 'vue'
import { useEditorState } from './useEditorState.js'
import { renderTimelineForSave } from '../audio/export.js'
import { downloadBlob } from '../audio/download.js'
import { createZip } from '../audio/zip.js'
import {
  estimatedBytes, totalBytes, formatSize, exportSizeLimit, uniqueNames, exportSettingsFor, encodedZipLimit,
} from '../audio/exportPlan.js'

/**
 * Export: render the chosen documents and hand them over, one file or a zip of
 * many — each in its source's own format, depth and rate (`exportSettingsFor`,
 * the Save dialog's defaults), through the same encoder Save uses.
 *
 * The files panel is the only surface that exports (tick files, then Export;
 * Ctrl+E opens it with the active file ticked). A separate export dialog
 * existed and was removed once Save became the way a single edited file goes
 * back to the user. This stays a composable so the rules below live apart from
 * the panel's markup.
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
    // The size refusal is repeated here rather than trusted to the caller: both
    // surfaces disable their button on it, and a render that gets past a
    // disabled button still produces a file the user cannot play.
    if (docs.length === 0 || isExporting.value || exportSizeLimit(docs)) return false

    isExporting.value = true
    exportProgress.value = { done: 0, total: docs.length }

    try {
      const names = uniqueNames(docs)
      const rendered = []
      const failed = []

      for (const [i, doc] of docs.entries()) {
        // Yield to the browser between files so the progress readout actually
        // paints — the timeline render is synchronous and would otherwise
        // freeze the UI solid until every file was done.
        await new Promise(r => setTimeout(r, 0))
        try {
          const file = await renderTimelineForSave(
            doc.segments, doc.currentFile.sampleRate, doc.currentFile.channels,
            exportSettingsFor(doc),
          )
          if (file) rendered.push({ name: names[i], data: file.bytes, mime: file.mime })
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
        downloadBlob(new Blob([rendered[0].data], { type: rendered[0].mime }), rendered[0].name)
        showToast(`Exported ${rendered[0].name}`)
      } else {
        const over = encodedZipLimit(rendered.map(f => ({ name: f.name, size: f.data.byteLength })))
        if (over) {
          showToast(over.message, 6000)
          return false
        }
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
    estimatedBytes, totalBytes, formatSize, exportSizeLimit, uniqueNames, exportSettingsFor,
  }
}
