/**
 * Undo history budgeted by the audio it keeps alive, not only by its length.
 *
 * An undo entry is a copy of the timeline's segment list, and a segment holds
 * its source AudioBuffer. Editing (cut, paste, silence) only rearranges
 * segments over buffers that are already open, so those steps cost almost
 * nothing. An APPLY replaces a region with a brand-new buffer, and the entry it
 * pushes keeps the buffer it replaced: a whole-file apply on an hour of stereo
 * keeps another 1.4 GB for as long as that step can be undone. Fifty such steps
 * is far past what a phone's tab survives.
 *
 * So history is trimmed from the OLDEST step until the audio that only history
 * still holds fits `budgetBytes`. Audio the timeline is still playing (any open
 * file's current segments, or the clipboard) costs history nothing and is not
 * counted. The newest step is always kept, however large: undoing the last
 * apply is the one undo users rely on.
 *
 * Trimming history alone frees nothing, because the editor's buffer pool also
 * holds every buffer until its file closes. `unreferencedBufferIds` names the
 * pool entries that no timeline, history step or clipboard reaches any more,
 * so the caller can drop them and let the browser reclaim the memory.
 *
 * Pure: the caller passes segments, entries and a byte count per buffer id.
 */

/** Ids of the buffers a segment list plays from (silence segments have none). */
export function segmentBufferIds(segments, into = new Set()) {
  for (const seg of segments ?? []) {
    if (seg?.sourceBufferId) into.add(seg.sourceBufferId)
  }
  return into
}

/**
 * How many of the OLDEST undo entries to drop so that the audio held only by
 * history fits the budget.
 *
 * @param {object} p
 * @param {Array<{segments: object[]}>} p.undo   oldest first, as the stack is kept
 * @param {Array<{segments: object[]}>} [p.redo] counted, never dropped here
 * @param {Set<string>} p.liveIds  buffers the timelines and clipboard still use
 * @param {(id: string) => number} p.bytesOf
 * @param {number} p.budgetBytes
 * @returns {{ drop: number, heldBytes: number }} heldBytes: what history holds after the drop
 */
export function historyTrim({ undo, redo = [], liveIds, bytesOf, budgetBytes }) {
  const counted = new Set(liveIds)
  let held = 0
  const take = (entry) => {
    for (const seg of entry?.segments ?? []) {
      const id = seg?.sourceBufferId
      if (!id || counted.has(id)) continue
      counted.add(id)
      held += bytesOf(id) || 0
    }
  }
  // Redo first: it is what an Undo just stepped away from and is never dropped
  // here, so whatever it holds is spent before any undo step is weighed.
  for (const entry of redo) take(entry)

  // Walk newest → oldest; the newest step is kept whatever it costs.
  let keep = 0
  for (let i = undo.length - 1; i >= 0; i--) {
    const before = held
    take(undo[i])
    if (keep > 0 && held > budgetBytes) {
      held = before
      break
    }
    keep++
  }
  return { drop: undo.length - keep, heldBytes: held }
}

/**
 * Pool ids that nothing reaches any more: not a current timeline, not a history
 * step (undo or redo, any file), not the clipboard.
 *
 * @param {Iterable<string>} poolIds
 * @param {Iterable<object[]>} segmentLists  every segment list that still counts
 */
export function unreferencedBufferIds(poolIds, segmentLists) {
  const reached = new Set()
  for (const list of segmentLists) segmentBufferIds(list, reached)
  const out = []
  for (const id of poolIds) if (!reached.has(id)) out.push(id)
  return out
}
