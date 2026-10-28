import { test } from 'node:test'
import assert from 'node:assert/strict'
import express from 'express'

import { createProcessRoute } from '../routes/process.js'
import { createEntitlementGate } from '../lib/entitlements.js'
import { createJobQueue } from '../lib/jobQueue.js'
import { neverEndingUpload } from './helpers/neverEndingUpload.js'
const PLANS = { 'tok-free': 'free', 'tok-pro': 'pro' }
const verify = async (token) => {
  if (!PLANS[token]) throw new Error('bad token')
  return { id: token }
}
const planFor = async (userId) => PLANS[userId]

async function withServer(router, fn) {
  const app = express()
  app.use('/api', router)
  const server = await new Promise(resolve => { const s = app.listen(0, () => resolve(s)) })
  try {
    return await fn(`http://127.0.0.1:${server.address().port}`)
  } finally {
    await new Promise(resolve => server.close(resolve))
  }
}

function upload(base, { token, preset = 'not_a_preset' } = {}) {
  const form = new FormData()
  form.append('file', new Blob([new Uint8Array(64)]), 'take.wav')
  form.append('preset', preset)
  form.append('output_profile', 'podcast')
  return fetch(`${base}/api/process`, {
    method: 'POST', body: form, headers: token ? { Authorization: `Bearer ${token}` } : {},
  })
}

// (That a refused upload is deleted is the gate's own test, in entitlements.test.js.)
test('signed out and longer than the preview: 402 asking for a free account', async () => {
  const gate = createEntitlementGate({ verify, planFor, probeDuration: async () => 300 })
  await withServer(createProcessRoute({ gate, verify }), async (base) => {
    const res = await upload(base)
    assert.equal(res.status, 402)
    const body = await res.json()
    assert.equal(body.code, 'upgrade_required')
    assert.equal(body.feature, 'mastering')
    assert.equal(body.requires, 'free')
    assert.match(body.error, /needs a free account/)

    // An invalid token is signed out, not an error.
    assert.equal((await upload(base, { token: 'expired' })).status, 402)
  })
})

test('any account, or a short clip signed out, gets past the gate (to validation)', async () => {
  const long = createEntitlementGate({ verify, planFor, probeDuration: async () => 300 })
  await withServer(createProcessRoute({ gate: long, verify }), async (base) => {
    const res = await upload(base, { token: 'tok-free' })
    assert.equal(res.status, 400)
    assert.match((await res.json()).error, /Invalid preset/)
  })
  const short = createEntitlementGate({ verify, planFor, probeDuration: async () => 12 })
  await withServer(createProcessRoute({ gate: short, verify }), async (base) => {
    assert.equal((await upload(base)).status, 400)
  })
})

test('at the job limit the request is refused before the upload is read', async () => {
  const queue = createJobQueue({ concurrency: 1, maxQueued: 0, maxPerClient: 1 })
  const hold = new Promise(() => {})
  queue.submit('user:tok-free', () => hold)  // this account's one job, running

  await withServer(createProcessRoute({ verify, queue }), async (base) => {
    const mine = await neverEndingUpload(`${base}/api/process`, 'tok-free')
    assert.equal(mine.status, 429)
    assert.equal(mine.body.code, 'too_many_jobs')

    // Someone else: the one slot is taken and the line holds nobody.
    const other = await neverEndingUpload(`${base}/api/process`, 'tok-pro')
    assert.equal(other.status, 503)
    assert.equal(other.headers['retry-after'], '60')
    assert.equal(other.body.code, 'server_busy')
  })
})

test('a waiting job reports its place in line; a running one reports null', async () => {
  const { jobsRoute } = await import('../routes/jobs.js')
  const { createJob, setJobQueuePosition, setJobProgress } = await import('../lib/jobStore.js')
  const id = createJob()
  setJobQueuePosition(id, 3)
  setJobProgress(id, 'Waiting in line (2 ahead of you)')
  await withServer(jobsRoute, async (base) => {
    assert.deepEqual(await (await fetch(`${base}/api/jobs/${id}`)).json(),
      { status: 'processing', progress: 'Waiting in line (2 ahead of you)', queuePosition: 3 })
    setJobQueuePosition(id, null)
    assert.equal((await (await fetch(`${base}/api/jobs/${id}`)).json()).queuePosition, null)
  })
})
