import { ref } from 'vue'
import { useEditorState } from './useEditorState.js'
import { decodeAudioFile, isSupportedFormat, SUPPORTED_FORMATS } from '../audio/loader.js'
import { computePeakCache } from '../audio/processing.js'

/**
 * Shared file import. Every entry point into the app — the empty state, the
 * tab strip's "+", the files panel, and workspace drag-drop — goes through
 * here so they all produce documents the same way.
 */

const BASE_SAMPLES_PER_PX = 256

// Import is app-wide rather than per-component: dropping files while another
// import is running should queue behind it, not race it.
const isImporting = ref(false)
const importProgress = ref({ done: 0, total: 0 })

export function useFileImport() {
  const { createDocument, getAudioContext, setPeakCache, showToast } = useEditorState()

  /**
   * Decode files and open each as a new document.
   * @param {File[]|FileList} files
   * @param {{ activateFirst?: boolean }} [options]
   * @returns {Promise<string[]>} ids of the documents created
   */
  async function importFiles(files, { activateFirst = true } = {}) {
    const list = Array.from(files ?? [])
    if (list.length === 0) return []

    const supported = list.filter(isSupportedFormat)
    const rejected = list.length - supported.length
    if (rejected > 0) {
      showToast(
        supported.length === 0
          ? `Unsupported format — expected ${SUPPORTED_FORMATS.join(', ').toUpperCase()}`
          : `Skipped ${rejected} unsupported file${rejected === 1 ? '' : 's'}`
      )
    }
    if (supported.length === 0) return []

    isImporting.value = true
    importProgress.value = { done: 0, total: supported.length }

    const createdIds = []
    const failed = []

    try {
      // Sequential rather than parallel: decoding is memory-hungry (32-bit
      // float PCM is ~10 MB per minute per channel) and decoding a dropped
      // folder of chapters all at once is a reliable way to kill the tab.
      for (const [i, file] of supported.entries()) {
        let audioBuffer
        try {
          const ctx = getAudioContext()
          audioBuffer = await decodeAudioFile(file, ctx)
        } catch (err) {
          console.error(`Failed to decode ${file.name}:`, err)
          failed.push(file.name)
          importProgress.value = { done: i + 1, total: supported.length }
          continue
        }

        const { docId, bufferId } = createDocument(file.name, audioBuffer, {
          // Activate the first successful import so the user lands on
          // something; later files open behind it without stealing focus.
          activate: activateFirst && createdIds.length === 0,
        })
        createdIds.push(docId)

        try {
          const cache = await computePeakCache(audioBuffer, BASE_SAMPLES_PER_PX)
          setPeakCache(bufferId, cache)
        } catch (err) {
          console.warn(`Failed to compute peak cache for ${file.name}:`, err)
        }

        importProgress.value = { done: i + 1, total: supported.length }
      }
    } finally {
      isImporting.value = false
    }

    if (failed.length > 0) {
      showToast(
        failed.length === 1
          ? `Couldn't load ${failed[0]}`
          : `Couldn't load ${failed.length} files`
      )
    } else if (createdIds.length > 1) {
      showToast(`Opened ${createdIds.length} files`)
    }

    return createdIds
  }

  /** Open the OS file picker and import whatever comes back. */
  function promptForFiles({ multiple = true } = {}) {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = 'audio/*'
    input.multiple = multiple
    input.style.display = 'none'
    input.addEventListener('change', () => {
      importFiles(input.files)
      input.remove()
    })
    document.body.appendChild(input)
    input.click()
  }

  return { importFiles, promptForFiles, isImporting, importProgress }
}
