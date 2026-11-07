import { test } from 'node:test'
import assert from 'node:assert/strict'
import express from 'express'

import { createAnalyzeRoute } from '../routes/analyze.js'
import { createSpotRoute } from '../routes/spot.js'
import { createEntitlementGate } from '../lib/entitlements.js'
import { createJobQueue, holdSlot, readRequestLimitConfig } from '../lib/jobQueue.js'
import { neverEndingUpload } from './helpers/neverEndingUpload.js'
const PLANS = { 'tok-free': 'free', 'tok-pro': 'pro' }
const verify = async (token) => {
  if (!PLANS[token]) throw new Error('bad token')
  return { id: token }
}
const planFor = async (userId) => PLANS[userId]
const gate = createEntitlementGate({ verify, planFor, probeDuration: async () => 300 })

async function withServer(router, fn) {
  const app = express()
  app.use('/api', router)
  const server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)) })
  try {
    return await fn(`http://127.0.0.1:${server.address().port}`)
  } finally {
    await new Promise(resolve => server.close(resolve))
  }
}

function post(url, token) {
  const form = new FormData()
  form.append('file', new Blob([new Uint8Array(64)]), 'clip.wav')
  return fetch(url, { method: 'POST', body: form, headers: token ? { Authorization: `Bearer ${token}` } : {} })
}

test('analyze and spot: signed out is 401 before the upload, even for a preview-length clip', async () => {
  const short = createEntitlementGate({ verify, planFor, probeDuration: async () => 5 })
  await withServer(createAnalyzeRoute({ gate: short }), async (base) => {
    for (const kind of ['vad', 'sibilance']) {
      const res = await neverEndingUpload(`${base}/api/analyze/${kind}`)
      assert.equal(res.status, 401, kind)
      assert.equal(res.body.code, 'sign_in_required')
    }
    assert.equal((await neverEndingUpload(`${base}/api/analyze/vad`, 'tok-garbage')).status, 401)
  })
  await withServer(createSpotRoute({ gate: short }), async (base) => {
    assert.equal((await neverEndingUpload(`${base}/api/spot/vocal_saturation`)).status, 401)
  })
})

test('a free account still gets the plan check after the upload, and a refusal frees its slot', async () => {
  const limit = holdSlot(createJobQueue({ concurrency: 1, maxQueued: 0, maxPerClient: 1 }))
  await withServer(createSpotRoute({ gate, limit }), async (base) => {
    for (let i = 0; i < 3; i++) {
      const res = await post(`${base}/api/spot/vocal_saturation`, 'tok-free')
      assert.equal(res.status, 402, `attempt ${i + 1}: refused by plan, not by a leaked slot`)
      assert.equal((await res.json()).code, 'upgrade_required')
    }
  })
})

test('at the shared limit spot and analyze refuse before the upload', async () => {
  const queue = createJobQueue({ ...readRequestLimitConfig(), concurrency: 1, maxPerClient: 1 })
  queue.submit('user:tok-pro', () => new Promise(() => {}))  // one long analysis running
  const limit = holdSlot(queue)

  const app = express.Router()
  app.use(createAnalyzeRoute({ gate, limit }))
  app.use(createSpotRoute({ gate, limit }))
  await withServer(app, async (base) => {
    const mine = await neverEndingUpload(`${base}/api/analyze/vad`, 'tok-pro')
    assert.equal(mine.status, 429)
    assert.match(mine.body.error, /server analysis running/)

    const other = await neverEndingUpload(`${base}/api/spot/vocal_saturation`, 'tok-free')
    assert.equal(other.status, 503)
    assert.equal(other.headers['retry-after'], '60')
  })
})

