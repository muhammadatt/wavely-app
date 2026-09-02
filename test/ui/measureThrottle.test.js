/**
 * Run with:  npm test
 *
 * The throttle that replaced the auto-makeup debounce. What it has to
 * guarantee is exactly what the debounce failed at: measurements keep landing
 * WHILE the input is still arriving, and the last input always gets one.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createMeasureThrottle } from '../../src/composables/measureThrottle.js'

const tick = () => new Promise(r => setTimeout(r, 0))

test('a burst of calls yields a pass DURING the burst, not only after it', async () => {
  let started = 0
  let release
  const t = createMeasureThrottle(() => new Promise(r => { started++; release = r }))

  t.schedule()
  assert.equal(started, 1, 'the first call runs immediately')

  // More input arrives while the pass is in flight. The debounce this replaced
  // would have reset a timer here and run nothing until the input stopped.
  t.schedule(); t.schedule(); t.schedule()
  assert.equal(started, 1, 'only one pass in flight at a time')

  release(); await tick()
  assert.equal(started, 2, 'the queued input starts a fresh pass the moment the first lands')
})

test('the LAST input always gets a measurement', async () => {
  const seen = []
  let value = 0
  let release
  const t = createMeasureThrottle(() => new Promise(r => { seen.push(value); release = r }))

  value = 1; t.schedule()          // runs now, sees 1
  value = 2; t.schedule()          // queued
  value = 3; t.schedule()          // still queued, coalesced
  release(); await tick()          // second pass starts, must see the LATEST
  assert.deepEqual(seen, [1, 3])
  release(); await tick()
  assert.deepEqual(seen, [1, 3], 'nothing left pending once it has caught up')
})

test('at most one pass is pending however fast the input arrives', async () => {
  let started = 0
  let release
  const t = createMeasureThrottle(() => new Promise(r => { started++; release = r }))
  t.schedule()
  for (let i = 0; i < 500; i++) t.schedule()
  release(); await tick()
  assert.equal(started, 2, '500 moves coalesce into one follow-up, not 500')
  release(); await tick()
  assert.equal(started, 2)
})

test('cancel stops a landed pass from re-arming', async () => {
  let started = 0
  let release
  const t = createMeasureThrottle(() => new Promise(r => { started++; release = r }))
  t.schedule()
  t.schedule()          // marks dirty
  t.cancel()            // panel torn down
  release(); await tick()
  assert.equal(started, 1, 'the queued pass must not run after cancel')
})

test('a throwing pass does not wedge the throttle', async () => {
  // `run` is documented as not throwing, but a wedged throttle is a makeup
  // that never updates again for the rest of the session — the "stuck"
  // report — so it must not depend on that.
  let started = 0
  const t = createMeasureThrottle(async () => { started++; throw new Error('boom') })
  try { t.schedule(); await tick(); await tick() } catch { /* surfaced below */ }
  assert.equal(t.isBusy(), false, 'inFlight must be cleared even when the pass throws')
})
