/**
 * Landing a mastering result on its document — shared by the Presets panel
 * (the job it started) and a job resumed after a reload (useServerJobs.js).
 */
import { useEditorState } from './useEditorState.js'
import { PRESETS } from '../audio/presets.js'
import { computePeakCache } from '../audio/processing.js'
import { getTimelineDuration } from '../audio/operations.js'

/**
 * Replace the whole of `docId`'s timeline with the decoded result as one undo
 * step, update its file details and report, and say so. Resolves false when
 * the document has closed meanwhile.
 *
 * @param {object} o
 * @param {string} o.docId
 * @param {AudioBuffer} o.audioBuffer   the decoded result
 * @param {object} o.report             the server's processing report
 * @param {string} o.preset             preset id, for the undo label
 * @param {object|null} [o.selection]   what was selected when the job started
 */
export async function commitMasteringResult({ docId, audioBuffer, report, preset, selection = null }) {
  const { appState, getDocument, replaceRegion, setPeakCache, setProcessingReport, showToast } = useEditorState()
  const doc = getDocument(docId)
  if (!doc) return false

  const dur = getTimelineDuration(doc.segments)
  const bufferId = replaceRegion(
    0, dur, audioBuffer, `${PRESETS[preset]?.displayName ?? 'Preset'} mastering`, docId, selection,
  )

  // Server-side presets can change channel count (e.g. Noise Eraser → mono)
  // and sample rate. Without this, export/render loops use the stale original
  // channel count and crash with IndexSizeError when calling getChannelData(1)
  // on a mono AudioBuffer.
  doc.currentFile.channels = audioBuffer.numberOfChannels
  doc.currentFile.sampleRate = audioBuffer.sampleRate
  doc.currentFile.duration = audioBuffer.duration

  setPeakCache(bufferId, await computePeakCache(audioBuffer, 256))
  setProcessingReport(report, docId)
  announceMastering(report, appState.documents.length > 1 ? doc.name : null, showToast)
  return true
}

/** "ACX certification: PASS", or "Processing complete" — naming the file when several are open. */
export function announceMastering(report, name, showToast) {
  const suffix = name ? ` — ${name}` : ''
  if (report?.acx_certification) {
    const label = report.acx_certification.certificate === 'pass' ? 'PASS' : 'FAIL'
    showToast(`ACX certification: ${label}${suffix}`)
  } else {
    showToast(`Processing complete${suffix}`)
  }
}
