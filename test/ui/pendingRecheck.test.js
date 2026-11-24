import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createPendingRecheck } from '../../src/platform/pendingRecheck.js'

/** A refresh whose answers are given in turn; `held` is what each one resolves. */
function refresher(...held) {
  const r = { calls: 0, gate: null }
  r.fn = async () => {
    const answer = held[Math.min(r.calls, held.length - 1)]
    r.calls++
    if (r.gate) await r.gate
    return answer
  }
  return r
}

test('one check at a time: a second call shares the one in flight', async () => {
  const r = refresher(true)
  let open
  r.gate = new Promise((res) => { open = res })
  const rc = createPendingRecheck({ refresh: r.fn })
  const a = rc.check()
  const b = rc.check()
  assert.equal(a, b)
  open()
  assert.equal(await a, true)
  assert.equal(r.calls, 1)
})

test('skipped while a restore or discard is busy', async () => {
  const r = refresher(true)
  let busy = true
  const rc = createPendingRecheck({ refresh: r.fn, busy: () => busy })
  assert.equal(await rc.check(), null)
  assert.equal(r.calls, 0)
  busy = false
  assert.equal(await rc.check(), true)
})

test('idle() waits for the check in flight, so a discard never overlaps it', async () => {
  const order = []
  let open
  const rc = createPendingRecheck({
    refresh: async () => { await new Promise((res) => { open = res }); order.push('check'); return false },
  })
  rc.check()
  const discard = rc.idle().then(() => order.push('discard'))
  await Promise.resolve()
  open()
  await discard
  assert.deepEqual(order, ['check', 'discard'])
  await rc.idle() // nothing in flight: resolves at once
})

test('an error is reported and reads as nothing held', async () => {
  const seen = []
  const rc = createPendingRecheck({ refresh: async () => { throw new Error('opfs') }, onError: e => seen.push(e.message) })
  assert.equal(await rc.check(), false)
  assert.deepEqual(seen, ['opfs'])
})

/** Timers run by hand: each tick awaits the check it started. */
function manualInterval() {
  const t = { fn: null, cleared: false }
  t.set = (fn) => { t.fn = fn; return 1 }
  t.clear = () => { t.cleared = true }
  t.tick = () => t.fn()
  return t
}

test('poll looks again until the closed tab lets go of its lock', async () => {
  const r = refresher(true, true, false, true)
  const t = manualInterval()
  const rc = createPendingRecheck({ refresh: r.fn, setIntervalFn: t.set, clearIntervalFn: t.clear })
  rc.poll(2000, 15)
  await t.tick(); assert.equal(t.cleared, false)
  await t.tick(); assert.equal(t.cleared, false)
  await t.tick(); assert.equal(t.cleared, true)
  assert.equal(r.calls, 3)
})

test('poll gives up after its tries, and keeps going through a busy tick', async () => {
  const r = refresher(true)
  const t = manualInterval()
  let busy = false
  const rc = createPendingRecheck({ refresh: r.fn, busy: () => busy, setIntervalFn: t.set, clearIntervalFn: t.clear })
  rc.poll(2000, 3)
  busy = true
  await t.tick(); assert.equal(t.cleared, false, 'a skipped check is not "nothing held"')
  busy = false
  await t.tick(); assert.equal(t.cleared, false)
  await t.tick(); assert.equal(t.cleared, true)
})
