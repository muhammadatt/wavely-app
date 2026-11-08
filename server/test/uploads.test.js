import { test } from 'node:test'
import assert from 'node:assert/strict'
import express from 'express'
import { mkdtemp, readFile, rm, access } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createUploadStore, createUploadRoutes, useUpload, parseMetadata, TUS_VERSION } from '../lib/uploads.js'

const MB = 1024 * 1024
const PLANS = { 'tok-a': 'a', 'tok-b': 'b' }
const verify = async (token) => {
  if (!PLANS[token]) throw new Error('bad token')
  return { id: PLANS[token] }
}
const quiet = () => {}
const exists = p => access(p).then(() => true, () => false)

async function setup(storeOpts = {}, routeOpts = {}) {
  const root = await mkdtemp(join(tmpdir(), 'wavely-uploads-'))
  const store = createUploadStore({ dir: join(root, 'tus'), log: quiet, ...storeOpts })
  const app = express()
  app.use(express.json())
  app.use('/api', createUploadRoutes({ store, verify, ...routeOpts }))
  // A stand-in processing route: it receives the taken upload as req.file.
  app.post('/api/consume', (req, res, next) => {
    req.user = req.get('authorization') ? { id: PLANS[req.get('authorization').slice(7)] } : null
    next()
  }, useUpload(store, join(root, 'taken')), async (req, res) => {
    res.json({ name: req.file.originalname, size: req.file.size, body: (await readFile(req.file.path)).toString() })
  })
  const server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)) })
  const base = `http://127.0.0.1:${server.address().port}`
  return {
    store, base, root,
    async close() {
      await new Promise(resolve => server.close(resolve))
      await rm(root, { recursive: true, force: true })
    },
  }
}

const auth = token => (token ? { Authorization: `Bearer ${token}` } : {})
const meta = obj => Object.entries(obj).map(([k, v]) => `${k} ${Buffer.from(v).toString('base64')}`).join(',')

function create(base, length, { token = 'tok-a', filename = 'take.wav' } = {}) {
  return fetch(`${base}/api/uploads`, {
    method: 'POST',
    headers: { 'Tus-Resumable': TUS_VERSION, 'Upload-Length': String(length), 'Upload-Metadata': meta({ filename }), ...auth(token) },
  })
}

function patch(base, location, offset, body, { token = 'tok-a' } = {}) {
  return fetch(`${base}${location}`, {
    method: 'PATCH',
    headers: {
      'Tus-Resumable': TUS_VERSION, 'Upload-Offset': String(offset),
      'Content-Type': 'application/offset+octet-stream', ...auth(token),
    },
    body,
  })
}

const head = (base, location, token = 'tok-a') =>
  fetch(`${base}${location}`, { method: 'HEAD', headers: { 'Tus-Resumable': TUS_VERSION, ...auth(token) } })

test('parseMetadata reads tus key/base64 pairs', () => {
  assert.deepEqual(parseMetadata(`filename ${Buffer.from('a b.wav').toString('base64')},flag`), { filename: 'a b.wav', flag: '' })
})

test('create → patch in chunks → head → take: the file arrives whole, once', async () => {
  const t = await setup()
  try {
    const created = await create(t.base, 11, { filename: '../../etc/Chapter 1.wav' })
    assert.equal(created.status, 201)
    const location = created.headers.get('location')
    assert.match(location, /^\/api\/uploads\/[0-9a-f-]{36}$/)

    let res = await patch(t.base, location, 0, 'hello ')
    assert.equal(res.status, 204)
    assert.equal(res.headers.get('upload-offset'), '6')

    res = await head(t.base, location)
    assert.equal(res.headers.get('upload-offset'), '6')
    assert.equal(res.headers.get('upload-length'), '11')

    // Not finished yet: a processing request is refused, and the upload survives.
    const id = location.split('/').pop()
    const early = await fetch(`${t.base}/api/consume`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', ...auth('tok-a') }, body: JSON.stringify({ uploadId: id }),
    })
    assert.equal(early.status, 409)
    assert.equal((await early.json()).code, 'upload_incomplete')

    assert.equal((await patch(t.base, location, 6, 'world')).status, 204)

    const taken = await fetch(`${t.base}/api/consume`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', ...auth('tok-a') }, body: JSON.stringify({ uploadId: id }),
    })
    assert.equal(taken.status, 200)
    assert.deepEqual(await taken.json(), { name: 'Chapter 1.wav', size: 11, body: 'hello world' })

    // Single use.
    const again = await fetch(`${t.base}/api/consume`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', ...auth('tok-a') }, body: JSON.stringify({ uploadId: id }),
    })
    assert.equal(again.status, 404)
    assert.equal((await head(t.base, location)).status, 404)
  } finally {
    await t.close()
  }
})

test("another account's upload reads as missing — head, patch, delete and take", async () => {
  const t = await setup()
  try {
    const location = (await create(t.base, 5)).headers.get('location')
    const id = location.split('/').pop()
    assert.equal((await head(t.base, location, 'tok-b')).status, 404)
    assert.equal((await patch(t.base, location, 0, 'abcde', { token: 'tok-b' })).status, 404)
    assert.equal((await fetch(`${t.base}${location}`, { method: 'DELETE', headers: auth('tok-b') })).status, 404)
    assert.equal((await patch(t.base, location, 0, 'abcde')).status, 204)
    const stolen = await fetch(`${t.base}/api/consume`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', ...auth('tok-b') }, body: JSON.stringify({ uploadId: id }),
    })
    assert.equal(stolen.status, 404)
  } finally {
    await t.close()
  }
})

