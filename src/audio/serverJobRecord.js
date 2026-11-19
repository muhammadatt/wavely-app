/**
 * What is remembered about a server job in flight so it can be picked up again
 * after the tab that started it is gone (src/composables/useServerJobs.js),
 * and how the result finds its file again.
 *
 * A RECORD is plain JSON:
 *   { jobId, kind: 'mastering' | 'noiseReduction', owner, startedAt,
 *     docId, name, timeline, start, end, sampleRate, channels, label, extra }
 * `docId` only means something in the tab that wrote it — document ids are
 * made afresh on every load. After a reload the result finds its file by
 * `timeline`: the timeline the job was sent, by buffer id and edge times.
 * Session autosave restores a file with the same buffer ids and the same
 * edges, so a restored file matches; a file edited since, or opened afresh
 * from disk (new buffer ids), does not, and the result opens as a new file.
 */

export const JOB_KINDS = ['mastering', 'noiseReduction']
/** Records older than this are dropped unread: the server keeps a finished job for an hour. */
export const RECORD_MAX_AGE_MS = 24 * 60 * 60 * 1000

/** A timeline's identity: which audio plays, from where, in what order. */
export function timelineKey(segments) {
  return JSON.stringify((segments ?? []).map(s => s.sourceBuffer === null || s.silence
    ? ['s', round(s.duration)]
    : [s.sourceBufferId, round(s.sourceStart), round(s.sourceEnd)]))
}

// Times survive a JSON round trip exactly, but a restored edge is clamped to
// the re-decoded buffer's duration (restoreSegments), which can move it by a
// sample or so.
function round(t) {
  return Math.round((t ?? 0) * 1000) / 1000
}

export function isJobRecord(r) {
  return !!r && typeof r === 'object' && typeof r.jobId === 'string' && r.jobId.length > 0
    && JOB_KINDS.includes(r.kind) && typeof r.timeline === 'string'
    && Number.isFinite(r.start) && Number.isFinite(r.end) && r.end > r.start
}

/** The open document a result belongs to: its timeline is the one the job was sent. */
export function matchDocument(record, documents) {
  return documents.find(d => timelineKey(d.segments) === record.timeline) ?? null
}

/**
 * Split the stored records into this tab's view of them: records whose owner
 * tab is gone (to resume), and the rest (kept as they are). Unreadable and
 * stale records are dropped.
 */
export function partitionRecords(records, { isAlive, now = Date.now() }) {
  const orphaned = []
  const kept = []
  for (const r of Array.isArray(records) ? records : []) {
    if (!isJobRecord(r) || now - (r.startedAt ?? 0) > RECORD_MAX_AGE_MS) continue
    if (isAlive(r.owner)) kept.push(r)
    else orphaned.push(r)
  }
  return { orphaned, kept }
}

/** The name a result that found no file opens under: "Ch 04 (mastered).wav". */
export function resultFileName(name, kind) {
  const m = /^(.*?)(\.[A-Za-z0-9]{1,5})?$/.exec(name || 'Audio')
  const base = m[1] || 'Audio'
  const suffix = kind === 'mastering' ? 'mastered' : 'denoised'
  return `${base} (${suffix}).wav`
}
