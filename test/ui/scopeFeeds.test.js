/**
 * What the activity scopes and held readouts are fed (useScopeFeeds.js), and
 * the plugins' frequency responses their panels draw (`responseDb`).
 *
 * Same loader stub as pluginSettings.test.js.
 *
 * Run with:  npm test
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { register } from 'node:module'

const HOOKS = `
const SRC = ${JSON.stringify(new URL('../../src/', import.meta.url).href)}
export async function resolve(specifier, context, next) {
  if (/\\?(worker|url|raw)\\b/.test(specifier)) {
    return { url: 'data:text/javascript,export default "stub:asset"', shortCircuit: true }
  }
  return next(specifier, context)
}
export async function load(url, context, next) {
  const out = await next(url, context)
  if (url.startsWith(SRC) && out.format === 'module') {
    out.source = 'if (!import.meta.env) import.meta.env = {};\\n' + String(out.source)
  }
  return out
}`
register('data:text/javascript,' + encodeURIComponent(HOOKS))

const { scopeTransportStep, createHeldReadings, SCOPE_RESUME_TOLERANCE_S } =
  await import('../../src/composables/useScopeFeeds.js')

test('the scope holds while stopped and clears only when playback resumes elsewhere', () => {
  const stop = scopeTransportStep({ playing: false, playhead: 4, stoppedAt: null })
  assert.deepEqual(stop, { hold: true, clear: false, stoppedAt: 4 })
  assert.deepEqual(scopeTransportStep({ playing: true, playhead: 4.1, stoppedAt: 4 }),
    { hold: false, clear: false, stoppedAt: null }, 'resumed where it stopped: history kept')
  assert.deepEqual(scopeTransportStep({ playing: true, playhead: 4 + SCOPE_RESUME_TOLERANCE_S + 0.01, stoppedAt: 4 }),
    { hold: false, clear: true, stoppedAt: null }, 'resumed elsewhere: history cleared')
  assert.deepEqual(scopeTransportStep({ playing: true, playhead: 9, stoppedAt: null }),
    { hold: false, clear: false, stoppedAt: null }, 'already playing: nothing to clear')
})

test('held readings hold a brief peak, then fall at their rate', () => {
  let v = 6
  const held = createHeldReadings({ cut: () => v }, { holdMs: 400, fallPerSec: 20 })
  assert.equal(held.step(16).cut, 6)
  v = 0 // the burst is over after one frame
  for (let i = 0; i < 3; i++) assert.equal(held.step(100).cut, 6, `still held at ${(i + 1) * 100} ms`)
  assert.ok(Math.abs(held.step(100).cut - 4) < 1e-9, 'past 400 ms it falls at 20 dB/s: 2 dB in 100 ms')
})

test('held readings publish at most every `everyMs`, keeping the peak meanwhile', () => {
  let v = 3
  const held = createHeldReadings({ a: () => v }, { holdMs: 1000, fallPerSec: 6, everyMs: 200 })
  assert.equal(held.step(0).a, 3, 'the first step publishes')
  v = 5
  assert.equal(held.step(50).a, 3, 'not yet due')
  assert.equal(held.step(160).a, 5, 'due: the held peak, not the instant value')
})

const responses = [
  ['Scheps', async () => (await import('../../src/composables/useScheps.js')).useScheps('solo'), r => [r.responseDb([100, 1000, 10000], 'pre'), r.responseDb([100, 1000, 10000], 'post'), r.responseDb([100, 1000, 10000], 'net')]],
  ['Air Boost', async () => (await import('../../src/composables/useAirBand.js')).useAirBand('solo'), r => [r.responseDb([100, 1000, 10000])]],
  ['Hi-Freq Limiter', async () => (await import('../../src/composables/useHFLimiter.js')).useHFLimiter('solo'), r => [r.responseDb([100, 1000, 10000], 1), r.responseDb([100, 1000, 10000], 0.25)]],
]
for (const [name, get, call] of responses) {
  test(`${name} draws its response from its composable`, async () => {
    for (const curve of call(await get())) {
      assert.equal(curve.length, 3)
      for (const db of curve) assert.ok(Number.isFinite(db), `${name}: ${db}`)
    }
  })
}

test('the Hi-Freq Limiter response is flat with no cut and dips at the top with one', async () => {
  const hfl = (await import('../../src/composables/useHFLimiter.js')).useHFLimiter('solo')
  const [low, , high] = hfl.responseDb([100, 1000, 20000], 0.25)
  assert.ok(Math.abs(low) < 0.5, 'below the shelf: untouched')
  assert.ok(high < -6, 'the cut band: down')
  for (const db of hfl.responseDb([100, 1000, 20000], 1)) assert.ok(Math.abs(db) < 1e-6, 'gain 1: no cut')
})