test('protocol errors: wrong offset 409, wrong type 415, missing Tus-Resumable 412, overrun 413', async () => {
  const t = await setup()
  try {
    const location = (await create(t.base, 4)).headers.get('location')
    assert.equal((await patch(t.base, location, 2, 'ab')).status, 409)

    const badType = await fetch(`${t.base}${location}`, {
      method: 'PATCH',
      headers: { 'Tus-Resumable': TUS_VERSION, 'Upload-Offset': '0', 'Content-Type': 'text/plain', ...auth('tok-a') },
      body: 'ab',
    })
    assert.equal(badType.status, 415)

    const noTus = await fetch(`${t.base}/api/uploads`, { method: 'POST', headers: { 'Upload-Length': '4', ...auth('tok-a') } })
    assert.equal(noTus.status, 412)

    const over = await patch(t.base, location, 0, 'abcdefgh')
    assert.equal(over.status, 413)
    const offset = Number((await head(t.base, location)).headers.get('upload-offset'))
    assert.ok(offset <= 4, 'never more than Upload-Length on disk')
  } finally {
    await t.close()
  }
})

test('limits at creation: signed-out size, per-caller count and bytes, the hard cap', async () => {
  const t = await setup({
    maxBytes: 100 * MB, maxSignedOutBytes: 1 * MB, maxActivePerClient: 2,
    maxBytesPerClient: 150 * MB, maxTotalBytes: 250 * MB,
  })
  try {
    // Signed out: a preview-sized file only.
    assert.equal((await create(t.base, 1 * MB, { token: null })).status, 201)
    const big = await create(t.base, 2 * MB, { token: null })
    assert.equal(big.status, 401)
    assert.equal((await big.json()).code, 'sign_in_required')

    assert.equal((await create(t.base, 101 * MB)).status, 413)

    assert.equal((await create(t.base, 80 * MB)).status, 201)
    const tooMuch = await create(t.base, 80 * MB)          // 160 MB > 150 for this account
    assert.equal(tooMuch.status, 429)
    assert.equal((await create(t.base, 10 * MB)).status, 201)
    assert.equal((await create(t.base, 1)).status, 429)    // third upload in flight
  } finally {
    await t.close()
  }
})

test('the disk guard refuses everyone with 503 once all uploads together would pass it', async () => {
  const t = await setup({ maxBytes: 100 * MB, maxTotalBytes: 150 * MB })
  try {
    assert.equal((await create(t.base, 100 * MB)).status, 201)
    const full = await create(t.base, 60 * MB, { token: 'tok-b' })
    assert.equal(full.status, 503)
    assert.equal(full.headers.get('retry-after'), '60')
    assert.equal((await full.json()).code, 'server_busy')
  } finally {
    await t.close()
  }
})

test('with accounts off nobody counts as signed out, so real files are not capped at preview size', async () => {
  const t = await setup({ maxSignedOutBytes: 1 * MB }, { verify: null })
  try {
    assert.equal((await create(t.base, 50 * MB, { token: null })).status, 201)
  } finally {
    await t.close()
  }
})

test('a blocked account cannot start an upload', async () => {
  const t = await setup({}, { isBlocked: async id => id === 'a' })
  try {
    const res = await create(t.base, 10)
    assert.equal(res.status, 403)
    assert.equal((await res.json()).code, 'account_blocked')
    assert.equal((await create(t.base, 10, { token: 'tok-b' })).status, 201)
  } finally {
    await t.close()
  }
})

test('idle uploads expire and their files go; DELETE removes one at once', async () => {
  let clock = 1_000_000
  const t = await setup({ ttlMs: 60_000, now: () => clock })
  try {
    const keep = (await create(t.base, 4)).headers.get('location')
    const idle = (await create(t.base, 4)).headers.get('location')
    const idlePath = t.store.get(idle.split('/').pop(), 'user:a').path
    clock += 50_000
    await patch(t.base, keep, 0, 'ab')     // activity resets the clock
    clock += 20_000
    assert.equal(await t.store.sweep(), 1)
    assert.equal((await head(t.base, idle)).status, 404)
    assert.equal(await exists(idlePath), false)
    assert.equal((await head(t.base, keep)).status, 200)

    assert.equal((await fetch(`${t.base}${keep}`, { method: 'DELETE', headers: auth('tok-a') })).status, 204)
    assert.equal((await head(t.base, keep)).status, 404)
  } finally {
    await t.close()
  }
})

test('a file name cannot carry a path or a control character into the logs', async () => {
  const t = await setup()
  try {
    const location = (await create(t.base, 1, { filename: 'C:\\x\\take\n{"evt":"fake"}.wav' })).headers.get('location')
    const u = t.store.get(location.split('/').pop(), 'user:a')
    assert.equal(u.filename, 'take_{"evt":"fake"}.wav')
  } finally {
    await t.close()
  }
})
