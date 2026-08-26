import test from 'node:test'
import assert from 'node:assert/strict'
import { DEFAULT_RESONANCE_ZONES } from '../../src/audio/resonanceParams.js'

/**
 * A ZONE'S DELTA IS A MONITORING STATE AND MUST NOT BECOME A PARAMETER.
 *
 * The rule the panel already holds for the header's DELTA, and this is the more
 * dangerous of the two: the delta monitor itself is expressible only inside the
 * kernel, but the ISOLATION it rides on is expressible as ordinary parameters —
 * every other zone at depth zero — so nothing about it would look wrong if it
 * leaked into what Apply renders. It would simply write a one-zone pass into
 * the timeline.
 *
 * ⚠ THIS REPLACED PER-ZONE SOLO. Same transform, opposite monitor: solo played
 * what survived one zone, this plays what one zone took out. The guarantee
 * being pinned here is the transform's, so it is unchanged by that swap.
 *
 * `useResonance` cannot be imported here: it reaches for an AudioContext at
 * module scope through useEditorState. What is testable, and what actually
 * carries the guarantee, is the transform itself — so it is reproduced here
 * exactly as the composable applies it, and the composable is pinned to it by
 * a source check below.
 */

function liveZones(zones, only) {
  if (only < 0 || only >= zones.length) return zones
  return zones.map((z, i) => ({ ...z, enabled: i === only }))
}

test('a zone delta leaves exactly one zone audible', () => {
  const zones = DEFAULT_RESONANCE_ZONES
  const live = liveZones(zones, 2)
  assert.deepEqual(live.map(z => z.enabled), [false, false, true])
  // Everything else about every zone is untouched, so clearing it restores the
  // set rather than a reconstruction of it.
  live.forEach((z, i) => {
    assert.equal(z.selectivity, zones[i].selectivity)
    assert.equal(z.depth, zones[i].depth)
    assert.equal(z.sharpness, zones[i].sharpness)
    assert.equal(z.hiHz, zones[i].hiHz)
  })
})

test('no zone delta returns the stored set by identity', () => {
  const zones = DEFAULT_RESONANCE_ZONES
  assert.equal(liveZones(zones, -1), zones)
  assert.equal(liveZones(zones, 99), zones)
})

test('asking a bypassed zone what it removes means silence, not a re-enable', () => {
  const zones = DEFAULT_RESONANCE_ZONES.map((z, i) => (i === 1 ? { ...z, enabled: false } : z))
  // Deliberate: the question is fair on a band that is switched off, and the
  // honest answer is nothing.
  assert.deepEqual(liveZones(zones, 1).map(z => z.enabled), [false, true, false])
})

test('THE COMPOSABLE KEEPS THE ZONE DELTA OUT OF WHAT APPLY RENDERS', async () => {
  // A source check rather than a behavioural one, because the behaviour needs a
  // live AudioContext. It guards the one mistake that matters: `currentParams`
  // is the object handed to applyResonanceRegion, and the moment the isolation
  // appears in it a one-zone pass gets written to the timeline.
  const { readFile } = await import('node:fs/promises')
  // NEWLINES NORMALISED BEFORE ANYTHING IS SLICED. The end-of-function search
  // below looks for a bare LF, so on a CRLF copy of the source it found
  // nothing, returned -1, and `slice(0, -1)` handed the whole module to the
  // assertions — which then failed on the first mention of the state ANYWHERE
  // in a file that is largely about it. A source check has to be indifferent to
  // how the file was written to disk, or it reports the checkout rather than
  // the code.
  const src = (await readFile(
    new URL('../../src/composables/useResonance.js', import.meta.url), 'utf8'))
    .replace(/\r\n/g, '\n')
  const body = src.slice(src.indexOf('function currentParams()'))
  const end = body.indexOf('\n}\n')
  assert.ok(end > 0, 'currentParams end not found — the slice below would be the whole module')
  const params = body.slice(0, end)
  assert.ok(!params.includes('resDeltaZone'), 'currentParams must not consult the zone delta')
  assert.ok(!params.includes('resDelta'), 'currentParams must not consult the delta monitor')
  assert.ok(!params.includes('liveZones'), 'currentParams must push the stored zones')
  assert.ok(params.includes('zones: resZones.value'), 'currentParams should carry the stored zones')
  // And the live push must go through the transform, or the zone delta would
  // isolate nothing.
  assert.ok(src.includes("pushParam('zones', liveZones())"))
  // Cleared on teardown, so it cannot survive the panel and come back under a
  // panel that no longer shows it — the same rule the header's delta follows.
  const teardown = src.slice(src.indexOf('function teardown()'))
  assert.ok(teardown.includes('resDeltaZone.value = -1'))
  assert.ok(teardown.includes('resDelta.value = false'))
})

test('THE MONITOR IS ON WHENEVER EITHER ASKS FOR IT', async () => {
  // One kernel monitor, two controls. A zone delta forces it on regardless of
  // the header switch and must hand that switch back untouched when it clears,
  // or switching a zone's delta off would silently turn the global one off with
  // it.
  const { readFile } = await import('node:fs/promises')
  const src = (await readFile(
    new URL('../../src/composables/useResonance.js', import.meta.url), 'utf8'))
    .replace(/\r\n/g, '\n')
  assert.ok(src.includes('return resDelta.value || resDeltaZone.value >= 0'),
    'monitoringDelta must be the OR of the two')
  // Every push of the monitor goes through it rather than through either flag.
  const calls = src.match(/setMonitorDelta\([^)]*\)/g) ?? []
  assert.ok(calls.length >= 4, `expected the monitor to be pushed from several places, saw ${calls.length}`)
  for (const c of calls) {
    assert.ok(
      c.includes('monitoringDelta()') || c.includes('false'),
      `setMonitorDelta must be fed by monitoringDelta() or cleared outright, saw ${c}`,
    )
  }
})
