import { test } from 'node:test'
import assert from 'node:assert/strict'

import { pollJob } from '../../src/api/pollJob.js'

const noWait = async () => {}

/** A status source that plays back `bodies` and then repeats the last one. */
function statuses(bodies) {
  let i = 0
  return async () => bodies[Math.min(i++, bodies.length - 1)]
}

test('resolves with the done body and reports progress on the way', async () => {
  const seen = []
  const job = await pollJob({
    fetchStatus: statuses([
      { status: 'processing', progress: 'Waiting in line (next up)', queuePosition: 1 },
      { status: 'processing', progress: 'Noise reduction', queuePosition: null },
      { status: 'done', report: { ok: 1 } },
    ]),
    onProgress: p => seen.push(p),
    wait: noWait,
  })
  assert.deepEqual(job, { status: 'done', report: { ok: 1 } })
  assert.deepEqual(seen, ['Waiting in line (next up)', 'Noise reduction'])
})

test('time in line does not use up the processing budget', async () => {
  // 50 polls in line, then 3 processing, then done — with a processing budget of 5.
  const bodies = [
    ...Array.from({ length: 50 }, () => ({ status: 'processing', queuePosition: 2 })),
    ...Array.from({ length: 3 }, () => ({ status: 'processing', queuePosition: null })),
    { status: 'done' },
  ]
  const job = await pollJob({ fetchStatus: statuses(bodies), wait: noWait, maxPolls: 5, maxQueuePolls: 100 })
  assert.equal(job.status, 'done')
})

test('each budget runs out on its own, with its own message', async () => {
  await assert.rejects(
    pollJob({ fetchStatus: statuses([{ status: 'processing' }]), wait: noWait, maxPolls: 5 }),
    /Processing timed out/,
  )
  await assert.rejects(
    pollJob({ fetchStatus: statuses([{ status: 'processing', queuePosition: 3 }]), wait: noWait, maxPolls: 5, maxQueuePolls: 7 }),
    /did not start/,
  )
})

test('a failed job throws its error', async () => {
  await assert.rejects(
    pollJob({ fetchStatus: statuses([{ status: 'error', error: 'Demucs crashed' }]), wait: noWait }),
    /Demucs crashed/,
  )
})
