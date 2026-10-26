import { ref } from 'vue'
import { useEditorState } from './useEditorState.js'
import { decodeAudioFile, isSupportedFormat, SUPPORTED_FORMATS } from '../audio/loader.js'
import { computePeakCache } from '../audio/processing.js'
import { parseSourceFormat, SOURCE_HEADER_BYTES } from '../audio/sourceFormat.js'
import { isCancellation } from '../audio/fileSave.js'

/**
 * Shared file import. Every entry point into the app — the empty state, the
 * tab strip's "+", the files panel, and workspace drag-drop — goes through
 * here so they all produce documents the same way.
 *
 * Where the browser has the File System Access API, files are opened through
 * it rather than an <input type="file">, and drag-drop asks each item for its
 * handle. The handle is what lets the Save dialog open in the original file's
 * folder and, when the user keeps the name, write back over it. It carries
 * READ access only: nothing is written to the original until the user confirms
 * a Save that names it, and the browser then asks for write permission itself.
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
   * @param {Iterable<File | { file: File, handle?: FileSystemFileHandle|null }>} files
   * @param {{ activateFirst?: boolean }} [options]
   * @returns {Promise<string[]>} ids of the documents created
   */
  async function importFiles(files, { activateFirst = true } = {}) {
    const list = Array.from(files ?? []).map(f => (f && f.file ? f : { file: f, handle: null }))
    if (list.length === 0) return []

    const supported = list.filter(e => isSupportedFormat(e.file))
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
      for (const [i, { file, handle }] of supported.entries()) {
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

        let sourceFormat = null
        try {
          sourceFormat = parseSourceFormat(
            await file.slice(0, SOURCE_HEADER_BYTES).arrayBuffer(), file.name
          )
        } catch (err) {
          console.warn(`Couldn't read the header of ${file.name}:`, err)
        }

        const { docId, bufferId } = createDocument(file.name, audioBuffer, {
          // Activate the first successful import so the user lands on
          // something; later files open behind it without stealing focus.
          activate: activateFirst && createdIds.length === 0,
          sourceFormat,
          sourceHandle: handle ?? null,
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

  /**
   * Import a drop. Each item's handle has to be REQUESTED during the drop event
   * itself — the DataTransfer is emptied once the handler returns — so every
   * `getAsFileSystemHandle()` call is made synchronously here and awaited after.
   */
  async function importDataTransfer(dataTransfer) {
    const items = Array.from(dataTransfer?.items ?? []).filter(item => item.kind === 'file')
    if (items.length === 0) return importFiles(dataTransfer?.files)

    const pending = items.map(item => ({
      file: item.getAsFile(),
      handle: typeof item.getAsFileSystemHandle === 'function'
        ? item.getAsFileSystemHandle().catch(() => null)
        : null,
    }))
    const entries = []
    for (const p of pending) {
      if (!p.file) continue
      const handle = await p.handle
      // A dropped folder yields a directory handle; only file handles can be
      // written back to.
      entries.push({ file: p.file, handle: handle?.kind === 'file' ? handle : null })
    }
    return importFiles(entries)
  }

  /** Open the OS file picker and import whatever comes back. */
  async function promptForFiles({ multiple = true } = {}) {
    if (typeof window !== 'undefined' && typeof window.showOpenFilePicker === 'function') {
      let handles
      try {
        handles = await window.showOpenFilePicker({
          multiple,
          types: [{
            description: 'Audio',
            accept: { 'audio/*': SUPPORTED_FORMATS.map(ext => `.${ext}`) },
          }],
        })
      } catch (err) {
        if (isCancellation(err)) return []
        // A picker that refuses outright (a sandboxed iframe, a policy) should
        // not leave the user with no way in: fall back to the plain input.
        console.warn('Open picker failed, falling back to file input:', err)
        return promptWithInput(multiple)
      }
      const entries = []
      for (const handle of handles) {
        try {
          entries.push({ file: await handle.getFile(), handle })
        } catch (err) {
          console.error(`Couldn't read ${handle.name}:`, err)
        }
      }
      return importFiles(entries)
    }
    return promptWithInput(multiple)
  }

  function promptWithInput(multiple) {
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

  return { importFiles, importDataTransfer, promptForFiles, isImporting, importProgress }
}
