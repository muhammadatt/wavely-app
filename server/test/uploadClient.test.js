/**
 * The browser's upload client (src/api/upload.js) against the real tus routes
 * (lib/uploads.js) — the two halves of resumable uploads, end to end.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import express from 'express'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createUploadStore, createUploadRoutes, useUpload } from '../lib/uploads.js'
import { uploadBlob } from '../../src/api/upload.js'

const verify = async (token) => {
  if (token !== 'tok-a') throw new Error('bad token')
  return { id: 'a' }
}
const noWait = async () => {}

async function serve(storeOpts = {}, intercept = null) {
  const root = await mkdtemp(join(tmpdir(), 'wavely-upclient-'))
  const store = createUploadStore({ dir: join(root, 'tus'), log: () => {}, ...storeOpts })
  const app = express()
  if (intercept) app.use(intercept)
  app.use(express.json())
  app.use('/api', createUploadRoutes({ store, verify }))
  app.post('/api/consume', (req, _res, next) => { req.user = { id: 'a' }; next() },
    useUpload(store, join(root, 'taken')),
    async (req, res) => res.json({ name: req.file.originalname, bytes: (await readFile(req.file.path)).toString('base64') }))
  const server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)) })
  const base = `http://127.0.0.1:${server.address().port}`
  return {
    base, store,
    async close() { await new Promise(r => server.close(r)); await rm(root, { recursive: true, force: true }) },
  }
}

const auth = async () => ({ Authorization: 'Bearer tok-a' })

function randomBlob(size) {
  const bytes = new Uint8Array(size)
  for (let i = 0; i < size; i++) bytes[i] = (i * 31 + 7) & 0xff
  return new Blob([bytes], { type: 'audio/wav' })
}

async function consume(base, uploadId) {
  const res = await fetch(`${base}/api/consume`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ uploadId }),
  })
  return res.json()
}

test('a file larger than one chunk arrives byte for byte, with progress', async () => {
  const s = await serve()
  try {
    const blob = randomBlob(250_000)
    const seen = []
    const id = await uploadBlob(blob, {
      endpoint: `${s.base}/api/uploads`, filename: 'Chapter 3 — ünïcode.wav', headers: auth,
      chunkSize: 64 * 1024, onProgress: sent => seen.push(sent),
    })
    const got = await consume(s.base, id)
    assert.equal(got.name, 'Chapter 3 — ünïcode.wav')
    assert.equal(Buffer.from(got.bytes, 'base64').equals(Buffer.from(await blob.arrayBuffer())), true)
    assert.deepEqual(seen, [0, 65536, 131072, 196608, 250000])
  } finally {
    await s.close()
  }
})

test('a chunk lost on the network is resumed from the server’s offset, not restarted', async () => {
  let patches = 0
  let dropped = false
  // Drop the second PATCH's connection after the server has taken part of it.
  const intercept = (req, res, next) => {
    if (req.method === 'PATCH' && ++patches === 2 && !dropped) {
      dropped = true
      let n = 0
      req.on('data', chunk => { n += chunk.length; if (n > 10_000) req.socket.destroy() })
    }
    next()
  }
  const s = await serve({}, intercept)
  try {
    const blob = randomBlob(200_000)
    const id = await uploadBlob(blob, {
      endpoint: `${s.base}/api/uploads`, headers: auth, chunkSize: 64 * 1024, wait: noWait,
    })
    const got = await consume(s.base, id)
    assert.equal(Buffer.from(got.bytes, 'base64').equals(Buffer.from(await blob.arrayBuffer())), true)
    assert.equal(dropped, true)
  } finally {
    await s.close()
  }
})

test('a refusal comes back as an error the app can act on, and is not retried', async () => {
  const s = await serve({ maxSignedOutBytes: 1000 })
  try {
    await assert.rejects(
      uploadBlob(randomBlob(5000), { endpoint: `${s.base}/api/uploads`, wait: noWait }),
      err => err.status === 401 && err.signIn?.code === 'sign_in_required',
    )
  } finally {
    await s.close()
  }
})

test('giving up after the retry budget, and an abort stops at once', async () => {
  const failing = (req, res, next) => (req.method === 'PATCH' ? res.status(503).json({ error: 'down', code: 'server_busy' }) : next())
  const s = await serve({}, failing)
  try {
    await assert.rejects(
      uploadBlob(randomBlob(1000), { endpoint: `${s.base}/api/uploads`, headers: auth, retryDelays: [0, 0], wait: noWait }),
      err => err.status === 503,
    )
    const controller = new AbortController()
    controller.abort()
    await assert.rejects(
      uploadBlob(randomBlob(1000), { endpoint: `${s.base}/api/uploads`, headers: auth, signal: controller.signal }),
      err => err.name === 'AbortError',
    )
  } finally {
    await s.close()
  }
})
