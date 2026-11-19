/**
 * What session autosave writes for an open file, and how it is read back.
 *
 * A document is a timeline of segments over immutable source buffers (the EDL
 * model). To survive a crash, a reload or iOS killing the tab, autosave keeps:
 *   - a small JSON MANIFEST per browser tab: each file with UNSAVED edits —
 *     its name, timeline (segments by buffer id), selection, playhead, preset;
 *   - every buffer those timelines play, stored ONCE under its id (buffers
 *     never change, so a stored buffer is never rewritten): an opened file's
 *     original audio as the file's own bytes (re-decoded on restore — a WAV is
 *     half the size of its decoded float samples, an MP3 a tenth), and audio an
 *     apply produced as raw float32 samples.
 * Files without unsaved edits are not kept: their audio is on disk already.
 * Undo history is not kept either; a restored file starts a new history.
 *
 * Segment times are in SECONDS, so a file re-decoded at a different context
 * rate (another device, another output) still lines up.
 *
 * Pure: the store (platform/sessionStore.js) and the editor wiring
 * (composables/useSessionAutosave.js) do the I/O.
 */

/** Bump when the manifest's shape changes; older manifests are ignored. */
export const MANIFEST_VERSION = 1

/** One segment, without its AudioBuffer: silence keeps its duration, audio its buffer id. */
function snapshotSegment(seg) {
  if (seg.sourceBuffer === null || !seg.sourceBufferId) {
    return { id: seg.id, silence: true, duration: seg.duration, outputStart: seg.outputStart }
  }
  return {
    id: seg.id,
    sourceBufferId: seg.sourceBufferId,
    sourceStart: seg.sourceStart,
    sourceEnd: seg.sourceEnd,
    outputStart: seg.outputStart,
  }
}

/** The part of a document worth keeping. */
export function snapshotDocument(doc) {
  return {
    id: doc.id,
    name: doc.name,
    sourceFormat: doc.currentFile?.sourceFormat ?? null,
    selection: doc.selection ? { start: doc.selection.start, end: doc.selection.end } : null,
    playhead: doc.playhead ?? 0,
    selectedPreset: doc.selectedPreset,
    selectedOutputProfile: doc.selectedOutputProfile,
    segments: doc.segments.map(snapshotSegment),
  }
}

/** Ids of the buffers a set of snapshots (or live documents) plays from. */
export function bufferIdsOf(docs) {
  const ids = new Set()
  for (const d of docs) for (const seg of d.segments) if (seg.sourceBufferId) ids.add(seg.sourceBufferId)
  return ids
}

/** Whether a document has edits that are not on disk. */
export function hasUnsavedEdits(doc) {
  return doc.revision !== doc.savedRevision
}

/**
 * The manifest for a tab: its documents with unsaved edits, and how each
 * buffer they use is stored (`describe(id)` → `{ kind: 'file', … }` or
 * `{ kind: 'pcm', … }`, from the store's own record of what it wrote).
 * `keep` widens which documents go in (autosave also keeps a file a server
 * job is working on).
 */
export function buildManifest({ sessionId, documents, describe, keep = hasUnsavedEdits, now = Date.now() }) {
  const docs = documents.filter(keep).map(snapshotDocument)
  const buffers = {}
  for (const id of bufferIdsOf(docs)) buffers[id] = describe(id)
  return { version: MANIFEST_VERSION, sessionId, savedAt: now, docs, buffers }
}

/** A manifest this build can restore: right version, every buffer described. */
export function isRestorableManifest(m) {
  if (!m || m.version !== MANIFEST_VERSION || !Array.isArray(m.docs) || !m.buffers) return false
  for (const id of bufferIdsOf(m.docs)) if (!m.buffers[id]) return false
  return true
}

/**
 * Rebuild a stored document's segments over loaded buffers.
 * @param {object} snapshot  one of a manifest's `docs`
 * @param {Map<string, AudioBuffer>} buffers
 */
export function restoreSegments(snapshot, buffers) {
  return snapshot.segments.map((seg) => {
    if (seg.silence) {
      return { id: seg.id, sourceBuffer: null, duration: seg.duration, outputStart: seg.outputStart }
    }
    const buffer = buffers.get(seg.sourceBufferId)
    if (!buffer) throw new Error(`missing buffer ${seg.sourceBufferId}`)
    return {
      id: seg.id,
      sourceBuffer: buffer,
      sourceBufferId: seg.sourceBufferId,
      sourceStart: seg.sourceStart,
      // Re-decoding at another rate can make the buffer a few samples shorter.
      sourceEnd: Math.min(seg.sourceEnd, buffer.duration),
      outputStart: seg.outputStart,
    }
  })
}

/**
 * Stored buffer files nothing needs any more: not in this tab's manifest, nor
 * in any other manifest still on disk (another open tab's, or a dead one's
 * awaiting the user's Restore / Discard).
 */
export function orphanedBufferIds(storedIds, manifests) {
  const kept = new Set()
  for (const m of manifests) if (m?.buffers) for (const id of Object.keys(m.buffers)) kept.add(id)
  return [...storedIds].filter(id => !kept.has(id))
}
