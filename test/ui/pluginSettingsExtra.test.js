import { test } from 'node:test'
import assert from 'node:assert/strict'
import { register } from 'node:module'
import { readFileSync } from 'node:fs'

/**
 * Saved-chain settings for the chainable plugins with no preset collection
 * (src/composables/pluginSettingsExtra.js), run against the REAL composables.
 *
 * Two Vite-isms stand between them and Node, and a loader hook stubs both:
 * `?worker&url` / `?url` asset imports (a worklet's URL — never fetched here,
 * since nothing previews) and `import.meta.env`, which Vite defines and Node
 * does not. Everything below runs with no AudioContext: the syncs push to the
 * live chain only while a copy is previewing, and no copy here ever is.
 */
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

const { EXTRA_PLUGIN_SETTINGS } = await import('../../src/composables/pluginSettingsExtra.js')

const io = (id, copy) => {
  const entry = EXTRA_PLUGIN_SETTINGS[id]
  return entry.io(entry.use(copy))
}

/** Non-default settings for each plugin, every key it stores. */
const FIXTURES = {
  'soft-clipper': { autoMakeup: false, peakControl: 'limit', outputTrimDb: 4.5 },
  'vox-pressor': {
    peaks: 6, speed: 'gentle', peaksMode: 'hard', body: 7.2, deEss: 55, deEssSplit: 70,
    parallelComp: '1176', parallel: 20, parallelDrive: 5, density: 40, ceiling: '-3',
  },
  'hum-remover': { fundamental: 50, q: 12, depth: 30 },
  'clip-gain-deesser': {
    stridentCeilingDb: 3, nonStridentCeilingDb: -7.5, reductionRatio: 0.8, maxReductionDb: 12,
    fricativeInMs: 5, fricativeOutMs: 8.5, affricateInMs: 2, affricateOutMs: 6,
  },
  'vocal-saturation': {
    drive: 2.5, wetDry: 0.4, asymmetry: 30, asymMode: 'offset', mode: 'parallel', curve: 'cubic',
    hardness: 3.5, emphasis: 70, soften: 10, tame: 60, autoDrive: 50, hfLoss: 20,
    lowCrossover: 300, midCrossover: 4000, lowDriveMult: 1.5, midDriveMult: 2, highDriveMult: 4,
  },
  'voicerx': {},
}

const roundTrip = v => JSON.parse(JSON.stringify(v))

test('the six plugins are keyed by their registry ids', () => {
  assert.deepEqual(Object.keys(EXTRA_PLUGIN_SETTINGS).sort(), Object.keys(FIXTURES).sort())
  // The registry imports .vue components, so it is read as source: each id is
  // an operation entry marked chainable before the next entry starts.
  const registry = readFileSync(new URL('../../src/ui/registry.js', import.meta.url), 'utf8')
  for (const id of Object.keys(EXTRA_PLUGIN_SETTINGS)) {
    const at = registry.indexOf(`id: '${id}',`)
    assert.ok(at >= 0, `${id} is a registry id`)
    const entry = registry.slice(at, registry.indexOf('\n  },', at))
    assert.match(entry, /\bchain: true\b/, `${id} is chainable`)
  }
})

for (const [id, fixture] of Object.entries(FIXTURES)) {
  test(`${id}: read → JSON → write on another copy reproduces read`, () => {
    const a = io(id, 'chain-1')
    const before = a.read()
    a.write(fixture)
    const saved = roundTrip(a.read())
    assert.deepEqual(saved, fixture, 'the fixture is exactly what read() stores')
    if (Object.keys(fixture).length) assert.notDeepEqual(saved, before, 'the fixture moved off the defaults')

    const b = io(id, 'chain-2')
    b.write(saved)
    assert.deepEqual(roundTrip(b.read()), saved)
  })

  test(`${id}: write tolerates nothing, junk and missing keys`, () => {
    const c = io(id, 'chain-3')
    const before = roundTrip(c.read())
    for (const junk of [{}, null, undefined, 'x', [1, 2]]) c.write(junk)
    assert.deepEqual(roundTrip(c.read()), before)
    // Unknown ids and non-numbers are ignored, key by key.
    const bad = Object.fromEntries(Object.keys(fixture).map(k => [k, typeof fixture[k] === 'number' ? 'NaN' : 'no-such-id']))
    c.write(bad)
    assert.deepEqual(roundTrip(c.read()), before)
  })
}

test('soft-clipper: AUTO stores no Output, and AUTO is decided before the knob', () => {
  const s = io('soft-clipper', 'chain-4')
  s.write({ autoMakeup: true, outputTrimDb: 9 })
  const r = s.read()
  assert.equal(r.autoMakeup, true)
  assert.ok(!('outputTrimDb' in r), 'a measured makeup is not a setting')
  // Off with a knob: the knob lands, and AUTO stays off.
  s.write({ autoMakeup: false, outputTrimDb: 99 })
  assert.equal(s.read().autoMakeup, false)
  assert.equal(s.read().outputTrimDb, 24, 'clamped to the knob travel')
})

test('numbers are clamped to the control travel', () => {
  const v = io('vox-pressor', 'chain-5')
  v.write({ peaks: 50, body: -3, deEss: 400 })
  assert.equal(v.read().peaks, 10)
  assert.equal(v.read().body, 0)
  assert.equal(v.read().deEss, 100)
  const h = io('hum-remover', 'chain-5')
  h.write({ fundamental: 55, q: 1000 })
  assert.equal(h.read().fundamental, 60, 'only 50 or 60 Hz')
  assert.equal(h.read().q, 60)
})

test('no measured or monitoring state is read', () => {
  const MEASURED = /align|measured|makeupDb$|f0|voiceF0|cornerHz|sourcePeak|harmonic|frequencies|events|analysis|tuning|delta|listen|solo|preview|fixedThreshold/i
  for (const id of Object.keys(FIXTURES)) {
    for (const key of Object.keys(io(id, 'chain-6').read())) {
      assert.doesNotMatch(key, MEASURED, `${id}.${key}`)
    }
  }
})
