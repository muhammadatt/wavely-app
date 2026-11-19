/**
 * Server jobs that outlive their tab.
 *
 * Mastering and Noise Reduction run on the server as jobs (202 + jobId, then
 * polling — CLAUDE.md, "Async Job Architecture"), and a long one takes many
 * minutes. Until now the job id lived only in the request that started it, so
 * a reload, a crash or a phone discarding a backgrounded tab threw away a
 * result the server went on to finish.
 *
 * Now every job in flight is RECORDED (localStorage, `STORAGE_KEY`; what a
 * record holds and how it finds its file: src/audio/serverJobRecord.js) from
 * the moment the server accepts it until its tab has landed the result, failed
 * or been cancelled. A tab that opens later RESUMES the records whose tab is
 * gone — told apart by a Web Lock per tab, as session autosave does — polls
 * them, and when one is done offers it (ServerJobsNotice.vue): Apply lands it
 * on its file if that file is open with the timeline the job was sent
 * (session autosave restores it so), and otherwise opens it as a new file.
 * The download waits for that click, because the server deletes a result once
 * downloaded and decoding needs an AudioContext, which needs a gesture.
 *
 * The file a job is working on is kept by session autosave while the job runs,
 * even when it has no unsaved edits (`pendingDocIds`), so the result usually
 * has its file to land on.
 *
 * Off where the browser lacks Web Locks or localStorage: jobs then run as
 * before, tied to their tab.
 */
import { computed, reactive } from 'vue'
import { v4 as uuidv4 } from 'uuid'
import { useEditorState } from './useEditorState.js'
import { commitMasteringResult, announceMastering } from './masteringResult.js'
import { pollJob } from '../api/pollJob.js'
import { fetchJobStatus, downloadJob } from '../api/jobs.js'
import { denoisedFromBlob } from '../api/noiseReduction.js'
import { blendDryWet } from '../audio/noiseReductionParams.js'
import { computePeakCache, renderRegionToBuffer } from '../audio/processing.js'
import { decodeWav } from '../audio/wavDecode.js'
import { matchDocument, partitionRecords, resultFileName, timelineKey } from '../audio/serverJobRecord.js'

export const STORAGE_KEY = 'wavely:server-jobs'
const LOCK_PREFIX = 'wavely-jobs:'
const ADOPT_LOCK = 'wavely-jobs-adopt'
const RESUME_POLL_MS = 3000
// A resumed job may have been running for a while already; give it the
// longest budget either client allows, rather than restarting the clock short.
const RESUME_MAX_POLLS = 40 * 60
const RESUME_MAX_QUEUE_POLLS = 60 * 20

const jobs = reactive({
  /** This tab's jobs in flight (records). */
  live: [],
  /**
   * Jobs a gone tab left, resumed here:
   * [{ record, status: 'running' | 'ready' | 'failed' | 'expired', progress,
   *    queuePosition, error, report, busy }]
   */
  resumed: [],
})

let tabId = null
let started = false
/** jobId → the result's Blob, once downloaded (kept out of the reactive entries). */
const downloaded = new Map()

function storage() {
  try { return globalThis.localStorage ?? null } catch { return null }
}

function readStore() {
  try { return JSON.parse(storage()?.getItem(STORAGE_KEY) ?? '[]') ?? [] } catch { return [] }
}

function writeStore(list) {
  try {
    if (list.length) storage()?.setItem(STORAGE_KEY, JSON.stringify(list))
    else storage()?.removeItem(STORAGE_KEY)
  } catch { /* storage full or blocked: the job just stays tied to its tab */ }
}

function upsertRecord(record) {
  writeStore([...readStore().filter(r => r.jobId !== record.jobId), record])
}

function removeRecord(jobId) {
  writeStore(readStore().filter(r => r.jobId !== jobId))
}

