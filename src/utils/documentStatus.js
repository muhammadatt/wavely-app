/**
 * The single definition of a document's processing state as the UI shows it.
 *
 * The tab strip renders this as a dot and the files panel renders it as a text
 * label, but they are the same state machine — keeping two copies meant two
 * colour tables that could disagree about what "mastered" looks like.
 *
 * @returns {null | { kind: string, color: string, label: string, title: string }}
 *   `null` when the document is untouched and should show no status at all.
 */
export function documentStatus(doc) {
  if (!doc) return null

  if (doc.isProcessing) {
    return {
      kind: 'processing',
      color: '#7fe9f6',
      label: doc.processingStage || 'Processing…',
      title: 'Processing',
    }
  }

  const cert = doc.processingReport?.acx_certification
  if (cert) {
    return cert.certificate === 'pass'
      ? { kind: 'pass', color: '#5fd39a', label: 'ACX pass', title: 'Mastered — ACX certification passed' }
      : { kind: 'fail', color: '#ff8a80', label: 'ACX fail', title: 'Mastered — ACX certification failed' }
  }

  if (doc.processingReport) {
    return { kind: 'mastered', color: '#7fe9f6', label: 'Mastered', title: 'Mastered' }
  }

  if (doc.undoCount > 0) {
    return { kind: 'edited', color: 'rgba(255,255,255,.45)', label: 'Edited', title: 'Edited' }
  }

  return null
}
