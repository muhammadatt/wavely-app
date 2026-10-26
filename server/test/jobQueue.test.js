import { test } from 'node:test'
import assert from 'node:assert/strict'

import { createJobQueue, QueueRefusal } from '../lib/jobQueue.js'

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
