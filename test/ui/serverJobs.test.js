/**
 * Server jobs that outlive their tab: the record rules
 * (src/audio/serverJobRecord.js), polling through a dropped connection
 * (src/api/pollJob.js) and the wake lock (src/platform/wakeLock.js). The
 * resume flow itself runs in a browser; see scripts/server-jobs-check.mjs.
 *
 * Run with:  npm test
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  RECORD_MAX_AGE_MS, isJobRecord, matchDocument, partitionRecords, resultFileName, timelineKey,
} from '../../src/audio/serverJobRecord.js'
import { pollJob } from '../../src/api/pollJob.js'
import { createWakeLock } from '../../src/platform/wakeLock.js'
import { buildManifest } from '../../src/audio/sessionSnapshot.js'

const buf = { duration: 10 }
const segs = (end = 4) => [
  { id: 'a', sourceBuffer: buf, sourceBufferId: 'A', sourceStart: 0, sourceEnd: 2, outputStart: 0 },
  { id: 'b', sourceBuffer: null, duration: 0.5, outputStart: 2 },
  { id: 'c', sourceBuffer: buf, sourceBufferId: 'B', sourceStart: 3, sourceEnd: end, outputStart: 2.5 },
]

const record = (over = {}) => ({
  jobId: 'j1', kind: 'mastering', owner: 'tab1', startedAt: 1000,
  name: 'Ch 04.wav', timeline: timelineKey(segs()), start: 0, end: 3.5, sampleRate: 48000, channels: 1,
  ...over,
})

test('a timeline key names the audio and its edges, not segment ids or positions', () => {
  const restored = segs().map(s => ({ ...s, id: s.id + '-new', outputStart: s.outputStart + 0 }))
  assert.equal(timelineKey(restored), timelineKey(segs()))
  assert.notEqual(timelineKey(segs(3.9)), timelineKey(segs()), 'an edit changes it')
  // A restored edge clamped to a re-decoded buffer by well under a millisecond still matches.
  assert.equal(timelineKey(segs(4.0000208)), timelineKey(segs()))
})

test('a result finds the open file whose timeline it was sent', () => {
  const docs = [{ id: 'x', segments: segs(3.5) }, { id: 'y', segments: segs() }]
  assert.equal(matchDocument(record(), docs)?.id, 'y')
  assert.equal(matchDocument(record(), [{ id: 'x', segments: segs(3.5) }]), null)
})

test('records of gone tabs are resumed, live ones kept, broken and stale ones dropped', () => {
  const now = 5000
  const { orphaned, kept } = partitionRecords([
    record({ jobId: 'dead', owner: 'gone' }),
    record({ jobId: 'live', owner: 'here' }),
    record({ jobId: 'old', owner: 'gone', startedAt: now - RECORD_MAX_AGE_MS - 1 }),
    { jobId: 'broken' },
    null,
  ], { isAlive: o => o === 'here', now })
  assert.deepEqual(orphaned.map(r => r.jobId), ['dead'])
  assert.deepEqual(kept.map(r => r.jobId), ['live'])
  assert.deepEqual(partitionRecords('nonsense', { isAlive: () => false }), { orphaned: [], kept: [] })
})

test('a record must say what it is and what it covers', () => {
  assert.equal(isJobRecord(record()), true)
  assert.equal(isJobRecord(record({ kind: 'export' })), false)
  assert.equal(isJobRecord(record({ end: 0 })), false)
  assert.equal(isJobRecord(record({ jobId: '' })), false)
})

test('a result with no file opens under a name that says what it is', () => {
  assert.equal(resultFileName('Ch 04.wav', 'mastering'), 'Ch 04 (mastered).wav')
  assert.equal(resultFileName('take.final.mp3', 'noiseReduction'), 'take.final (denoised).wav')
  assert.equal(resultFileName('', 'mastering'), 'Audio (mastered).wav')
})

test('session autosave can keep a file with no unsaved edits', () => {
  const clean = { id: 'd', name: 'a.wav', revision: 1, savedRevision: 1, segments: segs(), currentFile: {} }
  assert.equal(buildManifest({ sessionId: 's', documents: [clean], describe: () => ({}) }).docs.length, 0)
  const kept = buildManifest({ sessionId: 's', documents: [clean], describe: () => ({}), keep: () => true })
  assert.deepEqual(kept.docs.map(d => d.id), ['d'])
})

// ── Polling ──────────────────────────────────────────────────────────────────

const networkDown = () => Object.assign(new TypeError('Failed to fetch'), {})

test('polling rides out a dropped connection and carries on', async () => {
  const answers = [networkDown(), networkDown(), { status: 'processing' }, networkDown(), { status: 'done', report: 1 }]
  const job = await pollJob({
    wait: async () => {},
    fetchStatus: async () => { const a = answers.shift(); if (a instanceof Error) throw a; return a },
  })
  assert.equal(job.report, 1)
})

test('polling gives up after too many network failures in a row', async () => {
  let calls = 0
  await assert.rejects(pollJob({
    wait: async () => {}, maxNetworkRetries: 3,
    fetchStatus: async () => { calls++; throw networkDown() },
  }), /Failed to fetch/)
  assert.equal(calls, 4)
})

test('an error the server answered with is not retried', async () => {
  let calls = 0
  const gone = Object.assign(new Error('Job not found or expired'), { status: 404 })
  await assert.rejects(pollJob({ wait: async () => {}, fetchStatus: async () => { calls++; throw gone } }), /not found/)
  assert.equal(calls, 1)
})

// ── Wake lock ────────────────────────────────────────────────────────────────

function fakeDoc() {
  const listeners = []
  return {
    visibilityState: 'visible',
    addEventListener: (type, fn) => listeners.push(fn),
    fire() { listeners.forEach(fn => fn()) },
  }
}

function fakeNav() {
  const nav = { requests: 0, released: 0, sentinels: [] }
  nav.wakeLock = {
    async request(type) {
      assert.equal(type, 'screen')
      nav.requests++
      const handlers = []
      const s = {
        addEventListener: (t, fn) => handlers.push(fn),
        release: async () => { nav.released++; handlers.forEach(fn => fn()) },
        drop: () => handlers.forEach(fn => fn()),
      }
      nav.sentinels.push(s)
      return s
    },
  }
  return nav
}

test('the wake lock is held while wanted and let go after', async () => {
  const nav = fakeNav()
  const lock = createWakeLock({ nav, doc: fakeDoc() })
  await lock.set(true)
  assert.equal(lock.held, true)
  await lock.set(true)
  assert.equal(nav.requests, 1, 'asked for once')
  lock.set(false)
  assert.equal(lock.held, false)
  assert.equal(nav.released, 1)
})

test('the wake lock is asked for again when the page comes back', async () => {
  const nav = fakeNav()
  const doc = fakeDoc()
  const lock = createWakeLock({ nav, doc })
  await lock.set(true)
  // Hiding the page: the browser drops it.
  doc.visibilityState = 'hidden'
  nav.sentinels[0].drop()
  assert.equal(lock.held, false)
  doc.visibilityState = 'visible'
  doc.fire()
  await new Promise(r => setTimeout(r, 0))
  assert.equal(lock.held, true)
  assert.equal(nav.requests, 2)
})

test('a wake lock granted after it stopped being wanted is let go at once', async () => {
  const nav = fakeNav()
  const lock = createWakeLock({ nav, doc: fakeDoc() })
  const pending = lock.set(true)
  lock.set(false)
  await pending
  assert.equal(lock.held, false)
  assert.equal(nav.released, 1)
})

test('without the API nothing happens', async () => {
  const lock = createWakeLock({ nav: {}, doc: fakeDoc() })
  await lock.set(true)
  assert.equal(lock.held, false)
})