export function useServerJobs() {
  /** Documents with a job of this tab's in flight: session autosave keeps them. */
  const pendingDocIds = computed(() => new Set(jobs.live.map(r => r.docId)))

  async function start() {
    if (started) return
    started = true
    const locks = globalThis.navigator?.locks
    if (!locks?.request || !storage()) return
    const id = uuidv4()
    // Hold this tab's lock for its whole life; the browser drops it when the tab goes.
    await new Promise((resolve) => {
      locks.request(LOCK_PREFIX + id, () => {
        resolve()
        return new Promise(() => {})
      })
    })
    tabId = id
    // One tab at a time, so two tabs opened together do not both take a job.
    await locks.request(ADOPT_LOCK, async () => {
      const held = new Set(((await locks.query()).held ?? []).map(l => l.name))
      const { orphaned, kept } = partitionRecords(readStore(), { isAlive: owner => held.has(LOCK_PREFIX + owner) })
      const adopted = orphaned.map(r => ({ ...r, owner: tabId }))
      writeStore([...kept, ...adopted])
      for (const r of adopted) resume(r)
    })
  }

  /**
   * Start recording a job of this tab's. Call before submitting; `submitted`
   * writes the record once the server has given the job its id, `end` removes
   * it (landed, failed or cancelled — always, in a `finally`).
   *
   * @param {object} fields  kind, docId, name, timeline, start, end,
   *                         sampleRate, channels, extra
   */
  function beginJob(fields) {
    let record = null
    return {
      submitted(jobId) {
        if (!tabId) return
        record = { ...fields, jobId, owner: tabId, startedAt: Date.now() }
        jobs.live.push(record)
        upsertRecord(record)
      },
      end() {
        if (!record) return
        const i = jobs.live.indexOf(record)
        if (i >= 0) jobs.live.splice(i, 1)
        removeRecord(record.jobId)
        record = null
      },
    }
  }

  function resume(record) {
    const entry = reactive({
      record, status: 'running', progress: null, queuePosition: null, error: null, report: null, busy: false,
    })
    jobs.resumed.push(entry)
    pollJob({
      interval: RESUME_POLL_MS,
      maxPolls: RESUME_MAX_POLLS,
      maxQueuePolls: RESUME_MAX_QUEUE_POLLS,
      onProgress: (p) => { entry.progress = p },
      fetchStatus: async () => {
        const job = await fetchJobStatus(record.jobId)
        entry.queuePosition = job.queuePosition ?? null
        return job
      },
    }).then((job) => {
      entry.status = 'ready'
      entry.report = job.report ?? null
    }).catch((err) => settleFailed(entry, err))
  }

  function settleFailed(entry, err) {
    entry.status = err?.status === 404 || err?.status === 410 ? 'expired' : 'failed'
    entry.error = entry.status === 'expired'
      ? 'The server no longer has this result. Run it again.'
      : (err?.message || 'The job failed on the server')
    removeRecord(entry.record.jobId)
  }

  /**
   * Download a resumed job's result and land it: on its file if that is open
   * with the timeline the job was sent, else as a new file. Call from a click.
   */
  async function applyResumed(entry) {
    if (entry.status !== 'ready' || entry.busy) return
    const editor = useEditorState()
    const r = entry.record
    const candidate = matchDocument(r, editor.appState.documents)
    const doc = candidate && candidate.currentFile?.sampleRate === r.sampleRate
      && candidate.currentFile?.channels === r.channels ? candidate : null
    if (doc?.isProcessing) {
      editor.showToast(`Wait for ${doc.name} to finish processing`)
      return
    }
    entry.busy = true
    try {
      // Kept once downloaded: the server deletes a result on its first
      // download, so a retry (the file changed meanwhile) must not ask again.
      let blob = downloaded.get(r.jobId)
      if (!blob) downloaded.set(r.jobId, blob = await downloadJob(r.jobId))
      if (r.kind === 'mastering') await landMastering(editor, entry, blob, doc)
      else await landDenoise(editor, r, blob, doc)
      forget(entry)
    } catch (err) {
      if (err?.changedMeanwhile) {
        editor.showToast(err.message, 6000, { tone: 'warn' })
        return
      }
      console.error('Resumed job could not be applied:', err)
      settleFailed(entry, err)
    } finally {
      entry.busy = false
    }
  }

  async function landMastering(editor, entry, blob, doc) {
    const r = entry.record
    const audioBuffer = await editor.getAudioContext().decodeAudioData(await blob.arrayBuffer())
    if (doc) {
      if (timelineKey(doc.segments) !== r.timeline) throw changedMeanwhile(doc.name)
      await commitMasteringResult({
        docId: doc.id, audioBuffer, report: entry.report, preset: r.extra?.preset, selection: doc.selection,
      })
      editor.setActiveDocument(doc.id)
      return
    }
    const docId = await openAsNewFile(editor, r, audioBuffer)
    editor.setProcessingReport(entry.report, docId)
    announceMastering(entry.report, null, editor.showToast)
  }

  async function landDenoise(editor, r, blob, doc) {
    const ctx = editor.getAudioContext()
    if (doc) {
      const docId = doc.id
      const revision = doc.revision
      const dry = renderRegionToBuffer(doc.segments, r.start, r.end, r.sampleRate, r.channels)
      const wet = await denoisedFromBlob(blob, dry, r.sampleRate)
      const blended = blendDryWet(dry, wet, r.extra?.mix ?? 1)
      const buffer = ctx.createBuffer(blended.length, blended[0].length, r.sampleRate)
      blended.forEach((d, ch) => buffer.copyToChannel(d, ch))
      const cache = await computePeakCache(buffer, 256)
      if (editor.getDocument(docId)?.revision !== revision) throw changedMeanwhile(doc.name)
      const bufferId = editor.replaceRegion(r.start, r.end, buffer, 'noise reduction', docId, doc.selection)
      editor.setPeakCache(bufferId, cache)
      editor.setActiveDocument(docId)
      editor.showToast(`Noise reduced — ${doc.name}. Undo to compare`)
      return
    }
    // No file to blend into: the denoised selection alone, at full mix.
    const decoded = decodeWav(await blob.arrayBuffer())
    const buffer = ctx.createBuffer(decoded.channels.length, decoded.channels[0].length, decoded.sampleRate)
    decoded.channels.forEach((d, ch) => buffer.copyToChannel(d, ch))
    await openAsNewFile(editor, r, buffer)
  }

  async function openAsNewFile(editor, r, audioBuffer) {
    const name = resultFileName(r.name, r.kind)
    const { docId, bufferId } = editor.createDocument(name, audioBuffer, { unsaved: true })
    editor.setPeakCache(bufferId, await computePeakCache(audioBuffer, 256))
    editor.showToast(`${r.name} isn't open as it was sent, so the result opened as ${name}`, 6000)
    return docId
  }

  function changedMeanwhile(name) {
    return Object.assign(new Error(`${name} changed while the result downloaded — nothing was applied`), { changedMeanwhile: true })
  }

  /** Stop offering a resumed job. One still running is left to finish and expire on the server. */
  function forget(entry) {
    const i = jobs.resumed.indexOf(entry)
    if (i >= 0) jobs.resumed.splice(i, 1)
    downloaded.delete(entry.record.jobId)
    removeRecord(entry.record.jobId)
  }

  return { jobs, pendingDocIds, start, beginJob, applyResumed, forget }
}
