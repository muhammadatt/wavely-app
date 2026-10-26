import { test } from 'node:test'
import assert from 'node:assert/strict'

import { EventEmitter } from 'node:events'

import { createJobQueue, QueueRefusal, holdSlot } from '../lib/jobQueue.js'

/** A task the test finishes by hand. */
function deferred() {
  let resolve, reject
  const promise = new Promise((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject, run: () => promise }
}

const tick = () => new Promise(resolve => setImmediate(resolve))

test('runs at most `concurrency` at once and starts the next as one finishes', async () => {
  const queue = createJobQueue({ concurrency: 2, maxQueued: 5, maxPerClient: 5 })
  const tasks = [deferred(), deferred(), deferred()]
  const started = []
  const results = tasks.map((t, i) => queue.submit('a', () => { started.push(i); return t.run() }))
  await tick()
  assert.deepEqual(started, [0, 1])
  assert.deepEqual(queue.stats(), { running: 2, queued: 1, concurrency: 2, maxQueued: 5, maxPerClient: 5 })

  tasks[0].resolve('zero')
  assert.equal(await results[0], 'zero')
  await tick()
  assert.deepEqual(started, [0, 1, 2])

  tasks[1].reject(new Error('boom'))
  await assert.rejects(results[1], /boom/)
  tasks[2].resolve('two')
  assert.equal(await results[2], 'two')
  await tick()
  assert.deepEqual(queue.stats().running, 0)
})

test('reports each waiting task its place in line as the line moves', async () => {
  const queue = createJobQueue({ concurrency: 1, maxQueued: 5, maxPerClient: 5 })
  const first = deferred()
  const positions = { b: [], c: [] }
  queue.submit('a', first.run)
  const b = deferred(), c = deferred()
  queue.submit('b', b.run, { onPosition: n => positions.b.push(n) })
  queue.submit('c', c.run, { onPosition: n => positions.c.push(n) })
  assert.deepEqual(positions, { b: [1], c: [2] })

  first.resolve()
  await tick(); await tick()
  assert.equal(positions.c.at(-1), 1, 'c moved up when b started')
  b.resolve(); c.resolve()
})

test('one client may hold maxPerClient jobs (429); others are unaffected; a finish frees one', async () => {
  const queue = createJobQueue({ concurrency: 1, maxQueued: 5, maxPerClient: 2 })
  const a1 = deferred(), a2 = deferred()
  queue.submit('a', a1.run)
  queue.submit('a', a2.run)

  const refused = queue.refusal('a')
  assert.ok(refused instanceof QueueRefusal)
  assert.equal(refused.code, 'too_many_jobs')
  assert.equal(refused.status, 429)
  assert.throws(() => queue.submit('a', () => {}), QueueRefusal)
  assert.equal(queue.refusal('b'), null)

  a1.resolve()
  await tick(); await tick()
  assert.equal(queue.refusal('a'), null)
  a2.resolve()
})

test('a full line refuses everyone with 503; a FAILED job frees its slot too', async () => {
  const queue = createJobQueue({ concurrency: 1, maxQueued: 1, maxPerClient: 5 })
  const running = deferred(), waiting = deferred()
  const ran = queue.submit('a', running.run)
  queue.submit('b', waiting.run)

  const refused = queue.refusal('c')
  assert.equal(refused.code, 'server_busy')
  assert.equal(refused.status, 503)

  running.reject(new Error('stage crashed'))
  await assert.rejects(ran)
  await tick(); await tick()
  assert.equal(queue.refusal('c'), null)
  waiting.resolve()
})

test('a run() that throws synchronously rejects its promise and releases the slot', async () => {
  const queue = createJobQueue({ concurrency: 1, maxQueued: 0, maxPerClient: 1 })
  await assert.rejects(queue.submit('a', () => { throw new Error('sync') }), /sync/)
  await tick()
  assert.equal(queue.refusal('a'), null)
  assert.equal(queue.stats().running, 0)
})

// ── holdSlot: the limit on synchronous routes ───────────────────────────────


function fakeRes() {
  const res = new EventEmitter()
  Object.assign(res, {
    locals: {}, statusCode: 200, body: null, headers: {},
    set(k, v) { this.headers[k] = v; return this },
    status(c) { this.statusCode = c; return this },
    json(b) { this.body = b; return this },
  })
  return res
}

function through(mw, req) {
  const res = fakeRes()
  let passed = false
  mw(req, res, () => { passed = true })
  return { passed, res }
}

test('holdSlot refuses at once when full — never queues — and per client', () => {
  const queue = createJobQueue({ concurrency: 2, maxQueued: 0, maxPerClient: 1 })
  const limit = holdSlot(queue)
  const a = through(limit, { user: { id: 'a' } })
  assert.equal(a.passed, true)

  const a2 = through(limit, { user: { id: 'a' } })
  assert.equal(a2.passed, false)
  assert.equal(a2.res.statusCode, 429)

  assert.equal(through(limit, { ip: '1.2.3.4' }).passed, true)
  const c = through(limit, { user: { id: 'c' } })
  assert.equal(c.passed, false)
  assert.equal(c.res.statusCode, 503)
  assert.equal(c.res.headers['Retry-After'], '60')
  assert.equal(queue.stats().queued, 0)
})

test('a claimed slot is held until the handler releases it, even if the client hangs up', async () => {
  const queue = createJobQueue({ concurrency: 1, maxQueued: 0, maxPerClient: 1 })
  const limit = holdSlot(queue)
  const { res } = through(limit, { user: { id: 'a' } })
  const release = res.locals.slot.claim()

  res.emit('close')  // client aborted mid-render
  await tick()
  assert.ok(queue.refusal('b'), 'still held: the work is still running')

  release()
  await tick(); await tick()
  assert.equal(queue.refusal('b'), null)
})

test('an unclaimed slot (refused before the handler ran) frees when the response closes', async () => {
  const queue = createJobQueue({ concurrency: 1, maxQueued: 0, maxPerClient: 1 })
  const { res } = through(holdSlot(queue), { user: { id: 'a' } })
  assert.ok(queue.refusal('b'))
  res.emit('close')
  await tick(); await tick()
  assert.equal(queue.refusal('b'), null)
})
