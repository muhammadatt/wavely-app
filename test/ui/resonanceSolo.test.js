import test from 'node:test'
import assert from 'node:assert/strict'
import { DEFAULT_RESONANCE_ZONES } from '../../src/audio/resonanceParams.js'

/**
 * SOLO IS A MONITORING STATE AND MUST NOT BECOME A PARAMETER.
 *
 * The rule the panel already holds for DELTA, and solo is the more dangerous of
 * the two: delta is expressible only inside the kernel, but solo is expressible
 * as ordinary parameters — every other zone at depth zero — so nothing about it
 * would look wrong if it leaked into what Apply renders. It would simply write
 * a soloed pass into the timeline.
 *
 * `useResonance` cannot be imported here: it reaches for an AudioContext at
 * module scope through useEditorState. What is testable, and what actually
 * carries the guarantee, is the transform itself — so it is reproduced here
 * exactly as the composable applies it, and the composable is pinned to it by
 * a source check below.
 */

function liveZones(zones, solo) {
  if (solo < 0 || solo >= zones.length) return zones
  return zones.map((z, i) => ({ ...z, enabled: i === solo }))
}

test('solo leaves exactly one zone audible', () => {
  const zones = DEFAULT_RESONANCE_ZONES
  const live = liveZones(zones, 2)
  assert.deepEqual(live.map(z => z.enabled), [false, false, true, false])
  // Everything else about every zone is untouched, so clearing solo restores
  // the set rather than a reconstruction of it.
  live.forEach((z, i) => {
    assert.equal(z.selectivity, zones[i].selectivity)
    assert.equal(z.depth, zones[i].depth)
    assert.equal(z.sharpness, zones[i].sharpness)
    assert.equal(z.hiHz, zones[i].hiHz)
  })
})

test('no solo returns the stored set by identity', () => {
  const zones = DEFAULT_RESONANCE_ZONES
  assert.equal(liveZones(zones, -1), zones)
  assert.equal(liveZones(zones, 99), zones)
})

test('soloing a bypassed zone means silence, not a re-enable', () => {
  const zones = DEFAULT_RESONANCE_ZONES.map((z, i) => (i === 1 ? { ...z, enabled: false } : z))
  // Deliberate: "hear this band alone" on a band that is switched off is a
  // legitimate thing to ask, and the honest answer is nothing.
  assert.deepEqual(liveZones(zones, 1).map(z => z.enabled), [false, true, false, false])
})

test('THE COMPOSABLE KEEPS SOLO OUT OF WHAT APPLY RENDERS', async () => {
  // A source check rather than a behavioural one, because the behaviour needs a
  // live AudioContext. It guards the one mistake that matters: `currentParams`
  // is the object handed to applyResonanceRegion, and the moment solo appears
  // in it a soloed pass gets written to the timeline.
  const { readFile } = await import('node:fs/promises')
  // NEWLINES NORMALISED BEFORE ANYTHING IS SLICED. The end-of-function search
  // below looks for a bare LF, so on a CRLF copy of the source it found
  // nothing, returned -1, and `slice(0, -1)` handed the whole module to the
  // assertions — which then failed on the first mention of solo ANYWHERE in a
  // file that is largely about solo. A source check has to be indifferent to
  // how the file was written to disk, or it reports the checkout rather than
  // the code.
  const src = (await readFile(
    new URL('../../src/composables/useResonance.js', import.meta.url), 'utf8'))
    .replace(/\r\n/g, '\n')
  const body = src.slice(src.indexOf('function currentParams()'))
  const end = body.indexOf('\n}\n')
  assert.ok(end > 0, 'currentParams end not found — the slice below would be the whole module')
  const params = body.slice(0, end)
  assert.ok(!params.includes('Solo'), 'currentParams must not consult the solo state')
  assert.ok(!params.includes('liveZones'), 'currentParams must push the stored zones')
  assert.ok(params.includes('zones: resZones.value'), 'currentParams should carry the stored zones')
  // And the live push must go through the transform, or solo would do nothing.
  assert.ok(src.includes("pushParam('zones', liveZones())"))
  // Cleared on teardown, so a solo cannot survive the panel and come back under
  // a panel that no longer shows it — the same rule delta follows.
  const teardown = src.slice(src.indexOf('function teardown()'))
  assert.ok(teardown.includes('resSoloZone.value = -1'))
})
