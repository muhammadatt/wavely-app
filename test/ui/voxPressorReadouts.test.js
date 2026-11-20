/**
 * VoxPressor's readouts, warnings and guide zones (voxPressorReadouts.js),
 * over plain refs — what its faceplate says, without the faceplate.
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

const { ref } = await import('vue')
const { createVoxReadouts, cut } = await import('../../src/composables/voxPressorReadouts.js')
const P = await import('../../src/audio/effects/voxPressorParams.js')

function make(over = {}) {
  const s = {
    voxPeaks: ref(3), voxBody: ref(4.8), voxSpeed: ref('auto'), voxParallel: ref(35), voxParallelComp: ref('la2a'),
    voxPreview: ref(true), voxReadout: ref(null), voxMeasured: ref({ parallelMakeupDb: NaN }), voxBusy: ref(false),
    voxUpstreamStale: ref(false), voxPeaksStale: ref(false), voxPeaksGuide: ref(null), voxBodyGuide: ref(null),
    voxPeaksGr: ref(-4.2), voxBodyGr: ref(-2), voxParallelGr: ref(0),
  }
  for (const [k, v] of Object.entries(over)) s[k].value = v
  return { s, r: createVoxReadouts(s) }
}

const READ = { peaksDb: 3.04, peaksBodyDb: 0.02, bodyDb: 3.9, peaksRippleDb: -30 }

test('the needle reads a stage\'s reduction as a positive number', () => {
  const { r } = make()
  assert.equal(r.stageGrDb('peaks'), 4.2)
  assert.equal(r.stageGrDb('body'), 2)
  assert.equal(r.stageGrDb('nope'), 0)
})

test('a reduction prints as −x.x, and 0.0 rather than −0.0', () => {
  assert.equal(cut(3.04), '−3.0')
  assert.equal(cut(0.02), '0.0')
})

test('the readout goes measuring… → figures → remeasuring…, and a stage that is out measures nothing', () => {
  const { s, r } = make({ voxBusy: true })
  assert.deepEqual([r.stageReadout('peaks').line, r.stageReadout('peaks').status], ['', 'measuring…'])
  s.voxBusy.value = false
  s.voxReadout.value = READ
  assert.deepEqual(r.stageReadout('peaks').line, [{ k: 'loudest peaks', v: '−3.0 dB' }, { k: 'voice', v: '0.0 dB' }])
  assert.equal(r.stageReadout('peaks').status, '')
  s.voxBusy.value = true
  s.voxPeaksStale.value = true
  assert.equal(r.stageReadout('peaks').status, 'remeasuring…', 'figures kept, marked stale')
  assert.equal(r.stageReadout('body').status, '', 'a Peaks-only measurement leaves Body alone')
  s.voxBody.value = 0
  assert.deepEqual([r.stageReadout('body').line, r.stageReadout('body').status], ['stage out', ''])
})

test('Parallel shows its measured makeup and is stale during any measurement', () => {
  const { s, r } = make({ voxMeasured: { parallelMakeupDb: 6.04 } })
  assert.deepEqual(r.stageReadout('parallel').line, [{ k: 'parallel makeup', v: '+6.0 dB' }])
  s.voxBusy.value = true
  assert.equal(r.stageReadout('parallel').status, 'remeasuring…')
})

test('Peaks warns amber on the first touch of the voice and red past the warn line', () => {
  const { s, r } = make({ voxReadout: { ...READ, peaksBodyDb: 0 } })
  assert.deepEqual([r.peaksTouch.value, r.peaksOver.value], [false, false])
  s.voxReadout.value = { ...READ, peaksBodyDb: P.PEAKS_BODY_TOUCH_DB }
  assert.deepEqual([r.peaksTouch.value, r.peaksOver.value], [true, false])
  s.voxReadout.value = { ...READ, peaksBodyDb: P.PEAKS_BODY_WARN_DB + 0.1 }
  assert.deepEqual([r.peaksTouch.value, r.peaksOver.value], [true, true])
  s.voxPeaks.value = 0
  assert.deepEqual([r.peaksTouch.value, r.peaksOver.value], [false, false], 'a stage that is out warns nothing')
})

test('Body warns at its edge and over lines', () => {
  const { s, r } = make({ voxReadout: { ...READ, bodyDb: P.BODY_GUIDE_EDGE_DB - 0.1 } })
  assert.deepEqual([r.bodyEdge.value, r.bodyOver.value], [false, false])
  s.voxReadout.value = { ...READ, bodyDb: P.BODY_GUIDE_EDGE_DB }
  assert.deepEqual([r.bodyEdge.value, r.bodyOver.value], [true, false])
  s.voxReadout.value = { ...READ, bodyDb: P.BODY_GUIDE_WARN_DB }
  assert.deepEqual([r.bodyEdge.value, r.bodyOver.value], [true, true])
})

test('ripple takes the note line only when it warns, and suggests slowing down unless already slowest', () => {
  const { s, r } = make({ voxReadout: READ })
  assert.equal(r.stageReadout('peaks').note, '')
  s.voxReadout.value = { ...READ, peaksRippleDb: P.PEAKS_RIPPLE_WARN_DB + 2 }
  assert.match(r.stageReadout('peaks').note, /distorting, try NORMAL/)
  s.voxSpeed.value = 'gentle'
  assert.match(r.stageReadout('peaks').note, /distorting$/)
})

test('guide zones split the knob into ok / edge / over at the guide\'s positions', () => {
  const { r } = make({ voxPeaksGuide: { touch: 2, warn: 4.5 }, voxBodyGuide: { edge: 5, warn: 7 } })
  assert.deepEqual(r.peaksZones.value.map(z => [z.from, z.to, z.level]),
    [[0, 2, 'ok'], [2, 4.5, 'edge'], [4.5, P.PEAKS_MAX, 'over']])
  assert.deepEqual(r.bodyZones.value.map(z => [z.from, z.to, z.level]),
    [[0, 5, 'ok'], [5, 7, 'edge'], [7, P.BODY_MAX, 'over']])
  assert.equal(make().r.peaksZones.value, null, 'no guide yet: no zones')
})

test('the speed setter is live while either 1176 is in', () => {
  const { s, r } = make({ voxPeaks: 0, voxParallelComp: 'la2a' })
  assert.equal(r.speedInUse.value, false)
  s.voxParallelComp.value = '1176'
  assert.equal(r.speedInUse.value, true)
})
