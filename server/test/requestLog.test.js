import { test } from 'node:test'
import assert from 'node:assert/strict'
import express from 'express'

import { requestLog, trackWork } from '../lib/requestLog.js'

async function withApp(setup, fn) {
  const lines = []
  const recorded = []
  const usage = { record: e => { recorded.push(e) } }
  const app = express()
  app.use('/api', requestLog({ usage, log: l => lines.push(JSON.parse(l)) }))
  setup(app)
  const server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)) })
  try {
    await fn(`http://127.0.0.1:${server.address().port}`, { lines, recorded })
  } finally {
    await new Promise(resolve => server.close(resolve))
  }
}

const settle = () => new Promise(resolve => setTimeout(resolve, 20))

/** What the gate and multer would have left on the request. */
function asServed(req, { user = { id: 'u1' }, feature = 'autoLevel', mode = 'preview' } = {}) {
  req.user = user
  req.feature = feature
  req.entitlement = { plan: 'free', mode }
  req.audioSeconds = 28.44
  req.file = { size: 4096 }
}

test('a served request: one JSON line with who, what and how much, and a usage row', async () => {
  await withApp(app => {
    app.post('/api/analyze/vad', async (req, res) => {
      asServed(req)
      res.json(await trackWork(res, Promise.resolve({ ok: true })))
    })
  }, async (base, { lines, recorded }) => {
    await fetch(`${base}/api/analyze/vad?x=1`, { method: 'POST' })
    await settle()
    assert.equal(lines.length, 1)
    const [line] = lines
    assert.equal(line.evt, 'api')
    assert.equal(line.route, '/api/analyze/vad')
    assert.equal(line.user, 'u1')
    assert.equal(line.ip, '127.0.0.1')
    assert.equal(line.status, 200)
    assert.equal(line.code, null)
    assert.equal(line.feature, 'autoLevel')
    assert.equal(line.mode, 'preview')
    assert.equal(line.bytes, 4096)
    assert.equal(line.audio_s, 28.4)
    assert.ok(Number.isFinite(line.ms) && line.ms >= 0)
    assert.ok(!Number.isNaN(Date.parse(line.t)))

    assert.equal(recorded.length, 1)
    assert.deepEqual({ ...recorded[0], durationMs: 0 }, {
      userId: 'u1', ip: '127.0.0.1', feature: 'autoLevel', mode: 'preview',
      audioSeconds: 28.44, uploadBytes: 4096, outcome: 'ok', durationMs: 0,
    })
  })
})

test('a refusal is logged with its code (json or send) and records no usage', async () => {
  await withApp(app => {
    app.post('/api/spot/a', (req, res) => {
      req.feature = 'spotEffects'
      res.status(401).json({ error: 'Sign in', code: 'sign_in_required' })
    })
    // express-rate-limit sends its message object with res.send
    app.post('/api/spot/b', (_req, res) => res.status(429).send({ error: 'Too many', code: 'rate_limited' }))
    app.post('/api/spot/c', (_req, res) => res.status(400).send('no file'))
  }, async (base, { lines, recorded }) => {
    for (const p of ['a', 'b', 'c']) await fetch(`${base}/api/spot/${p}`, { method: 'POST' })
    await settle()
    assert.deepEqual(lines.map(l => [l.status, l.code, l.user]), [
      [401, 'sign_in_required', null], [429, 'rate_limited', null], [400, null, null],
    ])
    assert.equal(recorded.length, 0)
  })
})

test('failed work records an error row; a request that never reached the work records none', async () => {
  await withApp(app => {
    app.post('/api/analyze/x', async (req, res) => {
      asServed(req)
      try {
        await trackWork(res, Promise.reject(new Error('boom')))
      } catch {
        res.status(500).json({ error: 'boom' })
      }
    })
    // A queue refusal after the gate set the feature: logged, but no work, no row.
    app.post('/api/analyze/y', (req, res) => {
      req.feature = 'autoLevel'
      res.status(503).json({ error: 'busy', code: 'server_busy' })
    })
    // Mastering's 202 never tracks work here; the job records its own row.
    app.post('/api/process', (req, res) => {
      asServed(req, { feature: 'mastering', mode: 'full' })
      res.status(202).json({ jobId: 'j1' })
    })
  }, async (base, { lines, recorded }) => {
    await fetch(`${base}/api/analyze/x`, { method: 'POST' })
    await fetch(`${base}/api/analyze/y`, { method: 'POST' })
    await fetch(`${base}/api/process`, { method: 'POST' })
    await settle()
    assert.deepEqual(lines.map(l => [l.status, l.code]), [[500, null], [503, 'server_busy'], [202, null]])
    assert.deepEqual(recorded.map(r => [r.feature, r.outcome]), [['autoLevel', 'error']])
  })
})

test('a client that hangs up mid-work: logged as aborted at once, usage recorded when the work settles', async () => {
  let finishWork
  const work = new Promise(resolve => { finishWork = resolve })
  await withApp(app => {
    app.post('/api/spot/slow', async (req, res) => {
      asServed(req, { feature: 'spotEffects', mode: 'full' })
      await trackWork(res, work)
      if (!res.writableEnded) res.json({ ok: true })
    })
  }, async (base, { lines, recorded }) => {
    const controller = new AbortController()
    const pending = fetch(`${base}/api/spot/slow`, { method: 'POST', signal: controller.signal }).catch(() => {})
    await settle()
    controller.abort()
    await pending
    await settle()
    assert.equal(lines.length, 1)
    assert.equal(lines[0].aborted, true)
    assert.equal(recorded.length, 0, 'not recorded as ok at the disconnect')

    finishWork()
    await settle()
    assert.deepEqual(recorded.map(r => [r.feature, r.outcome]), [['spotEffects', 'ok']])
  })
})