test('a blocked account is refused 403 before the upload on analyze, spot and mastering', async () => {
  const { createProcessRoute } = await import('../routes/process.js')
  const blocking = createEntitlementGate({ verify, planFor, isBlocked: async id => id === 'tok-pro', probeDuration: async () => 5 })
  const app = express.Router()
  app.use(createAnalyzeRoute({ gate: blocking }))
  app.use(createSpotRoute({ gate: blocking }))
  app.use(createProcessRoute({ gate: blocking, verify }))
  await withServer(app, async (base) => {
    for (const path of ['/api/analyze/vad', '/api/spot/vocal_saturation', '/api/process']) {
      const res = await neverEndingUpload(`${base}${path}`, 'tok-pro')
      assert.equal(res.status, 403, path)
      assert.equal(res.body.code, 'account_blocked')
    }
  })
})

test('an unknown kind or operation is 400 before sign-in, the slot and the upload', async () => {
  const queue = createJobQueue({ concurrency: 1, maxQueued: 0, maxPerClient: 1 })
  const limit = holdSlot(queue)
  const app = express.Router()
  app.use(createAnalyzeRoute({ gate, limit }))
  app.use(createSpotRoute({ gate, limit }))
  await withServer(app, async (base) => {
    for (const path of ['/api/analyze/nope', '/api/spot/nope']) {
      const res = await neverEndingUpload(`${base}${path}`)
      assert.equal(res.status, 400, path)
      assert.match(res.body.error, /Unknown/)
    }
  })
  assert.equal(queue.stats().running, 0, 'no slot was taken')
})

test('a finished resumable upload stands in for the multipart file, for its owner only', async () => {
  const { mkdtemp, rm } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const { createUploadStore, useUpload } = await import('../lib/uploads.js')
  const root = await mkdtemp(join(tmpdir(), 'wavely-sync-up-'))
  const store = createUploadStore({ dir: join(root, 'tus'), log: () => {} })
  const takeUpload = useUpload(store, join(root, 'taken'))

  async function finishedUpload(client) {
    const u = await store.create({ client, signedOut: false, length: 4, metadata: { filename: 'sel.wav' } })
    const { Readable } = await import('node:stream')
    await store.append(u, 0, Readable.from([Buffer.from('RIFF')]))
    return u.id
  }

  const app = express.Router()
  app.use(express.json())
  app.use(createSpotRoute({ gate, takeUpload }))
  try {
    await withServer(app, async (base) => {
      const post = (token, uploadId) => fetch(`${base}/api/spot/vocal_saturation`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ uploadId }),
      })
      // The plan gate sees the taken file: a free account's long clip is a 402.
      const mine = await finishedUpload('user:tok-free')
      const res = await post('tok-free', mine)
      assert.equal(res.status, 402)
      assert.equal((await res.json()).code, 'upgrade_required')

      // Another account naming it gets nothing, and it is still there for its owner.
      const theirs = await finishedUpload('user:tok-free')
      const stolen = await post('tok-pro', theirs)
      assert.equal(stolen.status, 404)
      assert.equal((await stolen.json()).code, 'upload_not_found')
      assert.ok(store.get(theirs, 'user:tok-free'))
    })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('an async spot operation (noise reduction) is admitted by the processing job queue, before the upload — not by a spot slot', async () => {
  const jobs = createJobQueue({ concurrency: 1, maxQueued: 0, maxPerClient: 1 })
  jobs.submit('user:tok-pro', () => new Promise(() => {}))   // this account's one job, running
  const slots = createJobQueue({ ...readRequestLimitConfig(), concurrency: 1, maxPerClient: 1 })
  await withServer(createSpotRoute({ gate, limit: holdSlot(slots), jobs }), async (base) => {
    const mine = await neverEndingUpload(`${base}/api/spot/noise_reduction`, 'tok-pro')
    assert.equal(mine.status, 429)
    assert.equal(mine.body.code, 'too_many_jobs')
    assert.equal(slots.stats().running, 0, 'no spot slot was taken')

    const other = await neverEndingUpload(`${base}/api/spot/noise_reduction`, 'tok-free')
    assert.equal(other.status, 503, 'the one job slot is busy and the line holds nobody')
  })
})
