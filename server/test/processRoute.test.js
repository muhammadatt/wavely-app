import { test } from 'node:test'
import assert from 'node:assert/strict'
import express from 'express'
import { readdir } from 'node:fs/promises'
import path from 'node:path'

import { createProcessRoute } from '../routes/process.js'
import { createEntitlementGate } from '../lib/entitlements.js'
import { createJobQueue } from '../lib/jobQueue.js'

const UPLOADS = path.resolve(import.meta.dirname, '..', 'uploads')
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

const uploads = () => readdir(UPLOADS).catch(() => [])

test('signed out and longer than the preview: 402 asking for a free account; the upload is deleted', async () => {
  const before = await uploads()
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
  assert.deepEqual(await uploads(), before)
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
  const before = await uploads()
  const queue = createJobQueue({ concurrency: 1, maxQueued: 0, maxPerClient: 1 })
  const hold = new Promise(() => {})
  queue.submit('user:tok-free', () => hold)  // this account's one job, running

  await withServer(createProcessRoute({ verify, queue }), async (base) => {
    const mine = await upload(base, { token: 'tok-free' })
    assert.equal(mine.status, 429)
    assert.equal((await mine.json()).code, 'too_many_jobs')

    // Someone else: the one slot is taken and the line holds nobody.
    const other = await upload(base, { token: 'tok-pro' })
    assert.equal(other.status, 503)
    assert.equal(other.headers.get('retry-after'), '60')
    assert.equal((await other.json()).code, 'server_busy')
  })
  assert.deepEqual(await uploads(), before, 'refused uploads never reached disk')
})
